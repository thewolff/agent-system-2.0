// guard-replay (gates/scripts/guard-replay.ts) over the recorded corpus: the rows as they are now
// reproduce every live verdict the fixture carries (no LOST, no NEW-CATCH), a weakened row shows up
// as LOST and exits 1, an unjudged call exits 2, and the transcript parser reads what OMP writes.
// The fixture is a synthetic OMP session transcript of real lane and hand calls (home rewritten to
// /Users/as2, ids renamed, briefs and code cut to what earns the verdict, results omitted, refusal
// texts kept), so the test needs nothing outside the repository.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { wrapCommand } from "../src/fence";
import { checkToolCall } from "../src/gates";
import type { Refusal } from "../src/types";
import {
	type Check, classify, collectCalls, exitCode, isHandTranscript, jsonLines, liveEvidence, main, parseSession, renderExamples, renderTable, replay, replayInput, ROWS, rowOf, toolEventInput,
} from "../scripts/guard-replay";
import { tmpDir } from "../../ledger/test/tmp";

const FIXTURES = join(import.meta.dir, "fixtures", "guard-replay");
const SCRIPT = join(import.meta.dir, "..", "scripts", "guard-replay.ts");
/** The fixture's call count: a CLI run that parses fewer has lost calls, not passed. */
const CORPUS_CALLS = 41;

const corpus = () => collectCalls([FIXTURES], 0);

/** A one-session transcript on disk, for the CLI. */
function transcript(lines: Record<string, unknown>[]): string {
	const root = tmpDir("guard-replay-");
	writeFileSync(join(root, "s.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return root;
}
const header = (cwd = "/Users/as2/code/x") => ({ type: "session", version: 3, id: "s", timestamp: "2026-10-11T00:00:00Z", cwd });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", id, name, arguments: args }] } });
/**
 * A tool result as OMP writes it: a blocked call is a thrown error, `isError: true` with `details: {}`;
 * a call that ran reports its own details (`ran`); `isError: null` or `details: null` leaves the field out.
 */
const result = (id: string, text: string, isError: boolean | null = false, details: Record<string, unknown> | null = isError ? {} : { wallTimeMs: 1 }) => ({
	type: "message",
	message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], ...(details === null ? {} : { details }), ...(isError === null ? {} : { isError }) },
});
const ran = { exitCode: 1, wallTimeMs: 1, timeoutSeconds: 300 };
const passEverything: Check = (): Refusal => null;

