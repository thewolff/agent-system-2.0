// The P-11 bridge for the paired-coding adapter (PLAN-2 wl-mvb9mw00ycfjeo D5; plugins/VENDOR.md clashes C8
// and C12): a lane session with the surface, the gates and the adapter bound through
// plugins/paired-as2.ts, every pair call going tool_call → the tool's execute → tool_result the way OMP
// runs it, against a temp ledger, a temp HOME and a temp git worktree.
//   - pair_write and pair_edit into a path a write or edit may not touch get that write's or edit's own
//     refusal (rows 9 and 10); a pair call the gates never saw, or whose arguments changed after they
//     allowed it, is refused at execute and writes nothing; an agreed one with its arguments unchanged
//     writes its exact bytes and leaves its write receipt.
//   - a pair_run of a command bash would refuse gets bash's own refusal (row 6, sandbox-exec and a
//     destructive git command outside scratch, with the reserved request recorded); a scratch-only
//     exemption is refused, since the pairing sandbox is not that confinement.
//   - an allowed pair_run runs, under the one pairing profile that also carries the fence's ledger deny.
//   - a pair_run of a declared artifact writes the slice's outcome from the run's real exit, and a
//     passing one its artifact-tree entry; a run after which pairing stops (its post-run link check), or
//     during which the partner types pair stop, still writes its failure and its bash receipt, and never
//     a pass; a later pair_run refused before its start writes nothing, even under an earlier run's
//     reused tool call id.
//   - the as2 lifecycle tools are allowed while pairing; host mutation and unknown tools stay refused.
//   - with the clean shell on, pair_run refuses to start a /bin/sh whose env carries a start hook.
// The runs execute for real under /usr/bin/sandbox-exec. A process already inside a Seatbelt sandbox
// (an as2 lane's fenced bash) cannot apply another profile: sandbox-exec exits 71 with `sandbox_apply`,
// so the assertions that need a run to finish are skipped there and say why in their title.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { bindPairedCoding } from "../../plugins/paired-as2";
import { sessionDirFor } from "../../plugins/paired-coding/lib/verbs.mjs";
import orchestratorSurface from "../../surface/index";
import { artifactTrees } from "../../surface/src/signals";
import { ARTIFACT_TOOL, LANE_RECORD_ENTRY_TOOL } from "../../surface/src/types";
import p11Gates from "../index";
import type { CleanShellCheck } from "../src/clean-shell";
import { type FenceSettings, shellStartReason } from "../src/fence";
import { PAIR_RUN_CONFINED_REASON } from "../src/pair-call";
import { scratchRootFor } from "../src/scratch";
import { gateSession } from "../src/session";
import { CERTIFIED, commit, git, tmp } from "./helpers";

const ON: FenceSettings = { enabled: true, autoBackground: true };

/** Whether this process can apply a Seatbelt profile (not when it already runs under one). */
const NESTED = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
const RUN_SKIP = NESTED ? "" : " [skipped: this process already runs under a Seatbelt sandbox, so sandbox-exec cannot apply the pairing profile]";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type Result = { block?: boolean; reason?: string; input?: Record<string, unknown> } | undefined;
interface Tool {
	execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: { text: string }[]; details?: unknown; isError?: boolean }>;
}

/** Any zod builder chain the tools' parameter schemas use. */
const zod: unknown = new Proxy(() => zod, { get: () => () => zod });

/** OMP's extension API as the runner chains it: the first block wins, otherwise the last revision runs. */
function host() {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool & { name: string }>();
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		getActiveTools: () => [...tools.keys()],
		getAllTools: () => [...tools.keys()].map((name) => ({ name })),
		setActiveTools: async () => {},
		appendEntry: () => {},
		registerTool: (t: Tool & { name: string }) => tools.set(t.name, t),
		sendMessage: () => {},
		zod,
	};
	const emit = async (name: string, event: Record<string, unknown>, ctx: unknown): Promise<Result> => {
		let last: Result;
		for (const h of handlers.get(name) ?? []) {
			const r = (await h(event, ctx)) as Result;
			if (!r) continue;
			last = r;
			if (r.block) return r;
		}
		return last;
	};
	const tool = (name: string): Tool => {
		const t = tools.get(name);
		if (!t) throw new Error(`tool ${name} not registered`);
		return t;
	};
	return { pi, emit, tool };
}

/** One field of a tool result's details, or undefined. */
const field = (details: unknown, key: string): unknown => (typeof details === "object" && details !== null ? Reflect.get(details, key) : undefined);

