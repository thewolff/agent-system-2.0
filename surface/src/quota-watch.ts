// The quota watch (PLAN wl-mw0vs9uc3xqtka D7, Jo's jo-issues #49 folded in): the alert pass's first step, a port of the
// active daemon loop of Plumb's watcher (~/agent-scratch/agent-system-2.0/quota-watch/watch.py, `main`, the loop body
// from `rows, limits = snapshot()` to `time.sleep(POLL_S)`), not its disabled `burn_check` pace rule.
//
// One pass, at most one poll:
// - `omp usage --json` (bounded at 120 s) → one line `{"t", "rows", "limits"}` appended to `<dir>/polls.jsonl`, the
//   file classifier/src/headroom.ts reads (DEFAULT_POLLS). `t` is epoch seconds, `rows` maps `<provider>/<window>[/<meter>]`
//   to the used fraction rounded to 4 places, `limits` holds one `{provider, windowId, tier, resetsAt, usedFraction}` per
//   `reports[].limits[]` item, every field present (null when omp gave none), as watch.py writes it.
// - level: 0.70 / 0.85 / 0.95 per rows key, crossed upward past the last alerted level; the last alerted level resets to 0
//   when use falls more than 0.20 below it (a window reset). One subject for the highest level crossed.
// - burn: a rise of at least 5 points over 60 min for a `/7d` key, 15 points over 30 min for any other, against the newest
//   earlier poll at least that old; at most once per key per span.
// - poll-failed: the third failed usage read in a row is itself an alert. Every failed read is also this pass's `error`.
// The arithmetic is in basis points (rows carry 4 places), so a threshold fires exactly at its value, never one float ulp
// off. watch.py's floats could miss an exact boundary ((0.15 - 0.10) * 100 < 5 there).
//
// State stays in watch.py's file, `<dir>/state.json`, in its format: `<rows key>` → last alerted level, `burn-alerted:<rows
// key>` → epoch seconds. This module adds `as2-poll-fails`, `as2-last-attempt` (epoch seconds), `as2-last-error` and
// `as2-alerts` (subject key → when it last fired and its words) and leaves every other key as it found it.
// Each firing rule is a `quota:<rows key>:<rule>` subject (`quota:omp-usage:poll-failed` for the failed reads), start
// level 2, active for ACTIVE_S after it last fired; the alert path ends it earlier when Jo acks it.
//
// Dropped on purpose (D7): the Kimi off-until rule, the expired Anthropic reset-credit hint, the disabled pace rule.
// Added: a pass within MIN_POLL_GAP_S of the last poll attempt does not poll (train-tick runs the pass every 300 s, the
// cadence of watch.py's POLL_S; kicks after quota moves may run more passes, and each would otherwise call omp and append).
//
// While Plumb's watcher is installed (~/Library/LaunchAgents/com.agent-system-2.quota-watch.plist), this step only logs
// that, so the two never both write polls.jsonl or state.json. Removing that plist is a line in Jo's install commands.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_POLLS } from "../../classifier/src/headroom";
import type { AlertSubject } from "./alert-path";

/** Used fractions that raise an alert when crossed upward (watch.py LEVELS). */
export const LEVELS = [0.7, 0.85, 0.95] as const;
/** A fall of more than this below the last alerted level resets it to 0 (watch.py `used < prev - 0.2`). */
export const RESET_FALL = 0.2;
/** Burning fast for a `/7d` key: this many points over BURN_7D_SPAN_MIN (watch.py BURN_7D_PTS). */
export const BURN_7D_PTS = 5;
export const BURN_7D_SPAN_MIN = 60;
/** Burning fast for any other key: this many points over BURN_OTHER_SPAN_MIN (watch.py BURN_5H_PTS). */
export const BURN_OTHER_PTS = 15;
export const BURN_OTHER_SPAN_MIN = 30;
/** Failed usage reads in a row that make the poll-failed alert (watch.py `fails == 3`). */
export const POLL_FAILS_ALERT = 3;
/** A quota subject stays active this long after it last fired (D7: "active until acked or 24 h"). */
export const ACTIVE_S = 24 * 3600;
/** A pass this soon after the last poll attempt does not poll again. */
export const MIN_POLL_GAP_S = 60;
/** `omp usage --json` bound (D7). */
export const USAGE_TIMEOUT_MS = 120_000;
export const QUOTA_WATCH_PLIST_LABEL = "com.agent-system-2.quota-watch";
export const POLL_FAILED_KEY = "quota:omp-usage:poll-failed";

