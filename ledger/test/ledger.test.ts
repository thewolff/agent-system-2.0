import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
// Only names that also existed before the N1-N4 fixes, so each regression below fails on its own
// assertion against the old module rather than the whole file failing to load.
import { assertLocalPath, defaultLedgerPath, Ledger, LEDGER_DB_ENV, LedgerLocationError, SCHEMA_VERSION } from "../src/index";

const REPO = join(import.meta.dir, "..", "..");
const SQLITE3 = existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3";
const scratch = (label: string) => mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), `ledger-${label}-`));
const fresh = (label: string, opts: Parameters<typeof Ledger.open>[1] = {}) =>
	Ledger.open(join(scratch(label), "ledger.db"), { create: true, ...opts });

/** Raw sqlite3 CLI (foreign_keys and recursive_triggers off): SQL on stdin, stops at the first error. */
function sqlite(path: string, sql: string): { exitCode: number | null; out: string; err: string } {
	const r = Bun.spawnSync([SQLITE3, "-batch", "-bail", path], { stdin: Buffer.from(sql), stdout: "pipe", stderr: "pipe" });
	return { exitCode: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

/** `bun run ledger/scripts/<name> ...args`. */
function script(name: string, ...args: string[]): { exitCode: number | null; out: string; err: string } {
	const r = Bun.spawnSync(["bun", "run", join(REPO, "ledger", "scripts", name), ...args], { stdout: "pipe", stderr: "pipe" });
	return { exitCode: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const RAW_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const RAW_STAMPS = `'tool:sqlite3', ${RAW_NOW}, 'tool:sqlite3', ${RAW_NOW}`;

/** A clock that starts at `start` and advances `stepMs` per call, so stamps are known in advance. */
function steppingClock(start: string, stepMs = 1): () => string {
	let t = Date.parse(start) - stepMs;
	return () => new Date((t += stepMs)).toISOString();
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("legal lifecycle", () => {
	test("open -> claim -> slice -> queue -> question -> answer -> done -> release -> close, every write logged", () => {
		const l = fresh("lifecycle");
		const w = l.openWorkload({ brief: "ship the ledger", stakes: "normal", mode: "autonomous", by: "orch-1" });
		expect(l.claimWorkload(w, { holder: "lane-1", leaseMs: 60_000, by: "lane-1" })).toEqual({ won: true });
		const s = l.addSlice({ workloadId: w, task: "write schema", doneCondition: "tests.log exit 0", inputs: "ledger/", by: "lane-1" });

		const m = l.enqueue({ workloadId: w, sliceId: s, sender: "orchestrator", recipient: "lane-1", body: "go", by: "orch-1" });
		for (const to of ["delivered", "consumed", "acted-on"] as const) l.advanceMessage(m, to, { by: "lane-1" });
		expect(l.message(m)?.state).toBe("acted-on");

		const q = l.raiseQuestion({ workloadId: w, sliceId: s, body: "WAL or rollback journal?", options: ["WAL", "rollback"], by: "lane-1" });
		expect(l.slice(s)?.state).toBe("paused");
		const answer = l.answerQuestion(q, { answer: "WAL", author: "jo", channel: "surface", by: "orch-1" });
		expect(l.question(q)).toMatchObject({ state: "answered", resolved_by: answer });
		expect(l.slice(s)?.state).toBe("open");

		const direct = l.recordInstruction({ workloadId: w, sliceId: s, body: "also document the env var", author: "jo", channel: "direct", by: "lane-1" });
		expect(l.instructions(w).map((i) => [i.id, i.kind])).toEqual([[answer, "answer"], [direct, "instruction"]]);

		l.completeSlice(s, { artifact: "/tmp/tests.log", by: "lane-1" });
		// A close under the holder's live lease is refused (Codex review S2): the lane releases first.
		expect(() => l.closeWorkload(w, { by: "orch-1" })).toThrow(`cannot close workload ${w}: held by lane-1 under a live lease`);
		expect(l.releaseWorkload(w, { by: "lane-1", holder: "lane-1" })).toEqual({ released: true });
		l.closeWorkload(w, { by: "orch-1" });
		expect(l.workload(w)).toMatchObject({ status: "closed", holder: null, open_slices: 0, open_questions: 0 });

		const log = l.provenance(w).map((p) => `${p.tbl}:${p.action}:${p.detail}`);
		expect(log).toEqual([
			"workloads:insert:open stakes=normal mode=autonomous",
			expect.stringMatching(/^workloads:update:holder -->lane-1 lease /),
			"slices:insert:open",
			"messages:insert:held",
			"messages:update:held->delivered",
			"messages:update:delivered->consumed",
			"messages:update:consumed->acted-on",
			"questions:insert:open slice=" + s,
			"slices:update:open->paused",
			"instructions:insert:answer " + q,
			"questions:update:open->answered by " + answer,
			"slices:update:paused->open",
			"instructions:insert:instruction",
			"slices:update:open->done",
			"workloads:update:holder lane-1->- lease -",
			"workloads:update:status open->closed",
		]);
		l.close();
	});

	test("a question pauses only its own slice; unrelated slices keep running", () => {
		const l = fresh("isolation");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch-1" });
		const a = l.addSlice({ workloadId: w, task: "a", doneCondition: "d", inputs: "i", by: "lane-1" });
		const b = l.addSlice({ workloadId: w, task: "b", doneCondition: "d", inputs: "i", by: "lane-1" });
		l.raiseQuestion({ workloadId: w, sliceId: a, body: "?", options: ["x", "y"], by: "lane-1" });
		expect([l.slice(a)?.state, l.slice(b)?.state]).toEqual(["paused", "open"]);
		l.completeSlice(b, { artifact: "b.log", by: "lane-1" });
		expect(() => l.closeWorkload(w, { by: "orch-1" })).toThrow("cannot close a workload");
		l.close();
	});

	test("two open questions on one slice: the slice resumes only after both are answered", () => {
		const l = fresh("two-questions");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch-1" });
		const s = l.addSlice({ workloadId: w, task: "a", doneCondition: "d", inputs: "i", by: "lane-1" });
		const q1 = l.raiseQuestion({ workloadId: w, sliceId: s, body: "1?", options: ["x", "y"], by: "lane-1" });
		const q2 = l.raiseQuestion({ workloadId: w, sliceId: s, body: "2?", options: ["x", "y"], by: "lane-1" });
		l.answerQuestion(q1, { answer: "x", author: "jo", channel: "surface", by: "orch-1" });
		expect(l.slice(s)?.state).toBe("paused");
		l.answerQuestion(q2, { answer: "y", author: "jo", channel: "surface", by: "orch-1" });
		expect(l.slice(s)?.state).toBe("open");
		l.close();
	});

	test("a withdrawal cancels or replans the slice and is never recorded as an answer", () => {
		const l = fresh("withdraw");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch-1" });
		const s1 = l.addSlice({ workloadId: w, task: "a", doneCondition: "d", inputs: "i", by: "lane-1" });
		const s2 = l.addSlice({ workloadId: w, task: "b", doneCondition: "d", inputs: "i", by: "lane-1" });
		const q1 = l.raiseQuestion({ workloadId: w, sliceId: s1, body: "?", options: ["x", "y"], by: "lane-1" });
		const q2 = l.raiseQuestion({ workloadId: w, sliceId: s2, body: "?", options: ["x", "y"], by: "lane-1" });
		l.withdrawQuestion(q1, { reason: "not needed", then: "cancel", author: "jo", channel: "surface", by: "orch-1" });
		l.withdrawQuestion(q2, { reason: "do it differently", then: "replan", author: "jo", channel: "surface", by: "orch-1" });
		expect([l.question(q1)?.state, l.slice(s1)?.state, l.question(q2)?.state, l.slice(s2)?.state])
			.toEqual(["withdrawn", "cancelled", "withdrawn", "open"]);
		expect(l.instructions(w).map((i) => i.kind)).toEqual(["withdrawal", "withdrawal"]);
		l.close();
	});

	test("a mode flip lands as a ledgered instruction in the same write", () => {
		const l = fresh("mode");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch-1" });
		const i = l.flipMode(w, { mode: "user-driven", author: "jo", channel: "surface", by: "orch-1" });
		expect(l.workload(w)?.mode).toBe("user-driven");
		expect(l.instructions(w)).toMatchObject([{ id: i, kind: "mode-flip", body: "user-driven" }]);
		l.close();
	});
});

describe("lease + reclaim", () => {
	test("a live lease refuses another holder; an expired one is reclaimed", () => {
		const l = fresh("lease");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch-1" });
		expect(l.claimWorkload(w, { holder: "lane-A", leaseMs: 150, by: "lane-A" })).toEqual({ won: true });
		expect(l.claimWorkload(w, { holder: "lane-B", leaseMs: 150, by: "lane-B" })).toEqual({ won: false, holder: "lane-A", status: "open" });
		expect(l.claimWorkload(w, { holder: "lane-A", leaseMs: 150, by: "lane-A" })).toEqual({ won: true });
		Bun.sleepSync(250);
		expect(l.claimWorkload(w, { holder: "lane-B", leaseMs: 60_000, by: "lane-B" })).toEqual({ won: true });
		expect(l.claimWorkload(w, { holder: "lane-C", leaseMs: 60_000, by: "lane-C" })).toMatchObject({ won: false, holder: "lane-B" });
		expect(l.releaseWorkload(w, { by: "lane-A", holder: "lane-A" })).toEqual({ released: false, holder: "lane-B" });
		expect(l.releaseWorkload(w, { by: "lane-B", holder: "lane-B" })).toEqual({ released: true });
		expect(l.claimWorkload(w, { holder: "jo", leaseMs: null, by: "orch-1" })).toEqual({ won: true });
		expect(l.workload(w)).toMatchObject({ holder: "jo", holder_lease_until: null });
		l.close();
	});
});

describe("provenance cannot be omitted", () => {
	test("the module refuses a write with no lane instance, and the file refuses one without the module", () => {
		const l = fresh("provenance");
		expect(() => l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "" })).toThrow("CHECK constraint failed");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch-1" });
		expect(() => l.addSlice({ workloadId: w, task: "t", doneCondition: "d", inputs: "i", by: "   " })).toThrow("CHECK constraint failed");
		// An unstamped holder change (stakes would meet workloads_stakes_needs_instruction first, schema version 6).
		expect(() => l.db.run("UPDATE workloads SET holder = 'lane-x' WHERE id = ?", [w])).toThrow("unstamped update");
		l.close();
	});

	test("every row of every table carries workload, lane instance and a well-formed time", () => {
		const l = fresh("provenance-all");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch-1" });
		const s = l.addSlice({ workloadId: w, task: "t", doneCondition: "d", inputs: "i", by: "lane-1" });
		const q = l.raiseQuestion({ workloadId: w, sliceId: s, body: "?", options: ["a", "b"], by: "lane-1" });
		l.answerQuestion(q, { answer: "a", author: "jo", channel: "surface", by: "orch-1" });
		l.enqueue({ workloadId: w, sender: "o", recipient: "l", body: "m", by: "orch-1" });
		for (const table of ["slices", "messages", "questions", "instructions"]) {
			for (const row of l.db.query<{ workload_id: string; created_by: string; created_at: string }, []>(`SELECT * FROM ${table}`).all()) {
				expect(row.workload_id).toBe(w);
				expect(row.created_by.trim()).not.toBe("");
				expect(row.created_at).toMatch(ISO);
			}
		}
		const prov = l.provenance(w);
		expect(prov.length).toBe(8);
		for (const p of prov) {
			expect(p.lane_instance.trim()).not.toBe("");
			expect(p.at).toMatch(ISO);
		}
		l.close();
	});
});

describe("queries", () => {
	test("oldest held: the earliest message still held, its age at a given instant, per workload or overall", () => {
		const l = fresh("oldest", { clock: steppingClock("2026-09-28T10:00:00.000Z", 10_000) });
		expect(l.oldestHeld("2026-09-28T11:00:00.000Z")).toBeNull();
		const w1 = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch-1" }); // 10:00:00
		const w2 = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch-1" }); // 10:00:10
		const send = (w: string) => l.enqueue({ workloadId: w, sender: "o", recipient: "l", body: "m", by: "orch-1" });
		const m1 = send(w1); // 10:00:20
		const m2 = send(w2); // 10:00:30
		const m3 = send(w1); // 10:00:40
		const at = "2026-09-28T10:01:00.000Z";
		expect(l.oldestHeld(at)).toEqual({ id: m1, workload_id: w1, enqueued_at: "2026-09-28T10:00:20.000Z", age_seconds: 40 });
		expect(l.oldestHeld(at, w2)).toMatchObject({ id: m2, age_seconds: 30 });

		l.advanceMessage(m1, "delivered", { by: "lane-1" });
		expect(l.oldestHeld(at)).toMatchObject({ id: m2, age_seconds: 30 });
		expect(l.oldestHeld(at, w1)).toMatchObject({ id: m3, age_seconds: 20 });
		expect(l.workload(w1)).toMatchObject({ held_messages: 1, oldest_held_at: "2026-09-28T10:00:40.000Z" });

		l.advanceMessage(m2, "delivered", { by: "lane-1" });
		l.advanceMessage(m3, "delivered", { by: "lane-1" });
		expect(l.oldestHeld(at)).toBeNull();
		l.close();
	});

	test("in flight: open workloads with their running/paused slices, open questions and unacted messages", () => {
		// A stepping clock, so every row's stamp is distinct: questions and messages still break a
		// same-millisecond tie by id (ORDER BY created_at, id).
		const l = fresh("inflight", { clock: steppingClock("2026-09-28T10:00:00.000Z") });
		const w = l.openWorkload({ brief: "live", stakes: "production", mode: "user-driven", by: "orch-1" });
		const done = l.addSlice({ workloadId: w, task: "done one", doneCondition: "d", inputs: "i", by: "lane-1" });
		l.completeSlice(done, { artifact: "a.log", by: "lane-1" });
		const running = l.addSlice({ workloadId: w, task: "running", doneCondition: "d", inputs: "i", by: "lane-1" });
		const paused = l.addSlice({ workloadId: w, task: "paused", doneCondition: "d", inputs: "i", by: "lane-1" });
		const q = l.raiseQuestion({ workloadId: w, sliceId: paused, body: "which?", options: ["a", "b", "c"], by: "lane-1" });
		const acted = l.enqueue({ workloadId: w, sender: "o", recipient: "l", body: "old", by: "orch-1" });
		for (const to of ["delivered", "consumed", "acted-on"] as const) l.advanceMessage(acted, to, { by: "lane-1" });
		const pending = l.enqueue({ workloadId: w, sender: "o", recipient: "l", body: "new", by: "orch-1" });
		const closed = l.openWorkload({ brief: "finished", stakes: "throwaway", mode: "autonomous", by: "orch-1" });
		l.closeWorkload(closed, { by: "orch-1" });

		const flight = l.inFlight();
		expect(flight.map((f) => f.workload.id)).toEqual([w]);
		const [f] = flight;
		expect(f!.workload).toMatchObject({ stakes: "production", mode: "user-driven", open_slices: 1, paused_slices: 1, open_questions: 1, held_messages: 1 });
		expect(f!.workload.last_activity_at).toMatch(ISO);
		expect(f!.slices.map((s) => [s.id, s.state])).toEqual([[running, "open"], [paused, "paused"]]);
		expect(f!.openQuestions).toMatchObject([{ id: q, slice_id: paused, options: ["a", "b", "c"] }]);
		expect(f!.pendingMessages.map((m) => m.id)).toEqual([pending]);
		l.close();
	});

	test("slices in one millisecond come back in insertion order from slices() and inFlight(), not by id (PLAN wl-muq22rnjcfrrpc D9 part three)", () => {
		const l = fresh("slice-order", { clock: () => "2026-09-28T10:00:00.000Z" });
		const w = l.openWorkload({ brief: "tie", stakes: "normal", mode: "autonomous", by: "orch-1" });
		const ids = ["sl-z-first", "sl-m-second", "sl-a-third"];
		for (const id of ids) l.addSlice({ workloadId: w, task: id, doneCondition: "d", inputs: "i", by: "lane-1", id });
		expect(l.slices(w).map((s) => s.id)).toEqual(ids);
		expect(l.inFlight()[0]!.slices.map((s) => s.id)).toEqual(ids);
		l.close();
	});
});

describe("runtime obligations", () => {
	test("a write waits out another process's write lock by retrying on SQLITE_BUSY", () => {
		const dir = scratch("busy");
		const path = join(dir, "ledger.db");
		Ledger.open(path, { create: true }).close();
		const holder = Bun.spawn(["bun", "-e", `
			import { Database } from "bun:sqlite";
			const db = new Database(${JSON.stringify(path)});
			db.exec("BEGIN IMMEDIATE");
			console.log("locked");
			Bun.sleepSync(600);
			db.exec("COMMIT");
		`], { stdout: "pipe" });
		// Wait until the other process holds the lock.
		const deadline = Date.now() + 5000;
		const probe = Ledger.open(path, { busyTimeoutMs: 0, busyRetries: 0 });
		while (Date.now() < deadline) {
			try {
				probe.db.exec("BEGIN IMMEDIATE");
				probe.db.exec("ROLLBACK");
				Bun.sleepSync(10);
			} catch {
				break;
			}
		}
		expect(() => probe.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "o" })).toThrow();
		probe.close();

		const patient = Ledger.open(path, { busyTimeoutMs: 20, busyRetries: 8 });
		const w = patient.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch-1" });
		expect(patient.workload(w)?.status).toBe("open");
		patient.close();
		holder.kill();
	});

	test("backup via VACUUM INTO yields a readable copy with the rules intact", () => {
		const l = fresh("backup");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch-1" });
		const dest = join(scratch("backup-dest"), "copy.db");
		l.backup(dest);
		l.close();
		const copy = Ledger.open(dest);
		expect(copy.workload(w)?.brief).toBe("b");
		expect(() => copy.db.run("DELETE FROM workloads")).toThrow("ledger rows are never deleted");
		copy.close();
	});

	test("a plain `bun run` script, with no OMP in the environment, creates, writes and queries the ledger", () => {
		const path = join(scratch("plain"), "nested", "ledger.db");
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(OMP_|PI_)/.test(k)) env[k] = v;
		env[LEDGER_DB_ENV] = path;
		const init = Bun.spawnSync(["bun", "run", join(REPO, "ledger", "scripts", "init.ts")], { env, stdout: "pipe", stderr: "pipe" });
		expect(init.stderr.toString()).toBe("");
		expect(init.exitCode).toBe(0);
		expect(init.stdout.toString()).toContain(`ledger ok: path=${path} schema_version=6 journal_mode=wal`);
		const use = Bun.spawnSync(["bun", "-e", `
			import { Ledger } from ${JSON.stringify(join(REPO, "ledger", "src", "index.ts"))};
			const l = Ledger.open();
			const w = l.openWorkload({ brief: "from a plain script", stakes: "throwaway", mode: "autonomous", by: "script" });
			console.log(JSON.stringify(l.inFlight().map((f) => f.workload.brief)));
		`], { env, stdout: "pipe", stderr: "pipe" });
		expect(use.stderr.toString()).toBe("");
		expect(use.stdout.toString().trim()).toBe('["from a plain script"]');
	});
});