describe("the fixture corpus on the rows as they are now", () => {
	test("every live verdict is reproduced: no LOST, no NEW-CATCH, nothing unjudged, nothing ambiguous", () => {
		const calls = corpus();
		expect(calls).toHaveLength(CORPUS_CALLS);
		const report = replay(calls);
		expect(report.errors).toBe(0);
		expect(report.ambiguous).toBe(0);
		expect(report.lost).toBe(0);
		const newCatches = report.calls.filter((c) => c.outcomes.some((o) => o.kind === "new-catch")).map((c) => `${c.line}: ${c.nowReason}`);
		expect(newCatches).toEqual([]);
		// The corpus covers the replayable rows with live refusals and the state-bound ones too.
		for (const row of ["r06-reserved", "r10-raw-ledger", "r05-brief-fields"]) expect(report.rows[row]!.unchanged).toBeGreaterThan(0);
		for (const row of ["r08-push-rebase", "question", "fence", "r18-typed-wrapper"]) expect(report.rows[row]!.stateBound).toBeGreaterThan(0);
		expect(report.passed).toBeGreaterThan(0);
		expect(new Set(calls.map((c) => c.tool))).toEqual(new Set(["bash", "eval", "write", "edit", "read", "task"]));
		expect(exitCode(report)).toBe(0);
	});

	test("the context is the transcript's, not this process's", () => {
		const first = corpus()[0]!;
		expect(first.home).toBe("/Users/as2");
		expect(first.cwd).toBe("/Users/as2/code/agent-system-2.0-lanes/wl-fixture-1");
		expect(first.workload).toBe("wl-fixture-1");
		expect(first.role).toBe("lane");
		expect(first.isError).toBe(true);
		expect(first.detailKeys).toBe(0);
		expect(isHandTranscript(first.path)).toBe(false);
	});

	test("a weakened row 6 is a LOST: the stub lets every reserved action through", () => {
		const weakened: Check = (c, ctx, deps) => {
			const r = checkToolCall(c, ctx, deps);
			return r && rowOf(r.reason) === "r06-reserved" ? null : r;
		};
		const report = replay(corpus(), weakened);
		expect(report.rows["r06-reserved"]!.lost).toBeGreaterThan(0);
		expect(report.rows["r06-reserved"]!.unchanged).toBe(0);
		expect(report.lost).toBe(report.rows["r06-reserved"]!.lost);
		// The other rows are untouched by the stub.
		expect(report.rows["r10-raw-ledger"]!.lost).toBe(0);
		expect(report.rows["r05-brief-fields"]!.lost).toBe(0);
		expect(exitCode(report)).toBe(1);
		expect(renderTable(report)).toContain(`LOST ${report.lost}:`);
		const shown = renderExamples(report, "r06-reserved");
		expect(shown).toContain("r06-reserved LOST (");
		expect(shown).toContain("live: P-11 row 6 refused this");
		expect(shown).toContain(`${FIXTURES}/corpus.jsonl:`);
	});

	test("a row that refuses what it did not refuse live is a NEW-CATCH, not a LOST", () => {
		const stricter: Check = (c, ctx, deps) => checkToolCall(c, ctx, deps) ?? (c.toolName === "read" ? { block: true, reason: "P-11 row 10 refused this: reads too" } : null);
		const report = replay(corpus(), stricter);
		expect(report.lost).toBe(0);
		expect(report.rows["r10-raw-ledger"]!.newCatch).toBe(corpus().filter((c) => c.tool === "read").length);
		expect(exitCode(report)).toBe(0);
	});

	test("a judge that throws leaves the call unjudged: counted, never a verdict, and the report exits 2", () => {
		const throwing: Check = () => {
			throw new Error("boom");
		};
		const report = replay(corpus(), throwing);
		expect(report.errors).toBe(report.calls.length);
		expect(report.lost).toBe(0);
		for (const row of ROWS) expect(report.rows[row.id]).toEqual({ newCatch: 0, lost: 0, unchanged: 0, stateBound: 0, unreachedLive: 0 });
		expect(exitCode(report)).toBe(2);
		const table = renderTable(report);
		expect(table).toContain(`incomplete: ${report.calls.length} call(s) not judged`);
		expect(table).toContain("the report is incomplete");
		expect(table).not.toContain("ok:");
		expect(renderExamples(report, "errors")).toContain("cause: Error: boom");
	});

	test("a LOST outranks an unjudged call in the exit code; both are said", () => {
		let n = 0;
		const flaky: Check = (c, ctx, deps) => {
			if (n++ === 0) throw new Error("once");
			const r = checkToolCall(c, ctx, deps);
			return r && rowOf(r.reason) === "r10-raw-ledger" ? null : r;
		};
		const report = replay(corpus(), flaky);
		expect(report.errors).toBe(1);
		expect(report.lost).toBeGreaterThan(0);
		expect(exitCode(report)).toBe(1);
		const table = renderTable(report);
		expect(table).toContain("incomplete: 1 call(s) not judged");
		expect(table).toContain(`LOST ${report.lost}:`);
	});

	test("--json emits one object per call with the two rows, the evidence and the outcomes", () => {
		const report = replay(corpus());
		const lines = jsonLines(report).split("\n");
		expect(lines).toHaveLength(report.calls.length);
		const first = JSON.parse(lines[0]!) as Record<string, unknown>;
		for (const k of ["path", "line", "toolCallId", "tool", "command", "cwd", "role", "workload", "nowRow", "nowReason", "live", "liveRow", "isError", "detailKeys", "outcomes"]) expect(first).toHaveProperty(k);
		expect(first.live).toBe("refused");
	});
});

