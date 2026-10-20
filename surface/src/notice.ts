// The notice channel (PLAN wl-mvfkv7llkp7nk0 § 2): something Jo is told and does not answer — a ceiling
// reached, a plan that started on its own, a PR the merge train merged (PLAN wl-mvg8itbt0rz3ls D4). A notice is a
// held lane→orchestrator message whose body opens with `notice: `, on the same path as every other machinery signal
// (ORCHESTRATOR_RECIPIENT); it is never a `questions` row. surface/src/errors.ts shows it as an unnumbered needs-you
// line of kind `notice` while it is held, the surface's delivery moves it to `delivered` (surface/src/delivery.ts),
// and from then on it no longer shows. Its writers are trusted tool code (the ceiling meter, the plan auto-start, the
// train tick), never a lane's own words: a notice written by a lane that holds or held the workload is shown as that
// lane's plain message instead.
import type { Ledger } from "../../ledger/src/index";
import { ORCHESTRATOR_RECIPIENT } from "./types";

/** Body prefix of a notice message. */
export const NOTICE_PREFIX = "notice:";

/** Enqueue a notice to the orchestrator on `workloadId`, written and sent as `by`; returns the message id. */
export function sendNotice(ledger: Ledger, input: { by: string; workloadId: string; body: string }): string {
	const text = input.body.trim();
	if (!text) throw new Error("a notice has a body");
	return ledger.enqueue({ by: input.by, workloadId: input.workloadId, sender: input.by, recipient: ORCHESTRATOR_RECIPIENT, body: `${NOTICE_PREFIX} ${text}` });
}

/** The longest artifact text a merge notice carries (PLAN wl-mvg8itbt0rz3ls D4). */
export const TRAIN_MERGED_ARTIFACT_MAX = 160;

/** The ruling whose `ruling-applied:` entry on a train slice makes its merge Jo's production sign-off (PLAN wl-mvg8itbt0rz3ls D1, D4). */
export const TRAIN_SIGNOFF_APPLIED_PREFIX = "ruling-applied: train-signoff ";

/**
 * The merge train's notice that it merged PR `pr` on `repo` (PLAN wl-mvg8itbt0rz3ls D4): `merge train merged #<n> (<owner/repo>,
 * <why>): <artifact>`, `<why>` naming Jo's train word under ruling train-signoff when `production`, else normal stakes; the
 * artifact with its whitespace collapsed, cut to TRAIN_MERGED_ARTIFACT_MAX characters, `…` marking the cut.
 */
export function trainMergedNoticeBody(repo: string, pr: number, production: boolean, artifact: string): string {
	const why = production ? "production, Jo's train word (ruling train-signoff)" : "normal stakes";
	const text = artifact.replace(/\s+/g, " ").trim();
	const max = TRAIN_MERGED_ARTIFACT_MAX;
	return `merge train merged #${pr} (${repo}, ${why}): ${text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text}`;
}

/**
 * The control entry on the standing workload, by MERGE_TRAIN_BY, that says the merge notice for PR `pr` of `train` on `repo`
 * (lowercase `owner/repo`) was sent (PLAN wl-mvg8itbt0rz3ls D4). It matches neither `PROTECTION_NOTICE_RE` nor
 * `MAIN_RED_NOTICE_RE` (surface/src/merge-train.ts), so the protection and red-main readers pass over it.
 */
export function trainMergedEntryBody(repo: string, pr: number, train: string): string {
	return `train-notice: merged ${repo.toLowerCase()} #${pr} ${train}`;
}
