// The designated conversation and the first-turn size (PLAN wl-mv8wzipdczs2rk D1 writer, D2, D4), on the
// fake host of wake-push.test.ts: the test plays OMP's part, firing the wake's one-shot and the poll,
// admitting pushes, and emitting the assistant `message_end` (a snapshot carrying `usage`) that is a
// wake's size sample, `session_switch` (OMP's in-process new / fork / resume) and `session_shutdown`.
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { AS2_LAUNCH_ENV, controlEntries, reservedPrefix } from "../src/launch";
import { surfaceSession } from "../src/session";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, notified, type Sent, timeouts, timers, tmp } from "./helpers";

const TAIL = "— warning only, nothing compacted";
type Turn = { systemPrompt: string[]; messages: Sent["message"][] };

function env(over: Record<string, string> = {}): Record<string, string> {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const contract = join(tmp("contract"), "output-types.md");
	writeFileSync(contract, "CONTRACT DOC BODY");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, AGENT_SYSTEM_CONTRACT: contract, HOME: "/nonexistent-home", ...over };
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close();
	return e;
}

interface Opts {
	resumed?: boolean;
	env?: Record<string, string>;
	/** The model's context window (ExtensionContext.model.contextWindow); omitted → no model. */
	window?: number;
	/** What ctx.getContextUsage() returns. */
	usage?: { tokens: number; contextWindow: number; percent: number };
	/** The allocated session file and id (ReadonlySessionManager.getSessionFile / getSessionId). */
	file?: string;
	id?: string;
}

/** An orchestrator surface on the fake host, its session manager carrying a settable allocated file and id; `compact` is a spy. */
function surface(o: Opts = {}) {
	timers.length = 0;
	timeouts.length = 0;
	const f = fakePi(undefined, { exec: true });
	const e = env(o.env);
	orchestratorSurface(f.pi, e, {});
	const session = { file: o.file ?? join(tmp("sessions"), "never-written.jsonl"), id: o.id ?? "sess-1" };
	const sessionManager = {
		getHeader: () => ({}),
		getEntries: () => (o.resumed ? [{ type: "message" }] : []),
		getSessionId: () => session.id,
		getSessionFile: () => session.file,
		/** OMP writes the file lazily (session-manager.ts isSessionOnDisk): never true here, the file is never created. */
		isSessionOnDisk: () => existsSync(session.file),
	};
	const compactCalls: unknown[] = [];
	const ctx = {
		...ctxOf({ idle: true }),
		sessionManager,
		model: o.window === undefined ? undefined : { contextWindow: o.window },
		getContextUsage: () => o.usage,
		compact: async (arg?: unknown) => {
			compactCalls.push(arg);
		},
	};
	const ledger = () => Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { backup: false, backupOnOpen: false });
	const bodies = (prefix: string): string[] => {
		const l = ledger();
		try {
			return l.workload(STANDING_WORKLOAD_ID) ? l.entries(STANDING_WORKLOAD_ID, "assumption").filter((x) => x.created_by === SURFACE_BY && x.body.startsWith(prefix)).map((x) => x.body) : [];
		} finally {
			l.close();
		}
	};
	return {
		f,
		e,
		ctx,
		session,
		compactCalls,
		ledger,
		of: (customType: string): Sent[] => f.sent.filter((x) => x.message.customType === customType),
		start: () => f.emit("session_start", { type: "session_start" }, ctx),
		compact: () => f.emit("session_compact", { type: "session_compact" }, ctx),
		switchTo: (file: string, id: string, reason: "new" | "resume" | "fork" = "new") => {
			const previousSessionFile = session.file;
			session.file = file;
			session.id = id;
			return f.emit("session_switch", { type: "session_switch", reason, previousSessionFile }, ctx);
		},
		shutdown: () => f.emit("session_shutdown", { type: "session_shutdown" }, ctx),
		tick: () => timers[0]!.fn(),
		fire: () => {
			for (const t of timeouts.splice(0)) t.fn();
		},
		jo: async (prompt = "hi") => (await f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx)) as Turn,
		read: () => f.tool("orchestrator_wake_read").execute("1", { body: "nothing open" }, undefined, undefined, ctx),
		admit: (m: Sent) => f.admit(m, ctx),
		/** The assistant `message_end` OMP emits after a provider call, with that call's usage buckets. */
		assistant: (u: { input?: number; cacheRead?: number; cacheWrite?: number } = {}) =>
			f.emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 0, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 12, ...u }, timestamp: 0 } }, ctx),
		sizes: () => bodies("wake-size:"),
		pointers: () => bodies("orchestrator-session:"),
		s: () => surfaceSession(ctx, e),
	};
}

