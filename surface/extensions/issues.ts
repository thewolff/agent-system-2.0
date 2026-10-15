// The issues row (PLAN wl-mv66ylim0gahog § 2, § 8, § 13.2, § 13.3): the projection of the ledger
// onto each workload's tracker (GitHub issues or a Linear team), drained only here, in the
// orchestrator surface's own process. Inert unless the session is the surface (`s.active`: the
// orchestrator's top-level session); lanes and hands load it and do nothing.
//
// On `session_start` it registers its own `ctx.setInterval` at the surface poll's cadence
// (`s.pollMs`, the same timer source surface/extensions/wake.ts uses for its poll). Each firing
// starts one projector tick (surface/src/issues/projector.ts) fire-and-forget: never awaited by the
// poll, a wake push or a turn, so no turn waits on GitHub. One tick at a time in the process
// (`running`; a firing while one runs is skipped) and across processes (the sidecar claim). Every
// error is caught and becomes a tick notice on the surface's queue (`s.tickNotices`, pushed by the
// wake row's poll), once per distinct text for the session.
//
// The tick runs the phases in ROW_PHASES after the push: reconcile (surface/src/issues/reconcile.ts,
// `reconcileEveryMin`) and intake (surface/src/issues/intake.ts, `intakeEveryMin`), each keeping its
// own cadence in the sidecar.
//
// Turn end (§ 13.3, surface/src/issues/turnend.ts): `session_start` sets this session's own turn
// mark in the sidecar (keyed by OMP's session id, `ctx.sessionManager.getSessionId()`; a host
// without it gets the row's per-session holder id), so a second surface session never moves the
// first one's range; `session_shutdown` deletes this session's key, and a start deletes every mark
// older than 7 days (a session that ended without its shutdown). Every poll firing refreshes this
// session's own mark's time, its seq unchanged (`touchTurnMark`), so a live idle session's mark is
// never taken for an ended one's. Each `agent_end` with
// `willContinue` false records the turn's `turns` rows (local, no network call), marks the touched
// projected links dirty with priority, and starts one tick fire-and-forget (when a tick is already
// running, one more runs right after it). After every tick the pending rows are settled against the
// links' `pushed_seq`; a row pending two ticks is one notice.
//
// No `issues:` block in profile/config.yml (or `$AGENT_SYSTEM_ISSUES_CONFIG`) ⇒ nothing is opened
// and no call is made. The switch (`switch: issues on|off …` on wl-orchestrator) is read every tick.
// Linear's key is `LINEAR_API_KEY` from this process's environment, read per tick and handed to the
// projector only; every notice line has it redacted before it is queued.
import { randomUUID } from "node:crypto";
import { type IssuesConfig, loadIssuesConfig } from "../src/issues/config";
import { intake } from "../src/issues/intake";
import { type FetchLike, LINEAR_KEY_ENV, redact } from "../src/issues/linear";
import { type TickPhases, type TickReport, tick } from "../src/issues/projector";
import { reconcile } from "../src/issues/reconcile";
import { Sidecar, sidecarPath } from "../src/issues/sidecar";
import { clearTurnMark, markSessionStart, recordTurnEnd, settleTurns, touchTurnMark } from "../src/issues/turnend";
import { type SurfaceSession, surfaceSession } from "../src/session";
import type { Ctx, SurfaceAPI } from "../src/types";

/**
 * The phases every tick runs after the push. The projector runs `reconcile` before `intake`
 * whatever the key order here.
 */
export const ROW_PHASES: TickPhases = {
	reconcile,
	intake,
};

export interface IssuesDeps {
	/** The phases after the push; default ROW_PHASES. */
	phases?: TickPhases;
	/** Epoch ms; tests move it. */
	now?: () => number;
	/** Linear's fetch; tests fake it. Default: the global fetch. */
	fetch?: FetchLike;
}

interface RowState {
	started: boolean;
	running: boolean;
	/** A turn ended while a tick ran: run one more tick when it ends. */
	again: boolean;
	/** Notice texts already queued this session. */
	readonly told: Set<string>;
	sidecar: Sidecar | null;
	/** This drainer for the claim: pid + a per-session id. */
	readonly holder: string;
	/** The ticks in flight, or the last run of them (a test seam: tests await it after firing the timer or a turn end). */
	last: Promise<void> | null;
	shutdown: boolean;
}

const STATES = new WeakMap<SurfaceSession, RowState>();

function rowState(s: SurfaceSession): RowState {
	let st = STATES.get(s);
	if (!st) {
		st = { started: false, running: false, again: false, told: new Set(), sidecar: null, holder: `${process.pid}:${randomUUID()}`, last: null, shutdown: false };
		STATES.set(s, st);
	}
	return st;
}

/** The tick in flight (or the last one) for this surface session, or null before any; tests await it. */
export function issuesTickInFlight(s: SurfaceSession): Promise<void> | null {
	return STATES.get(s)?.last ?? null;
}

/**
 * The key of this session's turn mark: OMP's session id (`ReadonlySessionManager.getSessionId`,
 * OMP 18.8.6 session/session-manager.ts), else, on a host or fake without it, the row's own
 * per-session holder id.
 */