describe("the command line", () => {
	test("prints the per-row table in under ten seconds and exits 0 on the whole corpus", () => {
		const t0 = Date.now();
		const r = spawnSync("bun", [SCRIPT, "--root", FIXTURES, "--days", "0", "--show", "r06-reserved"], { encoding: "utf8" });
		expect(Date.now() - t0).toBeLessThan(10_000);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`GUARD REPLAY (${CORPUS_CALLS} calls)`);
		for (const row of ROWS) expect(r.stdout).toContain(row.id);
		expect(r.stdout).toContain("ok: no LOST on any replayable row");
		expect(r.stdout).toContain("r06-reserved UNCHANGED (");
		expect(r.stdout).toContain("r06-reserved LOST (0)");
	});

	test("exits 1 when a replayable row has a LOST: a harmless command the transcript says row 6 refused", () => {
		const root = transcript([header(), call("t1", "bash", { command: "ls -la" }), result("t1", "P-11 row 6 refused this: ls is on the § A4 reserved list", true)]);
		const r = spawnSync("bun", [SCRIPT, "--root", root, "--days", "0", "--show", "r06-reserved"], { encoding: "utf8" });
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("LOST 1: a replayable row no longer refuses a call it refused live");
		expect(r.stdout).toContain(`${join(root, "s.jsonl")}:2  bash  ls -la`);
		expect(r.stdout).toContain("live: P-11 row 6 refused this: ls is on the § A4 reserved list");
	});

	test("exits 2 when a call could not be judged: a transcript with no session header", () => {
		const root = transcript([call("t1", "bash", { command: "ls" }), result("t1", "ok")]);
		const r = spawnSync("bun", [SCRIPT, "--root", root, "--days", "0", "--show", "errors"], { encoding: "utf8" });
		expect(r.status).toBe(2);
		expect(r.stdout).toContain("incomplete: 1 call(s) not judged");
		expect(r.stdout).toContain("no session header before this call");
		expect(r.stdout).not.toContain("ok:");
	});

	test("main's exit code is the report's: 2 for a judge that throws, with the socket-style error shown", () => {
		const root = transcript([header(), call("t1", "bash", { command: "ls -l /var/run/docker.sock" }), result("t1", "srwxr-xr-x", false)]);
		const throwing: Check = () => {
			throw new Error("EOPNOTSUPP: operation not supported on socket, lstat");
		};
		const logged: string[] = [];
		const log = console.log;
		console.log = (s: string) => {
			logged.push(s);
		};
		try {
			expect(main(["--root", root, "--days", "0", "--show", "errors"], throwing)).toBe(2);
			expect(main(["--root", root, "--days", "0"], passEverything)).toBe(0);
		} finally {
			console.log = log;
		}
		expect(logged.join("\n")).toContain("cause: Error: EOPNOTSUPP");
	});

	test("a bad argument exits 2 with the reason", () => {
		const r = spawnSync("bun", [SCRIPT, "--days", "soon"], { encoding: "utf8" });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--days takes a number of days");
	});

	test("an unknown row name is said, not crashed on", () => {
		expect(renderExamples(replay([]), "r99")).toContain("no such row: r99");
	});
});