const POLLS_FILE = "polls.jsonl";
const STATE_FILE = "state.json";
const FAILS = "as2-poll-fails";
const LAST_ATTEMPT = "as2-last-attempt";
const LAST_ERROR = "as2-last-error";
const ALERTS = "as2-alerts";
const BURN_PREFIX = "burn-alerted:";

export interface QuotaWatchDeps {
	/** The quota-watch directory: polls.jsonl and state.json (AS2_QUOTA_DIR, default the directory of DEFAULT_POLLS). */
	dir: string;
	/** Now, epoch ms. */
	now: number;
	/** `omp usage --json`'s stdout; throws, naming the failure, when the read fails. */
	readUsage: () => string;
	/** Whether Plumb's watcher plist is installed; throws when that cannot be told. */
	plistInstalled: () => boolean;
}

export interface QuotaWatchResult {
	/** Every quota subject active now, sorted by key. */
	subjects: AlertSubject[];
	/** Lines for the pass's log. */
	log: string[];
	/** `quota watch: <what broke>` when this pass's read or write failed, for the needs-you line; else null. */
	error: string | null;
	/**
	 * Why `subjects` is not wholly this pass's evaluation of the quota; false for a pass that evaluated, even when it found
	 * nothing or only a later write failed.
	 * - "state": the plist check or the saved state's read or decode failed, so no quota state is known. The alert pass holds
	 *   every open quota episode unchanged, as for any source that could not be read (review r2 N1).
	 * - "usage": the saved state was read but the usage read failed (now, or in the attempt a pass under the poll gap
	 *   repeats), so the usage rules were not evaluated. The alert pass holds every open quota episode but POLL_FAILED_KEY's:
	 *   that subject is the read state's evaluation of the failing reads, so it climbs the ladder and acks (review r3 N8).
	 */
	unavailable: false | "state" | "usage";
}

/** One poll line's limit, field for field as watch.py writes it. */
export interface PollLimit {
	provider: unknown;
	windowId: unknown;
	tier: unknown;
	resetsAt: unknown;
	usedFraction: unknown;
}

export interface Snapshot {
	rows: Record<string, number>;
	limits: PollLimit[];
}

interface FiredAlert {
	at: number;
	title: string;
	text: string;
	next: string;
}

type State = Record<string, unknown>;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const bp = (fraction: number): number => Math.round(fraction * 10_000);
const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The plist that marks Plumb's watcher as installed, under `home`. */
export const quotaWatchPlistPath = (home: string): string => join(home, "Library", "LaunchAgents", `${QUOTA_WATCH_PLIST_LABEL}.plist`);

/** The real seams: AS2_QUOTA_DIR, `omp usage --json` under its bound, $HOME's LaunchAgents. */
export function quotaWatchDeps(env: Record<string, string | undefined> = process.env, now: number = Date.now()): QuotaWatchDeps {
	const home = env.HOME || homedir();
	return {
		dir: env.AS2_QUOTA_DIR || dirname(DEFAULT_POLLS),
		now,
		readUsage: () => {
			const r = Bun.spawnSync(["omp", "usage", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: USAGE_TIMEOUT_MS, killSignal: "SIGKILL" });
			if (r.exitedDueToTimeout) throw new Error(`omp usage --json timed out after ${USAGE_TIMEOUT_MS / 1000} s and was killed`);
			if (r.exitCode !== 0) throw new Error(`omp usage --json exited ${r.exitCode ?? r.signalCode ?? "?"}: ${r.stderr.toString().trim().split("\n")[0] || "no stderr"}`);
			return r.stdout.toString();
		},
		plistInstalled: () => statSync(quotaWatchPlistPath(home), { throwIfNoEntry: false }) !== undefined,
	};
}