/** A pushed or rendered wake's id: its `wake:<id>` push key. */
const idOf = (m: { details?: unknown }): string => {
	const d = m.details;
	if (!d || typeof d !== "object" || !("surfaceKey" in d) || typeof d.surfaceKey !== "string") throw new Error("the message carries no surfaceKey");
	return d.surfaceKey.replace(/^wake:/, "");
};

describe("D4: one wake-size entry per wake", () => {
	test("session-start taken by the aside push: the first assistant message after the take is the sample, with the window share; later turns add nothing", async () => {
		const t = surface({ window: 200_000 });
		await t.start();
		t.fire();
		const pushed = t.of("surface-wake");
		expect(pushed).toHaveLength(1);
		await t.admit(pushed[0]!);
		await t.assistant({ input: 1200, cacheRead: 48_000, cacheWrite: 800 });
		const id = idOf(pushed[0]!.message);
		expect(t.sizes()).toEqual([`wake-size: session-start ${id} session sess-1 first turn 50000 prompt tokens (input 1200, cache read 48000, cache write 800), 25% of 200000 ${TAIL}`]);
		await t.read();
		await t.jo("next");
		await t.assistant({ input: 30, cacheRead: 51_000 });
		await t.assistant({ input: 5, cacheRead: 52_000 });
		expect(t.sizes()).toHaveLength(1);
	});

	test("restart taken by Jo's turn: the sample is his turn's first assistant message; without a model window the share is left out", async () => {
		const t = surface({ resumed: true });
		await t.start();
		const turn = await t.jo();
		expect(turn.messages[0]!.content).toContain("(wake: restart)");
		await t.assistant({ input: 70, cacheRead: 0, cacheWrite: 90_000 });
		expect(t.sizes()).toEqual([`wake-size: restart ${idOf(turn.messages[0]!)} session sess-1 first turn 90070 prompt tokens (input 70, cache read 0, cache write 90000) ${TAIL}`]);
		await t.jo("again");
		await t.assistant({ input: 1, cacheRead: 90_100 });
		expect(t.sizes()).toHaveLength(1);
	});

	test("the share falls back to getContextUsage's window when the model gives none", async () => {
		const t = surface({ usage: { tokens: 1000, contextWindow: 100_000, percent: 1 } });
		await t.start();
		await t.jo();
		await t.assistant({ input: 10_000 });
		expect(t.sizes()[0]).toContain(`first turn 10000 prompt tokens (input 10000, cache read 0, cache write 0), 10% of 100000 ${TAIL}`);
	});

	test("compaction: a measured session-start wake, then the compaction's pushed wake gets its own entry", async () => {
		const t = surface({ window: 250_000 });
		await t.start();
		await t.jo();
		await t.assistant({ input: 100, cacheRead: 20_000 });
		await t.read();
		await t.compact();
		t.fire();
		const pushed = t.of("surface-wake");
		expect(pushed).toHaveLength(1);
		expect(pushed[0]!.message.content).toContain("(wake: compaction)");
		await t.admit(pushed[0]!);
		await t.assistant({ input: 300, cacheWrite: 30_000 });
		const sizes = t.sizes();
		expect(sizes).toHaveLength(2);
		expect(sizes[0]).toStartWith("wake-size: session-start ");
		expect(sizes[1]).toBe(`wake-size: compaction ${idOf(pushed[0]!.message)} session sess-1 first turn 30300 prompt tokens (input 300, cache read 0, cache write 30000), 12% of 250000 ${TAIL}`);
	});

	test("an assistant message before the wake was taken is not its sample", async () => {
		const t = surface();
		await t.start();
		await t.assistant({ input: 999 });
		expect(t.sizes()).toEqual([]);
		await t.jo();
		await t.assistant({ input: 4000 });
		expect(t.sizes()).toHaveLength(1);
		expect(t.sizes()[0]).toContain("first turn 4000 prompt tokens");
	});

	test("a zero-usage message_end (a failed provider attempt) is skipped and the next positive one is recorded; zero is never written", async () => {
		const t = surface();
		await t.start();
		await t.jo();
		await t.assistant({});
		await t.assistant({ input: 0, cacheRead: 0, cacheWrite: 0 });
		expect(t.sizes()).toEqual([]);
		await t.assistant({ input: 12, cacheRead: 3000 });
		expect(t.sizes()).toHaveLength(1);
		expect(t.sizes()[0]).toContain("first turn 3012 prompt tokens (input 12, cache read 3000, cache write 0)");
		expect(t.sizes().join("\n")).not.toContain("first turn 0 ");
	});

	test("a wake superseded before a positive sample gets its unmeasured entry, and the new wake its measured one", async () => {
		const t = surface();
		await t.start();
		t.fire();
		const first = t.of("surface-wake")[0]!;
		await t.assistant({});
		await t.compact();
		const sizes = t.sizes();
		expect(sizes).toEqual([`wake-size: session-start ${idOf(first.message)} session sess-1 unmeasured (superseded by compaction before a successful turn) ${TAIL}`]);
		const turn = await t.jo();
		expect(turn.messages[0]!.content).toContain("(wake: compaction)");
		await t.assistant({ input: 50, cacheRead: 6000 });
		expect(t.sizes()).toEqual([sizes[0]!, `wake-size: compaction ${idOf(turn.messages[0]!)} session sess-1 first turn 6050 prompt tokens (input 50, cache read 6000, cache write 0) ${TAIL}`]);
	});

	test("a wake superseded while still pending (never taken) is recorded unmeasured too", async () => {
		const t = surface();
		await t.start();
		await t.compact();
		const sizes = t.sizes();
		expect(sizes).toHaveLength(1);
		expect(sizes[0]).toMatch(new RegExp(`^wake-size: session-start \\S+ session sess-1 unmeasured \\(superseded by compaction before a successful turn\\) ${TAIL}$`));
	});

	test("session_shutdown with the wake unmeasured records it as ended; a measured wake adds nothing at shutdown", async () => {
		const t = surface({ resumed: true });
		await t.start();
		const turn = await t.jo();
		await t.assistant({});
		await t.shutdown();
		expect(t.sizes()).toEqual([`wake-size: restart ${idOf(turn.messages[0]!)} session sess-1 unmeasured (session ended before a successful turn) ${TAIL}`]);

		const u = surface();
		await u.start();
		await u.jo();
		await u.assistant({ input: 10 });
		await u.shutdown();
		expect(u.sizes()).toHaveLength(1);
		expect(u.sizes()[0]).toContain("first turn 10 prompt tokens");
	});

	test("a ledger write failure is a warning notification, never a thrown handler", async () => {
		const t = surface();
		await t.start();
		await t.jo();
		t.s().ledger().close();
		notified.length = 0;
		await expect(t.assistant({ input: 10 })).resolves.toBeUndefined();
		expect(notified.some((n) => n.type === "warning" && n.message.includes("could not record `wake-size: session-start"))).toBe(true);
		expect(t.s().unmeasured).toBeNull();
	});
});

