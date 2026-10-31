/**
 * Self-heal Phase 1 (detect and report): the shared shapes of the eight detectors and the daily
 * report (PLAN wl-mvbcjageg7o2yo § 2.1). Detectors are pure functions over already-read inputs, so
 * tests feed fixtures cut from recorded failures and the report feeds live reads. Nothing here
 * writes, repairs or changes authority.
 */

/** The seven failures of 4-self-heal.md § 3, one detector each, and mcp-load (an MCP server that failed to load in the profile). */
export const DETECTOR_IDS = [
	"compaction-loop",
	"hand-lab",
	"paste-drop",
	"ceiling-wall",
	"flaky-test",
	"jetsam",
	"model-start",
	"mcp-load",
] as const;
export type DetectorId = (typeof DETECTOR_IDS)[number];

/** A half-open report window `[from, to)`, ISO-8601 UTC instants. */
export interface Window {
	from: string;
	to: string;
}

/** One detected failure. `at` is the time of the event that completes it; it lies inside the window. */
export interface Finding {
	detector: DetectorId;
	at: string;
	workloadId: string | null;
	laneId: string | null;
	/** One line for the report. */
	summary: string;
	/** Where to look: an entry id, a session path and line, a report file. */
	evidence: string;
}