/** watch.py `snapshot()`: rows and limits out of `omp usage --json`'s stdout. Throws, naming what is missing. */
export function parseUsage(stdout: string): Snapshot {
	let d: unknown;
	try {
		d = JSON.parse(stdout);
	} catch (e) {
		throw new Error(`omp usage --json printed no JSON (${message(e)}): ${JSON.stringify(stdout.slice(0, 200))}`);
	}
	if (!isObj(d)) throw new Error(`omp usage --json printed ${JSON.stringify(stdout.slice(0, 200))}, not an object`);
	const capacity = d.capacity ?? {};
	if (!isObj(capacity)) throw new Error("omp usage --json: `capacity` is not an object");
	const rows: Record<string, number> = {};
	for (const [prov, wins] of Object.entries(capacity)) {
		if (!Array.isArray(wins)) throw new Error(`omp usage --json: capacity.${prov} is not a list`);
		for (const w of wins) {
			if (!isObj(w)) throw new Error(`omp usage --json: capacity.${prov} holds a non-object window`);
			const accounts = w.accounts ?? 0;
			if (!isNum(accounts)) throw new Error(`omp usage --json: capacity.${prov} window accounts is ${JSON.stringify(accounts)}`);
			if (accounts <= 0) continue;
			if (typeof w.window !== "string" || !w.window) throw new Error(`omp usage --json: capacity.${prov} has a window with no name`);
			if (!isNum(w.usedAccounts)) throw new Error(`omp usage --json: capacity.${prov}/${w.window} usedAccounts is ${JSON.stringify(w.usedAccounts)}`);
			const key = `${prov}/${w.window}${w.meter ? `/${String(w.meter)}` : ""}`;
			rows[key] = Math.round((w.usedAccounts / accounts) * 10_000) / 10_000;
		}
	}
	const reports = d.reports ?? [];
	if (!Array.isArray(reports)) throw new Error("omp usage --json: `reports` is not a list");
	const limits: PollLimit[] = [];
	for (const rep of reports) {
		const lims = isObj(rep) ? rep.limits : undefined;
		if (!Array.isArray(lims)) continue;
		for (const lim of lims) {
			const l = isObj(lim) ? lim : {};
			const sc = isObj(l.scope) ? l.scope : {};
			const win = isObj(l.window) ? l.window : {};
			const amt = isObj(l.amount) ? l.amount : {};
			limits.push({ provider: sc.provider ?? null, windowId: sc.windowId ?? null, tier: sc.tier || null, resetsAt: win.resetsAt ?? null, usedFraction: amt.usedFraction ?? null });
		}
	}
	return { rows, limits };
}

/** The polls.jsonl line for one poll at `nowMs` (watch.py `json.dumps({"t": now, "rows": rows, "limits": limits})`). */
export function pollLine(nowMs: number, snap: Snapshot): string {
	return `${JSON.stringify({ t: nowMs / 1000, rows: snap.rows, limits: snap.limits })}\n`;
}

/**
 * watch.py `history(minutes)` for each span at once: the rows of the newest poll at least `span` minutes before `nowS`,
 * scanning polls.jsonl from its end. A line that does not parse is skipped and logged; only lines inside the scan are read.
 */
function olderRows(text: string, nowS: number, spansMin: readonly number[], log: string[], path: string): Map<number, Record<string, unknown>> {
	const found = new Map<number, Record<string, unknown>>();
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0 && found.size < spansMin.length; i--) {
		const line = lines[i]!.trim();
		if (!line) continue;
		let p: unknown;
		try {
			p = JSON.parse(line);
		} catch (e) {
			log.push(`quota watch: ${path} line ${i + 1} is not JSON (${message(e)}); skipped for the burn rule`);
			continue;
		}
		if (!isObj(p) || !isNum(p.t) || !isObj(p.rows)) {
			log.push(`quota watch: ${path} line ${i + 1} has no numeric t or no rows; skipped for the burn rule`);
			continue;
		}
		for (const span of spansMin) if (!found.has(span) && p.t <= nowS - span * 60) found.set(span, p.rows);
	}
	return found;
}

function readState(path: string): State {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`cannot read ${path}: ${message(e)}`);
	}
	let s: unknown;
	try {
		s = JSON.parse(text);
	} catch (e) {
		throw new Error(`${path} is not JSON (${message(e)}); left as it is, no poll this pass`);
	}
	if (!isObj(s)) throw new Error(`${path} holds ${JSON.stringify(text.slice(0, 80))}, not an object; left as it is, no poll this pass`);
	return s;
}

function writeState(path: string, state: State): void {
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
	renameSync(tmp, path);
}

