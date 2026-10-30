/**
 * Three-lab review panels through the classifier extension (PLAN wl-mv5m7qvgkxhpj4 § 3.4, § 4): a
 * fake OMP host, a real temp ledger, a lane session file on disk and a staging run with its
 * manifest. This file imports only modules that exist on origin/main, so on origin/main it loads
 * and fails on its assertions (the `panel:` line is ignored there and the item is an ordinary
 * production review fan-out), never on a missing export.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { createClassifierExtension } from "../extension";
import { loadCalibration } from "../src/classify";
import { parseHandSpawn } from "../src/lab";
import { countRounds } from "../src/rounds";
import { tierTableFromConfig, type TierTable } from "../src/tier-table";
import { SURFACE_BY } from "../../surface/src/types";
import { currentModel, dist, fakeRegistry, recordedQuestion } from "./helpers";

const ROWS = {
	fast: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-5.6-luna", "moonshot/kimi-k2.7-code-highspeed"],
	standard: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6-luna", "moonshot/kimi-k2.5"],
	strong: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "moonshot/kimi-k2.7-code"],
	deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra", "moonshot/kimi-k3"],
};
const TABLE = tierTableFromConfig({ task: { agentModelOverrides: ROWS } });
const ALL = Object.values(ROWS).flat();
const OPUS = ROWS.strong[0]!;
const [FABLE, , K3] = ROWS.deep as [string, string, string];
// Every panel hand is a review, so it plans on `reviewRow`: OpenAI from the strong row (Jo, in-mv5qfm8910ycjk).
const SOL = ROWS.strong[1]!;
const LAB_MODEL: Record<string, string> = { anthropic: FABLE, openai: SOL, kimi: K3 };

/** `review…` is a judge 0.9 (a review dispatch); anything else change-large. */
function answer(brief: string) {
	const task = /^task: (.*)$/m.exec(brief)?.[1] ?? "";
	if (task.startsWith("review")) return { choice: "judge", confidence: 0.9, probabilities: dist({ judge: 0.9 }) };
	return { choice: "change-large", confidence: 0.9, probabilities: dist({ "change-large": 0.9 }) };
}
const JUDGE = { judge: async ({ state }: { state: string }) => ({ answers: { kind: answer(state) }, provider: "typesafe", model: "jev-1.13.0" }) };

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A production workload on a temp ledger, the lane's session file, and a credential list to take labs down. */
function world() {
	const dir = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "panel-dispatch-"));
	dirs.push(dir);
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false });
	const wl = ledger.openWorkload({ id: "wl-panel", brief: "panel test", stakes: "production", mode: "autonomous", by: "orch-test" });
	for (const id of ["sl-x", "sl-y"]) ledger.addSlice({ id, workloadId: wl, task: id, doneCondition: "d", inputs: "i", by: "lane-test" });
	ledger.recordEntry({ by: "lane-runner", workloadId: wl, kind: "assumption", body: 'lane-started: lane-test {"pid":1}' });
	mkdirSync(join(dir, "sessions"));
	const laneFile = join(dir, "sessions", "lane.jsonl");
	writeFileSync(laneFile, "");
	mkdirSync(join(dir, "sessions", "lane")); // the lane's artifacts directory: its hands' session and result files
	const creds = [...ALL];
	return { dir, ledger, wl, laneFile, root: laneFile.slice(0, -".jsonl".length), creds, registry: fakeRegistry(ALL, creds) };
}
type World = ReturnType<typeof world>;

const down = (w: World, ...models: string[]) => {
	for (const m of models) w.creds.splice(w.creds.indexOf(m), 1);
};