describe("locality", () => {
	test("the default path is $HOME-rooted and the env var overrides it", () => {
		expect(defaultLedgerPath({ HOME: "/home/x" })).toBe("/home/x/.agent-system-2/ledger.db");
		expect(defaultLedgerPath({ HOME: "/home/x", [LEDGER_DB_ENV]: "/data/l.db" })).toBe("/data/l.db");
	});

	test("synced folders under $HOME are refused, a local folder is accepted", () => {
		const home = scratch("home");
		for (const rel of ["Library/CloudStorage/Dropbox/l.db", "Library/Mobile Documents/com~apple~CloudDocs/l.db", "Documents/l.db", "Dropbox/l.db"]) {
			expect(() => assertLocalPath(join(home, rel), home)).toThrow(LedgerLocationError);
		}
		expect(() => assertLocalPath(join(home, ".agent-system-2", "ledger.db"), home)).not.toThrow();
	});

	test("the init script exits 3 and creates nothing when the path is in a synced folder", () => {
		const home = scratch("home-synced");
		const target = join(home, "Library", "CloudStorage", "Dropbox", "ledger.db");
		mkdirSync(join(home, "Library", "CloudStorage", "Dropbox"), { recursive: true });
		const r = Bun.spawnSync(["bun", "run", join(REPO, "ledger", "scripts", "init.ts")], {
			env: { ...process.env, HOME: home, [LEDGER_DB_ENV]: target }, stdout: "pipe", stderr: "pipe",
		});
		expect(r.exitCode).toBe(3);
		expect(r.stderr.toString()).toContain("a synced folder");
		expect(existsSync(target)).toBe(false);
	});
});


