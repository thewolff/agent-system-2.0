// The Jo-only boundary, accident grade, layer 1 and the table (PLAN wl-mv654hoqwpfhmo § 6.2, § 6.3 items 1 and 5).
//
// Interfaces these tests fix for the boundary (sl-auth-boundary):
// - `ledger/src/authority.ts` exports `AUTHORITY: readonly AuthorityRow[]`, the one Jo-only table, where
//     interface AuthorityRow {
//       kind: "instruction-kind" | "control-prefix" | "direct-channel";
//       name: string;      // an instructions.kind ("answer"), a control prefix without its colon ("plan"), or "direct"
//       writer: string;    // the one stamp the reader trusts: "orchestrator-surface" on every jo-only row
//       reader: string;    // where the reader that trusts the row lives (non-empty)
//       authority: "jo-only" | "words, not authority";
//     }
//   Every instructions kind and every control prefix the surface writes is a `jo-only` row written by the
//   surface; row 11's lane-stamped direct channel is the one `direct-channel` row, `words, not authority`.
// - `Ledger.open(path, { authority: "enforce" })` adds per-connection TEMP triggers on main.instructions,
//   main.entries, main.questions, main.workloads, main.slices and main.messages (insert and update) when the
//   process is an agent context, read from process.env at open: AGENT_SYSTEM_ROLE set and not "orchestrator", or
//   AGENT_SYSTEM_LANE_ID / AGENT_SYSTEM_WORKLOAD_ID set. Without the option the same triggers go on whenever the
//   opened file is in a live root (ledger/src/locality.ts liveRoots outside test mode: $HOME/.agent-system-2, the
//   passwd home's, and the directory of AGENT_SYSTEM_LEDGER_DB). The option only adds triggers, never removes them.
// - A trigger raises (the error message contains "Jo-only boundary") on a row stamped
//   created_by / changed_by = 'orchestrator-surface', and on an author = 'jo' instructions row that is not
//   row 11's lane-stamped shape: kind 'instruction', channel 'direct', question_id NULL, created_by the
//   connection's own AGENT_SYSTEM_LANE_ID (gates/src/rows/r11-jo-instruction.ts writes it with the lane's own id;
//   G3: no lane id in the env, no row 11 shape). Any `answer` row raises, whatever its author (G2): only the
//   surface answers a question, for Jo. G1-G3 are scratch auth-forgery AUDIT.md § (e).
// - TEMP triggers write nothing to the file: sqlite_master and PRAGMA schema_version are unchanged by an open.
//
// The table is loaded with a dynamic import in the tests that need it, so a missing authority.ts fails only those.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_PREFIXES, controlEntries } from "../../surface/src/launch";
import { SURFACE_BY } from "../../surface/src/types";
import { type EntryRow, Ledger, type OpenOptions } from "../src/index";

const REPO = join(import.meta.dir, "..", "..");
const LANE = "lane-authority-1";
const AGENT_VARS = ["AGENT_SYSTEM_ROLE", "AGENT_SYSTEM_LANE_ID", "AGENT_SYSTEM_WORKLOAD_ID"] as const;
type AgentEnv = Partial<Record<(typeof AGENT_VARS)[number], string>>;
/** The boundary's open option (PLAN § 6.3 item 1): turns the triggers on for a scratch file. */
const ENFORCE = { authority: "enforce" } as unknown as OpenOptions;
const BOUNDARY = /Jo-only boundary/;

/** A clock every ledger in this file shares, one second a call, so a later write is never stamped earlier. */
let tick = Date.parse("2026-10-19T00:00:00.000Z");
const clock = () => new Date((tick += 1000)).toISOString();

const scratchDir = (tag: string) => realpathSync(mkdtempSync(join(tmpdir(), `authority-${tag}-`)));