/** A staging run as prep writes it (CONTRACT § 1): the packet, the schemas, the synthesis prompt and the manifest. */
function stagingRun(w: World, opts: { workload?: string; slice?: string; name?: string } = {}) {
	const run = join(w.dir, "staging", opts.name ?? "run-1");
	mkdirSync(run, { recursive: true });
	const files: Record<string, string> = {
		"packet.md": "# Packet\n\nthe artifact under review\n",
		"leg.schema.json": JSON.stringify({ type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object" } } } }),
		"synth.md": "synthesise the legs\n",
		"synth.schema.json": JSON.stringify({ type: "object" }),
	};
	for (const [rel, text] of Object.entries(files)) writeFileSync(join(run, rel), text);
	const manifest = {
		version: 1,
		mode: "triad",
		workload: opts.workload ?? w.wl,
		slice: opts.slice ?? "sl-x",
		createdAt: "2026-10-01T00:00:00Z",
		repoAccess: false,
		repo: null,
		legSchema: "leg.schema.json",
		synthPrompt: "synth.md",
		synthSchema: "synth.schema.json",
		legTimeoutMin: { default: 30 },
		inputs: Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel, sha(text)])),
		legInputs: { anthropic: ["packet.md"], openai: ["packet.md"], kimi: ["packet.md"] },
		synthInputs: [],
		withheld: [],
		canary: null,
	};
	writeFileSync(join(run, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return run;
}

const brief = (w: World, task: string, panel?: string) =>
	`workload: ${w.wl}\ntask: ${task}\ndone-condition: d\ninputs: i\nstakes: production\nceiling-share: 10${panel ? `\n${panel}` : ""}`;

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Item = { agent: string; name: string; task?: string; outputSchema?: unknown };
type Reply = { block?: boolean; reason?: string; input?: Item & { tasks: Item[]; context?: string }; model?: string[]; note?: string } | undefined;

/**
 * One lane process (crosslab.test.ts `lane`): a fixed fingerprint, since the lane's cwd is no
 * repository here. `ledger`: the ledger this process writes through (default the world's).
 */
function lane(w: World, ledger: Ledger = w.ledger, opts: { laneModel?: string; now?: () => number; table?: TierTable } = {}) {
	const handlers: Record<string, Handler> = {};
	const handSession: Record<string, Handler> = {};
	const starts: Handler[] = [];
	const logs: string[] = [];
	const extension = createClassifierExtension({
		judge: async () => JUDGE as never,
		tierTable: () => opts.table ?? TABLE,
		disabledProviders: async () => [],
		question: recordedQuestion(),
		calibration: loadCalibration(),
		ledger: () => ledger,
		laneId: "lane-test",
		boundWorkload: () => w.wl,
		log: line => logs.push(line),
		fingerprint: () => "same",
		now: opts.now ?? (() => Date.parse("2026-11-01T00:00:00-07:00")),
	});
	extension({
		on: (name: string, h: Handler) => {
			if (name === "session_start") starts.push(h);
			handlers[name] = h;
		},
	} as never);
	extension({ on: (name: string, h: Handler) => (handSession[name] = h) } as never);
	const ctx = { cwd: w.dir, modelRegistry: w.registry, model: currentModel(opts.laneModel), sessionManager: { getSessionFile: () => w.laneFile } };
	const handCtx = (agentId: string) => ({ ...ctx, sessionManager: { getSessionFile: () => `${w.root}/${agentId}.jsonl` } });
	const assistant = (selector: string) => {
		const [provider, ...model] = selector.split("/");
		return { type: "message_end", message: { role: "assistant", provider, model: model.join("/"), content: [] } };
	};
	return {
		logs,
		setLaneModel: (selector: string) => void (ctx.model = currentModel(selector)),
		/** OMP starts (or resumes) the lane's session: every `session_start` handler, in order. */
		sessionStart: async () => {
			for (const h of starts) await h({ type: "session_start" }, ctx);
		},
		toolCall: (input: unknown, toolCallId = "call-1") => handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId, input }, ctx) as Promise<Reply>,
		spawn: (agent: string, spawnKey: string) =>
			handlers.before_subagent_spawn!({ type: "before_subagent_spawn", agent, invocationKind: "task", patterns: [], spawnKey }, ctx) as Promise<Reply>,
		laneMessage: (selector: string) => handlers.message_end!(assistant(selector), ctx),
		handMessage: (agentId: string, selector: string) => handSession.message_end!(assistant(selector), handCtx(agentId)),
		/** Hand `agentId` calls an editing tool with `input` in its own session. */
		handEdit: (agentId: string, toolName: string, input: unknown) =>
			handSession.tool_call!({ type: "tool_call", toolName, toolCallId: "t-1", input }, handCtx(agentId)) as Promise<Reply>,
		results: (toolCallId: string, results: { id: string; agent: string; model?: string; output?: string }[]) =>
			handlers.tool_result!(
				{
					type: "tool_result",
					toolName: "task",
					toolCallId,
					isError: false,
					input: {},
					content: [],
					details: { results: results.map(r => ({ id: r.id, agent: r.agent, resolvedModelIdentity: r.model, ...(r.output === undefined ? {} : { output: r.output }) })) },
				},
				ctx,
			) as { isError?: boolean; content?: { text: string }[] } | undefined,
		/** A job-control snapshot (`write proc://…/kill`, `wait`) in another tool's result (snapshot-settle.test.ts `snapshot`). */
		snapshot: (toolName: string, details: unknown) =>
			handlers.tool_result!({ type: "tool_result", toolName, toolCallId: `t-${toolName}`, isError: false, input: {}, content: [{ type: "text", text: "snapshot text" }], details }, ctx) as
				| { isError?: boolean; content?: { text: string }[] }
				| undefined,
	};
}
type Lane = ReturnType<typeof lane>;