// ---- regressions from the M2 review (REVIEW.md, review-astra) --------------------------------

describe("withdrawal disposition is persisted and honoured by the file (B2)", () => {
	const setup = (label: string) => {
		const l = fresh(label);
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch-1" });
		const s = l.addSlice({ workloadId: w, task: "a", doneCondition: "d", inputs: "i", by: "lane-1" });
		const q1 = l.raiseQuestion({ workloadId: w, sliceId: s, body: "one?", options: ["a", "b"], by: "lane-1" });
		const q2 = l.raiseQuestion({ workloadId: w, sliceId: s, body: "two?", options: ["a", "b"], by: "lane-1" });
		return { l, w, s, q1, q2 };
	};
	const jo = { author: "jo", channel: "surface" as const, by: "orch-1" };

	test("review probe: cancel-withdraw one question, answer the other; the slice ends cancelled, not resumed", () => {
		const { l, w, s, q1, q2 } = setup("b2-probe");
		const wid = l.withdrawQuestion(q1, { reason: "stop this slice", then: "cancel", ...jo });
		expect(l.slice(s)?.state).toBe("paused");
		expect(l.instructions(w).find((i) => i.id === wid)).toMatchObject({ kind: "withdrawal", disposition: "cancel" });
		l.answerQuestion(q2, { answer: "a", ...jo });
		expect([l.slice(s)?.state, l.question(q1)?.state, l.question(q2)?.state]).toEqual(["cancelled", "withdrawn", "answered"]);
		expect(l.provenance(w).map((p) => p.detail)).toContain(`withdrawal ${q1} then cancel`);
		expect(l.provenance(w).at(-1)).toMatchObject({ tbl: "slices", detail: "paused->cancelled" });
		l.close();
	});

	test("answer first, then cancel-withdraw the last open question: cancelled at once", () => {
		const { l, s, q1, q2 } = setup("b2-last");
		l.answerQuestion(q1, { answer: "a", ...jo });
		expect(l.slice(s)?.state).toBe("paused");
		l.withdrawQuestion(q2, { reason: "no", then: "cancel", ...jo });
		expect(l.slice(s)?.state).toBe("cancelled");
		l.close();
	});

	test("replan-withdraw one, answer the other: the slice runs again", () => {
		const { l, s, q1, q2 } = setup("b2-replan");
		l.withdrawQuestion(q1, { reason: "differently", then: "replan", ...jo });
		expect(l.slice(s)?.state).toBe("paused");
		l.answerQuestion(q2, { answer: "b", ...jo });
		expect(l.slice(s)?.state).toBe("open");
		l.close();
	});

	test("a deferred cancel outranks a later replan on the same slice", () => {
		const { l, s, q1, q2 } = setup("b2-both");
		l.withdrawQuestion(q1, { reason: "stop", then: "cancel", ...jo });
		l.withdrawQuestion(q2, { reason: "differently", then: "replan", ...jo });
		expect(l.slice(s)?.state).toBe("cancelled");
		l.close();
	});
});