/** A numeric state value, 0 when absent; anything else is a corrupt state the pass reports. */
function stateNum(state: State, key: string, path: string): number {
	const v = state[key];
	if (v === undefined) return 0;
	if (!isNum(v)) throw new Error(`${path}: "${key}" is ${JSON.stringify(v)}, not a number`);
	return v;
}

function firedAlerts(state: State, path: string): Record<string, FiredAlert> {
	const v = state[ALERTS] ?? {};
	if (!isObj(v)) throw new Error(`${path}: "${ALERTS}" is not an object`);
	const out: Record<string, FiredAlert> = {};
	for (const [key, a] of Object.entries(v)) {
		if (!isObj(a) || !isNum(a.at) || typeof a.title !== "string" || typeof a.text !== "string" || typeof a.next !== "string") {
			throw new Error(`${path}: "${ALERTS}"."${key}" is not {at, title, text, next}`);
		}
		out[key] = { at: a.at, title: a.title, text: a.text, next: a.next };
	}
	return out;
}

function activeSubjects(alerts: Record<string, FiredAlert>, nowS: number): AlertSubject[] {
	return Object.entries(alerts)
		.filter(([, a]) => nowS - a.at < ACTIVE_S)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, a]) => ({ key, kind: "quota", workloadId: null, startLevel: 2, title: a.title, text: a.text, next: a.next }));
}

/** The rules over one successful poll (watch.py's per-key loop). Mutates `state`; returns the alerts that fired. */
export function quotaRules(
	rows: Record<string, number>,
	older: Map<number, Record<string, unknown>>,
	state: State,
	nowS: number,
	statePath: string,
): Array<{ key: string; title: string; text: string; next: string }> {
	const out: Array<{ key: string; title: string; text: string; next: string }> = [];
	for (const [key, used] of Object.entries(rows)) {
		const provider = key.split("/")[0]!;
		let prev = stateNum(state, key, statePath);
		if (bp(used) < bp(prev) - bp(RESET_FALL)) {
			state[key] = 0;
			prev = 0;
		}
		const crossed = LEVELS.filter((lv) => bp(used) >= bp(lv) && bp(lv) > bp(prev));
		if (crossed.length > 0) {
			const top = crossed[crossed.length - 1]!;
			state[key] = top;
			out.push({
				key: `quota:${key}:level-${Math.round(top * 100)}`,
				title: `Quota: ${key} crossed ${pct(top)}`,
				text: `${key} is ${pct(used)} used (crossed ${pct(top)}).`,
				next: `look at omp usage and move work off ${provider} if it should not hit its cap; ack quota:${key}:level-${Math.round(top * 100)} once seen`,
			});
		}
		const [span, pts] = key.includes("/7d") ? [BURN_7D_SPAN_MIN, BURN_7D_PTS] : [BURN_OTHER_SPAN_MIN, BURN_OTHER_PTS];
		const old = older.get(span)?.[key];
		if (isNum(old)) {
			const riseBp = bp(used) - bp(old);
			const last = stateNum(state, BURN_PREFIX + key, statePath);
			if (riseBp >= pts * 100 && nowS - last >= span * 60) {
				state[BURN_PREFIX + key] = nowS;
				out.push({
					key: `quota:${key}:burn`,
					title: `Quota: ${key} burning fast`,
					text: `${key} burning fast: +${Math.round(riseBp / 100)} points in ${span} min (now ${pct(used)})`,
					next: `look at what is spending ${provider} quota now; ack quota:${key}:burn once seen`,
				});
			}
		}
	}
	return out;
}

/**
 * One quota-watch step of the alert pass. Never throws: every failure comes back as `error` (`quota watch: …`) with
 * the subjects still active, and a failed usage read never returns an empty result without one.
 */
