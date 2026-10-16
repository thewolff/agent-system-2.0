// Offline fixtures for the surface tests: temp ledgers through the ledger module with a settable
// clock, a fake OMP extension API following the runner's chaining (copied from
// gates/test/extension.test.ts so the two extensions are driven the same way), a workload with
// one slice, and the scratch root the lane script's process tests run in (the fake omp on PATH,
// a temp HOME with the profile config and the ledger, a temp git repo with a bare remote).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { type ControlEntry, controlEntries, holdersOf, laneStarted } from "../src/launch";
import { laneDeaths } from "../src/signals";
import type { SurfaceAPI } from "../src/types";

export const tmp = (tag: string): string => mkdtempSync(join(tmpdir(), `surface-${tag}-`));

/** A settable clock: `at(iso)` moves it; every ledger write stamps the current value. */
export function clock(start = "2026-10-01T10:00:00.000Z"): { now: () => string; at: (iso: string) => void; plusHours: (h: number) => void } {
	let t = start;
	return {
		now: () => t,
		at: (iso) => {
			t = iso;
		},
		plusHours: (h) => {
			t = new Date(Date.parse(t) + h * 3_600_000).toISOString();
		},
	};
}

export function tempLedger(now?: () => string): { ledger: Ledger; path: string } {
	const path = join(tmp("ledger"), "ledger.db");
	return { ledger: Ledger.open(path, { create: true, backup: false, backupOnOpen: false, ...(now ? { clock: now } : {}) }), path };
}

/** An open workload with one open slice, opened by a lane. */
export function workloadWithSlice(ledger: Ledger, over: { brief?: string; stakes?: "throwaway" | "normal" | "production"; mode?: "autonomous" | "user-driven" } = {}): { wl: string; sl: string } {
	const wl = ledger.openWorkload({ by: "lane-a", brief: over.brief ?? "Fix the feed header offset in newdle-web", stakes: over.stakes ?? "normal", mode: over.mode ?? "autonomous" });
	const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "Move the header offset into a token", doneCondition: "bun test passes", inputs: "src/header.css" });
	return { wl, sl };
}

type AnyHandler = (event: unknown, ctx: unknown) => unknown;
export interface FakeTool {
	name: string;
	execute(id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: { text: string }[]; details?: unknown }>;
}
const schema = (): unknown => ({ describe: () => schema(), optional: () => schema() });

/** A message pushed through pi.sendMessage (the between-wake delivery), with its options. */
export interface Sent {
	message: { customType: string; content: string; display: boolean; details?: unknown };
	options?: unknown;
}