describe("a mirrored answer: the row resolved and a plain instruction on another workload, one transaction (MIGRATION.md item 105)", () => {
	const jo = { author: "jo", channel: "surface" as const, by: "orchestrator-surface" };
	const setup = (label: string) => {
		const l = fresh(label);
		const asker = l.openWorkload({ brief: "standing", stakes: "throwaway", mode: "autonomous", by: "orchestrator-surface", id: "wl-orchestrator" });
		const s = l.addSlice({ workloadId: asker, task: "asks", doneCondition: "never", inputs: "chat", by: "orchestrator-surface" });
		const subject = l.openWorkload({ brief: "the work", stakes: "normal", mode: "autonomous", by: "orchestrator-surface" });
		const q = l.raiseQuestion({ workloadId: asker, sliceId: s, body: `about ${subject}: now or later?`, options: ["now", "later"], by: "orchestrator-surface" });
		return { l, asker, s, subject, q };
	};

	test("the answer resolves the row and settles the slice; the mirror is an instruction row by the same author on the subject", () => {
		const { l, asker, s, subject, q } = setup("mirror");
		const r = l.answerQuestionMirrored(q, { answer: "later", mirror: { workloadId: subject, body: 'Jo: "later" — answers the ask' }, ...jo });
		expect(l.question(q)).toMatchObject({ state: "answered", resolved_by: r.answerId });
		expect(l.slice(s)?.state).toBe("open");
		expect(l.instructions(asker)).toMatchObject([{ id: r.answerId, kind: "answer", question_id: q, author: "jo", channel: "surface", body: "later" }]);
		expect(l.instructions(subject)).toMatchObject([{ id: r.mirrorId, kind: "instruction", question_id: null, disposition: null, author: "jo", channel: "surface", body: 'Jo: "later" — answers the ask' }]);
		l.close();
	});

	test("a mirror the file refuses (a closed or unknown subject) rolls the answer back: the question stays open, no instruction on either side", () => {
		const { l, asker, s, subject, q } = setup("mirror-rollback");
		l.closeWorkload(subject, { by: "orchestrator-surface" });
		expect(() => l.answerQuestionMirrored(q, { answer: "now", mirror: { workloadId: subject, body: "x" }, ...jo })).toThrow(/no open workload/);
		expect(() => l.answerQuestionMirrored(q, { answer: "now", mirror: { workloadId: "wl-nope", body: "x" }, ...jo })).toThrow();
		expect(l.question(q)?.state).toBe("open");
		expect(l.slice(s)?.state).toBe("paused");
		expect(l.instructions(asker)).toEqual([]);
		expect(l.instructions(subject)).toEqual([]);
		l.close();
	});
});

describe("synced-folder refusal sees through symlinks (B3)", () => {
	test("review probe: an alias into ~/Dropbox is refused like ~/Dropbox itself", () => {
		const home = scratch("b3-home");
		mkdirSync(join(home, "Dropbox"), { recursive: true });
		symlinkSync(join(home, "Dropbox"), join(home, "alias"));
		expect(() => assertLocalPath(join(home, "Dropbox", "ledger.db"), home)).toThrow(LedgerLocationError);
		expect(() => assertLocalPath(join(home, "alias", "ledger.db"), home)).toThrow("a synced folder");
	});

	test("a symlinked HOME, a synced root that is itself a symlink, and existing or dangling database links are refused", () => {
		const home = scratch("b3-more");
		mkdirSync(join(home, "Dropbox"));
		const homeLink = join(scratch("b3-homelink"), "home");
		symlinkSync(home, homeLink);
		expect(() => assertLocalPath(join(home, "Dropbox", "l.db"), homeLink)).toThrow("a synced folder");
		expect(() => assertLocalPath(join(homeLink, "Dropbox", "l.db"), home)).toThrow("a synced folder");

		const syncTarget = scratch("b3-sync-target");
		symlinkSync(syncTarget, join(home, "OneDrive"));
		expect(() => assertLocalPath(join(syncTarget, "l.db"), home)).toThrow("a synced folder");

		const local = join(home, ".agent-system-2");
		mkdirSync(local);
		writeFileSync(join(home, "Dropbox", "real.db"), "");
		symlinkSync(join(home, "Dropbox", "real.db"), join(local, "existing.db"));
		expect(() => assertLocalPath(join(local, "existing.db"), home)).toThrow("a synced folder");
		symlinkSync(join(home, "Dropbox", "not-yet.db"), join(local, "dangling.db"));
		expect(() => assertLocalPath(join(local, "dangling.db"), home)).toThrow("a synced folder");
	});

	test("Ledger.open refuses the alias and creates nothing behind it; an accepted alias is opened at its canonical path", () => {
		const home = scratch("b3-open");
		mkdirSync(join(home, "Dropbox"));
		symlinkSync(join(home, "Dropbox"), join(home, "alias"));
		mkdirSync(join(home, "real-local"));
		symlinkSync(join(home, "real-local"), join(home, "work"));
		const saved = process.env.HOME;
		process.env.HOME = home;
		try {
			expect(() => Ledger.open(join(home, "alias", "ledger.db"), { create: true })).toThrow(LedgerLocationError);
			expect(readdirSync(join(home, "Dropbox"))).toEqual([]);
			const l = Ledger.open(join(home, "work", "ledger.db"), { create: true });
			expect(l.path).toBe(join(realpathSync(join(home, "real-local")), "ledger.db"));
			l.close();
		} finally {
			process.env.HOME = saved;
		}
	});
});

describe("scheduled second copy (S2)", () => {
	/** This directory's copies, wherever under backups/ they are (one ledger per test directory). */
	const copyPaths = (path: string) => (readdirSync(join(dirname(path), "backups"), { recursive: true }) as string[])
		.filter((n) => n.endsWith(".db")).map((n) => join(dirname(path), "backups", n)).sort((a, b) => basename(a) < basename(b) ? -1 : 1);
	const copies = (path: string) => copyPaths(path).map((p) => basename(p));

	test("opening an existing ledger takes a reopenable VACUUM INTO copy when due, none when not, and keeps the newest N", () => {
		const dir = scratch("s2-open");
		const path = join(dir, "ledger.db");
		const first = Ledger.open(path, { create: true });
		const w = first.openWorkload({ brief: "kept in the copy", stakes: "normal", mode: "autonomous", by: "orch-1" });
		first.close();
		expect(existsSync(join(dir, "backups"))).toBe(false); // the creating open has nothing to copy
		const openAt = (iso: string) => Ledger.open(path, { clock: () => iso, backup: { keep: 2 } }).close();

		openAt("2026-09-28T10:00:00.000Z");
		expect(copies(path)).toEqual(["ledger-2026-09-28T10-00-00.000Z.db"]);
		openAt("2026-09-28T11:00:00.000Z");
		expect(copies(path)).toEqual(["ledger-2026-09-28T10-00-00.000Z.db"]);
		openAt("2026-09-29T10:00:00.000Z");
		openAt("2026-09-30T10:00:00.000Z");
		expect(copies(path)).toEqual(["ledger-2026-09-29T10-00-00.000Z.db", "ledger-2026-09-30T10-00-00.000Z.db"]);

		const copy = Ledger.open(copyPaths(path).at(-1)!, { backup: false });
		expect(copy.workload(w)?.brief).toBe("kept in the copy");
		expect(() => copy.db.run("DELETE FROM workloads")).toThrow("ledger rows are never deleted");
		copy.close();
	});

	test("the `bun run` backup script takes a copy when due, reports none due right after, and --force takes one", () => {
		const dir = scratch("s2-script");
		const path = join(dir, "ledger.db");
		Ledger.open(path, { create: true }).close();
		const a = script("backup.ts", path);
		expect([a.exitCode, a.err]).toEqual([0, ""]);
		expect(a.out).toMatch(/^backup ok: took .*ledger-.*\.db\n$/);
		expect(script("backup.ts", path).out).toMatch(/^backup ok: none due; newest /);
		expect(script("backup.ts", path, "--force").out).toMatch(/^backup ok: took /);
		expect(copies(path).length).toBe(2);
		const check = Bun.spawnSync([SQLITE3, copyPaths(path)[0]!, "PRAGMA user_version; PRAGMA integrity_check;"]);
		expect(check.stdout.toString().trim().split("\n")).toEqual(["6", "ok"]);
	});
});