let sessions = 0;
const disposers: (() => void)[] = [];
afterEach(() => {
	for (const d of disposers.splice(0)) d();
});

/**
 * A lane on a temp ledger in a temp worktree on `branch`, with the surface, the gates and the paired
 * adapter loaded, its session started. `call` runs one tool as OMP does: tool_call, then (unless refused)
 * the tool's execute with the revision every handler left, then tool_result.
 */
async function lane(o: { branch?: string; cleanShell?: CleanShellCheck } = {}) {
	const home = tmp("pair-home");
	const ledgerDir = join(home, ".agent-system-2");
	mkdirSync(ledgerDir);
	const ledgerPath = join(ledgerDir, "ledger.db");
	const ledger = Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false });
	disposers.push(() => ledger.close());
	const wl = ledger.openWorkload({ by: "orch", brief: "Pair on the header", stakes: "normal", mode: "user-driven" });
	const sl = ledger.addSlice({ by: "orch", workloadId: wl, task: "Pair on the header", doneCondition: "the check passes", inputs: "src/" });
	const repo = tmp("pair-repo");
	git(repo, "init", "-q", "-b", "main");
	mkdirSync(join(repo, "src"));
	commit(repo, "src/a.txt", "a\n");
	if (o.branch !== "main") git(repo, "switch", "-q", "-c", o.branch ?? "wl/pair");
	const env: Record<string, string | undefined> = {
		AGENT_SYSTEM_ROLE: "lane",
		AGENT_SYSTEM_LEDGER_DB: ledgerPath,
		AGENT_SYSTEM_WORKLOAD_ID: wl,
		AGENT_SYSTEM_LANE_ID: "lane-a",
		AGENT_SYSTEM_CONTRACT: "/nonexistent",
		HOME: home,
		PATH: process.env.PATH,
		PAIRED_CODING_STATE_DIR: tmp("pair-state"),
	};
	const h = host();
	// One fake host for three extensions, each typed against its own slice of OMP's API: the fake
	// carries every member the three read.
	const shared = h.pi as never;
	orchestratorSurface(shared, env);
	p11Gates(shared, env, async () => ON, CERTIFIED, o.cleanShell);
	bindPairedCoding(shared, { env });
	const sessionId = `sess-${++sessions}`;
	const ctx = {
		hasUI: false,
		cwd: repo,
		sessionManager: { getSessionId: () => sessionId, getHeader: () => null, getEntries: () => [] },
		ui: { notify: () => {} },
		setInterval: () => 0,
		setTimeout: () => 0,
		clearTimer: () => {},
		isIdle: () => true,
		hasPendingMessages: () => false,
		getSystemPrompt: () => [],
		shutdown: () => {},
	};
	await h.emit("session_start", { type: "session_start" }, ctx);
	let n = 0;
	const call = async (toolName: string, input: Record<string, unknown>, o2: { execInput?: Record<string, unknown>; skipCall?: boolean; signal?: AbortSignal; id?: string } = {}) => {
		const toolCallId = o2.id ?? `${sessionId}-${toolName}-${++n}`;
		const gated = o2.skipCall ? undefined : await h.emit("tool_call", { type: "tool_call", toolName, toolCallId, input }, ctx);
		if (gated?.block) return { refused: gated.reason ?? "", text: "", details: undefined as unknown, isError: true };
		const params = o2.execInput ?? gated?.input ?? input;
		const r = await h.tool(toolName).execute(toolCallId, params, o2.signal, undefined, ctx);
		await h.emit("tool_result", { type: "tool_result", toolName, toolCallId, input: params, content: r.content, details: r.details, isError: r.isError === true }, ctx);
		return { refused: null, text: r.content.map((c) => c.text).join("\n"), details: r.details, isError: r.isError === true };
	};
	/** What the gates answer a call they see, without running it. */
	const verdict = async (toolName: string, input: Record<string, unknown>) =>
		h.emit("tool_call", { type: "tool_call", toolName, toolCallId: `${sessionId}-${toolName}-${++n}`, input }, ctx);
	const started = await call("pair_start", {});
	expect(started.text).toContain("Pairing started.");
	/** Agree a card on `boundary` and open its change set. */
	const open = async (boundary: string[]) => {
		const card = await call("pair_propose", { boundary, whyNow: "the header drifts", decision: "move the offset", currentCode: "a literal", effect: "one token", checks: ["the check passes"], openPoints: [] });
		const cardId = /Card (\S+) recorded/.exec(card.text)?.[1];
		expect(cardId).toBeDefined();
		await h.emit("input", { type: "input", text: "yes, go ahead with it", source: "interactive" }, ctx);
		const begun = await call("pair_begin", { cardId, quote: "go ahead" });
		expect(begun.text).toContain("is open");
	};
	return { sessionId, ledger, ledgerDir, ledgerPath, wl, sl, repo, env, home, call, verdict, open, emit: h.emit, tool: h.tool, ctx };
}

