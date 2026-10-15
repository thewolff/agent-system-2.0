#!/usr/bin/env bun
// chaos: the nightly chaos run's CLI (the approved plan of workload wl-mv45yxnkw2251c, revision 4,
// §§ 2.1–2.7). One injected fault per run against a scratch copy of this checkout and a throwaway
// ledger, judged within 5 minutes, reported to ~/agent-scratch/agent-system-2.0/chaos/.
//
//   bun surface/scripts/chaos.ts --fault <name> [--kill runner]   run one fault
//   bun surface/scripts/chaos.ts --nightly                        the 03:00 PT rotation (launchd)
//   bun surface/scripts/chaos.ts --help
//
// The run, in order:
//  1. The live state is snapshotted (surface/src/chaos.ts isolationSnapshot), then everything else
//     happens under the scratch root S = $TMPDIR/as2-chaos-<runId>, with an env built from scratch
//     (§ 2.1: HOME, TMPDIR, XDG_*, BUN_INSTALL_CACHE_DIR, the scratch ledger, git config, the
//     profile, a 120 s lease, the refusing egress proxy, an absolute PATH of the bun/omp/git dirs).
//     The guard refuses to start (exit 2) unless the ledger, the lanes dir, the worktree and the
//     profile dir all resolve under S and differ from the live ones.
//     Where /bin/ps cannot be executed (ps is setuid, so a run started inside a sandbox, a lane's
//     fenced bash, cannot exec it, and lane.ts startTime, which every lane-started: goes through,
//     would crash the runner), every scratch process gets surface/scripts/ps-shim first on its PATH:
//     the committed ps stand-in (Jo's "shim"), which chaos's own ps calls then use too. The report's
//     `- ps:` line names the ps the run used. Setup refuses (exit 2) only when neither ps works.
//  2. The repo copy: `git clone --no-hardlinks` of this checkout into S/repo; this checkout's
//     uncommitted changes and untracked files laid over it (install.sh renders the profile from the
//     working tree, so the working tree is the system under test, and the copy's manifest check
//     must see the same files); a `cp -c` (APFS clone) of node_modules when there is one; a commit
//     of that together with chaos/scratch.test.ts; then the bare S/origin.git, with origin repointed
//     at it, so the lane branch is cut from a base that holds the scratch test.
//  3. install/install.sh from the copy under `env -i PATH HOME=S/home`; the stub routes and role
//     overlay over the profile it wrote (chaos-stub.ts writeStubProfile).
//  4. The preflight (any miss is HARNESS-ERROR, exit 2, no workload opened): one warm-up omp start
//     in the proxy's `setup` phase (a fresh profile's shared-catalog fetch lands there), then one
//     `omp -p` per chat model id the run routes to (every chat role and every tier row), the judge
//     probe through OMP's own judge client, the egress self-test in the `preflight` bucket, and the
//     § 2.7 fence probe.
//  5. The workload is opened in the throwaway ledger with its `repo:` entry, and the lane launched
//     with `bun surface/scripts/lane.ts launch <wl> --requested-by chaos` from S/repo. The stub
//     scripts the lane (§ 2.2), the change hand, the review hand and the orchestrator.
//  6. The fault's trigger is read from the throwaway ledger every 1 s; the injection records its
//     fault evidence (FAULT_EVIDENCE). The judge polls every 5 s for 300 s, settles 30 s, and
//     `verdict` decides; the measured phase's egress, the nonce check and the harness checks feed it.
//  7. Every process the run owns is killed (Run.killAll: chaos's live children, the pids it verified when it learned them,
//     the scratch ledger's lane-started: omps and runners, and everything below them, each start time checked right before
//     its signal; a process that merely names S is never one), the live state is snapshotted again and diffed, the
//     report is written, and S is deleted on PASS and kept otherwise. Exit 0 PASS, 1 FAIL, 2 HARNESS-ERROR.
//
// Fault 4's trigger is the one not polled: "the lane's turn after its first lane_add_slice" is the
// very next request, which a 1 s poll would race, so the lane script's match arms the refusal on
// that request inside the stub (the request is then refused in the same call).
//
// chaos never exports AGENT_SYSTEM_LEDGER_DB in a shell command (P-11 row 10): the scratch path is
// set only in the env objects passed to Bun.spawn.
import type { Subprocess } from "bun";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseHandSpawn, settledTokens } from "../../classifier/src/lab";
import { type EntryRow, Ledger } from "../../ledger/src/index";
import { canonicalPath, defaultLedgerPath, homeDir } from "../../ledger/src/locality";
import {
	copyIntoScratch, END_RECEIPT_SKEW_MS, type Evidence, type EvidenceItem, emptySeen, FAULT_EVIDENCE, FAULTS, type FaultName, firstHolder, HarnessError, type IsolationDiff,
	type IsolationSnapshot, isFault, isolationDiff, isolationSnapshot, isOmpCommand, isScratchRunner, judgePoll, killRefusal, killTargets, type LaneStart, laneStarts, liveActorsOf,
	namesPath, newStarts, nightlyDue, nightlyFault, type OwnedProc,
	type Poll, POLL_MS, type ProcRow, PS_SHIM, type PsSource, removeFromScratch, type RunReport, renderReport, reportPath, sameStart, scratchNewPathRefusal, SECOND_RUNNER_EVIDENCE,
	secondRunnerJudgement, type Seen, SETTLE_MS, type Verdict,
	verdict, WINDOW_MS, type WorkloadRows, workloadRows, writeScratchFile,
} from "../src/chaos";
import { recordRepo } from "../src/decision-log";
import { laneDir, STARTER_EXIT, worktreePath } from "../src/launch";
import { type Proxy, type ProxyAttempt, startProxy } from "./chaos-proxy";
import { type Stub, type StubProfile, type StubRequest, type StubScript, type StubTurn, startStub, writeStubProfile } from "./chaos-stub";
import { isRunnerCommand } from "./lane";

/**
 * Hosts whose measured-phase proxy attempts are listed in the report rather than failing the run.
 * catalog.stencil.so is OMP's shared-catalog refetch (chaos-stub.ts header, "Background egress"):
 * an omp started 5 min or more after the last fetch makes it again, and the proxy refuses it. Jo
 * allowed it in in-mv4qsdpkrvu3gg. Every other host in the measured phase FAILs the run (§ 2.1).
 */
export const CHAOS_EXEMPT_EGRESS_HOSTS: string[] = ["catalog.stencil.so"];
const EXEMPT_LABEL = "exempt (omp catalog refetch, refused by the proxy; Jo in-mv4qsdpkrvu3gg)";

/** The checkout this script runs from: the code under test, cloned into the scratch root. */
const SOURCE = resolve(import.meta.dir, "..", "..");
const PROFILE = "agent-system-2";
const REPORTS_DIR = join(homedir(), "agent-scratch", "agent-system-2.0", "chaos");
/** The scratch lease (§ 2.1): a runner killed with its lane surfaces through the lapse inside the window. */
const LEASE_MS = 120_000;
/** The chat model every chat role is pinned to (writeStubProfile's default). */
const CHAT_MODEL = "anthropic/claude-haiku-4-5";
/** The egress self-test: an un-routed provider, with a fake key given only to that probe. */
const EGRESS_PROBE = { provider: "groq", model: "groq/gemma2-9b-it", host: "api.groq.com", keyEnv: "GROQ_API_KEY" };
// Jev capability card: skills/jev/SKILL.md (read before changing this call or its threshold)
const JUDGE_MODEL = "jev-1.13.0";
/** From launch to the trigger: the lane must reach the fault's moment within this. */
const TRIGGER_MS = 240_000;
const PROBE_MS = 90_000;
/** How long the stub holds the stalled hand (fault 1) and the review hand (fault 2) (§ 2.4). */
const HAND_STALL_MS = 180_000;
const REVIEW_STALL_MS = 90_000;
const BLACKHOLE_MS = 60_000;
const RESTART_DELAY_MS = 5_000;
/** Fault 5 part (ii): how long the second runner is watched before it is ended. */
const SECOND_RUNNER_WATCH_MS = 30_000;

/** The scripted slices (§ 2.2). The ids are the dispatch names, so they stay short and fixed. */
const SL_CHANGE = "sl-chaos-change";
const SL_REVIEW = "sl-chaos-review";
const SL_HOLD = "sl-chaos-hold";
/** Markers in a hand's brief that tell the stub which hand a request is. "review" must stay out of the change brief: the judge stub reads it. */
const BUILD_MARK = "chaos-step-build";
const REVIEW_MARK = "chaos-step-review";
const PROBE_FENCE_MARK = "chaos-probe-fence";
const PROBE_MODEL_MARK = "chaos-probe-model";
const FENCE_OK = "chaos-fence-ok";

const HELP = `usage: bun surface/scripts/chaos.ts --fault <name> [--kill runner]
       bun surface/scripts/chaos.ts --nightly
       bun surface/scripts/chaos.ts --help

Runs one injected fault against a scratch copy of this checkout and a throwaway ledger under
$TMPDIR/as2-chaos-<runId>, judges it within 5 minutes of injection (plus a 30 s settle), and writes
${REPORTS_DIR}/<PT date>-<fault>.md.

  --fault <name>   one of: ${FAULTS.join(", ")}
  --kill runner    with lane-kill-mid-hand: SIGKILL the lane runner as well as its omp
  --nightly        run FAULTS[days since epoch of the PT date % 5], only while PT wall time is in
                   [03:00, 03:15) and that date has no report yet (otherwise exit 0, nothing written);
                   requires fence: on
  --help           this text

Every model call goes to a local stub and every other request to a refusing proxy: no spend, no
credential. Exit: 0 PASS, 1 FAIL, 2 HARNESS-ERROR (also: bad arguments, the isolation guard).
The scratch root is deleted on PASS and kept otherwise. Where /bin/ps cannot be executed (a lane's
fence), the run uses the committed stand-in ${PS_SHIM}, and the report's ps line says so.
`;