describe("a ledger at a version older than the oldest upgrade (5), or unknown, is refused unchanged, never upgraded (N1; version 5's upgrade is freeze.test.ts)", () => {
	/** Everything the refusal must leave alone: version, schema objects, rows. */
	const state = (path: string) =>
		sqlite(path, "PRAGMA user_version; SELECT count(*) FROM sqlite_master; SELECT group_concat(id || ':' || brief) FROM workloads;").out;

	// Two version-1 schemas (the M2 build and its first fix), the version-2 schema (477af98, the
	// last schema before routings and entries), the version-3 schema (de28132, routings without
	// an outcome) and the version-4 schema (1fe1b6e, routings without the hand's session root and
	// allocated agent id): each is an older file, refused the same way.
	for (const [rev, version] of [["94f06b9", 1], ["71a576e", 1], ["477af98", 2], ["de28132", 3], ["1fe1b6e", 4]] as const) {
		test(`review probe: a version-${version} ledger built from ${rev}:ledger/schema.sql is refused by open, init and the backup job`, () => {
			const dir = scratch(`n1-${rev}`);
			const path = join(dir, "ledger.db");
			const schema = Bun.spawnSync(["git", "-C", REPO, "show", `${rev}:ledger/schema.sql`], { stdout: "pipe", stderr: "pipe" });
			expect(schema.exitCode).toBe(0);
			expect(sqlite(path, schema.stdout.toString()).exitCode).toBe(0);
			expect(sqlite(path, `INSERT INTO workloads (id, brief, stakes, mode, created_by, created_at, changed_by, changed_at) VALUES ('wl-old', 'written under version ${version}', 'normal', 'autonomous', ${RAW_STAMPS});`).err).toBe("");
			const before = state(path);
			expect(before.split("\n")[0]).toBe(String(version));
			const refusal = [`ledger at ${realpathSync(path)} is schema version ${version}`, "predates the supported schema (version 6) and every version this module upgrades"];

			for (const opts of [{}, { create: true }]) {
				let error: unknown;
				try {
					Ledger.open(path, opts).close();
				} catch (e) {
					error = e;
				}
				expect((error as Error | undefined)?.constructor.name).toBe("LedgerSchemaVersionError");
				for (const text of refusal) expect(String(error)).toContain(text);
			}
			for (const name of ["init.ts", "backup.ts"]) {
				const r = script(name, path);
				expect({ name, exitCode: r.exitCode, out: r.out }).toEqual({ name, exitCode: 4, out: "" });
				for (const text of refusal) expect(r.err).toContain(text);
			}
			expect(state(path)).toBe(before);
			expect(existsSync(join(dir, "backups"))).toBe(false);
		});
	}

	// The file an upgrade-on-open would touch first: the version immediately below SCHEMA_VERSION,
	// built from the schema.sql that preceded the commit introducing the current version. Both are
	// found from history, so the next schema bump needs no edit here. The error class and the exit
	// code are deliberately not pinned: what is pinned is that nothing opens it and nothing changes it.
	test("review probe: a ledger at the version immediately below SCHEMA_VERSION, built from git history, is refused unchanged by open, init and the backup job", () => {
		const git = (...args: string[]) => {
			const r = Bun.spawnSync(["git", "-C", REPO, ...args], { stdout: "pipe", stderr: "pipe" });
			expect({ args, exitCode: r.exitCode }).toEqual({ args, exitCode: 0 });
			return r.stdout.toString();
		};
		const below = SCHEMA_VERSION - 1;
		const introducing = git("log", "--format=%H", "-G", `PRAGMA user_version = ${SCHEMA_VERSION};`, "--", "ledger/schema.sql").trim().split("\n").at(-1)!;
		expect(introducing).toMatch(/^[0-9a-f]{40}$/);
		const schema = git("show", `${introducing}^:ledger/schema.sql`);
		expect(schema).toContain(`PRAGMA user_version = ${below};`);

		const dir = scratch("n1-below");
		const path = join(dir, "ledger.db");
		expect(sqlite(path, schema).exitCode).toBe(0);
		expect(sqlite(path, `INSERT INTO workloads (id, brief, stakes, mode, created_by, created_at, changed_by, changed_at) VALUES ('wl-below', 'written under version ${below}', 'normal', 'autonomous', ${RAW_STAMPS});`).err).toBe("");
		const version = () => sqlite(path, "PRAGMA user_version;").out;
		const snapshot = () => ({
			version: version(),
			objects: sqlite(path, "SELECT name, sql FROM sqlite_master ORDER BY name;").out,
			rows: sqlite(path, "SELECT * FROM workloads ORDER BY id;").out,
			sha256: new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex"),
			files: readdirSync(dir).sort(),
		});
		const before = snapshot();
		expect(before.version).toBe(String(below));

		// Every outcome is collected before any is asserted, so a failure shows each actor's result
		// and the version it left behind.
		const outcomes: { actor: string; refused: boolean; out: string; versionAfter: string }[] = [];
		for (const opts of [{}, { create: true }, { readonly: true }]) {
			let refused = true;
			try {
				Ledger.open(path, opts).close();
				refused = false;
			} catch {}
			outcomes.push({ actor: `Ledger.open(${JSON.stringify(opts)})`, refused, out: "", versionAfter: version() });
		}
		for (const name of ["init.ts", "backup.ts"]) {
			const r = script(name, path);
			outcomes.push({ actor: name, refused: r.exitCode !== 0, out: r.out, versionAfter: version() });
		}
		expect(outcomes).toEqual(outcomes.map(({ actor }) => ({ actor, refused: true, out: "", versionAfter: String(below) })));
		expect(snapshot()).toEqual(before);
		expect(existsSync(join(dir, "backups"))).toBe(false);
	});

	test("an unknown version is refused as not the supported schema", () => {
		const l = fresh("n1-unknown");
		const path = l.path;
		l.close();
		sqlite(path, "PRAGMA user_version = 7;");
		expect(() => Ledger.open(path)).toThrow(`ledger at ${path} is schema version 7, which is not the supported schema (version 6)`);
		expect(script("init.ts", path).exitCode).toBe(4);
		expect(sqlite(path, "PRAGMA user_version;").out).toBe("7");
	});
});

describe("a nonpositive physical identity is refused, so ordinary writes keep working (N2)", () => {
	const WORKLOAD_COLS = "id, brief, stakes, mode, created_by, created_at, changed_by, changed_at";

	test("review probe: a workload with rowid -1, then an ordinary openWorkload", () => {
		const l = fresh("n2-rowid", { backup: false });
		for (const [clause, rowid] of [["INSERT", -1], ["INSERT OR REPLACE", 0], ["INSERT OR IGNORE", -1]] as const) {
			const r = sqlite(l.path, `${clause} INTO workloads (rowid, ${WORKLOAD_COLS}) VALUES (${rowid}, 'wl-negative', 'b', 'normal', 'autonomous', ${RAW_STAMPS});`);
			expect({ clause, exitCode: r.exitCode, err: r.err }).toMatchObject({ clause, exitCode: 1, err: expect.stringContaining("a ledger rowid is a positive integer") });
		}
		const w = l.openWorkload({ brief: "ordinary", stakes: "normal", mode: "autonomous", by: "orch-1" });
		expect(l.workload(w)?.status).toBe("open");
		expect(sqlite(l.path, "SELECT count(*) FROM workloads WHERE rowid <= 0; SELECT count(*) FROM workloads;").out).toBe("0\n1");
		l.close();
	});

	test("review probe: provenance seq -1, then an ordinary stakes update", () => {
		const l = fresh("n2-seq", { backup: false });
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch-1" });
		for (const seq of [-1, 0]) {
			const r = sqlite(l.path, `INSERT INTO provenance (seq, at, workload_id, lane_instance, tbl, row_id, action) VALUES (${seq}, ${RAW_NOW}, '${w}', 'raw', 'workloads', '${w}', 'insert');`);
			expect({ exitCode: r.exitCode, err: r.err }).toMatchObject({ exitCode: 1, err: expect.stringContaining("a provenance seq is a positive integer") });
		}
		// As the surface writes it: the stakes change with its `stakes: <stakes>` instruction, one transaction.
		l.write(() => {
			l.recordInstruction({ by: "orch-1", workloadId: w, author: "jo", channel: "surface", body: "stakes: production" });
			l.setStakes(w, { stakes: "production", by: "orch-1" });
		});
		expect(l.workload(w)?.stakes).toBe("production");
		expect(sqlite(l.path, "SELECT count(*) FROM provenance WHERE seq <= 0;").out).toBe("0");
		l.close();
	});

	test("an explicit rowid that is already taken is still refused as a replacement, and the row is unchanged", () => {
		const l = fresh("n2-replace", { backup: false });
		const w = l.openWorkload({ brief: "original", stakes: "normal", mode: "autonomous", by: "orch-1" });
		const r = sqlite(l.path, `INSERT OR REPLACE INTO workloads (rowid, ${WORKLOAD_COLS}) SELECT rowid, 'wl-forged', 'forged', 'normal', 'autonomous', ${RAW_STAMPS} FROM workloads WHERE id = '${w}';`);
		expect(r.err).toContain("ledger rows are never replaced");
		expect(sqlite(l.path, "SELECT group_concat(id || ':' || brief) FROM workloads;").out).toBe(`${w}:original`);
		l.close();
	});
});

