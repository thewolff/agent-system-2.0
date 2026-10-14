// Row 1 on the orchestrator's batch turn (SPEC-2.0.md § B16 items 1 and 3, amended 2026-10-13;
// PLAN wl-mv66ylg1op3wg0 D8), driven through the extension's two hooks, `assistant_message` and
// `session_stop`, over fake session entries in OMP's shapes: the surface's `surface-batch-turn`
// CustomEntry (`pi.appendEntry`) and its hidden `surface-batch-trigger` CustomMessageEntry
// (`pi.sendMessage`, details `{ nonce }`). Ilex never types a `send:` line; on a batch turn the reply
// carries at most one new QUESTION and nothing else, and names no applied id or number; a later
// turn does not inherit the batch; entries that cannot be read fail closed.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { raiseOrchestratorQuestion } from "../../surface/src/orchestrator-question";
import turnShapeRow from "../extensions/r01-turn-shape";
import type { GatesAPI } from "../src/session";
import { tmp } from "./helpers";

type AnyHandler = (event: unknown, ctx: unknown) => unknown;
type Block = { type: string; text?: string; [k: string]: unknown };
type Entry = Record<string, unknown>;

/** The fake OMP extension API of turn-shape-once.test.ts: `assistant_message` chained as runner.ts emitAssistantMessage does. */
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
			content = r.content;
			replaced = true;
		}
		return replaced ? content : undefined;
	};
	return { pi: pi as unknown as GatesAPI, emit, emitAssistantMessage };
}

const MARKER = "(Reply held by P-11 row 1. The corrected reply follows.)";
const UNREADABLE = "could not read this turn's session entries";

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const user = (text: string): Entry => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const replied = (text: string): Entry => ({ type: "message", message: assistant(text) });
const working = (): Entry => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }] } });
const batchEntry = (nonce: unknown, appliedIds: unknown = ["q-mv6applied0001", "en-mv6applied0002"], numbers: unknown = [1, 2]): Entry => ({
	type: "custom",
	customType: "surface-batch-turn",
	data: { nonce, appliedIds, numbers },
});
const trigger = (nonce: unknown): Entry => ({ type: "custom_message", customType: "surface-batch-trigger", content: "act on these answers: #1 approve, #2 stop", display: false, details: { nonce } });
const continuation = (): Entry => ({ type: "custom_message", customType: "session-stop-continuation", content: "row 1 refused", display: false });
const wake = (): Entry => ({ type: "custom_message", customType: "surface-wake", content: "a lane finished", display: true });

/**
 * An orchestrator session over `entries`, with a tmp ledger holding one open question on the
 * standing slice (`newQuestion`), so a batch reply's new QUESTION binds under row 15 as it would live.
 */
function session(entries: Entry[] | (() => unknown), role: "orchestrator" | "lane" = "orchestrator") {
	const db = join(tmp("r01-batch-ledger"), "ledger.db");
	const ledger = Ledger.open(db, { create: true, backup: false, backupOnOpen: false });
	const newQuestion = raiseOrchestratorQuestion(ledger, { body: "Ship now or wait for M5?", options: ["now", "wait"], about: null });
	ledger.close();
	const env = { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: db, ...(role === "orchestrator" ? { AGENT_SYSTEM_ROLE: "orchestrator" } : {}) };
	const f = fakePi();
	turnShapeRow(f.pi, env);
	const getEntries = typeof entries === "function" ? entries : () => entries;
	const ctx = { hasUI: true, cwd: tmp("r01-batch"), sessionManager: { getHeader: () => ({}), getEntries }, ui: { notify: () => undefined } };
	/**
	 * One final reply through both hooks, as OMP runs them: `assistant_message` before the reply is
	 * persisted, then the stored text (the marker, when held) is persisted and `session_stop` sees it.
	 * Returns whether the reply was held and the stop's block reason (null when the turn ends).
	 */
	const reply = async (text: string): Promise<{ held: boolean; stop: string | null }> => {
		const content = await f.emitAssistantMessage(assistant(text), ctx);
		const stored = content ? content.map((b) => b.text ?? "").join("") : text;
		if (Array.isArray(entries)) entries.push(replied(stored));
		const stop = (await f.emit("session_stop", { last_assistant_message: assistant(stored) }, ctx)) as { decision?: string; reason?: string } | undefined;
		return { held: content !== undefined && stored.startsWith(MARKER), stop: stop?.decision === "block" ? stop.reason! : null };
	};
	/** `session_stop` alone over a reply already persisted, with nothing held in this process (the stop hook's own check). */
	const stopOnly = async (text: string): Promise<string | null> => {
		if (Array.isArray(entries)) entries.push(replied(text));
		const stop = (await f.emit("session_stop", { last_assistant_message: assistant(text) }, ctx)) as { decision?: string; reason?: string } | undefined;
		return stop?.decision === "block" ? stop.reason! : null;
	};
	return { reply, stopOnly, newQuestion };
}