function sessionIdOf(ctx: Ctx, st: RowState): string {
	const sm: object = ctx.sessionManager;
	const id: unknown = "getSessionId" in sm && typeof sm.getSessionId === "function" ? sm.getSessionId() : null;
	return typeof id === "string" && id !== "" ? id : st.holder;
}

export default function issuesRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env, deps: IssuesDeps = {}): void {
	const now = deps.now ?? (() => Date.now());

	const tell = (s: SurfaceSession, st: RowState, raw: string): void => {
		const line = redact(raw, env[LINEAR_KEY_ENV]?.trim());
		if (st.told.has(line)) return;
		st.told.add(line);
		s.tickNotices.push(`tick: issues: ${line}`);
	};

	/** The config when the block is present and parses, else null (a malformed block is told by the tick). */
	const configOf = (): IssuesConfig | null => {
		const cfg = loadIssuesConfig(env);
		return cfg.ok ? cfg.config : null;
	};

	const runTick = async (s: SurfaceSession, st: RowState): Promise<void> => {
		let config: IssuesConfig | null = null;
		let report: TickReport | null = null;
		try {
			const cfg = loadIssuesConfig(env);
			if (!cfg.ok) {
				tell(s, st, `the issues: block of the profile config does not parse: ${cfg.error}`);
				return;
			}
			if (cfg.config === null) return;
			if (!pi.exec) {
				tell(s, st, "the host has no exec for extensions; the issues projection cannot run");
				return;
			}
			config = cfg.config;
			st.sidecar ??= Sidecar.open(sidecarPath(env));
			report = await tick({
				exec: pi.exec.bind(pi),
				ledger: s.ledger(),
				sidecar: st.sidecar,
				config,
				holder: st.holder,
				now,
				notice: (line) => tell(s, st, line),
				phases: deps.phases ?? ROW_PHASES,
				linear: { key: env[LINEAR_KEY_ENV]?.trim() || null, fetch: deps.fetch ?? ((url, init) => fetch(url, init)) },
			});
		} catch (err) {
			tell(s, st, `the issues tick failed: ${String(err instanceof Error ? err.message : err)}`);
		}
		if (config === null || st.sidecar === null) return;
		try {
			const lines = settleTurns({ ledger: s.ledger(), sidecar: st.sidecar, config, nowMs: now(), report, linearKey: Boolean(env[LINEAR_KEY_ENV]?.trim()) });
			for (const line of lines) tell(s, st, line);
		} catch (err) {
			tell(s, st, `the issues turn check failed: ${String(err instanceof Error ? err.message : err)}`);
		}
	};

	/** Start a tick fire-and-forget; while one runs a poll firing is skipped and a turn end queues one more. */
	const start = (s: SurfaceSession, st: RowState, fromTurn: boolean): void => {
		if (st.shutdown) return;
		if (st.running) {
			if (fromTurn) st.again = true;
			return;
		}
		st.running = true;
		st.last = (async () => {
			try {
				do {
					st.again = false;
					await runTick(s, st);
				} while (st.again && !st.shutdown);
			} finally {
				st.running = false;
				if (st.shutdown) {
					st.sidecar?.close();
					st.sidecar = null;
				}
			}
		})().catch((err: unknown) => {
			process.stderr.write(`surface: the issues tick failed: ${String(err)}\n`);
		});
	};

	pi.on("session_start", (_e, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		const st = rowState(s);
		if (st.started) return undefined;
		st.started = true;
		const sessionId = sessionIdOf(ctx, st);
		try {
			if (configOf() !== null) {
				st.sidecar ??= Sidecar.open(sidecarPath(env));
				markSessionStart(s.ledger(), st.sidecar, sessionId, now());
			}
		} catch (err) {
			tell(s, st, `the issues turn mark failed: ${String(err instanceof Error ? err.message : err)}`);
		}
		ctx.setInterval(() => {
			// The heartbeat: this live session's mark stays younger than any start's purge age.
			try {
				if (st.sidecar && !st.shutdown) touchTurnMark(st.sidecar, sessionId, now());
			} catch (err) {
				tell(s, st, `the issues turn mark failed: ${String(err instanceof Error ? err.message : err)}`);
			}
			start(s, st, false);
		}, s.pollMs);
		return undefined;
	});

	pi.on("agent_end", (event, ctx) => {
		if (event.willContinue) return undefined;
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		const st = rowState(s);
		if (st.shutdown) return undefined;
		const config = configOf();
		if (config === null) return undefined;
		try {
			st.sidecar ??= Sidecar.open(sidecarPath(env));
			recordTurnEnd({ ledger: s.ledger(), sidecar: st.sidecar, config, nowMs: now(), sessionId: sessionIdOf(ctx, st) });
		} catch (err) {
			tell(s, st, `the issues turn check failed: ${String(err instanceof Error ? err.message : err)}`);
		}
		start(s, st, true);
		return undefined;
	});

	pi.on("session_shutdown", (_e, ctx) => {
		const s = surfaceSession(ctx, env);
		if (!s.active) return undefined;
		const st = rowState(s);
		st.shutdown = true;
		try {
			if (st.sidecar) clearTurnMark(st.sidecar, sessionIdOf(ctx, st));
		} catch (err) {
			tell(s, st, `the issues turn mark failed: ${String(err instanceof Error ? err.message : err)}`);
		}
		if (!st.running) {
			st.sidecar?.close();
			st.sidecar = null;
		}
		return undefined;
	});
}
