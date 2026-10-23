// The lane→orchestrator signals behind § B3 lines 3, 4 and 5 and the lane's artifact declaration,
// as ledger rows (§ B2: lane↔orchestrator talk is ledger messages; no schema bump — each is a
// `messages` row to the orchestrator with a body prefix, or an `assumption` entry). One place for
// the body formats so the writers (surface/extensions/lane.ts, gates row 8, the surface's own
// lease observer) and the readers (errors.ts) cannot drift.
//
// - `lane-died: <holder>: lease lapsed <until>` / `… session shutdown at <t>` / `… stopped by signal <SIG> (restart)`: the
//   owning session is gone with the workload still open (§ B3 item 4), one row per lane. Written by whoever observes it
//   first: the runner when a restart signal stops it, the lane itself at session_shutdown, a reclaiming lane before it
//   takes the workload over, or the surface
//   when it reads a lapsed lease. Held until the surface renders it, then `delivered`: that state
//   change is the "surfaced once" mark (SPEC-2.0.md:411-412), so a takeover or a reopen never
//   erases the death and a repeated wake never repeats it.
// - `prompt-wait: <tool> call <id> in session <sid>: <reason>` and the matching `prompt-resolved:`:
//   a leaked blocking human prompt began / ended (§ B3 item 5, first trigger), keyed by the lane
//   (sender) and the tool-call id.
// - `artifact-failed:` / `artifact-passed:` on a slice: one runtime-artifact execution's outcome
//   (§ B3 item 3); failures count since the last pass (Codex S3).
// - `artifact-command: <command>` (`assumption` entry on the slice): the lane's declaration of the
//   slice's runtime artifact, matched against its bash results.
// - `artifact-tree: {"repo","tree","command"}` (`assumption` entry on the slice): a declared artifact
//   exited 0 and the working tree (surface/src/wtree.ts) was the same before and after the run; the
//   evidence for a push (P-11 row 8). JSON, because a repository path can hold spaces.
import type { Ledger, MessageRow, WorkloadStatusRow } from "../../ledger/src/index";
import { controlEntries, holdersOf } from "./launch";
import { laneRunning, type ProbeFor, psProbe } from "./runner-probe";
import {
	ARTIFACT_COMMAND_PREFIX, ARTIFACT_FAILED_PREFIX, ARTIFACT_PASSED_PREFIX, ARTIFACT_TREE_PREFIX, LANE_DIED_PREFIX, ORCHESTRATOR_RECIPIENT,
	PROMPT_RESOLVED_PREFIX, PROMPT_WAIT_PREFIX,
} from "./types";

// ---- lane died -------------------------------------------------------------------------------

export interface LaneDeath {
	/** The message id: the row the § B3 line is about. */
	id: string;
	workloadId: string;
	holder: string;
	/** `held` until the surface has rendered it once. */
	state: MessageRow["state"];
	body: string;
	created_at: string;
	/** Insertion order (sqlite rowid): the tie-break for rows stamped in the same millisecond. */
	seq: number;
}

const laneDiedLapsedBody = (holder: string, leaseUntil: string): string => `${LANE_DIED_PREFIX} ${holder}: lease lapsed ${leaseUntil}`;

/** The body of a death the lane records about itself at session_shutdown with work still open. */
export function laneDiedShutdownBody(holder: string, at: string, openSlices: number): string {
	return `${LANE_DIED_PREFIX} ${holder}: session shutdown at ${at} with ${openSlices} open slice(s)`;
}

/**
 * The body of the death the runner records when a restart's SIGTERM/SIGINT stops its lane, in the transaction that accepts
 * the signal (PLAN wl-mvfqvd5hy8zv28 § 1.2): a graceful restart stop releases the holder, so no lapse would record it.
 */
export function laneDiedSignalBody(laneId: string, signal: string, openSlices: number): string {
	return `${LANE_DIED_PREFIX} ${laneId}: stopped by signal ${signal} (restart), ${openSlices} open slice(s)`;
}