describe("the backup job fails when a due copy fails; an ordinary open stays tolerant (N3)", () => {
	test("review probe: a 2020 copy plus an unwritable backup directory", () => {
		const dir = scratch("n3");
		const path = join(dir, "ledger.db");
		Ledger.open(path, { create: true }).close();
		Ledger.open(path, { clock: () => "2020-01-01T00:00:00.000Z" }).close(); // the open takes the 2020 copy
		const OLD = "ledger-2020-01-01T00-00-00.000Z.db";
		const found = (readdirSync(join(dir, "backups"), { recursive: true }) as string[]).filter((n) => n.endsWith(OLD));
		expect(found.length).toBe(1);
		const copyDir = dirname(join(dir, "backups", found[0]!));
		chmodSync(copyDir, 0o555);
		try {
			const writer = Bun.spawnSync(["bun", "-e", `
				import { Ledger } from ${JSON.stringify(join(REPO, "ledger", "src", "index.ts"))};
				const l = Ledger.open(${JSON.stringify(path)});
				console.log(l.openWorkload({ brief: "written while backups fail", stakes: "normal", mode: "autonomous", by: "o" }));
				l.close();
			`], { stdout: "pipe", stderr: "pipe" });
			expect(writer.exitCode).toBe(0);
			expect(writer.stdout.toString()).toMatch(/^wl-/);
			expect(writer.stderr.toString()).toContain("ledger: scheduled backup failed");

			const job = script("backup.ts", path);
			expect({ exitCode: job.exitCode, out: job.out }).toEqual({ exitCode: 1, out: "" });
			expect(job.err).toContain("ledger backup failed");
			expect(readdirSync(copyDir).filter((n) => n.endsWith(".db"))).toEqual([OLD]);
		} finally {
			chmodSync(copyDir, 0o755);
		}
		expect(script("backup.ts", path).out).toMatch(/^backup ok: took /);
	});
});

describe("a failed snapshot never leaves a file that counts as a copy (M2 third review, B1)", () => {
	/** Zero the first byte of the workloads table's root page, as the review's probe did. */
	const corruptWorkloadsPage = (path: string) => {
		const l = Ledger.open(path, { backupOnOpen: false });
		const page = l.db.query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_master WHERE name = 'workloads'").get()!.rootpage;
		const size = l.db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
		l.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		l.close();
		const bytes = readFileSync(path);
		bytes[(page - 1) * size] = 0;
		writeFileSync(path, bytes);
	};
	const namespaceOf = (path: string) => {
		const root = join(dirname(path), "backups");
		const [ns] = readdirSync(root);
		return join(root, ns!);
	};

	test("review probe: a malformed page; the job exits 1 twice, the old copy stays, and nothing else is left", () => {
		const dir = scratch("b1-malformed");
		const path = join(dir, "ledger.db");
		Ledger.open(path, { create: true }).close();
		Ledger.open(path, { clock: () => "2020-01-01T00:00:00.000Z" }).close(); // a good, aged copy
		const copyDir = namespaceOf(path);
		const before = readdirSync(copyDir).sort();
		expect(before).toEqual(["SOURCE", "ledger-2020-01-01T00-00-00.000Z.db"]);
		corruptWorkloadsPage(path);

		for (const attempt of [1, 2]) {
			const job = script("backup.ts", path);
			expect({ attempt, exitCode: job.exitCode, out: job.out }).toEqual({ attempt, exitCode: 1, out: "" });
			expect(job.err).toContain("ledger backup failed");
			expect(readdirSync(copyDir).sort()).toEqual(before);
		}
		const open = Bun.spawnSync(["bun", "-e", `
			import { Ledger } from ${JSON.stringify(join(REPO, "ledger", "src", "index.ts"))};
			Ledger.open(${JSON.stringify(path)}).close();
		`], { stdout: "pipe", stderr: "pipe" });
		expect(open.exitCode).toBe(0);
		expect(open.stderr.toString()).toContain("ledger: scheduled backup failed");
		expect(readdirSync(copyDir).sort()).toEqual(before);
	});

	test("an empty file with a copy name does not satisfy the due check; it is set aside and a real copy taken", () => {
		const dir = scratch("b1-empty");
		const path = join(dir, "ledger.db");
		Ledger.open(path, { create: true }).close();
		expect(script("backup.ts", path).exitCode).toBe(0);
		const copyDir = namespaceOf(path);
		const [good] = readdirSync(copyDir).filter((n) => n.startsWith("ledger-"));
		// The good copy is aged; a newer, empty one sits beside it, as the old module left behind.
		const aged = "ledger-2020-01-01T00-00-00.000Z.db";
		renameSync(join(copyDir, good!), join(copyDir, aged));
		const empty = `ledger-${new Date(Date.now() - 3_600_000).toISOString().replace(/:/g, "-")}`;
		writeFileSync(join(copyDir, empty + ".db"), "");

		const job = script("backup.ts", path);
		expect(job.exitCode).toBe(0);
		expect(job.out).toMatch(/^backup ok: took /);
		expect(job.err).toContain(`/${empty}.db as `);
		expect(job.err).toContain(`/${empty}.db.invalid, not a complete copy (empty file)`);
		const taken = job.out.replace(/^backup ok: took /, "").trim();
		expect(readdirSync(copyDir).sort()).toEqual(["SOURCE", aged, `${empty}.db.invalid`, basename(taken)].sort());
		const check = Bun.spawnSync([SQLITE3, taken, "PRAGMA user_version; PRAGMA integrity_check;"]);
		expect(check.stdout.toString().trim().split("\n")).toEqual(["6", "ok"]);
	});
});

describe("a killed writer's temporary snapshot is reclaimed; a live writer's is not (M2 fourth review, S1)", () => {
	test("review probe: SIGKILL right after the link; the next due copy removes the orphan and keeps a live pid's", () => {
		const dir = scratch("s1-crash");
		const path = join(dir, "ledger.db");
		Ledger.open(path, { create: true, backupOnOpen: false }).close();
		// The review's fault injection: the real link runs, then the writer dies before its `finally`.
		const worker = join(dir, "crash-worker.ts");
		writeFileSync(worker, `
			import * as fs from "node:fs";
			import { mock } from "bun:test";
			const realLink = fs.linkSync;
			mock.module("node:fs", () => ({ ...fs, linkSync: (src: string, dst: string) => { realLink(src, dst); process.kill(process.pid, "SIGKILL"); } }));
			// Dynamic on purpose: the module must load after the mock is installed.
			const { Ledger } = await import(${JSON.stringify(join(REPO, "ledger", "src", "index.ts"))});
			Ledger.open(${JSON.stringify(path)}, { backupOnOpen: false, clock: () => "2026-09-28T00:00:00.000Z" }).backupIfDue();
		`);
		const crash = Bun.spawnSync(["bun", "run", worker], { stdout: "pipe", stderr: "pipe" });
		expect(crash.signalCode).toBe("SIGKILL");
		const l = Ledger.open(path, { backupOnOpen: false, backup: { keep: 1 }, clock: () => "2026-09-30T00:00:00.000Z" });
		const copyDir = l.backupDir!;
		const temps = () => readdirSync(copyDir).filter((n) => n.endsWith(".tmp"));
		const [orphan] = temps();
		expect(orphan).toMatch(new RegExp(`^\\.ledger-2026-09-28T00-00-00\\.000Z\\.db\\.${crash.pid}-[0-9a-z]+\\.tmp$`));
		// A writer that is still running: its pid is alive, so its temporary file must survive.
		const live = Bun.spawn(["sleep", "30"]);
		const inProgress = `.ledger-2026-09-30T00-00-00.000Z.db.${live.pid}-inprogress.tmp`;
		writeFileSync(join(copyDir, inProgress), "in progress");
		try {
			const taken = l.backupIfDue();
			expect(taken).toBe(join(copyDir, "ledger-2026-09-30T00-00-00.000Z.db"));
			expect(temps()).toEqual([inProgress]);
			expect(readdirSync(copyDir).sort()).toEqual(["SOURCE", inProgress, basename(taken!)].sort());
		} finally {
			live.kill();
			l.close();
		}
	});
});