describe("control prefixes: wake-size and orchestrator-session are the surface's alone", () => {
	test("a lane's wake-size: or orchestrator-session: entry is not a valid control entry; the surface's is", () => {
		const t = surface();
		const l = t.ledger();
		l.openWorkload({ by: SURFACE_BY, id: STANDING_WORKLOAD_ID, brief: "standing", stakes: "throwaway", mode: "autonomous" });
		for (const by of ["lane-forger-1", SURFACE_BY]) {
			l.recordEntry({ by, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: "wake-size: restart w1 session s1 first turn 10 prompt tokens (input 10, cache read 0, cache write 0) — warning only, nothing compacted" });
			l.recordEntry({ by, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: "orchestrator-session: /x/y.jsonl s1" });
		}
		const valid = controlEntries(l.entries(STANDING_WORKLOAD_ID, "assumption"));
		l.close();
		expect(valid.map((c) => [c.prefix, c.createdBy])).toEqual([
			["wake-size", SURFACE_BY],
			["orchestrator-session", SURFACE_BY],
		]);
		expect(reservedPrefix("wake-size: forged")).toBe("wake-size");
		expect(reservedPrefix("orchestrator-session: forged")).toBe("orchestrator-session");
	});
});

describe("D1 writer: the orchestrator-session pointer", () => {
	const launched = { [AS2_LAUNCH_ENV]: "1" };

	test("with the env set, session_start records getSessionFile() and the id while the file is not on disk yet", async () => {
		const t = surface({ env: launched, id: "sess-a" });
		expect(t.ctx.sessionManager.isSessionOnDisk()).toBe(false);
		await t.start();
		expect(t.pointers()).toEqual([`orchestrator-session: ${t.session.file} sess-a`]);
		expect(t.ctx.sessionManager.isSessionOnDisk()).toBe(false);
	});

	test("without the env no pointer is written, on session_start or session_switch", async () => {
		const t = surface({ id: "sess-a" });
		await t.start();
		await t.switchTo(join(tmp("sessions"), "other.jsonl"), "sess-b");
		expect(t.pointers()).toEqual([]);
	});

	test("a lane session with the env writes none (only the active orchestrator does)", async () => {
		const t = surface({ env: { ...launched, AGENT_SYSTEM_ROLE: "lane" } });
		await t.start();
		await t.switchTo(join(tmp("sessions"), "other.jsonl"), "sess-b");
		expect(t.pointers()).toEqual([]);
	});

	test("not again for the same file (a resumed launch of it), again on a session_switch to another file", async () => {
		const t = surface({ env: launched, id: "sess-a" });
		await t.start();
		const again = surface({ env: { ...launched, AGENT_SYSTEM_LEDGER_DB: t.e.AGENT_SYSTEM_LEDGER_DB! }, file: t.session.file, id: "sess-a", resumed: true });
		await again.start();
		expect(again.pointers()).toEqual([`orchestrator-session: ${t.session.file} sess-a`]);
		const other = join(tmp("sessions"), "new.jsonl");
		await again.switchTo(other, "sess-b", "new");
		expect(again.pointers()).toEqual([`orchestrator-session: ${t.session.file} sess-a`, `orchestrator-session: ${other} sess-b`]);
		await again.switchTo(other, "sess-b", "resume");
		expect(again.pointers()).toHaveLength(2);
		await again.switchTo(t.session.file, "sess-a", "resume");
		expect(again.pointers()).toEqual([`orchestrator-session: ${t.session.file} sess-a`, `orchestrator-session: ${other} sess-b`, `orchestrator-session: ${t.session.file} sess-a`]);
	});
});

describe("D2: nothing compacts at wake", () => {
	test("a resumed session with large context usage takes its restart wake with zero compact() calls and exactly one wake push", async () => {
		const t = surface({ resumed: true, window: 250_000, usage: { tokens: 240_000, contextWindow: 250_000, percent: 96 } });
		await t.start();
		t.fire();
		const pushed = t.of("surface-wake");
		expect(pushed).toHaveLength(1);
		expect(pushed[0]!.message.content).toContain("(wake: restart)");
		await t.admit(pushed[0]!);
		t.tick();
		t.tick();
		await t.assistant({ input: 2000, cacheRead: 224_254 });
		t.tick();
		expect(t.of("surface-wake")).toHaveLength(1);
		expect(t.compactCalls).toHaveLength(0);
		expect(t.sizes()[0]).toContain("first turn 226254 prompt tokens (input 2000, cache read 224254, cache write 0), 91% of 250000");
	});
});
