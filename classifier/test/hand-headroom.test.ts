/**
 * A build hand moves lab on a used-up week (PLAN wl-mvwk0v0gmp6cjc D6, R10–R12; Jo, in-mvwl9tkmsym86o, amending
 * in-mv7hm58386f2o0 for this case). The host builds the classifier on a temp ledger and a fake model registry, as
 * crosslab.test.ts's `lane()` does: helpers.ts `extensionHost` has no seam for the move-alert spawn, and no test may start
 * the real worker, so `spawnMoveAlert` runs surface/src/quota-move-alert.ts's own `spawnMoveAlert` with a fake spawner.
 * The quota guard reads real-shaped poll lines from the file `AS2_HEADROOM_POLLS` names, on the lane's injected clock.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import type { Gh, GhResult } from "../../surface/src/jo-issues";
import { TRAIN_ALERT_REPO } from "../../surface/src/merge-train";
import {
	commentMarker, DISMISS_BUTTON, type MoveAlertSeams, moveAlertTroubles, quotaMove, quotaMoveMessageId, quotaMoves, runMoveAlert, spawnMoveAlert,
} from "../../surface/src/quota-move-alert";
import { createClassifierExtension } from "../extension";
import { loadCalibration } from "../src/classify";
import { builderLabs } from "../src/lab";
import { tierTableFromConfig } from "../src/tier-table";
import { asyncDelivery, currentModel, dist, type FakeRegistry, fakeRegistry, recordedQuestion } from "./helpers";

const ROWS = {
	fast: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-5.6-luna", "moonshot/kimi-k2.7-code-highspeed"],
	standard: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6-luna", "moonshot/kimi-k2.5"],
	strong: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "moonshot/kimi-k2.7-code"],
	deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra", "moonshot/kimi-k3"],
};
const TABLE = tierTableFromConfig({ task: { agentModelOverrides: ROWS } });
const ALL = Object.values(ROWS).flat();
const [OPUS, SOL, KIMI] = ROWS.strong as [string, string, string];
const LANE_ID = "lane-hh";
/** The lane's clock: after Jo's dated Kimi-out and Anthropic-out rules ended, so neither applies. */
const NOW = Date.parse("2026-11-02T12:00:00-08:00");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EXHAUSTED = "anthropic 7d 1.00 used, quota exhausted";
const FIVE_HOUR_OUT = "anthropic 5h 0.90 used > 0.80";

/** By task text: `review…` judge; anything else change-large (the strong tier). */
const JUDGE = {
	judge: async ({ state }: { state: string }) => ({
		answers: {
			kind: /^task: review/m.test(state)
				? { choice: "judge", confidence: 0.9, probabilities: dist({ judge: 0.9 }) }
				: { choice: "change-large", confidence: 0.9, probabilities: dist({ "change-large": 0.9 }) },
		},
		provider: "typesafe",
		model: "jev-1.13.0",
	}),
};

type Limit = { provider?: string; windowId: string; used: number; resetsIn: number; tier?: string };
/** One poll line a minute before the lane's clock; anthropic unless a limit names its provider. */
const poll = (limits: Limit[]) =>
	JSON.stringify({
		t: (NOW - MIN) / 1000,
		rows: {},
		limits: limits.map(l => ({ provider: l.provider ?? "anthropic", windowId: l.windowId, tier: l.tier ?? null, resetsAt: NOW + l.resetsIn, usedFraction: l.used })),
	});
/** The 5h window six minutes in (before its pace warm-up), so only the 80 % rule can take it out. */
const fiveHour = (used: number): Limit => ({ windowId: "5h", used, resetsIn: 4.9 * HOUR });
/** Anthropic's week, four days in. */
const week = (used: number): Limit => ({ windowId: "7d", used, resetsIn: 3 * DAY });
/** OpenAI's week one day in: before warm-up, so it never projects out. */
const openaiWeek: Limit = { provider: "openai-codex", windowId: "7d", used: 0.2, resetsIn: 6 * DAY };

