// The OMP adapter (gates/index.ts, registering every gates/extensions/ row) driven by a fake
// extension API: role detection, row 2 injection in hands, row 3 flagging a hand's yield without
// blocking it, row 1 at session_stop, row 11 on input (including a failed write), row 7's wake cycle
// with its recovery tool and its stop check, and `ask` removed for an autonomous lane.
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFindings } from "../../classifier/src/rounds";
import receiptsRow from "../extensions/r03-receipts";
import { errorLines } from "../../surface/src/errors";
import { artifactTreeBody } from "../../surface/src/signals";
import { STANDING_SLICE_TASK, STANDING_WORKLOAD_ID } from "../../surface/src/types";
import pushRebaseRow from "../extensions/r08-push-rebase";
import reservedRow from "../extensions/r06-reserved";
import p11Gates, { type GatesAPI } from "../index";
import { DISPLAY_LINKS } from "../extensions/open-links";
import { CONTRACT_MARKER } from "../src/rows/r02-contract";
import { prepareLinkSession, sessionLinkOptions, setLinkRouter } from "../src/links";
import { brief, commit, git, repoWithOrigin, tempLedger, testRecord, tmp } from "./helpers";

type AnyHandler = (event: unknown, ctx: unknown) => unknown;
interface FakeTool {
	name: string;
	execute(id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: { text: string }[] }>;
}

/** A describe-able schema stub standing in for pi.zod; the tests call execute with plain params. */
const schema = (): unknown => ({ describe: () => schema(), optional: () => schema() });

/**
 * A fake OMP extension API whose emit follows the runner's chaining (runner.ts emitToolCall,
 * emitBeforeAgentStart, emit for session_stop, input): tool_call stops at the first block and
 * otherwise returns the last result; before_agent_start threads the system prompt and collects
 * messages; context threads replacement messages; session_stop stops at the first block; input stops at the first `handled`.
 */