describe("a set-aside copy is never replaced by a later one with the same name (M2 fourth review, N1)", () => {
	test("review probe: one timestamp, invalid twice; both artifacts are kept as .invalid and .invalid.2", () => {
		const l = fresh("n1-collision", { backupOnOpen: false, clock: () => "2026-09-28T00:00:00.000Z" });
		const copy = l.backupIfDue()!;
		writeFileSync(copy, "first invalid content");
		expect(l.backupIfDue()).toBe(copy);
		writeFileSync(copy, "second invalid content");
		expect(l.backupIfDue()).toBe(copy);
		l.close();
		expect(readFileSync(`${copy}.invalid`, "utf8")).toBe("first invalid content");
		expect(readFileSync(`${copy}.invalid.2`, "utf8")).toBe("second invalid content");
		expect(readdirSync(dirname(copy)).sort()).toEqual(
			["SOURCE", basename(copy), `${basename(copy)}.invalid`, `${basename(copy)}.invalid.2`].sort());
	});
});

describe("each ledger's copies are its own, even in a shared backup directory (N4)", () => {
	const workloadIds = (copyPath: string) => {
		const db = new Database(copyPath, { readonly: true });
		try {
			return db.query<{ id: string }, []>("SELECT id FROM workloads ORDER BY id").all().map((r) => r.id);
		} finally {
			db.close();
		}
	};

	for (const shared of [false, true]) {
		test(`review probe: a.db and b.db in one directory${shared ? ", both configured to one backup dir" : ""}; each copy holds its own ledger`, () => {
			const dir = scratch("n4");
			const backup = shared ? { dir: join(dir, "shared-backups") } : {};
			for (const name of ["a", "b"]) {
				const l = Ledger.open(join(dir, `${name}.db`), { create: true, backup });
				l.openWorkload({ brief: `ledger ${name}`, stakes: "normal", mode: "autonomous", by: "o", id: `wl-${name}` });
				l.close();
				Ledger.open(join(dir, `${name}.db`), { backup }).close(); // the open takes this ledger's due copy
			}
			for (const name of ["a", "b"]) {
				const l = Ledger.open(join(dir, `${name}.db`), { backup });
				const own = l.backups();
				l.close();
				expect(own.length).toBe(1);
				expect(workloadIds(own[0]!.path)).toEqual([`wl-${name}`]);
			}
		});
	}

	test("a namespace directory whose SOURCE names another ledger is refused, not adopted", () => {
		const l = fresh("n4-source");
		l.backupIfDue(true);
		writeFileSync(join(dirname(l.backups()[0]!.path), "SOURCE"), "/somewhere/else.db\n");
		expect(() => l.backups()).toThrow(`holds copies of /somewhere/else.db, not of ${l.path}`);
		expect(() => l.backupIfDue(true)).toThrow("holds copies of /somewhere/else.db");
		l.close();
	});
});

describe("initialization honours busyRetries (S4)", () => {
	/** Another process creates the file, turns on WAL and holds BEGIN IMMEDIATE for `ms`. */
	async function holdFreshFile(path: string, ms: number) {
		const holder = Bun.spawn(["bun", "-e", `
			import { Database } from "bun:sqlite";
			const db = new Database(${JSON.stringify(path)});
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("BEGIN IMMEDIATE");
			console.log("locked");
			Bun.sleepSync(${ms});
			db.exec("COMMIT");
		`], { stdout: "pipe" });
		const reader = holder.stdout.getReader();
		await reader.read();
		reader.releaseLock();
		return holder;
	}

	test("review probe: opening an uninitialized file under another writer's lock waits it out and applies the schema", async () => {
		const path = join(scratch("s4-wait"), "ledger.db");
		const holder = await holdFreshFile(path, 400);
		const l = Ledger.open(path, { create: true, busyTimeoutMs: 0, busyRetries: 8 });
		expect(l.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(6);
		expect(l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "o" })).toMatch(/^wl-/);
		l.close();
		expect(await holder.exited).toBe(0);
	});

	test("with no retries left the open fails as SQLITE_BUSY and leaves the file uninitialized, not half-built", async () => {
		const path = join(scratch("s4-fail"), "ledger.db");
		const holder = await holdFreshFile(path, 300);
		let error: unknown;
		try {
			Ledger.open(path, { create: true, busyTimeoutMs: 0, busyRetries: 0 }).close();
		} catch (e) {
			error = e;
		}
		expect(error).toMatchObject({ code: expect.stringMatching(/^SQLITE_BUSY/) });
		expect(await holder.exited).toBe(0);
		const sqlite3 = existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3";
		const state = Bun.spawnSync([sqlite3, path, "PRAGMA user_version; SELECT count(*) FROM sqlite_master;"]);
		expect(state.stdout.toString().trim().split("\n")).toEqual(["0", "0"]);
		Ledger.open(path, { create: true }).close();
	});

	test("four processes creating the same new ledger at once all succeed", async () => {
		const path = join(scratch("s4-race"), "ledger.db");
		const script = `
			import { Ledger } from ${JSON.stringify(join(REPO, "ledger", "src", "index.ts"))};
			Ledger.open(${JSON.stringify(path)}, { create: true, busyTimeoutMs: 0, busyRetries: 8 }).close();
		`;
		const procs = Array.from({ length: 4 }, () => Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" }));
		const codes = await Promise.all(procs.map((p) => p.exited));
		const errors = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
		expect({ codes, errors }).toEqual({ codes: [0, 0, 0, 0], errors: ["", "", "", ""] });
	});
});

