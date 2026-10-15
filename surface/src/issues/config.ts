// The `issues:` block of profile/config.yml (PLAN wl-mv66ylim0gahog § 2, § 13.2): which tracker each
// workload's repo projects to (an ordered list, first match on the workload's origin owner/repo
// wins), seeded per-workload overrides, Jo's GitHub login (the intake author check), the repo intake
// reads and the labels it skips, and the projection's caps. Loaded the way `loadTestRunnerConfig`
// loads `testRunner:` (surface/src/close-entry.ts), with an env override for tests. No block means
// the projector serves nothing: the row never opens the sidecar and makes no call.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../session";

/** Replaces the checkout's profile/config.yml as the source of the `issues:` block (tests, the smoke). */
export const ISSUES_CONFIG_ENV = "AGENT_SYSTEM_ISSUES_CONFIG";

/** Where a workload's issue lives: GitHub issues on the workload's own repo, or a Linear team. */
export type Tracker = { kind: "github" } | { kind: "linear"; team: string };

/** One `issues.trackers` entry: `match` is `owner/repo` or `owner/*` (a `*` glob on the repo part). */
export interface TrackerRule {
	match: string;
	tracker: Tracker;
}

export interface IssuesConfig {
	/** Ordered: the first rule whose `match` fits the workload's origin owner/repo wins; none ⇒ not projected. */
	trackers: TrackerRule[];
	/** Per-workload trackers that beat the repo map (null: never projected). */
	overrides: Record<string, Tracker | null>;
	/** Jo's GitHub login: the only author intake accepts (§ 6.2 rule 1). */
	jo: string;
	/**
	 * The GitHub repo intake reads (§ 6), when it is not the projection's own: Jo files on
	 * thewolff/jo-issues (q-mv92ac7xt75v5s). Absent ⇒ the first exact GitHub rule's repo (`intakeRepo`).
	 */
	intakeRepo?: string;
	/**
	 * Lower-case labels that keep an issue out of intake: it is ignored, counted, and left untouched.
	 * Machinery files on the intake repo as Jo's own account and labels its issues: Plumb `plumb`, the
	 * merge train's alerts `as2-train` (in-mv93e832mquneo). A machinery-filed issue is never a Jo input.
	 */
	intakeSkipLabels: readonly string[];
	/** Counted calls one tick may make, per tracker kind. */
	perTick: number;
	/** Counted calls in any rolling hour, per tracker kind, across processes (the sidecar's `calls` table). */
	perHour: number;
	/** Minutes between reconciler runs (§ 4). */
	reconcileEveryMin: number;
	/** Minutes between intake runs (§ 6). */
	intakeEveryMin: number;
	/** A link or a PR footer that failed this many times in a row is parked until the reconciler resets it. */
	parkAfterFails: number;
}

/** The keys the block counts in positive integers. */
const COUNT_KEYS = ["perTick", "perHour", "reconcileEveryMin", "intakeEveryMin", "parkAfterFails"] as const;

/** The plan's defaults (§ 2), used for a key the block leaves out. */
export const ISSUES_DEFAULTS: Omit<IssuesConfig, "trackers" | "overrides" | "jo" | "intakeRepo"> = {
	perTick: 20,
	perHour: 300,
	reconcileEveryMin: 60,
	intakeEveryMin: 5,
	parkAfterFails: 10,
	intakeSkipLabels: ["plumb", "as2-train"],
};

const OWNER_REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
const OWNER_GLOB = /^[A-Za-z0-9][\w.-]*\/\*$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** A Linear team key (ENG, MKT, ALL). */
export const TEAM_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
const WORKLOAD_ID = /^wl-[a-z0-9]+$/;

/** `github`, `linear:<TEAM>` (the `links.tracker` value and the override form), or null for `none`; undefined when malformed. */
export function parseTrackerKey(s: string): Tracker | null | undefined {
	if (s === "none") return null;
	if (s === "github") return { kind: "github" };
	const m = /^linear:(.+)$/.exec(s);
	return m && TEAM_KEY.test(m[1]!) ? { kind: "linear", team: m[1]!.toUpperCase() } : undefined;
}

/** The `links.tracker` value of a tracker: `github` or `linear:<TEAM>`. */
export function trackerKey(t: Tracker): string {
	return t.kind === "github" ? "github" : `linear:${t.team}`;
}

/** The first rule matching `ownerRepo` (case-insensitive), or null. */
export function matchTracker(rules: readonly TrackerRule[], ownerRepo: string | null): Tracker | null {
	if (ownerRepo === null || !OWNER_REPO.test(ownerRepo)) return null;
	const want = ownerRepo.toLowerCase();
	for (const r of rules) {
		const m = r.match.toLowerCase();
		if (m.endsWith("/*") ? want.startsWith(m.slice(0, -1)) : want === m) return r.tracker;
	}
	return null;
}

