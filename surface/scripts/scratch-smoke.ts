#!/usr/bin/env bun
// scratch-smoke: one real omp lane session doing the repo lifecycle in its own scratch root with no hold
// (PLAN wl-mv5oikd5jtquww rev 4, slice sl-scratch-smoke; the done line's "real lane session, no hold").
// Built on the chaos harness's parts: the scripted model stub and the refusing egress proxy
// (surface/scripts/chaos-stub.ts, chaos-proxy.ts), a throwaway HOME and ledger, the profile installed by
// install/install.sh from a copy of the tree under test, the lane launched through that copy's
// surface/scripts/lane.ts, the OS fence on.
//
//   bun surface/scripts/scratch-smoke.ts                  after: this checkout's surface/ and gates/
//   bun surface/scripts/scratch-smoke.ts --ref origin/main before: <ref> of this checkout, unpacked (git archive)
//   bun surface/scripts/scratch-smoke.ts --tree <dir>     any checkout, or an unpacked copy with no .git
//   bun surface/scripts/scratch-smoke.ts --dry-run        print the plan and Jo's commands, run the pure checks
//
// The scripted lane makes one bash call per step, every target spelled "$AS2_SCRATCH/…": print the variable (an
// interlock: no further bash call unless it reads as the expected root), git init --bare, clone, write a file,
// git add, git -c user.* commit, git branch, push main and a feature ref to the bare repo by path, rev-parse the
// clone's HEAD and the bare repo's two refs, modify the file, git checkout --, git diff --exit-code, git branch -d,
// rm -rf the clone and the bare repo; then done-because and lane_release. Between the branch -d and the rm, this
// script reads the bare repo's refs itself.
//
// PASS (exit 0) only when: every scripted tool result is exit 0 and none holds `P-11 row`; the lane ended
// released; the lane's rev-parse and this script's own read both show main and the feature ref at the clone's
// HEAD; the clone and the bare repo are gone and the root is still there; the workload has zero
// `reserved-request` entries. FAIL exits 1. A harness error stops the run at once (exit 2).
//
// A tree with no scratch contract (gates/src/scratch.ts absent, as on origin/main before this workload) has a
// launcher that exports no AS2_SCRATCH: the script then creates the root and passes the same value in the launch
// env, so the commands target the same paths and only the gates differ. The run is then expected to FAIL.
//
// Nothing is written outside the run directory (throwaway HOME, ledger, profile, the repo copy and its worktree,
// all under LOG_DIR/run-<id>) and the log file beside it. The run directory is deleted on PASS and kept otherwise.
// The throwaway HOME sits outside the temp directories on purpose: gates/src/rows/r06-reserved.ts lets rm -rf of
// temp paths through on its own (TEMP_PATH), which would hide whether the scratch rule did the work.
//
// Inside a lane's fence the nested sandbox-exec fails (`sandbox_apply: Operation not permitted`) and a confined
// call is refused when the fence cannot wrap it, so the fence probe stops such a run as a harness error: run it
// from a plain terminal.
import type { Subprocess } from "bun";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SCRATCH_ENV, scratchRootFor } from "../../gates/src/scratch";
import { type EntryRow, Ledger } from "../../ledger/src/index";
import { canonicalPath, defaultLedgerPath } from "../../ledger/src/locality";
import { copyIntoScratch, HarnessError, laneStarts, PS_SHIM, removeFromScratch, scratchNewPathRefusal } from "../src/chaos";
import { recordRepo } from "../src/decision-log";
import { laneDir, STARTER_EXIT, worktreePath } from "../src/launch";
import { installOutcome } from "./chaos";
import { type Proxy, startProxy } from "./chaos-proxy";
import { type Stub, type StubRequest, type StubScript, type StubToolResult, type StubTurn, startStub, writeStubProfile } from "./chaos-stub";

/** The checkout this script runs from: the default tree, and the source of `--ref`. */
const SOURCE = resolve(import.meta.dir, "..", "..");
const PROFILE = "agent-system-2";
/** Logs and run directories (the slice brief names this directory). */
const LOG_DIR = join(homedir(), "agent-scratch", "agent-system-2.0", "wl-mv5oikd5jtquww", "smoke");
const CHAT_MODEL = "anthropic/claude-haiku-5-5";
const LEASE_MS = 120_000;
const PROBE_MS = 120_000;
/** From the launch to the lane's lane-exit: (or lane-died:). */
const LANE_END_MS = 300_000;
const FENCE_MARK = "scratch-smoke-probe-fence";
const FENCE_OK = "scratch-smoke-fence-ok";
/** Egress the proxy refuses and the report lists without failing (chaos.ts CHAOS_EXEMPT_EGRESS_HOSTS). */
const EXEMPT_HOSTS = ["catalog.stencil.so"];

/** The names inside the scratch root. */
export const NAMES = { bare: "smoke-bare.git", clone: "smoke-clone", file: "smoke.txt", feature: "smoke-feature" } as const;

const HELP = `usage: bun surface/scripts/scratch-smoke.ts [--tree <dir> | --ref <git-ref>]
       bun surface/scripts/scratch-smoke.ts --dry-run
       bun surface/scripts/scratch-smoke.ts --help

Runs one real omp lane (launched through the tree's surface/scripts/lane.ts, fence on) whose scripted bash calls do
the repo lifecycle in its scratch root, every target spelled "$AS2_SCRATCH/…", then checks the run.

  --tree <dir>    the checkout whose surface/ and gates/ the lane runs (default: ${SOURCE}); a directory with no
                  .git (an unpacked copy) is copied and committed as it is
  --ref <ref>     unpack <ref> of ${SOURCE} (git archive) into the run directory and run against that
  --dry-run       print the plan and the two commands to run, and exercise the pure checks; runs no lane
  --help          this text

Writes only under ${LOG_DIR}: run-<id>/ (deleted on PASS, kept otherwise) and <stamp>-<id>.log.
Exit: 0 PASS, 1 FAIL, 2 harness error or bad arguments. Run it from a plain terminal, not inside a lane's fence.
`;

// ---- the scripted steps (pure) -------------------------------------------------------------------

export interface PlanStep {
	id: string;
	tool: string;
	input: Record<string, unknown>;
}

const bash = (id: string, command: string, i: string): PlanStep => ({ id, tool: "bash", input: { command, i, timeout: 60 } });