export function fakePi(tools = ["read", "bash", "ask", "task", "yield"], o: { exec?: boolean } = {}) {
	const handlers = new Map<string, AnyHandler[]>();
	const entries: { type: string; data: unknown }[] = [];
	const sent: Sent[] = [];
	const registered = new Map<string, FakeTool>();
	let active = [...tools];
	const execs: {
		calls: { command: string; args: string[]; options: unknown }[];
		answer: (command: string, args: string[]) => { stdout: string; stderr: string; code: number; killed: boolean };
	} = { calls: [], answer: () => ({ stdout: "", stderr: "", code: 0, killed: false }) };
	const pi = {
		on: (name: string, h: AnyHandler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		getActiveTools: () => [...active],
		getAllTools: () => tools.map((name) => ({ name })),
		setActiveTools: async (names: string[]) => {
			active = names;
		},
		appendEntry: (type: string, data?: unknown) => entries.push({ type, data }),
		registerTool: (t: FakeTool) => registered.set(t.name, t),
		sendMessage: (message: Sent["message"], options?: unknown) => sent.push({ message, options }),
		zod: { object: schema, string: schema, array: schema, enum: schema },
	};
	/** pi.exec, opt-in (`fakePi(tools, { exec: true })`): recorded, answered by `execs.answer` (default: exit 0, empty output). */
	const exec = async (command: string, args: string[], options?: unknown) => {
		execs.calls.push({ command, args, options });
		return execs.answer(command, args);
	};
	if (o.exec) Object.assign(pi, { exec });
	const emit = async (name: string, event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
		const hs = handlers.get(name) ?? [];
		if (name === "before_agent_start") {
			let systemPrompt = event.systemPrompt as string[];
			const messages: { customType: string; content: string }[] = [];
			for (const h of hs) {
				const r = (await h({ ...event, systemPrompt }, ctx)) as { systemPrompt?: string[]; message?: { customType: string; content: string } } | undefined;
				if (r?.message) messages.push(r.message);
				if (r?.systemPrompt) systemPrompt = r.systemPrompt;
			}
			return { systemPrompt, messages };
		}
		let last: unknown;
		for (const h of hs) {
			const r = (await h(event, ctx)) as { block?: boolean; decision?: string; handled?: boolean } | undefined;
			if (!r) continue;
			last = r;
			if (r.block || r.decision === "block" || r.handled) return r;
		}
		return last;
	};
	const tool = (name: string): FakeTool => {
		const t = registered.get(name);
		if (!t) throw new Error(`tool ${name} not registered`);
		return t;
	};
	/** OMP admitting a pushed message (agent-session.ts: a turn's input messages, or a fold into context): its `message_end`, a custom-role message. */
	const admit = (entry: Sent, ctx: unknown) =>
		emit("message_end", { type: "message_end", message: { role: "custom", ...entry.message, timestamp: 0 } }, ctx);
	/** The `context` hook over the messages about to reach the model: what the handlers return, or the input unchanged. */
	const context = async (messages: unknown[], ctx: unknown): Promise<unknown[]> => {
		const r = (await emit("context", { type: "context", messages }, ctx)) as { messages?: unknown[] } | undefined;
		return r?.messages ?? messages;
	};
	return { pi: pi as unknown as SurfaceAPI, emit, entries, sent, execs, active: () => active, tool, registered: () => [...registered.keys()], admit, context };
}

export const notices: string[] = [];
/** The same notifications as `notices`, with the level each was notified at. */
export const notified: { message: string; type?: string }[] = [];
/** Timers registered through ctx.setInterval (the surface's poll, the lane's lease renewal): fire one with `timers[i].fn()`. */
export const timers: { fn: () => void; ms: number }[] = [];
/** One-shot timers registered through ctx.setTimeout (the surface's wake push after session_start / session_compact): fire one with `timeouts[i].fn()`. */
export const timeouts: { fn: () => void; ms: number }[] = [];
/** ctx.isIdle() and ctx.hasPendingMessages() read `o.idle` / `o.pending` live at every call, so a test flips them mid-run on its own options object or through `host`, which reads and writes the same fields. */
export const ctxOf = (o: { hasUI?: boolean; parent?: string; cwd?: string; resumed?: boolean; idle?: boolean; pending?: boolean; systemPrompt?: string[] } = {}) => {
	const shutdowns: number[] = [];
	const cleared: unknown[] = [];
	const host = {
		get idle() {
			return o.idle ?? true;
		},
		set idle(v: boolean) {
			o.idle = v;
		},
		get pending() {
			return o.pending ?? false;
		},
		set pending(v: boolean) {
			o.pending = v;
		},
	};
	return {
		hasUI: o.hasUI ?? true,
		cwd: o.cwd ?? tmp("cwd"),
		sessionManager: { getHeader: () => ({ parentSession: o.parent }), getEntries: () => (o.resumed ? [{ type: "message" }] : []) },
		ui: {
			notify: (m: string, type?: string) => {
				notices.push(m);
				notified.push({ message: m, ...(type ? { type } : {}) });
			},
		},
		setInterval: (fn: () => void, ms: number) => {
			timers.push({ fn, ms });
			return timers.length;
		},
		setTimeout: (fn: () => void, ms: number) => {
			timeouts.push({ fn, ms });
			return -timeouts.length;
		},
		clearTimer: (t: unknown) => {
			cleared.push(t);
		},
		isIdle: () => host.idle,
		hasPendingMessages: () => host.pending,
		host,
		/** The session's base system prompt as OMP holds it at session_start (`o.systemPrompt`, default none). */
		getSystemPrompt: () => o.systemPrompt ?? [],
		/** ctx.shutdown calls (lane_release / lane_handoff end the session through it). */
		shutdown: () => {
			shutdowns.push(Date.now());
		},
		shutdowns,
		cleared,
	};
};

/** Minimal offline Text double; ANSI controls are indivisible and only visible characters consume width. */
export const loadTestText = async () => class TestText {
	constructor(private readonly text: string) {}
	invalidate(): void {}
	render(width: number): string[] {
		const rows: string[] = [];
		for (const line of this.text.split("\n")) {
			let row = "";
			let columns = 0;
			for (const token of line.match(/\x1b\]8;[^\x07]*(?:\x07)|\x1b\[[0-9;]*m|[^\x1b]/gu) ?? []) {
				const size = token.startsWith("\x1b") ? 0 : Bun.stringWidth(token);
				if (size > 0 && columns + size > width && columns > 0) {
					rows.push(row);
					row = "";
					columns = 0;
				}
				row += token;
				columns += size;
			}
			rows.push(row);
		}
		return rows;
	}
};

// ---- the lane script's scratch root (surface/test/lane-script.test.ts, lane-smoke.test.ts) ----------

export const LANE_SCRIPT = join(import.meta.dir, "..", "scripts", "lane.ts");
const FAKE_OMP = join(import.meta.dir, "fake-omp.ts");

export interface LaneRoot {
	root: string;
	home: string;
	repo: string;
	remote: string;
	ledgerPath: string;
	/** The fake omp's record (JSONL): one line per process with argv/env/session, then one per event. */
	record: string;
	/** The fake omp's script path (`setScript` writes it). */
	script: string;
	env: Record<string, string>;
}
export interface FakeRecord {
	pid: number;
	argv?: string[];
	cwd?: string;
	env?: Record<string, string>;
	/** On the start record: which shell-start hook names (gates/src/shell-start.ts) the process env carries, by name only. */
	hooks?: string[];
	session?: string;
	resumed?: string | null;
	event?: string;
	/** On a `prompt` event: the frame's id and message. */
	id?: string;
	message?: string;
	/** One per rpc command frame the fake received, in arrival order (`set_model` carries its provider and modelId). */
	command?: string;
	provider?: string;
	modelId?: string;
}
/** One step of the fake omp's script (surface/test/fake-omp.ts header). */
export type FakeStep =
	| { tool: string; args: Record<string, unknown> } | { sleepMs: number } | { exit: number } | { hang: true }
	| { result: string; error?: { message: string; provider?: string; model?: string; retryable: boolean } }
	| { usage: { usd: number; tokens: number }; hand?: string }
	| { background: number | "never" } | { wake: { ms: number; steps: FakeStep[] } }
	| { ledger: { body: string; slice?: string } | { routing: { slice: string } } };
/** The fake omp's script (surface/test/fake-omp.ts header). */
export interface FakeScript {
	claim?: boolean;
	noSession?: boolean;
	/** get_state's `data.model` instead of the one `--model` names; null: no model at all (MIGRATION.md item 85). */
	stateModel?: { provider?: string; id?: string } | null;
	/** get_state answers `success: false` with no data. */
	stateFail?: boolean;
	/** get_state answers this many ms late. */
	stateDelayMs?: number;
	steps?: FakeStep[];
	/** The n-th turn (prompt or woken turn) runs `prompts[n]`, falling back to `steps`. */
	prompts?: FakeStep[][];
	ignoreAbort?: boolean;
	ignoreEof?: boolean;
	ignoreTerm?: boolean;
	stateOnAbort?: boolean;
	eofDelayMs?: number;
	shutdownOnTerm?: boolean;
	/** A helper holds the fake's stdout open until this file exists (≤ 30 s): the runner's finish() waits past omp's death for the test. */
	holdStdoutUntil?: string;
}

export const sh = (cmd: string[], cwd: string, env?: Record<string, string>) => {
	const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
	return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
export const git = (repo: string, args: string[]) => sh(["git", "-C", repo, ...args], repo);

/** A canonical-path git repo with one commit: a tracked file and a `.gitignore` that ignores `*.log` (the working-tree tests). */
export function tempRepo(): string {
	const repo = realpathSync(tmp("repo"));
	writeFileSync(join(repo, "README.md"), "working tree test repo\n");
	writeFileSync(join(repo, ".gitignore"), "*.log\n");
	for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"], ["config", "commit.gpgsign", "false"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) {
		const r = git(repo, args);
		if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
	}
	return repo;
}

/**
 * A scratch root for the lane script: HOME with the profile config and a fresh ledger, the fake omp
 * on PATH ahead of the real binary, a git repo with one commit and a bare remote. The readiness
 * window and the SIGKILL grace are shortened through the runner's two test knobs; `over` adds or
 * replaces environment variables. The quota polls (`AS2_HEADROOM_POLLS`, classifier/src/headroom.ts) point at a file that
 * does not exist, so the runner's guard is open and never reads the real quota-watch polls (PLAN wl-mv71x5rwdu7eo0 § 4); a
 * headroom test passes its own fixture in `over`.
 */
export function laneRoot(over: Record<string, string> = {}): LaneRoot {
	// git rev-parse --show-toplevel reports the canonical path and the worktree is derived from it: the root is canonical too.
	const root = realpathSync(tmp("lane-root"));
	const home = join(root, "home");
	const profile = join(home, ".omp", "profiles", "agent-system-2", "agent");
	mkdirSync(profile, { recursive: true });
	writeFileSync(join(profile, "config.yml"), "setupVersion: 2\n");
	mkdirSync(join(home, ".agent-system-2"), { recursive: true });
	const ledgerPath = join(home, ".agent-system-2", "ledger.db");
	Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false }).close();
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "omp"), `#!/bin/sh\nexec bun ${FAKE_OMP} "$@"\n`);
	chmodSync(join(bin, "omp"), 0o755);
	const repo = join(root, "repo");
	mkdirSync(join(repo, ".ai", "decision-log"), { recursive: true });
	writeFileSync(join(repo, "README.md"), "lane script test repo\n");
	writeFileSync(join(repo, ".ai", "decision-log", ".keep"), "");
	for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) {
		const r = git(repo, args);
		if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
	}
	const remote = join(root, "remote.git");
	sh(["git", "init", "-q", "--bare", "-b", "main", remote], root);
	git(repo, ["remote", "add", "origin", remote]);
	git(repo, ["push", "-q", "-u", "origin", "main"]);
	const record = join(root, "omp-record.jsonl");
	const script = join(root, "omp-script.json");
	const env: Record<string, string> = {
		PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, AGENT_SYSTEM_LEDGER_DB: ledgerPath, FAKE_OMP_RECORD: record, FAKE_OMP_SCRIPT: script,
		AGENT_SYSTEM_LANE_READY_MS: "4000", AGENT_SYSTEM_LANE_END_GRACE_MS: "1500", AGENT_SYSTEM_LEASE_MS: "60000", AS2_HEADROOM_POLLS: join(root, "no-headroom-polls.jsonl"), ...over,
	};
	return { root, home, repo, remote, ledgerPath, record, script, env };
}

