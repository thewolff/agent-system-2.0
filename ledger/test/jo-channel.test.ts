// The Jo channels as provenance (PLAN wl-mvfxw3c4zqfzls D1, D2's cutovers, D5's reversal reads): R6, R7, R8 and the
// reversal filters of R15.
//
// - `declareJoChannel({ kind: "surface" } | { kind: "launcher", workload })` (ledger/src/jo-channel.ts) is
//   process-wide; every later `Ledger.open` of the process puts TEMP triggers on the connection that write one
//   `provenance` mark per Jo-authority row: lane_instance 'jo-channel', tbl, row_id, action 'insert', at = the
//   row's created_at, detail = the channel kind. A launcher marks only its own workload's rows.
// - It throws where the Jo-only boundary (ledger/src/authority.ts) is in force; an agent connection there refuses a
//   'jo-channel' provenance row; a temp ledger in a lane-run test can still declare.
// - A surface `forgery-reversed: <row id> by <in-id>` voids the row for Ledger.instructions, parkLane's resolving
//   read, and surface/scripts/invariants.ts reservedView as of its time, unless a later reversal voids the reversal:
//   reversing a forged reversal restores its row.
// The preload (ledger/test/isolate-preload.ts) forgets the declaration after every test.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reservedView } from "../../surface/scripts/invariants";
import { SURFACE_BY } from "../../surface/src/types";
import { LANE_STARTER_BY, Ledger, type OpenOptions, type ProvenanceRow } from "../src/index";
import { declareJoChannel, joChannel } from "../src/jo-channel";
import { LEDGER_DB_ENV, TEST_LIVE_ROOTS_ENV } from "../src/locality";

const LANE = "lane-jochannel-1";
const AGENT = { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LANE_ID: LANE, AGENT_SYSTEM_WORKLOAD_ID: "wl-jochannel" };
const NO_AGENT = { AGENT_SYSTEM_ROLE: undefined, AGENT_SYSTEM_LANE_ID: undefined, AGENT_SYSTEM_WORKLOAD_ID: undefined };
const ENFORCE = { authority: "enforce" } as unknown as OpenOptions;
const BOUNDARY = /Jo-only boundary/;

/** One clock for every ledger here, one second a call, so a later write is never stamped earlier. */
let tick = Date.parse("2026-10-19T00:00:00.000Z");
const clock = () => new Date((tick += 1000)).toISOString();

const scratchDir = (tag: string) => realpathSync(mkdtempSync(join(tmpdir(), `jo-channel-${tag}-`)));

/** Run `fn` with `vars` set (undefined clears one) in process.env, then restore them. */
function withVars<T>(vars: Record<string, string | undefined>, fn: () => T): T {
	const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

const open = (path: string, opts: OpenOptions = {}) => Ledger.open(path, { create: true, clock, backup: false, backupOnOpen: false, ...opts });

interface World {
	path: string;
	wl: string;
	other: string;
	slice: string;
	question: string;
}

/** A ledger seeded before any declaration: two workloads, a lane holding the first, a plan question it raised. */
function seed(tag: string): World {
	const path = join(scratchDir(tag), "ledger.db");
	return withVars(NO_AGENT, () => {
		const l = open(path);
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "jo-channel fixture", stakes: "production", mode: "user-driven" });
		const other = l.openWorkload({ by: SURFACE_BY, brief: "another workload", stakes: "normal", mode: "autonomous" });
		l.claimWorkload(wl, { by: LANE, holder: LANE, leaseMs: 3_600_000 });
		const slice = l.addSlice({ by: LANE, workloadId: wl, task: "plan", doneCondition: "d", inputs: "i" });
		const question = l.raiseQuestion({ by: LANE, workloadId: wl, sliceId: slice, body: "approve the plan?", options: ["approve", "revise", "cancel"] });
		l.close();
		return { path, wl, other, slice, question };
	});
}

/** The file's Jo-channel marks, read through a fresh read-only handle. */
function marks(path: string): ProvenanceRow[] {
	const db = new Database(path, { readonly: true });
	try {
		return db.query<ProvenanceRow, []>("SELECT * FROM provenance WHERE lane_instance = 'jo-channel' ORDER BY seq").all();
	} finally {
		db.close();
	}
}

