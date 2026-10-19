// The surface's side of the dead-lane relaunch (PLAN wl-mvfqvd5hy8zv28 § 1.5, § 1.6): the pre-read step every surface read
// runs first, inside the same ledger write transaction as the read it precedes (surface/extensions/wake.ts), and the facts
// the needs-you lines (surface/src/errors.ts) hide a death by.
//
// The pre-read step records each lapsed lease as its `lane-died:` row (surface/src/signals.ts), then writes the relaunch
// incident of every open workload whose `relaunchState` is `exhausted` (surface/src/relaunch.ts), once per dead lane
// (`recordIncidentOnce`, surface/src/incident.ts). Run in one IMMEDIATE transaction with the lines it precedes, no runner can
// commit a death between the incident check and the lines, so no read shows an exhausted death without its incident.
//
// A death is the machinery's, and hidden, while the relaunch is due or waiting for it, once a later attempt names it in a
// `relaunch` cause, and for good once an incident keyed to it exists, held or delivered. Every one of these is a durable
// ledger fact; none reads a message's delivery state.
import type { Ledger } from "../../ledger/src/index";
import { INCIDENT_PREFIX, recordIncidentOnce, RETRY_LIMIT } from "./incident";
import { attempts, controlEntries, holdersOf, laneExit } from "./launch";
import { heldTrainPrs, trainHeldDetail } from "./merge-train";
import { type RelaunchState, relaunchRead } from "./relaunch";
import { laneDeaths, recordLapsedLeases } from "./signals";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "./types";

/** The incident kind of a dead lane's spent relaunch budget; its key is the dead lane. */
export const RELAUNCH_INCIDENT = "relaunch";

/** An `incident:` body read back (`incidentBody`'s shape, surface/src/incident.ts); null when the body is not one. */
export interface ParsedIncident {
	kind: string;
	workloadId: string;
	key: string;
	count: number;
	limit: number;
	detail: string;
}

const INCIDENT_BODY = new RegExp(`^${INCIDENT_PREFIX} (\\S+) (\\S+) key (\\S+) after (\\d+)/(\\d+) retries without progress: (.*)$`, "s");

export function parseIncident(body: string): ParsedIncident | null {
	const m = INCIDENT_BODY.exec(body);
	return m ? { kind: m[1]!, workloadId: m[2]!, key: m[3]!, count: Number(m[4]), limit: Number(m[5]), detail: m[6]! } : null;
}

/** The newest attempt's relaunch state at `now`, over the rows a launch decision reads; none for no such workload. */
function stateAt(ledger: Ledger, workloadId: string, now: string): RelaunchState {
	// The cap is not read by the relaunch state; launchRows wants one.
	const rows = ledger.launchRows(workloadId, 0);
	return rows ? relaunchRead({ ...rows, now }).state : { kind: "none" };
}

/**
 * The incident's detail: the held train PRs the dead lane's workload owns (`train #<n> held`, PLAN § 1.7) first, so the
 * 200-character cut never drops them, then the dead lane's `lane-died:` body, or its `lane-exit:` line when no death row
 * names it.
 */
function incidentDetail(ledger: Ledger, workloadId: string, lane: string): string {
	const death = laneDeaths(ledger, workloadId).findLast((d) => d.holder === lane)?.body;
	// `lane-exit:` is the runner's or the starter's, valid without a holder list.
	const exit = death === undefined ? laneExit(controlEntries(ledger.entries(workloadId)), lane) : null;
	const last = death ?? (exit ? `lane-exit: ${lane} outcome ${exit.outcome}${exit.reason ? ` reason ${exit.reason}` : ""}` : `lane ${lane} died`);
	return [trainHeldDetail(heldTrainPrs(ledger, workloadId)), last].filter(Boolean).join("; ");
}

/**
 * For each open autonomous workload whose relaunch state is `exhausted`, write its incident unless one keyed to the dead
 * lane exists (§ 1.5); `recordIncidentOnce` re-reads the state inside its transaction. Returns the ids written.
 */
export function recordRelaunchIncidents(ledger: Ledger, by: string, now: string = ledger.now()): string[] {
	const out: string[] = [];
	for (const { workload } of ledger.inFlight()) {
		if (workload.id === STANDING_WORKLOAD_ID || workload.mode !== "autonomous") continue;
		const s = stateAt(ledger, workload.id, now);
		if (s.kind !== "exhausted") continue;
		const id = recordIncidentOnce(
			ledger,
			{ by, kind: RELAUNCH_INCIDENT, workloadId: workload.id, key: s.lane, count: s.n - 1, limit: RETRY_LIMIT, detail: incidentDetail(ledger, workload.id, s.lane) },
			() => {
				const again = stateAt(ledger, workload.id, now);
				return again.kind === "exhausted" && again.lane === s.lane;
			},
		);
		if (id) out.push(id);
	}
	return out;
}

/**
 * The surface's pre-read step (§ 1.5): lapsed leases recorded as `lane-died:` rows, then the relaunch incidents. The
 * caller runs it inside the `ledger.write` that also materializes its read.
 */
export function recordBeforeRead(ledger: Ledger, by: string, now: string): void {
	recordLapsedLeases(ledger, by, now);
	recordRelaunchIncidents(ledger, by, now);
}

/** What hides a workload's deaths (§ 1.6): the relaunch state, the lanes a relaunch named, the lanes an incident is keyed to. */
export interface RelaunchView {
	state: RelaunchState;
	relaunched: ReadonlySet<string>;
	incidents: ReadonlySet<string>;
}

/** The relaunch view of one workload at `now`. */
export function relaunchView(ledger: Ledger, workloadId: string, now: string): RelaunchView {
	const rows = ledger.launchRows(workloadId, 0);
	if (!rows) return { state: { kind: "none" }, relaunched: new Set(), incidents: new Set() };
	const read = relaunchRead({ ...rows, now });
	const control = controlEntries(rows.entries, holdersOf(rows.entries, rows.workload.holder, rows.holders));
	const relaunched = new Set(attempts(control).flatMap((a) => (a.cause?.kind === "relaunch" ? [a.cause.lane] : [])));
	const prefix = `${INCIDENT_PREFIX} ${RELAUNCH_INCIDENT} ${workloadId} key `;
	const incidents = new Set(
		ledger.db.query<{ body: string }, [string, string, number, string]>(
			"SELECT body FROM messages WHERE workload_id = ? AND created_by = ? AND substr(body, 1, ?) = ?",
		).all(workloadId, SURFACE_BY, prefix.length, prefix).flatMap((m) => {
			const p = parseIncident(m.body);
			return p ? [p.key] : [];
		}),
	);
	return { state: read.state, relaunched, incidents };
}

/** Whether lane `lane`'s death or idle line is hidden (§ 1.6): the machinery relaunches it, waits to, or reported it as an incident. */
export function machineryDeath(v: RelaunchView, lane: string): boolean {
	const s = v.state;
	if ((s.kind === "due" || s.kind === "waiting") && s.lane === lane) return true;
	return v.relaunched.has(lane) || v.incidents.has(lane);
}