export const setScript = (r: LaneRoot, s: FakeScript) => writeFileSync(r.script, JSON.stringify(s));
export const fakeRecords = (r: LaneRoot): FakeRecord[] => (existsSync(r.record) ? readFileSync(r.record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeRecord) : []);
export const laneIdOf = (wl: string, n: number) => `lane-${wl.replace(/^wl-/, "")}-${n}`;

/** The workload's rows as the launcher reads them, through a fresh handle (the processes write through their own). */
export function laneSnapshot(r: LaneRoot, wl: string) {
	const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
	try {
		const workload = l.workload(wl);
		const entries = l.entries(wl);
		const control = controlEntries(entries, holdersOf(entries, workload?.holder ?? null));
		const bodies = entries.map((e) => `${e.created_by} ${e.body}`);
		const deaths = laneDeaths(l, wl).map((d) => d.body);
		return { workload, entries, control, bodies, deaths, questions: l.questions(wl), slices: l.slices(wl) };
	} finally {
		l.close();
	}
}

/** A real-process test polls the ledger for the rows the processes write; there is no event to await across the boundary. */
export async function until<T>(what: string, read: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = read();
		if (v) return v as T;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await Bun.sleep(100);
	}
}

export const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// ---- the runners' drains (MIGRATION.md item 71) ------------------------------------------------------