/** The created_at of row `id` of `tbl`. */
function createdAt(path: string, tbl: "instructions" | "entries", id: string): string {
	const db = new Database(path, { readonly: true });
	try {
		return db.query<{ created_at: string }, [string]>(`SELECT created_at FROM ${tbl} WHERE id = ?`).get(id)!.created_at;
	} finally {
		db.close();
	}
}

/** The one mark of row `id`, checked against the contract's shape. */
function expectMark(path: string, wl: string, tbl: "instructions" | "entries", id: string, detail: "surface" | "launcher") {
	const m = marks(path).filter((p) => p.row_id === id);
	expect(m).toHaveLength(1);
	expect(m[0]).toMatchObject({ lane_instance: "jo-channel", tbl, row_id: id, action: "insert", workload_id: wl, detail, at: createdAt(path, tbl, id) });
}

describe("R6: a surface-declared process marks its Jo-authority rows on every connection", () => {
	test("instructions authored jo and surface control entries carry a surface mark at their own created_at", () => {
		const w = seed("r6");
		withVars(NO_AGENT, () => {
			declareJoChannel({ kind: "surface" });
			expect(joChannel()).toEqual({ kind: "surface" });
			const a = open(w.path);
			const b = open(w.path);
			try {
				const steer = a.recordInstruction({ by: SURFACE_BY, workloadId: w.wl, body: "use the drafted line", author: "jo", channel: "surface" });
				const plan = a.recordEntry({ by: SURFACE_BY, workloadId: w.wl, kind: "assumption", body: "plan: approved" });
				const answer = b.answerQuestion(w.question, { by: SURFACE_BY, answer: "approve", author: "jo", channel: "surface" });
				const stop = b.recordEntry({ by: SURFACE_BY, workloadId: w.other, kind: "assumption", body: "lane-stop: lane-x-1" });
				// Not Jo-authority rows: no mark.
				const note = b.recordEntry({ by: SURFACE_BY, workloadId: w.wl, kind: "assumption", body: "reading: Jo approved the plan" });
				const laneEntry = a.recordEntry({ by: LANE, workloadId: w.wl, kind: "assumption", body: "plan: approved" });
				const laneWords = a.recordInstruction({ by: LANE, workloadId: w.wl, body: "a lane's note", author: LANE, channel: "direct" });

				expectMark(w.path, w.wl, "instructions", steer, "surface");
				expectMark(w.path, w.wl, "entries", plan, "surface");
				expectMark(w.path, w.wl, "instructions", answer, "surface");
				expectMark(w.path, w.other, "entries", stop, "surface");
				const marked = new Set(marks(w.path).map((m) => m.row_id));
				for (const id of [note, laneEntry, laneWords]) expect(marked.has(id)).toBe(false);
				expect(marks(w.path)).toHaveLength(4);
			} finally {
				a.close();
				b.close();
			}
		});
	});

	test("an undeclared process marks nothing, and the cutovers are null until a kind's first mark", () => {
		const w = seed("r6-none");
		withVars(NO_AGENT, () => {
			const l = open(w.path);
			try {
				expect(joChannel()).toBeNull();
				l.recordInstruction({ by: SURFACE_BY, workloadId: w.wl, body: "go", author: "jo", channel: "surface" });
				l.recordEntry({ by: SURFACE_BY, workloadId: w.wl, kind: "assumption", body: "plan: approved" });
				expect(marks(w.path)).toHaveLength(0);
				expect(l.joChannelCutovers()).toEqual({ surface: null, launcher: null });
			} finally {
				l.close();
			}
			declareJoChannel({ kind: "surface" });
			const d = open(w.path);
			try {
				const first = d.recordInstruction({ by: SURFACE_BY, workloadId: w.other, body: "first", author: "jo", channel: "surface" });
				d.recordInstruction({ by: SURFACE_BY, workloadId: w.wl, body: "second", author: "jo", channel: "surface" });
				expect(d.joChannelCutovers()).toEqual({ surface: createdAt(w.path, "instructions", first), launcher: null });
			} finally {
				d.close();
			}
		});
	});
});