const LANE_DIED_BODY = /^lane-died:\s*(\S+?):\s/;

/** Every lane-died message on a workload, oldest first (any state). */
export function laneDeaths(ledger: Ledger, workloadId: string): LaneDeath[] {
	const rows = ledger.db.query<MessageRow & { seq: number }, [string, string]>(
		"SELECT rowid AS seq, * FROM messages WHERE workload_id = ? AND body LIKE ? ORDER BY created_at, rowid",
	).all(workloadId, `${LANE_DIED_PREFIX}%`);
	return rows.map((m) => ({ id: m.id, workloadId: m.workload_id, holder: LANE_DIED_BODY.exec(m.body)?.[1] ?? "?", state: m.state, body: m.body, created_at: m.created_at, seq: m.seq }));
}

/**
 * Persist the death of `workload`'s holder whose lease has lapsed, once per lane (the guard `enqueueRunnerDeath` keeps,
 * PLAN wl-mvfqvd5hy8zv28 § 1.2): the same lapse observed by the surface and by a reclaiming lane lands one row, and a lane
 * whose death is already recorded (its runner's restart death, its own shutdown) gets no second one, so each lane has one
 * death row and one death time. Returns the message id, or null when the lease is live, there is no holder, a lane-died
 * message already names the holder, or the holder's lane is still running (`unrecordedLapse`).
 */
export function recordLapsedLease(ledger: Ledger, workload: WorkloadStatusRow, by: string, now: string = ledger.now(), probeFor: ProbeFor = psProbe): string | null {
	if (workload.status !== "open" || !unrecordedLapse(ledger, workload, now, probeFor)) return null;
	return ledger.enqueue({ by, workloadId: workload.id, sender: by, recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedLapsedBody(workload.holder!, workload.holder_lease_until!) });
}

/**
 * A lapsed lease whose holder no lane-died row names yet (the surface writes it before rendering; pure readers see it here),
 * and whose lane is not still running (`laneRunning` over `probeFor`, the check the relaunch's `laneEnd` makes): a runner
 * that outlived its lease (a sleeping Mac) renews on wake, so its lapse is neither recorded nor shown as a death (review r2 R2-3).
 */
export function unrecordedLapse(ledger: Ledger, workload: WorkloadStatusRow, now: string, probeFor: ProbeFor = psProbe): boolean {
	if (!workload.holder || !workload.holder_lease_until || workload.holder_lease_until >= now) return false;
	if (laneDeaths(ledger, workload.id).some((d) => d.holder === workload.holder)) return false;
	const entries = ledger.entries(workload.id);
	return !laneRunning(controlEntries(entries, holdersOf(entries, workload.holder, ledger.holders(workload.id))), workload.id, workload.holder, probeFor);
}

/** `recordLapsedLease` over every open workload; the ids written. The surface calls this before every read. */
export function recordLapsedLeases(ledger: Ledger, by: string, now: string = ledger.now(), probeFor: ProbeFor = psProbe): string[] {
	const out: string[] = [];
	for (const { workload } of ledger.inFlight()) {
		const id = recordLapsedLease(ledger, workload, by, now, probeFor);
		if (id) out.push(id);
	}
	return out;
}

// ---- leaked prompt ---------------------------------------------------------------------------

export interface PromptWait {
	/** The `prompt-wait:` message id. */
	id: string;
	workloadId: string;
	/** The lane whose session is blocked (the message sender). */
	lane: string;
	toolName: string;
	toolCallId: string;
	sessionId: string;
	reason: string;
	created_at: string;
}

const promptKey = (toolName: string, toolCallId: string, sessionId: string): string => `${toolName} call ${toolCallId} in session ${sessionId || "?"}`;