/** The repo issue intake reads (§ 6): `issues.intakeRepo` when set, else the first GitHub rule naming one exact repo, else null. */
export function intakeRepo(c: Pick<IssuesConfig, "trackers" | "intakeRepo">): string | null {
	return c.intakeRepo ?? c.trackers.find((r) => r.tracker.kind === "github" && OWNER_REPO.test(r.match))?.match ?? null;
}

function trackerRule(x: unknown, i: number): TrackerRule | string {
	if (x === null || typeof x !== "object" || Array.isArray(x)) return `issues.trackers[${i}] is not a mapping`;
	const r = x as Record<string, unknown>;
	if (typeof r.match !== "string" || !(OWNER_REPO.test(r.match) || OWNER_GLOB.test(r.match))) return `issues.trackers[${i}].match is not an owner/repo or owner/*`;
	if (r.kind === "github") {
		if (r.team !== undefined) return `issues.trackers[${i}] is github and names a team`;
		return { match: r.match, tracker: { kind: "github" } };
	}
	if (r.kind === "linear") {
		if (typeof r.team !== "string" || !TEAM_KEY.test(r.team)) return `issues.trackers[${i}].team is not a Linear team key`;
		return { match: r.match, tracker: { kind: "linear", team: r.team.toUpperCase() } };
	}
	return `issues.trackers[${i}].kind is not github or linear`;
}

/**
 * The `issues:` block of a parsed profile config. No block (or `issues: null`) is `config: null`:
 * the projector serves nothing. A block that is present but malformed is an error, never a default.
 */
export function issuesConfig(doc: unknown): { ok: true; config: IssuesConfig | null } | { ok: false; error: string } {
	const block = doc !== null && typeof doc === "object" && "issues" in doc ? doc.issues : undefined;
	if (block === undefined || block === null) return { ok: true, config: null };
	if (typeof block !== "object" || Array.isArray(block)) return { ok: false, error: "issues is not a mapping" };
	// A non-null, non-array object from YAML: every key is read below as unknown and checked.
	const b = block as Record<string, unknown>;
	if (!Array.isArray(b.trackers)) return { ok: false, error: "issues.trackers is not a list" };
	const trackers: TrackerRule[] = [];
	for (const [i, x] of b.trackers.entries()) {
		const r = trackerRule(x, i);
		if (typeof r === "string") return { ok: false, error: r };
		trackers.push(r);
	}
	const overrides: Record<string, Tracker | null> = {};
	if (b.overrides !== undefined && b.overrides !== null) {
		if (typeof b.overrides !== "object" || Array.isArray(b.overrides)) return { ok: false, error: "issues.overrides is not a mapping" };
		for (const [id, v] of Object.entries(b.overrides as Record<string, unknown>)) {
			if (!WORKLOAD_ID.test(id)) return { ok: false, error: `issues.overrides: ${id} is not a workload id` };
			const t = typeof v === "string" ? parseTrackerKey(v) : undefined;
			if (t === undefined) return { ok: false, error: `issues.overrides.${id} is not github, linear:<TEAM> or none` };
			overrides[id] = t;
		}
	}
	if (typeof b.jo !== "string" || !LOGIN.test(b.jo)) return { ok: false, error: "issues.jo is not a GitHub login" };
	const out: IssuesConfig = { trackers, overrides, jo: b.jo, ...ISSUES_DEFAULTS };
	if (b.intakeRepo !== undefined) {
		if (typeof b.intakeRepo !== "string" || !OWNER_REPO.test(b.intakeRepo)) return { ok: false, error: "issues.intakeRepo is not an owner/repo" };
		out.intakeRepo = b.intakeRepo;
	}
	if (b.intakeSkipLabels !== undefined) {
		const labels = b.intakeSkipLabels;
		if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string" && l.trim() !== "")) return { ok: false, error: "issues.intakeSkipLabels is not a list of label names" };
		out.intakeSkipLabels = labels.map((l: string) => l.trim().toLowerCase());
	}
	for (const key of COUNT_KEYS) {
		const v = b[key];
		if (v === undefined) continue;
		if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) return { ok: false, error: `issues.${key} is not a positive integer` };
		out[key] = v;
	}
	return { ok: true, config: out };
}

/** The `issues:` block from the checkout's profile/config.yml (or `$AGENT_SYSTEM_ISSUES_CONFIG`). */
export function loadIssuesConfig(env: Record<string, string | undefined>): { ok: true; config: IssuesConfig | null } | { ok: false; error: string } {
	const path = env[ISSUES_CONFIG_ENV]?.trim() || join(REPO_ROOT, "profile", "config.yml");
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(readFileSync(path, "utf8"));
	} catch (err) {
		return { ok: false, error: `${path}: ${String(err instanceof Error ? err.message : err).split("\n")[0]}` };
	}
	const c = issuesConfig(doc);
	return c.ok ? c : { ok: false, error: `${path}: ${c.error}` };
}