/** The lane's bash calls, in order, one call each, every target spelled "$AS2_SCRATCH/…". */
export function smokeSteps(token: string): PlanStep[] {
	const s = (rest: string) => `"$AS2_SCRATCH/${rest}"`;
	const { bare, clone, file, feature } = NAMES;
	const inClone = `git -C ${s(clone)}`;
	return [
		bash("echo-root", `printf '%s\\n' "$AS2_SCRATCH"`, "Printing the scratch root"),
		bash("init-bare", `git init --bare -b main ${s(bare)}`, "Creating the bare repo"),
		bash("clone", `git clone ${s(bare)} ${s(clone)}`, "Cloning the bare repo"),
		bash("write-file", `printf 'scratch smoke ${token}\\n' > ${s(`${clone}/${file}`)}`, "Writing a file in the clone"),
		bash("add", `${inClone} add ${file}`, "Staging the file"),
		// `git -C <dir>` never goes with `-c` (P-11 row 6 refuses the pair as unmodeled), so the commit enters the clone with cd.
		bash("commit", `cd ${s(clone)} && git -c user.name=scratch-smoke -c user.email=scratch-smoke@localhost commit -m 'scratch smoke ${token}'`, "Committing the file"),
		bash("branch-feature", `${inClone} branch ${feature}`, "Creating the feature branch"),
		bash("push-main", `${inClone} push ${s(bare)} main`, "Pushing main to the bare repo"),
		bash("push-feature", `${inClone} push ${s(bare)} ${feature}`, "Pushing the feature ref to the bare repo"),
		bash("head-clone", `${inClone} rev-parse HEAD`, "Reading the clone's HEAD"),
		bash("refs-bare", `git -C ${s(bare)} rev-parse refs/heads/main refs/heads/${feature}`, "Reading the bare repo's refs"),
		bash("modify", `printf 'modified\\n' >> ${s(`${clone}/${file}`)}`, "Modifying the file"),
		bash("checkout", `${inClone} checkout -- ${file}`, "Discarding the modification"),
		bash("diff-clean", `${inClone} diff --exit-code`, "Checking the clone is clean"),
		bash("branch-delete", `${inClone} branch -d ${feature}`, "Deleting the merged feature branch"),
		bash("rm", `rm -rf ${s(clone)} ${s(bare)}`, "Removing the clone and the bare repo"),
	];
}

/** The whole lane plan: the wake read, the bash steps, the receipt, the release. */
export function lanePlan(token: string, wl: string): PlanStep[] {
	return [
		{ id: "wake-read", tool: "ledger_wake_read", input: { body: `scratch smoke ${token}: fresh workload ${wl}; next: the repo lifecycle in the scratch root.`, i: "Recording the wake read" } },
		...smokeSteps(token),
		{ id: "done-because", tool: "lane_record_entry", input: { body: `done-because: scratch smoke ${token}: the repo lifecycle ran in the scratch root, one bash call per step.`, i: "Recording the receipt" } },
		{ id: "release", tool: "lane_release", input: { i: "Releasing the workload" } },
	];
}

/** The two steps that replace the rest when the interlock trips. */
export function abortPlan(token: string, why: string): PlanStep[] {
	return [
		{ id: "abort-entry", tool: "lane_record_entry", input: { body: `scratch smoke ${token} aborted before any write: ${why}`, i: "Recording the abort" } },
		{ id: "release", tool: "lane_release", input: { i: "Releasing the workload" } },
	];
}

// ---- result checks (pure) ------------------------------------------------------------------------

const oneLine = (s: string, max = 300): string => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Why one tool result is not a clean exit 0, or null when it is. OMP's bash tool marks a nonzero exit as an error
 * result ending in `Command exited with code <n>` (pi-coding-agent src/tools/bash.ts #buildCompletedResult, pi-tui
 * formatExitCodeNotice); a gate refusal is an error result naming `P-11 row`; a call moved to the background has no
 * exit status yet (`Backgrounded as job`).
 */
export function resultProblem(tool: string, r: Pick<StubToolResult, "text" | "isError"> | undefined): string | null {
	if (r === undefined) return "no result";
	if (r.text.includes("P-11 row")) return `gate refusal: ${oneLine(r.text)}`;
	const exit = /Command exited with code (\d+)/.exec(r.text);
	if (tool === "bash" && exit) return `exit ${exit[1]}: ${oneLine(r.text)}`;
	if (tool === "bash" && /Backgrounded as job/.test(r.text)) return `moved to the background, no exit status: ${oneLine(r.text)}`;
	if (r.isError) return `error result: ${oneLine(r.text)}`;
	return null;
}

/** The lines of `text` that are a full object name. */
export function hexLines(text: string | undefined): string[] {
	return (text ?? "").split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l));
}

/** Why the lane's rev-parse results do not show main and the feature ref at the clone's HEAD, or null. */
export function laneRefsProblem(headText: string | undefined, refsText: string | undefined): string | null {
	const head = hexLines(headText);
	const refs = hexLines(refsText);
	if (head.length !== 1) return `the clone's rev-parse HEAD gave ${head.length} object names`;
	if (refs.length !== 2) return `the bare repo's rev-parse gave ${refs.length} object names, not 2`;
	if (refs.some((r) => r !== head[0])) return `the bare repo's refs ${refs.join(", ")} are not the clone's HEAD ${head[0]}`;
	return null;
}

/** Why this script's own `for-each-ref refs/heads` of the bare repo does not hold both refs at `head`, or null. */
export function harnessRefsProblem(forEachRef: string | null, headText: string | undefined): string | null {
	if (forEachRef === null) return "the bare repo was not read before the rm";
	const head = hexLines(headText)[0];
	if (head === undefined) return "no clone HEAD to compare with";
	const refs = new Map<string, string>();
	for (const line of forEachRef.split("\n")) {
		const m = /^([0-9a-f]{40}) (\S+)$/.exec(line.trim());
		if (m) refs.set(m[2]!, m[1]!);
	}
	for (const name of ["refs/heads/main", `refs/heads/${NAMES.feature}`]) {
		if (refs.get(name) !== head) return `${name} is ${refs.get(name) ?? "absent"} in the bare repo, not ${head}`;
	}
	return null;
}

/** The `reserved-request` entries on workload `wl`: what a P-11 row 6 refusal of a § A4 reserved action records. */
export function reservedRequests(ledger: Pick<Ledger, "entries">, wl: string): EntryRow[] {
	return ledger.entries(wl, "reserved-request");
}