const dirs: string[] = [];
let savedPolls: string | undefined;
beforeEach(() => {
	savedPolls = process.env.AS2_HEADROOM_POLLS;
});
afterEach(() => {
	if (savedPolls === undefined) delete process.env.AS2_HEADROOM_POLLS;
	else process.env.AS2_HEADROOM_POLLS = savedPolls;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A workload on a temp ledger, the lane's session file and root, and the model registry its lane sees. */
interface World {
	ledger: Ledger;
	wl: string;
	laneFile: string;
	root: string;
	registry: FakeRegistry;
}

/** A workload on a temp ledger with its slices, the lane's session file, a polls file holding `lines`, and a credentialed registry. */
function world(...lines: string[]): World {
	const dir = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "hand-headroom-"));
	dirs.push(dir);
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backup: false });
	const wl = ledger.openWorkload({ id: "wl-handroom", brief: "hand headroom test", stakes: "normal", mode: "autonomous", by: "orch-test" });
	for (const id of ["sl-work", "sl-x"]) ledger.addSlice({ id, workloadId: wl, task: id, doneCondition: "d", inputs: "i", by: LANE_ID });
	mkdirSync(join(dir, "sessions"));
	const laneFile = join(dir, "sessions", "lane.jsonl");
	writeFileSync(laneFile, "");
	const polls = join(dir, "polls.jsonl");
	writeFileSync(polls, `${lines.join("\n")}\n`);
	process.env.AS2_HEADROOM_POLLS = polls;
	return { ledger, wl, laneFile, root: laneFile.slice(0, -".jsonl".length), registry: fakeRegistry(ALL, [...ALL]) };
}

const brief = (w: World, task: string) =>
	`workload: ${w.wl}\ntask: ${task}\ndone-condition: d\ninputs: i\nstakes: normal\nceiling-share: 10\n## How it fails\n- the hand fails: its failure reaches the ledger; redispatch once`;

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Reply = { block?: boolean; reason?: string; input?: { agent: string; name: string }; model?: string[]; note?: string } | undefined;

/** One lane process's hooks, and what it logged and spawned. */
interface Lane {
	logs: string[];
	spawned: string[][];
	toolCall(input: unknown, toolCallId: string): Promise<Reply>;
	spawn(agent: string, spawnKey: string | undefined, invocationKind?: string): Promise<Reply>;
	laneMessage(selector: string): unknown;
	handMessage(agentId: string, selector: string): unknown;
	results(toolCallId: string, results: { id: string; agent: string; model: string }[]): { isError?: boolean } | undefined;
	deliver(agentIds: string[]): unknown;
}

/**
 * One lane process. `bound`: the session's bound workload (`AGENT_SYSTEM_WORKLOAD_ID`), the world's unless given;
 * `ledger`: what `deps.ledger()` returns (a failing stand-in for the one-transaction check). `alert`: the move alert's
 * start, by default the real `spawnMoveAlert` with a fake spawner whose argv lands in `spawned`.
 */
function lane(w: World, opts: { laneModel?: string; bound?: string | null; ledger?: Ledger; alert?: (ledger: Ledger, wl: string, eventId: string) => number | null } = {}): Lane {
	const handlers: Record<string, Handler> = {};
	const handSession: Record<string, Handler> = {};
	const logs: string[] = [];
	const spawned: string[][] = [];
	const extension = createClassifierExtension({
		judge: async () => JUDGE as never,
		tierTable: () => TABLE,
		disabledProviders: async () => [],
		question: recordedQuestion(),
		calibration: loadCalibration(),
		ledger: () => opts.ledger ?? w.ledger,
		laneId: LANE_ID,
		boundWorkload: () => (opts.bound === null ? undefined : (opts.bound ?? w.wl)),
		ompState: () => "same",
		lastWrite: () => null,
		log: line => logs.push(line),
		now: () => NOW,
		fingerprint: () => "fingerprint",
		spawnMoveAlert: opts.alert ?? ((ledger, wl, eventId) =>
			spawnMoveAlert(ledger, wl, eventId, argv => {
				spawned.push(argv);
				return 4242;
			}, () => false)),
	});
	extension({ on: (name: string, h: Handler) => (handlers[name] = h) } as never);
	extension({ on: (name: string, h: Handler) => (handSession[name] = h) } as never);
	const ctx = { cwd: w.root, modelRegistry: w.registry, model: currentModel(opts.laneModel ?? OPUS), sessionManager: { getSessionFile: () => w.laneFile } };
	const assistant = (selector: string) => {
		const [provider, ...model] = selector.split("/");
		return { type: "message_end", message: { role: "assistant", provider, model: model.join("/"), content: [] } };
	};
	return {
		logs,
		spawned,
		toolCall: (input: unknown, toolCallId: string) => handlers.tool_call!({ type: "tool_call", toolName: "task", toolCallId, input }, ctx) as Promise<Reply>,
		spawn: (agent: string, spawnKey: string | undefined, invocationKind = "task") =>
			handlers.before_subagent_spawn!({ type: "before_subagent_spawn", agent, invocationKind, patterns: [], spawnKey }, ctx) as Promise<Reply>,
		laneMessage: (selector: string) => {
			ctx.model = currentModel(selector);
			return handlers.message_end!(assistant(selector), ctx);
		},
		handMessage: (agentId: string, selector: string) =>
			handSession.message_end!(assistant(selector), { ...ctx, sessionManager: { getSessionFile: () => `${w.root}/${agentId}.jsonl` } }),
		results: (toolCallId: string, results: { id: string; agent: string; model: string }[]) =>
			handlers.tool_result!(
				{ type: "tool_result", toolName: "task", toolCallId, isError: false, input: {}, content: [], details: { results: results.map(r => ({ id: r.id, agent: r.agent, resolvedModelIdentity: r.model })) } },
				ctx,
			) as { isError?: boolean } | undefined,
		deliver: (agentIds: string[]) => handlers.context!({ type: "context", messages: [asyncDelivery(agentIds)] }, ctx),
	};
}