export function promptWaitBody(toolName: string, toolCallId: string, sessionId: string, reason: string): string {
	return `${PROMPT_WAIT_PREFIX} ${promptKey(toolName, toolCallId, sessionId)}: ${reason}`;
}
export function promptResolvedBody(toolName: string, toolCallId: string, sessionId: string, outcome: string): string {
	return `${PROMPT_RESOLVED_PREFIX} ${promptKey(toolName, toolCallId, sessionId)}: ${outcome}`;
}

const PROMPT_BODY = /^prompt-(?:wait|resolved):\s*(\S+) call (\S+) in session (\S+):\s*(.*)$/s;

/**
 * The prompt waits on a workload that no `prompt-resolved:` from the same lane has closed and that
 * did not die with their lane (a later `lane-died:` for the sender ends the wait: § B3 item 4 is
 * the liveness check that closes a prompt a dead process never resolves, SPEC-2.0.md:429-430).
 */
export function openPromptWaits(ledger: Ledger, workloadId: string): PromptWait[] {
	const rows = ledger.db.query<MessageRow & { seq: number }, [string, string, string]>(
		"SELECT rowid AS seq, * FROM messages WHERE workload_id = ? AND (body LIKE ? OR body LIKE ?) ORDER BY created_at, rowid",
	).all(workloadId, `${PROMPT_WAIT_PREFIX}%`, `${PROMPT_RESOLVED_PREFIX}%`);
	const deaths = laneDeaths(ledger, workloadId);
	const resolved = new Set<string>();
	for (const m of rows) {
		if (!m.body.startsWith(PROMPT_RESOLVED_PREFIX)) continue;
		const p = PROMPT_BODY.exec(m.body);
		if (p) resolved.add(`${m.sender}|${p[1]}|${p[2]}|${p[3]}`);
	}
	const waits: PromptWait[] = [];
	for (const m of rows) {
		if (!m.body.startsWith(PROMPT_WAIT_PREFIX)) continue;
		const p = PROMPT_BODY.exec(m.body);
		if (!p) continue;
		if (resolved.has(`${m.sender}|${p[1]}|${p[2]}|${p[3]}`)) continue;
		if (deaths.some((d) => d.holder === m.sender && d.seq > m.seq)) continue;
		waits.push({ id: m.id, workloadId, lane: m.sender, toolName: p[1]!, toolCallId: p[2]!, sessionId: p[3]!, reason: p[4]!.trim(), created_at: m.created_at });
	}
	return waits;
}

// ---- runtime artifact ------------------------------------------------------------------------

export function artifactCommandBody(command: string): string {
	return `${ARTIFACT_COMMAND_PREFIX} ${command.trim()}`;
}

/** The declared artifact command per open or paused slice of a workload: the newest declaration wins. */
export function artifactCommands(ledger: Ledger, workloadId: string): Map<string, string> {
	const rows = ledger.db.query<{ slice_id: string; body: string }, [string, string]>(
		`SELECT e.slice_id, e.body FROM entries e JOIN slices s ON s.id = e.slice_id
		 WHERE e.workload_id = ? AND e.kind = 'assumption' AND e.body LIKE ? AND s.state IN ('open', 'paused')
		 ORDER BY e.created_at, e.rowid`,
	).all(workloadId, `${ARTIFACT_COMMAND_PREFIX}%`);
	const out = new Map<string, string>();
	for (const r of rows) out.set(r.slice_id, r.body.slice(ARTIFACT_COMMAND_PREFIX.length).trim());
	return out;
}

/**
 * The declared artifact command per open, paused or done slice of a workload, the newest
 * declaration winning: the commands whose passing run writes an `artifact-tree:` record
 * (wl-mupzpidbb3ksg0 PLAN.md § 2). A done slice's tests re-run on a new tree are evidence for that
 * tree; a cancelled slice's declaration was never proven and is left out.
 */