interface Ran {
	code: number | null;
	out: string;
	err: string;
	timedOut: boolean;
	ms: number;
}

// Process listing goes through pgrep, not ps: ps is setuid root, and a run inside a sandbox (a lane's
// fence) cannot exec it (posix_spawn EPERM). ps is still asked for a start time and a command: /bin/ps
// where it runs, else the committed stand-in (choosePs).

/** Every process with its full command line (`pgrep -l -f -a .`; -a keeps this process's ancestors in the list). */
function processList(): { pid: number; command: string }[] {
	const r = Bun.spawnSync(["pgrep", "-l", "-f", "-a", "."], { stdout: "pipe", stderr: "pipe" });
	const out: { pid: number; command: string }[] = [];
	for (const line of r.stdout.toString().split("\n")) {
		const m = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (m) out.push({ pid: Number(m[1]), command: m[2]! });
	}
	return out;
}

/** `roots` and every process below them, by `pgrep -P`: each pid found → the parent it was found under (a root → 0). */
function descendantEdges(roots: Iterable<number>): Map<number, number> {
	const out = new Map<number, number>();
	for (const r of roots) out.set(r, 0);
	const queue = [...out.keys()];
	while (queue.length > 0) {
		const parent = queue.shift()!;
		const r = Bun.spawnSync(["pgrep", "-P", String(parent)], { stdout: "pipe", stderr: "pipe" });
		for (const s of r.stdout.toString().split(/\s+/)) {
			const pid = Number(s);
			if (s !== "" && !out.has(pid)) {
				out.set(pid, parent);
				queue.push(pid);
			}
		}
	}
	return out;
}

/**
 * The stand-in, absolute, in the checkout this script runs from. Never a copy under $TMPDIR (the scratch repo
 * lies there): Jo denied a temp-path shim (en-mv4r7pwm008o3k).
 */
const PS_SHIM_ABS = join(SOURCE, PS_SHIM);
const PS_SHIM_DIR = dirname(PS_SHIM_ABS);
/** chaos's own ps calls: bun's dir ahead of this PATH, so the stand-in's `#!/usr/bin/env bun` resolves as on the scratch PATH. */
const PS_ENV: Record<string, string | undefined> = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(":") };

/**
 * `<ps> -o lstart=,command= -p <pid>`: the process start time (lane.ts startTime's lstart, five fields) and its
 * command, or null when gone. `ps` is the one setup chose (choosePs), so it can be executed.
 */
function psInfo(ps: string, pid: number): { lstart: string; command: string } | null {
	const r = Bun.spawnSync([ps, "-o", "lstart=,command=", "-p", String(pid)], { env: PS_ENV, stdout: "pipe", stderr: "pipe" });
	const m = /^\s*(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/s.exec(r.stdout.toString().trim());
	return r.exitCode === 0 && m ? { lstart: m[1]!, command: m[2]!.trim() } : null;
}

/** This process's ancestors up to launchd, by `<ps> -p <pid> -o ppid=`: chaos never signals one. */
function ancestorPids(ps: string): Set<number> {
	const out = new Set<number>();
	let pid = process.ppid;
	while (pid > 1 && !out.has(pid)) {
		out.add(pid);
		const r = Bun.spawnSync([ps, "-p", String(pid), "-o", "ppid="], { env: PS_ENV, stdout: "pipe", stderr: "pipe" });
		const next = Number(r.stdout.toString().trim());
		if (r.exitCode !== 0 || !Number.isInteger(next)) break;
		pid = next;
	}
	return out;
}

/** `<ps> -p <own pid> -o pid=`: null when it answers with this process's pid, else why not (a sandbox makes the setuid /bin/ps fail with EPERM). */
function psProbe(ps: string): string | null {
	try {
		const r = Bun.spawnSync([ps, "-p", String(process.pid), "-o", "pid="], { env: PS_ENV, stdout: "pipe", stderr: "pipe" });
		if (r.exitCode === 0 && r.stdout.toString().trim() === String(process.pid)) return null;
		return `${ps} -p ${process.pid} -o pid= exited ${r.exitCode}: ${oneLine(r.stderr.toString() || r.stdout.toString() || "no output", 200)}`;
	} catch (e) {
		return oneLine(e instanceof Error ? e.message : String(e), 200);
	}
}

/** The ps the run uses: the real /bin/ps where it can be executed, else the committed stand-in (Jo's "shim"), else none. */
function choosePs(): PsSource {
	const blocked = psProbe("/bin/ps");
	if (blocked === null) return { kind: "real" };
	const standIn = psProbe(PS_SHIM_ABS);
	return standIn === null ? { kind: "stand-in", blocked } : { kind: "none", blocked, standIn };
}

const iso = (t: number = Date.now()): string => new Date(t).toISOString();
const secs = (ms: number): string => `${Math.round(ms / 1000)} s`;
const oneLine = (s: string, max = 300): string => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Every assistant message under `dirs` (session .jsonl files of the scratch run) that carries content but not the nonce. */
function nonceMisses(dirs: readonly string[], nonce: string): string[] {
	const misses: string[] = [];
	const visit = (node: unknown, where: string): void => {
		if (Array.isArray(node)) {
			for (const x of node) visit(x, where);
			return;
		}
		if (node === null || typeof node !== "object") return;
		const o = node as Record<string, unknown>;
		if (o.role === "assistant" && Array.isArray(o.content)) {
			const blocks = o.content.filter((b) => b !== null && typeof b === "object" && "type" in b && ["text", "toolCall", "tool_use"].includes(String(b.type)));
			if (blocks.length > 0 && !JSON.stringify(o.content).includes(nonce)) misses.push(where);
			return;
		}
		for (const v of Object.values(o)) visit(v, where);
	};
	const walk = (dir: string): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(dir, name);
			let st;
			try {
				st = lstatSync(path);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(path);
			else if (st.isFile() && name.endsWith(".jsonl")) {
				const lines = readFileSync(path, "utf8").split("\n");
				lines.forEach((line, i) => {
					if (!line.trim().startsWith("{")) return;
					try {
						visit(JSON.parse(line), `${path}:${i + 1}`);
					} catch {
						// a partial last line of a killed session
					}
				});
			}
		}
	};
	for (const d of dirs) walk(d);
	return misses;
}

interface Args {
	fault: FaultName | null;
	variant: string | null;
	nightly: boolean;
	help: boolean;
}

function parseArgs(argv: string[]): Args | string {
	const a: Args = { fault: null, variant: null, nightly: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const x = argv[i]!;
		if (x === "--help" || x === "-h") a.help = true;
		else if (x === "--nightly") a.nightly = true;
		else if (x === "--fault" || x.startsWith("--fault=")) {
			const v = x.includes("=") ? x.slice(x.indexOf("=") + 1) : argv[++i];
			if (!v || !isFault(v)) return `--fault takes one of ${FAULTS.join(", ")}; got ${v ?? "nothing"}`;
			a.fault = v;
		} else if (x === "--kill" || x.startsWith("--kill=")) {
			const v = x.includes("=") ? x.slice(x.indexOf("=") + 1) : argv[++i];
			if (v !== "runner") return `--kill takes runner; got ${v ?? "nothing"}`;
			a.variant = "kill runner";
		} else return `unknown argument ${x}`;
	}
	if (a.help) return a;
	if (a.nightly && a.fault) return "--nightly picks its own fault; give --fault or --nightly, not both";
	if (!a.nightly && !a.fault) return "give --fault <name> or --nightly";
	if (a.variant && a.fault !== "lane-kill-mid-hand") return "--kill runner is a variant of lane-kill-mid-hand only";
	return a;
}

class Run {
	readonly runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0")}`;
	readonly token = `chaos-${this.runId}`;
	readonly wl = `wl-chaos-${this.runId}`;
	readonly started = Date.now();
	S = "";
	home = "";
	repo = "";
	env: Record<string, string> = {};
	agentDir = "";
	liveCheckout = "";
	stub: Stub | null = null;
	proxy: Proxy | null = null;
	profile: StubProfile | null = null;
	ledger: Ledger | null = null;
	before: IsolationSnapshot | null = null;
	fence: "on" | "off (nested sandbox)" = "on";
	/** The ps the run uses (choosePs, first in setup) and the binary chaos's own ps calls run. */
	ps: PsSource = { kind: "unchecked" };
	psBin = "/bin/ps";
	/** chaos's own ancestors (ancestorPids, in setup once the ps is chosen): never signalled. */
	shield: Set<number> | null = null;
	laneId: string | null = null;
	runnerPid: number | null = null;
	/** The runner's start time, from ps when the launch named its pid and its command was verified as this run's (`isScratchRunner`); null when not verified. */
	runnerStart: string | null = null;
	/** Processes verified as the run's own when chaos learned their pids, with their start times then (killAll's roots beside its live children). */
	owned: OwnedProc[] = [];
	measuredAt: number | null = null;
	triggerAt: string | null = null;
	injectedAt: string | null = null;
	polls: Poll[] = [];
	lastPoll: Poll | null = null;
	items = new Map<string, EvidenceItem>();
	harness: string[] = [];
	notes: string[] = [];
	runners: { label: string; exitCode: number | null; stderr: string }[] = [];
	children = new Set<Subprocess>();
	/** Lane tool results seen by the stub, in order, for the report of a run that did not pass. */
	laneResults = new Map<string, string>();
	fenceResults: { text: string; isError: boolean }[] = [];
	/** Background work an injection started (fault 2's restart, fault 5's runners); awaited before the verdict. */
	pending: Promise<void>[] = [];
	/** The evidence `decide` judged, for the report; null when the run never reached the verdict. */
	evidence: Evidence | null = null;
	orchestrator: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	orchestratorStarts: number[] = [];
	/** The current orchestrator's start time, read from ps right after chaos spawned it; the kill check compares it. */
	orchestratorLstart = "";
	/** Fault-specific state. */
	f: Record<string, unknown> = {};