/** The outcome word of a `lane-exit:` body, or null for anything else (a `lane-died:` message, nothing). */
export function exitOutcome(body: string | null): string | null {
	if (body === null || !body.startsWith("lane-exit: ")) return null;
	return /\boutcome (\S+)/.exec(body)?.[1] ?? null;
}

/** What the run observed, judged by `judge`. */
export interface Observed {
	/** The steps the stub issued, by turn: issued[n] is the call answering a request that held n tool results. */
	issued: PlanStep[];
	/** The tool results of the lane's last request, in order: results[n] answers issued[n]. */
	results: StubToolResult[];
	aborted: string | null;
	laneEnd: string | null;
	harnessRefs: string | null;
	dirs: { root: boolean; clone: boolean; bare: boolean };
	reserved: { id: string; body: string }[];
}

export interface Judgement {
	pass: boolean;
	lines: string[];
}

export function judge(o: Observed, expected: PlanStep[]): Judgement {
	const lines: string[] = [];
	let pass = true;
	const check = (ok: boolean, what: string, detail: string) => {
		if (!ok) pass = false;
		lines.push(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`);
	};
	const outcome = exitOutcome(o.laneEnd);
	const released = outcome === "released" || outcome === "completed";
	check(o.aborted === null, "interlock: $AS2_SCRATCH read as the expected root", o.aborted ?? "");
	const steps: string[] = [];
	let bad = 0;
	for (const [n, step] of expected.entries()) {
		const issued = o.issued[n];
		if (issued === undefined || issued.id !== step.id) {
			bad++;
			steps.push(`  [FAIL] ${step.id}: never issued${issued ? ` (turn ${n} issued ${issued.id})` : ""}`);
			continue;
		}
		const r = o.results[n];
		// lane_release ends the session, so its result reaches no later request: the lane-exit: outcome stands for it.
		if (step.tool === "lane_release" && r === undefined) {
			if (!released) bad++;
			steps.push(`  [${released ? "ok" : "FAIL"}] ${step.id}: no result (the session ended); lane end: ${o.laneEnd ?? "none"}`);
			continue;
		}
		const why = resultProblem(step.tool, r);
		if (why !== null) bad++;
		const cmd = typeof step.input.command === "string" ? `  ${step.input.command}` : "";
		steps.push(`  [${why === null ? "ok" : "FAIL"}] ${step.id}${cmd}${why === null ? "" : `\n         ${why}`}`);
	}
	check(bad === 0, "every scripted tool result exit 0, none holding `P-11 row`", bad === 0 ? `${expected.length} steps` : `${bad} of ${expected.length} steps`);
	lines.push(...steps);
	check(released, "the lane ended released", o.laneEnd ?? "no lane-exit: or lane-died: seen");
	const at = (id: string) => o.results[expected.findIndex((s) => s.id === id)]?.text;
	const laneRefs = laneRefsProblem(at("head-clone"), at("refs-bare"));
	check(laneRefs === null, "inside the lane: the bare repo held main and the feature ref at the clone's HEAD before the rm", laneRefs ?? "");
	const ownRefs = harnessRefsProblem(o.harnessRefs, at("head-clone"));
	check(ownRefs === null, "read by this script before the rm: the bare repo held both refs", ownRefs ?? "");
	check(!o.dirs.clone && !o.dirs.bare, "the clone and the bare repo are absent after", `clone ${o.dirs.clone ? "present" : "absent"}, bare ${o.dirs.bare ? "present" : "absent"}`);
	check(o.dirs.root, "the scratch root itself is still there", "");
	check(o.reserved.length === 0, "zero reserved-request entries on the smoke workload", o.reserved.map((e) => `${e.id}: ${oneLine(e.body, 200)}`).join("; "));
	return { pass, lines };
}

// ---- the commands Jo runs ------------------------------------------------------------------------

export function joCommands(source: string = SOURCE): { after: string; before: string } {
	const script = join(source, "surface", "scripts", "scratch-smoke.ts");
	return { after: `bun ${script}`, before: `bun ${script} --ref origin/main` };
}

const joBlock = (): string => {
	const c = joCommands();
	return `Run from a plain terminal (not inside a lane: the fence cannot nest):\n  after  (this checkout, expected PASS):        ${c.after}\n  before (origin/main unpacked, expected FAIL): ${c.before}\n`;
};

// ---- the run -------------------------------------------------------------------------------------

type TreeSource = { kind: "checkout"; dir: string } | { kind: "plain"; dir: string } | { kind: "ref"; ref: string };

interface Args {
	tree: TreeSource;
	dryRun: boolean;
	help: boolean;
}

export function parseArgs(argv: string[]): Args | string {
	let tree: string | null = null;
	let ref: string | null = null;
	const a: Args = { tree: { kind: "checkout", dir: SOURCE }, dryRun: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const x = argv[i]!;
		if (x === "--help" || x === "-h") a.help = true;
		else if (x === "--dry-run") a.dryRun = true;
		else if (x === "--tree" || x === "--ref") {
			const v = argv[++i];
			if (!v || v.startsWith("--")) return `${x} takes a value`;
			if (x === "--tree") tree = v;
			else ref = v;
		} else return `unknown argument ${x}`;
	}
	if (tree !== null && ref !== null) return "give --tree or --ref, not both";
	if (ref !== null) a.tree = { kind: "ref", ref };
	if (tree !== null) {
		const dir = resolve(tree);
		if (!existsSync(join(dir, "surface", "scripts", "lane.ts")) || !existsSync(join(dir, "install", "install.sh"))) return `--tree ${dir} has no surface/scripts/lane.ts or install/install.sh`;
		a.tree = existsSync(join(dir, ".git")) ? { kind: "checkout", dir } : { kind: "plain", dir };
	}
	return a;
}

export interface Ran {
	code: number | null;
	out: string;
	err: string;
	timedOut: boolean;
}

/** What installProfile needs: the copy, the throwaway HOME and PATH, the run directory install.log goes in, and the Run's spawn and log. */
export interface InstallDeps {
	repo: string;
	home: string;
	path: string;
	runDir: string;
	run: (cmd: string[], o: { cwd: string; env?: Record<string, string>; ms: number }) => Promise<Ran>;
	say: (line: string) => void;
}

/**
 * install/install.sh from the copy into the throwaway HOME, its whole output kept in runDir/install.log; returns the profile's agent
 * dir. The exit is judged by chaos.ts installOutcome: 0 is success; INSTALL_DOCTOR_FAILED (5, install's closing doctor found failing
 * parts) is success with one logged line, since the doctor's seat part cannot pass for a copy no orchestrator runs for; any other
 * exit, or a timeout, throws HarnessError.
 */
export async function installProfile(d: InstallDeps): Promise<string> {
	const install = await d.run(["bash", join(d.repo, "install", "install.sh")], { cwd: d.repo, env: { PATH: d.path, HOME: d.home }, ms: 300_000 });
	const log = join(d.runDir, "install.log");
	writeFileSync(log, `${install.out}\n--- stderr ---\n${install.err}`);
	const outcome = installOutcome(install, log);
	if (outcome.note !== null) d.say(`setup: ${outcome.note}`);
	const agentDir = join(d.home, ".omp", "profiles", PROFILE, "agent");
	if (!existsSync(join(agentDir, "config.yml"))) throw new HarnessError(`install.sh wrote no profile at ${agentDir}`);
	return agentDir;
}

/** Why `ps` at `bin` cannot report this process, or null when it can (the setuid /bin/ps fails with EPERM in a sandbox). */
function psProblem(bin: string): string | null {
	try {
		const env = { ...process.env, PATH: `${resolve(process.execPath, "..")}:${process.env.PATH ?? ""}` };
		const r = Bun.spawnSync([bin, "-p", String(process.pid), "-o", "pid="], { env, stdout: "pipe", stderr: "pipe" });
		return r.exitCode === 0 && r.stdout.toString().trim() === String(process.pid) ? null : `${bin} exited ${r.exitCode}: ${oneLine(r.stderr.toString(), 160)}`;
	} catch (e) {
		return `${bin}: ${oneLine(e instanceof Error ? e.message : String(e), 160)}`;
	}
}

class Run {
	readonly runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0")}`;
	readonly token = `scratch-smoke-${this.runId}`;
	/** gates/src/scratch.ts takes workload ids of the shape wl-<alnum>. */
	readonly wl = `wl-smoke${this.runId}`;
	readonly logPath: string;
	R = "";
	home = "";
	repo = "";
	root = "";
	env: Record<string, string> = {};
	launchEnv: Record<string, string> = {};
	stub: Stub | null = null;
	proxy: Proxy | null = null;
	ledger: Ledger | null = null;
	laneId: string | null = null;
	children = new Set<Subprocess>();
	plan: PlanStep[];
	issued: PlanStep[] = [];
	results: StubToolResult[] = [];
	seen = new Set<string>();
	aborted: string | null = null;
	harnessRefs: string | null = null;
	fenceResults: { text: string; isError: boolean }[] = [];
	unmatched = 0;

	constructor(readonly tree: TreeSource) {
		mkdirSync(LOG_DIR, { recursive: true });
		this.logPath = join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${this.runId}.log`);
		this.plan = lanePlan(this.token, this.wl);
	}

	say(line: string): void {
		process.stdout.write(`${line}\n`);
		appendFileSync(this.logPath, `${line}\n`);
	}

	spawn(cmd: string[], o: { cwd: string; env?: Record<string, string> }): Subprocess<"ignore", "pipe", "pipe"> {
		const p = Bun.spawn(cmd, { cwd: o.cwd, env: o.env ?? this.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		this.children.add(p);
		void p.exited.then(() => this.children.delete(p));
		return p;
	}

	async run(cmd: string[], o: { cwd: string; env?: Record<string, string>; ms: number }): Promise<Ran> {
		const p = this.spawn(cmd, o);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			p.kill("SIGKILL");
		}, o.ms);
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		clearTimeout(timer);
		return { code, out, err, timedOut };
	}

	async must(cmd: string[], cwd: string, what: string, ms = 300_000): Promise<string> {
		const r = await this.run(cmd, { cwd, ms });
		if (r.code !== 0) throw new HarnessError(`${what}: ${cmd.join(" ")} exited ${r.code}${r.timedOut ? " (timed out)" : ""}: ${oneLine(r.err || r.out)}`);
		return r.out;
	}

	git(cwd: string, args: string[], what: string): Promise<string> {
		return this.must(["git", "-C", cwd, ...args], cwd, what);
	}

	announce(): void {
		const t = this.tree;
		const what = t.kind === "ref" ? `${t.ref} of ${SOURCE}, unpacked with git archive` : `${t.dir}${t.kind === "plain" ? " (no .git: copied as it is)" : " (HEAD plus its uncommitted and untracked files)"}`;
		this.say(`scratch-smoke ${this.token}`);
		this.say("What this does:");
		this.say("  1. copies the tree under test into a run directory and installs its profile into a throwaway HOME there");
		this.say("  2. routes every model call to a local scripted stub and every other request to a local proxy that refuses it (no provider, no spend)");
		this.say("  3. probes the OS fence with one bash call; a nested sandbox (run inside a lane) stops the run here");
		this.say(`  4. opens workload ${this.wl} in the throwaway ledger and launches its lane through the copy's surface/scripts/lane.ts`);
		this.say(`  5. the lane's scripted bash calls do the repo lifecycle in "$AS2_SCRATCH/…"; then this script checks the run`);
		this.say(`tree under test: ${what}`);
		this.say(`writes only: ${join(LOG_DIR, `run-${this.runId}`)} (deleted on PASS, kept otherwise) and this log: ${this.logPath}`);
		this.say("exit: 0 PASS, 1 FAIL, 2 harness error (stops at the first one)");
	}

	buildEnv(proxyUrl: string, psShim: boolean): Record<string, string> {
		const omp = Bun.which("omp");
		const git = Bun.which("git");
		if (!omp) throw new HarnessError("no omp on PATH");
		if (!git) throw new HarnessError("no git on PATH");
		const shim = psShim ? [resolve(SOURCE, PS_SHIM, "..")] : [];
		const path = [...new Set([...shim, resolve(process.execPath, ".."), resolve(omp, ".."), resolve(git, ".."), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
		return {
			PATH: path,
			HOME: this.home,
			TMPDIR: join(this.R, "tmp"),
			XDG_CONFIG_HOME: join(this.home, ".config"),
			XDG_CACHE_HOME: join(this.home, ".cache"),
			XDG_DATA_HOME: join(this.home, ".local", "share"),
			XDG_STATE_HOME: join(this.home, ".local", "state"),
			BUN_INSTALL_CACHE_DIR: join(this.R, "bun-cache"),
			AGENT_SYSTEM_LEDGER_DB: join(this.home, ".agent-system-2", "ledger.db"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: join(this.R, "gitconfig"),
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "/usr/bin/false",
			AGENT_SYSTEM_PROFILE: PROFILE,
			OMP_PROFILE: PROFILE,
			AGENT_SYSTEM_LEASE_MS: String(LEASE_MS),
			HTTP_PROXY: proxyUrl,
			HTTPS_PROXY: proxyUrl,
			ALL_PROXY: proxyUrl,
			http_proxy: proxyUrl,
			https_proxy: proxyUrl,
			all_proxy: proxyUrl,
			NO_PROXY: "127.0.0.1,localhost",
			no_proxy: "127.0.0.1,localhost",
			LANG: "en_US.UTF-8",
		};
	}

	/** Every path the lane machinery writes resolves under the run directory and is not the live one; a HarnessError otherwise. */
	guard(): void {
		const under = (p: string) => p.startsWith(`${this.R}/`);
		const live = homedir();
		const checks: [string, string, string][] = [
			["ledger", canonicalPath(defaultLedgerPath(this.env)), canonicalPath(defaultLedgerPath(process.env))],
			["lanes dir", resolve(laneDir(this.wl, this.home)), resolve(laneDir(this.wl, live))],
			["worktree", resolve(worktreePath(this.repo, this.wl)), resolve(worktreePath(SOURCE, this.wl))],
			["profile dir", join(this.home, ".omp", "profiles", PROFILE, "agent"), join(live, ".omp", "profiles", PROFILE, "agent")],
			["scratch root", this.root, scratchRootFor(live, this.wl)],
		];
		const problems = checks.flatMap(([what, p, l]) => [...(under(p) ? [] : [`${what} ${p} is not under ${this.R}`]), ...(p === l ? [`${what} ${p} is the live path`] : [])]);
		if (problems.length > 0) throw new HarnessError(`isolation guard refused to start: ${problems.join("; ")}`);
	}

	async setup(): Promise<void> {
		const runDir = join(LOG_DIR, `run-${this.runId}`);
		mkdirSync(runDir, { recursive: true });
		this.R = realpathSync(runDir);
		this.home = join(this.R, "home");
		this.repo = join(this.R, "repo");
		this.root = scratchRootFor(this.home, this.wl);
		const blocked = psProblem("/bin/ps");
		if (blocked !== null) {
			const standIn = psProblem(join(SOURCE, PS_SHIM));
			if (standIn !== null) throw new HarnessError(`ps cannot be executed (${blocked}) and the stand-in failed too (${standIn}); lane.ts needs one`);
			this.say(`ps: /bin/ps blocked (${blocked}); the committed stand-in ${PS_SHIM} goes first on the run's PATH`);
		}
		this.proxy = startProxy();
		this.proxy.setPhase("setup");
		this.stub = startStub({ nonce: this.token, scripts: this.scripts() });
		this.env = this.buildEnv(this.proxy.url, blocked !== null);
		this.guard();
		for (const d of [this.home, this.env.TMPDIR!, this.env.BUN_INSTALL_CACHE_DIR!]) mkdirSync(d, { recursive: true });
		writeFileSync(this.env.GIT_CONFIG_GLOBAL!, "[user]\n\tname = scratch-smoke\n\temail = scratch-smoke@localhost\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n");

		this.say("setup: copying the tree");
		await this.copyTree();
		const scratchContract = existsSync(join(this.repo, "gates", "src", "scratch.ts"));
		this.launchEnv = { ...this.env };
		if (!scratchContract) {
			// The launcher of such a tree exports no AS2_SCRATCH: the same root, created here and passed in, so the commands
			// target the same paths as on a tree that has the contract, and never expand to `/…`.
			mkdirSync(this.root, { recursive: true, mode: 0o700 });
			this.launchEnv[SCRATCH_ENV] = this.root;
			this.say(`setup: the tree has no gates/src/scratch.ts: ${SCRATCH_ENV}=${this.root} is passed to the launch by this script; refusals expected (FAIL)`);
		} else this.say(`setup: the tree has the scratch contract; the launcher must export ${SCRATCH_ENV} itself (expected ${this.root})`);

		this.say("setup: install/install.sh into the throwaway HOME");
		const agentDir = await installProfile({ repo: this.repo, home: this.home, path: this.env.PATH!, runDir: this.R, run: (cmd, o) => this.run(cmd, o), say: (l) => this.say(l) });
		writeStubProfile(agentDir, this.stub.port, { chatModel: CHAT_MODEL });
	}

	/** The tree under test as the git checkout `repo`, with a bare `origin` beside it (lane.ts cuts the lane branch from origin's default). */
	async copyTree(): Promise<void> {
		const t = this.tree;
		let what: string;
		if (t.kind === "checkout") {
			await this.git(this.R, ["clone", "--quiet", "--no-hardlinks", t.dir, this.repo], "clone");
			const n = await this.overlay(t.dir);
			what = `${(await this.git(t.dir, ["rev-parse", "HEAD"], "tree HEAD")).trim()} of ${t.dir} with ${n} working-tree path(s) laid over`;
		} else {
			mkdirSync(this.repo);
			if (t.kind === "plain") {
				await this.must(["cp", "-c", "-R", `${t.dir}/.`, this.repo], this.R, "copy of the tree");
				what = `${t.dir} as it is`;
			} else {
				const sha = (await this.git(SOURCE, ["rev-parse", "--verify", `${t.ref}^{commit}`], `resolve ${t.ref}`)).trim();
				const tar = join(this.R, "tree.tar");
				await this.git(SOURCE, ["archive", "--format=tar", "-o", tar, sha], "git archive");
				await this.must(["tar", "-x", "-f", tar, "-C", this.repo], this.R, "unpack");
				rmSync(tar);
				what = `${t.ref} = ${sha}`;
			}
			await this.git(this.repo, ["init", "--quiet", "-b", "main"], "git init of the copy");
		}
		const dest = join(this.repo, "node_modules");
		if (!existsSync(dest)) {
			const from = [t.kind === "ref" ? null : join(t.dir, "node_modules"), join(SOURCE, "node_modules")].find((p): p is string => p !== null && existsSync(p));
			if (from) {
				const refused = scratchNewPathRefusal(this.repo, dest);
				if (refused !== null) throw new HarnessError(`refusing the node_modules copy: ${refused}`);
				await this.must(["cp", "-c", "-R", from, dest], this.R, "node_modules copy");
			}
		}
		await this.git(this.repo, ["add", "-A"], "copy commit");
		await this.git(this.repo, ["commit", "--quiet", "--no-verify", "--allow-empty", "-m", `scratch smoke ${this.token}: ${what}`], "copy commit");
		const origin = join(this.R, "origin.git");
		await this.git(this.R, ["clone", "--quiet", "--bare", this.repo, origin], "bare origin");
		const hasOrigin = (await this.run(["git", "-C", this.repo, "remote", "get-url", "origin"], { cwd: this.repo, ms: 30_000 })).code === 0;
		await this.git(this.repo, ["remote", hasOrigin ? "set-url" : "add", "origin", origin], "origin remote");
		await this.git(this.repo, ["fetch", "--quiet", "--prune", "origin"], "fetch origin");
		await this.git(this.repo, ["remote", "set-head", "origin", "-a"], "origin HEAD");
		this.say(`setup: tree copied: ${what}`);
	}

	/** `dir`'s uncommitted changes and untracked files, laid over the clone (chaos.ts overlayWorkingTree). */
	async overlay(dir: string): Promise<number> {
		const read = (args: string[]) => this.run(["git", "--no-optional-locks", "-C", dir, ...args], { cwd: dir, env: { ...this.env, GIT_OPTIONAL_LOCKS: "0" }, ms: 60_000 });
		const changed = await read(["diff", "--name-only", "-z", "HEAD"]);
		const untracked = await read(["ls-files", "-z", "--others", "--exclude-standard"]);
		if (changed.code !== 0 || untracked.code !== 0) throw new HarnessError(`reading the tree's working tree failed: ${oneLine(changed.err || untracked.err)}`);
		const paths = [...new Set([...changed.out.split("\0"), ...untracked.out.split("\0")].filter((p) => p !== ""))];
		for (const p of paths) {
			const from = join(dir, p);
			const to = join(this.repo, p);
			if (existsSync(from) && lstatSync(from).isFile()) copyIntoScratch(this.repo, from, to);
			else if (!existsSync(from)) removeFromScratch(this.repo, to);
		}
		return paths.length;
	}

	// ---- the stub scripts ------------------------------------------------------------------------

	scripts(): StubScript[] {
		const probe: StubScript = {
			kind: "probe-fence",
			match: (r) => r.firstUser.includes(FENCE_MARK),
			steps: [{ text: "running the fence probe", tool: { name: "bash", input: { command: `printf ${FENCE_OK}`, i: "Running the fence probe" } } }],
			after: ({ request }) => {
				const r = request.results.at(-1);
				if (r) this.fenceResults.push({ text: r.text, isError: r.isError });
				return { text: `fence probe said: ${oneLine(r?.text ?? "nothing", 200)}` };
			},
		};
		const lane: StubScript = {
			kind: "lane",
			match: (r) => /You are a \*\*lane\*\*/.test(r.system) || (r.tools.includes("lane_add_slice") && r.firstUser.includes(this.wl)),
			steps: [],
			after: ({ request }) => this.laneTurn(request),
		};
		const unmatched: StubScript = {
			kind: "unmatched",
			match: () => {
				this.unmatched++;
				return true;
			},
			steps: [],
			after: { text: "scratch smoke: no script for this session" },
		};
		return [probe, lane, unmatched];
	}

	/** One lane turn: the step for a request holding n tool results is the plan's step n (one tool call per turn). */
	laneTurn(request: StubRequest): StubTurn {
		const n = request.results.length;
		if (n >= this.results.length) this.results = request.results;
		for (const [i, r] of request.results.entries()) {
			if (this.seen.has(r.toolUseId)) continue;
			this.seen.add(r.toolUseId);
			const step = this.issued[i];
			const why = resultProblem(r.name ?? "?", r);
			this.say(`  lane ${String(i).padStart(2)} ${step?.id ?? r.name ?? "?"}: ${why === null ? "ok" : why}`);
		}
		const echo = this.plan.findIndex((s) => s.id === "echo-root");
		if (this.aborted === null && n > echo) {
			const printed = request.results[echo]?.text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
			if (printed !== this.root) this.aborted = `the lane printed ${JSON.stringify(printed)} for $AS2_SCRATCH, expected ${this.root}`;
			if (this.aborted !== null) this.plan = [...this.plan.slice(0, echo + 1), ...abortPlan(this.token, this.aborted)];
		}
		const rm = this.plan.findIndex((s) => s.id === "rm");
		if (n === rm && this.harnessRefs === null) {
			const r = Bun.spawnSync(["git", "-C", join(this.root, NAMES.bare), "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"], { env: this.env, stdout: "pipe", stderr: "pipe" });
			this.harnessRefs = r.exitCode === 0 ? r.stdout.toString() : `for-each-ref exited ${r.exitCode}: ${oneLine(r.stderr.toString(), 200)}`;
			this.say(`  harness read of the bare repo before the rm: ${oneLine(this.harnessRefs, 300)}`);
		}
		const step = this.plan[n];
		if (!step) return { text: "scratch smoke lane: released." };
		this.issued[n] = step;
		return { text: `scratch smoke step ${n} ${step.id}`, tool: { name: step.tool, input: step.input } };
	}

	// ---- probe and lane --------------------------------------------------------------------------

	/** One scripted bash call in a plain omp: it must run under the fence. A nested sandbox is a harness error, never worked around. */
	async fenceProbe(): Promise<void> {
		this.proxy!.setPhase("probe");
		const r = await this.run(["omp", "-p", "--no-session", "--model", CHAT_MODEL, `${FENCE_MARK}: run the fence probe`], { cwd: this.repo, ms: PROBE_MS });
		const got = this.fenceResults.at(-1);
		if (!got) throw new HarnessError(`fence probe: the bash result never reached the stub (omp exit ${r.code}${r.timedOut ? ", timed out" : ""}: ${oneLine(r.err || r.out)})`);
		if (/sandbox_apply/.test(got.text)) {
			throw new HarnessError(`fence probe: the OS fence cannot wrap a bash call here (nested sandbox: ${oneLine(got.text, 200)}). The scratch rules hold only inside that fence and refuse a call it cannot confine, so this run cannot show anything here; run it from a plain terminal.`);
		}
		if (!got.text.includes(FENCE_OK) || got.isError) throw new HarnessError(`fence probe failed: ${oneLine(got.text, 300)}`);
		this.say("fence probe: a bash call ran under the fence");
	}

	laneEnd(): string | null {
		const l = this.ledger!;
		const e = l.entries(this.wl).find((x) => x.body.startsWith(`lane-exit: ${this.laneId} `));
		if (e) return e.body;
		const m = l.db.query<{ body: string }, [string]>("SELECT body FROM messages WHERE workload_id = ? ORDER BY created_at").all(this.wl).find((x) => x.body.startsWith(`lane-died: ${this.laneId}`));
		return m?.body ?? null;
	}

	async lane(): Promise<string | null> {
		this.proxy!.setPhase("measured");
		this.ledger = Ledger.open(this.env.AGENT_SYSTEM_LEDGER_DB!, { backupOnOpen: false });
		this.ledger.openWorkload({ by: "scratch-smoke", id: this.wl, stakes: "normal", mode: "autonomous", brief: `scratch smoke ${this.token}: the repo lifecycle in the lane's own scratch root, one bash call per step, then release.` });
		recordRepo(this.ledger, this.wl, this.repo);
		const launched = await this.run(["bun", "surface/scripts/lane.ts", "launch", this.wl, "--requested-by", "scratch-smoke"], { cwd: this.repo, env: this.launchEnv, ms: 120_000 });
		const m = /lane (\S+) runner (\d+)/.exec(launched.out);
		if (launched.code !== STARTER_EXIT.ok || !m) throw new HarnessError(`lane.ts launch exited ${launched.code}${launched.timedOut ? " (timed out)" : ""}: ${oneLine(launched.err || launched.out)}`);
		this.laneId = m[1]!;
		this.say(`lane ${this.laneId} launched (runner pid ${m[2]}); waiting up to ${LANE_END_MS / 1000} s for it to end`);
		const deadline = Date.now() + LANE_END_MS;
		for (;;) {
			const end = this.laneEnd();
			if (end !== null) {
				this.say(`lane end: ${oneLine(end, 300)}`);
				return end;
			}
			if (Date.now() > deadline) {
				this.say(`lane end: none within ${LANE_END_MS / 1000} s`);
				return null;
			}
			await Bun.sleep(1_000);
		}
	}

	/** End the lane if its omp still runs (lane.ts stop checks the recorded start time before any signal), then this run's own children. */
	async stopAll(): Promise<void> {
		if (this.ledger && this.laneId) {
			const alive = laneStarts(this.ledger.entries(this.wl)).some((s) => {
				try {
					process.kill(s.pid, 0);
					return true;
				} catch {
					return false;
				}
			});
			if (alive) {
				const r = await this.run(["bun", "surface/scripts/lane.ts", "stop", this.wl], { cwd: this.repo, env: this.launchEnv, ms: 90_000 });
				this.say(`cleanup: lane.ts stop ${this.wl} exited ${r.code}: ${oneLine(r.out || r.err, 300)}`);
			}
		}
		for (const c of this.children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
	}

	async execute(): Promise<number> {
		this.announce();
		let code = 2;
		let reason = "";
		const onSignal = (sig: string) => {
			this.say(`scratch-smoke: ${sig}: stopping; run directory kept at ${this.R || "(not created)"}`);
			void this.stopAll().finally(() => {
				this.stub?.stop();
				this.proxy?.stop();
				process.exit(2);
			});
		};
		process.on("SIGINT", () => onSignal("SIGINT"));
		process.on("SIGTERM", () => onSignal("SIGTERM"));
		try {
			await this.setup();
			await this.fenceProbe();
			const end = await this.lane();
			const observed: Observed = {
				issued: this.issued,
				results: this.results,
				aborted: this.aborted,
				laneEnd: end,
				harnessRefs: this.harnessRefs,
				dirs: { root: existsSync(this.root), clone: existsSync(join(this.root, NAMES.clone)), bare: existsSync(join(this.root, NAMES.bare)) },
				reserved: reservedRequests(this.ledger!, this.wl).map((e) => ({ id: e.id, body: e.body })),
			};
			const j = judge(observed, this.plan);
			this.say("");
			for (const l of j.lines) this.say(l);
			const egress = [...new Set((this.proxy?.attempts("measured") ?? []).map((a) => a.host || `(${a.kind} ${a.target})`).filter((h) => !EXEMPT_HOSTS.includes(h)))];
			if (egress.length > 0) this.say(`note: the proxy refused measured-phase egress to ${egress.join(", ")}`);
			if (this.unmatched > 0) this.say(`note: ${this.unmatched} stub request(s) matched no script (answered with a text)`);
			code = j.pass ? 0 : 1;
			reason = j.pass ? "PASS" : "FAIL";
		} catch (e) {
			reason = `HARNESS-ERROR: ${e instanceof HarnessError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
		} finally {
			try {
				await this.stopAll();
			} catch (e) {
				this.say(`cleanup: ${e instanceof Error ? e.message : String(e)}`);
			}
			this.stub?.stop();
			this.proxy?.stop();
			this.ledger?.close();
		}
		const keep = code !== 0;
		if (!keep && this.R) rmSync(this.R, { recursive: true, force: true });
		this.say("");
		this.say(`scratch-smoke ${this.token}: ${reason}`);
		this.say(`run directory: ${this.R || "(not created)"} (${keep ? "kept" : "deleted"})`);
		this.say(`log: ${this.logPath}`);
		this.say(joBlock());
		return code;
	}
}

// ---- --dry-run: the plan, the commands, and the pure checks exercised -----------------------------

function selfChecks(): { name: string; ok: boolean; detail: string }[] {
	const out: { name: string; ok: boolean; detail: string }[] = [];
	const add = (name: string, ok: boolean, detail = "") => out.push({ name, ok, detail });
	const token = "scratch-smoke-dry";
	const wl = "wl-smokedry";
	const plan = lanePlan(token, wl);
	const steps = smokeSteps(token);

	const commands = steps.map((s) => String(s.input.command));
	add("every bash step spells its targets \"$AS2_SCRATCH/…\" and names no other variable", commands.every((c) => c.includes('"$AS2_SCRATCH') && !/\$(?!AS2_SCRATCH\b)[A-Za-z_{(]/.test(c)), commands.filter((c) => /\$(?!AS2_SCRATCH\b)[A-Za-z_{(]/.test(c)).join(" | "));
	add("one git or shell action per step: no chaining but a leading cd into the root", commands.every((c) => !/&&|;|\|\|/.test(c.replace(/^cd "\$AS2_SCRATCH\/[^"]+" && /, "").replace(/'[^']*'/g, ""))));

	add("resultProblem: a clean bash result is exit 0", resultProblem("bash", { text: "Initialized empty Git repository", isError: false }) === null);
	add("resultProblem: a gate refusal fails", resultProblem("bash", { text: "P-11 row 6 refused this: …", isError: true })?.startsWith("gate refusal") === true);
	add("resultProblem: a nonzero exit fails", resultProblem("bash", { text: "fatal: x\n\nCommand exited with code 128", isError: true })?.startsWith("exit 128") === true);
	add("resultProblem: a backgrounded call fails", resultProblem("bash", { text: "Backgrounded as job bg_1 (no deadline); …", isError: false }) !== null);
	add("resultProblem: no result fails", resultProblem("bash", undefined) === "no result");
	add("resultProblem: an errored lane tool fails", resultProblem("lane_record_entry", { text: "refused", isError: true }) !== null);

	const sha = "a".repeat(40);
	const other = "b".repeat(40);
	add("laneRefsProblem: both refs at HEAD", laneRefsProblem(`${sha}\n`, `${sha}\n${sha}\n`) === null);
	add("laneRefsProblem: a ref elsewhere fails", laneRefsProblem(sha, `${sha}\n${other}`) !== null);
	add("laneRefsProblem: a missing ref fails", laneRefsProblem(sha, `${sha}\nfatal: ambiguous argument`) !== null);
	add("harnessRefsProblem: both refs at HEAD", harnessRefsProblem(`${sha} refs/heads/main\n${sha} refs/heads/${NAMES.feature}\n`, sha) === null);
	add("harnessRefsProblem: no read fails", harnessRefsProblem(null, sha) !== null);
	add("harnessRefsProblem: feature ref absent fails", harnessRefsProblem(`${sha} refs/heads/main\n`, sha) !== null);
	add("exitOutcome: lane-exit outcome", exitOutcome("lane-exit: lane-x-1 code 0 signal - outcome released") === "released" && exitOutcome("lane-died: lane-x-1: …") === null);

	// The ledger query against a throwaway ledger.
	const dir = mkdtempSync(join(tmpdir(), "as2-scratch-smoke-dry-"));
	try {
		const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, backupOnOpen: false });
		try {
			const w = ledger.openWorkload({ by: "scratch-smoke", id: wl, brief: "dry", stakes: "normal", mode: "autonomous" });
			const v = ledger.openWorkload({ by: "scratch-smoke", brief: "other", stakes: "normal", mode: "autonomous" });
			const before = reservedRequests(ledger, w).length;
			ledger.recordEntry({ by: "lane-dry-1", workloadId: w, kind: "assumption", body: "not a request" });
			ledger.recordEntry({ by: "lane-dry-1", workloadId: v, kind: "reserved-request", body: "push: git push origin main (P-11 row 6 refused tool call c0)" });
			const unrelated = reservedRequests(ledger, w).length;
			ledger.recordEntry({ by: "lane-dry-1", workloadId: w, kind: "reserved-request", body: "git checkout --: git checkout -- f (P-11 row 6 refused tool call c1)" });
			const after = reservedRequests(ledger, w);
			add("reservedRequests: zero on a fresh workload, blind to other kinds and other workloads, one after a request", before === 0 && unrelated === 0 && after.length === 1, `before ${before}, unrelated ${unrelated}, after ${after.length}`);
		} finally {
			ledger.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	// judge on a synthetic clean run, then with each failure injected.
	const results: StubToolResult[] = plan.slice(0, -1).map((s, i) => {
		const text = s.id === "echo-root" ? "/root\n" : s.id === "head-clone" ? `${sha}\n` : s.id === "refs-bare" ? `${sha}\n${sha}\n` : "ok";
		return { toolUseId: `t${i}`, name: s.tool, text, isError: false };
	});
	const clean: Observed = {
		issued: plan, results, aborted: null, laneEnd: "lane-exit: lane-x-1 code 0 signal - outcome released",
		harnessRefs: `${sha} refs/heads/main\n${sha} refs/heads/${NAMES.feature}\n`, dirs: { root: true, clone: false, bare: false }, reserved: [],
	};
	const j = judge(clean, plan);
	add("judge: a clean run passes", j.pass, j.lines.filter((l) => l.startsWith("FAIL")).join(" | "));
	const refused = results.map((r) => (r.name === "bash" && r.text === "ok" && r.toolUseId === `t${plan.findIndex((s) => s.id === "checkout")}` ? { ...r, text: "P-11 row 6 refused this", isError: true } : r));
	const failures: [string, Observed][] = [
		["a refused step", { ...clean, results: refused }],
		["a reserved-request entry", { ...clean, reserved: [{ id: "en-x", body: "git checkout -- f" }] }],
		["the clone left behind", { ...clean, dirs: { root: true, clone: true, bare: false } }],
		["the root removed", { ...clean, dirs: { root: false, clone: false, bare: false } }],
		["no harness read", { ...clean, harnessRefs: null }],
		["a lane that died", { ...clean, laneEnd: "lane-died: lane-x-1: turn ended" }],
		["the interlock tripped", { ...clean, aborted: "printed /" }],
		["a missing result", { ...clean, results: results.slice(0, 5) }],
	];
	for (const [what, o] of failures) add(`judge: ${what} fails`, !judge(o, plan).pass);
	return out;
}

function dryRun(): number {
	const token = "scratch-smoke-<run id>";
	const wl = "wl-smoke<run id>";
	process.stdout.write(`scratch-smoke --dry-run: no lane, no copy; ${LOG_DIR} untouched.\n\nThe scripted lane, one tool call per turn:\n`);
	for (const [n, s] of lanePlan(token, wl).entries()) process.stdout.write(`  ${String(n).padStart(2)} ${s.tool.padEnd(17)} ${typeof s.input.command === "string" ? s.input.command : s.id}\n`);
	process.stdout.write("\nPure checks:\n");
	const checks = selfChecks();
	for (const c of checks) process.stdout.write(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail && !c.ok ? ` — ${c.detail}` : ""}\n`);
	const ok = checks.every((c) => c.ok);
	process.stdout.write(`\n${ok ? "all" : "NOT all"} ${checks.length} pure checks hold\n\n${joBlock()}`);
	return ok ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
	const a = parseArgs(argv);
	if (typeof a === "string") {
		process.stderr.write(`scratch-smoke: ${a}\n\n${HELP}`);
		return 2;
	}
	if (a.help) {
		process.stdout.write(`${HELP}\n${joBlock()}`);
		return 0;
	}
	if (a.dryRun) return dryRun();
	return new Run(a.tree).execute();
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