describe("what the transcript says happened live", () => {
	test("a successful result that quotes a refusal is not a refusal", () => {
		expect(liveEvidence({ result: "P-11 row 6 refused this: quoted example", isError: false, detailKeys: 3 })).toEqual({ live: "passed", liveRow: null });
		expect(liveEvidence({ result: "P-11 row 6 refused this: quoted example", isError: false, detailKeys: null })).toEqual({ live: "passed", liveRow: null });
		const text = [header(), call("a", "read", { path: "notes.md" }), result("a", "P-11 row 6 refused this: quoted example", false)].map((l) => JSON.stringify(l)).join("\n");
		const report = replay(parseSession("/x/s.jsonl", text), passEverything);
		expect(report.calls[0]!.outcomes).toEqual([{ row: null, kind: "pass" }]);
		expect(report.lost).toBe(0);
	});

	test("a failed command whose output quotes a refusal ran (its details say so), so it is not a refusal either", () => {
		expect(liveEvidence({ result: "P-11 row 6 refused this: quoted example\n", isError: true, detailKeys: 3 })).toEqual({ live: "passed", liveRow: null });
		const text = [header(), call("a", "bash", { command: "printf 'P-11 row 6 refused this: quoted example\\n'; exit 1" }), result("a", "P-11 row 6 refused this: quoted example\n", true, ran)].map((l) => JSON.stringify(l)).join("\n");
		const report = replay(parseSession("/x/s.jsonl", text), passEverything);
		expect(report.calls[0]!.detailKeys).toBe(3);
		expect(report.calls[0]!.outcomes).toEqual([{ row: null, kind: "pass" }]);
		expect(report.lost).toBe(0);
	});

	test("a blocked call (error-flagged, empty details) whose head is a row's reason is that row's refusal", () => {
		expect(liveEvidence({ result: "P-11 row 6 refused this: force push", isError: true, detailKeys: 0 })).toEqual({ live: "refused", liveRow: "r06-reserved" });
		const text = [header(), call("a", "bash", { command: "git push --force" }), result("a", "P-11 row 6 refused this: force push", true)].map((l) => JSON.stringify(l)).join("\n");
		const report = replay(parseSession("/x/s.jsonl", text), passEverything);
		expect(report.calls[0]!.detailKeys).toBe(0);
		expect(report.calls[0]!.outcomes).toEqual([{ row: "r06-reserved", kind: "lost" }]);
	});

	test("a failed result that is no gate refusal is the tool failing, so the gates let it through", () => {
		expect(liveEvidence({ result: "exit 1: command not found", isError: true, detailKeys: 3 })).toEqual({ live: "passed", liveRow: null });
		expect(liveEvidence({ result: "stale tag", isError: true, detailKeys: 0 })).toEqual({ live: "passed", liveRow: null });
		expect(liveEvidence({ result: "logS raw: kubectl delete | verdict: P-11 row 6 refused", isError: true, detailKeys: 0 })).toEqual({ live: "passed", liveRow: null });
	});

	test("refusal text with no error flag, or no details, is ambiguous: compared with nothing, and the report is incomplete (exit 2)", () => {
		expect(liveEvidence({ result: "P-11 row 10 refused this: x", isError: null, detailKeys: 0 })).toEqual({ live: "ambiguous", liveRow: "r10-raw-ledger" });
		expect(liveEvidence({ result: "P-11 row 10 refused this: x", isError: true, detailKeys: null })).toEqual({ live: "ambiguous", liveRow: "r10-raw-ledger" });
		const text = [header(), call("a", "bash", { command: "cat ledger.db" }), result("a", "P-11 row 10 refused this: x", null, null)].map((l) => JSON.stringify(l)).join("\n");
		const report = replay(parseSession("/x/s.jsonl", text), passEverything);
		expect(report.calls[0]!.outcomes).toEqual([{ row: "r10-raw-ledger", kind: "ambiguous" }]);
		expect(report.ambiguous).toBe(1);
		expect(report.lost).toBe(0);
		expect(report.errors).toBe(0);
		expect(report.rows["r10-raw-ledger"]!.lost).toBe(0);
		const table = renderTable(report);
		expect(table).toContain("incomplete: 1 call(s) with ambiguous live evidence");
		expect(table).toContain("the report is incomplete");
		expect(table).not.toContain("ok:");
		expect(renderExamples(report, "ambiguous")).toContain("result: P-11 row 10 refused this: x");
		expect(exitCode(report)).toBe(2);
	});

	test("an ambiguous call next to a LOST: exit 1 still, both footers", () => {
		const text = [
			header(),
			call("a", "bash", { command: "cat ledger.db" }),
			result("a", "P-11 row 10 refused this: x", null, null),
			call("b", "bash", { command: "git push --force" }),
			result("b", "P-11 row 6 refused this: force push", true),
		].map((l) => JSON.stringify(l)).join("\n");
		const report = replay(parseSession("/x/s.jsonl", text), passEverything);
		expect(report.ambiguous).toBe(1);
		expect(report.lost).toBe(1);
		expect(exitCode(report)).toBe(1);
		const table = renderTable(report);
		expect(table).toContain("incomplete: 1 call(s) with ambiguous live evidence");
		expect(table).toContain("LOST 1: a replayable row no longer refuses a call it refused live");
	});

	test("the CLI exits 2 on an ambiguous call with nothing lost", () => {
		const root = transcript([header(), call("t1", "bash", { command: "cat ledger.db" }), result("t1", "P-11 row 10 refused this: x", null, null)]);
		const r = spawnSync("bun", [SCRIPT, "--root", root, "--days", "0", "--show", "ambiguous"], { encoding: "utf8" });
		expect(r.status).toBe(2);
		expect(r.stdout).toContain("incomplete: 1 call(s) with ambiguous live evidence");
		expect(r.stdout).toContain("ambiguous (1)");
		expect(r.stdout).not.toContain("ok:");
	});

	test("the gate's could-not-read variants are the row's too, live and now", () => {
		expect(rowOf("P-11 question row could not read the ledger to check this dispatch against open questions (x); refusing rather than pass unchecked.")).toBe("question");
		expect(rowOf("P-11 row 7 refused this: after a wake, the wake verified read is owed and the ledger could not be read (x).")).toBe("r07-wake-read");
		expect(rowOf("P-11 row 15 could not read the ledger")).toBe("r15-orchestrator-role");
		const ledgerDown: Check = () => ({ block: true, reason: "P-11 question row could not read the ledger to check this dispatch against open questions (x); refusing rather than pass unchecked." });
		const text = [header(), call("a", "task", { tasks: [] }), result("a", "ok", false)].map((l) => JSON.stringify(l)).join("\n");
		const report = replay(parseSession("/x/s.jsonl", text), ledgerDown);
		expect(report.calls[0]!.nowRow).toBe("question");
		expect(report.calls[0]!.outcomes).toEqual([{ row: "question", kind: "state-bound" }]);
	});

	test("rowOf reads the row off the reason's head only, and row 1 is no tool-call row", () => {
		expect(rowOf("P-11 row 6 refused this: rm -rf")).toBe("r06-reserved");
		expect(rowOf("  P-11 question row refused this dispatch")).toBe("question");
		expect(rowOf("M4b OS fence: the running OMP is 18.8.5")).toBe("fence");
		expect(rowOf("P-11 row 1 refused this turn to Jo: x")).toBeNull();
		expect(rowOf("P-11 row 10 refused this: x")).toBe("r10-raw-ledger");
		expect(rowOf("logS raw: kubectl delete | verdict: P-11 row 6 refused")).toBeNull();
		expect(rowOf("")).toBeNull();
		expect(rowOf(null)).toBeNull();
	});
});