describe("schema v3-v5: routings and entries through the module", () => {
	const routing = (w: string, s: string) => ({
		workloadId: w, sliceId: s, sessionRoot: "/tmp/lane", agentId: "hand-1" as string | null, kind: "change-small" as const, confidence: 0.42,
		probabilities: { locate: 0.1, understand: 0.2, "change-small": 0.42, "change-large": 0.18, judge: 0.1 },
		classifiedTier: "standard" as const, pullUpTo: "strong" as const, stakes: "throwaway" as const,
		pullDownTo: "standard" as const, tier: "standard" as const, models: ["anthropic/a", "openai/b"],
		judgeModel: "typesafe/jev", outcome: "ran" as const, ranModels: ["anthropic/a"], by: "lane-1",
	});

	test("recordRouting round-trips every column, stores model = models[0], and logs provenance with the outcome", () => {
		const l = fresh("v4-routing", { backup: false, clock: steppingClock("2026-09-28T20:00:00.000Z") });
		const w = l.openWorkload({ brief: "b", stakes: "throwaway", mode: "autonomous", by: "orch-1" });
		const s = l.addSlice({ workloadId: w, task: "t", doneCondition: "d", inputs: "i", by: "lane-1" });
		const r1 = l.recordRouting({ ...routing(w, s), spawnKey: "0-Scout", agentId: "0-Scout-2" });
		const r2 = l.recordRouting({ ...routing(w, s), agentId: "hand-2", pullUpTo: null, pullDownTo: null, stakes: null, classifiedTier: "fast", tier: "fast", models: ["p/fast"], outcome: "refused-out-of-row", ranModels: ["p/fast", "x/off-row"] });
		const r3 = l.recordRouting({ ...routing(w, s), agentId: null, models: [], outcome: "refused-no-usable-model", ranModels: null });
		const r4 = l.recordRouting({ ...routing(w, s), agentId: "hand-4", outcome: "refused-model-unknown", ranModels: null });
		expect(r1).toMatch(/^rt-/);
		const rows = l.routings(w);
		expect(rows.map((r) => r.id)).toEqual([r1, r2, r3, r4]);
		expect(rows[0]).toEqual({
			id: r1, workload_id: w, slice_id: s, spawn_key: "0-Scout", session_root: "/tmp/lane", agent_id: "0-Scout-2", kind: "change-small", confidence: 0.42,
			probabilities: JSON.stringify(routing(w, s).probabilities), classified_tier: "standard", pull_up_to: "strong",
			stakes: "throwaway", pull_down_to: "standard", tier: "standard", models: '["anthropic/a","openai/b"]',
			model: "anthropic/a", judge_model: "typesafe/jev", outcome: "ran", ran_models: '["anthropic/a"]',
			created_by: "lane-1", created_at: "2026-09-28T20:00:00.002Z",
		});
		expect(rows[1]).toMatchObject({ spawn_key: null, pull_up_to: null, stakes: null, pull_down_to: null, model: "p/fast", outcome: "refused-out-of-row", ran_models: '["p/fast","x/off-row"]' });
		expect(rows[2]).toMatchObject({ agent_id: null, models: "[]", model: null, outcome: "refused-no-usable-model", ran_models: null });
		expect(rows[3]).toMatchObject({ model: "anthropic/a", outcome: "refused-model-unknown", ran_models: null });
		expect(l.provenance(w).filter((p) => p.tbl === "routings").map((p) => [p.row_id, p.lane_instance, p.detail])).toEqual([
			[r1, "lane-1", "change-small standard up strong down standard -> standard anthropic/a: ran on anthropic/a"],
			[r2, "lane-1", "change-small fast -> fast p/fast: refused-out-of-row on p/fast, x/off-row"],
			[r3, "lane-1", "change-small standard up strong down standard -> standard (no usable model): refused-no-usable-model"],
			[r4, "lane-1", "change-small standard up strong down standard -> standard anthropic/a: refused-model-unknown"],
		]);
		l.close();
	});

	test("recordRouting is refused by the file for a closed workload, a slice of another workload, or an outcome its row or ran list contradicts", () => {
		const l = fresh("v4-routing-refused", { backup: false });
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "o" });
		const s = l.addSlice({ workloadId: w, task: "t", doneCondition: "d", inputs: "i", by: "o" });
		const w2 = l.openWorkload({ brief: "b2", stakes: "normal", mode: "autonomous", by: "o" });
		const s2 = l.addSlice({ workloadId: w2, task: "t", doneCondition: "d", inputs: "i", by: "o" });
		expect(() => l.recordRouting(routing(w, s2))).toThrow("the slice belongs to another workload");
		expect(() => l.recordRouting({ ...routing(w, s), models: [] })).toThrow("CHECK constraint failed");
		expect(() => l.recordRouting({ ...routing(w, s), agentId: null, outcome: "refused-no-usable-model", ranModels: null })).toThrow("CHECK constraint failed");
		// A hand that ran has its allocated agent id; a refused spawn has none.
		expect(() => l.recordRouting({ ...routing(w, s), agentId: null })).toThrow("CHECK constraint failed");
		expect(() => l.recordRouting({ ...routing(w, s), models: [], outcome: "refused-no-usable-model", ranModels: null })).toThrow("CHECK constraint failed");
		expect(() => l.recordRouting({ ...routing(w, s), ranModels: null })).toThrow("CHECK constraint failed");
		expect(() => l.recordRouting({ ...routing(w, s), outcome: "refused-out-of-row", ranModels: [] })).toThrow("CHECK constraint failed");
		expect(() => l.recordRouting({ ...routing(w, s), outcome: "refused-model-unknown" })).toThrow("CHECK constraint failed");
		expect(() => l.recordRouting({ ...routing(w, s), confidence: 1.5 })).toThrow("CHECK constraint failed");
		l.cancelSlice(s2, { by: "o" });
		l.closeWorkload(w2, { by: "o" });
		expect(() => l.recordRouting(routing(w2, s2))).toThrow("no open workload with that id");
		expect(l.routings(w)).toEqual([]);
		expect(l.routings(w2)).toEqual([]);
		l.close();
	});

	test("S1: recordRouting refuses a model list that names no model — null, object, blank, or a repeated ran model", () => {
		const l = fresh("v4-routing-s1", { backup: false });
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "o" });
		const s = l.addSlice({ workloadId: w, task: "t", doneCondition: "d", inputs: "i", by: "o" });
		const refusal = "routing models and ran_models must be JSON arrays of distinct non-blank model names";
		const bad = <T>(v: T) => v as unknown as string[];
		expect(() => l.recordRouting({ ...routing(w, s), ranModels: bad([null]) })).toThrow(refusal);
		expect(() => l.recordRouting({ ...routing(w, s), ranModels: bad([{}]) })).toThrow(refusal);
		expect(() => l.recordRouting({ ...routing(w, s), ranModels: [" "] })).toThrow(refusal);
		expect(() => l.recordRouting({ ...routing(w, s), ranModels: ["\t"] })).toThrow(refusal);
		expect(() => l.recordRouting({ ...routing(w, s), models: ["\n", "openai/b"] })).toThrow(refusal);
		expect(() => l.recordRouting({ ...routing(w, s), ranModels: ["anthropic/a", "anthropic/a"] })).toThrow(refusal);
		expect(() => l.recordRouting({ ...routing(w, s), outcome: "refused-out-of-row", ranModels: bad([null]) })).toThrow(refusal);
		expect(() => l.recordRouting({ ...routing(w, s), models: bad([null, "openai/b"]) })).toThrow(refusal);
		expect(l.routings(w)).toEqual([]);
		// The v4 equivalence stands (ruling, triad row 10): a refusal row keeps the off-row model it read.
		l.recordRouting({ ...routing(w, s), outcome: "refused-out-of-row", ranModels: ["x/off-row"] });
		expect(l.routings(w).map((r) => [r.outcome, r.ran_models])).toEqual([["refused-out-of-row", '["x/off-row"]']]);
		l.close();
	});

	test("recordEntry/entries: kind filter, optional slice, oldest first, provenance logged, refused on a closed workload", () => {
		const l = fresh("v3-entries", { backup: false, clock: steppingClock("2026-09-28T21:00:00.000Z") });
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "user-driven", by: "orch-1" });
		const s = l.addSlice({ workloadId: w, task: "t", doneCondition: "d", inputs: "i", by: "lane-1" });
		const e1 = l.recordEntry({ workloadId: w, kind: "wake-read", body: "read in-flight", by: "lane-1" });
		const e2 = l.recordEntry({ workloadId: w, sliceId: s, kind: "assumption", body: "assume WAL", by: "lane-1" });
		const e3 = l.recordEntry({ workloadId: w, kind: "wake-read", body: "read again", by: "lane-1" });
		expect(e1).toMatch(/^en-/);
		expect(l.entries(w).map((e) => e.id)).toEqual([e1, e2, e3]);
		expect(l.entries(w, "wake-read").map((e) => e.id)).toEqual([e1, e3]);
		expect(l.entries(w, "reserved-request")).toEqual([]);
		expect(l.entries(w, "assumption")[0]).toEqual({
			id: e2, workload_id: w, slice_id: s, kind: "assumption", body: "assume WAL", created_by: "lane-1", created_at: "2026-09-28T21:00:00.003Z",
		});
		expect(l.provenance(w).filter((p) => p.tbl === "entries").map((p) => [p.row_id, p.detail])).toEqual([
			[e1, "wake-read"], [e2, "assumption"], [e3, "wake-read"],
		]);
		// @ts-expect-error: a kind outside the four is refused by the file too
		expect(() => l.recordEntry({ workloadId: w, kind: "note", body: "x", by: "lane-1" })).toThrow("CHECK constraint failed");
		l.completeSlice(s, { artifact: "a.log", by: "lane-1" });
		l.closeWorkload(w, { by: "orch-1" });
		expect(() => l.recordEntry({ workloadId: w, kind: "mode-effective", body: "x", by: "lane-1" })).toThrow("no open workload with that id");
		expect(l.entries(w).length).toBe(3);
		l.close();
	});
});