	constructor(readonly fault: FaultName, readonly variant: string | null, readonly nightly: boolean) {
		for (const name of FAULT_EVIDENCE[fault]) this.items.set(name, { name, observed: "not observed", at: null });
	}

	observe(name: string, observed: string, extra: Partial<EvidenceItem> = {}): void {
		const item = this.items.get(name);
		if (!item) throw new Error(`no evidence item ${name} for ${this.fault}`);
		if (item.at !== null && extra.lostAt === undefined) return;
		this.items.set(name, { ...item, observed, at: extra.at !== undefined ? extra.at : (item.at ?? iso()), ...extra });
	}

	// ---- processes ---------------------------------------------------------------------------------

	spawn(cmd: string[], o: { cwd: string; env?: Record<string, string>; stdin?: "pipe" | "ignore" }): Subprocess<"pipe" | "ignore", "pipe", "pipe"> {
		const p = Bun.spawn(cmd, { cwd: o.cwd, env: o.env ?? this.env, stdin: o.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
		this.children.add(p);
		void p.exited.then(() => this.children.delete(p));
		return p;
	}

	async run(cmd: string[], o: { cwd: string; env?: Record<string, string>; ms: number }): Promise<Ran> {
		const t0 = Date.now();
		const p = this.spawn(cmd, o);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			p.kill("SIGKILL");
		}, o.ms);
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		clearTimeout(timer);
		return { code, out, err, timedOut, ms: Date.now() - t0 };
	}

	git(cwd: string, args: string[], ms = 120_000): Promise<Ran> {
		return this.run(["git", "-C", cwd, ...args], { cwd, ms });
	}

	async mustGit(cwd: string, args: string[], what: string): Promise<string> {
		const r = await this.git(cwd, args);
		if (r.code !== 0) throw new HarnessError(`${what}: git ${args.join(" ")} exited ${r.code}: ${oneLine(r.err || r.out)}`);
		return r.out;
	}

	/**
	 * SIGKILL every process the run owns and everything below them (`killTargets`): chaos's live children (it holds their
	 * handles), the processes it verified when it learned their pids (`owned`), and the scratch ledger's `lane-started:` omps
	 * (by their recorded start) and runners (`lane.ts run` of this workload from the scratch repo). A process that only names
	 * S in its command is never a target.
	 */
	killAll(): number {
		if (!this.S) return 0;
		let killed = 0;
		for (let round = 0; round < 4; round++) {
			const owned = [...this.owned, ...this.ledgerOwned()];
			for (const c of this.children) {
				if (c.exitCode !== null || c.signalCode !== null) continue;
				const ps = psInfo(this.psBin, c.pid);
				if (ps) owned.push({ pid: c.pid, lstart: ps.lstart, what: "chaos child" });
			}
			const n = this.killOwned(owned);
			if (n === 0) break;
			killed += n;
			Bun.sleepSync(300);
		}
		return killed;
	}

	/** SIGKILL `owned` and everything below them (`killTargets`), each target's start time checked again right before its signal. */
	killOwned(owned: readonly OwnedProc[]): number {
		const shield = this.shield ?? ancestorPids(this.psBin);
		const rows: ProcRow[] = [];
		for (const [pid, ppid] of descendantEdges(owned.map((o) => o.pid))) {
			const ps = psInfo(this.psBin, pid);
			if (ps) rows.push({ pid, ppid, lstart: ps.lstart, command: ps.command });
		}
		let killed = 0;
		for (const t of killTargets(rows, owned, process.pid, shield)) {
			const now = psInfo(this.psBin, t.pid);
			if (!now || !sameStart(now.lstart, t.lstart)) continue;
			try {
				process.kill(t.pid, "SIGKILL");
				killed++;
			} catch {
				// gone between the check and the signal
			}
		}
		return killed;
	}

	/** The scratch ledger's `lane-started:` processes: each omp by its recorded start, each runner while ps shows it running `lane.ts run` of this workload from the scratch repo. */
	ledgerOwned(): OwnedProc[] {
		if (!this.ledger) return [];
		let starts: LaneStart[];
		try {
			starts = laneStarts(this.entries());
		} catch {
			return [];
		}
		const out: OwnedProc[] = [];
		for (const s of starts) {
			if (s.pid > 0 && s.start !== "") out.push({ pid: s.pid, lstart: s.start, what: `lane omp of ${s.laneId}` });
			const ps = s.runnerPid > 0 ? psInfo(this.psBin, s.runnerPid) : null;
			if (ps && isScratchRunner(ps.command, this.repo, this.wl, s.laneId, isRunnerCommand)) out.push({ pid: s.runnerPid, lstart: ps.lstart, what: `runner of ${s.laneId}` });
		}
		return out;
	}

	/** Own every process below `pid` now, with its start time: called before chaos kills `pid`, whose children then lose it as their parent. */
	adoptBelow(pid: number, what: string): void {
		for (const [child, parent] of descendantEdges([pid])) {
			const ps = child === pid ? null : psInfo(this.psBin, child);
			if (ps) this.owned.push({ pid: child, lstart: ps.lstart, what: `below ${what} (parent ${parent})` });
		}
	}

	// ---- setup (§ 2.1) -----------------------------------------------------------------------------