describe("classification: first refusal wins, live and now", () => {
	const kinds = (now: string | null, live: string | null) => classify(now, live).map((o) => `${o.kind}:${o.row ?? "-"}`);
	test("same verdict both times", () => {
		expect(kinds(null, null)).toEqual(["pass:-"]);
		expect(kinds("r06-reserved", "r06-reserved")).toEqual(["unchanged:r06-reserved"]);
		expect(kinds("r08-push-rebase", "r08-push-rebase")).toEqual(["state-bound:r08-push-rebase"]);
	});
	test("a replayable row's new refusal is a NEW-CATCH; a lost one is a LOST", () => {
		expect(kinds("r06-reserved", null)).toEqual(["new-catch:r06-reserved"]);
		expect(kinds(null, "r06-reserved")).toEqual(["lost:r06-reserved"]);
	});
	test("a refusal now at an earlier row shadows the live row: still refused, not a LOST", () => {
		expect(kinds("r10-raw-ledger", "r06-reserved")).toEqual(["new-catch:r10-raw-ledger", "shadowed:r06-reserved"]);
	});
	test("a refusal now at a later row than the live one never saw the call live: UNREACHED-LIVE, and the live row is LOST", () => {
		expect(kinds("r06-reserved", "r10-raw-ledger")).toEqual(["unreached-live:r06-reserved", "lost:r10-raw-ledger"]);
	});
	test("state-bound rows never count as NEW-CATCH or LOST", () => {
		expect(kinds("r08-push-rebase", null)).toEqual(["state-bound:r08-push-rebase"]);
		expect(kinds(null, "fence")).toEqual(["state-bound:fence"]);
		expect(kinds("r09-protected-edit", "question")).toEqual(["unreached-live:r09-protected-edit", "state-bound:question"]);
		// A state-bound refusal now against a replayable live one later in the order: the live row was consulted and passed.
		expect(kinds("r08-push-rebase", "r06-reserved")).toEqual(["unreached-live:r08-push-rebase", "lost:r06-reserved"]);
		expect(kinds("r07-wake-read", "r06-reserved")).toEqual(["state-bound:r07-wake-read", "shadowed:r06-reserved"]);
	});
	test("a live state-bound refusal from an earlier row keeps its STATE-BOUND and makes a later row's refusal UNREACHED-LIVE", () => {
		// Wake runs before reserved: a wake refusal live means row 6 never saw the call, so this is no new catch.
		expect(kinds("r06-reserved", "r07-wake-read")).toEqual(["unreached-live:r06-reserved", "state-bound:r07-wake-read"]);
		// The question row runs before the raw-ledger and reserved rows and after the brief row.
		expect(kinds("r06-reserved", "question")).toEqual(["unreached-live:r06-reserved", "state-bound:question"]);
		expect(kinds("r05-brief-fields", "question")).toEqual(["new-catch:r05-brief-fields", "state-bound:question"]);
		// A state-bound live refusal after the row refusing now: that row passed the call live.
		expect(kinds("r06-reserved", "r08-push-rebase")).toEqual(["new-catch:r06-reserved", "state-bound:r08-push-rebase"]);
		expect(kinds("r06-reserved", "fence")).toEqual(["new-catch:r06-reserved", "state-bound:fence"]);
	});
	test("UNREACHED-LIVE is counted per row and shown, and is neither a NEW-CATCH nor in the exit code", () => {
		const text = [header(), call("a", "bash", { command: "rm -rf x" }), result("a", "P-11 row 7 refused this: after a wake, the lane's first turn owes one ledger entry", true)].map((l) => JSON.stringify(l)).join("\n");
		const report = replay(parseSession("/x/s.jsonl", text));
		expect(report.rows["r06-reserved"]).toEqual({ newCatch: 0, lost: 0, unchanged: 0, stateBound: 0, unreachedLive: 1 });
		expect(report.rows["r07-wake-read"]!.stateBound).toBe(1);
		expect(exitCode(report)).toBe(0);
		expect(renderExamples(report, "r06-reserved")).toContain("r06-reserved UNREACHED-LIVE (1)");
	});
});