describe("pair_write and pair_edit are judged as the write and edit they are", () => {
	test("into the ledger file: row 10's refusal of that write, before anything runs", async () => {
		const l = await lane();
		await l.open(["src/a.txt"]);
		const write = await l.verdict("write", { path: l.ledgerPath, content: "x" });
		expect(write?.block).toBe(true);
		expect(write?.reason).toContain("P-11 row 10");
		const pairWrite = await l.call("pair_write", { path: l.ledgerPath, content: "x" });
		expect(pairWrite.refused).toBe(write!.reason!);
		const edit = await l.verdict("edit", { path: l.ledgerPath, oldString: "a", newString: "b" });
		const pairEdit = await l.call("pair_edit", { path: l.ledgerPath, oldString: "a", newString: "b" });
		expect(pairEdit.refused).toBe(edit!.reason!);
	});

	test("on a protected branch: row 9's refusal of that write, the relative path resolved at the worktree root", async () => {
		const l = await lane({ branch: "main" });
		await l.open(["src/a.txt"]);
		// The worktree root as the adapter resolves it: realpath'd (macOS's tmpdir is under the /var symlink).
		const write = await l.verdict("write", { path: join(realpathSync.native(l.repo), "src/a.txt"), content: "b\n" });
		expect(write?.reason).toContain("P-11 row 9");
		const pairWrite = await l.call("pair_write", { path: "src/a.txt", content: "b\n" });
		expect(pairWrite.refused).toBe(write!.reason!);
		expect(readFileSync(join(l.repo, "src/a.txt"), "utf8")).toBe("a\n");
	});

	test("outside the gates: a pair_write the gates never saw, or whose path changed after they allowed it, is refused at execute and writes nothing", async () => {
		const l = await lane();
		await l.open(["src/a.txt", "src/b.txt"]);
		const unseen = await l.call("pair_write", { path: "src/a.txt", content: "unseen\n" }, { skipCall: true });
		expect(unseen.isError).toBe(true);
		expect(unseen.text).toContain("pair_write refused: the P-11 gates did not allow this call");
		const rewritten = await l.call("pair_write", { path: "src/a.txt", content: "a2\n" }, { execInput: { path: "src/b.txt", content: "a2\n" } });
		expect(rewritten.isError).toBe(true);
		expect(rewritten.text).toContain("are not the ones the P-11 gates checked");
		expect(readFileSync(join(l.repo, "src/a.txt"), "utf8")).toBe("a\n");
		expect(existsSync(join(l.repo, "src/b.txt"))).toBe(false);
	});

	test.skipIf(!NESTED)(`agreed, with the arguments the gates allowed: pair_write and pair_edit write their exact bytes, each with its write receipt${RUN_SKIP}`, async () => {
		const l = await lane();
		await l.open(["src/a.txt", "src/b.txt"]);
		const root = realpathSync.native(l.repo);
		const written = await l.call("pair_write", { path: "src/b.txt", content: "b\n\tsecond line\n" });
		expect(written.refused).toBeNull();
		expect(written.isError).toBe(false);
		expect(written.text).toBe("Wrote src/b.txt.");
		expect(readFileSync(join(l.repo, "src/b.txt"), "utf8")).toBe("b\n\tsecond line\n");
		const edited = await l.call("pair_edit", { path: "src/a.txt", oldString: "a\n", newString: "a, edited\n" });
		expect(edited.refused).toBeNull();
		expect(edited.isError).toBe(false);
		expect(edited.text).toBe("Edited src/a.txt.");
		expect(readFileSync(join(l.repo, "src/a.txt"), "utf8")).toBe("a, edited\n");
		expect(gateSession(l.ctx as never, l.env).history.filter((h) => h.kind === "write")).toEqual([
			{ kind: "write", path: join(root, "src/b.txt") },
			{ kind: "write", path: join(root, "src/a.txt") },
		]);
	});
});