export function recordableArtifactCommands(ledger: Ledger, workloadId: string): Map<string, string> {
	const rows = ledger.db.query<{ slice_id: string; body: string }, [string, string]>(
		`SELECT e.slice_id, e.body FROM entries e JOIN slices s ON s.id = e.slice_id
		 WHERE e.workload_id = ? AND e.kind = 'assumption' AND e.body LIKE ? AND s.state IN ('open', 'paused', 'done')
		 ORDER BY e.created_at, e.rowid`,
	).all(workloadId, `${ARTIFACT_COMMAND_PREFIX}%`);
	const out = new Map<string, string>();
	for (const r of rows) out.set(r.slice_id, r.body.slice(ARTIFACT_COMMAND_PREFIX.length).trim());
	return out;
}

export function artifactFailedBody(what: string): string {
	return `${ARTIFACT_FAILED_PREFIX} ${what}`;
}
export function artifactPassedBody(what: string): string {
	return `${ARTIFACT_PASSED_PREFIX} ${what}`;
}

/** The body of the record a passing declared artifact run leaves: the tree it ran on. */
export function artifactTreeBody(r: { repo: string; tree: string; command: string }): string {
	return `${ARTIFACT_TREE_PREFIX} ${JSON.stringify({ repo: r.repo, tree: r.tree, command: r.command })}`;
}

export interface ArtifactTree {
	sliceId: string;
	repo: string;
	tree: string;
	command: string;
}

/**
 * Every `artifact-tree:` record on a workload, oldest first, on a slice in any state (a done slice's
 * passing run is still evidence for the tree it ran on). A body that does not parse to the three
 * strings is skipped.
 */
export function artifactTrees(ledger: Ledger, workloadId: string): ArtifactTree[] {
	const rows = ledger.db.query<{ slice_id: string | null; body: string }, [string, string]>(
		`SELECT slice_id, body FROM entries WHERE workload_id = ? AND kind = 'assumption' AND body LIKE ? ORDER BY created_at, rowid`,
	).all(workloadId, `${ARTIFACT_TREE_PREFIX}%`);
	const out: ArtifactTree[] = [];
	for (const r of rows) {
		if (r.slice_id === null || !r.body.startsWith(ARTIFACT_TREE_PREFIX)) continue;
		let v: unknown;
		try {
			v = JSON.parse(r.body.slice(ARTIFACT_TREE_PREFIX.length));
		} catch {
			continue;
		}
		if (!v || typeof v !== "object") continue;
		const { repo, tree, command } = v as Record<string, unknown>;
		if (typeof repo !== "string" || typeof tree !== "string" || typeof command !== "string" || !repo || !tree || !command) continue;
		out.push({ sliceId: r.slice_id, repo, tree, command });
	}
	return out;
}

/**
 * The artifact-failure count per slice of one workload since that slice's last `artifact-passed:`
 * message (a later success is recovery, Codex S3), with the ids of the held failure messages
 * behind the count so a delivery can consume them.
 */
export function artifactFailures(ledger: Ledger, workloadId: string): Map<string, { n: number; heldIds: string[] }> {
	const rows = ledger.db.query<{ id: string; slice_id: string; body: string; state: string }, [string, string, string]>(
		`SELECT id, slice_id, body, state FROM messages
		 WHERE workload_id = ? AND slice_id IS NOT NULL AND (body LIKE ? OR body LIKE ?) ORDER BY created_at, rowid`,
	).all(workloadId, `${ARTIFACT_FAILED_PREFIX}%`, `${ARTIFACT_PASSED_PREFIX}%`);
	const out = new Map<string, { n: number; heldIds: string[] }>();
	for (const r of rows) {
		if (r.body.startsWith(ARTIFACT_PASSED_PREFIX)) {
			out.set(r.slice_id, { n: 0, heldIds: [] });
			continue;
		}
		const cur = out.get(r.slice_id) ?? { n: 0, heldIds: [] };
		cur.n++;
		if (r.state === "held") cur.heldIds.push(r.id);
		out.set(r.slice_id, cur);
	}
	return out;
}