const bodies = (w: World, prefix: string) => w.ledger.entries(w.wl).map(e => e.body).filter(b => b.startsWith(prefix));

/**
 * `w.ledger` as a lane process sees it until the process is lost: once `lost(body)` matches an entry
 * it records, every later call throws — at once when `at` is `"entry"` (that entry's transaction
 * rolls back), after the transaction that recorded it commits when `at` is `"commit"`.
 */
function dying(w: World, lost: (body: string) => boolean, at: "entry" | "commit"): Ledger {
	let dead = false;
	let doomed = false;
	return new Proxy(w.ledger, {
		get(target, prop) {
			if (dead) throw new Error("the lane process is lost");
			if (prop === "recordEntry") {
				return (input: Parameters<Ledger["recordEntry"]>[0]) => {
					if (at === "entry" && lost(input.body)) {
						dead = true;
						throw new Error("the lane process is lost");
					}
					const id = target.recordEntry(input);
					if (lost(input.body)) doomed = true;
					return id;
				};
			}
			if (prop === "write") {
				return <T>(fn: () => T): T => {
					const out = target.write(fn);
					if (doomed) dead = true;
					return out;
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** The panel group the ledger records: its id and its JSON. */
function group(w: World): { pg: string; pdir: string; members: Record<string, string | null> } {
	const body = bodies(w, "panel-group: ")[0];
	if (!body) throw new Error("no panel-group entry");
	const m = /^panel-group: (pg-\S+) (\{.*\})$/.exec(body)!;
	const j = JSON.parse(m[2]!);
	return { pg: m[1]!, pdir: j.pdir, members: j.members };
}

/** A hand's own session file (one read of `reads`) and its result file, as OMP leaves them. */
function legFiles(w: World, agentId: string, reads: string, output: string) {
	const call = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: reads } }] } };
	writeFileSync(join(w.root, `${agentId}.jsonl`), `${JSON.stringify(call)}\n`);
	writeFileSync(join(w.root, `${agentId}.md`), output);
}

/** Dispatch the panel on `sl-x` and spawn every member it names; returns the call's reply. */
async function panel(h: Lane, w: World, run: string, toolCallId = "p1") {
	const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change", `panel: ${run}`) }, toolCallId);
	const spawns: Record<string, Reply> = {};
	const items = out?.input ? out.input.tasks ?? [out.input] : [];
	for (const t of items) spawns[t.name] = await h.spawn(t.agent, t.name);
	return { out, spawns };
}

/** Each member answers on its own lab with a schema-valid reply, then the blocking call returns, delivering each reply. */
function settleAll(h: Lane, w: World, toolCallId = "p1") {
	const { pdir } = group(w);
	const labs = ["anthropic", "openai", "kimi"];
	const output = (lab: string) => JSON.stringify({ items: [{ title: `${lab} finding` }] });
	for (const lab of labs) {
		const id = `sl-x--${lab}`;
		legFiles(w, id, join(pdir, "in", "packet.md"), output(lab));
		h.handMessage(id, LAB_MODEL[lab]!);
	}
	return h.results(
		toolCallId,
		labs.map(lab => ({ id: `sl-x--${lab}`, agent: "deep", model: LAB_MODEL[lab], output: output(lab) })),
	);
}

/** The synthesis reply the panel's legs support: the three labs landed, pinned to openai (anthropic built). */
const SYNTH_REPORT = JSON.stringify({
	legs: ["anthropic", "openai", "kimi"].map(lab => ({ lab, status: "landed", model: LAB_MODEL[lab], reason: "" })),
	synth: { lab: "openai", builderLab: false },
	findings: [{ id: "S1", title: "t", section: "s", supportIds: ["openai-1"], refuteIds: [] }],
	dropped: [],
	markdown: "# Panel report\n",
});

/** `panel-synth:` on the published legs of `run`: dispatched as `s1`, its hand spawned, answering on SOL, and its reply delivered. */
async function synthesise(h: Lane, w: World, run: string) {
	const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review: synthesise the panel", `panel-synth: ${run}`) }, "s1");
	expect(out?.input?.name).toBe("sl-x--synth");
	const agent = out!.input!.agent;
	expect((await h.spawn(agent, "sl-x--synth"))?.model).toEqual([SOL]);
	legFiles(w, "sl-x--synth", join(group(w).pdir, "out", "status.json"), SYNTH_REPORT);
	h.handMessage("sl-x--synth", SOL);
	return h.results("s1", [{ id: "sl-x--synth", agent, model: SOL, output: SYNTH_REPORT }]);
}

describe("panel dispatch", () => {
	test("panel: dispatches one member per lab, the builder lab included, each spawn pinned to its lab's entries", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS); // anthropic is the builder lab
		const run = stagingRun(w);
		const { out, spawns } = await panel(h, w, run);
		expect(out?.block).toBeUndefined();
		expect(out?.input?.tasks?.map(t => t.name)).toEqual(["sl-x--anthropic", "sl-x--openai", "sl-x--kimi"]);
		const { pg, pdir } = group(w);
		for (const t of out!.input!.tasks) {
			expect(t.outputSchema).toMatchObject({ type: "object", required: ["items"] });
			expect(t.task).not.toContain("panel:");
			expect(t.task).toContain(join(pdir, "in", "packet.md"));
		}
		// Byte-identical tasks across the members (triad: one shared packet).
		expect(new Set(out!.input!.tasks.map(t => t.task)).size).toBe(1);
		expect(spawns["sl-x--anthropic"]?.model).toEqual([FABLE]);
		expect(spawns["sl-x--openai"]?.model).toEqual([SOL]);
		expect(spawns["sl-x--kimi"]?.model).toEqual([K3]);
		const rows = bodies(w, "hand-spawn: ").map(b => parseHandSpawn(b)!);
		expect(rows.map(r => [r.group, r.review, r.row])).toEqual([
			[pg, true, [FABLE]],
			[pg, true, [SOL]],
			[pg, true, [K3]],
		]);
		expect(existsSync(join(pdir, "in", "manifest.json"))).toBe(true);
	});

	test("a lab with no usable entry is a missing leg, and no other lab is substituted", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		down(w, K3);
		const { out } = await panel(h, w, stagingRun(w));
		expect(out?.input?.tasks?.map(t => t.name)).toEqual(["sl-x--anthropic", "sl-x--openai"]);
		const { pg, members } = group(w);
		expect(members.kimi).toBeNull();
		expect(bodies(w, `panel-leg: ${pg} kimi missing`)).toHaveLength(1);
		expect(bodies(w, "hand-spawn: ").flatMap(b => parseHandSpawn(b)!.row)).not.toContain(K3);
	});

	test("a member whose lab goes down before its spawn is refused and ends missing", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change", `panel: ${stagingRun(w)}`) }, "p1");
		expect(out?.input?.tasks).toHaveLength(3);
		down(w, SOL);
		const spawn = await h.spawn("deep", "sl-x--openai");
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain("no other lab is substituted");
		expect(bodies(w, `panel-leg: ${group(w).pg} openai missing`)).toHaveLength(1);
	});

	test("settled members write panel-leg lines and the published outputs, never a review round", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await panel(h, w, stagingRun(w));
		settleAll(h, w);
		const { pg, pdir } = group(w);
		expect(bodies(w, `panel-leg: ${pg}`).map(b => b.split(" ").slice(2, 4).join(" "))).toEqual(["anthropic landed", "openai landed", "kimi landed"]);
		expect(bodies(w, "review-round:")).toEqual([]);
		expect(countRounds(w.ledger.entries(w.wl), "sl-x").rounds).toEqual([]);
		expect(bodies(w, `panel-published: ${pg} out`)).toHaveLength(1);
		const status = JSON.parse(readFileSync(join(pdir, "out", "status.json"), "utf8"));
		expect(status.legs.openai).toMatchObject({ status: "landed", model: SOL, findingIds: ["openai-1"] });
		expect(JSON.parse(readFileSync(join(pdir, "out", "legs", "kimi.json"), "utf8")).items).toEqual([{ id: "kimi-1", title: "kimi finding" }]);
	});

	test("a leg whose job snapshot shows it cancelled with no text ends missing through the panel, never a review round", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await panel(h, w, stagingRun(w));
		const { pg } = group(w);
		const job = { id: "sl-x--openai", type: "task", status: "cancelled", label: "sl-x--openai", durationMs: 5 };
		h.snapshot("write", { proc: { op: "cancel", jobs: [job], cancelled: [{ id: "sl-x--openai", status: "cancelled" }] } });
		expect(bodies(w, `panel-leg: ${pg} openai`)).toEqual([expect.stringMatching(new RegExp(`^panel-leg: ${pg} openai missing withheld cancelled-no-output`))]);
		expect(bodies(w, "review-round:")).toEqual([]);
		expect(bodies(w, "hand-settled:")).toHaveLength(1);
		expect(countRounds(w.ledger.entries(w.wl), "sl-x").rounds).toEqual([]);
	});

	test("headroom projecting out the first non-builder lab pins the synthesis to the next usable lab, and it spawns", async () => {
		const saved = process.env.AS2_HEADROOM_POLLS;
		try {
			const w = world();
			// timing-under-test: quota freshness selects the next usable synthesis lab (fake clock: now)
			const now = Date.parse("2026-11-01T00:00:00-07:00");
			const h = lane(w, w.ledger, { now: () => now });
			h.laneMessage(OPUS); // anthropic built: openai is the first non-builder lab in row order
			const run = stagingRun(w);
			await panel(h, w, run);
			settleAll(h, w);
			// The quota watcher's newest poll: openai-codex's 5h window at 0.85 (over the 80 % ceiling), resetting in 4.9 h.
			const limits = [{ provider: "openai-codex", windowId: "5h", tier: null, resetsAt: now + 4.9 * 3_600_000, usedFraction: 0.85 }];
			const polls = join(w.dir, "polls.jsonl");
			writeFileSync(polls, `${JSON.stringify({ t: (now - 60_000) / 1000, rows: {}, limits })}\n`);
			process.env.AS2_HEADROOM_POLLS = polls;
			const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review: synthesise the panel", `panel-synth: ${run}`) }, "s1");
			expect(out?.block).toBeUndefined();
			expect(out?.input?.name).toBe("sl-x--synth");
			const spawn = await h.spawn(out!.input!.agent, "sl-x--synth");
			expect(spawn?.block).toBeUndefined();
			expect(spawn?.model).toEqual([K3]);
			expect(bodies(w, "panel-synth: ")).toHaveLength(1);
			expect(bodies(w, "hand-spawn: ").map(b => parseHandSpawn(b)!.row).at(-1)).toEqual([K3]);
		} finally {
			if (saved === undefined) delete process.env.AS2_HEADROOM_POLLS;
			else process.env.AS2_HEADROOM_POLLS = saved;
		}
	});

	test("a leg that names another file under its panel is excluded for the breach", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await panel(h, w, stagingRun(w));
		const { pg, pdir } = group(w);
		legFiles(w, "sl-x--kimi", join(pdir, "in", "synth.md"), JSON.stringify({ items: [] }));
		h.handMessage("sl-x--kimi", K3);
		const out = h.results("p1", [{ id: "sl-x--kimi", agent: "deep", model: K3, output: "{}" }]);
		expect(out?.isError).toBe(true);
		expect(bodies(w, `panel-leg: ${pg} kimi excluded breach`)).toHaveLength(1);
	});

	test("panel: on the plan slice is refused", async () => {
		const w = world();
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.wl, kind: "assumption", body: "plan: first production" });
		const h = lane(w);
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the plan", `panel: ${stagingRun(w)}`) }, "p1");
		expect(out?.block).toBe(true);
		expect(out?.reason).toContain("is the plan slice");
		expect(bodies(w, "panel-group:")).toEqual([]);
	});

	test("a panel: item the judge does not call a review is refused", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "change the loader", `panel: ${stagingRun(w)}`) }, "p1");
		expect(out?.block).toBe(true);
		expect(out?.reason).toContain("a panel runs only as a review dispatch");
	});

	test("panel-synth: before the legs are published is refused", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const run = stagingRun(w);
		await panel(h, w, run);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review: synthesise the panel", `panel-synth: ${run}`) }, "s1");
		expect(out?.block).toBe(true);
		expect(out?.reason).toContain("no panel-published out yet");
	});

	test("a staging run prepared for another workload is refused, and so is a run dispatched twice", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		const other = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it", `panel: ${stagingRun(w, { workload: "wl-other" })}`) }, "p1");
		expect(other?.block).toBe(true);
		expect(other?.reason).toContain("belongs to workload wl-other");
		const run = stagingRun(w, { name: "run-2" });
		await panel(h, w, run, "p2");
		settleAll(h, w, "p2");
		const again = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review it", `panel: ${run}`) }, "p3");
		expect(again?.block).toBe(true);
		expect(again?.reason).toContain("was already dispatched as pg-");
	});

	test("recovery: a second instance settles a lost member's result without a review round", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await panel(h, w, stagingRun(w));
		const { pg } = group(w);
		const restarted = lane(w); // the first process is lost with its hands
		const out = restarted.results("p1", [{ id: "sl-x--openai", agent: "deep", model: SOL, output: "{}" }]);
		expect(out?.isError).toBe(true); // no routing row: its models are unknown
		expect(bodies(w, `panel-leg: ${pg} openai missing`)).toHaveLength(1);
		expect(bodies(w, "review-round:")).toEqual([]);
	});

	test("an editing tool naming a panel directory is refused in any session", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await panel(h, w, stagingRun(w));
		const { pdir } = group(w);
		const out = await h.handEdit("sl-other", "write", { path: join(pdir, "out", "status.json"), content: "{}" });
		expect(out?.block).toBe(true);
		expect(out?.reason).toContain("panel directory");
	});

	test("an ordinary production review after a panel still routes off the builder lab", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await panel(h, w, stagingRun(w));
		settleAll(h, w);
		const out = await h.toolCall({ agent: "strong", name: "sl-y", task: brief(w, "review the change") }, "r1");
		expect(out?.input?.tasks?.map(t => t.name)).toEqual(["sl-y--openai", "sl-y--kimi"]);
	});

	test("a leg whose result file is not the output delivered for it is excluded, never landed", async () => {
		const w = world();
		const h = lane(w);
		h.laneMessage(OPUS);
		await panel(h, w, stagingRun(w));
		const { pg, pdir } = group(w);
		legFiles(w, "sl-x--kimi", join(pdir, "in", "packet.md"), JSON.stringify({ items: [{ title: "a reply written over the delivered one" }] }));
		h.handMessage("sl-x--kimi", K3);
		const out = h.results("p1", [{ id: "sl-x--kimi", agent: "deep", model: K3, output: JSON.stringify({ items: [{ title: "kimi finding" }] }) }]);
		expect(out?.isError).toBe(true);
		expect(bodies(w, `panel-leg: ${pg} kimi excluded delivered-mismatch`)).toHaveLength(1);
		expect(bodies(w, `panel-leg: ${pg} kimi landed`)).toEqual([]);
	});

	/** The panel published, then its synthesis hand's settle cut off by the lane process being lost where `lost`/`at` say. */
	async function lostSynthesis(lost: (body: string, w: World) => boolean, at: "entry" | "commit") {
		const w = world();
		const run = stagingRun(w);
		const h = lane(w, dying(w, body => lost(body, w), at));
		h.laneMessage(OPUS);
		await panel(h, w, run);
		settleAll(h, w);
		const { pg, pdir } = group(w);
		expect(bodies(w, `panel-published: ${pg} out`)).toHaveLength(1);
		await synthesise(h, w, run);
		expect(bodies(w, "hand-settled: ")).toHaveLength(4);
		expect(bodies(w, `panel-published: ${pg} report`)).toEqual([]);
		return { w, pg, pdir };
	}

	/** A new lane process starts on the workload, with no result redelivered: its sweep publishes the report from the hand's result file. */
	async function resumed(w: World, pg: string, pdir: string) {
		await lane(w).sessionStart();
		expect(bodies(w, `panel-published: ${pg} report`)).toHaveLength(1);
		expect(bodies(w, `panel-synth: ${pg} `).filter(b => b.includes(` landed sha256 ${sha(SYNTH_REPORT)}`))).toHaveLength(1);
		expect(readFileSync(join(pdir, "out", "report.json"), "utf8")).toBe(SYNTH_REPORT);
		expect(readFileSync(join(pdir, "out", "REPORT.md"), "utf8")).toBe("# Panel report\n");
	}

	test("restart: a synthesis lost right after its settle transaction commits is published by the next session's sweep", async () => {
		// The synthesis hand's `hand-settled:` is the only one recorded once the legs are published.
		const { w, pg, pdir } = await lostSynthesis((body, w) => body.startsWith("hand-settled: ") && bodies(w, "panel-published: ").length > 0, "commit");
		expect(existsSync(join(pdir, "out", "report.json"))).toBe(false);
		await resumed(w, pg, pdir);
	});

	test("restart: a synthesis whose publication transaction rolled back after its files were written is published by the next session's sweep", async () => {
		const { w, pg, pdir } = await lostSynthesis(body => /^panel-synth: \S+ \S+ landed /.test(body), "entry");
		expect(readFileSync(join(pdir, "out", "report.json"), "utf8")).toBe(SYNTH_REPORT); // written, never recorded
		await resumed(w, pg, pdir);
	});
});