	buildEnv(proxyUrl: string): Record<string, string> {
		const S = this.S;
		const omp = Bun.which("omp");
		const git = Bun.which("git");
		if (!omp) throw new HarnessError("no omp on PATH");
		if (!git) throw new HarnessError("no git on PATH");
		// The stand-in's dir goes first only when /bin/ps is blocked (setup's choosePs): lane.ts and its children find `ps` there.
		const shim = this.ps.kind === "stand-in" ? [PS_SHIM_DIR] : [];
		const path = [...new Set([...shim, dirname(process.execPath), dirname(omp), dirname(git), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
		return {
			PATH: path,
			HOME: this.home,
			TMPDIR: join(S, "tmp"),
			XDG_CONFIG_HOME: join(this.home, ".config"),
			XDG_CACHE_HOME: join(this.home, ".cache"),
			XDG_DATA_HOME: join(this.home, ".local", "share"),
			XDG_STATE_HOME: join(this.home, ".local", "state"),
			BUN_INSTALL_CACHE_DIR: join(S, "bun-cache"),
			AGENT_SYSTEM_LEDGER_DB: join(this.home, ".agent-system-2", "ledger.db"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: join(S, "gitconfig"),
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

	/** § 2.1 "Guard before start": every scratch path under S and none of them a live path; exit 2 otherwise. */
	guard(): void {
		const S = this.S;
		const under = (p: string) => p === S || p.startsWith(`${S}/`);
		const liveHome = homeDir();
		const checks: [string, string, string][] = [
			["ledger", canonicalPath(defaultLedgerPath(this.env)), canonicalPath(defaultLedgerPath(process.env))],
			["lanes dir", resolve(laneDir(this.wl, this.env.HOME!)), resolve(laneDir(this.wl, liveHome))],
			["worktree", resolve(worktreePath(this.repo, this.wl)), resolve(worktreePath(this.liveCheckout, this.wl))],
			["profile dir", resolve(this.agentDir), resolve(join(liveHome, ".omp", "profiles", PROFILE, "agent"))],
		];
		const problems: string[] = [];
		for (const [what, scratch, live] of checks) {
			if (!under(scratch)) problems.push(`${what} ${scratch} is not under ${S}`);
			if (scratch === live) problems.push(`${what} ${scratch} is the live path`);
		}
		if (problems.length > 0) throw new HarnessError(`isolation guard refused to start: ${problems.join("; ")}`);
	}

	async setup(): Promise<void> {
		const t0 = Date.now();
		// ps first: buildEnv puts the stand-in on the scratch PATH when the real ps is blocked (a lane's fence makes the setuid
		// exec fail with EPERM, and lane.ts startTime, which every lane-started: entry goes through, would throw on it).
		this.ps = choosePs();
		if (this.ps.kind === "none") {
			throw new HarnessError(`ps cannot be executed here (${this.ps.blocked}) and the stand-in ${PS_SHIM} failed too (${this.ps.standIn}); lane.ts startTime needs one of them`);
		}
		if (this.ps.kind === "stand-in") this.psBin = PS_SHIM_ABS;
		this.shield = ancestorPids(this.psBin);
		mkdirSync(join(tmpdir(), `as2-chaos-${this.runId}`), { recursive: true });
		this.S = realpathSync(join(tmpdir(), `as2-chaos-${this.runId}`));
		this.home = join(this.S, "home");
		this.repo = join(this.S, "repo");
		this.agentDir = join(this.home, ".omp", "profiles", PROFILE, "agent");
		this.proxy = startProxy();
		this.stub = startStub({ nonce: this.token, scripts: this.scripts() });
		this.env = this.buildEnv(this.proxy.url);
		this.guard();
		for (const d of [this.home, this.env.TMPDIR!, this.env.BUN_INSTALL_CACHE_DIR!]) mkdirSync(d, { recursive: true });
		writeFileSync(this.env.GIT_CONFIG_GLOBAL!, "[user]\n\tname = chaos\n\temail = chaos@localhost\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n");

		// The repo copy, in order (§ 2.1): clone, the working tree laid over it, node_modules, the scratch test commit, then origin.
		// Every write into the clone goes through the scratch writers (surface/src/chaos.ts): a symlink the clone holds, at the
		// path or above it, is refused, never followed.
		await this.mustGit(this.S, ["clone", "--quiet", "--no-hardlinks", SOURCE, this.repo], "clone");
		const overlaid = await this.overlayWorkingTree();
		const modules = join(SOURCE, "node_modules");
		if (existsSync(modules)) {
			const dest = join(this.repo, "node_modules");
			const refused = scratchNewPathRefusal(this.repo, dest);
			if (refused !== null) throw new HarnessError(`refusing the node_modules copy: ${refused}`);
			const r = await this.run(["cp", "-c", "-R", modules, dest], { cwd: this.S, ms: 300_000 });
			if (r.code !== 0) throw new HarnessError(`cp -c of node_modules exited ${r.code}: ${oneLine(r.err)}`);
			this.notes.push("node_modules: cloned with cp -c");
		} else this.notes.push(`node_modules: none in ${SOURCE}; nothing cloned`);
		writeScratchFile(
			this.repo,
			join(this.repo, "chaos", "scratch.test.ts"),
			`// The chaos run's scratch test (surface/scripts/chaos.ts): the hand runs \`bun test chaos/\` on it.\nimport { expect, test } from "bun:test";\n\ntest("chaos scratch", () => {\n\texpect(1 + 1).toBe(2);\n});\n`,
		);
		await this.mustGit(this.repo, ["add", "-A"], "scratch commit");
		await this.mustGit(this.repo, ["commit", "--quiet", "--no-verify", "-m", `chaos ${this.token}: scratch test${overlaid > 0 ? ` and ${overlaid} working-tree path(s) of the source` : ""}`], "scratch commit");
		const origin = join(this.S, "origin.git");
		await this.mustGit(this.S, ["clone", "--quiet", "--bare", this.repo, origin], "bare origin");
		await this.mustGit(this.repo, ["remote", "set-url", "origin", origin], "repoint origin");
		await this.mustGit(this.repo, ["fetch", "--quiet", "--prune", "origin"], "fetch origin");
		await this.mustGit(this.repo, ["remote", "set-head", "origin", "-a"], "origin HEAD");
		const tClone = Date.now();

		// The profile: install.sh from the copy, as a fresh machine (install/fresh-machine-test.sh run_install).
		const install = await this.run(["bash", join(this.repo, "install", "install.sh")], { cwd: this.repo, env: { PATH: this.env.PATH!, HOME: this.home }, ms: 300_000 });
		writeFileSync(join(this.S, "install.log"), `${install.out}\n--- stderr ---\n${install.err}`);
		if (install.code !== 0) throw new HarnessError(`install.sh exited ${install.code}${install.timedOut ? " (timed out)" : ""}: ${oneLine(install.err.trim().split("\n").at(-1) ?? "")} (log ${join(this.S, "install.log")})`);
		if (!existsSync(join(this.agentDir, "config.yml"))) throw new HarnessError(`install.sh wrote no profile at ${this.agentDir}`);
		this.profile = writeStubProfile(this.agentDir, this.stub.port, { unrouted: [EGRESS_PROBE.provider], chatModel: CHAT_MODEL });
		this.notes.push(`setup: clone and copy ${secs(tClone - t0)}, install and profile ${secs(Date.now() - tClone)}`);
	}

	/** This checkout's uncommitted changes and untracked files, laid over the copy (the copy is then committed). */
	async overlayWorkingTree(): Promise<number> {
		const read = (args: string[]) => this.run(["git", "--no-optional-locks", "-C", SOURCE, ...args], { cwd: SOURCE, env: { ...this.env, GIT_OPTIONAL_LOCKS: "0" }, ms: 60_000 });
		const changed = await read(["diff", "--name-only", "-z", "HEAD"]);
		const untracked = await read(["ls-files", "-z", "--others", "--exclude-standard"]);
		if (changed.code !== 0 || untracked.code !== 0) throw new HarnessError(`reading the source working tree failed: ${oneLine(changed.err || untracked.err)}`);
		const paths = [...new Set([...changed.out.split("\0"), ...untracked.out.split("\0")].filter((p) => p !== ""))];
		for (const p of paths) {
			const from = join(SOURCE, p);
			const to = join(this.repo, p);
			if (existsSync(from) && lstatSync(from).isFile()) copyIntoScratch(this.repo, from, to);
			else if (!existsSync(from)) removeFromScratch(this.repo, to);
		}
		if (paths.length > 0) this.notes.push(`source working tree laid over the copy: ${paths.length} path(s): ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? ", …" : ""}`);
		return paths.length;
	}

	// ---- the stub scripts (§ 2.2, § 2.3) ---------------------------------------------------------

	scripts(): StubScript[] {
		const firstHas = (mark: string) => (r: StubRequest) => r.firstUser.includes(mark);
		const toolOf = (r: StubRequest, names: string[]): string | null => names.find((n) => r.tools.includes(n)) ?? null;
		const handReport = (r: StubRequest, report: string): StubTurn => {
			const y = toolOf(r, ["yield", "submit_result"]);
			return y ? { text: "reporting", tool: { name: y, input: { data: { report } } } } : { text: report };
		};
		const build: StubScript = {
			kind: "hand",
			match: firstHas(BUILD_MARK),
			steps: [{ text: "appending the line and running the scratch test", tool: { name: "bash", input: { command: `printf 'chaos line ${this.token}\\n' >> chaos/scratch.txt && bun test chaos/`, timeout: 120, i: "Appending the line and running the scratch test" } } }],
			after: ({ request }) => {
				if (request.results.some((x) => x.name === "yield" || x.name === "submit_result")) return { text: "done" };
				const out = request.results.at(-1);
				return handReport(request, `**ACTION**\nappended one line to chaos/scratch.txt and ran \`bun test chaos/\` → ${out?.isError ? "error" : "ran"}: ${oneLine(out?.text ?? "no output", 400)}`);
			},
		};
		const review: StubScript = {
			kind: "review",
			match: firstHas(REVIEW_MARK),
			steps: [],
			after: ({ request }) => {
				if (request.results.some((x) => x.name === "yield" || x.name === "submit_result")) return { text: "done" };
				return handReport(request, `**CLAIM**\nthe change appends one line to chaos/scratch.txt; nothing else changed.\n\n\`\`\`review-findings\n{"findings":[]}\n\`\`\``);
			},
		};
		const probeFence: StubScript = {
			kind: "probe-fence",
			match: firstHas(PROBE_FENCE_MARK),
			steps: [{ text: "running the fence probe", tool: { name: "bash", input: { command: `printf ${FENCE_OK}`, i: "Running the fence probe" } } }],
			after: ({ request }) => {
				const r = request.results.at(-1);
				if (r) this.fenceResults.push({ text: r.text, isError: r.isError });
				return { text: `fence probe said: ${oneLine(r?.text ?? "nothing", 200)}` };
			},
		};
		const probeModel: StubScript = { kind: "probe-model", match: firstHas(PROBE_MODEL_MARK), steps: [], after: { text: "chaos probe ok" } };
		const lane: StubScript = {
			kind: "lane",
			match: (r) => {
				const isLane = /You are a \*\*lane\*\*/.test(r.system) || (r.tools.includes("lane_add_slice") && r.firstUser.includes(this.wl));
				if (isLane && this.fault === "provider-refusal" && this.f.refusalArmed === undefined && r.results.some((x) => x.name === "lane_add_slice")) {
					// Fault 4's trigger and action, in the request itself: refused in this same call (see the header).
					this.f.refusalArmed = true;
					this.stub!.setMode({ mode: "refuse", kind: "lane" });
					this.triggerAt = iso();
					this.injectedAt = this.triggerAt;
				}
				return isLane;
			},
			steps: [],
			after: ({ request }) => this.laneTurn(request),
		};
		const orchestrator: StubScript = {
			kind: "orchestrator",
			match: (r) => r.tools.includes("orchestrator_wake_read") || /You are the \*\*orchestrator\*\* surface/.test(r.system),
			steps: [{ text: "recording the wake read", tool: { name: "orchestrator_wake_read", input: { body: `chaos ${this.token}: scratch orchestrator; the chaos workload ${this.wl} runs under its lane; next: wait.`, i: "Recording the wake read" } } }],
			after: { text: "**PMDW**\nchaos scratch orchestrator: nothing to do." },
		};
		const unmatched: StubScript = {
			kind: "unmatched",
			match: (r) => {
				const n = Number(this.f.unmatched ?? 0);
				this.f.unmatched = n + 1;
				if (n < 5) this.notes.push(`unmatched stub request ${n + 1}: model ${r.model}; tools [${r.tools.slice(0, 12).join(", ")}${r.tools.length > 12 ? ", …" : ""}]; system: ${oneLine(r.system, 200)}; first user: ${oneLine(r.firstUser, 200)}`);
				return true;
			},
			steps: [],
			after: { text: "chaos: no script for this session" },
		};
		return [build, review, probeFence, probeModel, lane, orchestrator, unmatched];
	}

	/** The lane's ten scripted steps (§ 2.2), chosen from what the conversation already did; waits for its hands between them. */
	laneTurn(request: StubRequest): StubTurn {
		for (const r of request.results) if (r.name !== null && !this.laneResults.has(r.toolUseId)) this.laneResults.set(r.toolUseId, `${r.name}${r.isError ? " (error)" : ""}: ${oneLine(r.text, 240)}`);
		const brief = (slice: string, task: string, done: string, inputs: string) =>
			`slice: ${slice}\nworkload: ${this.wl}\ntask: ${task}\ndone-condition: ${done}\ninputs: ${inputs}\nstakes: normal\nceiling-share: 10`;
		const plan: { tool: string; input: Record<string, unknown>; afterHands?: number }[] = [
			{ tool: "ledger_wake_read", input: { body: `chaos ${this.token}: fresh workload ${this.wl}, no slices yet; next: cut the change slice.`, i: "Recording the wake read" } },
			{ tool: "lane_add_slice", input: { id: SL_CHANGE, kind: "change-small", task: "append one line to chaos/scratch.txt and run bun test chaos/", doneCondition: "bun test chaos/ exits 0 with the line appended to chaos/scratch.txt", inputs: "chaos/scratch.txt and chaos/scratch.test.ts in the lane worktree", i: "Adding the change slice" } },
			{
				tool: "task",
				input: {
					i: "Dispatching the change hand",
					context: `# Goal\nchaos scratch run ${this.token}`,
					tasks: [{ name: SL_CHANGE, agent: "fast", solutionSpace: "one fix: append the line, given", task: brief(SL_CHANGE, `append one line to chaos/scratch.txt and run bun test chaos/ (${BUILD_MARK})`, "bun test chaos/ exits 0 with the line appended", "chaos/scratch.txt, chaos/scratch.test.ts in the lane worktree") }],
				},
			},
			{ tool: "lane_complete_slice", afterHands: 1, input: { slice: SL_CHANGE, artifact: "bun test chaos/ → exit 0 (the hand's report)", i: "Completing the change slice" } },
			{ tool: "lane_add_slice", input: { id: SL_REVIEW, kind: "judge", task: "review the change", doneCondition: "a review-findings block with no blocking finding", inputs: "chaos/scratch.txt on the lane branch", i: "Adding the review slice" } },
			{
				tool: "task",
				input: {
					i: "Dispatching the review",
					context: `# Goal\nchaos scratch run ${this.token}`,
					tasks: [{ name: SL_REVIEW, agent: "standard", solutionSpace: "judge: one change to review", task: brief(SL_REVIEW, `review the change on ${SL_CHANGE}: one line appended to chaos/scratch.txt (${REVIEW_MARK})`, "a review-findings block", "chaos/scratch.txt on the lane branch") }],
				},
			},
			{ tool: "lane_complete_slice", afterHands: 2, input: { slice: SL_REVIEW, artifact: "review-findings: no findings", i: "Completing the review slice" } },
			{ tool: "lane_add_slice", input: { id: SL_HOLD, task: "chaos-hold: wait for Jo", doneCondition: "Jo answers close or keep", inputs: "none", i: "Adding the hold slice" } },
			{ tool: "lane_raise_question", input: { slice: SL_HOLD, body: `**QUESTION**\nchaos ${this.token}: close this scratch workload, or keep it? close ends it; keep leaves it parked.`, options: ["close", "keep"], i: "Raising the hold question" } },
		];
		let ptr = 0;
		let trailingWaits = 0;
		for (const r of request.results) {
			if (r.name === "wait" || r.name === "bash") {
				trailingWaits++;
				continue;
			}
			trailingWaits = 0;
			if (ptr < plan.length && r.name === plan[ptr]!.tool) ptr++;
		}
		const step = plan[ptr];
		if (!step) return { text: "chaos lane: the hold question is raised; parking." };
		if (step.afterHands !== undefined && this.ledger && trailingWaits < 150) {
			const dispatch = [...request.results].reverse().find((x) => x.name === "task");
			const entries = this.ledger.entries(this.wl);
			const spawns = entries.flatMap((e) => parseHandSpawn(e.body)?.token ?? []);
			const settled = settledTokens(entries);
			const running = spawns.filter((t) => !settled.has(t));
			if (dispatch && !dispatch.isError && (spawns.length < step.afterHands || running.length > 0)) {
				if (running.length > 0 && request.tools.includes("wait")) return { text: "waiting for the hand", tool: { name: "wait", input: { i: "Waiting for the hand" } } };
				return { text: "waiting for the hand to settle", tool: { name: "bash", input: { command: "sleep 2", i: "Waiting for the hand to settle" } } };
			}
		}
		return { text: `chaos lane step ${ptr + 1}`, tool: { name: step.tool, input: step.input } };
	}

	// ---- preflight (§ 2.3, § 2.7) ------------------------------------------------------------------

	async omp(args: string[], prompt: string, extraEnv: Record<string, string> = {}, ms = PROBE_MS): Promise<Ran> {
		return this.run(["omp", "-p", "--no-session", ...args, prompt], { cwd: this.repo, env: { ...this.env, ...extraEnv }, ms });
	}

	async preflight(): Promise<void> {
		const stub = this.stub!;
		const proxy = this.proxy!;
		const t0 = Date.now();
		proxy.setPhase("setup");
		const warm = await this.omp(["--model", CHAT_MODEL], `${PROBE_MODEL_MARK} warm up`);
		if (warm.code !== 0 || !warm.out.includes(this.token)) throw new HarnessError(`warm-up omp start: exit ${warm.code}${warm.timedOut ? " (timed out)" : ""}, ${warm.out.includes(this.token) ? "" : "no nonce in its reply; "}${oneLine(warm.err || warm.out)}`);

		proxy.setPhase("probes");
		// Every chat model id the run routes to: each chat role's model and every tier row.
		const config = Bun.YAML.parse(readFileSync(join(this.agentDir, "config.yml"), "utf8")) as { modelRoles?: Record<string, string>; task?: { agentModelOverrides?: Record<string, string[]> } };
		const kindRoles = new Set(["judge", "image", "speech", "dictation"]);
		const models = [...new Set([
			...Object.entries(config.modelRoles ?? {}).filter(([role]) => !kindRoles.has(role)).map(([, m]) => m),
			...Object.values(config.task?.agentModelOverrides ?? {}).flat(),
		])].sort();
		const misses: string[] = [];
		for (let i = 0; i < models.length; i += 4) {
			await Promise.all(models.slice(i, i + 4).map(async (m) => {
				const bare = m.slice(m.indexOf("/") + 1);
				const before = stub.counts().messages[bare] ?? 0;
				const r = await this.omp(["--model", m], `${PROBE_MODEL_MARK} ${m}`);
				const served = (stub.counts().messages[bare] ?? 0) - before;
				if (r.code !== 0 || !r.out.includes(this.token) || served < 1) misses.push(`${m}: exit ${r.code}${r.timedOut ? " (timed out)" : ""}, stub served ${served}, nonce ${r.out.includes(this.token) ? "returned" : "missing"}${r.code !== 0 ? `, ${oneLine(r.err, 160)}` : ""}`);
			}));
		}
		if (misses.length > 0) throw new HarnessError(`model probes failed: ${misses.join("; ")}`);
		this.notes.push(`preflight: ${models.length} chat model id(s) reached the stub with the nonce: ${models.join(", ")}`);

		const judgeBefore = stub.counts().judge[JUDGE_MODEL] ?? 0;
		const judge = await this.run(["bun", join(this.repo, "surface", "scripts", "chaos-stub.ts"), "judge-probe", this.repo, "review the change on this branch"], { cwd: this.repo, ms: PROBE_MS });
		let decoded: { choice?: string; judgeModel?: string } = {};
		try {
			decoded = JSON.parse(judge.out.trim()) as typeof decoded;
		} catch {
			// reported below
		}
		const judged = (stub.counts().judge[JUDGE_MODEL] ?? 0) - judgeBefore;
		if (judge.code !== 0 || judged < 1 || decoded.judgeModel !== `typesafe/${JUDGE_MODEL}`) {
			throw new HarnessError(`judge probe: exit ${judge.code}, stub judged ${judged}, decoded ${JSON.stringify(decoded)}: ${oneLine(judge.err || judge.out)}`);
		}

		proxy.setPhase("preflight");
		const egress = await this.omp(["--model", EGRESS_PROBE.model], "say hi", { [EGRESS_PROBE.keyEnv]: "chaos-egress-probe" });
		proxy.setPhase("probes");
		const hosts = [...new Set(proxy.attempts("preflight").map((a) => a.host))].sort();
		if (egress.code === 0 || egress.out.includes(this.token) || hosts.length !== 1 || hosts[0] !== EGRESS_PROBE.host) {
			throw new HarnessError(`egress self-test: ${EGRESS_PROBE.model} exited ${egress.code}${egress.timedOut ? " (timed out)" : ""}; the preflight bucket holds [${hosts.join(", ")}], expected exactly [${EGRESS_PROBE.host}]`);
		}

		await this.fenceProbe();
		const probeHosts = [...new Set(proxy.attempts("probes").map((a) => a.host))].filter((h) => !CHAOS_EXEMPT_EGRESS_HOSTS.includes(h));
		if (probeHosts.length > 0) throw new HarnessError(`egress during the preflight probes: ${probeHosts.join(", ")}`);
		if (this.nightly && this.fence !== "on") throw new HarnessError(`--nightly requires fence: on, and the probe found fence: ${this.fence}`);
		this.notes.push(`preflight: ${secs(Date.now() - t0)} (warm-up ${secs(warm.ms)}, judge ${decoded.choice ?? "?"}, egress self-test refused at ${EGRESS_PROBE.host}, fence: ${this.fence})`);
	}

	/** § 2.7: one scripted bash call; a nested-sandbox refusal (exit 71, sandbox_apply) turns the scratch fence off and probes again. */
	async fenceProbe(): Promise<void> {
		const once = async (): Promise<{ text: string; isError: boolean } | null> => {
			const n = this.fenceResults.length;
			const r = await this.omp(["--model", CHAT_MODEL], `${PROBE_FENCE_MARK}: run the fence probe`);
			const got = this.fenceResults.length > n ? this.fenceResults.at(-1)! : null;
			if (!got) throw new HarnessError(`fence probe: the bash result never reached the stub (omp exit ${r.code}${r.timedOut ? ", timed out" : ""}: ${oneLine(r.err || r.out)})`);
			return got;
		};
		const ran = (x: { text: string; isError: boolean }) => x.text.includes(FENCE_OK) && !x.text.includes("sandbox_apply");
		const first = await once();
		if (first && ran(first)) {
			this.fence = "on";
			return;
		}
		const nested = first !== null && /sandbox_apply: Operation not permitted/.test(first.text) && /\b71\b/.test(first.text);
		if (!nested) throw new HarnessError(`fence probe refused other than by a nested sandbox: ${oneLine(first?.text ?? "", 400)}`);
		const path = join(this.agentDir, "config.yml");
		const config = Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const gates = (config.gates && typeof config.gates === "object" ? config.gates : {}) as Record<string, unknown>;
		const fence = gates.fence && typeof gates.fence === "object" ? gates.fence : {};
		config.gates = { ...gates, fence: { ...fence, enabled: false } };
		writeFileSync(path, `# chaos: gates.fence.enabled false in the scratch profile only (nested sandbox, plan § 2.7)\n${JSON.stringify(config, null, 1)}\n`);
		const second = await once();
		if (!second || !ran(second)) throw new HarnessError(`fence probe with the scratch fence off still did not run: ${oneLine(second?.text ?? "", 400)}`);
		this.fence = "off (nested sandbox)";
		this.notes.push(`fence probe: nested sandbox refusal (${oneLine(first!.text, 160)}); scratch profile set gates.fence.enabled: false`);
	}

	// ---- the measured phase ------------------------------------------------------------------------

	entries(): EntryRow[] {
		return this.ledger!.entries(this.wl);
	}

	messages(): { body: string; created_at: string }[] {
		return this.ledger!.db.query<{ body: string; created_at: string }, [string]>("SELECT body, created_at FROM messages WHERE workload_id = ? ORDER BY created_at").all(this.wl);
	}

	spawns(): { token: string; review: boolean; at: string; settled: boolean }[] {
		const entries = this.entries();
		const settled = settledTokens(entries);
		return entries.flatMap((e) => {
			const s = parseHandSpawn(e.body);
			return s ? [{ token: s.token, review: s.review, at: e.created_at, settled: settled.has(s.token) }] : [];
		});
	}

	laneEnded(laneId: string): { body: string; at: string } | null {
		const e = this.entries().find((x) => x.body.startsWith(`lane-exit: ${laneId} `));
		if (e) return { body: e.body, at: e.created_at };
		const m = this.messages().find((x) => x.body.startsWith(`lane-died: ${laneId}`));
		return m ? { body: m.body, at: m.created_at } : null;
	}

	launch(requestedBy: string): Promise<Ran> {
		return this.run(["bun", "surface/scripts/lane.ts", "launch", this.wl, "--requested-by", requestedBy], { cwd: this.repo, ms: 120_000 });
	}

	async measured(): Promise<Verdict> {
		const stub = this.stub!;
		this.ledger = Ledger.open(this.env.AGENT_SYSTEM_LEDGER_DB!, { backupOnOpen: false });
		this.measuredAt = Date.now();
		this.proxy!.setPhase("measured");
		this.ledger.openWorkload({
			by: "chaos", id: this.wl, stakes: "normal", mode: "autonomous",
			brief: `chaos run ${this.token}: append one line to chaos/scratch.txt and run bun test chaos/, have another lab check it, then park on a question.`,
		});
		recordRepo(this.ledger, this.wl, this.repo);

		if (this.fault === "lane-kill-mid-hand") stub.setMode({ mode: "stall", kind: "hand", ms: HAND_STALL_MS });
		if (this.fault === "orchestrator-kill-mid-review") stub.setMode({ mode: "stall", kind: "review", ms: REVIEW_STALL_MS });

		const launched = await this.launch("chaos");
		const m = /lane (\S+) runner (\d+)/.exec(launched.out);
		if (launched.code !== STARTER_EXIT.ok || !m) throw new HarnessError(`lane.ts launch exited ${launched.code}${launched.timedOut ? " (timed out)" : ""}: ${oneLine(launched.err || launched.out)}`);
		this.laneId = m[1]!;
		this.runnerPid = Number(m[2]);
		// The runner the launch named is the run's only while ps shows `lane.ts run <wl> <laneId>` from the scratch repo; its
		// start time then is what killAll and the --kill runner check compare.
		const runner = psInfo(this.psBin, this.runnerPid);
		if (runner && isScratchRunner(runner.command, this.repo, this.wl, this.laneId, isRunnerCommand)) {
			this.runnerStart = runner.lstart;
			this.owned.push({ pid: this.runnerPid, lstart: runner.lstart, what: `runner of ${this.laneId}` });
			this.notes.push(`lane ${this.laneId}, runner pid ${this.runnerPid} (started ${runner.lstart})`);
		} else this.notes.push(`lane ${this.laneId}, runner pid ${this.runnerPid}: not verified as this run's at the launch (ps shows ${runner ? oneLine(runner.command, 160) : "no such process"}); --kill runner refuses it`);

		// The trigger, read from the throwaway ledger every 1 s (fault 4 arms itself in the stub).
		const deadline = Date.now() + TRIGGER_MS;
		while (this.injectedAt === null) {
			if (Date.now() > deadline) throw new HarnessError(`the ${this.fault} trigger never fired within ${TRIGGER_MS / 1000} s of the launch`);
			const ended = this.laneEnded(this.laneId);
			if (ended && this.injectedAt === null) throw new HarnessError(`the lane ended before the ${this.fault} trigger: ${oneLine(ended.body)}`);
			await this.trigger();
			if (this.injectedAt === null) await Bun.sleep(1_000);
		}

		// Monitors every 1 s, the judge every 5 s.
		let monitoring = true;
		const monitor = (async () => {
			while (monitoring) {
				try {
					await this.monitor();
				} catch (e) {
					this.harness.push(`monitor: ${e instanceof Error ? e.message : String(e)}`);
					return;
				}
				await Bun.sleep(1_000);
			}
		})();
		const t0 = Date.parse(this.injectedAt);
		let seen: Seen = emptySeen();
		let deciding: Poll | null = null;
		for (;;) {
			const p = judgePoll(this.ledger, this.wl, seen);
			seen = p.seen;
			this.polls.push(p);
			this.lastPoll = p;
			const at = Date.parse(p.at);
			if (p.a.union.length >= 2) break;
			if (deciding === null) {
				const items = [...this.items.values()];
				if (p.ok && items.every((i) => i.at !== null && Date.parse(i.at) <= at && (i.lostAt == null || Date.parse(i.lostAt) > at))) deciding = p;
				else if (at - t0 > WINDOW_MS) break;
			} else if (at >= Date.parse(deciding.at) + SETTLE_MS) break;
			await Bun.sleep(POLL_MS);
		}
		monitoring = false;
		await monitor;
		await Promise.all(this.pending);
		this.proxy!.setPhase("after");
		return this.decide();
	}

	/** The measured phase's egress, nonce and harness checks, then `verdict`. */
	decide(): Verdict {
		const stub = this.stub!;
		const routed = new Set([...(this.profile?.routedModelIds ?? []), JUDGE_MODEL]);
		const counts = stub.counts();
		for (const id of [...Object.keys(counts.messages), ...Object.keys(counts.judge)]) if (id !== "" && !routed.has(id)) this.harness.push(`unrouted model ${id}`);
		const firstSpawn = this.spawns()[0];
		if (firstSpawn && this.measuredAt !== null) {
			const judged = stub.log().some((e) => e.outcome === "judged" && e.at >= this.measuredAt! && e.at <= Date.parse(firstSpawn.at));
			if (!judged) this.harness.push("no /v1/systemone request before the first hand-spawn: the classifier ran some other way");
		}
		const egress = this.proxy!.attempts("measured").filter((a) => !CHAOS_EXEMPT_EGRESS_HOSTS.includes(a.host)).map((a) => `${a.host || "(no host)"} (${a.kind} ${a.target})`);
		const sessions = [laneDir(this.wl, this.home), join(this.home, ".omp")];
		this.evidence = {
			fault: this.fault, injectedAt: this.injectedAt!, items: [...this.items.values()], nonceMisses: nonceMisses(sessions, this.token), egress, harness: [...this.harness],
		};
		return verdict(this.polls, this.evidence, WINDOW_MS, SETTLE_MS);
	}

	// ---- the five faults (§ 2.4) -------------------------------------------------------------------

	/** One trigger check; performs the injection when it fires. */
	async trigger(): Promise<void> {
		const stub = this.stub!;
		const fire = () => {
			this.triggerAt = iso();
		};
		const openHeld = (kind: string) => stub.held().find((h) => h.kind === kind && h.outcome === "open");
		switch (this.fault) {
			case "lane-kill-mid-hand": {
				const hand = this.spawns().find((s) => !s.review && !s.settled);
				const held = openHeld("hand");
				if (!hand || !held) return;
				fire();
				this.f.held = held.id;
				const start = laneStarts(this.entries()).filter((s) => s.laneId === this.laneId).at(-1);
				if (!start) throw new HarnessError(`no lane-started: entry for ${this.laneId} at the trigger`);
				// The omp must be the one lane-started: recorded (its start time) and run from the scratch root (`--cwd` is the
				// scratch worktree); the runner the one the launch named (its start time when chaos verified it), still running
				// `lane.ts run <wl> <laneId>` from the scratch repo.
				const targets: { pid: number; start: string; want: (c: string) => boolean; what: string }[] = [
					{ pid: start.pid, start: start.start, want: (c) => isOmpCommand(c) && namesPath(c, this.S), what: "lane omp" },
				];
				// Variant kill runner: the runner goes first. Killed second, it would already have seen its omp exit, written
				// lane-exit: and exited (kill then fails with no such process), and the variant would test nothing new.
				if (this.variant === "kill runner") {
					targets.unshift({
						pid: start.runnerPid, start: start.runnerPid === this.runnerPid ? (this.runnerStart ?? "") : "",
						want: (c) => isScratchRunner(c, this.repo, this.wl, start.laneId, isRunnerCommand), what: "lane runner",
					});
				}
				const shield = this.shield ?? ancestorPids(this.psBin);
				// Every target is checked before any is killed, so a refusal leaves the lane untouched.
				for (const t of targets) {
					const refused = killRefusal(t, psInfo(this.psBin, t.pid), process.pid, shield);
					if (refused !== null) throw new HarnessError(refused);
				}
				for (const t of targets) this.adoptBelow(t.pid, t.what);
				const results: string[] = [];
				let ok = true;
				for (const t of targets) {
					// And again right before its signal: the pid must still be the process checked above.
					const ps = psInfo(this.psBin, t.pid);
					const refused = killRefusal(t, ps, process.pid, shield);
					if (refused !== null) {
						ok = false;
						results.push(`not signalled: ${refused}`);
						continue;
					}
					const k = Bun.spawnSync(["kill", "-KILL", String(t.pid)], { stdout: "pipe", stderr: "pipe" });
					ok &&= k.exitCode === 0;
					results.push(`kill -KILL ${t.pid} (${t.what}, started ${ps!.lstart}) exited ${k.exitCode}`);
				}
				this.injectedAt = iso();
				if (ok) this.observe("kill returned 0", results.join("; "));
				else this.items.set("kill returned 0", { name: "kill returned 0", observed: results.join("; "), at: null });
				return;
			}
			case "orchestrator-kill-mid-review": {
				if (this.orchestrator === null && laneStarts(this.entries()).some((s) => s.laneId === this.laneId)) this.startOrchestrator();
				const review = this.spawns().find((s) => s.review && !s.settled);
				const held = openHeld("review");
				if (!review || !held || this.orchestrator === null) return;
				fire();
				this.f.reviewToken = review.token;
				this.f.held = held.id;
				const old = this.orchestrator;
				// The orchestrator chaos spawned: its start time when spawned, an omp run with `--cwd` the scratch repo.
				const target = { pid: old.pid, start: this.orchestratorLstart, want: (c: string) => isOmpCommand(c) && namesPath(c, this.repo), what: "orchestrator" };
				const shield = this.shield ?? ancestorPids(this.psBin);
				const ps = psInfo(this.psBin, old.pid);
				const refused = killRefusal(target, ps, process.pid, shield);
				if (refused !== null || ps === null) throw new HarnessError(refused ?? `orchestrator pid ${old.pid} is gone`);
				this.adoptBelow(old.pid, "orchestrator");
				const again = killRefusal(target, psInfo(this.psBin, old.pid), process.pid, shield);
				if (again !== null) throw new HarnessError(again);
				const stillHeld = stub.held().find((h) => h.id === held.id)?.outcome === "open";
				const k = Bun.spawnSync(["kill", "-KILL", String(old.pid)], { stdout: "pipe", stderr: "pipe" });
				this.injectedAt = iso();
				if (k.exitCode !== 0) throw new HarnessError(`kill -KILL ${old.pid} (orchestrator) exited ${k.exitCode}`);
				if (stillHeld) this.observe("review hand held at the kill", `review hand ${review.token}'s request (stub hold ${held.id}) was open when the orchestrator pid ${old.pid} was killed`);
				this.pending.push((async () => {
					await old.exited;
					for (let i = 0; i < 50 && psInfo(this.psBin, old.pid) !== null; i++) await Bun.sleep(100);
					if (psInfo(this.psBin, old.pid) === null) this.observe("old orchestrator pid gone", `pid ${old.pid} (${oneLine(ps.command, 80)}) is gone after SIGKILL`);
					await Bun.sleep(RESTART_DELAY_MS);
					this.startOrchestrator();
				})());
				return;
			}
			case "network-block-60s": {
				if (this.spawns().length === 0) return;
				fire();
				stub.setMode({ mode: "blackhole", ms: BLACKHOLE_MS });
				this.injectedAt = iso();
				return;
			}
			case "provider-refusal":
				return; // armed inside the stub's lane match
			case "duplicate-lane-runner": {
				const first = laneStarts(this.entries()).find((s) => s.laneId === this.laneId);
				if (!first) return;
				fire();
				this.injectedAt = iso();
				this.observe("first lane held throughout, no second lane held or reserved", `holder ${this.laneId} at the trigger; watched every 1 s until its own end (lane-exit:, lane-decided: or lane-parked: no later than ${END_RECEIPT_SKEW_MS} ms after the release, or its parked question before it)`);
				this.items.set("first lane held throughout, no second lane held or reserved", { ...this.items.get("first lane held throughout, no second lane held or reserved")!, systemFault: true });
				this.pending.push(this.duplicateRunners(first));
				return;
			}
		}
	}

	/** Fault 5's two parts: a second launch, then a second runner on the live lane id. */
	async duplicateRunners(first: LaneStart): Promise<void> {
		const dup = await this.launch("chaos-dup");
		this.runners.push({ label: "(i) lane.ts launch --requested-by chaos-dup", exitCode: dup.code, stderr: (dup.err || dup.out).trim() });
		if (dup.code === STARTER_EXIT.held && /\bheld\b/.test(dup.err)) this.observe("second launch exited held", `exit ${dup.code} (STARTER_EXIT.held): ${oneLine(dup.err, 200)}`);
		else this.items.set("second launch exited held", { name: "second launch exited held", observed: `exit ${dup.code}, stderr: ${oneLine(dup.err || dup.out, 200)}`, at: null });

		// Start records are attributed by writer: only one whose runnerPid is this spawned runner's counts, since the first runner
		// re-records its own start (model, session) under its own pid during the watch.
		const before = new Set(laneStarts(this.entries()).filter((s) => s.laneId === first.laneId).map((s) => s.entryId));
		const runner = this.spawn(["bun", "surface/scripts/lane.ts", "run", this.wl, first.laneId], { cwd: this.repo });
		const errText = new Response(runner.stderr).text();
		const outText = new Response(runner.stdout).text();
		const deadline = Date.now() + SECOND_RUNNER_WATCH_MS;
		let omp: number | null = null;
		while (Date.now() < deadline && runner.exitCode === null && runner.signalCode === null) {
			const below = new Set(descendantEdges([runner.pid]).keys());
			omp = processList().find((p) => p.pid !== runner.pid && below.has(p.pid) && isOmpCommand(p.command))?.pid ?? null;
			if (omp !== null || newStarts(laneStarts(this.entries()), first.laneId, runner.pid, before).second.length > 0) break;
			await Bun.sleep(500);
		}
		const alive = runner.exitCode === null && runner.signalCode === null;
		if (alive) {
			// chaos's own child: everything below it by their start times (killOwned), then the child itself through its handle.
			const ps = psInfo(this.psBin, runner.pid);
			if (ps) this.killOwned([{ pid: runner.pid, lstart: ps.lstart, what: "second runner" }]);
			runner.kill("SIGKILL");
		}
		const code = await runner.exited;
		const stderr = `${(await errText).trim()}${(await outText).trim() ? `\n${(await outText).trim()}` : ""}`;
		this.runners.push({ label: `(ii) lane.ts run ${this.wl} ${first.laneId}${alive ? " (killed by chaos)" : ""}`, exitCode: alive ? null : code, stderr });
		// Judged on a snapshot taken after the exit: a start record written and followed by exit between two polls is in it.
		const judged = secondRunnerJudgement({
			laneId: first.laneId, runnerPid: runner.pid, before, starts: laneStarts(this.entries()), omp, killed: alive,
			code: alive ? null : runner.exitCode, stderr, watchMs: SECOND_RUNNER_WATCH_MS,
		});
		if (judged.held) this.observe(SECOND_RUNNER_EVIDENCE, judged.observed, { systemFault: true });
		else this.items.set(SECOND_RUNNER_EVIDENCE, { name: SECOND_RUNNER_EVIDENCE, observed: judged.observed, at: null, systemFault: true });
	}

	startOrchestrator(): void {
		const p = Bun.spawn(["omp", "--mode", "rpc", "--no-ui", "--cwd", this.repo], {
			cwd: this.repo, env: { ...this.env, AGENT_SYSTEM_ROLE: "orchestrator" }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
		});
		this.children.add(p);
		this.orchestratorLstart = psInfo(this.psBin, p.pid)?.lstart ?? "";
		this.orchestrator = p;
		this.orchestratorStarts.push(Date.now());
		const n = this.orchestratorStarts.length;
		void (async () => {
			const decoder = new TextDecoder();
			let buf = "";
			let sent = false;
			try {
				for await (const chunk of p.stdout) {
					buf += decoder.decode(chunk, { stream: true });
					let nl = buf.indexOf("\n");
					while (nl >= 0) {
						const line = buf.slice(0, nl).trim();
						buf = buf.slice(nl + 1);
						nl = buf.indexOf("\n");
						if (!sent && line.startsWith("{") && line.includes('"ready"')) {
							sent = true;
							p.stdin.write(`${JSON.stringify({ id: `wake-${n}`, type: "prompt", message: "chaos: wake" })}\n`);
							p.stdin.flush();
						}
					}
				}
			} catch {
				// killed
			}
		})();
		void new Response(p.stderr).text();
	}

	/** Fault evidence observed after the injection, every 1 s. */
	async monitor(): Promise<void> {
		const stub = this.stub!;
		const after = (at: string) => at >= this.injectedAt!;
		switch (this.fault) {
			case "lane-kill-mid-hand": {
				const h = stub.held().find((x) => x.id === this.f.held);
				if (h && h.outcome === "dropped") this.observe("held hand connection dropped", `stub hold ${h.id} (${h.kind}, ${h.model}) dropped by the client at ${iso(h.ended ?? Date.now())}`, { at: iso(h.ended ?? Date.now()) });
				if (h && h.outcome !== "open" && stub.mode().mode === "stall") stub.setMode({ mode: "normal" });
				const ended = this.laneEnded(this.laneId!);
				if (ended && after(ended.at)) this.observe("lane-exit or lane-died followed", oneLine(ended.body, 240), { at: ended.at });
				else if (this.variant === "kill runner") {
					const died = this.lastPoll?.lines.find((l) => l.kind === "lane-died");
					if (died) this.observe("lane-exit or lane-died followed", `needs-you ${died.identity}: ${oneLine(died.text, 200)} (the runner was killed, so no lane-exit: is written)`);
				}
				return;
			}
			case "orchestrator-kill-mid-review": {
				const restart = this.orchestratorStarts[1];
				if (restart !== undefined) {
					const wake = this.ledger!.entries("wl-orchestrator", "wake-read").find((e) => Date.parse(e.created_at) > restart);
					if (wake) this.observe("new orchestrator wake read after restart", `wake-read entry ${wake.id} at ${wake.created_at}, after the restart at ${iso(restart)}`, { at: wake.created_at });
				}
				const settled = this.spawns().find((s) => s.token === this.f.reviewToken && s.settled);
				if (settled) this.observe("review hand settled", `hand-settled: ${settled.token}`);
				return;
			}
			case "network-block-60s": {
				const w = stub.windows()[0];
				if (!w) return;
				if (w.held >= 1) this.observe("provider connection held in the window", `${w.held} provider request(s) held in the blackhole window opened ${iso(w.start)}`);
				if (w.end !== null && w.end - w.start >= BLACKHOLE_MS) this.observe("window lasted at least 60 s", `window ${iso(w.start)} → ${iso(w.end)} (${((w.end - w.start) / 1000).toFixed(1)} s by the stub's clock), ${w.reset} connection(s) reset`, { at: iso(w.end) });
				return;
			}
			case "provider-refusal": {
				const n = stub.counts().refused.lane ?? 0;
				if (n >= 1) this.observe("refusal served to a lane request", `${n} refusal frame(s) served to lane requests`);
				const died = this.messages().find((m) => m.body.startsWith(`lane-died: ${this.laneId}`));
				if (died && /Refusal \(cyber\)/.test(died.body) && /retryable false/.test(died.body)) this.observe("lane-died body names Refusal (cyber) and retryable false", oneLine(died.body, 300), { at: died.created_at });
				return;
			}
			case "duplicate-lane-runner": {
				const name = "first lane held throughout, no second lane held or reserved";
				const item = this.items.get(name)!;
				if (item.lostAt != null || this.f.firstEnded !== undefined) return;
				const held = firstHolder({
					laneId: this.laneId!, injectedAt: this.injectedAt!, workload: this.ledger!.workload(this.wl) ?? null, entries: this.entries(), questions: this.ledger!.questions(this.wl),
				});
				if (held.state === "ended") {
					this.f.firstEnded = held.receipt;
					this.items.set(name, { ...item, observed: `${item.observed}; its holding ended by ${held.receipt}` });
				} else if (held.state === "lost") this.items.set(name, { ...item, systemFault: true, lostAt: iso(), observed: held.observed });
				return;
			}
		}
	}

	// ---- the run -----------------------------------------------------------------------------------

	async execute(): Promise<number> {
		this.liveCheckout = liveCheckoutOf(SOURCE);
		const livePaths = { ledgerDb: defaultLedgerPath(process.env), checkout: this.liveCheckout, lanesRoots: [join(homeDir(), ".agent-system-2", "lanes"), `${this.liveCheckout}-lanes`] };
		this.before = isolationSnapshot(livePaths);
		const onSignal = (sig: string) => {
			process.stderr.write(`chaos: ${sig}: killing every process of the run; scratch kept at ${this.S || "(not created)"}\n`);
			this.killAll();
			this.stub?.stop();
			this.proxy?.stop();
			process.exit(2);
		};
		process.on("SIGTERM", () => onSignal("SIGTERM"));
		process.on("SIGINT", () => onSignal("SIGINT"));

		let v: Verdict;
		let setupMs: number | null = null;
		try {
			await this.setup();
			await this.preflight();
			setupMs = Date.now() - this.started;
			v = await this.measured();
		} catch (e) {
			const reason = e instanceof HarnessError ? e.message : `chaos itself failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
			v = { verdict: "HARNESS-ERROR", reason, deciding: null, settle: null, atMs: null, last: this.lastPoll };
		} finally {
			try {
				const killed = this.killAll();
				if (killed > 0) this.notes.push(`cleanup: killed ${killed} process(es) of the run`);
			} catch (e) {
				this.notes.push(`cleanup: killing the run's processes failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		let rows: WorkloadRows | null = null;
		try {
			if (this.ledger && this.ledger.workload(this.wl)) rows = workloadRows(this.ledger, this.wl);
		} catch (e) {
			this.notes.push(`throwaway ledger rows could not be read: ${e instanceof Error ? e.message : String(e)}`);
		}
		const after = isolationSnapshot(livePaths);
		const diff: IsolationDiff = isolationDiff(this.before, after, [this.runId, this.S, this.wl].filter((x) => x !== ""), liveActorsOf(this.before));
		if (!diff.ok && v.verdict !== "HARNESS-ERROR") v = { ...v, verdict: "FAIL", reason: `${v.verdict === "PASS" ? "" : `${v.reason}; `}isolation: ${diff.failures.join("; ")}` };

		if (v.verdict !== "PASS" && this.laneResults.size > 0) for (const r of this.laneResults.values()) this.notes.push(`lane tool result: ${r}`);
		const unmatched = this.stub?.counts().kinds.unmatched ?? 0;
		if (unmatched > 0) this.notes.push(`${unmatched} stub request(s) matched no session script (answered with a nonce text)`);
		if (this.variant === "kill runner") this.notes.push("variant kill runner: no lane-exit: is written, so under wl-mv45jcsi4h3nr4's rule no hand counts as dead and (c) holds vacuously; this variant tests (a) and (b)");
		const attempts: ProxyAttempt[] = this.proxy?.attempts() ?? [];
		const exempt = attempts.filter((a) => a.phase === "measured" && CHAOS_EXEMPT_EGRESS_HOSTS.includes(a.host));
		if (exempt.length > 0) this.notes.push(`egress ${EXEMPT_LABEL}: ${exempt.length} attempt(s) to ${[...new Set(exempt.map((a) => a.host))].join(", ")}`);
		const counts = this.stub?.counts();
		const stubCounts: Record<string, number> = {};
		if (counts) {
			for (const [m, n] of Object.entries(counts.messages)) stubCounts[m || "(none)"] = n;
			for (const [m, n] of Object.entries(counts.judge)) stubCounts[`judge ${m}`] = n;
			for (const [k, n] of Object.entries(counts.kinds)) stubCounts[`kind ${k}`] = n;
		}
		this.stub?.stop();
		this.proxy?.stop();
		this.ledger?.close();

		const keep = v.verdict !== "PASS";
		const report: RunReport = {
			fault: this.fault, variant: this.variant, token: this.token, fence: this.fence, ps: this.ps, verdict: v,
			timings: { startedAt: iso(this.started), setupMs, triggerAt: this.triggerAt, injectedAt: this.injectedAt },
			evidence: this.evidence ?? { fault: this.fault, injectedAt: this.injectedAt ?? iso(this.started), items: [...this.items.values()], nonceMisses: [], egress: [], harness: this.harness },
			egressLog: attempts.map((a) => ({ phase: a.phase === "measured" && CHAOS_EXEMPT_EGRESS_HOSTS.includes(a.host) ? `measured, ${EXEMPT_LABEL}` : a.phase, host: a.host || `(${a.kind} ${a.target})`, at: iso(a.at) })),
			rows, runners: this.runners, stubCounts, isolation: diff,
			scratch: { path: this.S || "(not created)", kept: keep }, notes: this.notes,
		};
		mkdirSync(REPORTS_DIR, { recursive: true });
		const path = reportPath(REPORTS_DIR, new Date(this.started), this.fault);
		writeFileSync(path, renderReport(report));
		if (!keep && this.S) rmSync(this.S, { recursive: true, force: true });
		process.stdout.write(`chaos ${this.fault}${this.variant ? ` (${this.variant})` : ""}: ${v.verdict} — ${oneLine(v.reason, 600)}\nreport: ${path}\nscratch: ${this.S || "(not created)"} (${keep ? "kept" : "deleted"})\n`);
		return v.verdict === "PASS" ? 0 : v.verdict === "FAIL" ? 1 : 2;
	}
}

/** The main checkout of the repository `dir` is in (a worktree's common dir's parent): the live checkout of § 2.1. */
function liveCheckoutOf(dir: string): string {
	const r = Bun.spawnSync(["git", "--no-optional-locks", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdout: "pipe", stderr: "pipe",
	});
	const common = r.stdout.toString().trim();
	if (r.exitCode !== 0 || !common) return dir;
	return basename(common) === ".git" ? dirname(common) : dir;
}

async function main(argv: string[]): Promise<number> {
	const a = parseArgs(argv);
	if (typeof a === "string") {
		process.stderr.write(`chaos: ${a}\n\n${HELP}`);
		return 2;
	}
	if (a.help) {
		process.stdout.write(HELP);
		return 0;
	}
	let fault = a.fault;
	if (a.nightly) {
		const now = new Date();
		if (!nightlyDue(now, REPORTS_DIR)) return 0;
		fault = nightlyFault(now);
	}
	return new Run(fault!, a.variant, a.nightly).execute();
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}

export { parseArgs, nonceMisses };
