// The file refuses illegal writes by itself: every case here is a raw `sqlite3` CLI write with no
// module in the path (the CLI's connection runs foreign_keys=0, like any foreign tool).
// Mirrors the prototype's ledger-lifecycle/sqlite/logs/11-foreign-write.log.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/index";

const SQLITE3 = process.env.SQLITE3 ?? (existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3");
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
/** A correctly stamped update: fresh actor and time, rev bumped. */
const STAMP = `changed_by = 'tool:sqlite3', changed_at = ${NOW}, rev = rev + 1`;

let dbPath: string;
const ids: Record<string, string> = {};

function raw(sql: string): { exitCode: number; stdout: string; stderr: string } {
	const r = Bun.spawnSync([SQLITE3, dbPath, sql], { stdout: "pipe", stderr: "pipe" });
	return { exitCode: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/** Everything a refused write could have touched, as one comparable string. */
function snapshot(): string {
	return ["workloads", "slices", "messages", "instructions", "questions", "routings", "entries", "provenance"]
		.map((t) => raw(`SELECT * FROM ${t} ORDER BY rowid;`).stdout).join("\n--\n");
}

beforeAll(() => {
	const dir = mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "ledger-raw-"));
	dbPath = join(dir, "ledger.db");
	const l = Ledger.open(dbPath, { create: true });
	const by = "orch-1";
	ids.w = l.openWorkload({ brief: "raw-write fixture", stakes: "normal", mode: "autonomous", by });
	l.claimWorkload(ids.w, { holder: "lane-A", leaseMs: 3_600_000, by: "lane-A" });
	ids.sOpen = l.addSlice({ workloadId: ids.w, task: "t", doneCondition: "d", inputs: "i", by: "lane-A" });
	ids.sDone = l.addSlice({ workloadId: ids.w, task: "t", doneCondition: "d", inputs: "i", by: "lane-A" });
	l.completeSlice(ids.sDone, { artifact: "logs/run.log", by: "lane-A" });
	ids.sCancelled = l.addSlice({ workloadId: ids.w, task: "t", doneCondition: "d", inputs: "i", by: "lane-A" });
	l.cancelSlice(ids.sCancelled, { by: "lane-A" });
	ids.sPaused = l.addSlice({ workloadId: ids.w, task: "t", doneCondition: "d", inputs: "i", by: "lane-A" });
	ids.qOpen = l.raiseQuestion({ workloadId: ids.w, sliceId: ids.sPaused, body: "which?", options: ["a", "b"], by: "lane-A" });
	ids.sAnswered = l.addSlice({ workloadId: ids.w, task: "t", doneCondition: "d", inputs: "i", by: "lane-A" });
	ids.qAnswered = l.raiseQuestion({ workloadId: ids.w, sliceId: ids.sAnswered, body: "which?", options: ["a", "b"], by: "lane-A" });
	ids.iAnswer = l.answerQuestion(ids.qAnswered, { answer: "a", author: "jo", channel: "surface", by: by });
	const msg = () => l.enqueue({ workloadId: ids.w, sender: "orchestrator", recipient: "lane-A", body: "m", by });
	ids.mHeld = msg();
	ids.mDelivered = msg();
	l.advanceMessage(ids.mDelivered, "delivered", { by: "lane-A" });
	ids.mConsumed = msg();
	l.advanceMessage(ids.mConsumed, "delivered", { by: "lane-A" });
	l.advanceMessage(ids.mConsumed, "consumed", { by: "lane-A" });
	ids.mActed = msg();
	for (const s of ["delivered", "consumed", "acted-on"] as const) l.advanceMessage(ids.mActed, s, { by: "lane-A" });
	ids.mLegal = msg();
	ids.sDeferred = l.addSlice({ workloadId: ids.w, task: "t", doneCondition: "d", inputs: "i", by: "lane-A" });
	ids.w2 = l.openWorkload({ brief: "other workload", stakes: "throwaway", mode: "user-driven", by });
	ids.s2 = l.addSlice({ workloadId: ids.w2, task: "t", doneCondition: "d", inputs: "i", by: "lane-B" });
	ids.rt = l.recordRouting({
		workloadId: ids.w, sliceId: ids.sOpen, spawnKey: "0-Hand", sessionRoot: "/tmp/lane-A", agentId: "0-Hand", kind: "locate", confidence: 0.9,
		probabilities: { locate: 0.9, understand: 0.1 }, classifiedTier: "fast", tier: "fast",
		models: ["p/fast"], judgeModel: "typesafe/jev", outcome: "ran", ranModels: ["p/fast"], by: "lane-A",
	});
	ids.en = l.recordEntry({ workloadId: ids.w, kind: "wake-read", body: "read in-flight", by: "lane-A" });
	ids.wClosed = l.openWorkload({ brief: "closed workload", stakes: "throwaway", mode: "autonomous", by });
	l.closeWorkload(ids.wClosed, { by });
	l.close();
});

// [name, table, SQL, the refusal text the file raises]
const cases: [string, string, () => string, string][] = [
	// messages: held -> delivered -> consumed -> acted-on, one step, never back
	["message held->consumed (skip)", "messages", () => `UPDATE messages SET state = 'consumed', ${STAMP} WHERE id = '${ids.mHeld}';`, "illegal message transition"],
	["message held->acted-on (skip)", "messages", () => `UPDATE messages SET state = 'acted-on', ${STAMP} WHERE id = '${ids.mHeld}';`, "illegal message transition"],
	["message delivered->held (backward)", "messages", () => `UPDATE messages SET state = 'held', ${STAMP} WHERE id = '${ids.mDelivered}';`, "illegal message transition"],
	["message consumed->held (backward)", "messages", () => `UPDATE messages SET state = 'held', ${STAMP} WHERE id = '${ids.mConsumed}';`, "illegal message transition"],
	["message acted-on->consumed (backward)", "messages", () => `UPDATE messages SET state = 'consumed', ${STAMP} WHERE id = '${ids.mActed}';`, "illegal message transition"],
	["message enqueued at a later state", "messages", () => `INSERT INTO messages (id, workload_id, sender, recipient, body, state, created_by, created_at, changed_by, changed_at) VALUES ('msg-skip', '${ids.w}', 'x', 'y', 'b', 'acted-on', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "message must be enqueued in state held"],
	["message transition without a stamp", "messages", () => `UPDATE messages SET state = 'delivered' WHERE id = '${ids.mHeld}';`, "unstamped update"],
	["message body rewritten", "messages", () => `UPDATE messages SET body = 'forged', ${STAMP} WHERE id = '${ids.mHeld}';`, "only state and its stamp change on a message"],
	["message into a closed workload", "messages", () => `INSERT INTO messages (id, workload_id, sender, recipient, body, created_by, created_at, changed_by, changed_at) VALUES ('msg-closed', '${ids.wClosed}', 'x', 'y', 'b', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "no open workload with that id"],
	["message orphan (unknown workload, foreign_keys off)", "messages", () => `INSERT INTO messages (id, workload_id, sender, recipient, body, created_by, created_at, changed_by, changed_at) VALUES ('msg-ghost', 'wl-ghost', 'x', 'y', 'b', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "no open workload with that id"],
	["message on a slice of another workload", "messages", () => `INSERT INTO messages (id, workload_id, slice_id, sender, recipient, body, created_by, created_at, changed_by, changed_at) VALUES ('msg-cross', '${ids.w}', '${ids.s2}', 'x', 'y', 'b', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "the slice belongs to another workload"],
	// slices
	["slice open->done without an artifact", "slices", () => `UPDATE slices SET state = 'done', ${STAMP} WHERE id = '${ids.sOpen}';`, "CHECK constraint failed"],
	["slice done->open (reopen)", "slices", () => `UPDATE slices SET state = 'open', artifact = NULL, ${STAMP} WHERE id = '${ids.sDone}';`, "illegal slice transition"],
	["slice cancelled->open (reopen)", "slices", () => `UPDATE slices SET state = 'open', ${STAMP} WHERE id = '${ids.sCancelled}';`, "illegal slice transition"],
	["slice paused->done (skip the answer)", "slices", () => `UPDATE slices SET state = 'done', artifact = 'x', ${STAMP} WHERE id = '${ids.sPaused}';`, "illegal slice transition"],
	["slice open->paused with no open question", "slices", () => `UPDATE slices SET state = 'paused', ${STAMP} WHERE id = '${ids.sOpen}';`, "a slice pauses only on an open question"],
	["slice paused->open while its question is open", "slices", () => `UPDATE slices SET state = 'open', ${STAMP} WHERE id = '${ids.sPaused}';`, "slice has an open question"],
	["slice paused->cancelled while its question is open", "slices", () => `UPDATE slices SET state = 'cancelled', ${STAMP} WHERE id = '${ids.sPaused}';`, "slice has an open question"],
	["slice created already done", "slices", () => `INSERT INTO slices (id, workload_id, task, done_condition, inputs, state, artifact, created_by, created_at, changed_by, changed_at) VALUES ('sl-born-done', '${ids.w}', 't', 'd', 'i', 'done', 'x', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "a slice is created in state open"],
	["slice added to a closed workload", "slices", () => `INSERT INTO slices (id, workload_id, task, done_condition, inputs, created_by, created_at, changed_by, changed_at) VALUES ('sl-late', '${ids.wClosed}', 't', 'd', 'i', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "no open workload with that id"],
	["slice done-condition rewritten", "slices", () => `UPDATE slices SET done_condition = 'easier', ${STAMP} WHERE id = '${ids.sOpen}';`, "never change"],
	// workloads
	["workload closed->open (reopen)", "workloads", () => `UPDATE workloads SET status = 'open', closed_at = NULL, ${STAMP} WHERE id = '${ids.wClosed}';`, "illegal workload transition"],
	["workload closed with open slices and an open question", "workloads", () => `UPDATE workloads SET status = 'closed', closed_at = ${NOW}, holder = NULL, holder_lease_until = NULL, ${STAMP} WHERE id = '${ids.w}';`, "cannot close a workload"],
	["workload lane steal under a live lease", "workloads", () => `UPDATE workloads SET holder = 'lane-B', ${STAMP} WHERE id = '${ids.w}';`, "live lease"],
	["workload opened already closed", "workloads", () => `INSERT INTO workloads (id, brief, stakes, mode, status, closed_at, created_by, created_at, changed_by, changed_at) VALUES ('wl-born-closed', 'b', 'normal', 'autonomous', 'closed', ${NOW}, 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "a workload is opened in status open"],
	["workload mode flipped without a mode-flip instruction", "workloads", () => `UPDATE workloads SET mode = 'user-driven', ${STAMP} WHERE id = '${ids.w}';`, "a mode flip needs a mode-flip instruction"],
	["workload brief rewritten", "workloads", () => `UPDATE workloads SET brief = 'forged', ${STAMP} WHERE id = '${ids.w}';`, "never change"],
	// The stakes instruction is recorded first so the CHECK, not the instruction trigger, is what refuses; the
	// transaction is never committed, so the instruction goes when the connection does.
	["workload stakes outside the three levels", "workloads", () => `BEGIN; INSERT INTO instructions (id, workload_id, kind, channel, author, body, created_by, created_at) VALUES ('in-yolo', '${ids.w}', 'instruction', 'surface', 'jo', 'stakes: yolo', 'tool:sqlite3', ${NOW}); UPDATE workloads SET stakes = 'yolo', ${STAMP} WHERE id = '${ids.w}';`, "CHECK constraint failed"],
	["workload stakes changed without a stakes instruction (v6)", "workloads", () => `UPDATE workloads SET stakes = 'production', ${STAMP} WHERE id = '${ids.w}';`, "a stakes change needs a \"stakes: <stakes>\" instruction"],
	["closed workload restamped (v6)", "workloads", () => `UPDATE workloads SET ${STAMP} WHERE id = '${ids.wClosed}';`, "a closed workload is final"],
	["done slice artifact rewritten (v6)", "slices", () => `UPDATE slices SET artifact = 'forged.log', ${STAMP} WHERE id = '${ids.sDone}';`, "a done or cancelled slice is final"],
	["cancelled slice restamped (v6)", "slices", () => `UPDATE slices SET ${STAMP} WHERE id = '${ids.sCancelled}';`, "a done or cancelled slice is final"],
	["acted-on message restamped (v6)", "messages", () => `UPDATE messages SET ${STAMP} WHERE id = '${ids.mActed}';`, "an acted-on message is final"],
	// questions
	["question open->answered with no answer instruction", "questions", () => `UPDATE questions SET state = 'answered', resolved_by = 'in-fake', ${STAMP} WHERE id = '${ids.qOpen}';`, "a question is resolved only by an answer or withdrawal instruction naming it"],
	["question open->withdrawn by an answer instruction for another question", "questions", () => `UPDATE questions SET state = 'withdrawn', resolved_by = '${ids.iAnswer}', ${STAMP} WHERE id = '${ids.qOpen}';`, "a question is resolved only by an answer or withdrawal instruction naming it"],
	["question answered->open (reopen)", "questions", () => `UPDATE questions SET state = 'open', resolved_by = NULL, ${STAMP} WHERE id = '${ids.qAnswered}';`, "illegal question transition"],
	["question with fewer than two options", "questions", () => `INSERT INTO questions (id, workload_id, slice_id, body, options, created_by, created_at, changed_by, changed_at) VALUES ('q-one', '${ids.w}', '${ids.sOpen}', 'b', '["only"]', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "CHECK constraint failed"],
	["question on a slice of another workload", "questions", () => `INSERT INTO questions (id, workload_id, slice_id, body, options, created_by, created_at, changed_by, changed_at) VALUES ('q-cross', '${ids.w}', '${ids.s2}', 'b', '["a","b"]', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "a question needs an open workload"],
	["question on a done slice", "questions", () => `INSERT INTO questions (id, workload_id, slice_id, body, options, created_by, created_at, changed_by, changed_at) VALUES ('q-done', '${ids.w}', '${ids.sDone}', 'b', '["a","b"]', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "a question needs an open workload"],
	["question options rewritten after raising", "questions", () => `UPDATE questions SET options = '["c","d"]', ${STAMP} WHERE id = '${ids.qOpen}';`, "keeps its id, slice, text and options"],
	// instructions
	["answer instruction for an already answered question", "instructions", () => `INSERT INTO instructions (id, workload_id, kind, question_id, channel, author, body, created_by, created_at) VALUES ('in-late', '${ids.w}', 'answer', '${ids.qAnswered}', 'surface', 'jo', 'b', 'tool:sqlite3', ${NOW});`, "answer or withdrawal must name an open question"],
	["answer instruction naming no question", "instructions", () => `INSERT INTO instructions (id, workload_id, kind, channel, author, body, created_by, created_at) VALUES ('in-bare', '${ids.w}', 'answer', 'surface', 'jo', 'b', 'tool:sqlite3', ${NOW});`, "CHECK constraint failed"],
	["instruction rewritten", "instructions", () => `UPDATE instructions SET body = 'forged' WHERE id = '${ids.iAnswer}';`, "instructions are append-only"],
	["instruction deleted", "instructions", () => `DELETE FROM instructions WHERE id = '${ids.iAnswer}';`, "ledger rows are never deleted"],
	// provenance
	["provenance row deleted", "provenance", () => "DELETE FROM provenance WHERE seq = 1;", "provenance is append-only"],
	["provenance row rewritten", "provenance", () => "UPDATE provenance SET lane_instance = 'someone-else' WHERE seq = 1;", "provenance is append-only"],
	["provenance row for an unknown workload", "provenance", () => `INSERT INTO provenance (at, workload_id, lane_instance, tbl, row_id, action) VALUES (${NOW}, 'wl-ghost', 'tool:sqlite3', 'workloads', 'wl-ghost', 'insert');`, "provenance must name an existing workload"],
	["row inserted with no lane instance (NULL created_by)", "provenance", () => `INSERT INTO workloads (id, brief, stakes, mode, created_by, created_at, changed_by, changed_at) VALUES ('wl-anon', 'b', 'normal', 'autonomous', NULL, ${NOW}, NULL, ${NOW});`, "NOT NULL constraint failed: workloads.created_by"],
	["row inserted with a blank lane instance", "provenance", () => `INSERT INTO workloads (id, brief, stakes, mode, created_by, created_at, changed_by, changed_at) VALUES ('wl-blank', 'b', 'normal', 'autonomous', '  ', ${NOW}, '  ', ${NOW});`, "CHECK constraint failed"],
	["row inserted with no time", "provenance", () => `INSERT INTO workloads (id, brief, stakes, mode, created_by, changed_by) VALUES ('wl-notime', 'b', 'normal', 'autonomous', 'x', 'x');`, "NOT NULL constraint failed: workloads.created_at"],
	["row inserted with a non-ISO time", "provenance", () => `INSERT INTO workloads (id, brief, stakes, mode, created_by, created_at, changed_by, changed_at) VALUES ('wl-badtime', 'b', 'normal', 'autonomous', 'x', 'yesterday', 'x', 'yesterday');`, "CHECK constraint failed"],
	["row inserted with no workload (NULL workload_id)", "provenance", () => `INSERT INTO slices (id, workload_id, task, done_condition, inputs, created_by, created_at, changed_by, changed_at) VALUES ('sl-nowl', NULL, 't', 'd', 'i', 'x', ${NOW}, 'x', ${NOW});`, "no open workload with that id"],
	["row inserted with a forged starting revision", "provenance", () => `INSERT INTO workloads (id, brief, stakes, mode, created_by, created_at, changed_by, changed_at, rev) VALUES ('wl-rev', 'b', 'normal', 'autonomous', 'x', ${NOW}, 'x', ${NOW}, 7);`, "insert must start at rev 0"],
	["update that moves changed_at backwards", "provenance", () => `UPDATE messages SET state = 'delivered', changed_by = 'tool:sqlite3', changed_at = '2000-01-01T00:00:00.000Z', rev = rev + 1 WHERE id = '${ids.mHeld}';`, "unstamped update"],
	// deletes
	["workload deleted", "workloads", () => `DELETE FROM workloads WHERE id = '${ids.w2}';`, "ledger rows are never deleted"],
	["message deleted", "messages", () => `DELETE FROM messages WHERE id = '${ids.mHeld}';`, "ledger rows are never deleted"],
	// B1 (review): a reused identity is never a replacement, whatever the conflict clause. With
	// recursive_triggers off (the CLI default), REPLACE deletes the old row without firing the
	// delete triggers, so these must be refused before the conflict is resolved.
	["REPLACE rewinds an acted-on message (review probe E2)", "messages", () => `INSERT OR REPLACE INTO messages (id, workload_id, sender, recipient, body, created_by, created_at, changed_by, changed_at) SELECT id, workload_id, sender, recipient, 'REPLACED', created_by, created_at, created_by, created_at FROM messages WHERE id = '${ids.mActed}';`, "ledger rows are never replaced"],
	["REPLACE forges provenance seq 1 (review probe E2)", "provenance", () => "INSERT OR REPLACE INTO provenance (seq, at, workload_id, lane_instance, tbl, row_id, action, detail) SELECT seq, at, workload_id, 'FORGED', tbl, row_id, action, 'REPLACED' FROM provenance WHERE seq = 1;", "provenance is append-only: that seq is already in use"],
	["bare REPLACE of provenance seq 1", "provenance", () => `REPLACE INTO provenance (seq, at, workload_id, lane_instance, tbl, row_id, action) VALUES (1, ${NOW}, '${ids.w}', 'FORGED', 'workloads', '${ids.w}', 'insert');`, "provenance is append-only: that seq is already in use"],
	["REPLACE reopens a workload as new", "workloads", () => `REPLACE INTO workloads (id, brief, stakes, mode, created_by, created_at, changed_by, changed_at) VALUES ('${ids.w}', 'forged', 'normal', 'autonomous', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "ledger rows are never replaced"],
	["INSERT OR REPLACE reopens a done slice", "slices", () => `INSERT OR REPLACE INTO slices (id, workload_id, task, done_condition, inputs, created_by, created_at, changed_by, changed_at) VALUES ('${ids.sDone}', '${ids.w}', 't', 'easier', 'i', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "ledger rows are never replaced"],
	["REPLACE rewrites an answer instruction", "instructions", () => `REPLACE INTO instructions (id, workload_id, kind, channel, author, body, created_by, created_at) VALUES ('${ids.iAnswer}', '${ids.w}', 'instruction', 'surface', 'jo', 'forged', 'tool:sqlite3', ${NOW});`, "ledger rows are never replaced"],
	["INSERT OR REPLACE reopens an answered question", "questions", () => `INSERT OR REPLACE INTO questions (id, workload_id, slice_id, body, options, created_by, created_at, changed_by, changed_at) VALUES ('${ids.qAnswered}', '${ids.w}', '${ids.sOpen}', 'b', '["a","b"]', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "ledger rows are never replaced"],
	["INSERT OR IGNORE with a reused message id", "messages", () => `INSERT OR IGNORE INTO messages (id, workload_id, sender, recipient, body, created_by, created_at, changed_by, changed_at) VALUES ('${ids.mActed}', '${ids.w}', 'x', 'y', 'b', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "ledger rows are never replaced"],
	["UPSERT onto an existing message", "messages", () => `INSERT INTO messages (id, workload_id, sender, recipient, body, created_by, created_at, changed_by, changed_at) VALUES ('${ids.mActed}', '${ids.w}', 'x', 'y', 'b', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW}) ON CONFLICT(id) DO UPDATE SET state = 'held';`, "ledger rows are never replaced"],
	["REPLACE onto another row's rowid under a new id", "messages", () => `INSERT OR REPLACE INTO messages (rowid, id, workload_id, sender, recipient, body, created_by, created_at, changed_by, changed_at) SELECT rowid, 'msg-new-id', workload_id, sender, recipient, 'REPLACED', created_by, ${NOW}, created_by, ${NOW} FROM messages WHERE id = '${ids.mActed}';`, "ledger rows are never replaced"],
	["UPDATE OR REPLACE onto another row's rowid", "messages", () => `UPDATE OR REPLACE messages SET rowid = (SELECT rowid FROM messages WHERE id = '${ids.mActed}'), ${STAMP} WHERE id = '${ids.mHeld}';`, "a ledger row keeps its rowid"],
	// N2 (second review): a nonpositive rowid/seq is never stored, so an omitted rowid (read as -1
	// by the BEFORE INSERT replacement guard) can never collide with one.
	["workload with explicit rowid -1", "workloads", () => `INSERT INTO workloads (rowid, id, brief, stakes, mode, created_by, created_at, changed_by, changed_at) VALUES (-1, 'wl-neg', 'b', 'normal', 'autonomous', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "a ledger rowid is a positive integer"],
	["slice with explicit rowid 0 via INSERT OR REPLACE", "slices", () => `INSERT OR REPLACE INTO slices (rowid, id, workload_id, task, done_condition, inputs, created_by, created_at, changed_by, changed_at) VALUES (0, 'sl-neg', '${ids.w}', 't', 'd', 'i', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "a ledger rowid is a positive integer"],
	["message with explicit rowid -1 via INSERT OR IGNORE", "messages", () => `INSERT OR IGNORE INTO messages (rowid, id, workload_id, sender, recipient, body, created_by, created_at, changed_by, changed_at) VALUES (-1, 'msg-neg', '${ids.w}', 'x', 'y', 'b', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "a ledger rowid is a positive integer"],
	["instruction with explicit rowid -1", "instructions", () => `INSERT INTO instructions (rowid, id, workload_id, kind, channel, author, body, created_by, created_at) VALUES (-1, 'in-neg', '${ids.w}', 'instruction', 'surface', 'jo', 'b', 'tool:sqlite3', ${NOW});`, "a ledger rowid is a positive integer"],
	["question with explicit rowid -1", "questions", () => `INSERT INTO questions (rowid, id, workload_id, slice_id, body, options, created_by, created_at, changed_by, changed_at) VALUES (-1, 'q-neg', '${ids.w}', '${ids.sOpen}', 'b', '["a","b"]', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`, "a ledger rowid is a positive integer"],
	["provenance with explicit seq -1 (review probe)", "provenance", () => `INSERT INTO provenance (seq, at, workload_id, lane_instance, tbl, row_id, action) VALUES (-1, ${NOW}, '${ids.w}', 'raw', 'workloads', '${ids.w}', 'insert');`, "a provenance seq is a positive integer"],
	// S3 (review): options are strings, whoever writes them.
	...(['[null,42]', '["a",42]', '["a",null]', '["a",{"k":"v"}]', '["a",["b"]]', '["a",true]'] as const).map((options): [string, string, () => string, string] => [
		`question options ${options}`, "questions",
		() => `INSERT INTO questions (id, workload_id, slice_id, body, options, created_by, created_at, changed_by, changed_at) VALUES ('q-bad-options', '${ids.w}', '${ids.sOpen}', 'pick', '${options}', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`,
		"question options must be a JSON array of strings",
	]),
	// B2 (review): a withdrawal carries its disposition, or it is not a withdrawal.
	["withdrawal with no disposition", "instructions", () => `INSERT INTO instructions (id, workload_id, kind, question_id, channel, author, body, created_by, created_at) VALUES ('in-nodisp', '${ids.w}', 'withdrawal', '${ids.qOpen}', 'surface', 'jo', 'stop', 'tool:sqlite3', ${NOW});`, "CHECK constraint failed"],
	["disposition on an answer", "instructions", () => `INSERT INTO instructions (id, workload_id, kind, question_id, disposition, channel, author, body, created_by, created_at) VALUES ('in-ansdisp', '${ids.w}', 'answer', '${ids.qOpen}', 'cancel', 'surface', 'jo', 'a', 'tool:sqlite3', ${NOW});`, "CHECK constraint failed"],
	// Schema v3: routings and entries carry the instructions trigger family. Schema v4: a routing's
	// outcome and the models that ran agree with its row, whoever writes it. Schema v5: a routing names
	// the hand's session root and allocated agent id, once per hand. Each raw row below is its own hand
	// (agent id = row id), so only the rule a case names can refuse it.
	...((): [string, string, () => string, string][] => {
		const RT_COLS = "id, workload_id, slice_id, session_root, agent_id, kind, confidence, probabilities, classified_tier, tier, models, model, judge_model, outcome, ran_models, created_by, created_at";
		const rt = (id: string, wl: () => string, sl: () => string, extra = "") =>
			`VALUES (${extra}'${id}', '${wl()}', '${sl()}', '/tmp/raw', '${id}', 'locate', 0.9, '{}', 'fast', 'fast', '["p/fast"]', 'p/fast', 'j', 'ran', '["p/fast"]', 'tool:sqlite3', ${NOW});`;
		const rtOutcome = (id: string, models: string, model: string, outcome: string, ran: string, agent = `'${id}'`) =>
			`INSERT INTO routings (${RT_COLS}) VALUES ('${id}', '${ids.w}', '${ids.sOpen}', '/tmp/raw', ${agent}, 'locate', 0.9, '{}', 'fast', 'fast', '${models}', ${model}, 'j', ${outcome}, ${ran}, 'tool:sqlite3', ${NOW});`;
		const EN_COLS = "id, workload_id, kind, body, created_by, created_at";
		const en = (id: string, wl: () => string, extra = "") => `VALUES (${extra}'${id}', '${wl()}', 'assumption', 'b', 'tool:sqlite3', ${NOW});`;
		return [
			["routing rewritten", "routings", () => `UPDATE routings SET tier = 'deep' WHERE id = '${ids.rt}';`, "routings are append-only"],
			["routing deleted", "routings", () => `DELETE FROM routings WHERE id = '${ids.rt}';`, "ledger rows are never deleted"],
			["REPLACE rewrites a routing", "routings", () => `REPLACE INTO routings (${RT_COLS}) ${rt(ids.rt!, () => ids.w!, () => ids.sOpen!)}`, "ledger rows are never replaced"],
			["INSERT OR IGNORE with a reused routing id", "routings", () => `INSERT OR IGNORE INTO routings (${RT_COLS}) ${rt(ids.rt!, () => ids.w!, () => ids.sOpen!)}`, "ledger rows are never replaced"],
			["UPSERT onto an existing routing", "routings", () => `INSERT INTO routings (${RT_COLS}) ${rt(ids.rt!, () => ids.w!, () => ids.sOpen!).slice(0, -1)} ON CONFLICT(id) DO UPDATE SET tier = 'deep';`, "ledger rows are never replaced"],
			["REPLACE onto a routing's rowid under a new id", "routings", () => `INSERT OR REPLACE INTO routings (rowid, ${RT_COLS}) ${rt("rt-new", () => ids.w!, () => ids.sOpen!, `(SELECT rowid FROM routings WHERE id = '${ids.rt}'), `)}`, "ledger rows are never replaced"],
			["routing with explicit rowid -1", "routings", () => `INSERT INTO routings (rowid, ${RT_COLS}) ${rt("rt-neg", () => ids.w!, () => ids.sOpen!, "-1, ")}`, "a ledger rowid is a positive integer"],
			["routing into a closed workload", "routings", () => `INSERT INTO routings (${RT_COLS}) ${rt("rt-closed", () => ids.wClosed!, () => ids.sOpen!)}`, "no open workload with that id"],
			["routing on a slice of another workload", "routings", () => `INSERT INTO routings (${RT_COLS}) ${rt("rt-cross", () => ids.w!, () => ids.s2!)}`, "the slice belongs to another workload"],
			["routing whose model is not models[0]", "routings", () => rtOutcome("rt-model", '["p/fast"]', "'p/other'", "'ran'", `'["p/fast"]'`), "CHECK constraint failed"],
			["routing with a blank spawn key", "routings", () => `INSERT INTO routings (spawn_key, ${RT_COLS}) ${rt("rt-blank", () => ids.w!, () => ids.sOpen!, "'  ', ")}`, "CHECK constraint failed"],
			["routing with no outcome (v4)", "routings", () => rtOutcome("rt-no-outcome", '["p/fast"]', "'p/fast'", "NULL", `'["p/fast"]'`), "NOT NULL constraint failed"],
			["routing with an unknown outcome (v4)", "routings", () => rtOutcome("rt-bad-outcome", '["p/fast"]', "'p/fast'", "'dispatched'", `'["p/fast"]'`), "CHECK constraint failed"],
			["routing that ran with no model read (v4)", "routings", () => rtOutcome("rt-ran-none", '["p/fast"]', "'p/fast'", "'ran'", "NULL"), "CHECK constraint failed"],
			["routing refused out of row with an empty ran list (v4)", "routings", () => rtOutcome("rt-ran-empty", '["p/fast"]', "'p/fast'", "'refused-out-of-row'", "'[]'"), "CHECK constraint failed"],
			["routing refused as model-unknown naming a model (v4)", "routings", () => rtOutcome("rt-unknown-ran", '["p/fast"]', "'p/fast'", "'refused-model-unknown'", `'["p/fast"]'`), "CHECK constraint failed"],
			["routing refused for no usable model with a non-empty row (v4)", "routings", () => rtOutcome("rt-nousable-row", '["p/fast"]', "'p/fast'", "'refused-no-usable-model'", "NULL", "NULL"), "CHECK constraint failed"],
			["routing that ran with an empty row (v4)", "routings", () => rtOutcome("rt-ran-norow", "[]", "NULL", "'ran'", `'["p/fast"]'`), "CHECK constraint failed"],
			["routing with no session root (v5)", "routings", () => `INSERT INTO routings (id, workload_id, slice_id, agent_id, kind, confidence, probabilities, classified_tier, tier, models, model, judge_model, outcome, ran_models, created_by, created_at) VALUES ('rt-no-root', '${ids.w}', '${ids.sOpen}', 'rt-no-root', 'locate', 0.9, '{}', 'fast', 'fast', '["p/fast"]', 'p/fast', 'j', 'ran', '["p/fast"]', 'tool:sqlite3', ${NOW});`, "NOT NULL constraint failed"],
			["routing that ran with no agent id (v5)", "routings", () => rtOutcome("rt-no-agent", '["p/fast"]', "'p/fast'", "'ran'", `'["p/fast"]'`, "NULL"), "CHECK constraint failed"],
			["routing refused for no usable model naming an agent id (v5)", "routings", () => rtOutcome("rt-nousable-agent", "[]", "NULL", "'refused-no-usable-model'", "NULL"), "CHECK constraint failed"],
			["a second routing for one session root and agent id (v5)", "routings", () => rtOutcome("rt-second", '["p/fast"]', "'p/fast'", "'ran'", `'["p/fast"]'`, "(SELECT agent_id FROM routings WHERE id = '" + ids.rt + "')").replace("'/tmp/raw'", "'/tmp/lane-A'"), "a hand has one routing row"],
			// S1 (astra review 3): both model lists name models — strings, non-blank; ran_models once each.
			...([
				["ran_models [null]", '["p/fast"]', "'p/fast'", `'[null]'`],
				["ran_models [{}]", '["p/fast"]', "'p/fast'", `'[{}]'`],
				["ran_models [42]", '["p/fast"]', "'p/fast'", `'[42]'`],
				["ran_models a blank name", '["p/fast"]', "'p/fast'", `'["  "]'`],
				["ran_models a tab-only name (N1)", '["p/fast"]', "'p/fast'", `'["\\t"]'`],
				["ran_models a newline-only name (N1)", '["p/fast"]', "'p/fast'", `'["\\n"]'`],
				["ran_models naming a model twice", '["p/fast"]', "'p/fast'", `'["p/fast","p/fast"]'`],
				["models [null]", "[null]", "NULL", `'["p/fast"]'`],
				["models with a blank name", '["p/fast",""]', "'p/fast'", `'["p/fast"]'`],
			] as const).map(([what, models, model, ran]): [string, string, () => string, string] => [
				`routing whose ${what} (S1)`, "routings",
				() => rtOutcome(`rt-s1-${what.replace(/\W+/g, "-")}`, models, model, "'ran'", ran),
				"routing models and ran_models must be JSON arrays of distinct non-blank model names",
			]),
			["entry rewritten", "entries", () => `UPDATE entries SET body = 'forged' WHERE id = '${ids.en}';`, "entries are append-only"],
			["entry deleted", "entries", () => `DELETE FROM entries WHERE id = '${ids.en}';`, "ledger rows are never deleted"],
			["REPLACE rewrites an entry", "entries", () => `REPLACE INTO entries (${EN_COLS}) ${en(ids.en!, () => ids.w!)}`, "ledger rows are never replaced"],
			["INSERT OR IGNORE with a reused entry id", "entries", () => `INSERT OR IGNORE INTO entries (${EN_COLS}) ${en(ids.en!, () => ids.w!)}`, "ledger rows are never replaced"],
			["REPLACE onto an entry's rowid under a new id", "entries", () => `INSERT OR REPLACE INTO entries (rowid, ${EN_COLS}) ${en("en-new", () => ids.w!, `(SELECT rowid FROM entries WHERE id = '${ids.en}'), `)}`, "ledger rows are never replaced"],
			["entry with explicit rowid 0 via INSERT OR REPLACE", "entries", () => `INSERT OR REPLACE INTO entries (rowid, ${EN_COLS}) ${en("en-neg", () => ids.w!, "0, ")}`, "a ledger rowid is a positive integer"],
			["entry into a closed workload", "entries", () => `INSERT INTO entries (${EN_COLS}) ${en("en-closed", () => ids.wClosed!)}`, "no open workload with that id"],
			["entry orphan (unknown workload, foreign_keys off)", "entries", () => `INSERT INTO entries (${EN_COLS}) ${en("en-ghost", () => "wl-ghost")}`, "no open workload with that id"],
			["entry on a slice of another workload", "entries", () => `INSERT INTO entries (slice_id, ${EN_COLS}) ${en("en-cross", () => ids.w!, `'${ids.s2}', `)}`, "the slice belongs to another workload"],
			["entry of an unknown kind", "entries", () => `INSERT INTO entries (${EN_COLS}) VALUES ('en-kind', '${ids.w}', 'note', 'b', 'tool:sqlite3', ${NOW});`, "CHECK constraint failed"],
		];
	})(),
];

describe("raw sqlite3 writes are refused by the file itself", () => {
	let before = "";

	test("the raw connection really is a foreign tool: foreign_keys off, recursive_triggers off, WAL from the file", () => {
		const r = raw("PRAGMA foreign_keys; PRAGMA recursive_triggers; PRAGMA journal_mode;");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim().split("\n")).toEqual(["0", "0", "wal"]);
		before = snapshot();
	});

	for (const [name, table, sql, refusal] of cases) {
		test(`refused [${table}]: ${name}`, () => {
			const r = raw(sql());
			expect(r.exitCode).not.toBe(0);
			expect(r.stderr).toContain(refusal);
		});
	}

	test("no refused write changed any row", () => {
		expect(snapshot()).toBe(before);
	});

	test("a legal, stamped raw write is accepted and logged with its lane instance", () => {
		const r = raw(`UPDATE messages SET state = 'delivered', ${STAMP} WHERE id = '${ids.mLegal}';`);
		expect(r.exitCode).toBe(0);
		const log = raw(`SELECT lane_instance || '|' || detail FROM provenance WHERE row_id = '${ids.mLegal}' ORDER BY seq;`);
		expect(log.stdout.trim().split("\n")).toEqual(["orch-1|held", "tool:sqlite3|held->delivered"]);
	});

	test("legal raw routing and entry inserts are accepted and logged with their lane instance", () => {
		const r = raw(`INSERT INTO routings (id, workload_id, slice_id, session_root, agent_id, kind, confidence, probabilities, classified_tier, pull_up_to, tier, models, model, judge_model, outcome, ran_models, created_by, created_at) VALUES ('rt-raw', '${ids.w}', '${ids.sOpen}', '/tmp/raw', 'rt-raw', 'judge', 0.3, '{}', 'strong', 'deep', 'deep', '["p/deep","q/deep"]', 'p/deep', 'j', 'refused-out-of-row', '["p/deep","x/other"]', 'tool:sqlite3', ${NOW});`
			+ `INSERT INTO routings (id, workload_id, slice_id, session_root, kind, confidence, probabilities, classified_tier, tier, models, model, judge_model, outcome, created_by, created_at) VALUES ('rt-raw-none', '${ids.w}', '${ids.sOpen}', '/tmp/raw', 'locate', 0.9, '{}', 'fast', 'fast', '[]', NULL, 'j', 'refused-no-usable-model', 'tool:sqlite3', ${NOW});`
			+ `INSERT INTO entries (id, workload_id, slice_id, kind, body, created_by, created_at) VALUES ('en-raw', '${ids.w}', '${ids.sOpen}', 'reserved-request', 'push to main', 'tool:sqlite3', ${NOW});`);
		expect(r.stderr).toBe("");
		const log = raw("SELECT tbl || '|' || row_id || '|' || lane_instance || '|' || detail FROM provenance WHERE tbl IN ('routings', 'entries') ORDER BY seq;");
		expect(log.stdout.trim().split("\n")).toEqual([
			`routings|${ids.rt}|lane-A|locate fast -> fast p/fast: ran on p/fast`,
			`entries|${ids.en}|lane-A|wake-read`,
			"routings|rt-raw|tool:sqlite3|judge strong up deep -> deep p/deep: refused-out-of-row on p/deep, x/other",
			"routings|rt-raw-none|tool:sqlite3|locate fast -> fast (no usable model): refused-no-usable-model",
			"entries|en-raw|tool:sqlite3|reserved-request",
		]);
	});

	test("B2: a raw cancel withdrawal stays in force when the slice's other question is answered afterwards", () => {
		const q = (id: string) => `INSERT INTO questions (id, workload_id, slice_id, body, options, created_by, created_at, changed_by, changed_at) VALUES ('${id}', '${ids.w}', '${ids.sDeferred}', '?', '["a","b"]', 'tool:sqlite3', ${NOW}, 'tool:sqlite3', ${NOW});`;
		const resolve = (qid: string, iid: string, state: string) => `UPDATE questions SET state = '${state}', resolved_by = '${iid}', ${STAMP} WHERE id = '${qid}';`;
		expect(raw(q("q-raw-1") + q("q-raw-2")).exitCode).toBe(0);
		const withdraw = raw(`INSERT INTO instructions (id, workload_id, slice_id, kind, question_id, disposition, channel, author, body, created_by, created_at) VALUES ('in-raw-w', '${ids.w}', '${ids.sDeferred}', 'withdrawal', 'q-raw-1', 'cancel', 'surface', 'jo', 'stop this slice', 'tool:sqlite3', ${NOW});` + resolve("q-raw-1", "in-raw-w", "withdrawn"));
		expect(withdraw.stderr).toBe("");
		expect(raw(`SELECT state FROM slices WHERE id = '${ids.sDeferred}';`).stdout.trim()).toBe("paused");
		const answer = raw(`INSERT INTO instructions (id, workload_id, slice_id, kind, question_id, channel, author, body, created_by, created_at) VALUES ('in-raw-a', '${ids.w}', '${ids.sDeferred}', 'answer', 'q-raw-2', 'surface', 'jo', 'a', 'tool:sqlite3', ${NOW});` + resolve("q-raw-2", "in-raw-a", "answered"));
		expect(answer.stderr).toBe("");
		expect(raw(`SELECT state FROM slices WHERE id = '${ids.sDeferred}';`).stdout.trim()).toBe("cancelled");
	});

	test("integrity_check ok and foreign_key_check clean after every raw attempt", () => {
		expect(raw("PRAGMA integrity_check;").stdout.trim()).toBe("ok");
		expect(raw("PRAGMA foreign_key_check;").stdout.trim()).toBe("");
	});
});
