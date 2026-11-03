// The alert path (PLAN wl-mw0vs9uc3xqtka D1): one ladder for every event that needs Jo, generalized from the merge
// train's alert ladder. This file starts as the shared contract the sources (alert-sources.ts) and the quota watch
// (quota-watch.ts) build against; sl-alert-core fills in the ladder, records and actions.

/** What kind of event a subject is; one key per (kind, thing). */
export type AlertKind =
	| "ceiling"
	| "died"
	| "parked"
	| "train"
	| "released-alive"
	| "main-red"
	| "chaos"
	| "quota-move"
	| "quota";

/**
 * One thing Jo must hear about, computed fresh by every pass from ledger state and files (level-triggered).
 * `key` is `<kind prefix>:<id>`: `ceiling:wl-…`, `died:wl-…`, `parked:wl-…`, `q:q-…`, `lane:lane-…`,
 * `main:<owner/repo>`, `chaos:<report file name>`, `move:<entry id>`, `quota:<rows key>:<rule>`.
 */
export interface AlertSubject {
	key: string;
	kind: AlertKind;
	workloadId: string | null;
	/** 1, or 2 (the popup level) for quota moves, quota alerts and urgent workloads' subjects. */
	startLevel: 1 | 2;
	/** One line naming the thing in words. */
	title: string;
	/** The facts, one or more lines. */
	text: string;
	/** The one thing Jo does, e.g. `extend wl-…`. */
	next: string;
}