/** The drains' log under the root's HOME, where surface/scripts/lane.ts `drainLogPath` puts it. */
export const drainLog = (r: LaneRoot): string => join(r.home, ".agent-system-2", "lanes", "drain.log");
/** drain.log's lines without their timestamps. */
function drainLines(r: LaneRoot): string[] {
	const path = drainLog(r);
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => l.slice(l.indexOf(" ") + 1)) : [];
}
/** Every drain a runner spawned so far: the `spawned <pid> by <laneId>` lines it writes before its exit write commits. */
export function drainsSpawned(r: LaneRoot): { pid: number; by: string }[] {
	return drainLines(r).flatMap((l) => {
		const m = /^spawned (\d+) by (\S+)$/.exec(l);
		return m ? [{ pid: Number(m[1]), by: m[2]! }] : [];
	});
}
/** One drain's own lines (`start`, `attempt`, `failed`, `end`), oldest first: never the runner's `spawned <pid>` line for it. */
export const drainLinesOf = (r: LaneRoot, pid: number): string[] =>
	drainLines(r).filter((l) => !l.startsWith("spawned ") && l.split(" ")[1] === String(pid));
/** The pid of the drain the runner of `laneId` spawned. */
export const drainOf = async (r: LaneRoot, laneId: string, timeoutMs = 30_000): Promise<number> =>
	(await until(`the drain of ${laneId}`, () => drainsSpawned(r).find((d) => d.by === laneId), timeoutMs)).pid;