describe("row 18 and the fence's wrapper on a recorded bash call", () => {
	const line = (l: Record<string, unknown>) => JSON.stringify(l);
	const PROFILE = '(version 1)(allow default)(deny file-write* (subpath "/Users/as2/.agent-system-2"))';
	const wrapped = (command: string) => wrapCommand("/usr/bin/sandbox-exec", PROFILE, command);
	/** checkToolCall, recording the command each bash call is judged as. */
	const seeing = () => {
		const seen: string[] = [];
		const check: Check = (c, ctx, deps) => {
			if (c.toolName === "bash") seen.push(String(c.input.command));
			return checkToolCall(c, ctx, deps);
		};
		return { seen, check };
	};
	const typedReason =
		"P-11 row 18 refused this: the command you typed starts with the M4b OS fence's own wrapper (sandbox-exec, its -p profile and /bin/bash -c). The fence adds that wrapper itself, after the gates. Resend the bare command: ls";

	test("row 18's reason is its own, and it runs right after row 15", () => {
		expect(rowOf(typedReason)).toBe("r18-typed-wrapper");
		expect(ROWS.map((r) => r.id).slice(0, 4)).toEqual(["r14-ask", "r15-orchestrator-role", "r18-typed-wrapper", "r07-wake-read"]);
		expect(ROWS.find((r) => r.id === "r18-typed-wrapper")!.replayable).toBe(false);
	});

	test("a call that ran has one fence wrapper taken off before it is judged, so row 18 does not catch every recorded bash call", () => {
		const { seen, check } = seeing();
		const text = [
			line(header()),
			line(call("a", "bash", { command: wrapped("ls") })),
			line(result("a", "ok")),
			line(call("b", "bash", { command: wrapped("git push --force origin main") })),
			line(result("b", "", true, ran)),
		].join("\n");
		const report = replay(parseSession("/x/s.jsonl", text), check);
		expect(seen).toEqual(["ls", "git push --force origin main"]);
		expect(report.calls[0]!.outcomes).toEqual([{ row: null, kind: "pass" }]);
		// The rows after row 18 see the inner command: row 6 catches the push it let through live.
		expect(report.calls[1]!.outcomes).toEqual([{ row: "r06-reserved", kind: "new-catch" }]);
		expect(report.rows["r18-typed-wrapper"]).toEqual({ newCatch: 0, lost: 0, unchanged: 0, stateBound: 0, unreachedLive: 0 });
	});

	test("a call refused live keeps its command as typed: row 18's refusal replays as row 18's, and a pre-change fence refusal of a copy is row 18's now", () => {
		const { seen, check } = seeing();
		const already = "M4b OS fence: the command already carries sandbox-exec; the fence adds sandbox-exec itself";
		const text = [
			line(header()),
			line(call("a", "bash", { command: wrapped("ls") })),
			line(result("a", typedReason, true)),
			line(call("b", "bash", { command: wrapped("ls") })),
			line(result("b", already, true)),
		].join("\n");
		const report = replay(parseSession("/x/s.jsonl", text), check);
		expect(seen).toEqual([wrapped("ls"), wrapped("ls")]);
		expect(report.calls[0]!.nowReason).toBe(typedReason);
		expect(report.calls[0]!.outcomes).toEqual([{ row: "r18-typed-wrapper", kind: "state-bound" }]);
		expect(report.calls[1]!.outcomes).toEqual([
			{ row: "r18-typed-wrapper", kind: "state-bound" },
			{ row: "fence", kind: "state-bound" },
		]);
		expect(report.lost).toBe(0);
		expect(exitCode(report)).toBe(0);
	});

	test("only a bash call that ran is unwrapped: refused, ambiguous and other tools' inputs are judged as recorded", () => {
		const command = wrapped("ls");
		expect(replayInput({ tool: "bash", input: { command } }, "passed")).toEqual({ command: "ls" });
		expect(replayInput({ tool: "bash", input: { command, cwd: "/w" } }, "passed")).toEqual({ command: "ls", cwd: "/w" });
		for (const live of ["refused", "ambiguous"] as const) expect(replayInput({ tool: "bash", input: { command } }, live)).toEqual({ command });
		expect(replayInput({ tool: "eval", input: { code: command } }, "passed")).toEqual({ code: command });
		expect(replayInput({ tool: "bash", input: { command: "ls" } }, "passed")).toEqual({ command: "ls" });
		// One level only: a wrapper left inside is the rows' to judge.
		expect(replayInput({ tool: "bash", input: { command: wrapped(command) } }, "passed")).toEqual({ command });
	});

	test("classification: row 18 runs before every row but ask and row 15, and is state-bound", () => {
		const kinds = (now: string | null, live: string | null) => classify(now, live).map((o) => `${o.kind}:${o.row ?? "-"}`);
		expect(kinds("r18-typed-wrapper", "r18-typed-wrapper")).toEqual(["state-bound:r18-typed-wrapper"]);
		expect(kinds("r18-typed-wrapper", "r06-reserved")).toEqual(["state-bound:r18-typed-wrapper", "shadowed:r06-reserved"]);
		expect(kinds("r06-reserved", "r18-typed-wrapper")).toEqual(["unreached-live:r06-reserved", "state-bound:r18-typed-wrapper"]);
		expect(kinds("r15-orchestrator-role", "r18-typed-wrapper")).toEqual(["state-bound:r15-orchestrator-role", "state-bound:r18-typed-wrapper"]);
		expect(kinds(null, "r18-typed-wrapper")).toEqual(["state-bound:r18-typed-wrapper"]);
	});
});