const QUIET = "**PMDW**\nAll quiet.";
const PROSE = "**PMDW**\nDone: I recorded your answers and the lanes are moving.";
const question = (id: string, extra = "") => `**QUESTION**\n(${id}) Ship now or wait for M5?${extra} Options: now / wait`;
/** Entries for an `ok` batch: an earlier turn, then the surface's entry and its hidden trigger. */
const okTurn = (nonce = "n-ok-1"): Entry[] => [user("how is it going"), replied(QUIET), batchEntry(nonce), trigger(nonce)];
/** Entries for a paste with prose blocks: the entry written at before_agent_start, then the paste's own user message. */
const pasteTurn = (nonce = "n-paste-1"): Entry[] => [user("earlier"), replied(QUIET), batchEntry(nonce), user("1 approve\nand also look at the flaky test")];

describe("row 1: the orchestrator never types a send: line", () => {
	test("a model send: line is refused on a normal turn, at both hooks", async () => {
		const s = session([user("what is open?")]);
		const r = await s.reply("**PMDW**\nTwo things wait.\nsend: 1 approve, 2 stop");
		expect(r.held).toBe(true);
		expect(r.stop).toContain("it types a `send:` line");
		expect(r.stop).toContain("Your held reply was");

		const t = session([user("what is open?")]);
		expect(await t.stopOnly("**PMDW**\nTwo things wait.\n- send: 1 approve")).toContain("it types a `send:` line");
		expect(await session([user("what is open?")]).stopOnly(QUIET)).toBeNull();
	});

	test("a lane's reply is not read for send: or batch shape", async () => {
		const s = session([batchEntry("n-lane"), trigger("n-lane")], "lane");
		expect(await s.stopOnly("**CLAIM**\nThe batch ran.\nsend: 1 approve")).toBeNull();
	});
});

describe("row 1 on a batch turn", () => {
	for (const [name, entries] of [
		["ok (entry, then trigger)", okTurn],
		["paste (entry, then the paste's user message)", pasteTurn],
		["entry after the user message", () => [user("earlier"), replied(QUIET), user("1 approve"), batchEntry("n-after")]],
	] as const) {
		test(`batch-turn prose is refused: ${name}`, async () => {
			const s = session(entries());
			const r = await s.reply(PROSE);
			expect(r.held).toBe(true);
			expect(r.stop).toContain("it carries a **PMDW** block on a batch turn");

			const t = session(entries());
			expect(await t.stopOnly("Recorded your answers.")).toContain("it carries unlabeled prose on a batch turn");
			expect(await session(entries()).stopOnly(`**CLAIM**\nApplied.\n\n${question("q-mv6zzzzzzzzzzz")}`)).toContain("it carries a **CLAIM** block on a batch turn");
		});

		test(`one new QUESTION is allowed: ${name}`, async () => {
			const s = session(entries());
			expect(await s.reply(question(s.newQuestion))).toEqual({ held: false, stop: null });
		});
	}

	test("two QUESTIONs are still refused on a batch turn", async () => {
		const s = session(okTurn());
		expect(await s.stopOnly(`${question("q-mv6aaaaaaaaaaa")}\n\n${question("q-mv6bbbbbbbbbbb")}`)).toContain("2 QUESTIONs");
	});

	test("an empty reply passes: nothing new to ask", async () => {
		expect(await session(okTurn()).stopOnly("")).toBeNull();
	});

	test("a line naming an applied id or number is refused", async () => {
		for (const [extra, named] of [
			[" (q-mv6applied0001 is settled.)", "q-mv6applied0001"],
			[" Given en-mv6applied0002,", "en-mv6applied0002"],
			[" After #2,", "#2"],
		] as const) {
			const s = session(okTurn());
			const r = await s.reply(question(s.newQuestion, extra));
			expect(r.held).toBe(true);
			expect(r.stop).toContain(`it names ${named}, which Jo just answered`);
		}
		// #12 is not #1, and en-mv6applied00021 is not en-mv6applied0002.
		const s = session(okTurn());
		expect(await s.reply(question(s.newQuestion, " Item #12 and en-mv6applied00021 aside,"))).toEqual({ held: false, stop: null });
	});

	test("the rewrite after a hold keeps the batch: the continuation is the same turn", async () => {
		const entries = okTurn();
		const s = session(entries);
		expect((await s.reply(PROSE)).held).toBe(true);
		entries.push(continuation(), working());
		// A fresh session object has nothing held: the stop hook reads the entries alone.
		const t = session(entries);
		expect(await t.stopOnly(PROSE)).toContain("on a batch turn");
		entries.pop();
		expect(await t.reply(question(t.newQuestion))).toEqual({ held: false, stop: null });
	});
});