function fakePi(tools = ["read", "bash", "ask", "task", "yield"]) {
	const handlers = new Map<string, AnyHandler[]>();
	const entries: { type: string; data: unknown }[] = [];
	const registered = new Map<string, FakeTool>();
	let active = [...tools];
	const pi = {
		on: (name: string, h: AnyHandler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		getActiveTools: () => [...active],
		getAllTools: () => tools.map((name) => ({ name })),
		setActiveTools: async (names: string[]) => {
			active = names;
		},
		appendEntry: (type: string, data?: unknown) => entries.push({ type, data }),
		registerTool: (t: FakeTool) => registered.set(t.name, t),
		zod: { object: schema, string: schema },
	};
	const emit = async (name: string, event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
		const hs = handlers.get(name) ?? [];
		if (name === "before_agent_start") {
			let systemPrompt = event.systemPrompt as string[];
			const messages: unknown[] = [];
			for (const h of hs) {
				const r = (await h({ ...event, systemPrompt }, ctx)) as { systemPrompt?: string[]; message?: unknown } | undefined;
				if (r?.message) messages.push(r.message);
				if (r?.systemPrompt) systemPrompt = r.systemPrompt;
			}
			return { systemPrompt, messages };
		}
		let last: unknown;
		for (const h of hs) {
			const r = (await h(event, ctx)) as { block?: boolean; decision?: string; handled?: boolean; messages?: unknown[] } | undefined;
			if (!r) continue;
			if (name === "context") {
				if (!r.messages) continue;
				event = { ...event, messages: r.messages };
			}
			if (name === "assistant_message" && "content" in r) {
				event = { ...event, message: { ...(event.message as object), content: r.content } };
			}
			last = r;
			if (r.block || r.decision === "block" || r.handled) return r;
		}
		return last;
	};
	const tool = (name: string): FakeTool => {
		const t = registered.get(name);
		if (!t) throw new Error(`tool ${name} not registered`);
		return t;
	};
	return { pi: pi as unknown as GatesAPI, emit, entries, active: () => active, tool };
}

const notices: string[] = [];
/** A session context; its sessionManager is the key the rows share state on, one per session. */
const ctxOf = (o: { hasUI: boolean; parent?: string; cwd?: string; resumed?: boolean }) => ({
	hasUI: o.hasUI,
	cwd: o.cwd ?? tmp("ext-cwd"),
	sessionManager: { getHeader: () => ({ parentSession: o.parent }), getEntries: () => (o.resumed ? [{ type: "message" }] : []) },
	ui: { notify: (m: string) => notices.push(m) },
});

describe("gates extension adapter", () => {
	test("a hand: contract injected, `ask` removed, yield flagged not blocked, no turn-shape gate", async () => {
		const contract = join(tmp("contract"), "c.md");
		writeFileSync(contract, "OWNED CONTRACT");
		const f = fakePi();
		p11Gates(f.pi, { AGENT_SYSTEM_CONTRACT: contract, HOME: "/nonexistent-home" });
		const ctx = ctxOf({ hasUI: false, parent: "/sessions/lane.jsonl" });
		await f.emit("session_start", { type: "session_start" }, ctx);
		const started = (await f.emit("before_agent_start", { prompt: "go", systemPrompt: ["base"] }, ctx)) as { systemPrompt: string[] };
		expect(started.systemPrompt.join("\n")).toContain(CONTRACT_MARKER);
		expect(started.systemPrompt.join("\n")).toContain("OWNED CONTRACT");
		expect(f.active()).not.toContain("ask");
		expect(((await f.emit("tool_call", { toolName: "ask", input: {} }, ctx)) as { block: boolean }).block).toBe(true);

		const report = "**ACTION**\n`bun test` → exit 0\nAll tests pass.";
		const res = (await f.emit("tool_call", { toolName: "yield", input: { data: { report, files: [] } } }, ctx)) as { block?: boolean; input: { data: { report: string } } };
		expect(res.block).toBeUndefined();
		expect(res.input.data.report).toContain("P-11 row 3 receipt check (informational");
		expect(res.input.data.report).toContain("no such run recorded");
		expect(await f.emit("session_stop", { last_assistant_message: { content: "**QUESTION**\na?\n**QUESTION**\nb?" } }, ctx)).toBeUndefined();
	});

	test("an orchestrator: `ask` kept, turn shape refused at session_stop, receipts flagged into the session", async () => {
		const f = fakePi();
		p11Gates(f.pi, { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_CONTRACT: "/nonexistent", HOME: "/nonexistent-home" });
		const ctx = ctxOf({ hasUI: true });
		await f.emit("session_start", { type: "session_start" }, ctx);
		await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx);
		expect(f.active()).toContain("ask");
		const stop = (await f.emit("session_stop", { last_assistant_message: { content: [{ type: "text", text: "**QUESTION**\na?\n\n**QUESTION**\nb?\n**CITE**\nhttps://nowhere.example" }] } }, ctx)) as { decision: string; reason: string };
		expect(stop.decision).toBe("block");
		expect(stop.reason).toContain("P-11 row 1");
		expect(f.entries.find((e) => e.type === "p11-receipts")).toBeTruthy();
		expect(await f.emit("session_stop", { last_assistant_message: { content: "**PMDW**\nAll quiet." } }, ctx)).toBeUndefined();
	});

	/** A lane bound to a fresh autonomous workload with history, started through the adapter. */
	async function boundLane() {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "orch", brief: "b", stakes: "normal", mode: "autonomous" });
		ledger.addSlice({ by: "orch", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const f = fakePi();
		p11Gates(f.pi, { AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-1", AGENT_SYSTEM_CONTRACT: "/nonexistent", HOME: "/nonexistent-home" });
		const ctx = ctxOf({ hasUI: true });
		await f.emit("session_start", { type: "session_start" }, ctx);
		return { ledger, path, wl, f, ctx };
	}
	const read = { toolName: "read", input: { path: "x" } };

	test("a lane bound to an autonomous workload: instruction recorded, `ask` removed, wake cycle discharged by the recovery tool", async () => {
		const { ledger, wl, f, ctx } = await boundLane();
		expect(await f.emit("input", { text: "prefer the v3 schema", source: "interactive" }, ctx)).toBeUndefined();
		expect(ledger.instructions(wl).map((r) => [r.author, r.channel, r.body])).toEqual([["jo", "direct", "prefer the v3 schema"]]);

		const start = (await f.emit("before_agent_start", { prompt: "go", systemPrompt: [] }, ctx)) as { messages: { content: string }[] };
		expect(f.active()).not.toContain("ask");
		// The workload has history (open + slice), so this fresh lane owes a wake read.
		expect(start.messages.map((m) => m.content).join("\n")).toContain("ledger_wake_read");
		expect(await f.emit("tool_call", read, ctx)).toBeUndefined();
		await f.emit("agent_end", { willContinue: false }, ctx);
		await Bun.sleep(5); // the entry must postdate the trigger's timestamp

		// Second turn: refused until this lane's entry exists, except the recovery tool itself.
		expect(((await f.emit("tool_call", read, ctx)) as { reason: string }).reason).toContain("P-11 row 7");
		expect(await f.emit("tool_call", { toolName: "ledger_wake_read", input: { body: "resuming slice t" } }, ctx)).toBeUndefined();
		const out = await f.tool("ledger_wake_read").execute("c1", { body: "resuming slice t from the ledger" }, undefined, undefined, ctx);
		expect(out.content[0]!.text).toContain("as lane-1");
		expect(ledger.entries(wl, "wake-read")).toMatchObject([{ created_by: "lane-1", body: "resuming slice t from the ledger" }]);
		expect(await f.emit("tool_call", read, ctx)).toBeUndefined();
		expect(await f.emit("session_stop", { last_assistant_message: { content: "**PMDW**\nResumed." } }, ctx)).toBeUndefined();

		const dispatch = { toolName: "task", input: { tasks: [{ agent: "builder", task: brief() }] } };
		expect(((await f.emit("tool_call", dispatch, ctx)) as { block: boolean }).block).toBe(true);
	});

	test("row 7 ledger questions never resolve legacy local handles in the waking lane", async () => {
		const { ledger, wl, f, ctx } = await boundLane();
		const root = tmp("wake-local");
		const plan = join(root, "PLAN.md");
		writeFileSync(plan, "unrelated waking lane plan");
		Object.assign(ctx, { localProtocolOptions: { getArtifactsDir: () => root } });
		const sl = ledger.slices(wl)[0]!.id;
		ledger.raiseQuestion({ by: "old-lane", workloadId: wl, sliceId: sl, body: `Read local://PLAN.md or ${plan}`, options: ["yes", "no"] });
		let locates = 0;
		setLinkRouter({
			async locate() { locates++; return plan; },
			locateSync() { locates++; return plan; },
		});
		try {
			const start = await f.emit("before_agent_start", { prompt: "go", systemPrompt: [] }, ctx) as { messages: { customType: string; content: string }[] };
			const text = start.messages.find((m) => m.customType === "p11-wake")!.content;
			expect(text).toContain("Read local://PLAN.md");
			expect(text).not.toContain("[local://");
			expect(text).toContain(`[${plan}](${pathToFileURL(plan).href})`);
			expect(locates).toBe(0);
		} finally {
			setLinkRouter(undefined);
			ledger.close();
		}
	});

	test("row 7: a second turn with no tool calls is refused at its stop (astra review B3)", async () => {
		const { f, ctx } = await boundLane();
		await f.emit("before_agent_start", { prompt: "go", systemPrompt: [] }, ctx);
		await f.emit("agent_end", { willContinue: false }, ctx);
		await f.emit("before_agent_start", { prompt: "again", systemPrompt: [] }, ctx);
		const stop = (await f.emit("session_stop", { last_assistant_message: { content: "**PMDW**\nDone, no tools." } }, ctx)) as { decision: string; reason: string };
		expect(stop.decision).toBe("block");
		expect(stop.reason).toContain("P-11 row 7");
	});

	test("row 7: an empty or blank slice on the recovery tool is recorded as no slice; a foreign slice is still refused", async () => {
		/** A bound lane in its second turn, so row 7 genuinely owes the entry (the first turn passes by design). */
		async function owing() {
			const lane = await boundLane();
			await lane.f.emit("before_agent_start", { prompt: "go", systemPrompt: [] }, lane.ctx);
			await lane.f.emit("agent_end", { willContinue: false }, lane.ctx);
			await Bun.sleep(5); // the entry must postdate the trigger's timestamp
			expect(((await lane.f.emit("tool_call", read, lane.ctx)) as { reason: string }).reason).toContain("P-11 row 7");
			return lane;
		}

		for (const slice of ["", "   "]) {
			const { ledger, wl, f, ctx } = await owing();
			await f.tool("ledger_wake_read").execute("c1", { body: "resuming from the ledger", slice }, undefined, undefined, ctx);
			expect(ledger.entries(wl, "wake-read")).toMatchObject([{ created_by: "lane-1", slice_id: null }]);
			expect(await f.emit("tool_call", read, ctx)).toBeUndefined();
		}

		const own = await owing();
		own.ledger.addSlice({ by: "orch", workloadId: own.wl, task: "t2", doneCondition: "d", inputs: "i", id: "sl-own" });
		await own.f.tool("ledger_wake_read").execute("c1", { body: "resuming sl-own", slice: " sl-own " }, undefined, undefined, own.ctx);
		expect(own.ledger.entries(own.wl, "wake-read")).toMatchObject([{ slice_id: "sl-own" }]);

		const { ledger, wl, f, ctx } = await owing();
		const other = ledger.openWorkload({ by: "orch", brief: "other", stakes: "normal", mode: "autonomous" });
		ledger.addSlice({ by: "orch", workloadId: other, task: "t", doneCondition: "d", inputs: "i", id: "sl-foreign" });
		await expect(f.tool("ledger_wake_read").execute("c1", { body: "resuming sl-foreign", slice: "sl-foreign" }, undefined, undefined, ctx)).rejects.toThrow(
			"the slice belongs to another workload",
		);
		expect(ledger.entries(wl, "wake-read")).toEqual([]);
		expect(((await f.emit("tool_call", read, ctx)) as { reason: string }).reason).toContain("P-11 row 7");
	});

	test("row 11: a failed instruction write consumes the input so no turn runs, and says so (astra review B6)", async () => {
		// The ledger refuses the insert: the lane is bound to a workload id the ledger has no open row for.
		const { ledger, path } = tempLedger();
		const f = fakePi();
		p11Gates(f.pi, { AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: "wl-missing1", AGENT_SYSTEM_LANE_ID: "lane-1", AGENT_SYSTEM_CONTRACT: "/nonexistent", HOME: "/nonexistent-home" });
		const ctx = ctxOf({ hasUI: true });
		await f.emit("session_start", { type: "session_start" }, ctx);
		notices.length = 0;
		expect(await f.emit("input", { text: "use v3", source: "interactive" }, ctx)).toEqual({ handled: true });
		expect(notices.join("\n")).toContain("NOT recorded");
		expect(notices.join("\n")).toContain("no turn was started");
		// Slash commands are not instructions, but the held one is retried first and still fails.
		expect(await f.emit("input", { text: "/compact", source: "interactive" }, ctx)).toEqual({ handled: true });
		expect(ledger.instructions("wl-missing1")).toHaveLength(0);
	});

	test("one row file loads on its own and enforces only its row (astra review S4)", async () => {
		const f = fakePi();
		reservedRow(f.pi, { HOME: "/nonexistent-home" });
		const ctx = ctxOf({ hasUI: true });
		expect(((await f.emit("tool_call", { toolName: "bash", input: { command: "rm '-rf' /not-real/review-not-executed" } }, ctx)) as { reason: string }).reason).toContain("§ A4");
		expect(await f.emit("tool_call", { toolName: "ask", input: {} }, ctx)).toBeUndefined(); // row 14 not loaded
		expect(() => f.tool("ledger_wake_read")).toThrow("not registered"); // row 7 not loaded
	});

	/** A refusal's reason, or "" when the call was let through. */
	const reasonOf = (r: unknown): string => (r && typeof r === "object" && "reason" in r ? String(r.reason) : "");

	/** Rows 6 and 8 alone, in a session bound to an open workload with one open slice. */
	function boundRows(cwd?: string) {
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "orch", brief: "b", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: "orch", workloadId: wl, task: "ship the feature branch", doneCondition: "d", inputs: "i" });
		const f = fakePi();
		const env = { AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-1", HOME: "/nonexistent-home" };
		reservedRow(f.pi, env);
		pushRebaseRow(f.pi, env);
		return { ledger, path, wl, sl, f, ctx: ctxOf({ hasUI: true, cwd }) };
	}

	test("row 6 writes a reserved-request per reserved refusal that the surface renders as § B3 line 1; respellings write none; an unbound session writes it on the orchestrator's standing workload", async () => {
		const { ledger, path, wl, sl, f, ctx } = boundRows();
		const force = { toolName: "bash", toolCallId: "call-force", input: { command: "git push --force origin main" } };
		expect(reasonOf(await f.emit("tool_call", force, ctx))).toContain("§ A4 reserved list");
		const entries = ledger.entries(wl, "reserved-request");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ slice_id: sl, created_by: "lane-1" });
		expect(entries[0]!.body).toContain("git push --force origin main");
		expect(entries[0]!.body).toContain("call-force");
		const lines = errorLines(ledger).filter((l) => l.kind === "reserved");
		expect(lines).toHaveLength(1);
		expect(lines[0]!.rowId).toBe(entries[0]!.id);
		expect(lines[0]!.line).toContain("git push --force origin main");
		expect(lines[0]!.line).toContain(`approve ${entries[0]!.id}`);

		// A form the gate does not model is refused for respelling, not raised to Jo.
		const unread = { toolName: "bash", toolCallId: "call-unread", input: { command: "git -c alias.p=push p" } };
		expect(reasonOf(await f.emit("tool_call", unread, ctx))).toContain("P-11 row 6");
		expect(ledger.entries(wl, "reserved-request")).toHaveLength(1);

		// No workload (the orchestrator itself): the refusal lands on the standing workload, where the surface reads it, and is kept as a session entry too.
		const u = fakePi();
		const uEnv = { AGENT_SYSTEM_LEDGER_DB: path, HOME: "/nonexistent-home" };
		reservedRow(u.pi, uEnv);
		await u.emit("tool_call", force, ctxOf({ hasUI: true }));
		expect(u.entries).toEqual([{ type: "p11-reserved-request", data: { body: expect.stringContaining("git push --force origin main"), workloadId: STANDING_WORKLOAD_ID } }]);
		const standing = ledger.entries(STANDING_WORKLOAD_ID, "reserved-request");
		expect(standing).toHaveLength(1);
		expect(standing[0]!.slice_id).toBeNull();
		const orchestratorLines = errorLines(ledger).filter((l) => l.kind === "reserved" && l.workloadId === STANDING_WORKLOAD_ID);
		expect(orchestratorLines).toHaveLength(1);
		expect(orchestratorLines[0]!.line).toContain(`approve ${standing[0]!.id}`);
	});

	test("row 6 refuses an eval that starts a process outright: no reserved-request entry and no needs-you line (PLAN wl-muzs0ytnaet1v4 D1)", async () => {
		const { ledger, wl, f, ctx } = boundRows();
		// en-muzrj6i64vnj7k's code, verbatim; the nested bash force push; an optional chain to Bun.spawn and to the bash tool.
		const hold = 'import time, subprocess; time.sleep(100)\nprint(subprocess.run(["git","status","--short"],cwd="/Users/jowolff/code/agent-system-2.0-lanes/wl-muq1v31q5ly7ls",capture_output=True,text=True).stdout)';
		const calls = [
			{ toolName: "eval", toolCallId: "call-hold", input: { language: "py", code: hold } },
			{ toolName: "eval", toolCallId: "call-nested", input: { language: "js", code: 'await tool.bash({command: "git push --force origin main"})' } },
			{ toolName: "eval", toolCallId: "call-optional", input: { language: "js", code: 'Bun?.spawn(["kubectl","delete","deployment","app"])' } },
			{ toolName: "eval", toolCallId: "call-bracket", input: { language: "js", code: 'await tool?.["bash"]({command: "git push --force origin main"})' } },
		];
		for (const call of calls) expect(reasonOf(await f.emit("tool_call", call, ctx))).toContain("bash tool");
		expect(ledger.entries(wl, "reserved-request")).toEqual([]);
		expect(errorLines(ledger).filter((l) => l.kind === "reserved")).toEqual([]);
	});

	test("row 8 sends artifact-failed messages on a second refusal in a row on the slice, which the surface renders as § B3 line 3; the let-through push's successful result ends the run with artifact-passed", async () => {
		const { work } = repoWithOrigin();
		git(work, "switch", "-q", "-c", "feat");
		commit(work, "f.txt", "f\n");
		const { ledger, wl, sl, f, ctx } = boundRows(work);
		const push = (id: string) => ({ toolName: "bash", toolCallId: id, input: { command: "git push -u origin feat" } });
		const failures = () => ledger.db.query<{ sender: string; recipient: string; body: string }, [string]>("SELECT sender, recipient, body FROM messages WHERE slice_id = ? ORDER BY rowid").all(sl);

		expect(reasonOf(await f.emit("tool_call", push("p1"), ctx))).toContain("P-11 row 8");
		expect(failures()).toEqual([]);
		expect(errorLines(ledger).filter((l) => l.kind === "artifact")).toEqual([]);

		expect(reasonOf(await f.emit("tool_call", push("p2"), ctx))).toContain("P-11 row 8");
		expect(failures().map((m) => [m.sender, m.recipient, m.body.slice(0, 54)])).toEqual([
			["lane-1", "orchestrator", "artifact-failed: P-11 row 8 refused push 1 in a row on"],
			["lane-1", "orchestrator", "artifact-failed: P-11 row 8 refused push 2 in a row on"],
		]);
		const lines = errorLines(ledger).filter((l) => l.kind === "artifact");
		expect(lines.map((l) => [l.workloadId, l.rowId])).toEqual([[wl, sl]]);
		expect(lines[0]!.line).toContain("failed its runtime artifact 2 times: ship the feature branch");

		// The test record the refusal asks for, written as the lane writes it: the push passes.
		const { repo, tree, command } = testRecord(work);
		ledger.recordEntry({ by: "lane-1", workloadId: wl, sliceId: sl, kind: "assumption", body: artifactTreeBody({ repo, tree, command }) });
		expect(await f.emit("tool_call", push("p3"), ctx)).toBeUndefined();
		// Let through is not passed: a rejected push result leaves the line up (Codex S3).
		await f.emit("tool_result", { ...push("p3"), details: { exitCode: 1 }, isError: true }, ctx);
		expect(failures()).toHaveLength(2);
		expect(errorLines(ledger).filter((l) => l.kind === "artifact")).toHaveLength(1);
		// The push succeeding ends the run: one artifact-passed row, and the line clears.
		await f.emit("tool_result", { ...push("p3"), isError: false }, ctx);
		expect(failures().map((m) => m.body.slice(0, 40))).toEqual([
			"artifact-failed: P-11 row 8 refused push",
			"artifact-failed: P-11 row 8 refused push",
			"artifact-passed: push let through by P-1",
		]);
		expect(errorLines(ledger).filter((l) => l.kind === "artifact")).toEqual([]);
		// A new commit makes the next push a first refusal again: nothing more is sent.
		commit(work, "g.txt", "g\n");
		expect(reasonOf(await f.emit("tool_call", push("p4"), ctx))).toContain("P-11 row 8");
		expect(failures()).toHaveLength(3);
	});
});

