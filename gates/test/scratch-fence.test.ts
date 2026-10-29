// The confined fence (PLAN wl-mv5oikd5jtquww § 1.3): a bash call a scratch-root rule let through runs
// under a profile that denies every write but those inside the own root (and /dev/null, /dev/tty,
// /dev/fd), denies outbound network, and keeps the ledger and git denies; with the fence off, or the
// root gone, it is refused. The behaviour tests run the wrapped command through sandbox-exec as OMP's
// shell would: the call is marked by row 6 (checkReserved, rule 1's `rm -rf "$AS2_SCRATCH/…"`) and
// wrapped by the fence under the same tool call id, the order gates/index.ts registers them in.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
// Branch-only symbols (CONFINED_UNFENCED_REASON, isConfined, markConfined) through namespaces: on
// origin/main the file still loads and each test fails on its own (sl-scratch-prefail).
import * as fence from "../src/fence";
import { type FenceSettings, fenceProfile, registerFence } from "../src/fence";
import { checkReserved } from "../src/rows/r06-reserved";
import { SCRATCH_ENV, scratchRootFor } from "../src/scratch";
import * as session from "../src/session";
import type { GatesAPI } from "../src/session";
import { WORKLOAD_ENV } from "../src/types";
import { commit, git, tmp } from "./helpers";

type AnyHandler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type Revised = { block?: boolean; reason?: string; input?: Record<string, unknown> } | undefined;

const ON: FenceSettings = { enabled: true, autoBackground: true };
const OFF: FenceSettings = { enabled: false, autoBackground: true };