const bodies = (w: World, prefix: string) => w.ledger.entries(w.wl).map(e => e.body).filter(b => b.startsWith(prefix));

/** A classified build dispatch of sl-work up to its spawn reply. */
async function buildSpawn(h: Lane, w: World, call = "c1") {
	const out = await h.toolCall({ agent: "strong", name: "sl-work", task: brief(w, "change the loader") }, call);
	expect(out?.block).toBeUndefined();
	return { agent: out!.input!.agent, spawn: await h.spawn(out!.input!.agent, "sl-work") };
}

/** The `hand-spawn:` token of the one spawned hand. */
const tokenOf = (w: World) => bodies(w, "hand-spawn:")[0]!.split(" ")[1]!;

describe("an exhausted Anthropic week moves a build hand to the first usable OpenAI strong entry (R10)", () => {
	for (const [label, limits, skip] of [
		["the week alone", [fiveHour(0.1), week(1), openaiWeek], `anthropic 7d 1.00 used, window pace +`],
		["a 5h limit refused first", [fiveHour(0.9), week(1), openaiWeek], FIVE_HOUR_OUT],
	] as [string, Limit[], string][]) {
		test(`classified, ${label}: hand-spawn: on [SOL], hand-headroom: and its quota-move: message, the alert, no routing until settle`, async () => {
			const w = world(poll(limits));
			const h = lane(w);
			h.laneMessage(OPUS);
			const { agent, spawn } = await buildSpawn(h, w);
			expect(spawn?.block).toBeUndefined();
			expect(spawn?.model).toEqual([SOL]);
			const token = tokenOf(w);
			const subject = `hand ${token} (slice sl-work) of lane ${LANE_ID}`;
			expect(bodies(w, "hand-spawn:")).toEqual([expect.stringContaining(` row ${SOL}`)]);
			expect(bodies(w, "headroom-skip:")).toEqual([expect.stringContaining(`headroom-skip: ${OPUS} token ${token} ${skip}`)]);
			expect(bodies(w, "hand-headroom:")).toEqual([`hand-headroom: ${subject} ${OPUS} -> ${SOL} (${EXHAUSTED})`]);
			// The record and its NOW message: one event, the message tied to it by id, by the lane, held for the orchestrator.
			const event = w.ledger.entries(w.wl).find(e => e.body.startsWith("hand-headroom:"))!;
			expect(event.created_by).toBe(LANE_ID);
			expect(w.ledger.message(quotaMoveMessageId(event.id))).toMatchObject({
				recipient: "orchestrator",
				state: "held",
				body: `quota-move: ${subject} on ${w.wl}: ${OPUS} -> ${SOL} (${EXHAUSTED})`,
			});
			expect(spawn?.note).toContain(`moved off the lane lab anthropic (${OPUS}) to ${SOL}: ${EXHAUSTED} (hand-headroom ${event.id}`);
			// The alert's worker was started for this event (fake spawner), each channel marked spawning.
			expect(h.spawned).toEqual([[expect.any(String), expect.stringContaining("lane.ts"), "move-alert", w.wl, event.id]]);
			expect(bodies(w, `quota-move-alert: ${event.id} `)).toEqual([`quota-move-alert: ${event.id} comment spawning`, `quota-move-alert: ${event.id} popup spawning`]);
			// No routing at the move; the target lab is a builder once spawned.
			expect(w.ledger.routings(w.wl)).toEqual([]);
			expect(builderLabs(w.ledger, w.wl).labs).toContain("openai");
			// The routing row is written at the verdict, from what answered.
			h.handMessage("sl-work", SOL);
			expect(h.results("c1", [{ id: "sl-work", agent, model: SOL }])).toBeUndefined();
			expect(w.ledger.routings(w.wl)).toMatchObject([{ slice_id: "sl-work", outcome: "ran", models: JSON.stringify([SOL]), ran_models: JSON.stringify([SOL]) }]);
		});
	}

	test("unclassified: moves on the bound workload under subject `unclassified hand <key>`, with no hand-spawn: (none is written today)", async () => {
		const w = world(poll([fiveHour(0.9), week(1), openaiWeek]));
		const h = lane(w);
		const spawn = await h.spawn("strong", "Eval.1", "eval");
		expect(spawn?.model).toEqual([SOL]);
		const subject = `unclassified hand Eval.1 of lane ${LANE_ID}`;
		expect(bodies(w, "hand-headroom:")).toEqual([`hand-headroom: ${subject} ${OPUS} -> ${SOL} (${EXHAUSTED})`]);
		expect(quotaMoves(w.ledger).map(m => [m.subject, m.from, m.to, m.reason])).toEqual([[subject, OPUS, SOL, EXHAUSTED]]);
		expect(bodies(w, "hand-spawn:")).toEqual([]);
		expect(h.spawned).toHaveLength(1);

		const keyless = world(poll([week(1), openaiWeek]));
		expect((await lane(keyless).spawn("strong", undefined, "eval"))?.model).toEqual([SOL]);
		expect(bodies(keyless, "hand-headroom:")).toEqual([`hand-headroom: unclassified hand no key of lane ${LANE_ID} ${OPUS} -> ${SOL} (${EXHAUSTED})`]);
	});

	test("unclassified with no bound workload: today's refusal, nothing recorded, and the log says why", async () => {
		const w = world(poll([week(1), openaiWeek]));
		const h = lane(w, { bound: null });
		const spawn = await h.spawn("strong", "Eval.1", "eval");
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain(`no usable strong model on the lane lab anthropic (${OPUS})`);
		expect(spawn?.reason).toContain("a build hand never runs on another lab");
		expect(quotaMoves(w.ledger)).toEqual([]);
		expect(h.spawned).toEqual([]);
		expect(h.logs).toEqual([expect.stringContaining("unclassified hand Eval.1 not moved off")]);
	});

	test("the first usable entry in row order: an unusable OpenAI entry passes the move to Kimi", async () => {
		const w = world(poll([week(1), openaiWeek]));
		w.registry = fakeRegistry(ALL, ALL.filter(m => m !== SOL));
		const h = lane(w);
		h.laneMessage(OPUS);
		expect((await buildSpawn(h, w)).spawn?.model).toEqual([KIMI]);
		expect(bodies(w, "hand-headroom:")).toEqual([expect.stringContaining(`${OPUS} -> ${KIMI} (${EXHAUSTED})`)]);
		expect(builderLabs(w.ledger, w.wl).labs).toContain("kimi");
	});

	test("nothing usable on any lab: today's refusal and wording, no move", async () => {
		const w = world(poll([week(1), openaiWeek]));
		w.registry = fakeRegistry(ALL, ALL.filter(m => m !== SOL && m !== KIMI));
		const h = lane(w);
		h.laneMessage(OPUS);
		const { spawn } = await buildSpawn(h, w);
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toBe(`agent-system-2 classifier: no usable strong model on the lane lab anthropic (${OPUS}): ${OPUS} (projected out: anthropic 7d 1.00 used, window pace +1.0 pts/h, projected 1.75 at reset ${new Date(NOW + 3 * DAY).toISOString().slice(0, 16)}Z); a build hand never runs on another lab`);
		expect(quotaMoves(w.ledger)).toEqual([]);
		expect(w.ledger.routings(w.wl)).toMatchObject([{ slice_id: "sl-work", outcome: "refused-no-usable-model" }]);
	});

	test("one transaction: when the quota-move: message cannot be written, neither hand-spawn: nor hand-headroom: is, and the spawn is refused", async () => {
		const w = world(poll([week(1), openaiWeek]));
		const broken = Object.create(w.ledger) as Ledger;
		broken.enqueue = () => {
			throw new Error("disk I/O error");
		};
		const h = lane(w, { ledger: broken });
		h.laneMessage(OPUS);
		const { spawn } = await buildSpawn(h, w);
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain("disk I/O error");
		expect(bodies(w, "hand-spawn:")).toEqual([]);
		expect(bodies(w, "hand-headroom:")).toEqual([]);
		expect(bodies(w, "headroom-skip:")).toEqual([]);
		expect(quotaMoves(w.ledger)).toEqual([]);
	});

	test("an alert that cannot be started is logged with its event id and does not undo the spawn", async () => {
		const w = world(poll([week(1), openaiWeek]));
		const h = lane(w, {
			alert: () => {
				throw new Error("spawn failed and recording that failed too");
			},
		});
		h.laneMessage(OPUS);
		const { spawn } = await buildSpawn(h, w);
		expect(spawn?.model).toEqual([SOL]);
		const event = w.ledger.entries(w.wl).find(e => e.body.startsWith("hand-headroom:"))!;
		expect(h.logs).toEqual([expect.stringContaining(`move alert ${event.id} on ${w.wl}`)]);
		expect(h.logs[0]).toContain("spawn failed and recording that failed too");
		expect(bodies(w, "hand-spawn:")).toHaveLength(1);
	});
});