// T2/T3 intentionally import only pre-existing entry points: the unpacked baseline reaches
// behavioral assertions rather than failing to import the new links module.
describe("T2 settled links through the gates entry", () => {
	const root = mkdtempSync(join(process.env.AS2_SCRATCH ?? tmpdir(), "openlinks-entry-"));
	mkdirSync(join(root, "My Docs"));
	const path = join(root, "My Docs/x.ts");
	writeFileSync(path, "one\ntwo\nthree");
	const url = pathToFileURL(path).href;
	const linked = `[${path.replace(/[\\`*_\[\]<>~&$]/g, "\\$&")}](${url})`;
	const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_CONTRACT: "/nonexistent", HOME: "/nonexistent-home" };
	const message = (text: string, tool = false) => ({ role: "assistant", content: [{ type: "text", text }, ...(tool ? [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] : [])] });
	test("context is a no-op without link asides and composes filtering with a later extension", async () => {
		const f = fakePi();
		p11Gates(f.pi, env);
		const ctx = ctxOf({ hasUI: true, cwd: root });
		const kept = { role: "custom", customType: "other-extension", content: "keep" };
		expect(await f.emit("context", { type: "context", messages: [kept] }, ctx)).toBeUndefined();
		const appended = { role: "user", content: "later extension" };
		let seen: unknown;
		f.pi.on("context", (event) => {
			seen = event.messages;
			return { messages: [...event.messages, appended] };
		});
		const aside = { role: "custom", customType: DISPLAY_LINKS, content: "display only" };
		const messages = [aside, kept];
		expect(await f.emit("context", { type: "context", messages }, ctx)).toEqual({ messages: [kept, appended] });
		expect(seen).toEqual([kept]);
		expect(messages).toEqual([aside, kept]);
	});
	test("rewrites ordinary text and tool-call messages, while row 1 still holds handed-over commands", async () => {
		const f = fakePi();
		p11Gates(f.pi, env);
		const ctx = ctxOf({ hasUI: true, cwd: root });
		const original = message(`**PMDW**\nOpen ${path}.`);
		const normal = (await f.emit("assistant_message", { message: original }, ctx) ?? original) as { content: { text: string }[] };
		expect(normal.content[0]!.text).toContain(linked);
		expect(await f.emit("session_stop", { last_assistant_message: { content: normal.content } }, ctx)).toBeUndefined();
		const tool = (await f.emit("assistant_message", { message: message(path, true) }, ctx) ?? message(path, true)) as { content: { type: string; text?: string }[] };
		expect(tool.content[0]!.text).toBe(linked);
		expect(tool.content[1]!.type).toBe("toolCall");
		const held = await f.emit("assistant_message", { message: message("**ACTION**\nbash ~/x.sh") }, ctx) as { content: { text: string }[] };
		expect(held.content[0]!.text).toContain("Reply held");
		expect((await f.emit("session_stop", { last_assistant_message: { content: held.content } }, ctx) as { reason: string }).reason).toContain("P-11 row 1");
	});
	test("row 15 binds the QUESTION row despite a linked path in its body", async () => {
		const { ledger, path: db } = tempLedger();
		ledger.openWorkload({ id: STANDING_WORKLOAD_ID, by: "orch", brief: "standing", stakes: "normal", mode: "autonomous" });
		const slice = ledger.addSlice({ by: "orch", workloadId: STANDING_WORKLOAD_ID, task: STANDING_SLICE_TASK, doneCondition: "d", inputs: "i", id: "sl-orchestrator-standing" });
		const q = ledger.raiseQuestion({ by: "orch", workloadId: STANDING_WORKLOAD_ID, sliceId: slice, body: `Open ${path}?`, options: ["yes", "no"] });
		const f = fakePi();
		p11Gates(f.pi, { ...env, AGENT_SYSTEM_LEDGER_DB: db });
		const ctx = ctxOf({ hasUI: true, cwd: root });
		const original = message(`**QUESTION**\n(${q}) Open ${path}? Options: yes / no`);
		const result = (await f.emit("assistant_message", { message: original }, ctx) ?? original) as { content: { text: string }[] };
		expect(result.content[0]!.text).toContain(linked);
		expect(result.content[0]!.text).not.toContain("Reply held");
		expect(ledger.entries(STANDING_WORKLOAD_ID, "assumption").some(e => e.body.includes(`question-published: ${q}`))).toBe(true);
	});
	test("a hand's fenced review-findings still parses", async () => {
		const f = fakePi();
		p11Gates(f.pi, env);
		const block = '```review-findings\n{"findings":[]}\n```';
		const text = `${path}\n${block}`;
		const r = (await f.emit("assistant_message", { message: message(text) }, ctxOf({ hasUI: false, parent: "/sessions/lane.jsonl", cwd: root })) ?? message(text)) as { content: { text: string }[] };
		expect(r.content[0]!.text).toContain(linked);
		expect(r.content[0]!.text).toContain(block);
		expect(parseFindings(r.content[0]!.text)).toEqual(parseFindings(block));
	});
});

describe("T3 receipt checks through existing receipts adapter", () => {
	const root = mkdtempSync(join(process.env.AS2_SCRATCH ?? tmpdir(), "linked-receipts-"));
	mkdirSync(join(root, "My Docs"));
	const path = join(root, "My Docs/x.ts");
	writeFileSync(path, "one\ntwo\nthree");
	async function reportFlags(report: string, reads: string[], hand: boolean): Promise<string> {
		const f=fakePi();
		receiptsRow(f.pi, { AGENT_SYSTEM_ROLE: "orchestrator" });
		const ctx=ctxOf({hasUI:!hand,...(hand ? {parent:"/lane.jsonl"} : {}),cwd:root});
		for (const path of reads) await f.emit("tool_result",{toolName:"read",input:{path},details:{resolvedPath:path},isError:false},ctx);
		if (hand) {
			const result=await f.emit("tool_call",{toolName:"yield",input:{data:{report}}},ctx) as {input?:{data:{report:string}}}|undefined;
			return result?.input?.data.report.slice(report.length) ?? "";
		}
		await f.emit("session_stop",{last_assistant_message:{content:report}},ctx);
		return f.entries.map(e=>JSON.stringify(e.data)).join("\n");
	}
	for (const hand of [false,true]) {
		test(`prose slash and clock are not receipts in ${hand ? "hand yield" : "session stop"}`, async () => {
			expect(await reportFlags(`**CLAIM**\nthe timer and/or the retry fires at 10:30, see ${path}:3`,[path],hand)).toBe("");
		});
		for (const linked of [false,true]) {
			test(`each ${linked ? "linked" : "bare"} receipt owns its quote in ${hand ? "hand yield" : "session stop"}`, async () => {
				const a=join(root,"a.ts"), b=join(root,"b.ts");
				writeFileSync(a,Array.from({length:40},(_,i)=>i === 2 || i === 29 ? "first file evidence" : "first filler").join("\n"));
				writeFileSync(b,"one\ntwo\nsecond file evidence\n");
				const receipt=(p:string,line:number)=>linked ? `[${p}:${line}](${pathToFileURL(p).href})` : `${p}:${line}`;
				for (const firstLine of [3,30]) {
					const report=`**CLAIM**\n${receipt(a,firstLine)} — \`first file evidence\`; ${receipt(b,3)} — \`second file evidence\``;
					expect(await reportFlags(report,[a,b],hand)).toBe("");
					const wrong=report.replace("`second file evidence`","`wrong second evidence`");
					const flags=await reportFlags(wrong,[a,b],hand);
					expect(flags).toContain(`does not match ${b} near line 3`);
					expect(flags).not.toContain(`does not match ${a}`);
				}
				// A quote after another receipt must not be borrowed by a preceding unquoted receipt.
				expect(await reportFlags(`**CLAIM**\n${receipt(a,3)}; ${receipt(b,3)} — "second file evidence"`,[a,b],hand)).toBe("");
			});
		}
	}
	for (const linked of [false, true]) for (const hand of [false, true]) {
		test(`${linked ? "linked" : "bare"} CLAIM in ${hand ? "hand yield" : "session stop"}`, async () => {
			const f = fakePi();
			receiptsRow(f.pi, { AGENT_SYSTEM_ROLE: "orchestrator" });
			const ctx = ctxOf({ hasUI: !hand, ...(hand ? { parent: "/lane.jsonl" } : {}), cwd: root });
			const report = (line: number) => `**CLAIM**\n${linked ? `[${path}:${line}](${pathToFileURL(path).href})` : `${path}:${line}`}`;
			const flags = async (line: number): Promise<string> => {
				if (hand) {
					const r = await f.emit("tool_call", { toolName: "yield", input: { data: { report: report(line) } } }, ctx) as { input?: { data: { report: string } } } | undefined;
					return r?.input?.data.report ?? "";
				}
				f.entries.length = 0;
				await f.emit("session_stop", { last_assistant_message: { content: report(line) } }, ctx);
				return JSON.stringify(f.entries);
			};
			expect(await flags(3)).toContain("not read this session");
			await f.emit("tool_result", { toolName: "read", input: { path }, details: { resolvedPath: path }, isError: false }, ctx);
			expect(await flags(3)).not.toContain("not read this session");
			expect(await flags(9)).toContain("past the file's 3 lines");
		});
	}
});