describe("the transcript parser", () => {
	const line = (l: Record<string, unknown>) => JSON.stringify(l);
	const laneHeader = line(header("/Users/someone/code/agent-system-2.0-lanes/wl-abc"));

	test("pairs each call with its result, keeps the line and the flag, derives cwd, home and workload, keeps every tool", () => {
		const text = [laneHeader, line(call("a", "bash", { command: "ls" })), line(call("b", "grep", { pattern: "x" })), line(result("a", "ok")), line(result("b", "hit", true)), line(call("c", "bash", { command: "pwd" }))].join("\n");
		const calls = parseSession("/x/lanes/wl-abc/sessions/s.jsonl", text);
		expect(calls).toHaveLength(2); // c has no result
		expect(calls[0]).toMatchObject({ line: 2, toolCallId: "a", tool: "bash", input: { command: "ls" }, cwd: "/Users/someone/code/agent-system-2.0-lanes/wl-abc", home: "/Users/someone", workload: "wl-abc", role: "lane", result: "ok", isError: false });
		expect(calls[1]).toMatchObject({ line: 3, toolCallId: "b", tool: "grep", result: "hit", isError: true });
	});

	test("a header written with spaces inside the JSON is the same header", () => {
		const spaced = '{"type": "session", "version": 3, "id": "s", "cwd": "/Users/as2/expected"}';
		const compact = line(header("/Users/as2/expected"));
		for (const h of [spaced, compact]) {
			const calls = parseSession("/x/s.jsonl", [h, line(call("a", "bash", { command: "ls" })), line(result("a", "ok"))].join("\n"));
			expect(calls[0]!.cwd).toBe("/Users/as2/expected");
			expect(calls[0]!.home).toBe("/Users/as2");
		}
	});

	test("a call before any header carries no cwd and is not judged, rather than judged in this process's cwd", () => {
		const text = [line(call("a", "bash", { command: "ls" })), line(result("a", "ok"))].join("\n");
		const calls = parseSession("/x/s.jsonl", text);
		expect(calls[0]!.cwd).toBeNull();
		const report = replay(calls, passEverything);
		expect(report.errors).toBe(1);
		expect(report.calls[0]!.outcomes).toEqual([{ row: null, kind: "error" }]);
		expect(report.calls[0]!.nowReason).toContain("no session header before this call in /x/s.jsonl");
	});

	test("an edit call's hashline headers become path or paths, as OMP's event input has them", () => {
		expect(toolEventInput("edit", { input: "[a/b.ts#1A2B]\nPUT 1.=1:\n+x\n" })).toEqual({ input: "[a/b.ts#1A2B]\nPUT 1.=1:\n+x\n", path: "a/b.ts" });
		expect(toolEventInput("edit", { input: "[a.ts#1A2B]\nPUT 1.=1:\n+x\n[b.ts#3C4D]\nPUT 2.=2:\n+y\n" })).toEqual({ input: "[a.ts#1A2B]\nPUT 1.=1:\n+x\n[b.ts#3C4D]\nPUT 2.=2:\n+y\n", paths: ["a.ts", "b.ts"] });
		expect(toolEventInput("edit", { path: "given.ts", input: "[x.ts#1A2B]\n" })).toEqual({ path: "given.ts", input: "[x.ts#1A2B]\n" });
		expect(toolEventInput("write", { path: "w.ts", content: "[x.ts#1A2B]\n" })).toEqual({ path: "w.ts", content: "[x.ts#1A2B]\n" });
	});

	test("a hand's transcript sits in a directory named after its parent session", () => {
		expect(isHandTranscript(join(FIXTURES, "corpus.jsonl"))).toBe(false);
	});

	test("a resumed transcript's repeated calls are read once", () => {
		const calls = collectCalls([FIXTURES, FIXTURES], 0);
		expect(calls).toHaveLength(CORPUS_CALLS);
	});

	test("ask and browser calls reach the rows: a hand's ask is refused by row 14, a browser click by row 6", () => {
		const text = [laneHeader, line(call("a", "ask", { question: "which?" })), line(result("a", "answered")), line(call("b", "mcp__chrome_devtools_click", { uid: "1" })), line(result("b", "clicked"))].join("\n");
		const calls = parseSession("/x/s.jsonl", text, { role: "hand" });
		const report = replay(calls);
		expect(report.calls[0]!.nowRow).toBe("r14-ask");
		expect(report.calls[0]!.outcomes).toEqual([{ row: "r14-ask", kind: "state-bound" }]);
		expect(report.calls[1]!.nowRow).toBe("r06-reserved");
		expect(report.calls[1]!.outcomes).toEqual([{ row: "r06-reserved", kind: "new-catch" }]);
	});
});