describe("row 1: a later turn does not inherit the batch allowance", () => {
	test("after the batch turn's reply and a new user message, prose passes again (ok)", async () => {
		const entries = okTurn();
		const s = session(entries);
		expect(await s.reply("")).toEqual({ held: false, stop: null });
		entries.push(user("thanks, what next?"));
		expect(await s.reply(PROSE)).toEqual({ held: false, stop: null });
	});

	test("after the paste turn's reply and a new user message, prose passes again (paste)", async () => {
		const entries = pasteTurn();
		const s = session(entries);
		expect((await s.reply(PROSE)).held).toBe(true);
		entries.push(continuation());
		expect(await s.reply(question(s.newQuestion))).toEqual({ held: false, stop: null });
		entries.push(user("ok and the other thing?"));
		expect(await session(entries).stopOnly(PROSE)).toBeNull();
	});

	test("a user message after the trigger, with no reply between, ends the allowance", async () => {
		const entries = [...okTurn(), working(), user("actually, also check the runner")];
		expect(await session(entries).stopOnly(PROSE)).toBeNull();
	});

	test("a second user message after a paste entry ends the allowance", async () => {
		expect(await session([...pasteTurn(), user("one more thing")]).stopOnly(PROSE)).toBeNull();
	});

	test("a later pushed turn (a wake, no user message) does not inherit it", async () => {
		const entries = [...okTurn(), replied(""), wake()];
		expect(await session(entries).stopOnly(PROSE)).toBeNull();
	});
});

describe("row 1: entries that cannot be read fail closed", () => {
	const unreadable: [string, Entry[] | (() => unknown)][] = [
		["getEntries throws", () => {
			throw new Error("session file locked");
		}],
		["getEntries returns no list", () => ({ entries: [] })],
		["an entry with no type", [user("hi"), { kind: "custom" } as Entry]],
		["a message entry with no message", [{ type: "message" }]],
		["the trigger carries no nonce", [user("earlier"), replied(QUIET), batchEntry("n-1"), trigger(undefined)]],
		["no batch entry precedes the trigger", [user("earlier"), replied(QUIET), trigger("n-2")]],
		["the latest entry's nonce is not the trigger's", [user("earlier"), replied(QUIET), batchEntry("n-3"), trigger("n-4")]],
		["the batch entry's data is unreadable (ok)", [user("earlier"), replied(QUIET), batchEntry("n-5", "q-mv6applied0001"), trigger("n-5")]],
		["the batch entry's data is unreadable (paste)", [user("earlier"), replied(QUIET), batchEntry(42, ["q-x"], [1]), user("1 approve\nprose")]],
		["the batch entry's numbers are not integers", [user("earlier"), replied(QUIET), batchEntry("n-6", ["q-x"], ["2"]), trigger("n-6")]],
	];
	for (const [name, entries] of unreadable) {
		test(`${name}: held at assistant_message, blocked at session_stop, reason named`, async () => {
			const r = await session(typeof entries === "function" ? entries : [...entries]).reply(QUIET);
			expect(r.held).toBe(true);
			expect(r.stop).toContain(UNREADABLE);
			expect(await session(typeof entries === "function" ? entries : [...entries]).stopOnly(QUIET)).toContain(UNREADABLE);
		});
	}

	test("an unreadable batch entry from an earlier turn does not hold a later one", async () => {
		const entries = [user("earlier"), replied(QUIET), batchEntry(7, "bad"), user("1 approve"), replied(""), user("next")];
		expect(await session(entries).reply(PROSE)).toEqual({ held: false, stop: null });
	});
});
