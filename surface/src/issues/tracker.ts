// Which tracker a workload's issue lives on (PLAN wl-mv66ylim0gahog § 13.2). Precedence: the newest
// `tracker: <wl-id> github|linear <TEAM>|none by <in-id>` entry on the workload (Jo's typed
// `tracker` word, written by the surface with the instruction it cites), else the config's
// `issues.overrides`, else the first `issues.trackers` rule matching the workload's origin
// owner/repo, else none (not projected). The entry is in the switch's shape (switch.ts): an
// `assumption` by the surface; any other author's entry is not read.
import type { EntryRow, Ledger } from "../../../ledger/src/index";
import { SURFACE_BY } from "../types";
import { type IssuesConfig, matchTracker, TEAM_KEY, type Tracker } from "./config";

const ENTRY_RE = /^tracker: (wl-[a-z0-9]+) (github|linear ([A-Za-z][A-Za-z0-9]*)|none) by (in-\S+)$/;

/** `links.repo` for a workload on no GitHub repo (no `repo:` entry, no origin, or not github.com). */
export const NO_REPO = "-";

/** `tracker: <wl-id> <kind> [<team>] by <in-id>`: the entry body the `tracker` word records on the workload. */
export function trackerEntryBody(workloadId: string, tracker: Tracker | null, instructionId: string): string {
	if (!/^wl-[a-z0-9]+$/.test(workloadId)) throw new Error(`${workloadId} is not a workload id`);
	if (!/^in-\S+$/.test(instructionId)) throw new Error(`${instructionId} is not an instruction id`);
	if (tracker?.kind === "linear" && !TEAM_KEY.test(tracker.team)) throw new Error(`${tracker.team} is not a Linear team key`);
	const kind = tracker === null ? "none" : tracker.kind === "github" ? "github" : `linear ${tracker.team.toUpperCase()}`;
	return `tracker: ${workloadId} ${kind} by ${instructionId}`;
}

/** The tracker the newest valid `tracker:` entry among `entries` (the workload's, oldest first) names; undefined when there is none. */
export function trackerEntryOf(workloadId: string, entries: readonly EntryRow[]): { tracker: Tracker | null; entryId: string } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.kind !== "assumption" || e.created_by !== SURFACE_BY) continue;
		const m = ENTRY_RE.exec(e.body.trim());
		if (!m || m[1] !== workloadId) continue;
		const tracker: Tracker | null = m[2] === "github" ? { kind: "github" } : m[2] === "none" ? null : { kind: "linear", team: m[3]!.toUpperCase() };
		return { tracker, entryId: e.id };
	}
	return undefined;
}

export type TrackerSource = "entry" | "override" | "repo" | "none";

/** The workload's effective tracker and where it came from; `ownerRepo` is its origin owner/repo (the `links.repo` cache), or null/`-`. */
export function effectiveTracker(ledger: Ledger, config: Pick<IssuesConfig, "trackers" | "overrides">, workloadId: string, ownerRepo: string | null): { tracker: Tracker | null; source: TrackerSource } {
	const entry = trackerEntryOf(workloadId, ledger.entries(workloadId, "assumption"));
	if (entry) return { tracker: entry.tracker, source: "entry" };
	if (Object.hasOwn(config.overrides, workloadId)) return { tracker: config.overrides[workloadId]!, source: "override" };
	const byRepo = matchTracker(config.trackers, ownerRepo);
	return byRepo ? { tracker: byRepo, source: "repo" } : { tracker: null, source: "none" };
}

/**
 * The tracker a link projects to now (`effectiveTracker`), or null. `repo` is the link's cached
 * owner/repo (NO_REPO or null when it has none). GitHub issues live on the workload's own repo, so
 * a GitHub tracker on a workload with no GitHub repo is none.
 */
export function linkTracker(ledger: Ledger, config: Pick<IssuesConfig, "trackers" | "overrides">, workloadId: string, repo: string | null): Tracker | null {
	const t = effectiveTracker(ledger, config, workloadId, repo === NO_REPO ? null : repo).tracker;
	return t?.kind === "github" && (repo === null || repo === NO_REPO) ? null : t;
}