describe("R7: a launcher-declared process marks its workload's rows, on a second connection too", () => {
	test("the lane-typed answer and its surface-stamped plan: approved companion carry the launcher mark", () => {
		const w = seed("r7");
		withVars(NO_AGENT, () => {
			declareJoChannel({ kind: "launcher", workload: w.wl });
			const launcher = open(w.path);
			const relay = open(w.path);
			try {
				const typed = launcher.answerQuestion(w.question, { by: LANE_STARTER_BY, answer: "approve", author: "jo", channel: "direct" });
				const companion = relay.recordEntry({ by: SURFACE_BY, workloadId: w.wl, sliceId: w.slice, kind: "assumption", body: "plan: approved" });
				expect(launcher.instructions(w.wl).find((i) => i.id === typed)).toMatchObject({ kind: "answer", question_id: w.question, author: "jo", channel: "direct", created_by: LANE_STARTER_BY });
				expectMark(w.path, w.wl, "instructions", typed, "launcher");
				expectMark(w.path, w.wl, "entries", companion, "launcher");
				// Another workload's rows are not the launcher's: no mark.
				const elsewhere = relay.recordInstruction({ by: SURFACE_BY, workloadId: w.other, body: "not this workload", author: "jo", channel: "surface" });
				expect(marks(w.path).some((m) => m.row_id === elsewhere)).toBe(false);
				expect(relay.joChannelCutovers()).toEqual({ surface: null, launcher: createdAt(w.path, "instructions", typed) });
			} finally {
				launcher.close();
				relay.close();
			}
		});
	});

	test("one process is one channel: a second, different declaration throws; the same one is a no-op", () => {
		withVars(NO_AGENT, () => {
			declareJoChannel({ kind: "launcher", workload: "wl-one" });
			declareJoChannel({ kind: "launcher", workload: "wl-one" });
			expect(() => declareJoChannel({ kind: "launcher", workload: "wl-two" })).toThrow(/already/);
			expect(() => declareJoChannel({ kind: "surface" })).toThrow(/already/);
			expect(joChannel()).toEqual({ kind: "launcher", workload: "wl-one" });
		});
	});
});

describe("R8: the boundary refuses a Jo channel", () => {
	test("declareJoChannel throws for an agent process whose ledger is live", () => {
		const live = join(scratchDir("r8-live"), "ledger.db");
		withVars({ ...AGENT, [LEDGER_DB_ENV]: live, [TEST_LIVE_ROOTS_ENV]: dirname(live) }, () => {
			expect(() => declareJoChannel({ kind: "surface" })).toThrow(BOUNDARY);
			expect(() => declareJoChannel({ kind: "launcher", workload: "wl-jochannel" })).toThrow(BOUNDARY);
			expect(joChannel()).toBeNull();
		});
	});

	test("a declared process is refused an agent connection under the boundary", () => {
		const w = seed("r8-open");
		withVars(NO_AGENT, () => declareJoChannel({ kind: "surface" }));
		withVars(AGENT, () => expect(() => open(w.path, ENFORCE)).toThrow(/declared Jo channel/));
	});

	test("an agent connection under the boundary cannot write a jo-channel provenance row", () => {
		const w = seed("r8-forge");
		const forge = (l: Ledger) =>
			l.db.query("INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action, detail) VALUES (?, ?, 'jo-channel', 'instructions', 'in-forged', 'insert', 'surface')").run(clock(), w.wl);
		withVars(AGENT, () => {
			const l = open(w.path, ENFORCE);
			try {
				expect(() => forge(l)).toThrow(BOUNDARY);
			} finally {
				l.close();
			}
		});
		expect(marks(w.path)).toHaveLength(0);
		// Control: the same insert goes in without the boundary, so the refusal is the trigger's.
		withVars(NO_AGENT, () => {
			const l = open(w.path);
			try {
				forge(l);
			} finally {
				l.close();
			}
		});
		expect(marks(w.path)).toHaveLength(1);
	});

	test("a temp ledger in a lane-run test can still declare, and its writes are marked", () => {
		const w = seed("r8-temp");
		withVars(AGENT, () => {
			declareJoChannel({ kind: "surface" });
			const l = open(w.path);
			try {
				const id = l.recordInstruction({ by: SURFACE_BY, workloadId: w.wl, body: "go", author: "jo", channel: "surface" });
				expectMark(w.path, w.wl, "instructions", id, "surface");
			} finally {
				l.close();
			}
		});
	});
});