describe("Anthropic-out panel consumers", () => {
	const active = () => Date.parse("2026-10-30T12:00:00-07:00");
	const nonCodex = "openai/fixture-review";
	const mixedTable = tierTableFromConfig({ task: { agentModelOverrides: { ...ROWS, strong: [...ROWS.strong, nonCodex] } } });

	test("leg planning and spawn expose only Codex, with excluded labs explicitly missing", async () => {
		const w = world();
		w.creds.push(nonCodex);
		w.registry = fakeRegistry([...ALL, nonCodex], w.creds);
		const h = lane(w, w.ledger, { laneModel: SOL, now: active, table: mixedTable });
		h.laneMessage(SOL);
		const { out, spawns } = await panel(h, w, stagingRun(w));
		expect(out?.input?.name).toBe("sl-x--openai");
		expect(spawns["sl-x--openai"]?.model).toEqual([SOL]);
		const { pg } = group(w);
		expect(bodies(w, `panel-leg: ${pg} anthropic missing`)).toHaveLength(1);
		expect(bodies(w, `panel-leg: ${pg} kimi missing`)).toHaveLength(1);
		h.handMessage("sl-x--openai", nonCodex);
		expect(h.results("p1", [{ id: "sl-x--openai", agent: "deep", model: nonCodex, output: "{}" }])?.isError).toBe(true);
		expect(w.ledger.routings(w.wl).at(-1)).toMatchObject({ models: JSON.stringify([SOL]), outcome: "refused-out-of-row" });
	});

	test("synthesis planning after a lane switch ignores the usable non-Codex labs and records Codex-only spawn and settle allowlist", async () => {
		const w = world();
		w.creds.push(nonCodex);
		w.registry = fakeRegistry([...ALL, nonCodex], w.creds);
		const h = lane(w, w.ledger, { laneModel: OPUS, now: active, table: mixedTable });
		h.laneMessage(OPUS);
		const run = stagingRun(w);
		await panel(h, w, run);
		settleAll(h, w);
		h.setLaneModel(SOL);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review: synthesise the panel", `panel-synth: ${run}`) }, "s1");
		expect(out?.input?.name).toBe("sl-x--synth");
		expect((await h.spawn(out!.input!.agent, "sl-x--synth"))?.model).toEqual([SOL]);
		h.handMessage("sl-x--synth", K3);
		expect(h.results("s1", [{ id: "sl-x--synth", agent: "deep", model: K3, output: "{}" }])?.isError).toBe(true);
		expect(w.ledger.routings(w.wl).at(-1)).toMatchObject({ models: JSON.stringify([SOL]), outcome: "refused-out-of-row" });
	});

	test("Anthropic and Kimi pins published before an OpenAI lane switch refuse instead of substituting Codex", async () => {
		const w = world();
		const h = lane(w, w.ledger, { laneModel: OPUS, now: active });
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change", `panel: ${stagingRun(w)}`) });
		expect(out?.input?.tasks).toHaveLength(3);
		h.setLaneModel(SOL);
		for (const lab of ["anthropic", "kimi"]) {
			const spawn = await h.spawn("deep", `sl-x--${lab}`);
			expect(spawn?.block).toBe(true);
			expect(spawn?.reason).toContain("no other lab is substituted");
		}
		expect((await h.spawn("deep", "sl-x--openai"))?.model).toEqual([SOL]);
		expect(w.ledger.questions(w.wl)).toEqual([]);
	});

	test("a synthesis pin published on Anthropic refuses after switching to OpenAI", async () => {
		const w = world();
		const h = lane(w, w.ledger, { laneModel: OPUS, now: active });
		h.laneMessage(OPUS);
		const run = stagingRun(w);
		await panel(h, w, run);
		settleAll(h, w);
		down(w, SOL, K3); // synthesis must be published with its Anthropic pin
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review: synthesise the panel", `panel-synth: ${run}`) });
		expect(out?.block).toBeUndefined();
		w.creds.push(SOL, K3);
		h.setLaneModel(SOL);
		const spawn = await h.spawn(out!.input!.agent, "sl-x--synth");
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain("no other lab is substituted");
	});
});