describe("no exhausted week, no move (R11)", () => {
	test("a 5h-only out is refused as today, with no move and no quota-move: message", async () => {
		const w = world(poll([fiveHour(0.9), week(0.3), openaiWeek]));
		const h = lane(w);
		h.laneMessage(OPUS);
		const { spawn } = await buildSpawn(h, w);
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toBe(`agent-system-2 classifier: no usable strong model on the lane lab anthropic (${OPUS}): ${OPUS} (projected out: ${FIVE_HOUR_OUT}); a build hand never runs on another lab`);
		expect(bodies(w, "hand-headroom:")).toEqual([]);
		expect(quotaMoves(w.ledger)).toEqual([]);
		expect(h.spawned).toEqual([]);
		const unclassified = await h.spawn("strong", "Eval.1", "eval");
		expect(unclassified?.block).toBe(true);
		expect(quotaMoves(w.ledger)).toEqual([]);
	});

	test("a week-pace-only out (an OpenAI lane's week projected past 1.0) is refused as today, with no move", async () => {
		// Half the week gone at 0.6: projected 1.20 at reset, under no exhaustion.
		const w = world(poll([{ provider: "openai-codex", windowId: "7d", used: 0.6, resetsIn: 3.5 * DAY }, week(0.3)]));
		const h = lane(w, { laneModel: SOL });
		h.laneMessage(SOL);
		const { spawn } = await buildSpawn(h, w);
		expect(spawn?.block).toBe(true);
		expect(spawn?.reason).toContain(`no usable strong model on the lane lab openai (${SOL}): ${SOL} (projected out: openai-codex 7d 0.60 used, window pace +`);
		expect(spawn?.reason).toContain("a build hand never runs on another lab");
		expect(quotaMoves(w.ledger)).toEqual([]);
		expect(h.spawned).toEqual([]);
	});

	test("a hand on a lane that already moved is a normal spawn on the lane's lab, with no alert", async () => {
		const w = world(poll([week(1), openaiWeek]));
		const h = lane(w, { laneModel: SOL });
		h.laneMessage(SOL);
		const { spawn } = await buildSpawn(h, w);
		expect(spawn?.model).toEqual([SOL]);
		expect(spawn?.note).not.toContain("moved off");
		expect(bodies(w, "hand-headroom:")).toEqual([]);
		expect(quotaMoves(w.ledger)).toEqual([]);
	});

	test("a review routes as today under the exhausted week: off the builder lab, no move", async () => {
		const w = world(poll([week(1), openaiWeek]));
		const h = lane(w);
		h.laneMessage(OPUS);
		const out = await h.toolCall({ agent: "strong", name: "sl-x", task: brief(w, "review the change") }, "rev-1");
		expect(out?.block).toBeUndefined();
		const review = await h.spawn(out!.input!.agent, "sl-x");
		expect(review?.model).toEqual([SOL, KIMI]);
		expect(review?.note).toContain("review routed off the builder lab anthropic");
		expect(bodies(w, "hand-headroom:")).toEqual([]);
		expect(quotaMoves(w.ledger)).toEqual([]);

		// An OpenAI-built workload: the review skips the exhausted Claude entry and runs on Kimi, as today; still no move.
		const v = world(poll([week(1), openaiWeek]));
		const r = lane(v, { laneModel: SOL });
		r.laneMessage(SOL);
		const rout = await r.toolCall({ agent: "strong", name: "sl-x", task: brief(v, "review the change") }, "rev-1");
		const other = await r.spawn(rout!.input!.agent, "sl-x");
		expect(other?.model).toEqual([KIMI]);
		expect(other?.note).toContain(`skipped ${OPUS} (projected out: anthropic 7d 1.00 used, window pace +`);
		expect(quotaMoves(v.ledger)).toEqual([]);
	});
});