describe("R15: a reversed row is void for every decision reader", () => {
	const reverse = (l: Ledger, wl: string, id: string, by = SURFACE_BY) =>
		l.recordEntry({ by, workloadId: wl, kind: "assumption", body: `forgery-reversed: ${id} by in-reverse1` });

	test("Ledger.instructions leaves a reversed row out unless withReversed; only the surface reverses", () => {
		const w = seed("r15-instructions");
		withVars(NO_AGENT, () => {
			const l = open(w.path);
			try {
				const forged = l.recordInstruction({ by: SURFACE_BY, workloadId: w.wl, body: "stakes: throwaway", author: "jo", channel: "surface" });
				const kept = l.recordInstruction({ by: SURFACE_BY, workloadId: w.wl, body: "go on", author: "jo", channel: "surface" });
				reverse(l, w.wl, kept, LANE); // a lane's line of the same shape reverses nothing
				reverse(l, w.other, forged); // another workload's reversal is not this one's
				expect(l.instructions(w.wl).map((i) => i.id)).toEqual([forged, kept]);
				reverse(l, w.wl, forged);
				expect(l.instructions(w.wl).map((i) => i.id)).toEqual([kept]);
				expect(l.instructions(w.wl, { withReversed: true }).map((i) => i.id)).toEqual([forged, kept]);
			} finally {
				l.close();
			}
		});
	});

	test("parkLane reads a reversed answer as no pending resume", () => {
		const w = seed("r15-park");
		withVars(NO_AGENT, () => {
			const l = open(w.path);
			try {
				const answer = l.answerQuestion(w.question, { by: SURFACE_BY, answer: "approve", author: "jo", channel: "surface" });
				expect(l.parkLane(w.wl, { by: LANE, laneId: LANE, session: "/s/1.jsonl" })).toEqual({ parked: true, open: 0 });
				reverse(l, w.wl, answer);
				expect(l.parkLane(w.wl, { by: LANE, laneId: LANE, session: "/s/1.jsonl" })).toEqual({ parked: false });
			} finally {
				l.close();
			}
		});
	});

	test("invariants reservedView drops a reversed row only as of the reversal's time", () => {
		const w = seed("r15-asof");
		const ids = withVars(NO_AGENT, () => {
			const l = open(w.path);
			try {
				const row = l.recordInstruction({ by: SURFACE_BY, workloadId: w.wl, body: "ceiling: 50", author: "jo", channel: "surface" });
				const before = clock();
				const reversal = reverse(l, w.wl, row);
				return { row, before, at: l.entries(w.wl).find((e) => e.id === reversal)!.created_at };
			} finally {
				l.close();
			}
		});
		const db = new Database(w.path, { readonly: true });
		try {
			const has = (asOf?: string) => reservedView(db, asOf).instructions(w.wl).some((i) => i.id === ids.row);
			expect(has(ids.before)).toBe(true);
			expect(has(ids.at)).toBe(false);
			expect(has()).toBe(false);
		} finally {
			db.close();
		}
	});

	test("a reversed reversal voids nothing: reversing a forged reversal restores the instruction for every reader", () => {
		const w = seed("r15-rereverse");
		const ids = withVars(NO_AGENT, () => {
			const l = open(w.path);
			try {
				const row = l.recordInstruction({ by: SURFACE_BY, workloadId: w.wl, body: "ceiling: 50", author: "jo", channel: "surface" });
				const answer = l.answerQuestion(w.question, { by: SURFACE_BY, answer: "approve", author: "jo", channel: "surface" });
				// a forger's surface-stamped reversals hide Jo's instruction and his answer
				const forgedRow = reverse(l, w.wl, row);
				const forgedAnswer = reverse(l, w.wl, answer);
				expect(l.instructions(w.wl).map((i) => i.id)).not.toContain(row);
				expect(l.parkLane(w.wl, { by: LANE, laneId: LANE, session: "/s/1.jsonl" })).toEqual({ parked: false });
				const between = clock();
				// Jo reverses both forged reversals: the rows are back
				reverse(l, w.wl, forgedRow);
				reverse(l, w.wl, forgedAnswer);
				expect(l.instructions(w.wl).map((i) => i.id)).toEqual([row, answer]);
				expect(l.parkLane(w.wl, { by: LANE, laneId: LANE, session: "/s/1.jsonl" })).toEqual({ parked: true, open: 0 });
				return { row, between };
			} finally {
				l.close();
			}
		});
		const db = new Database(w.path, { readonly: true });
		try {
			const has = (asOf?: string) => reservedView(db, asOf).instructions(w.wl).some((i) => i.id === ids.row);
			// as of before Jo's reversal of the reversal, the row was still hidden; after it, and now, it is back
			expect(has(ids.between)).toBe(false);
			expect(has()).toBe(true);
		} finally {
			db.close();
		}
	});
});