describe("pair_run is judged as the bash call it is", () => {
	test("a hand-typed sandbox-exec wrapper: bash's own refusal", async () => {
		const l = await lane();
		const command = "/usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/sh -c 'touch src/x'";
		const bash = await l.verdict("bash", { command, cwd: l.repo });
		expect(bash?.block).toBe(true);
		const run = await l.call("pair_run", { command });
		expect(run.refused).toBe(bash!.reason!);
		expect(existsSync(join(l.repo, "src/x"))).toBe(false);
	});

	test("a destructive git command outside scratch: row 6's refusal of that bash, its reserved request recorded the same way", async () => {
		const l = await lane();
		const requests = () => l.ledger.entries(l.wl).filter((e) => e.kind === "reserved-request").map((e) => e.body.replace(/tool call \S+\)$/, "tool call <id>)"));
		const bash = await l.verdict("bash", { command: "git reset --hard HEAD~0", cwd: l.repo });
		expect(bash?.reason).toContain("P-11 row 6");
		const run = await l.call("pair_run", { command: "git reset --hard HEAD~0" });
		expect(run.refused).toBe(bash!.reason!);
		const [fromBash, fromPair] = requests();
		expect(requests()).toHaveLength(2);
		expect(fromPair).toBe(fromBash!);
	});

	test("a scratch-only exemption is refused: the pairing sandbox is not the confinement the exemption needs", async () => {
		const l = await lane();
		const root = scratchRootFor(l.home, l.wl);
		mkdirSync(join(root, "junk"), { recursive: true });
		l.env.AS2_SCRATCH = root;
		const run = await l.call("pair_run", { command: `rm -rf "$AS2_SCRATCH/junk"` });
		expect(run.refused).toBe(PAIR_RUN_CONFINED_REASON);
		expect(existsSync(join(root, "junk"))).toBe(true);
	});

	test("an allowed pair_run executes: the adapter runs it and reports its run", async () => {
		const l = await lane();
		const run = await l.call("pair_run", { command: "echo paired" });
		expect(run.refused).toBeNull();
		expect(typeof field(run.details, "runId")).toBe("string");
	});

	test.skipIf(!NESTED)(`an allowed pair_run runs inside the fence: it exits 0, and the OS denies its write into the ledger directory${RUN_SKIP}`, async () => {
		const l = await lane();
		const ok = await l.call("pair_run", { command: "echo paired" });
		expect(ok.isError).toBe(false);
		expect(ok.text).toContain("paired");
		const probe = join(l.ledgerDir, "probe");
		const denied = await l.call("pair_run", { command: `echo x > '${probe}'` });
		expect(denied.refused).toBeNull();
		expect(denied.isError).toBe(true);
		expect(existsSync(probe)).toBe(false);
	});
});

