// Row 1 on the orchestrator under "withhold" (MIGRATION.md item 37): a reply row 1
// refuses is replaced by one fixed marker line at `assistant_message` that quotes nothing from the
// draft, and the `session_stop` that follows blocks from the stored refusal, carrying the original,
// so the finalized history holds the marker and the corrected reply once each. One marker shows per
// prompt: later holds in the same prompt show "…" (R4). Lanes, tool-call messages and well-formed
// replies are left alone.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import turnShapeRow from "../extensions/r01-turn-shape";
import { checkTurnShape } from "../src/rows/r01-turn-shape";
import type { GatesAPI } from "../src/session";
import { tmp } from "./helpers";

type AnyHandler = (event: unknown, ctx: unknown) => unknown;
type Block = { type: string; text?: string; [k: string]: unknown };

/**
 * A fake OMP extension API (the pattern of extension.test.ts), with `assistant_message` chained as
 * runner.ts emitAssistantMessage does: each handler sees the previous replacement, and the result is
 * the final content, or undefined when no handler replaced anything.
 */
function fakePi() {
	const handlers = new Map<string, AnyHandler[]>();
	const pi = {
		on: (name: string, h: AnyHandler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		appendEntry: () => undefined,
	};
	const emit = async (name: string, event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
		let last: unknown;
		for (const h of handlers.get(name) ?? []) {
			const r = (await h(event, ctx)) as { decision?: string } | undefined;
			if (!r) continue;
			last = r;
			if (r.decision === "block") return r;
		}
		return last;
	};
	const emitAssistantMessage = async (message: { role: string; content: Block[] }, ctx: unknown): Promise<Block[] | undefined> => {
		let content = message.content;
		let replaced = false;
		for (const h of handlers.get("assistant_message") ?? []) {
			const r = (await h({ type: "assistant_message", message: structuredClone({ ...message, content }) }, ctx)) as { content?: Block[] } | undefined;
			if (r?.content === undefined) continue;
			expect(r.content.map((b) => b.type)).toEqual(content.map((b) => b.type));
			content = r.content;
			replaced = true;
		}
		return replaced ? content : undefined;
	};
	return { pi: pi as unknown as GatesAPI, emit, emitAssistantMessage };
}

const ctxOf = () => ({
	hasUI: true,
	cwd: tmp("turn-shape-once"),
	sessionManager: { getHeader: () => ({}), getEntries: () => [] },
	ui: { notify: () => undefined },
});

/** A fresh tmp ledger (the answerSession pattern of r15-orchestrator-role.test.ts), so no test reads the live ~/.agent-system-2/ledger.db. */
function tmpLedgerDb(): string {
	const db = join(tmp("turn-shape-ledger"), "ledger.db");
	Ledger.open(db, { create: true, backup: false, backupOnOpen: false }).close();
	return db;
}

const laneEnv = () => ({ HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: tmpLedgerDb() });
const orchestratorEnv = () => ({ AGENT_SYSTEM_ROLE: "orchestrator", ...laneEnv() });

const MALFORMED = "**PMDW**\nDone. Do you want the PR now, or should I wait for the proof?\nZEBRA-7Q";
const WELL_FORMED = "**PMDW**\nAll quiet.";
const assistant = (...content: Block[]) => ({ role: "assistant", content });
const text = (t: string): Block => ({ type: "text", text: t });

describe("row 1 withholds a refused orchestrator reply", () => {
	test("R1: the malformed reply becomes the marker; session_stop blocks once with the original", async () => {
		const f = fakePi();
		turnShapeRow(f.pi, orchestratorEnv());
		const ctx = ctxOf();
		const msg = assistant(text(MALFORMED), { type: "thinking", thinking: "t" }, text("second block"));
		const content = await f.emitAssistantMessage(msg, ctx);
		expect(content).toBeDefined();
		const texts = content!.filter((b) => b.type === "text" && b.text).map((b) => b.text);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toBe("(Reply held by P-11 row 1. The corrected reply follows.)");
		expect(content![1]).toEqual({ type: "thinking", thinking: "t" });
		expect(content![2]).toEqual({ type: "text", text: "" });

		// OMP hands session_stop the rewritten message, the marker, which itself passes the shape check.
		const stop = (await f.emit("session_stop", { last_assistant_message: { role: "assistant", content } }, ctx)) as { decision: string; reason: string };
		expect(stop?.decision).toBe("block");
		expect(stop.reason).toStartWith("P-11 row 1 refused this turn to Jo: ");
		expect(stop.reason).toContain(`Your held reply was:\n\n${MALFORMED}`);

		// The correction turn's reply is checked afresh; the stored refusal is gone.
		expect(await f.emitAssistantMessage(assistant(text(WELL_FORMED)), ctx)).toBeUndefined();
		expect(await f.emit("session_stop", { last_assistant_message: assistant(text(WELL_FORMED)) }, ctx)).toBeUndefined();
		expect(await f.emit("session_stop", { last_assistant_message: assistant(text(WELL_FORMED)) }, ctx)).toBeUndefined();
	});

	test("R3: a refused command is not republished: the marker quotes nothing from the draft and passes row 1", async () => {
		const f = fakePi();
		turnShapeRow(f.pi, orchestratorEnv());
		const ctx = ctxOf();
		const draft = "**PMDW**\n`zsh /tmp/ops.sh`";
		expect(checkTurnShape(draft, "orchestrator", { batch: null })).not.toBeNull();
		const content = await f.emitAssistantMessage(assistant(text(draft)), ctx);
		expect(content).toBeDefined();
		const marker = content!.map((b) => b.text ?? "").join("");
		expect(marker).not.toContain("/tmp/ops.sh");
		expect(marker).not.toContain("`");
		expect(checkTurnShape(marker, "orchestrator", { batch: null })).toBeNull();

		const stop = (await f.emit("session_stop", { last_assistant_message: { role: "assistant", content } }, ctx)) as { decision: string; reason: string };
		expect(stop?.decision).toBe("block");
		expect(stop.reason).toStartWith("P-11 row 1 refused this turn to Jo: ");
		expect(stop.reason).toContain(`Your held reply was:\n\n${draft}`);
	});

	test("R4: one marker per prompt; later holds in the same prompt show only an ellipsis and still block with their original", async () => {
		const f = fakePi();
		turnShapeRow(f.pi, orchestratorEnv());
		const ctx = ctxOf();
		const MARKER = "(Reply held by P-11 row 1. The corrected reply follows.)";
		const thinking: Block = { type: "thinking", thinking: "t", thinkingSignature: "sig" };
		const refusedThenStop = async (draft: string) => {
			expect(checkTurnShape(draft, "orchestrator", { batch: null })).not.toBeNull();
			const content = await f.emitAssistantMessage(assistant(text(draft), thinking, text("second block")), ctx);
			expect(content).toBeDefined();
			const stop = (await f.emit("session_stop", { last_assistant_message: { role: "assistant", content } }, ctx)) as { decision: string; reason: string };
			expect(stop?.decision).toBe("block");
			expect(stop.reason).toStartWith("P-11 row 1 refused this turn to Jo: ");
			expect(stop.reason).toContain(`Your held reply was:\n\n${draft}`);
			return content!;
		};
		const expectMarker = (content: Block[]) => {
			expect(content[0]).toEqual({ type: "text", text: MARKER });
			expect(content[1]).toEqual(thinking);
			expect(content[2]).toEqual({ type: "text", text: "" });
		};
		const expectEllipsis = (content: Block[]) => {
			expect(content).toEqual([{ type: "text", text: "…" }, thinking, { type: "text", text: "…" }]);
			expect(JSON.stringify(content)).not.toContain("Reply held by");
		};

		// One prompt: refused #1 shows the marker, refused retries #2 and #3 show only "…".
		await f.emit("input", { type: "input", text: "status?", source: "interactive" }, ctx);
		expectMarker(await refusedThenStop(MALFORMED));
		expectEllipsis(await refusedThenStop("**PMDW**\nRetry two. Shall I go on?\nZEBRA-8Q"));
		// A tool-call message between retries is not a reply that passes: no reset.
		expect(await f.emitAssistantMessage(assistant(text("checking"), { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }), ctx)).toBeUndefined();
		expectEllipsis(await refusedThenStop("**PMDW**\nRetry three. Shall I go on?\nZEBRA-9Q"));

		// Passing retry #4 comes back unchanged, and its stop is not blocked.
		expect(await f.emitAssistantMessage(assistant(text(WELL_FORMED)), ctx)).toBeUndefined();
		expect(await f.emit("session_stop", { last_assistant_message: assistant(text(WELL_FORMED)) }, ctx)).toBeUndefined();

		// Jo's next prompt: its first refused reply shows the marker again.
		await f.emit("input", { type: "input", text: "and the PR?", source: "interactive" }, ctx);
		expectMarker(await refusedThenStop(MALFORMED));
		expectEllipsis(await refusedThenStop(MALFORMED));

		// Jo interrupts the rewrite loop and types again (no reply passed): the new prompt shows the marker.
		await f.emit("input", { type: "input", text: "stop, try again", source: "interactive" }, ctx);
		expectMarker(await refusedThenStop(MALFORMED));
	});

	test("R4: an aside-started turn (no input) after a passing reply shows the marker again", async () => {
		const f = fakePi();
		turnShapeRow(f.pi, orchestratorEnv());
		const ctx = ctxOf();
		const first = await f.emitAssistantMessage(assistant(text(MALFORMED)), ctx);
		expect(first).toEqual([{ type: "text", text: "(Reply held by P-11 row 1. The corrected reply follows.)" }]);
		await f.emit("session_stop", { last_assistant_message: { role: "assistant", content: first } }, ctx);
		expect(await f.emitAssistantMessage(assistant(text(WELL_FORMED)), ctx)).toBeUndefined();
		// A wake aside starts a new turn without an `input` event; the pass above already reset the marker.
		const aside = await f.emitAssistantMessage(assistant(text(MALFORMED)), ctx);
		expect(aside).toEqual([{ type: "text", text: "(Reply held by P-11 row 1. The corrected reply follows.)" }]);
	});
});

describe("row 1 guards (unchanged before and after withhold)", () => {
	test("R2: an orchestrator message carrying a toolCall block is never replaced", async () => {
		const f = fakePi();
		turnShapeRow(f.pi, orchestratorEnv());
		const msg = assistant(text(MALFORMED), { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } });
		expect(await f.emitAssistantMessage(msg, ctxOf())).toBeUndefined();
	});

	test("R2: a lane reply is never replaced, and its session_stop still blocks", async () => {
		const f = fakePi();
		turnShapeRow(f.pi, laneEnv());
		const ctx = ctxOf();
		const msg = assistant(text(MALFORMED));
		expect(await f.emitAssistantMessage(msg, ctx)).toBeUndefined();
		const stop = (await f.emit("session_stop", { last_assistant_message: msg }, ctx)) as { decision: string; reason: string };
		expect(stop?.decision).toBe("block");
		expect(stop.reason).toContain("P-11 row 1");
		expect(stop.reason).not.toContain("Your held reply was");
	});

	test("R2: a well-formed orchestrator reply is returned unchanged", async () => {
		const f = fakePi();
		turnShapeRow(f.pi, orchestratorEnv());
		const ctx = ctxOf();
		expect(await f.emitAssistantMessage(assistant(text(WELL_FORMED)), ctx)).toBeUndefined();
		expect(await f.emit("session_stop", { last_assistant_message: assistant(text(WELL_FORMED)) }, ctx)).toBeUndefined();
	});
});