export function runQuotaWatch(deps: QuotaWatchDeps): QuotaWatchResult {
	const log: string[] = [];
	const nowS = deps.now / 1000;
	let installed: boolean;
	try {
		installed = deps.plistInstalled();
	} catch (e) {
		const error = `quota watch: cannot tell whether Plumb's watcher (${QUOTA_WATCH_PLIST_LABEL}.plist) is installed, so no poll this pass: ${message(e)}`;
		return { subjects: [], log: [error], error, unavailable: "state" };
	}
	if (installed) {
		log.push(`quota watch: Plumb's watcher is still installed (~/Library/LaunchAgents/${QUOTA_WATCH_PLIST_LABEL}.plist); it polls, so this step raises nothing`);
		return { subjects: [], log, error: null, unavailable: false };
	}

	const statePath = join(deps.dir, STATE_FILE);
	const pollsPath = join(deps.dir, POLLS_FILE);
	let state: State;
	let alerts: Record<string, FiredAlert>;
	let lastAttempt: number;
	let priorFails: number;
	let lastError: string | null;
	try {
		mkdirSync(deps.dir, { recursive: true });
		state = readState(statePath);
		alerts = firedAlerts(state, statePath);
		lastAttempt = stateNum(state, LAST_ATTEMPT, statePath);
		priorFails = stateNum(state, FAILS, statePath);
		const le = state[LAST_ERROR];
		if (le !== undefined && typeof le !== "string") throw new Error(`${statePath}: "${LAST_ERROR}" is ${JSON.stringify(le)}, not a string`);
		lastError = typeof le === "string" ? le : null;
	} catch (e) {
		const error = `quota watch: ${message(e)}`;
		return { subjects: [], log: [...log, error], error, unavailable: "state" };
	}

	const sinceAttempt = nowS - lastAttempt;
	if (sinceAttempt >= 0 && sinceAttempt < MIN_POLL_GAP_S) {
		log.push(`quota watch: last poll attempt ${Math.round(sinceAttempt)} s ago (under ${MIN_POLL_GAP_S} s); no poll this pass`);
		return { subjects: activeSubjects(alerts, nowS), log, error: lastError ? `quota watch: ${lastError} (the attempt ${Math.round(sinceAttempt)} s ago)` : null, unavailable: lastError === null ? false : "usage" };
	}
	state[LAST_ATTEMPT] = nowS;

	const errors: string[] = [];
	const fire = (a: { key: string; title: string; text: string; next: string }) => {
		alerts[a.key] = { at: nowS, title: a.title, text: a.text, next: a.next };
		log.push(`quota watch: ${a.key} fired: ${a.text}`);
	};

	let snap: Snapshot | null = null;
	try {
		snap = parseUsage(deps.readUsage());
	} catch (e) {
		const fails = priorFails + 1;
		state[FAILS] = fails;
		const failure = `omp usage read failed (${fails} in a row): ${message(e)}`;
		state[LAST_ERROR] = failure;
		errors.push(failure);
		if (fails === POLL_FAILS_ALERT) {
			fire({
				key: POLL_FAILED_KEY,
				title: `Quota watch cannot read omp usage (${POLL_FAILS_ALERT} polls in a row)`,
				text: `Quota watcher cannot read omp usage (${POLL_FAILS_ALERT} polls in a row): ${message(e)}`,
				next: `run omp usage --json by hand to see why it fails; ack ${POLL_FAILED_KEY} once seen`,
			});
		}
	}

	if (snap) {
		state[FAILS] = 0;
		delete state[LAST_ERROR];
		try {
			let text = "";
			try {
				text = readFileSync(pollsPath, "utf8");
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read ${pollsPath} for the burn rule: ${message(e)}`);
			}
			const older = olderRows(text, nowS, [BURN_7D_SPAN_MIN, BURN_OTHER_SPAN_MIN], log, pollsPath);
			for (const a of quotaRules(snap.rows, older, state, nowS, statePath)) fire(a);
		} catch (e) {
			errors.push(message(e));
		}
		try {
			appendFileSync(pollsPath, pollLine(deps.now, snap));
		} catch (e) {
			errors.push(`cannot append to ${pollsPath}: ${message(e)}`);
		}
		log.push(`quota watch: polled ${Object.keys(snap.rows).length} rows (${Object.entries(snap.rows).map(([k, v]) => `${k} ${pct(v)}`).join(", ") || "none"})`);
	}

	for (const [key, a] of Object.entries(alerts)) if (nowS - a.at >= ACTIVE_S) delete alerts[key];
	state[ALERTS] = alerts;
	try {
		writeState(statePath, state);
	} catch (e) {
		errors.push(`cannot write ${statePath}: ${message(e)}`);
	}
	const error = errors.length > 0 ? `quota watch: ${errors.join("; ")}` : null;
	if (error) log.push(error);
	return { subjects: activeSubjects(alerts, nowS), log, error, unavailable: snap === null ? "usage" : false };
}