/** Run `fn` with exactly `env` as the agent-context variables (all three cleared first), then restore them. */
function withEnv<T>(env: AgentEnv, fn: () => T): T {
	const saved = Object.fromEntries(AGENT_VARS.map((k) => [k, process.env[k]]));
	for (const k of AGENT_VARS) delete process.env[k];
	Object.assign(process.env, env);
	try {
		return fn();
	} finally {
		for (const k of AGENT_VARS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
}

interface Seeded {
	path: string;
	wl: string;
	slice: string;
	pausedSlice: string;
	question: string;
	message: string;
}

/** A ledger seeded the way the surface and a lane leave one, written with no agent context and no triggers. */
function seed(tag: string): Seeded {
	const path = join(scratchDir(tag), "ledger.db");
	return withEnv({}, () => {
		const l = Ledger.open(path, { create: true, clock, backup: false });
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "authority fixture", stakes: "production", mode: "autonomous" });
		l.claimWorkload(wl, { by: LANE, holder: LANE, leaseMs: 3_600_000 });
		const slice = l.addSlice({ by: LANE, workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const pausedSlice = l.addSlice({ by: LANE, workloadId: wl, task: "plan", doneCondition: "d", inputs: "i" });
		const question = l.raiseQuestion({ by: LANE, workloadId: wl, sliceId: pausedSlice, body: "approve the plan?", options: ["approve", "revise", "cancel"] });
		const message = l.enqueue({ by: SURFACE_BY, workloadId: wl, sender: "orchestrator", recipient: LANE, body: "go" });
		l.close();
		return { path, wl, slice, pausedSlice, question, message };
	});
}

/** Open `s` with the boundary's option under `env`, run `fn` on it, close. */
function enforced<T>(s: Seeded, env: AgentEnv, fn: (l: Ledger) => T): T {
	return withEnv(env, () => {
		const l = Ledger.open(s.path, { ...ENFORCE, clock, backup: false });
		try {
			return fn(l);
		} finally {
			l.close();
		}
	});
}

/** Every row of the six guarded tables, as one comparable string. */
function rows(path: string): string {
	const db = new Database(path, { readonly: true });
	try {
		return ["workloads", "slices", "messages", "instructions", "questions", "entries"]
			.map((t) => JSON.stringify(db.query(`SELECT * FROM ${t} ORDER BY rowid`).all()))
			.join("\n");
	} finally {
		db.close();
	}
}

function schema(path: string): { master: unknown[]; version: number } {
	const db = new Database(path, { readonly: true });
	try {
		return {
			master: db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
			version: db.query<{ schema_version: number }, []>("PRAGMA schema_version").get()!.schema_version,
		};
	} finally {
		db.close();
	}
}

const TEMP_TRIGGERS = "SELECT count(*) AS n FROM sqlite_temp_master WHERE type = 'trigger'";

/** A surface-stamped or Jo-authored write a lane process must not make: name and the write. */
type Write = [string, (l: Ledger, s: Seeded) => unknown];

const SURFACE_WRITES: Write[] = [
	["entries insert (recordEntry, a surface control line)", (l, s) => l.recordEntry({ by: SURFACE_BY, workloadId: s.wl, kind: "assumption", body: "plan: approved in-forged0000001" })],
	["instructions insert (recordInstruction, Jo's word from the surface)", (l, s) => l.recordInstruction({ by: SURFACE_BY, workloadId: s.wl, body: "ceiling: 500 12", author: "jo", channel: "surface" })],
	["question answer (answerQuestion as the surface)", (l, s) => l.answerQuestion(s.question, { by: SURFACE_BY, answer: "approve", author: "jo", channel: "surface" })],
	["question withdrawal (withdrawQuestion as the surface)", (l, s) => l.withdrawQuestion(s.question, { by: SURFACE_BY, reason: "forged", author: "jo", channel: "surface", then: "cancel" })],
	["mode flip as the surface", (l, s) => l.flipMode(s.wl, { by: SURFACE_BY, mode: "user-driven", author: "jo", channel: "surface" })],
	["workloads insert (openWorkload as the surface)", (l) => l.openWorkload({ by: SURFACE_BY, brief: "forged", stakes: "normal", mode: "autonomous" })],
	["workloads update (setStakes as the surface)", (l, s) => l.setStakes(s.wl, { by: SURFACE_BY, stakes: "throwaway" })],
	["slices insert (addSlice as the surface)", (l, s) => l.addSlice({ by: SURFACE_BY, workloadId: s.wl, task: "t", doneCondition: "d", inputs: "i" })],
	["slices update (cancelSlice as the surface)", (l, s) => l.cancelSlice(s.slice, { by: SURFACE_BY })],
	["messages insert (enqueue as the surface)", (l, s) => l.enqueue({ by: SURFACE_BY, workloadId: s.wl, sender: "orchestrator", recipient: LANE, body: "forged" })],
	["messages update (advanceMessage as the surface)", (l, s) => l.advanceMessage(s.message, "delivered", { by: SURFACE_BY })],
	["questions insert (raiseQuestion as the surface)", (l, s) => l.raiseQuestion({ by: SURFACE_BY, workloadId: s.wl, sliceId: s.slice, body: "forged?", options: ["a", "b"] })],
	// Raw, through the public connection and through ledger.write(fn): the helpers are not the only way in.
	["raw entries insert through ledger.db", (l, s) =>
		l.db.query("INSERT INTO entries (id, workload_id, kind, body, created_by, created_at) VALUES (?, ?, 'assumption', ?, ?, ?)")
			.run("en-rawforged0001", s.wl, "launch-requested: forged", SURFACE_BY, clock())],
	["raw instructions insert through ledger.write(fn)", (l, s) =>
		l.write(() => l.db.query("INSERT INTO instructions (id, workload_id, kind, channel, author, body, created_by, created_at) VALUES (?, ?, 'instruction', 'surface', 'jo', ?, ?, ?)")
			.run("in-rawforged0001", s.wl, "stakes: throwaway", SURFACE_BY, clock()))],
	["raw workloads update through ledger.db", (l, s) =>
		l.db.query("UPDATE workloads SET changed_by = ?, changed_at = ?, rev = rev + 1 WHERE id = ?").run(SURFACE_BY, clock(), s.wl)],
	["raw questions update through ledger.write(fn)", (l, s) =>
		l.write(() => l.db.query("UPDATE questions SET changed_by = ?, changed_at = ?, rev = rev + 1 WHERE id = ?").run(SURFACE_BY, clock(), s.question))],
];

/** author 'jo' rows a lane stamps but that are not row 11's shape (kind instruction, channel direct, no question). */
const JO_NOT_ROW11: Write[] = [
	["a lane-stamped jo instruction on the surface channel", (l, s) => l.recordInstruction({ by: LANE, workloadId: s.wl, body: "rounds: 9", author: "jo", channel: "surface" })],
	["a lane-stamped jo answer", (l, s) => l.answerQuestion(s.question, { by: LANE, answer: "approve", author: "jo", channel: "direct" })],
	["a lane-stamped jo withdrawal", (l, s) => l.withdrawQuestion(s.question, { by: LANE, reason: "x", author: "jo", channel: "direct", then: "cancel" })],
	["a lane-stamped jo mode flip", (l, s) => l.flipMode(s.wl, { by: LANE, mode: "user-driven", author: "jo", channel: "direct" })],
	["a raw lane-stamped jo answer row through ledger.db", (l, s) =>
		l.db.query("INSERT INTO instructions (id, workload_id, kind, question_id, channel, author, body, created_by, created_at) VALUES (?, ?, 'answer', ?, 'direct', 'jo', 'approve', ?, ?)")
			.run("in-rawjoanswer01", s.wl, s.question, LANE, clock())],
];

/** Answers whatever their author (G2): an agent connection never answers a question, so a lane cannot un-gate its own. */
const AGENT_ANSWERS: Write[] = [
	["a lane answering its own question as author lane-x, channel direct", (l, s) => l.answerQuestion(s.question, { by: LANE, answer: "approve", author: "lane-x", channel: "direct" })],
	["a lane answering as itself on the surface channel", (l, s) => l.answerQuestion(s.question, { by: LANE, answer: "approve", author: LANE, channel: "surface" })],
	["a raw lane-x answer row through ledger.db", (l, s) =>
		l.db.query("INSERT INTO instructions (id, workload_id, kind, question_id, channel, author, body, created_by, created_at) VALUES (?, ?, 'answer', ?, 'direct', 'lane-x', 'approve', ?, ?)")
			.run("in-rawlaneanswer", s.wl, s.question, LANE, clock())],
];

/** Row 11's shape (author jo, kind instruction, channel direct, no question) stamped as someone other than this lane (G3). */
const ROW11_OTHER_STAMP: Write[] = ["lane-other", "escalation", "lane-runner"].map((by): Write => [
	`row 11's shape stamped ${by}`,
	(l, s) => l.recordInstruction({ by, workloadId: s.wl, body: "approve en-1", author: "jo", channel: "direct" }),
]);

/** Writes a lane makes every day; none may be refused. */
const LANE_WRITES: Write[] = [
	["row 11: Jo's words typed into the lane (author jo, channel direct, the lane's stamp)", (l, s) => l.recordInstruction({ by: LANE, workloadId: s.wl, body: "go right ahead", author: "jo", channel: "direct" })],
	["a lane entry", (l, s) => l.recordEntry({ by: LANE, workloadId: s.wl, kind: "assumption", body: "a lane note" })],
	["a lane slice, completed", (l, s) => l.completeSlice(l.addSlice({ by: LANE, workloadId: s.wl, task: "t", doneCondition: "d", inputs: "i" }), { by: LANE, artifact: "bun test → 0" })],
	["a lane question", (l, s) => l.raiseQuestion({ by: LANE, workloadId: s.wl, sliceId: s.slice, body: "which?", options: ["a", "b"] })],
	["a lane message, delivered by the lane", (l, s) => l.advanceMessage(l.enqueue({ by: LANE, workloadId: s.wl, sender: LANE, recipient: "orchestrator", body: "hi" }), "delivered", { by: LANE })],
	["the lane renews its lease", (l, s) => l.claimWorkload(s.wl, { by: LANE, holder: LANE, leaseMs: 3_600_000 })],
	["the runner withdraws a question as itself", (l, s) => l.withdrawQuestion(s.question, { by: "lane-runner", reason: "finished under the ceiling", author: "lane-runner", channel: "direct", then: "cancel" })],
	["a raw lane entry through ledger.write(fn)", (l, s) =>
		l.write(() => l.db.query("INSERT INTO entries (id, workload_id, kind, body, created_by, created_at) VALUES (?, ?, 'assumption', 'raw lane note', ?, ?)")
			.run("en-rawlanenote01", s.wl, LANE, clock()))],
];

describe("layer 1: an agent connection opened with { authority: 'enforce' } refuses Jo-only writes", () => {
	for (const [name, write] of [...SURFACE_WRITES, ...JO_NOT_ROW11, ...AGENT_ANSWERS, ...ROW11_OTHER_STAMP]) {
		test(`role lane: ${name} is refused with "Jo-only boundary" and writes nothing`, () => {
			const s = seed("refuse");
			const before = rows(s.path);
			enforced(s, { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LANE_ID: LANE, AGENT_SYSTEM_WORKLOAD_ID: s.wl }, (l) => {
				expect(() => write(l, s)).toThrow(BOUNDARY);
			});
			expect(rows(s.path)).toBe(before);
		});
	}

	test("every agent context refuses a surface-stamped entry: role hand, a lane id alone, a workload id alone, role orchestrator with a lane id", () => {
		const contexts: AgentEnv[] = [
			{ AGENT_SYSTEM_ROLE: "hand" },
			{ AGENT_SYSTEM_LANE_ID: LANE },
			{ AGENT_SYSTEM_WORKLOAD_ID: "wl-any" },
			{ AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LANE_ID: LANE },
		];
		const s = seed("contexts");
		for (const env of contexts) {
			enforced(s, env, (l) => {
				expect(() => l.recordEntry({ by: SURFACE_BY, workloadId: s.wl, kind: "assumption", body: "plan: approved in-forged0000002" }), JSON.stringify(env)).toThrow(BOUNDARY);
			});
		}
	});

	for (const [name, write] of LANE_WRITES) {
		test(`role lane: ${name} passes`, () => {
			const s = seed("pass");
			enforced(s, { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LANE_ID: LANE, AGENT_SYSTEM_WORKLOAD_ID: s.wl }, (l) => {
				expect(() => write(l, s)).not.toThrow();
			});
		});
	}

	test("G3: with no lane id in the env (a hand, a workload id alone, role lane alone) row 11's shape is refused, whatever the stamp", () => {
		const s = seed("row11-nolane");
		const before = rows(s.path);
		for (const env of [{ AGENT_SYSTEM_ROLE: "hand" }, { AGENT_SYSTEM_WORKLOAD_ID: s.wl }, { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_WORKLOAD_ID: s.wl }] as AgentEnv[]) {
			enforced(s, env, (l) => {
				for (const by of [LANE, "lane-other"]) {
					expect(() => l.recordInstruction({ by, workloadId: s.wl, body: "go", author: "jo", channel: "direct" }), `${JSON.stringify(env)} by ${by}`).toThrow(BOUNDARY);
				}
			});
		}
		expect(rows(s.path)).toBe(before);
	});

	test("G3: the lane id is a SQL literal: an id carrying a quote writes row 11 as itself and nothing else", () => {
		const s = seed("row11-quote");
		const odd = "lane-o'brien";
		enforced(s, { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LANE_ID: odd, AGENT_SYSTEM_WORKLOAD_ID: s.wl }, (l) => {
			expect(() => l.recordInstruction({ by: odd, workloadId: s.wl, body: "go", author: "jo", channel: "direct" })).not.toThrow();
			expect(() => l.recordInstruction({ by: LANE, workloadId: s.wl, body: "go", author: "jo", channel: "direct" })).toThrow(BOUNDARY);
		});
	});

	test("G2: a non-agent connection still writes an answer by any author (the surface's path)", () => {
		const s = seed("answer-jo-terminal");
		enforced(s, {}, (l) => {
			expect(() => l.answerQuestion(s.question, { by: LANE, answer: "approve", author: "lane-x", channel: "direct" })).not.toThrow();
		});
		expect(withEnv({}, () => {
			const l = Ledger.open(s.path, { clock, backup: false });
			try {
				return l.question(s.question)?.state;
			} finally {
				l.close();
			}
		})).toBe("answered");
	});

	for (const env of [{}, { AGENT_SYSTEM_ROLE: "orchestrator" }] as AgentEnv[]) {
		test(`${JSON.stringify(env)} (Jo's terminal / the top-level orchestrator) writes every surface row with the option on`, () => {
			for (const [name, write] of SURFACE_WRITES) {
				const s = seed("surface-ok");
				enforced(s, env, (l) => {
					expect(() => write(l, s), name).not.toThrow();
				});
			}
		});
	}

	test("the triggers are TEMP: open leaves sqlite_master and schema_version unchanged, during the connection and after it", () => {
		const s = seed("schema");
		const before = schema(s.path);
		enforced(s, { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LANE_ID: LANE }, (l) => {
			expect(l.db.query<{ n: number }, []>(TEMP_TRIGGERS).get()!.n).toBeGreaterThan(0);
			expect(schema(s.path)).toEqual(before);
		});
		expect(schema(s.path)).toEqual(before);
	});
});

describe("throwaway ledgers get no triggers", () => {
	test("a scratch ledger opened without the option in an agent context: no temp trigger, and a surface-stamped write lands", () => {
		const s = seed("throwaway");
		withEnv({ AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LANE_ID: LANE, AGENT_SYSTEM_WORKLOAD_ID: s.wl }, () => {
			const l = Ledger.open(s.path, { clock, backup: false });
			try {
				expect(l.db.query<{ n: number }, []>(TEMP_TRIGGERS).get()!.n).toBe(0);
				expect(() => l.recordEntry({ by: SURFACE_BY, workloadId: s.wl, kind: "assumption", body: "plan: approved in-test0000000001" })).not.toThrow();
				expect(() => l.recordInstruction({ by: SURFACE_BY, workloadId: s.wl, body: "ceiling: 500 12", author: "jo", channel: "surface" })).not.toThrow();
			} finally {
				l.close();
			}
		});
	});
});

describe("layer 1 outside test mode: the live root, with no option", () => {
	// A `bun -e` child with a clean env (no AS2_TEST_*, no NODE_ENV): the boundary's own live-root decision, not the
	// test option. Each fake home is a scratch directory; nothing here is under a real ~/.agent-system-2.
	const INDEX = JSON.stringify(join(REPO, "ledger", "src", "index.ts"));
	const CHILD = `
		import { Ledger } from ${INDEX};
		const [path, mode] = process.argv.slice(-2);
		const SURFACE = "orchestrator-surface", LANE = ${JSON.stringify(LANE)}, WL = "wl-authlive";
		const attempt = (name, fn) => { try { fn(); return { name, ok: true }; } catch (e) { return { name, ok: false, error: String(e?.message ?? e) }; } };
		if (mode === "seed") {
			const l = Ledger.open(path, { create: true, backup: false });
			l.openWorkload({ by: SURFACE, brief: "authority live-root probe", stakes: "normal", mode: "autonomous", id: WL });
			l.close();
			console.log("[]");
		} else {
			const l = Ledger.open(path, { backup: false });
			const out = [
				attempt("surface entry", () => l.recordEntry({ by: SURFACE, workloadId: WL, kind: "assumption", body: "plan: approved in-forged0000003" })),
				attempt("surface instruction", () => l.recordInstruction({ by: SURFACE, workloadId: WL, body: "ceiling: 500 12", author: "jo", channel: "surface" })),
				attempt("lane entry", () => l.recordEntry({ by: LANE, workloadId: WL, kind: "assumption", body: "a lane note" })),
				attempt("row 11 instruction", () => l.recordInstruction({ by: LANE, workloadId: WL, body: "go ahead", author: "jo", channel: "direct" })),
				attempt("row 11 as another lane", () => l.recordInstruction({ by: "lane-other", workloadId: WL, body: "approve en-1", author: "jo", channel: "direct" })),
				attempt("lane answer", () => {
					const slice = l.addSlice({ by: LANE, workloadId: WL, task: "t", doneCondition: "d", inputs: "i" });
					const q = l.raiseQuestion({ by: LANE, workloadId: WL, sliceId: slice, body: "approve?", options: ["approve", "revise"] });
					l.answerQuestion(q, { by: LANE, answer: "approve", author: "lane-x", channel: "direct" });
				}),
			];
			l.close();
			console.log(JSON.stringify(out));
		}`;

	type Attempt = { name: string; ok: boolean; error?: string };
	function child(cwd: string, path: string, mode: "seed" | "try", env: Record<string, string>): Attempt[] {
		const r = Bun.spawnSync([process.execPath, "-e", CHILD, "--", path, mode], {
			cwd,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? tmpdir(), ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(r.exitCode, r.stderr.toString()).toBe(0);
		return JSON.parse(r.stdout.toString().trim()) as Attempt[];
	}
	const verdicts = (out: Attempt[]) => Object.fromEntries(out.map((a) => [a.name, a.ok ? "ok" : BOUNDARY.test(a.error ?? "") ? "boundary" : `other: ${a.error}`]));
	const REFUSED = { "surface entry": "boundary", "surface instruction": "boundary", "lane entry": "ok", "row 11 instruction": "ok", "row 11 as another lane": "boundary", "lane answer": "boundary" };
	const ALL_OK = { "surface entry": "ok", "surface instruction": "ok", "lane entry": "ok", "row 11 instruction": "ok", "row 11 as another lane": "ok", "lane answer": "ok" };

	/** A fake home whose default ledger is seeded by Jo's terminal (no agent variables). */
	function liveHome(tag: string): { home: string; path: string } {
		const home = scratchDir(tag);
		const path = join(home, ".agent-system-2", "ledger.db");
		child(home, path, "seed", { HOME: home });
		return { home, path };
	}

	test("$HOME/.agent-system-2/ledger.db opened by a lane process: surface stamps refused, lane writes pass", () => {
		const { home, path } = liveHome("live-home");
		expect(verdicts(child(home, path, "try", { HOME: home, AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LANE_ID: LANE, AGENT_SYSTEM_WORKLOAD_ID: "wl-authlive" }))).toEqual(REFUSED);
	});

	test("the directory of AGENT_SYSTEM_LEDGER_DB is a live root: a process with only a lane id is refused there", () => {
		const home = scratchDir("ledger-db-home");
		const dir = join(scratchDir("ledger-db-dir"), "custom");
		mkdirSync(dir);
		const path = join(dir, "ledger.db");
		child(home, path, "seed", { HOME: home, AGENT_SYSTEM_LEDGER_DB: path });
		expect(verdicts(child(home, path, "try", { HOME: home, AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_LANE_ID: LANE }))).toEqual(REFUSED);
	});

	test("Jo's terminal and the top-level orchestrator write surface rows to the live file", () => {
		const { home, path } = liveHome("live-jo");
		expect(verdicts(child(home, path, "try", { HOME: home }))).toEqual(ALL_OK);
		expect(verdicts(child(home, path, "try", { HOME: home, AGENT_SYSTEM_ROLE: "orchestrator" }))).toEqual(ALL_OK);
	});

	test("a ledger outside every live root opened by a lane process gets no triggers (a lane-run chaos, a scratch ledger)", () => {
		const home = scratchDir("scratch-home");
		const path = join(scratchDir("scratch-ledger"), "ledger.db");
		child(home, path, "seed", { HOME: home });
		expect(verdicts(child(home, path, "try", { HOME: home, AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LANE_ID: LANE }))).toEqual(ALL_OK);
	});
});

describe("the Jo-only table is complete (PLAN § 6.3 item 5)", () => {
	interface AuthorityRow {
		kind: "instruction-kind" | "control-prefix" | "direct-channel";
		name: string;
		writer: string;
		reader: string;
		authority: "jo-only" | "words, not authority";
	}
	async function table(): Promise<readonly AuthorityRow[]> {
		// Dynamic on purpose: authority.ts is new in PR-C, and a static import would fail every test in this file
		// on main, not only the table's.
		const mod: Record<string, unknown> = await import("../src/authority");
		const rows = mod.AUTHORITY as readonly AuthorityRow[]; // the shape the header fixes; the tests below check it
		return rows;
	}

	/** The control prefixes the surface writes, read from the writer check itself (launch.ts `controlEntries`), not from a list. */
	function surfacePrefixes(): string[] {
		return CONTROL_PREFIXES.filter((p) => {
			const e: EntryRow = { id: "en-probe", workload_id: "wl-probe", slice_id: null, kind: "assumption", body: `${p}: lane-probe-1 requested by jo`, created_by: SURFACE_BY, created_at: "2026-10-19T00:00:00.000Z" };
			return controlEntries([e], []).length > 0;
		});
	}

	/** Every instructions kind the schema admits; the surface writes each for Jo (instruction, answer, withdrawal, mode-flip). */
	function instructionKinds(): string[] {
		const path = join(scratchDir("kinds"), "ledger.db");
		const l = withEnv({}, () => Ledger.open(path, { create: true, clock, backup: false }));
		try {
			const sql = l.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'instructions'").get()!.sql;
			const list = /kind\s+TEXT\s+NOT NULL\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)\s*\)/.exec(sql)![1]!;
			return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
		} finally {
			l.close();
		}
	}

	test("the derivations read what they claim (sanity: known surface prefixes and kinds are found)", () => {
		const prefixes = surfacePrefixes();
		for (const p of ["plan", "done", "repo", "ceiling", "launch-requested", "lane-model"]) expect(prefixes).toContain(p);
		for (const p of ["launch", "spend", "test-run", "done-because"]) expect(prefixes).not.toContain(p);
		expect(instructionKinds()).toEqual(["instruction", "answer", "withdrawal", "mode-flip"]);
	});

	test("every control prefix whose WRITERS entry is the surface is a jo-only row written by the surface", async () => {
		const t = await table();
		const missing = surfacePrefixes().filter((p) => !t.some((r) => r.kind === "control-prefix" && r.name === p && r.authority === "jo-only" && r.writer === SURFACE_BY));
		expect(missing).toEqual([]);
	});

	test("the prefixes PLAN § 6.2 names are in the table, cap: and switch: included", async () => {
		const t = await table();
		const prefixes = t.filter((r) => r.kind === "control-prefix").map((r) => r.name);
		for (const p of ["plan", "done", "repo", "ceiling", "launch-requested", "lane-model", "cap", "switch"]) expect(prefixes).toContain(p);
	});

	test("every instruction kind the surface writes for Jo is a jo-only row written by the surface", async () => {
		const t = await table();
		const missing = instructionKinds().filter((k) => !t.some((r) => r.kind === "instruction-kind" && r.name === k && r.authority === "jo-only" && r.writer === SURFACE_BY));
		expect(missing).toEqual([]);
	});

	test("row 11's direct channel is the one 'words, not authority' row, and it is not the surface's", async () => {
		const t = await table();
		const direct = t.filter((r) => r.kind === "direct-channel");
		expect(direct).toHaveLength(1);
		expect(direct[0]).toMatchObject({ name: "direct", authority: "words, not authority" });
		expect(direct[0]!.writer).not.toBe(SURFACE_BY);
		expect(t.filter((r) => r.authority === "words, not authority")).toEqual(direct);
	});

	test("every row names its reader, and no (kind, name) appears twice", async () => {
		const t = await table();
		expect(t.filter((r) => r.reader.trim() === "")).toEqual([]);
		const keys = t.map((r) => `${r.kind}:${r.name}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