// No readable ledger, as the test runner sees it (it cannot read ~/.agent-system-2/ledger.db): the
// path's directory does not exist, so Ledger.open throws. U1 is the regression (MIGRATION.md item 105,
// fix round 2): a reply naming no question never opens the ledger. U2 and U3 guard item 105: an
// unreadable ledger still refuses a reply that names a question, at publication and at the stop.
describe("row 1 with no readable ledger (item 105 fix round 2)", () => {
	const noLedgerEnv = () => ({ AGENT_SYSTEM_ROLE: "orchestrator", HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: join(tmp("r01-noledger"), "missing", "ledger.db") });
	const ASKED = "**PMDW**\nSee below.\n\n**QUESTION**\n(q-mv4zzzzzzzzzzz) Today or tomorrow? Options: today / tomorrow";

	test("U1: a well-formed reply with no QUESTION opens no ledger: it is returned unchanged and its stop is not blocked", async () => {
		const f = fakePi();
		turnShapeRow(f.pi, noLedgerEnv());
		const ctx = ctxOf();
		expect(await f.emitAssistantMessage(assistant(text(WELL_FORMED)), ctx)).toBeUndefined();
		expect(await f.emit("session_stop", { last_assistant_message: assistant(text(WELL_FORMED)) }, ctx)).toBeUndefined();
	});

	test("U2: a reply naming a question is held at publication, and its stop blocks with row 15's reason and the held reply", async () => {
		expect(checkTurnShape(ASKED, "orchestrator", { batch: null })).toBeNull();
		const f = fakePi();
		turnShapeRow(f.pi, noLedgerEnv());
		const ctx = ctxOf();
		const content = await f.emitAssistantMessage(assistant(text(ASKED)), ctx);
		expect(content).toEqual([{ type: "text", text: "(Reply held by P-11 row 1. The corrected reply follows.)" }]);
		const stop = (await f.emit("session_stop", { last_assistant_message: { role: "assistant", content } }, ctx)) as { decision: string; reason: string };
		expect(stop?.decision).toBe("block");
		expect(stop.reason).toContain("could not bind this reply's QUESTION to the ledger");
		expect(stop.reason).toContain(`Your held reply was:\n\n${ASKED}`);
	});

	test("U3: with nothing held, a stop over a reply naming a question blocks: the turn does not end unchecked", async () => {
		const f = fakePi();
		turnShapeRow(f.pi, noLedgerEnv());
		const stop = (await f.emit("session_stop", { last_assistant_message: assistant(text(ASKED)) }, ctxOf())) as { decision: string; reason: string };
		expect(stop?.decision).toBe("block");
		expect(stop.reason).toContain("could not bind this reply's QUESTION to the ledger");
		expect(stop.reason).toContain("the turn does not end unchecked");
	});
});