interface FakeIssue {
	number: number;
	title: string;
	body: string;
	comments: { body: string; url: string }[];
}

/** jo-issues in memory: the REST listing (one page), issue create / view / comment, label create. */
function fakeGh() {
	const issues: FakeIssue[] = [];
	const url = (n: number) => `https://github.com/${TRAIN_ALERT_REPO}/issues/${n}`;
	const flag = (args: string[], f: string) => args[args.indexOf(f) + 1]!;
	const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: "" });
	const gh: Gh = args => {
		if (args[0] === "api" && args[1] === `repos/${TRAIN_ALERT_REPO}/issues`) return ok(JSON.stringify([issues.map(i => ({ body: i.body, html_url: url(i.number) }))]));
		if (args[0] === "issue" && args[1] === "create") {
			issues.push({ number: issues.length + 1, title: flag(args, "--title"), body: flag(args, "--body"), comments: [] });
			return ok(`${url(issues.length)}\n`);
		}
		const issue = issues[Number(args[2]) - 1];
		if (args[0] === "issue" && args[1] === "view" && issue) return ok(JSON.stringify({ comments: issue.comments }));
		if (args[0] === "issue" && args[1] === "comment" && issue) {
			const u = `${url(issue.number)}#issuecomment-${issue.comments.length + 1}`;
			issue.comments.push({ body: flag(args, "--body"), url: u });
			return ok(`${u}\n`);
		}
		if (args[0] === "label" && args[1] === "create") return ok("");
		return { code: 1, stdout: "", stderr: `fake gh: unexpected call ${args.join(" ")}` };
	};
	return { gh, issues };
}

