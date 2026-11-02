// The auto-apply gate (PLAN wl-mvqwn80onq9hq8 D2b fence, D3, D4, D5): row 6's extension lets a reserved bash call
// through only after its `auto-applied:` row and notice commit, marks it for the fence's read-only, confined or worktree
// profile, and after the call writes its result, trips on a gh request that may write, unseen gh traffic or a fence
// denial, and, when that write fails, leaves an alarm-file line, an isError result and a process-local trip.
// The tests under "behaviour under sandbox-exec" run the profiles through sandbox-exec; inside another Seatbelt
// sandbox (a fenced lane's own bash) sandbox-exec cannot apply a profile, so they are skipped there and say so.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorLines } from "../../surface/src/errors";
import { ensureStandingWorkload } from "../../surface/src/identity";
import { ESCALATION_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../../surface/src/types";
import { LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import reservedRow, { type AutoApplyOptions, detectTrip, exitOf, fullOutput } from "../extensions/r06-reserved";
import {
	execAllowList,
	type FenceSettings,
	fenceProfile,
	NETWORK_ENV_PREFIX,
	READ_ONLY_UNFENCED_REASON,
	registerFence,
	worktreeFence,
} from "../src/fence";
import { registerPairCalls, PAIR_RUN_CONFINED_REASON } from "../src/pair-call";
import type { RoutineVerdict } from "../src/routine";
import { ALARM_FILE_NAME, routineOn } from "../src/routine-switch";
import { CLASSIFY_DEADLINE_MS, classifyUnderDeadline, parseVerdict } from "../src/routine-worker";
import { SCRATCH_ENV, scratchRootFor } from "../src/scratch";
import { type Ctx, callMark, type GatesAPI, gateSession, markReadOnly } from "../src/session";
import { LANE_ENV, WORKLOAD_ENV } from "../src/types";
import { commit, git, tempLedger, tmp } from "./helpers";

type AnyHandler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type Result = { block?: boolean; reason?: string; input?: Record<string, unknown>; content?: unknown[]; isError?: boolean } | undefined;

const ON: FenceSettings = { enabled: true, autoBackground: true };
const OFF: FenceSettings = { enabled: false, autoBackground: true };

/** A fake OMP extension API chaining handlers as the runner does: tool_call stops at the first block; the last result stands. */
function fakePi() {
	const handlers = new Map<string, AnyHandler[]>();
	const entries: { type: string; data: unknown }[] = [];
	const pi = {
		on: (name: string, h: AnyHandler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		getActiveTools: () => ["bash"],
		getAllTools: () => [{ name: "bash" }],
		setActiveTools: async () => {},
		appendEntry: (type: string, data?: unknown) => entries.push({ type, data }),
		registerTool: () => {},
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
	return { pi: pi as unknown as GatesAPI, emit, entries };
}

const notes: string[] = [];
/** A lane's session context (a hand's with `hand`); a fresh one is a fresh gate session. */
const ctxOf = (cwd: string, o: { hand?: boolean; artifacts?: Record<string, string> } = {}): Ctx => ({
	hasUI: !o.hand,
	cwd,
	sessionManager: {
		getHeader: () => (o.hand ? { parentSession: "parent" } : null),
		getEntries: () => [],
		...(o.artifacts ? { getArtifactPath: async (id: string) => o.artifacts![id] ?? null } : {}),
	},
	ui: { notify: (m: string) => notes.push(m) },
});

/** Probe once: can sandbox-exec apply a profile here (not inside another sandbox)? */
const SANDBOX = spawnSync("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
if (!SANDBOX) console.warn("routine-gate.test.ts: sandbox-exec cannot apply a profile here (nested sandbox?); the behaviour-under-sandbox-exec tests are skipped");

/** A lane bound to a fresh workload with one open slice, its own scratch root, and the alarm file beside its ledger. */
function lane() {
	const { ledger, path } = tempLedger();
	ensureStandingWorkload(ledger);
	const wl = ledger.openWorkload({ by: "orch", brief: "b", stakes: "normal", mode: "autonomous" });
	const sl = ledger.addSlice({ by: "orch", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
	const home = realpathSync(tmp("rg-home"));
	const root = scratchRootFor(home, wl);
	mkdirSync(root, { recursive: true });
	const env: Record<string, string | undefined> = {
		HOME: home, PATH: process.env.PATH, AGENT_SYSTEM_LEDGER_DB: path, [WORKLOAD_ENV]: wl, [LANE_ENV]: "lane-1", [SCRATCH_ENV]: root,
	};
	return { ledger, path, wl, sl, home, root: realpathSync(root), env, alarmFile: join(dirname(path), ALARM_FILE_NAME) };
}
type Lane = ReturnType<typeof lane>;

/** Row 6 (and, with `fence`, the fence after it, as gates/index.ts orders them) on a fresh fake API. */
function rows(l: Lane, o: AutoApplyOptions & { fence?: FenceSettings } = {}) {
	const f = fakePi();
	const { fence, ...opts } = o;
	reservedRow(f.pi, l.env, { fenceOn: async () => true, ...opts });
	if (fence) registerFence(f.pi, l.env, async () => fence);
	return f;
}

let n = 0;
const call = (command: string, cwd?: string) => ({ toolName: "bash", toolCallId: `rg-${++n}`, input: cwd ? { command, cwd } : { command } });
const READ = "for p in 304 305; do gh pr view $p --json state; done";
const SCRATCH = 'cd "$AS2_SCRATCH" && rm -rf a b';
const control = (ledger: Ledger, wl: string, prefix: string) => ledger.entries(wl, "assumption").filter((e) => e.body.startsWith(`${prefix}:`) && e.created_by === ESCALATION_BY);
const noticesOf = (ledger: Ledger, wl: string) =>
	ledger.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE workload_id = ? AND body LIKE 'notice:%' ORDER BY created_at, rowid").all(wl).map((m) => m.body);
const requests = (ledger: Ledger, wl: string) => ledger.entries(wl, "reserved-request").map((e) => e.body);
const jo = (ledger: Ledger, body: string) => ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body, author: "jo", channel: "surface" });
const verdict = (v: RoutineVerdict) => async () => v;

afterEach(() => {
	notes.length = 0;
});

describe("R6: an auto-apply commits its row and notice, in one write, before the call is marked", () => {
	test("a gh read loop: one auto-applied: row naming rule, call id, lane, cwd, net and command on the slice, one notice, then the read-only mark (real worker)", async () => {
		const l = lane();
		const f = rows(l);
		const c = call(READ);
		const ctx = ctxOf(l.home);
		expect(await f.emit("tool_call", c, ctx)).toBeUndefined();
		const rows_ = control(l.ledger, l.wl, "auto-applied");
		expect(rows_.map((e) => [e.body, e.slice_id])).toEqual([[`auto-applied: read-only ${c.toolCallId} by lane-1 cwd ${l.home} net yes: ${READ}`, l.sl]]);
		expect(noticesOf(l.ledger, l.wl)).toEqual([`notice: auto-applied (read-only) on ${l.wl}: ${READ}`]);
		expect(callMark(c.toolCallId)).toEqual({ kind: "read-only", network: true, readers: [] });
		expect(requests(l.ledger, l.wl)).toEqual([]);
	});

	test("a scratch rm: rule scratch, marked confined to the own root; a hand's call auto-applies under its hand id", async () => {
		const l = lane();
		const c = call(SCRATCH);
		expect(await rows(l).emit("tool_call", c, ctxOf(l.home))).toBeUndefined();
		expect(control(l.ledger, l.wl, "auto-applied")[0]!.body).toBe(`auto-applied: scratch ${c.toolCallId} by lane-1 cwd ${l.home} net no: ${SCRATCH}`);
		expect(callMark(c.toolCallId)).toEqual({ kind: "confined", root: l.root });
		const h = call(SCRATCH);
		expect(await rows(l).emit("tool_call", h, ctxOf(l.home, { hand: true }))).toBeUndefined();
		expect(control(l.ledger, l.wl, "auto-applied").map((e) => e.body.split(" ").slice(1, 5).join(" "))).toEqual([`scratch ${c.toolCallId} by lane-1`, `scratch ${h.toolCallId} by lane-1`]);
	});

	test("Jo's ask-all, read inside the write: the reserved-request is written as today, naming why, and nothing is marked", async () => {
		const l = lane();
		jo(l.ledger, "ask-all");
		const c = call(READ);
		const r = await rows(l).emit("tool_call", c, ctxOf(l.home));
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("§ A4");
		expect(requests(l.ledger, l.wl)).toEqual([expect.not.stringContaining("not auto-applied")]);
		expect(control(l.ledger, l.wl, "auto-applied")).toEqual([]);
		expect(noticesOf(l.ledger, l.wl)).toEqual([]);
		expect(callMark(c.toolCallId)).toBeUndefined();
	});

	test("a classifier ask takes today's path, its reason in the request body; a non-reserved refusal and a non-bash tool never reach the classifier", async () => {
		const l = lane();
		let asked = 0;
		const f = rows(l, { classify: async () => (asked++, { ask: "not read-only: x; not confined: y" }) });
		const r = await f.emit("tool_call", call("git push --force origin main"), ctxOf(l.home));
		expect(r?.block).toBe(true);
		// A ruling ask keeps today's body word for word.
		expect(requests(l.ledger, l.wl)).toEqual([expect.not.stringContaining("not auto-applied")]);
		expect(asked).toBe(1);
		expect((await f.emit("tool_call", call("git -c alias.p=push p"), ctxOf(l.home)))?.block).toBe(true);
		expect(asked).toBe(1);
		// pair_run is judged as its bash equivalent, but only bash calls auto-apply (pair_run cannot run a marked call).
		const pr = await f.emit("tool_call", { toolName: "pair_run", toolCallId: `rg-${++n}`, input: { command: READ } }, ctxOf(l.home));
		expect(pr?.block).toBe(true);
		expect(asked).toBe(1);
		// A call the gate never considers keeps today's body word for word.
		expect(requests(l.ledger, l.wl).at(-1)).not.toContain("not auto-applied");
	});
});

describe("R7: every failure before the commit falls back to today's refusal and reserved-request", () => {
	test("a classifier error, and a failed row or notice write: refused, nothing marked, no auto-applied row, the request names it", async () => {
		const l = lane();
		const thrown = await rows(l, { classify: async () => Promise.reject(new Error("boom")) }).emit("tool_call", call(READ), ctxOf(l.home));
		expect(thrown?.block).toBe(true);
		expect(requests(l.ledger, l.wl)).toEqual([expect.stringContaining("(not auto-applied: classifier error: boom)")]);

		// The notice write throws inside the deciding transaction: the auto-applied row rolls back with it.
		const ctx = ctxOf(l.home);
		const sessionLedger = gateSession(ctx, l.env).ledger();
		const enqueue = spyOn(sessionLedger, "enqueue").mockImplementationOnce(() => {
			throw new Error("SQLITE_FULL: database or disk is full");
		});
		const c = call(READ);
		const failed = await rows(l, { classify: verdict({ rule: "read-only", detail: "d", network: true, readers: [] }) }).emit("tool_call", c, ctx);
		enqueue.mockRestore();
		expect(failed?.block).toBe(true);
		expect(callMark(c.toolCallId)).toBeUndefined();
		expect(control(l.ledger, l.wl, "auto-applied")).toEqual([]);
		expect(requests(l.ledger, l.wl).at(-1)).toContain("(not auto-applied: auto-apply failed: SQLITE_FULL: database or disk is full)");

		// The deciding write and the request write both fail: the notify names both errors.
		const write = spyOn(sessionLedger, "write").mockImplementation(() => {
			throw new Error("database is locked");
		});
		const both = call(READ);
		const r = await rows(l, { classify: verdict({ rule: "read-only", detail: "d", network: true, readers: [] }) }).emit("tool_call", both, ctx);
		write.mockRestore();
		expect(r?.block).toBe(true);
		expect(callMark(both.toolCallId)).toBeUndefined();
		expect(notes.at(-1)).toContain("could not be written");
		expect(notes.at(-1)).toContain("before that, auto-apply failed: database is locked");

		// A ledger read inside the deciding write fails (routineOn reads Jo's words): refused, nothing marked.
		const read = spyOn(sessionLedger, "instructions").mockImplementation(() => {
			throw new Error("SQLITE_CORRUPT: database disk image is malformed");
		});
		const unread = call(READ);
		const r3 = await rows(l, { classify: verdict({ rule: "read-only", detail: "d", network: true, readers: [] }) }).emit("tool_call", unread, ctx);
		read.mockRestore();
		expect(r3?.block).toBe(true);
		expect(callMark(unread.toolCallId)).toBeUndefined();
		expect(requests(l.ledger, l.wl).at(-1)).toContain("(not auto-applied: auto-apply failed: SQLITE_CORRUPT: database disk image is malformed)");
		expect(control(l.ledger, l.wl, "auto-applied")).toEqual([]);
	});

	test("an unreadable alarm file reads as a latch: today's path, never auto-apply", async () => {
		const l = lane();
		mkdirSync(l.alarmFile);
		const c = call(READ);
		expect((await rows(l).emit("tool_call", c, ctxOf(l.home)))?.block).toBe(true);
		expect(requests(l.ledger, l.wl)).toEqual([expect.not.stringContaining("not auto-applied")]);
		expect(callMark(c.toolCallId)).toBeUndefined();
	});

	// The deadline is driven through the `deadline` seam: the test fires it itself, so nothing here races a wall clock.
	test("the worker: its verdict is routineVerdict's; a stall past the deadline, a throw, an exit and a malformed reply each ask", async () => {
		const l = lane();
		const ctx = { role: "lane" as const, cwd: l.home, env: l.env, mode: null };
		expect(CLASSIFY_DEADLINE_MS).toBe(2000);
		// a deadline that never fires: each outcome below is the worker's own, never a race with a clock
		const never = { deadline: () => () => {} };
		const armed: { ms: number; fire: () => void }[] = [];
		const fake = { deadline: (ms: number, fire: () => void) => (armed.push({ ms, fire }), () => {}) };
		expect(await classifyUnderDeadline({ toolName: "bash", input: { command: READ } }, ctx, never)).toEqual({ rule: "read-only", detail: "read-only: for, gh", network: true, readers: [] });
		const dir = tmp("rg-workers");
		const worker = (name: string, body: string): string => {
			writeFileSync(join(dir, name), body);
			return join(dir, name);
		};
		const stalled = classifyUnderDeadline({ toolName: "bash", input: { command: READ } }, ctx, { entry: worker("stall.ts", "self.onmessage = () => { for (;;) {} };"), ...fake });
		expect(armed.map((a) => a.ms)).toEqual([CLASSIFY_DEADLINE_MS]);
		armed[0]!.fire();
		expect(await stalled).toEqual({ ask: `classifier timeout after ${CLASSIFY_DEADLINE_MS} ms` });
		const thrown = await classifyUnderDeadline({ toolName: "bash", input: { command: READ } }, ctx, { entry: worker("throw.ts", 'self.onmessage = () => { throw new Error("lstat stalled"); };'), ...never });
		expect("ask" in thrown && thrown.ask).toContain("classifier worker failed");
		const exited = await classifyUnderDeadline({ toolName: "bash", input: { command: READ } }, ctx, { entry: worker("exit.ts", "self.onmessage = () => process.exit(0);"), ...never });
		expect("ask" in exited).toBe(true);
		expect(await classifyUnderDeadline({ toolName: "bash", input: { command: READ } }, ctx, { entry: worker("bad.ts", 'self.onmessage = () => postMessage({ rule: "read-only" });'), ...never })).toEqual({
			ask: 'the classifier worker posted a malformed reply ({"rule":"read-only"})',
		});
		const broken = await classifyUnderDeadline({ toolName: "bash", input: { command: READ } }, ctx, { deadline: () => { throw new Error("no timer"); } });
		expect(broken).toEqual({ ask: "classifier worker failed: no timer" });
		expect(parseVerdict({ rule: "scratch", detail: "d", network: false, root: "relative" })).toEqual({ ask: expect.stringContaining("malformed") });
		expect(parseVerdict({ rule: "worktree", detail: "d", network: true, root: "/x" })).toEqual({ ask: expect.stringContaining("malformed") });
	});
});

describe("R5: read-only runs with no file writes and network only for gh; scratch runs confined; with the fence off nothing auto-applies", () => {
	test("the fence wraps an auto-applied gh read under the read-only network profile, the network env in front, stderr untouched", async () => {
		const l = lane();
		const c = call(READ);
		const r = await rows(l, { fence: ON }).emit("tool_call", c, ctxOf(l.home));
		const wrapped = String(r?.input?.command);
		expect(wrapped.startsWith(NETWORK_ENV_PREFIX)).toBe(true);
		expect(NETWORK_ENV_PREFIX).toBe("GH_DEBUG=api GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 ");
		expect(wrapped).toContain(`(deny file-write*)(allow file-write* (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))(deny process-exec*)(allow process-exec* (literal "/bin/bash")`);
		expect(wrapped).not.toContain("(deny network-outbound");
		expect(wrapped).not.toContain("(allow file-write* (subpath");
		// The command itself is passed through unchanged: no redirect of gh's stderr is added.
		expect(wrapped.endsWith(`/bin/bash -c '${READ}'`)).toBe(true);
	});

	test("an auto-applied scratch rm runs under the confined profile", async () => {
		const l = lane();
		const r = await rows(l, { fence: ON }).emit("tool_call", call(SCRATCH), ctxOf(l.home));
		const wrapped = String(r?.input?.command);
		expect(wrapped).toContain(`(deny file-write*)(allow file-write* (subpath "${l.root}")`);
		expect(wrapped).toContain("(deny network-outbound (remote ip))");
		expect(wrapped.startsWith(NETWORK_ENV_PREFIX)).toBe(false);
	});

	test("the read-only profile without network denies outbound network and starts any program", () => {
		expect(fenceProfile([], { kind: "read-only", network: false, execAllow: [] })).toBe(
			'(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))(deny network-outbound (remote ip))',
		);
	});

	test("with the fence off (its own settings reader) the call takes today's path; a read-only mark with the fence off is refused; pair_run refuses a marked call", async () => {
		const l = lane();
		const f = fakePi();
		reservedRow(f.pi, l.env);
		registerFence(f.pi, l.env, async () => OFF);
		const c = call(READ);
		const r = await f.emit("tool_call", c, ctxOf(l.home));
		expect(r?.block).toBe(true);
		expect(requests(l.ledger, l.wl)).toEqual([expect.not.stringContaining("not auto-applied")]);
		expect(control(l.ledger, l.wl, "auto-applied")).toEqual([]);

		const marked = call("ls");
		markReadOnly(marked, false);
		const g = fakePi();
		registerFence(g.pi, l.env, async () => OFF);
		expect(await g.emit("tool_call", marked, ctxOf(l.home))).toEqual({ block: true, reason: READ_ONLY_UNFENCED_REASON });

		const paired = { toolName: "pair_run", toolCallId: `rg-${++n}`, input: { command: "ls" } };
		markReadOnly(paired, true, []);
		const p = fakePi();
		registerPairCalls(p.pi, l.env, async () => ON);
		expect(await p.emit("tool_call", paired, ctxOf(l.home))).toEqual({ block: true, reason: PAIR_RUN_CONFINED_REASON });
	});
});

describe("R19: a call granted network runs under an exec allow-list with GIT_NO_LAZY_FETCH=1", () => {
	test("the allow-list holds /bin/bash, gh, git's real exec chain and the named readers, each by its path and its canonical path", () => {
		const list = execAllowList(["jq", "head", "echo-is-a-builtin-not-on-path"], { PATH: process.env.PATH });
		expect(list[0]).toBe("/bin/bash");
		for (const name of ["gh", "git", "jq", "head"]) {
			const found = Bun.which(name, { PATH: process.env.PATH });
			if (found) expect(list).toContain(found);
			if (found) expect(list).toContain(realpathSync(found));
		}
		if (list.includes("/usr/bin/git")) {
			expect(list).toContain("/usr/bin/xcrun");
			if (existsSync("/Library/Developer/CommandLineTools/usr/bin/git")) expect(list).toContain(realpathSync("/Library/Developer/CommandLineTools/usr/bin/git"));
		}
		expect(list.some((p) => p.includes("echo-is-a-builtin"))).toBe(false);
		expect(new Set(list).size).toBe(list.length);
	});

	test("the network profile denies every program start but the list; a list without /bin/bash is refused", () => {
		expect(fenceProfile([], { kind: "read-only", network: true, execAllow: ["/bin/bash", "/opt/gh"] })).toBe(
			'(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))(deny process-exec*)(allow process-exec* (literal "/bin/bash") (literal "/opt/gh"))',
		);
		expect(() => fenceProfile([], { kind: "read-only", network: true, execAllow: ["/opt/gh"] })).toThrow("lacks /bin/bash");
	});

	test("an exec denial in the output trips", () => {
		expect(detectTrip("> GET /x HTTP/1.1\nsandbox: deny(1) process-exec /usr/bin/curl", true, 0)).toEqual({ signal: "fence-denial", evidence: "sandbox: deny(1) process-exec /usr/bin/curl" });
		expect(detectTrip("> GET /x HTTP/1.1\nbash: line 1: /usr/bin/curl: Operation not permitted", true, 126)?.signal).toBe("fence-denial");
	});
});

describe("R8: a gh request that may write, unseen gh traffic or a fence denial trips", () => {
	test("the detector reads gh's GH_DEBUG request lines", () => {
		expect(detectTrip("> GET /repos/o/r/pulls/1 HTTP/1.1\n{}", true, 0)).toBeNull();
		expect(detectTrip("> PATCH /repos/o/r/pulls/1 HTTP/1.1", true, 0)).toEqual({ signal: "gh-write", evidence: "> PATCH /repos/o/r/pulls/1 HTTP/1.1" });
		expect(detectTrip("> DELETE /repos/o/r/git/refs/heads/x HTTP/1.1", true, 1)?.signal).toBe("gh-write");
		// gh's read subcommands read through GraphQL POSTs: a query block passes, a mutation or no block trips.
		expect(detectTrip("> POST /graphql HTTP/1.1\n> Host: api.github.com\nGraphQL query:\nquery PullRequestList(\n  $owner: String!\n)", true, 0)).toBeNull();
		expect(detectTrip("> POST /graphql HTTP/1.1\nGraphQL query:\nmutation MergePullRequest($id: ID!) {", true, 0)?.signal).toBe("gh-write");
		expect(detectTrip("> POST /graphql HTTP/1.1\n{}", true, 0)?.signal).toBe("gh-write");
		expect(detectTrip("> POST /graphql HTTP/1.1\n> POST /graphql HTTP/1.1\nGraphQL query:\nquery X {", true, 0)?.signal).toBe("gh-write");
		expect(detectTrip("> POST /repos/o/r/issues HTTP/1.1", true, 0)?.signal).toBe("gh-write");
		// No request line on a clean exit: gh's traffic was not seen. A failed exit with none does not trip on that.
		expect(detectTrip("[]", true, 0)).toEqual({ signal: "gh-traffic-unseen", evidence: "the call exited 0 and printed no gh request line (GH_DEBUG=api)" });
		expect(detectTrip("gh: not found", true, 127)).toBeNull();
		// Any rule: a Seatbelt denial.
		expect(detectTrip("rm: x: Operation not permitted", false, 1)?.signal).toBe("fence-denial");
		expect(detectTrip("> PATCH /x HTTP/1.1", false, 0)).toBeNull();
	});

	test("the exit and the whole output: a failed exit's code, a background start or a timeout unknown; a truncated output read from its artifact, or unreadable", async () => {
		expect(exitOf(undefined, false)).toBe(0);
		expect(exitOf({ exitCode: 2 }, true)).toBe(2);
		expect(exitOf({ async: { state: "running" } }, false)).toBe("unknown");
		expect(exitOf({ timedOut: true }, true)).toBe("unknown");
		expect(exitOf(undefined, true)).toBe("unknown");
		const text = [{ type: "text", text: "head" }];
		const art = join(tmp("rg-art"), "7.log");
		writeFileSync(art, "> PATCH /x HTTP/1.1\nfull");
		const spilled = { meta: { truncation: { artifactId: "7" } } };
		expect(await fullOutput(text, undefined, ctxOf("/"))).toEqual({ text: "head" });
		expect(await fullOutput(text, spilled, ctxOf("/", { artifacts: { "7": art } }))).toEqual({ text: "> PATCH /x HTTP/1.1\nfull" });
		expect(await fullOutput(text, spilled, ctxOf("/"))).toEqual({ unreadable: "the output was truncated and this host cannot resolve artifact 7" });
		expect(await fullOutput(text, { meta: { truncation: { artifactId: "7", artifactElidedBytes: 10 } } }, ctxOf("/"))).toEqual({ unreadable: "the output's artifact 7 is itself capped" });
		expect(await fullOutput(text, { meta: { truncation: {} } }, ctxOf("/"))).toEqual({ unreadable: "the output was truncated and no artifact holds the rest" });
		expect(await fullOutput(text, { async: {} }, ctxOf("/"))).toEqual({ unreadable: "the call went to the background, so its output is not in this result" });
	});

	test("at the result: auto-applied-result: on the slice; with a trip, auto-apply-tripped: on the standing workload and a notice, and auto-apply is off for every lane", async () => {
		const l = lane();
		const ctx = ctxOf(l.home);
		const f = rows(l, { fence: ON });
		const clean = call(READ);
		await f.emit("tool_call", clean, ctx);
		const ok = "> POST /graphql HTTP/1.1\nGraphQL query:\nquery PullRequest(\n{\"state\":\"OPEN\"}";
		expect(await f.emit("tool_result", { ...clean, content: [{ type: "text", text: ok }], isError: false }, ctx)).toBeUndefined();
		expect(control(l.ledger, l.wl, "auto-applied-result").map((e) => [e.body, e.slice_id])).toEqual([[`auto-applied-result: ${clean.toolCallId} exit 0`, l.sl]]);
		expect(callMark(clean.toolCallId)).toBeUndefined();
		expect(routineOn(l.ledger, Date.now(), { alarmFile: l.alarmFile })).toBe(true);

		const w = call(READ);
		await f.emit("tool_call", w, ctx);
		const art = join(tmp("rg-art"), "9.log");
		writeFileSync(art, "head\n> PATCH /repos/o/r/pulls/9 HTTP/1.1\ntail");
		await f.emit("tool_result", { ...w, content: [{ type: "text", text: "head … tail" }], details: { meta: { truncation: { artifactId: "9" } } }, isError: false }, ctxOf(l.home, { artifacts: { "9": art } }));
		expect(control(l.ledger, l.wl, "auto-applied-result").at(-1)!.body).toBe(`auto-applied-result: ${w.toolCallId} exit 0`);
		expect(control(l.ledger, STANDING_WORKLOAD_ID, "auto-apply-tripped").map((e) => e.body)).toEqual([`auto-apply-tripped: ${w.toolCallId} gh-write > PATCH /repos/o/r/pulls/9 HTTP/1.1`]);
		expect(noticesOf(l.ledger, l.wl).at(-1)).toBe(`notice: AUTO-APPLY TRIPPED by ${l.wl}: gh-write in a call ruled read-only; auto-apply is off for every lane until your auto-routine`);
		expect(routineOn(l.ledger, Date.now(), { alarmFile: l.alarmFile })).toBe(false);
		// The next reserved call takes today's path.
		expect((await f.emit("tool_call", call(READ), ctx))?.block).toBe(true);
		expect(requests(l.ledger, l.wl)).toHaveLength(1);
		expect(requests(l.ledger, l.wl)[0]).not.toContain("not auto-applied");
	});

	test("a call another row refuses after the gate let it through records exit refused at its end; a network call that went to the background trips unreadable", async () => {
		const l = lane();
		const ctx = ctxOf(l.home);
		const f = rows(l, { fence: OFF });
		const c = call(READ);
		// The fence is off by its own reader here while the gate's check said on: the fence refuses the marked call.
		expect(await f.emit("tool_call", c, ctx)).toEqual({ block: true, reason: READ_ONLY_UNFENCED_REASON });
		await f.emit("tool_execution_end", { toolName: "bash", toolCallId: c.toolCallId, result: {}, isError: true }, ctx);
		expect(control(l.ledger, l.wl, "auto-applied-result").map((e) => e.body)).toEqual([`auto-applied-result: ${c.toolCallId} exit refused`]);
		expect(control(l.ledger, STANDING_WORKLOAD_ID, "auto-apply-tripped")).toEqual([]);

		const g = rows(l);
		const bg = call(READ);
		await g.emit("tool_call", bg, ctx);
		await g.emit("tool_result", { ...bg, content: [{ type: "text", text: "Background job bg_1 started" }], details: { async: { state: "running", jobId: "bg_1" } }, isError: false }, ctx);
		// tool_execution_end after tool_result writes nothing more.
		await g.emit("tool_execution_end", { toolName: "bash", toolCallId: bg.toolCallId, result: {}, isError: false }, ctx);
		expect(control(l.ledger, l.wl, "auto-applied-result").map((e) => e.body).slice(1)).toEqual([`auto-applied-result: ${bg.toolCallId} exit unknown`]);
		expect(control(l.ledger, STANDING_WORKLOAD_ID, "auto-apply-tripped").map((e) => e.body)).toEqual([
			`auto-apply-tripped: ${bg.toolCallId} output-unreadable the call went to the background, so its output is not in this result`,
		]);
	});
});

describe("R9: a failed result or trip write leaves an alarm-file line, an AUTO-APPLY ALARM line and an isError result", () => {
	test("the trip write fails: one alarm line (kind trip, at), the result rewritten isError naming it, a local trip until Jo's auto-routine", async () => {
		const l = lane();
		const ctx = ctxOf(l.home);
		const f = rows(l);
		const c = call(READ);
		await f.emit("tool_call", c, ctx);
		const write = spyOn(gateSession(ctx, l.env).ledger(), "write").mockImplementationOnce(() => {
			throw new Error("database is locked");
		});
		const content = [{ type: "text", text: "> PUT /repos/o/r/pulls/1/merge HTTP/1.1" }];
		const r = await f.emit("tool_result", { ...c, content, isError: false }, ctx);
		write.mockRestore();
		expect(r).toEqual({
			content: [...content, { type: "text", text: "AUTO-APPLY TRIPPED: gh-write > PUT /repos/o/r/pulls/1/merge HTTP/1.1. The ledger write failed (database is locked). Report this line verbatim to your caller." }],
			isError: true,
		});
		const lines = readFileSync(l.alarmFile, "utf8").trim().split("\n").map((s) => JSON.parse(s));
		expect(lines).toEqual([
			{
				kind: "trip", at: expect.any(String), workload: l.wl, toolCallId: c.toolCallId, rule: "read-only", signal: "gh-write",
				evidence: "> PUT /repos/o/r/pulls/1/merge HTTP/1.1", command: READ, error: "database is locked",
			},
		]);
		expect(Number.isNaN(Date.parse(lines[0].at))).toBe(false);
		expect(control(l.ledger, l.wl, "auto-applied-result")).toEqual([]);
		// Every process reads the line as a latch; the surface shows it.
		expect(routineOn(l.ledger, Date.now(), { alarmFile: l.alarmFile })).toBe(false);
		expect(errorLines(l.ledger, l.ledger.inFlight(), { reportJobInstalled: () => false }).filter((e) => e.kind === "alarm").map((e) => e.line)).toEqual([
			`AUTO-APPLY ALARM ${l.wl} gh-write: > PUT /repos/o/r/pulls/1/merge HTTP/1.1; auto-apply is off; ledger write failed: database is locked (alarm-file line 1; your auto-routine clears it)`,
		]);
		// This process holds its own trip: named on the next call, until Jo's auto-routine is newer.
		await f.emit("tool_call", call(READ), ctx);
		expect(requests(l.ledger, l.wl).at(-1)).toMatch(/\(not auto-applied: this process holds an auto-apply trip from \S+ until Jo's auto-routine\)$/);
		// auto-routine must be strictly newer than the trip, whose `at` is the wall clock the gate read: Jo's word is
		// stamped one second after it through a second handle on the same ledger file with a fixed clock.
		const afterTrip = new Date(Date.parse(lines[0].at) + 1000).toISOString();
		const stamped = Ledger.open(l.path, { backup: false, backupOnOpen: false, clock: () => afterTrip });
		jo(stamped, "auto-routine");
		stamped.close();
		const again = call(READ);
		expect(await f.emit("tool_call", again, ctx)).toBeUndefined();
		expect(callMark(again.toolCallId)).toEqual({ kind: "read-only", network: true, readers: [] });
	});

	test("a lost result row writes kind result; an alarm write that fails too is named beside the ledger error", async () => {
		const l = lane();
		const ctx = ctxOf(l.home);
		const f = rows(l);
		const c = call(SCRATCH);
		await f.emit("tool_call", c, ctx);
		const ledger = gateSession(ctx, l.env).ledger();
		const write = spyOn(ledger, "write").mockImplementationOnce(() => {
			throw new Error("disk I/O error");
		});
		const r = await f.emit("tool_result", { ...c, content: [], isError: false }, ctx);
		write.mockRestore();
		expect(r?.isError).toBe(true);
		expect(JSON.stringify(r?.content)).toContain(`AUTO-APPLY TRIPPED: result-row-lost auto-applied-result: ${c.toolCallId} exit 0. The ledger write failed (disk I/O error).`);
		expect(JSON.parse(readFileSync(l.alarmFile, "utf8").trim())).toMatchObject({ kind: "result", signal: "result-row-lost", rule: "scratch", error: "disk I/O error" });

		// The alarm file cannot be written either (its directory is read-only, so it reads as absent): the result names both errors.
		const m = lane();
		const blocked = tmp("rg-blocked");
		chmodSync(blocked, 0o500);
		const ctx2 = ctxOf(m.home);
		const g = rows(m, { alarmFile: join(blocked, ALARM_FILE_NAME) });
		const d = call(READ);
		await g.emit("tool_call", d, ctx2);
		const w2 = spyOn(gateSession(ctx2, m.env).ledger(), "write").mockImplementationOnce(() => {
			throw new Error("database is locked");
		});
		const r2 = await g.emit("tool_result", { ...d, content: [{ type: "text", text: "sandbox: deny(1) file-write-create /x" }], isError: true, details: { exitCode: 1 } }, ctx2);
		w2.mockRestore();
		const text = JSON.stringify(r2?.content);
		expect(text).toContain("AUTO-APPLY TRIPPED: fence-denial");
		expect(text).toContain("The ledger write failed (database is locked). The alarm-file write failed too (");
		expect(notes.some((s) => s.includes("database is locked") && s.includes("the alarm-file write failed too"))).toBe(true);
	});
});

/** A linked worktree of a fresh repository on `wl/<wl>`, recorded as the workload's `worktree:` entry. */
function worktreeOf(l: Lane) {
	const main = realpathSync(tmp("rg-main"));
	git(main, "init", "-q", "-b", "main");
	commit(main, "f", "one\n");
	commit(main, "f", "two\n");
	const wt = join(realpathSync(tmp("rg-wt")), "wt");
	git(main, "worktree", "add", "-q", wt, "-b", `wl/${l.wl}`);
	l.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: l.wl, kind: "assumption", body: `worktree: ${wt}` });
	const gitDir = realpathSync(join(main, ".git", "worktrees", "wt"));
	return { main, wt, gitDir, common: realpathSync(join(main, ".git")) };
}

describe("R33: the worktree fence", () => {
	test("allows the worktree and its validated gitdir, denies the .git file, commondir, gitdir and config.worktree; a reset adds only the own branch's ref, lock and reflog", () => {
		const l = lane();
		const { wt, gitDir, common } = worktreeOf(l);
		const plain = worktreeFence(wt, l.wl, false);
		expect(plain.allow).toEqual([{ kind: "subpath", path: wt }, { kind: "subpath", path: gitDir }]);
		expect(plain.deny).toEqual([join(wt, ".git"), join(gitDir, "commondir"), join(gitDir, "gitdir"), join(gitDir, "config.worktree")].map((path) => ({ kind: "literal", path })));
		expect(plain.branch).toBe(`wl/${l.wl}`);
		const reset = worktreeFence(wt, l.wl, true);
		const ref = join(common, "refs", "heads", "wl", l.wl);
		expect(reset.allow.slice(2)).toEqual([{ kind: "literal", path: ref }, { kind: "literal", path: `${ref}.lock` }, { kind: "literal", path: join(common, "logs", "refs", "heads", "wl", l.wl) }]);
		const profile = fenceProfile([], { kind: "worktree", allow: reset.allow, deny: reset.deny });
		expect(profile).toBe(
			`(version 1)(allow default)(deny file-write*)(allow file-write* (subpath "${wt}") (subpath "${gitDir}") (literal "${ref}") (literal "${ref}.lock") (literal "${join(common, "logs", "refs", "heads", "wl", l.wl)}") (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))(deny file-write* (literal "${join(wt, ".git")}") (literal "${join(gitDir, "commondir")}") (literal "${join(gitDir, "gitdir")}") (literal "${join(gitDir, "config.worktree")}"))(deny network-outbound (remote ip))`,
		);
	});

	test("a failed validation refuses: not a linked worktree, a gitdir that does not name it back, a reset on another branch or a detached HEAD", () => {
		const l = lane();
		const { main, wt, gitDir } = worktreeOf(l);
		expect(() => worktreeFence(main, l.wl, false)).toThrow("is not a regular file");
		expect(() => worktreeFence(wt, "wl-0ther001", true)).toThrow(`not the workload's own wl/wl-0ther001`);
		git(wt, "checkout", "-q", "--detach");
		expect(() => worktreeFence(wt, l.wl, true)).toThrow("on a detached HEAD");
		expect(worktreeFence(wt, l.wl, false).branch).toBeNull();
		writeFileSync(join(gitDir, "gitdir"), `${join(main, "elsewhere", ".git")}\n`);
		expect(() => worktreeFence(wt, l.wl, false)).toThrow("not this worktree's");
	});

	test("R32: an rm in the own worktree auto-applies as rule worktree and the fence wraps it under the worktree profile", async () => {
		const l = lane();
		const { wt } = worktreeOf(l);
		mkdirSync(join(wt, "build"));
		const c = call("rm -rf build", wt);
		const r = await rows(l, { fence: ON }).emit("tool_call", c, ctxOf(l.home));
		expect(control(l.ledger, l.wl, "auto-applied").map((e) => e.body)).toEqual([`auto-applied: worktree ${c.toolCallId} by lane-1 cwd ${wt} net no: rm -rf build`]);
		expect(callMark(c.toolCallId)).toEqual({ kind: "worktree", root: wt });
		const wrapped = String(r?.input?.command);
		expect(wrapped).toContain(`(allow file-write* (subpath "${wt}")`);
		expect(wrapped).toContain(`(deny file-write* (literal "${join(wt, ".git")}")`);
		expect(wrapped).toContain("(deny network-outbound (remote ip))");
	});
});

/** Run `command` in `cwd` under `profile` with sandbox-exec, as the fence's wrapper would. */
function sandboxed(profile: string, command: string, cwd: string) {
	const r = spawnSync("sandbox-exec", ["-p", profile, "/bin/bash", "-c", command], { cwd, encoding: "utf8", timeout: 60_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" } });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!SANDBOX)("behaviour under sandbox-exec", () => {
	test("R5: the read-only profile denies every file write, the own scratch root and home included", () => {
		const l = lane();
		const r = sandboxed(fenceProfile([], { kind: "read-only", network: false, execAllow: [] }), `echo x > "${l.root}/f"; echo y > "${l.home}/g"; echo ok > /dev/null && uname >/dev/null && echo ran`, l.home);
		expect(r.err).toContain("Operation not permitted");
		expect(r.out.trim()).toBe("ran");
		expect(existsSync(join(l.root, "f")) || existsSync(join(l.home, "g"))).toBe(false);
	});

	test("R19: the network profile starts only the listed programs; a denied start reads as a denial the detector trips on", () => {
		const r = sandboxed(fenceProfile([], { kind: "read-only", network: true, execAllow: ["/bin/bash", "/bin/cat"] }), "/bin/cat /dev/null && echo cat-ran; /usr/bin/uname", "/");
		expect(r.out).toContain("cat-ran");
		expect(r.code).not.toBe(0);
		expect(detectTrip(`${r.out}\n${r.err}`, false, r.code ?? 1)?.signal).toBe("fence-denial");
	});

	test("R33: under the worktree profile a work-tree discard and a reset on the own branch succeed; the .git file and the common dir stay unwritable", () => {
		const l = lane();
		const { wt, common } = worktreeOf(l);
		writeFileSync(join(wt, "f"), "dirty\n");
		const tip = git(wt, "rev-parse", "HEAD");
		const fence = worktreeFence(wt, l.wl, true);
		const profile = fenceProfile([], { kind: "worktree", allow: fence.allow, deny: fence.deny });
		const ok = sandboxed(profile, "git checkout -- f && git reset -q --keep HEAD~1 && cat f", wt);
		// stderr counts only lines that carry a denial (xcrun may warn about its cache, which the profile does not allow). The one
		// denial expected is git's own: deleting the per-worktree AUTO_MERGE ref tries `<common>/packed-refs.lock`, which the fence
		// keeps unwritable, and git goes on (Jo's ruling in-mvzor59pc1067u). Any other denied path fails here.
		const packedLock = `error: Unable to create '${join(common, "packed-refs.lock")}': Operation not permitted`;
		const denials = ok.err.split("\n").filter((x) => /Operation not permitted|deny\(1\)/.test(x) && x.trim() !== packedLock);
		expect({ code: ok.code, out: ok.out.trim(), denials }).toEqual({ code: 0, out: "one", denials: [] });
		expect(git(wt, "rev-parse", "HEAD")).not.toBe(tip);
		expect(existsSync(join(common, "packed-refs.lock"))).toBe(false);
		const denied = sandboxed(profile, `echo x >> .git; echo x >> "${join(common, "config")}"; echo x > "${join(common, "refs", "heads", "main")}"`, wt);
		expect(denied.err.match(/Operation not permitted/g)?.length).toBe(3);
		expect(git(wt, "rev-parse", "main")).toBe(tip);
	});
});