describe("a pair_run of a declared artifact records its real outcome", () => {
	/** A started lane with `command` declared as its slice's artifact. */
	const declared = async (command: string) => {
		const l = await lane();
		const r = await l.tool(ARTIFACT_TOOL).execute("d1", { slice: l.sl, command }, undefined, undefined, l.ctx);
		expect(r.content[0]!.text).toMatch(/^Declared the runtime artifact of sl-/);
		return l;
	};
	const outcomes = (l: { ledger: Ledger; wl: string }) =>
		l.ledger.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE workload_id = ? AND (body LIKE 'artifact-failed:%' OR body LIKE 'artifact-passed:%') ORDER BY rowid").all(l.wl).map((m) => m.body);

	test("a failing run writes artifact-failed with its exit code; an undeclared run writes nothing", async () => {
		const flag = join(tmp("pair-flag"), "ready");
		const command = `test -f '${flag}'`;
		const l = await declared(command);
		await l.call("pair_run", { command: "echo not the artifact" });
		expect(outcomes(l)).toEqual([]);
		const run = await l.call("pair_run", { command });
		const code = field(run.details, "exitCode");
		expect(typeof code).toBe("number");
		expect(code).not.toBe(0);
		expect(outcomes(l)).toHaveLength(1);
		expect(outcomes(l)[0]).toContain(`\`${command}\` exited ${code} (tool call ${l.sessionId}-pair_run-`);
		expect(artifactTrees(l.ledger, l.wl)).toEqual([]);
	});

	test.skipIf(!NESTED)(`a passing run after a failure writes artifact-passed and the tree it ran on${RUN_SKIP}`, async () => {
		const flag = join(tmp("pair-flag"), "ready");
		const command = `test -f '${flag}'`;
		const l = await declared(command);
		await l.call("pair_run", { command });
		writeFileSync(flag, "");
		const run = await l.call("pair_run", { command });
		expect(run.isError).toBe(false);
		const bodies = outcomes(l);
		expect(bodies.map((b) => b.slice(0, 16))).toEqual(["artifact-failed:", "artifact-passed:"]);
		expect(bodies[1]).toContain(`\`${command}\` exited 0`);
		expect(artifactTrees(l.ledger, l.wl).map((t) => [t.sliceId, t.command])).toEqual([[l.sl, command]]);
	});

	test("a run after which pairing stops writes artifact-failed with its real exit and its bash receipt, and no tree", async () => {
		const command = "exit 3";
		const l = await declared(command);
		await l.open(["src/link"]);
		// A link appears where the run may write while it is in flight, so the adapter's post-run link
		// check stops pairing after the run. The signal's first read is the adapter's, right after the
		// spawn (plugins/paired-coding/lib/host-io.mjs runSandboxed); making the link there reproduces the
		// stop even where sandbox-exec cannot run the command itself.
		const link = join(l.repo, "src/link");
		const signal = {
			get aborted() {
				if (!existsSync(link)) symlinkSync("a.txt", link);
				return false;
			},
			addEventListener: () => {},
			removeEventListener: () => {},
		} as unknown as AbortSignal;
		const run = await l.call("pair_run", { command }, { signal });
		expect(run.refused).toBeNull();
		expect(run.isError).toBe(true);
		expect(run.text).toContain("pair_run refused: STOPPED: pair_run made a link or a .git entry");
		expect(outcomes(l)).toHaveLength(1);
		expect(outcomes(l)[0]).toStartWith("artifact-failed:");
		const code = field(run.details, "exitCode");
		expect(typeof code).toBe("number");
		expect(code).not.toBe(0);
		if (NESTED) expect(code).toBe(3);
		expect(outcomes(l)[0]).toContain(`\`${command}\` exited ${code} (tool call ${l.sessionId}-pair_run-`);
		expect(gateSession(l.ctx as never, l.env).history.at(-1)).toEqual({ kind: "bash", command, exitCode: code });
		expect(artifactTrees(l.ledger, l.wl)).toEqual([]);
	});

	test.skipIf(!NESTED)(`a run that exits 0 and makes a link, so pairing stops, is a failure after a failure: no artifact-passed and no tree${RUN_SKIP}`, async () => {
		const flag = join(tmp("pair-flag"), "ready");
		const command = `test -f '${flag}' && ln -s a.txt src/link`;
		const l = await declared(command);
		await l.open(["src/link"]);
		await l.call("pair_run", { command });
		writeFileSync(flag, "");
		const run = await l.call("pair_run", { command });
		expect(run.text).toContain("pair_run refused: STOPPED:");
		const bodies = outcomes(l);
		expect(bodies.map((b) => b.slice(0, 16))).toEqual(["artifact-failed:", "artifact-failed:"]);
		expect(bodies[1]).toContain(`\`${command}\` exited 1`);
		expect(gateSession(l.ctx as never, l.env).history.at(-1)).toEqual({ kind: "bash", command, exitCode: 1 });
		expect(artifactTrees(l.ledger, l.wl)).toEqual([]);
	});

	test("a run during which the partner types pair stop writes one artifact-failed and its bash receipt, and no tree or pass", async () => {
		const command = "exit 3";
		const l = await declared(command);
		await l.open(["src/link"]);
		// While the run is in flight a link appears where it may write, and the partner types pair stop,
		// which reaches the adapter's input handler as OMP emits it. The stop ends pairing before the run
		// ends, so runEnd journals no end of it, and the post-run link check returns the stop with no
		// result. As above, the signal's first read is the adapter's, right after the spawn.
		const link = join(l.repo, "src/link");
		let typed: Promise<unknown> | undefined;
		const signal = {
			get aborted() {
				if (!typed) {
					symlinkSync("a.txt", link);
					typed = l.emit("input", { type: "input", text: "pair stop", source: "interactive" }, l.ctx);
				}
				return false;
			},
			addEventListener: () => {},
			removeEventListener: () => {},
		} as unknown as AbortSignal;
		const run = await l.call("pair_run", { command }, { signal });
		expect(typed).toBeDefined();
		await typed;
		expect(run.refused).toBeNull();
		expect(run.isError).toBe(true);
		expect(run.text).toContain("pair_run refused: STOPPED: pair_run made a link or a .git entry");
		// The path under test: the journal holds the run's start, the typed stop after it, and no end.
		const runId = field(run.details, "runId");
		expect(typeof runId).toBe("string");
		const journal = readFileSync(join(sessionDirFor(l.sessionId, l.env)!, "journal.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; runId?: string });
		expect(journal.filter((e) => e.runId === runId).map((e) => e.type)).toEqual(["run-start"]);
		expect(journal.findLastIndex((e) => e.type === "stop")).toBeGreaterThan(journal.findIndex((e) => e.runId === runId));
		const bodies = outcomes(l);
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toStartWith("artifact-failed:");
		expect(bodies[0]).toContain(`\`${command}\` exited 1 (tool call ${l.sessionId}-pair_run-`);
		expect(gateSession(l.ctx as never, l.env).history.at(-1)).toEqual({ kind: "bash", command, exitCode: 1 });
		expect(artifactTrees(l.ledger, l.wl)).toEqual([]);
	});

	test("a later pair_run that reuses an earlier run's tool call id and is refused before its start records nothing", async () => {
		const command = "exit 3";
		const l = await declared(command);
		await l.open(["src/link"]);
		// Run A with id X: its post-run link check stops pairing, so the session is halted and the journal
		// holds A's run-start and run-end under X.
		const link = join(l.repo, "src/link");
		const signal = {
			get aborted() {
				if (!existsSync(link)) symlinkSync("a.txt", link);
				return false;
			},
			addEventListener: () => {},
			removeEventListener: () => {},
		} as unknown as AbortSignal;
		const id = `${l.sessionId}-pair_run-reused`;
		const first = await l.call("pair_run", { command }, { signal, id });
		expect(first.text).toContain("pair_run refused: STOPPED: pair_run made a link or a .git entry");
		expect(field(first.details, "runId")).toBe(id);
		const history = gateSession(l.ctx as never, l.env).history.length;
		// A later prompt's provider reuses X for the same declared command: runStart refuses it on the
		// halted session before it journals a start, so it never ran.
		const second = await l.call("pair_run", { command }, { id });
		expect(second.refused).toBeNull();
		expect(second.isError).toBe(true);
		expect(second.text).toContain("pair_run refused: the session is stopped");
		// The journal is append-only: X still has A's start and end, and nothing of the refused call.
		const journal = readFileSync(join(sessionDirFor(l.sessionId, l.env)!, "journal.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; runId?: string });
		expect(journal.filter((e) => e.runId === id && e.type.startsWith("run-")).map((e) => e.type)).toEqual(["run-start", "run-end"]);
		expect(field(second.details, "runId")).toBeUndefined();
		expect(field(second.details, "exitCode")).toBeUndefined();
		expect(gateSession(l.ctx as never, l.env).history).toHaveLength(history);
		expect(outcomes(l)).toHaveLength(1);
		expect(artifactTrees(l.ledger, l.wl)).toEqual([]);
	});
});

describe("pairing lets the as2 lifecycle tools through (VENDOR.md C8)", () => {
	test("a lane tool is allowed while pairing; the host's own mutation and an unknown tool stay refused", async () => {
		const l = await lane();
		expect(await l.verdict(LANE_RECORD_ENTRY_TOOL, { body: "an assumption" })).toBeUndefined();
		const bash = await l.verdict("bash", { command: "echo hi", cwd: l.repo });
		expect(bash?.reason).toContain("paired coding: bash is the host's own mutating tool");
		const unknown = await l.verdict("some_other_tool", {});
		expect(unknown?.reason).toContain("paired coding: some_other_tool is not on the pairing allowlist");
	});
});

describe("with the clean shell on, pair_run's /bin/sh must start hook-free", () => {
	const ALL: CleanShellCheck = async () => ({ ok: true, value: "all" });

	test("a BASH_ENV in the env pair_run starts /bin/sh with refuses the run, naming it; without it the run proceeds", async () => {
		const l = await lane({ cleanShell: ALL });
		const saved = process.env.BASH_ENV;
		process.env.BASH_ENV = join(l.home, "hook.sh");
		try {
			const hooked = await l.call("pair_run", { command: "echo paired" });
			expect(hooked.refused).toBeNull();
			expect(hooked.isError).toBe(true);
			expect(hooked.text).toStartWith(`pair_run refused: ${shellStartReason([]).slice(0, 40)}`);
			expect(hooked.text).toContain("BASH_ENV");
			expect(field(hooked.details, "runId")).toBeUndefined();
		} finally {
			if (saved === undefined) delete process.env.BASH_ENV;
			else process.env.BASH_ENV = saved;
		}
		const clean = await l.call("pair_run", { command: "echo paired" });
		expect(typeof field(clean.details, "runId")).toBe("string");
	});
});