describe("the alert machinery reads a hand move as it reads a lane move (R12)", () => {
	test("move-alert posts the @thewolff comment naming hand, slice, lane, workload, from, to and reason, then the silent popup", async () => {
		const w = world(poll([fiveHour(0.9), week(1), openaiWeek]));
		const h = lane(w);
		h.laneMessage(OPUS);
		expect((await buildSpawn(h, w)).spawn?.model).toEqual([SOL]);
		const token = tokenOf(w);
		const event = w.ledger.entries(w.wl).find(e => e.body.startsWith("hand-headroom:"))!;
		expect(quotaMove(w.ledger, event.id)).toMatchObject({ kind: "hand", subject: `hand ${token} (slice sl-work) of lane ${LANE_ID}`, from: OPUS, to: SOL, reason: EXHAUSTED });

		const g = fakeGh();
		const popups: { title: string; text: string }[] = [];
		const seams: MoveAlertSeams = {
			gh: g.gh,
			popup: (title, text) => {
				popups.push({ title, text });
				return { code: 0, stdout: `${DISMISS_BUTTON}\n`, stderr: "" };
			},
			voice: () => null,
			probe: () => false,
			kill: () => undefined,
			pid: 4242,
			log: () => undefined,
		};
		expect(runMoveAlert(w.ledger, seams, w.wl, event.id, false)).toBe(0);
		expect(g.issues.map(i => i.title)).toEqual(["as2: hand moved off anthropic"]);
		const comment = g.issues[0]!.comments.map(c => c.body);
		expect(comment).toHaveLength(1);
		expect(comment[0]).toStartWith("@thewolff ");
		for (const part of [`hand ${token}`, "slice sl-work", `lane ${LANE_ID}`, w.wl, OPUS, SOL, EXHAUSTED, commentMarker(event.id)]) expect(comment[0]).toContain(part);
		const text = `hand ${token} (slice sl-work) of lane ${LANE_ID} on ${w.wl} moved ${OPUS} -> ${SOL} (${EXHAUSTED})`;
		expect(popups).toEqual([{ title: "as2: hand moved off anthropic", text }]);
		// Both channels ok: no failure line for this move.
		expect(moveAlertTroubles(w.ledger, Date.parse(w.ledger.now()), () => false)).toEqual([]);
	});
});