/** Until drain `pid` has logged its end and is gone. */
export async function drainEnded(r: LaneRoot, pid: number, timeoutMs = 30_000): Promise<void> {
	await until(`the end of drain ${pid}`, () => drainLinesOf(r, pid).some((l) => l.startsWith("end ")), timeoutMs);
	await until(`drain ${pid} gone`, () => !alive(pid), timeoutMs);
}
/** Until the drain the runner of `laneId` spawned has ended: whatever it launches has its `launch:` row by then. */
export async function drainSettled(r: LaneRoot, laneId: string, timeoutMs = 30_000): Promise<number> {
	const pid = await drainOf(r, laneId, timeoutMs);
	await drainEnded(r, pid, timeoutMs);
	return pid;
}

/** Every workload's control rows in the root's ledger, closed ones too. */
function rootControl(r: LaneRoot): ControlEntry[] {
	const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
	try {
		return l.db.query<{ id: string }, []>("SELECT id FROM workloads").all().flatMap(({ id }) => {
			const entries = l.entries(id);
			return controlEntries(entries, holdersOf(entries, l.workload(id)?.holder ?? null));
		});
	} finally {
		l.close();
	}
}

/**
 * Before a root is removed: every runner's lane and every lane a drain launched has ended (lane-exit:, or
 * launch-failed: for a starter that failed after its reservation), every runner process is gone, every runner
 * that wrote its own lane-exit: has its `spawned` line, and every spawned drain has logged its end and is
 * gone. Repeated until a pass finds no new launch and no new drain, since a drain's lane spawns its own drain.
 * When a wait fails (its timeout, or an unreadable ledger), every runner and drain of the root still alive is
 * SIGKILLed and waited for until it is gone, then the failure is rethrown: the caller removes the root only
 * after this returns or rejects, so no process it waited on outlives its root.
 */
export async function settleDrains(r: LaneRoot, timeoutMs = 60_000): Promise<void> {
	if (!existsSync(r.ledgerPath)) return;
	const deadline = Date.now() + timeoutMs;
	const left = () => Math.max(1_000, deadline - Date.now());
	try {
		for (let seen = ""; ;) {
			const control = rootControl(r);
			const runnerLanes = new Set(control.filter((c) => c.prefix === "lane-started" && c.createdBy === "lane-runner").map((c) => c.laneId!));
			const lanes = new Set([...runnerLanes, ...control.filter((c) => c.prefix === "launch" && / requested-by lane-runner$/.test(c.rest)).map((c) => c.laneId!)]);
			for (const laneId of lanes) {
				await until(`the end of ${laneId}`, () => rootControl(r).some((c) => c.laneId === laneId && (c.prefix === "lane-exit" || c.prefix === "launch-failed")), left());
			}
			for (const laneId of runnerLanes) {
				const pid = laneStarted(control, laneId)?.runnerPid;
				if (pid) await until(`runner ${pid} gone`, () => !alive(pid), left());
			}
			for (const c of control) if (c.prefix === "lane-exit" && c.createdBy === "lane-runner") await drainOf(r, c.laneId!, left());
			const spawned = drainsSpawned(r);
			for (const d of spawned) await drainEnded(r, d.pid, left());
			const now = `${control.filter((c) => c.prefix === "launch").length} ${spawned.length}`;
			if (now === seen) return;
			seen = now;
		}
	} catch (err) {
		// The pids this function waits on: every runner's (from its lane-started:, when the ledger still reads) and every drain's.
		let runners: number[] = [];
		try {
			const control = rootControl(r);
			runners = control.flatMap((c) => (c.prefix === "lane-started" && c.createdBy === "lane-runner" ? [laneStarted(control, c.laneId!)?.runnerPid ?? 0] : []));
		} catch {
			// An unreadable ledger leaves the drains, which drain.log names.
		}
		const live = [...new Set([...runners, ...drainsSpawned(r).map((d) => d.pid)])].filter((pid) => pid > 0 && alive(pid));
		for (const pid of live) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Gone between the check and the signal.
			}
		}
		for (const pid of live) await until(`pid ${pid} gone after SIGKILL (settling failed: ${String(err)})`, () => !alive(pid), 10_000);
		throw err;
	}
}