/** A fake OMP extension API chaining handlers the way the runner does (as in fence.test.ts). */
function fakePi() {
	const handlers = new Map<string, AnyHandler[]>();
	const pi = {
		on: (name: string, h: AnyHandler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		getActiveTools: () => ["bash"],
		getAllTools: () => [{ name: "bash" }],
		setActiveTools: async () => {},
		appendEntry: () => {},
		registerTool: () => {},
	};
	const emit = async (name: string, event: Record<string, unknown>, ctx: unknown): Promise<Revised> => {
		let last: Revised;
		for (const h of handlers.get(name) ?? []) {
			const r = (await h(event, ctx)) as Revised;
			if (!r) continue;
			last = r;
			if (r.block) return r;
		}
		return last;
	};
	return { pi: pi as unknown as GatesAPI, emit };
}

const ctxOf = (cwd: string) => ({ hasUI: false, cwd, sessionManager: { getHeader: () => null, getEntries: () => [] }, ui: { notify: () => {} } });

const ID = "wl-f3nce01";
const HOME = realpathSync(tmp("scratch-fence"));
const ROOT = scratchRootFor(HOME, ID);
mkdirSync(ROOT, { recursive: true });
const OUTSIDE = realpathSync(tmp("scratch-fence-out"));
// A repository inside the root: the git denies for a repo the call runs in still hold there.
const REPO = join(ROOT, "repo");
mkdirSync(REPO);
git(REPO, "init", "-q", "-b", "main");
commit(REPO, "f", "one\n");

// HOME has no ledger and no lane: the fence off records nothing, so the fake API's appendEntry is enough.
const ENV: Record<string, string | undefined> = { HOME, PATH: process.env.PATH, [WORKLOAD_ENV]: ID, [SCRATCH_ENV]: ROOT };
const RUN_ENV: Record<string, string | undefined> = {
	...ENV,
	GIT_AUTHOR_NAME: "fence test",
	GIT_AUTHOR_EMAIL: "fence@test.invalid",
	GIT_COMMITTER_NAME: "fence test",
	GIT_COMMITTER_EMAIL: "fence@test.invalid",
	GIT_CONFIG_NOSYSTEM: "1",
	LC_ALL: "C",
};
/** Rule 1's housekeeping, so row 6 marks the call: every behaviour command starts with it. */
const MARK = `rm -rf "$AS2_SCRATCH/pp";`;
const TMP_PROBE = `/tmp/scratch-fence-${process.pid}`;

afterAll(() => {
	spawnSync("/bin/rm", ["-f", TMP_PROBE]);
});

let n = 0;
/**
 * Row 6 then the fence over one bash call, as gates/index.ts orders them; the fence's result and
 * whether the call was marked. `rowless`: mark it directly (session.ts markConfined) instead, for a
 * command row 6 refuses on its own, so the fence's deny is what the test sees.
 */
async function gate(command: string, opts: { settings?: FenceSettings; env?: Record<string, string | undefined>; cwd?: string; rowless?: boolean } = {}): Promise<{ revised: Revised; marked: boolean }> {
	const toolCallId = `sf-${++n}`;
	const env = opts.env ?? ENV;
	const cwd = opts.cwd ?? HOME;
	const call = { toolName: "bash", toolCallId, input: { command } };
	if (opts.rowless) session.markConfined(call);
	else expect(checkReserved(call, { role: "lane", cwd, env, mode: null })).toBeNull();
	const marked = session.isConfined(toolCallId);
	const f = fakePi();
	registerFence(f.pi, env, async () => opts.settings ?? ON);
	return { revised: await f.emit("tool_call", call, ctxOf(cwd)), marked };
}

/** Run what the fence would hand OMP's shell, with /bin/bash -c (fence.test.ts sh). */
function sh(command: string, cwd: string) {
	const r = spawnSync("/bin/bash", ["-c", command], { cwd, env: RUN_ENV as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

/**
 * Mark, wrap and run `command` confined; fails the test if the fence refused it, or if sandbox-exec
 * could not apply the profile (inside another Seatbelt sandbox it exits 71 with `sandbox_apply`, and
 * a deny test would otherwise pass on a command that never ran).
 */
async function confined(command: string, cwd = HOME, rowless = false) {
	const { revised, marked } = rowless ? await gate(command, { cwd, rowless }) : await gate(`${MARK} ${command}`, { cwd });
	expect(marked).toBe(true);
	if (!revised?.input || revised.block) throw new Error(`fence refused: ${revised?.reason}`);
	const wrapped = String(revised.input.command);
	expect(wrapped).toContain("(deny network-outbound (remote ip))");
	const r = sh(wrapped, cwd);
	expect(r.err).not.toContain("sandbox_apply");
	return r;
}

describe("the confined profile text", () => {
	test("deny every write, allow the root and the terminal devices, deny network, then the targets' denies", () => {
		expect(fenceProfile([{ kind: "subpath", path: "/x/.agent-system-2" }], [ROOT], true)).toBe(
			`(version 1)(allow default)(deny file-write*)(allow file-write* (subpath "${ROOT}") (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))(deny network-outbound (remote ip))(deny file-write* (subpath "/x/.agent-system-2"))`,
		);
		expect(fenceProfile([{ kind: "subpath", path: "/x/.agent-system-2" }])).toBe(`(version 1)(allow default)(deny file-write* (subpath "/x/.agent-system-2"))`);
	});

	test("only a marked call gets it", async () => {
		const plain = await gate(`ls "$AS2_SCRATCH"`);
		expect(plain.marked).toBe(false);
		expect(String(plain.revised?.input?.command)).not.toContain("(deny network-outbound");
		const marked = await gate(`${MARK} ls`);
		expect(marked.marked).toBe(true);
		expect(String(marked.revised?.input?.command)).toContain(`(allow file-write* (subpath "${ROOT}")`);
	});
});

describe("fail closed", () => {
	test("a marked call with the fence off is refused; an unmarked one runs unfenced as before", async () => {
		expect((await gate(`${MARK} ls`, { settings: OFF })).revised).toEqual({ block: true, reason: fence.CONFINED_UNFENCED_REASON });
		expect((await gate(`ls "$AS2_SCRATCH"`, { settings: OFF })).revised).toBeUndefined();
	});

	test("a marked call whose root is gone by the time the fence runs is refused", async () => {
		const home2 = realpathSync(tmp("scratch-fence-gone"));
		const root2 = scratchRootFor(home2, ID);
		mkdirSync(root2, { recursive: true });
		const env2 = { HOME: home2, PATH: process.env.PATH, [WORKLOAD_ENV]: ID, [SCRATCH_ENV]: root2 };
		const toolCallId = `sf-${++n}`;
		const call = { toolName: "bash", toolCallId, input: { command: `${MARK} ls` } };
		expect(checkReserved(call, { role: "lane", cwd: home2, env: env2, mode: null })).toBeNull();
		expect(session.isConfined(toolCallId)).toBe(true);
		spawnSync("/bin/rmdir", [root2]);
		const f = fakePi();
		registerFence(f.pi, env2, async () => ON);
		const r = await f.emit("tool_call", call, ctxOf(home2));
		expect({ block: r?.block, why: r?.reason?.includes("the own scratch root") }).toEqual({ block: true, why: true });
	});

	test("the call's result clears the mark", async () => {
		const toolCallId = `sf-${++n}`;
		const call = { toolName: "bash", toolCallId, input: { command: `${MARK} ls` } };
		expect(checkReserved(call, { role: "lane", cwd: HOME, env: ENV, mode: null })).toBeNull();
		const f = fakePi();
		registerFence(f.pi, ENV, async () => ON);
		await f.emit("tool_call", call, ctxOf(HOME));
		expect(session.isConfined(toolCallId)).toBe(true);
		await f.emit("tool_result", { ...call, content: [] }, ctxOf(HOME));
		expect(session.isConfined(toolCallId)).toBe(false);
	});
});

describe("behaviour under sandbox-exec", () => {
	test("a write inside the root is allowed", async () => {
		const r = await confined(`mkdir -p "$AS2_SCRATCH/d" && echo in > "$AS2_SCRATCH/d/f" && cat "$AS2_SCRATCH/d/f" && echo quiet > /dev/null`);
		expect({ code: r.code, out: r.out.trim(), err: r.err }).toEqual({ code: 0, out: "in", err: "" });
		expect(readFileSync(join(ROOT, "d", "f"), "utf8")).toBe("in\n");
	});

	test("a write outside the root is denied", async () => {
		const r = await confined(`echo out > ${OUTSIDE}/f`);
		expect(r.err).toContain("Operation not permitted");
		expect(existsSync(join(OUTSIDE, "f"))).toBe(false);
	});

	test("a symlink made in the same call does not lead a write out", async () => {
		const r = await confined(`ln -s ${OUTSIDE} "$AS2_SCRATCH/esc" && echo out > "$AS2_SCRATCH/esc/g"`);
		expect(r.err).toContain("Operation not permitted");
		expect(existsSync(join(OUTSIDE, "g"))).toBe(false);
	});

	test("a write to /tmp is denied", async () => {
		const r = await confined(`echo out > ${TMP_PROBE}`);
		expect(r.err).toContain("Operation not permitted");
		expect(existsSync(TMP_PROBE)).toBe(false);
	});

	test("outbound network is denied, to localhost too; the same connect unconfined succeeds", async () => {
		const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		try {
			const connect = `exec 3<>/dev/tcp/127.0.0.1/${server.port} && echo connected`;
			const control = sh(connect, HOME);
			expect({ code: control.code, out: control.out.trim() }).toEqual({ code: 0, out: "connected" });
			const r = await confined(connect);
			expect({ code: r.code === 0, out: r.out.trim() }).toEqual({ code: false, out: "" });
		} finally {
			server.stop(true);
		}
	});

	test("an own-root repository the call runs in keeps its git denies; ordinary git work there succeeds", async () => {
		// Row 6 refuses this write itself; marked directly, the fence's own deny is what runs.
		const hooks = await confined("echo 'exit 0' > .git/hooks/pre-commit", REPO, true);
		expect(hooks.err).toContain("Operation not permitted");
		expect(existsSync(join(REPO, ".git", "hooks", "pre-commit"))).toBe(false);
		const work = await confined("echo two > f && git add f && git commit -q -m two && git log --oneline -1", REPO);
		expect({ code: work.code, out: work.out.trim().endsWith("two") }).toEqual({ code: 0, out: true });
	});
});