describe("T7 bounded repository discovery", () => {
	test("gh and fallback git receive real execution timeouts within one shared budget", async () => {
		const ctx=ctxOf({hasUI:true});
		const calls:{command:string;timeout:number;signal:AbortSignal}[]=[];
		let now=1000;
		const clock=spyOn(Date,"now").mockImplementation(()=>now);
		try {
			const pi={exec:async(command:string,_args:string[],options:{cwd:string;timeout:number;signal:AbortSignal})=>{
				calls.push({command,timeout:options.timeout,signal:options.signal});
				if(command === "gh") { now+=1750; return {code:1,stdout:""}; }
				return {code:0,stdout:"git@ghe.co:owner/repo.git\n"};
			}};
			await Promise.all([prepareLinkSession(pi,ctx),prepareLinkSession(pi,ctx)]);
			expect(calls.map(c=>[c.command,c.timeout])).toEqual([["gh",1000],["git",250]]);
			expect(calls[0]!.signal).toBe(calls[1]!.signal);
			expect(sessionLinkOptions(ctx).repo).toEqual({host:"ghe.co",slug:"owner/repo"});
		} finally { clock.mockRestore(); }
	});
	for(const stalled of ["gh","git"]) test(`an uncooperative ${stalled} cannot hold the session beyond its total deadline`, async () => {
		const ctx=ctxOf({hasUI:true});
		const timers:{callback:()=>void;delay:number}[]=[];
		const calls:{command:string;timeout:number;signal:AbortSignal}[]=[];
		const late=Promise.withResolvers<{code:number;stdout:string}>();
		const timer=spyOn(globalThis,"setTimeout").mockImplementation(((callback:()=>void,delay:number)=>{
			timers.push({callback,delay}); return 1;
		}) as unknown as typeof setTimeout);
		const clear=spyOn(globalThis,"clearTimeout").mockImplementation(()=>{});
		try {
			const pi={exec:(command:string,_args:string[],options:{cwd:string;timeout:number;signal:AbortSignal})=>{
				calls.push({command,timeout:options.timeout,signal:options.signal});
				return command === stalled ? late.promise : Promise.resolve({code:1,stdout:""});
			}};
			const pending=prepareLinkSession(pi,ctx);
			await Promise.resolve(); // failed gh has reached its git fallback before the deadline fires
			expect(calls.map(c=>[c.command,c.timeout])).toEqual(stalled === "gh" ? [["gh",1000]] : [["gh",1000],["git",1000]]);
			expect(timers.map(t=>t.delay)).toEqual([2000]);
			timers[0]!.callback();
			await pending;
			await prepareLinkSession(pi,ctx);
			expect(calls).toHaveLength(stalled === "gh" ? 1 : 2);
			expect(calls.every(c=>c.signal.aborted)).toBe(true);
			late.resolve({code:0,stdout:stalled === "gh" ? JSON.stringify({nameWithOwner:"late/repo",url:"https://github.com/late/repo"}) : "git@github.com:late/repo.git"});
			await Promise.resolve();
			expect(sessionLinkOptions(ctx).repo).toBeNull();
			expect(calls).toHaveLength(stalled === "gh" ? 1 : 2);
		} finally { timer.mockRestore(); clear.mockRestore(); }
	});
});
