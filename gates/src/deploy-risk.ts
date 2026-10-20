// Routine deploys and their escalation conditions (PLAN wl-mvgorfqqbuyyo0 rev 9 § 2, § 3.1, § 3.4; SPEC-2.0.md § A4,
// amended 2026-10-20). This is the one module that knows the conditions: the condition table with each condition's
// outcome class and source ids (docs/deploy-risk.md), the profile `deploy:` policy reader with its canonical hash and
// its authentication against the newest `deploy-policy:` ledger row, the § 2.1 command shape, the facts a deploy is
// judged on (an injectable interface: `gh api`, the ledger, the clock, the gate's own HTTPS GET), every predicate of
// § 2.4, and the verdict hold > escalate > defer > routine with the condition instances of § 3.4 and their sha256.
//
// No condition runs a declared shell command. An unauthenticated policy is E0 and no fact beyond the policy is read
// (R15). A fact that cannot be read, a timeout, an incomplete page set or a capped compare is E0 (R6, R26).
// Row 6 (gates/src/rows/r06-reserved.ts) and `as2 deploy settle` (surface/scripts/deploy.ts) are its callers.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Ledger, Stakes } from "../../ledger/src/index";
import { installedConfigPath } from "../../surface/src/pair-suggest";
import { DEPLOY_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../../surface/src/types";
import { type Expansion, expandShell } from "./exec";

// ---- the condition table ------------------------------------------------------------------------

export type ConditionId =
	| "O1" | "U1" | "U2" | "U3"
	| "E0" | "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7" | "E8" | "E9" | "E10" | "E11" | "M1"
	| "D1"
	| "W1" | "W2" | "W3" | "W4";
/** § 2.3: hold (plain refusal, never approvable), escalate (NOW request), defer (waits for Jo's window), warn (never blocks). */
export type OutcomeClass = "hold" | "escalate" | "defer" | "warn";
/** The research table's source ids (PLAN § 1, docs/deploy-risk.md). */
export type SourceId =
	| "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8" | "S9"
	| "S10" | "S11" | "S12" | "S13" | "S14" | "S15" | "S16" | "S17" | "S18";

export interface Condition {
	id: ConditionId;
	outcome: OutcomeClass;
	/** Source ids of docs/deploy-risk.md; empty when no study backs it and `basis` says what does. */
	sources: readonly SourceId[];
	/** What backs a condition with no source id (Jo's word, as2 policy, a mechanism); null when sources do. */
	basis: string | null;
	/** One line: what holds. */
	summary: string;
}

/** Every condition, in the order a verdict names them. Ids and source ids are fixed by the plan (R12, R13). */
export const CONDITIONS: readonly Condition[] = [
	{ id: "O1", outcome: "hold", sources: [], basis: "Jo (in-mvgpe7k1np4xkw), no study", summary: "an earlier deploy.order target has merged work not deployed yet; deploy it first" },
	{ id: "U1", outcome: "hold", sources: ["S6"], basis: null, summary: "a deploy: row of the target has no deploy-settled: row; run as2 deploy settle first" },
	{ id: "U2", outcome: "hold", sources: ["S6"], basis: null, summary: "gh pr merge on a target's repo while a deploy of it is unsettled" },
	{ id: "U3", outcome: "hold", sources: ["S6"], basis: null, summary: "a merge of the repo started or finished while the facts were read; re-evaluate" },
	{ id: "E0", outcome: "escalate", sources: [], basis: "fail-closed rule", summary: "policy unauthenticated or malformed, workflow blob moved, a fact unreadable, or the compare capped" },
	{ id: "E1", outcome: "escalate", sources: [], basis: "as2 policy (SPEC § B4)", summary: "the workload's stakes are production" },
	{ id: "E2", outcome: "escalate", sources: ["S9", "S13", "S17"], basis: null, summary: "a required check is missing or not green, or a check or status at H is not green" },
	{ id: "E3", outcome: "escalate", sources: ["S3"], basis: null, summary: "the default branch moved while reading, an open PR has auto-merge, or a merge queue is on" },
	{ id: "E4", outcome: "escalate", sources: ["S5", "S7", "S11", "S14"], basis: null, summary: "B…H touches a migration or data-shape path" },
	{ id: "E5", outcome: "escalate", sources: ["S2", "S9", "S10", "S11", "S12"], basis: null, summary: "B…H touches an auth, payment, secret, infra or pipeline path" },
	{ id: "E6", outcome: "escalate", sources: ["S7", "S14", "S2"], basis: null, summary: "no release to return to: no B, no rollback text, or no successful run at B" },
	{ id: "E7", outcome: "escalate", sources: [], basis: "misuse guard", summary: "a workflow run of a declared target that is not byte-equal to its command" },
	{ id: "E8", outcome: "escalate", sources: ["S6"], basis: null, summary: "the target's newest settle failed with no later ok" },
	{ id: "E9", outcome: "escalate", sources: ["S8", "S4", "S2"], basis: null, summary: "B…H additions plus deletions exceed deploy.lines.escalate" },
	{ id: "E10", outcome: "escalate", sources: ["S6"], basis: null, summary: "the target's health probe fails before the deploy" },
	{ id: "E11", outcome: "escalate", sources: [], basis: "mechanism", summary: "an as2 merge of the repo is unresolved (no merge-done:, PR not merged into H)" },
	{ id: "M1", outcome: "escalate", sources: [], basis: "Jo (in-mvgpe7k1np4xkw), inferred", summary: "gh pr merge on a repo whose push to the default branch deploys" },
	{ id: "D1", outcome: "defer", sources: ["S6"], basis: null, summary: "now is outside deploy.window" },
	{ id: "W1", outcome: "warn", sources: ["S16"], basis: null, summary: "a package.json direct dependency changed major version" },
	{ id: "W2", outcome: "warn", sources: ["S9", "S13", "S17"], basis: null, summary: "a required check passed only on a re-run, or an optional one was skipped or neutral" },
	{ id: "W3", outcome: "warn", sources: ["S8", "S4", "S2"], basis: null, summary: "B…H additions plus deletions exceed deploy.lines.warn" },
	{ id: "W4", outcome: "warn", sources: ["S8"], basis: null, summary: "B…H touches more than deploy.dirs.warn top-level directories" },
];

export const CONDITION: Readonly<Record<ConditionId, Condition>> = Object.fromEntries(CONDITIONS.map((c) => [c.id, c])) as Record<ConditionId, Condition>;
const ORDER: Readonly<Record<string, number>> = Object.fromEntries(CONDITIONS.map((c, i) => [c.id, i]));

/** M1's code constant (§ 2.4): repos whose push to the default branch deploys. The policy can add to it, never remove. */
export const MERGE_TRIGGERED: readonly string[] = ["ContextPress/crawler"];

/** § 2.4 E4 and E5 default globs; a target's `migrations` / `sensitive` add to them. */
export const MIGRATION_GLOBS: readonly string[] = [
	"**/migrations/**", "**/migrate/**", "**/*.sql", "**/schema.prisma", "**/alembic/**", "supabase/**", "db/schema.*",
	"**/*.proto", "**/*.graphql", "**/schema.json",
];
export const SENSITIVE_GLOBS: readonly string[] = [
	"**/auth/**", "**/*auth*.*",
	"**/payment*/**", "**/billing/**", "**/*stripe*",
	"**/.env*", "**/secret*",
	".github/workflows/**", "**/Dockerfile*", "**/*.tf", "k8s/**", "helm/**", "charts/**", "infra/**", "deploy/**", "scripts/deploy*",
	"fly.toml", "vercel.json", "netlify.toml", "wrangler.toml", "app.yaml",
];

/** gh's limit per read (§ 2.4 E0) and the health probe's (E10). */
export const GH_TIMEOUT_MS = 20_000;
export const HEALTH_TIMEOUT_MS = 10_000;
/** GitHub lists at most 300 changed files for a whole comparison (§ 2.4 E0, R26). */
export const COMPARE_FILE_CAP = 300;

// ---- condition instances (§ 3.4) ----------------------------------------------------------------

/** One condition that holds, with the facts that made it hold, sorted. An id-only condition has no facts. */
export interface ConditionInstance {
	id: ConditionId;
	facts: string[];
}

/** JSON with every object's keys sorted, no whitespace; throws on a value JSON cannot carry exactly. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${value} has no JSON form`);
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) throw new Error(`a ${proto?.constructor?.name ?? "non-plain"} object has no JSON form`);
		const o = value as Record<string, unknown>;
		const keys = Object.keys(o).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
	}
	throw new Error(`a ${typeof value} has no JSON form`);
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The instances in canonical order: table order, then facts; facts sorted; duplicates dropped. */
export function canonicalInstances(instances: readonly ConditionInstance[]): ConditionInstance[] {
	const seen = new Map<string, ConditionInstance>();
	for (const i of instances) {
		const c = { id: i.id, facts: [...i.facts].sort() };
		seen.set(canonicalJson(c), c);
	}
	return [...seen.values()].sort((a, b) => ORDER[a.id]! - ORDER[b.id]! || (canonicalJson(a.facts) < canonicalJson(b.facts) ? -1 : 1));
}

/** sha256 of the canonical instance list (§ 3.4). */
export function instancesHash(instances: readonly ConditionInstance[]): string {
	return sha256Hex(canonicalJson(canonicalInstances(instances)));
}

/** § 3.4: every instance holding now is one the request named (an extra or replacement instance is a fresh evaluation). */
export function instancesCoveredBy(now: readonly ConditionInstance[], approved: readonly ConditionInstance[]): boolean {
	const named = new Set(canonicalInstances(approved).map((i) => canonicalJson(i)));
	return canonicalInstances(now).every((i) => named.has(canonicalJson(i)));
}

// ---- the policy (§ 3.1, § 2.1) ------------------------------------------------------------------

export interface RequiredCheck {
	/** Check-run name. */
	name: string;
	/** The producing app's `app.slug`. */
	app: string;
}
export interface DeployTarget {
	name: string;
	repo: string;
	/** The declared command, byte for byte (§ 2.1). */
	command: string;
	/** Parsed from `command`: the workflow file, the `--ref` (the default branch) and the fixed `-f` pairs. */
	file: string;
	ref: string;
	inputs: readonly (readonly [string, string])[];
	workflowBlob: string;
	deployJob: string;
	requiredChecks: readonly RequiredCheck[];
	/** Text Jo and the notice show; never run. Null when not declared (E6). */
	rollback: string | null;
	health: { url: string; status: number };
	migrations: readonly string[];
	sensitive: readonly string[];
}
/** Minutes since midnight, [start, end). */
export type Span = readonly [number, number];
export interface DeployWindow {
	tz: string;
	monThu: Span;
	fri: Span;
}
export interface DeployPolicy {
	window: DeployWindow;
	lines: { warn: number; escalate: number };
	dirs: { warn: number };
	/** Groups of target names; each group deploys before the next (O1). */
	order: readonly (readonly string[])[];
	mergeTriggered: readonly string[];
	targets: readonly DeployTarget[];
}

export const WINDOW_DEFAULT: DeployWindow = { tz: "America/Los_Angeles", monThu: [9 * 60, 16 * 60], fri: [9 * 60, 12 * 60] };
export const LINES_DEFAULT = { warn: 400, escalate: 1500 } as const;
export const DIRS_DEFAULT = { warn: 5 } as const;

export type PolicyParse = { ok: true; policy: DeployPolicy } | { ok: false; error: string };
export type CommandShape = { ok: true; file: string; ref: string; repo: string; inputs: [string, string][] } | { ok: false; error: string };

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN = /^[A-Za-z0-9._/@:+=-]+$/;

/**
 * § 2.1: the one declared command shape that can be routine, `gh workflow run <file> --ref <branch> -R <owner/repo>`
 * followed only by `-f key=value` pairs, single spaces, nothing a shell would read as more than literal words.
 */
export function parseDeployCommand(command: string): CommandShape {
	const bad = (why: string): CommandShape => ({ ok: false, error: `command ${JSON.stringify(command)} ${why}` });
	if (typeof command !== "string" || command.length === 0) return bad("is empty");
	const words = command.split(" ");
	if (words.some((w) => w === "")) return bad("is not single-space separated words with no leading or trailing space");
	if (!words.every((w) => TOKEN.test(w))) return bad("carries a character outside [A-Za-z0-9._/@:+=-]");
	if (words.length < 8 || words[0] !== "gh" || words[1] !== "workflow" || words[2] !== "run" || words[4] !== "--ref" || words[6] !== "-R") {
		return bad("is not `gh workflow run <file> --ref <default branch> -R <owner/repo>` [-f key=value]…");
	}
	const file = words[3]!;
	const ref = words[5]!;
	const repo = words[7]!;
	if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(file)) return bad(`names workflow ${file}, not a .yml or .yaml file name`);
	if (ref.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(ref)) return bad(`has --ref ${ref}, not a branch name`);
	if (!REPO.test(repo)) return bad(`has -R ${repo}, not owner/repo`);
	const inputs: [string, string][] = [];
	for (let i = 8; i < words.length; i += 2) {
		const pair = words[i + 1];
		if (words[i] !== "-f" || pair === undefined) return bad("goes on with something other than -f key=value pairs");
		const m = /^([A-Za-z_][A-Za-z0-9_-]*)=([A-Za-z0-9._/@:+-]*)$/.exec(pair);
		if (!m) return bad(`has -f ${pair}, not key=value`);
		if (inputs.some(([k]) => k === m[1])) return bad(`sets -f ${m[1]} twice`);
		inputs.push([m[1]!, m[2]!]);
	}
	return { ok: true, file, ref, repo, inputs };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(o: Obj, allowed: readonly string[], where: string, problems: string[]): void {
	for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`${where} has unknown key ${JSON.stringify(k)}`);
}
function posInt(v: unknown, where: string, problems: string[]): number {
	if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
	problems.push(`${where} is not a positive integer`);
	return 0;
}
function text(v: unknown, where: string, problems: string[]): string {
	if (typeof v === "string" && v.trim() !== "") return v;
	problems.push(`${where} is not a non-empty string`);
	return "";
}
function globs(v: unknown, where: string, problems: string[]): string[] {
	if (v === undefined || v === null) return [];
	if (Array.isArray(v) && v.every((g) => typeof g === "string" && g.trim() !== "")) return v as string[];
	problems.push(`${where} is not a list of glob strings`);
	return [];
}
function span(v: unknown, where: string, fallback: Span, problems: string[]): Span {
	if (v === undefined) return fallback;
	const m = typeof v === "string" ? /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]|24):([0-5]\d)$/.exec(v) : null;
	const s = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
	const e = m ? Number(m[3]) * 60 + Number(m[4]) : 0;
	if (!m || e > 24 * 60 || s >= e) {
		problems.push(`${where} is not "HH:MM-HH:MM" with start before end`);
		return fallback;
	}
	return [s, e];
}

/** The `deploy:` section (§ 3.1) as a policy, or every way it departs from the schema (each is E0). */
export function parsePolicy(section: unknown): PolicyParse {
	const problems: string[] = [];
	if (!isObj(section)) return { ok: false, error: "the deploy: section is not a mapping" };
	onlyKeys(section, ["window", "lines", "dirs", "order", "mergeTriggered", "targets"], "deploy", problems);

	let window = WINDOW_DEFAULT;
	if (section.window !== undefined) {
		if (!isObj(section.window)) problems.push("deploy.window is not a mapping");
		else {
			const w = section.window;
			onlyKeys(w, ["tz", "mon-thu", "fri"], "deploy.window", problems);
			let tz = WINDOW_DEFAULT.tz;
			if (w.tz !== undefined) {
				tz = text(w.tz, "deploy.window.tz", problems);
				try {
					new Intl.DateTimeFormat("en-US", { timeZone: tz });
				} catch {
					problems.push(`deploy.window.tz ${JSON.stringify(tz)} is not a time zone`);
				}
			}
			window = { tz, monThu: span(w["mon-thu"], "deploy.window.mon-thu", WINDOW_DEFAULT.monThu, problems), fri: span(w.fri, "deploy.window.fri", WINDOW_DEFAULT.fri, problems) };
		}
	}
	let lines: { warn: number; escalate: number } = { ...LINES_DEFAULT };
	if (section.lines !== undefined) {
		if (!isObj(section.lines)) problems.push("deploy.lines is not a mapping");
		else {
			onlyKeys(section.lines, ["warn", "escalate"], "deploy.lines", problems);
			lines = {
				warn: section.lines.warn === undefined ? LINES_DEFAULT.warn : posInt(section.lines.warn, "deploy.lines.warn", problems),
				escalate: section.lines.escalate === undefined ? LINES_DEFAULT.escalate : posInt(section.lines.escalate, "deploy.lines.escalate", problems),
			};
		}
	}
	let dirs: { warn: number } = { ...DIRS_DEFAULT };
	if (section.dirs !== undefined) {
		if (!isObj(section.dirs)) problems.push("deploy.dirs is not a mapping");
		else {
			onlyKeys(section.dirs, ["warn"], "deploy.dirs", problems);
			dirs = { warn: section.dirs.warn === undefined ? DIRS_DEFAULT.warn : posInt(section.dirs.warn, "deploy.dirs.warn", problems) };
		}
	}
	let mergeTriggered: string[] = [];
	if (section.mergeTriggered !== undefined && section.mergeTriggered !== null) {
		if (!Array.isArray(section.mergeTriggered) || !section.mergeTriggered.every((r) => typeof r === "string" && REPO.test(r))) {
			problems.push("deploy.mergeTriggered is not a list of owner/repo");
		} else mergeTriggered = section.mergeTriggered as string[];
	}

	const targets: DeployTarget[] = [];
	const rawTargets = section.targets ?? [];
	if (!Array.isArray(rawTargets)) problems.push("deploy.targets is not a list");
	else {
		rawTargets.forEach((t, i) => {
			const where = `deploy.targets[${i}]`;
			if (!isObj(t)) return void problems.push(`${where} is not a mapping`);
			onlyKeys(t, ["name", "repo", "command", "workflowBlob", "deployJob", "requiredChecks", "rollback", "health", "migrations", "sensitive"], where, problems);
			const name = text(t.name, `${where}.name`, problems);
			if (name && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) problems.push(`${where}.name ${JSON.stringify(name)} is not a word`);
			const repo = text(t.repo, `${where}.repo`, problems);
			if (repo && !REPO.test(repo)) problems.push(`${where}.repo ${JSON.stringify(repo)} is not owner/repo`);
			const command = typeof t.command === "string" ? t.command : "";
			const shape = parseDeployCommand(command);
			if (!shape.ok) problems.push(`${where}: ${shape.error}`);
			else if (shape.repo !== repo) problems.push(`${where}.command names -R ${shape.repo}, not the target's repo ${repo}`);
			const workflowBlob = typeof t.workflowBlob === "string" && /^[0-9a-f]{40}$/.test(t.workflowBlob) ? t.workflowBlob : "";
			if (!workflowBlob) problems.push(`${where}.workflowBlob is not a 40-hex git blob sha`);
			const deployJob = text(t.deployJob, `${where}.deployJob`, problems);
			const requiredChecks: RequiredCheck[] = [];
			if (t.requiredChecks !== undefined && t.requiredChecks !== null) {
				if (!Array.isArray(t.requiredChecks)) problems.push(`${where}.requiredChecks is not a list`);
				else {
					t.requiredChecks.forEach((c, j) => {
						const w = `${where}.requiredChecks[${j}]`;
						if (!isObj(c)) return void problems.push(`${w} is not {name, app}`);
						onlyKeys(c, ["name", "app"], w, problems);
						requiredChecks.push({ name: text(c.name, `${w}.name`, problems), app: text(c.app, `${w}.app`, problems) });
					});
				}
			}
			let rollback: string | null = null;
			if (t.rollback !== undefined && t.rollback !== null) {
				if (typeof t.rollback !== "string") problems.push(`${where}.rollback is not text`);
				else if (t.rollback.trim() !== "") rollback = t.rollback;
			}
			let health = { url: "", status: 0 };
			if (!isObj(t.health)) problems.push(`${where}.health is not {url, status}`);
			else {
				onlyKeys(t.health, ["url", "status"], `${where}.health`, problems);
				const url = text(t.health.url, `${where}.health.url`, problems);
				let https = false;
				try {
					https = new URL(url).protocol === "https:";
				} catch {}
				if (url && !https) problems.push(`${where}.health.url is not an https URL`);
				const status = t.health.status;
				if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) problems.push(`${where}.health.status is not an HTTP status`);
				health = { url, status: typeof status === "number" ? status : 0 };
			}
			targets.push({
				name, repo, command, file: shape.ok ? shape.file : "", ref: shape.ok ? shape.ref : "", inputs: shape.ok ? shape.inputs : [],
				workflowBlob, deployJob, requiredChecks, rollback, health,
				migrations: globs(t.migrations, `${where}.migrations`, problems), sensitive: globs(t.sensitive, `${where}.sensitive`, problems),
			});
		});
	}
	const names = targets.map((t) => t.name);
	for (const n of new Set(names)) if (names.filter((x) => x === n).length > 1) problems.push(`target name ${JSON.stringify(n)} is declared twice`);
	const commands = targets.map((t) => t.command);
	for (const c of new Set(commands)) if (c && commands.filter((x) => x === c).length > 1) problems.push(`command ${JSON.stringify(c)} is declared by two targets`);

	const order: string[][] = [];
	if (section.order !== undefined && section.order !== null) {
		if (!Array.isArray(section.order) || !section.order.every((g) => Array.isArray(g) && g.every((n) => typeof n === "string"))) {
			problems.push("deploy.order is not a list of lists of target names");
		} else {
			const seen = new Set<string>();
			for (const g of section.order as string[][]) {
				for (const n of g) {
					if (!names.includes(n)) problems.push(`deploy.order names ${JSON.stringify(n)}, which is not a target`);
					if (seen.has(n)) problems.push(`deploy.order names ${JSON.stringify(n)} twice`);
					seen.add(n);
				}
				order.push([...g]);
			}
		}
	}
	if (lines.warn > lines.escalate) problems.push("deploy.lines.warn is above deploy.lines.escalate");
	if (problems.length > 0) return { ok: false, error: problems.join("; ") };
	return { ok: true, policy: { window, lines, dirs, order, mergeTriggered, targets } };
}

/** The canonical hash Jo accepts with `deploy-policy <sha12>`: sha256 of the section's canonical JSON. */
export function policyHash(section: unknown): string {
	return sha256Hex(canonicalJson(section));
}

/** The profile config text, read: its `deploy:` section, that section's hash, and the section parsed. */
export type PolicyRead = { ok: true; section: unknown; hash: string; parsed: PolicyParse } | { ok: false; error: string };

export function readPolicySection(configText: string | null): PolicyRead {
	if (configText === null) return { ok: false, error: "the profile config could not be read" };
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(configText);
	} catch (err) {
		return { ok: false, error: `the profile config does not parse (${String(err instanceof Error ? err.message : err).split("\n")[0]})` };
	}
	if (!isObj(doc) || !("deploy" in doc) || doc.deploy === null || doc.deploy === undefined) return { ok: false, error: "the profile config has no deploy: section" };
	let hash: string;
	try {
		hash = policyHash(doc.deploy);
	} catch (err) {
		return { ok: false, error: `the deploy: section has no canonical JSON (${err instanceof Error ? err.message : String(err)})` };
	}
	return { ok: true, section: doc.deploy, hash, parsed: parsePolicy(doc.deploy) };
}

/** A `deploy-policy:` row's body: `sha256 <hex> <instruction id>` or `off <instruction id>`. */
export type PolicyAcceptance = { kind: "sha256"; hex: string; instruction: string } | { kind: "off"; instruction: string };

export function parsePolicyRow(body: string): PolicyAcceptance | null {
	const m = /^deploy-policy: (?:sha256 ([0-9a-f]{64})|(off)) (in-\S+)$/.exec(body.trim());
	if (!m) return null;
	return m[2] === "off" ? { kind: "off", instruction: m[3]! } : { kind: "sha256", hex: m[1]!, instruction: m[3]! };
}

/** The newest `deploy-policy:` row Jo's surface wrote on the standing workload, or null. Only it counts (§ 3.1). */
export function newestPolicyRow(ledger: LedgerFacts): LedgerRow | null {
	const rows = ledger.rows("deploy-policy").filter((r) => r.workloadId === STANDING_WORKLOAD_ID && r.createdBy === SURFACE_BY);
	return rows.at(-1) ?? null;
}

/**
 * § 3.1: the section is authenticated when the newest `deploy-policy:` row is a sha256 equal to the section's hash
 * now. `policy` is the parsed section whether or not it is authenticated (a caller may match a call against it, never
 * admit one); `problem` says why the policy cannot make a call routine, null when it can.
 */
export interface PolicyAuth {
	authenticated: boolean;
	hash: string | null;
	policy: DeployPolicy | null;
	problem: string | null;
}

export function authenticatePolicy(read: PolicyRead, newest: LedgerRow | null): PolicyAuth {
	const policy = read.ok && read.parsed.ok ? read.parsed.policy : null;
	const hash = read.ok ? read.hash : null;
	const accepted = newest === null ? null : parsePolicyRow(newest.body);
	let why: string | null = null;
	if (!read.ok) why = read.error;
	else if (newest === null) why = "no deploy-policy: row accepts it";
	else if (accepted === null) why = `the newest deploy-policy: row ${newest.id} does not parse`;
	else if (accepted.kind === "off") why = `the newest deploy-policy: row ${newest.id} is off`;
	else if (accepted.hex !== read.hash) why = `the section's hash ${read.hash.slice(0, 12)} is not the newest accepted ${accepted.hex.slice(0, 12)} (${newest.id})`;
	if (why !== null) return { authenticated: false, hash, policy, problem: `policy not authenticated: ${why}` };
	const parsed = (read as Extract<PolicyRead, { ok: true }>).parsed;
	return { authenticated: true, hash, policy, problem: parsed.ok ? null : `policy shape: ${parsed.error}` };
}


// Shared lifecycle wire format. Only DEPLOY_BY writes these rows; all readers use these parsers.
export interface DeployRecord {
	id: string;
	target: string;
	sha: string;
	base: string | null;
	checks: number;
	warnings: ConditionInstance[];
	approved?: string;
}
export function formatDeployRow(r: DeployRecord): string {
	return `deploy: ${r.id} target ${r.target} sha ${r.sha} base ${r.base ?? "none"} checks ${r.checks} warn ${r.warnings.length ? canonicalJson(canonicalInstances(r.warnings)) : "none"}${r.approved ? ` approved ${r.approved}` : ""}`;
}
export function parseDeployRow(body: string): DeployRecord | null {
	const m = /^deploy: (dp-\S+) target (\S+) sha (\S+) base (\S+) checks (\d+) warn (none|\[[^\n]*\])(?: approved (\S+))?$/.exec(body);
	if (!m) return null;
	try {
		const warnings: unknown = m[6] === "none" ? [] : JSON.parse(m[6]!);
		if (!Array.isArray(warnings) || warnings.some((w) => !isObj(w) || !["W1", "W2", "W3", "W4"].includes(String(w.id)) || !Array.isArray(w.facts) || w.facts.some((f: unknown) => typeof f !== "string"))) return null;
		return { id: m[1]!, target: m[2]!, sha: m[3]!, base: m[4] === "none" ? null : m[4]!, checks: Number(m[5]), warnings: warnings as ConditionInstance[], ...(m[7] ? { approved: m[7] } : {}) };
	} catch { return null; }
}
export interface DeployRunRecord { id: string; runId?: string; url?: string; exit?: number }
export function formatDeployRunRow(r: DeployRunRecord): string {
	return `deploy-run: ${r.id} ${r.runId ? `${r.runId}${r.url ? ` url ${r.url}` : ""}` : `exit ${r.exit}`}`;
}
export function parseDeployRunRow(body: string): DeployRunRecord | null {
	const m = /^deploy-run: (dp-\S+) (?:(\d+)(?: url (https:\/\/github\.com\/\S+\/actions\/runs\/\d+))?|exit (-?\d+))$/.exec(body);
	return m ? { id: m[1]!, ...(m[2] ? { runId: m[2], ...(m[3] ? { url: m[3] } : {}) } : { exit: Number(m[4]) }) } : null;
}
export interface DeploySettledRecord { id: string; outcome: "ok" | "failed"; evidence: string }
export function formatDeploySettledRow(r: DeploySettledRecord): string {
	return `deploy-settled: ${r.id} ${r.outcome} ${r.evidence}`;
}
export function parseDeploySettledRow(body: string): DeploySettledRecord | null {
	const m = /^deploy-settled: (dp-\S+) (ok|failed)(?: ([\s\S]*))?$/.exec(body);
	return m ? { id: m[1]!, outcome: m[2] as "ok" | "failed", evidence: m[3] ?? "" } : null;
}
export interface MergeInflightRecord { token: string; repo: string; pr: number }
export function formatMergeInflightRow(r: MergeInflightRecord): string {
	return `merge-inflight: ${r.token} ${r.repo} pr ${r.pr}`;
}
export function parseMergeInflightRow(body: string): MergeInflightRecord | null {
	const m = /^merge-inflight: (\S+) ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) pr ([1-9]\d*)$/.exec(body);
	return m ? { token: m[1]!, repo: m[2]!, pr: Number(m[3]) } : null;
}
export interface MergeDoneRecord { token: string; exit: number }
export function formatMergeDoneRow(r: MergeDoneRecord): string {
	return `merge-done: ${r.token} exit ${r.exit}`;
}
export function parseMergeDoneRow(body: string): MergeDoneRecord | null {
	const m = /^merge-done: (\S+) exit (-?\d+)$/.exec(body);
	return m ? { token: m[1]!, exit: Number(m[2]) } : null;
}

export interface DeployMergeRecord { requestId: string; pr: number; head: string }
export function formatDeployMergeRow(r: DeployMergeRecord): string {
	return `deploy-merge: ${r.requestId} pr ${r.pr} head ${r.head}`;
}
export function parseDeployMergeRow(body: string): DeployMergeRecord | null {
	const m = /^deploy-merge: (en-\S+) pr ([1-9]\d*) head ([0-9a-f]{40})$/.exec(body);
	return m ? { requestId: m[1]!, pr: Number(m[2]), head: m[3]! } : null;
}
// ---- the facts (injectable) ---------------------------------------------------------------------

/** One `gh api` read: a REST path (with its query string), every page when `paginate`, or a GraphQL query. */
export type GhRequest =
	| { kind: "rest"; path: string; paginate: boolean }
	| { kind: "graphql"; query: string; vars: Record<string, string> };
/** A paginated read's `json` is the array of pages (`--paginate --slurp`). `notFound`: GitHub answered 404. */
export type GhResult = { ok: true; json: unknown } | { ok: false; error: string; notFound: boolean };
export type HealthResult = { ok: true; status: number } | { ok: false; error: string };

/** One lane-written `assumption` entry whose body opens with a deploy prefix, with its ledger rowid. */
export interface LedgerRow {
	rowid: number;
	id: string;
	workloadId: string;
	body: string;
	createdBy: string;
	createdAt: string;
}
export type DeployPrefix = "deploy" | "deploy-run" | "deploy-settled" | "deploy-merge" | "merge-inflight" | "merge-done" | "deploy-policy";
export interface LedgerFacts {
	/** M: the newest entry's rowid (0 for none). */
	mark(): number;
	/** Every entry whose body opens with `<prefix>: `, on any workload, in rowid order. */
	rows(prefix: DeployPrefix): LedgerRow[];
	/** A workload's stakes, or null when there is no such workload. */
	stakes(workloadId: string): Stakes | null;
}
export interface DeployFacts {
	/** The installed profile's config.yml text, or null when it cannot be read. */
	config(): string | null;
	gh(req: GhRequest): Promise<GhResult>;
	ledger: LedgerFacts;
	now(): Date;
	/** The gate's own HTTPS GET: no shell, redirects not followed, HEALTH_TIMEOUT_MS. */
	httpsGet(url: string): Promise<HealthResult>;
}

/** The ledger facts read from the ledger module's file (entries table, rowid order). */
export function ledgerFacts(ledger: Pick<Ledger, "db" | "workload">): LedgerFacts {
	return {
		mark: () => ledger.db.query<{ m: number }, []>("SELECT coalesce(max(rowid), 0) AS m FROM entries").get()!.m,
		rows: (prefix) =>
			ledger.db
				.query<{ rowid: number; id: string; workload_id: string; body: string; created_by: string; created_at: string }, [string, string, string, string]>(
					"SELECT rowid, id, workload_id, body, created_by, created_at FROM entries WHERE kind = 'assumption' AND body GLOB ? AND created_by = ? AND (? = '' OR workload_id = ?) ORDER BY rowid",
				)
				.all(`${prefix}: *`, prefix === "deploy-policy" ? SURFACE_BY : DEPLOY_BY, prefix === "deploy-policy" ? STANDING_WORKLOAD_ID : "", prefix === "deploy-policy" ? STANDING_WORKLOAD_ID : "")
				.map((r) => ({ rowid: r.rowid, id: r.id, workloadId: r.workload_id, body: r.body, createdBy: r.created_by, createdAt: r.created_at })),
		stakes: (id) => ledger.workload(id)?.stakes ?? null,
	};
}

/** `gh api` through the gh CLI: `--paginate --slurp` for every page, killed after `timeoutMs`. */
export function ghCli(opts: { bin?: string; timeoutMs?: number; env?: Record<string, string | undefined> } = {}): (req: GhRequest) => Promise<GhResult> {
	const bin = opts.bin ?? "gh";
	const timeoutMs = opts.timeoutMs ?? GH_TIMEOUT_MS;
	return async (req) => {
		const args =
			req.kind === "rest"
				? ["api", ...(req.paginate ? ["--paginate", "--slurp"] : []), "-H", "Accept: application/vnd.github+json", req.path]
				: ["api", "graphql", "-f", `query=${req.query}`, ...Object.entries(req.vars).flatMap(([k, v]) => ["-f", `${k}=${v}`])];
		const label = req.kind === "rest" ? req.path : "graphql";
		let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			proc = Bun.spawn([bin, ...args], {
				stdin: "ignore", stdout: "pipe", stderr: "pipe",
				env: { ...(opts.env ?? process.env), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
			});
		} catch (err) {
			return { ok: false, error: `gh api ${label} could not start (${err instanceof Error ? err.message : String(err)})`, notFound: false };
		}
		const out = new Response(proc.stdout as ReadableStream).text();
		const errText = new Response(proc.stderr as ReadableStream).text();
		let timer: Timer | undefined;
		const code = await Promise.race([proc.exited, new Promise<null>((r) => { timer = setTimeout(() => r(null), timeoutMs); })]);
		clearTimeout(timer);
		if (code === null) {
			proc.kill("SIGKILL");
			return { ok: false, error: `gh api ${label} gave no answer in ${timeoutMs} ms`, notFound: false };
		}
		const stderr = await errText;
		if (code !== 0) return { ok: false, error: `gh api ${label} exited ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`, notFound: /\(HTTP 404\)/.test(stderr) };
		try {
			return { ok: true, json: JSON.parse(await out) };
		} catch {
			return { ok: false, error: `gh api ${label} printed no JSON`, notFound: false };
		}
	};
}

/** The health probe's HTTPS GET (§ 2.4 E10): fetch, redirects not followed, `timeoutMs`. */
export async function httpsGet(url: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<HealthResult> {
	if (!url.startsWith("https://")) return { ok: false, error: `${url} is not https` };
	try {
		const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
		void res.body?.cancel();
		return { ok: true, status: res.status };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** The real facts: the installed profile, the gh CLI, this ledger, the system clock and fetch. */
export function defaultFacts(ledger: Pick<Ledger, "db" | "workload">, env: Record<string, string | undefined> = process.env): DeployFacts {
	return {
		config: () => {
			try {
				return readFileSync(installedConfigPath(env), "utf8");
			} catch {
				return null;
			}
		},
		gh: ghCli({ env }),
		ledger: ledgerFacts(ledger),
		now: () => new Date(),
		httpsGet: (url) => httpsGet(url),
	};
}

/** The policy as the facts give it, authenticated against the ledger. Reads only the config and the deploy-policy: rows. */
export function policyAuth(facts: Pick<DeployFacts, "config" | "ledger">): PolicyAuth {
	const read = readPolicySection(facts.config());
	let newest: LedgerRow | null;
	try {
		newest = newestPolicyRow(facts.ledger);
	} catch (err) {
		return { authenticated: false, hash: read.ok ? read.hash : null, policy: read.ok && read.parsed.ok ? read.parsed.policy : null, problem: `policy not authenticated: the ledger could not be read (${err instanceof Error ? err.message : String(err)})` };
	}
	return authenticatePolicy(read, newest);
}

// ---- matching a call to a target (§ 2.1, E7) ----------------------------------------------------

export type CallMatch =
	| { kind: "exact"; target: DeployTarget }
	| { kind: "near"; target: DeployTarget; differing: string[] }
	| null;

export interface BashCall {
	/** The raw `command` of the bash tool input. */
	command: string;
	/** The bash tool input's `env`, if any. */
	toolEnv?: unknown;
	cwd: string;
	env: Record<string, string | undefined>;
}

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const envKeys = (toolEnv: unknown): string[] => (toolEnv && typeof toolEnv === "object" ? Object.keys(toolEnv as object) : []);

/** E7's differing words: `+w` in the call and not the declaration, `-w` the reverse (multiset), `+env <KEY>` per env key. */
function differingWords(call: BashCall, target: DeployTarget): string[] {
	const have = call.command.trim().split(/\s+/).filter(Boolean);
	const want = target.command.split(" ");
	const out: string[] = [];
	const left = [...want];
	for (const w of have) {
		const i = left.indexOf(w);
		if (i >= 0) left.splice(i, 1);
		else out.push(`+${w}`);
	}
	for (const w of left) out.push(`-${w}`);
	for (const k of envKeys(call.toolEnv)) out.push(`+env ${k}`);
	if (call.toolEnv !== undefined && envKeys(call.toolEnv).length === 0) out.push("+env present");
	if (out.length === 0) out.push("~spacing-or-order");
	return out.sort();
}

/**
 * Which declared target a bash call is (§ 2.1): `exact` when its raw command, trimmed, equals the target's command byte
 * for byte and the tool input carries no env; `near` (E7) when some `gh workflow run` in it names a target's file and
 * repo without being exact. An unresolved repo retains the original workflow reservation, never a guessed target.
 */
export function matchCall(call: BashCall, policy: DeployPolicy): CallMatch {
	const trimmed = call.command.trim();
	const exact = policy.targets.find((t) => t.command === trimmed);
	if (exact && call.toolEnv === undefined) return { kind: "exact", target: exact };
	if (exact) return { kind: "near", target: exact, differing: differingWords(call, exact) };
	let x: Expansion;
	try {
		x = expandShell(call.command, call.cwd, call.env, call.toolEnv);
	} catch {
		return null;
	}
	const toolRepo = isObj(call.toolEnv) ? call.toolEnv.GH_REPO : undefined;
	const assigned = x.assigned.has("GH_REPO") ? (/^GH_REPO=(.*)$/s.exec(x.assigned.get("GH_REPO")!.at(-1)?.text ?? "")?.[1] ?? null) : undefined;
	const envRepo = assigned !== undefined ? assigned : (typeof toolRepo === "string" ? toolRepo : null) ?? call.env.GH_REPO ?? null;
	for (const e of x.commands) {
		const a = e.argv.map((w) => w.text);
		if (a[0] !== "gh" || a[1] !== "workflow" || a[2] !== "run") continue;
		let file: string | null = null;
		let repo: string | null = null;
		for (let i = 3; i < a.length; i++) {
			const w = a[i]!;
			if (w === "-R" || w === "--repo") repo = a[++i] ?? null;
			else if (w.startsWith("--repo=")) repo = w.slice("--repo=".length);
			else if (/^-R./.test(w)) repo = w.slice(2);
			else if (["-r", "--ref", "-f", "--raw-field", "-F", "--field"].includes(w)) i++;
			else if (w.startsWith("-")) continue;
			else if (file === null) file = w;
		}
		repo ??= envRepo;
		if (file === null) continue;
		const base = file.split("/").at(-1)!;
		const target = repo === null ? undefined : policy.targets.find((t) => t.file === base && sameRepo(t.repo, repo));
		if (target) return { kind: "near", target, differing: differingWords(call, target) };
	}
	return null;
}

// ---- the evaluation -----------------------------------------------------------------------------

export type Outcome = "hold" | "escalate" | "defer" | "routine";

export interface Verdict {
	/** § 2.3 precedence: hold > escalate > defer > routine; warnings never block (R4). */
	outcome: Outcome;
	target: string | null;
	repo: string | null;
	/** Whether the policy was authenticated (E0 is approvable only when it was, § 3.4). */
	authenticated: boolean;
	/** H: the default-branch head at evaluation; null when unread. */
	head: string | null;
	/** B: the H of the target's newest settled-ok deploy; null for none. */
	base: string | null;
	/** M: the ledger mark read before H; null when unread (U3 at admission is checked above it). */
	mark: number | null;
	/** Latest check-runs plus commit statuses read at H (the `deploy:` row's `checks <n>`). */
	checks: number;
	/** Every hold, escalate and defer instance that holds, canonical order. */
	conditions: ConditionInstance[];
	/** Every warning instance that holds, canonical order. */
	warnings: ConditionInstance[];
	/** The distinct ids of `conditions`, table order. */
	ids: ConditionId[];
	/** sha256 of `conditions` (§ 3.4). */
	sha256: string;
	/** Human detail for E0 and the like (error text); never hashed. */
	notes: string[];
}

export type DeployEvaluation = { kind: "not-target" } | ({ kind: "verdict" } & Verdict);

class FactError extends Error {
	constructor(readonly fact: string, readonly detail: string) {
		super(`${fact}: ${detail}`);
	}
}

/** Strict JSON field access: a missing or mistyped field is an unreadable fact (E0). */
function field(v: unknown, key: string, fact: string): unknown {
	if (!isObj(v) || !(key in v)) throw new FactError(fact, `no ${key} field`);
	return v[key];
}
function fstr(v: unknown, key: string, fact: string): string {
	const x = field(v, key, fact);
	if (typeof x !== "string") throw new FactError(fact, `${key} is not a string`);
	return x;
}
function fnum(v: unknown, key: string, fact: string): number {
	const x = field(v, key, fact);
	if (typeof x !== "number") throw new FactError(fact, `${key} is not a number`);
	return x;
}
function farr(v: unknown, key: string, fact: string): unknown[] {
	const x = field(v, key, fact);
	if (!Array.isArray(x)) throw new FactError(fact, `${key} is not a list`);
	return x;
}
function sha(v: string, fact: string): string {
	if (!/^[0-9a-f]{40}$/.test(v)) throw new FactError(fact, `${JSON.stringify(v)} is not a commit sha`);
	return v;
}
function pages(json: unknown, fact: string): unknown[] {
	if (!Array.isArray(json) || json.length === 0) throw new FactError(fact, "no pages");
	return json;
}

interface DeployRow { id: string; rowid: number; target: string; sha: string }
interface SettleRow { dp: string; rowid: number; ok: boolean }
interface InflightRow { token: string; repo: string; pr: number; rowid: number }

function deployRows(ledger: LedgerFacts): DeployRow[] {
	return ledger.rows("deploy").map((r) => {
		const d = parseDeployRow(r.body);
		if (!d) throw new FactError(`ledger deploy row ${r.id}`, "does not parse");
		return { id: d.id, rowid: r.rowid, target: d.target, sha: d.sha };
	});
}
function settleRows(ledger: LedgerFacts): SettleRow[] {
	return ledger.rows("deploy-settled").map((r) => {
		const s = parseDeploySettledRow(r.body);
		if (!s) throw new FactError(`ledger deploy-settled row ${r.id}`, "does not parse");
		return { dp: s.id, rowid: r.rowid, ok: s.outcome === "ok" };
	});
}
function inflightRows(ledger: LedgerFacts): InflightRow[] {
	return ledger.rows("merge-inflight").map((r) => {
		const m = parseMergeInflightRow(r.body);
		if (!m) throw new FactError(`ledger merge-inflight row ${r.id}`, "does not parse");
		return { ...m, rowid: r.rowid };
	});
}
function doneRows(ledger: LedgerFacts): { token: string; rowid: number }[] {
	return ledger.rows("merge-done").map((r) => {
		const m = parseMergeDoneRow(r.body);
		if (!m) throw new FactError(`ledger merge-done row ${r.id}`, "does not parse");
		return { token: m.token, rowid: r.rowid };
	});
}

/** A target's deploy history from the ledger: unsettled deploy ids (U1), newest settle failed (E8), B. */
export interface TargetHistory {
	unsettled: string[];
	newestFailed: boolean;
	base: string | null;
}

export function targetHistory(ledger: LedgerFacts, target: string): TargetHistory {
	const deploys = deployRows(ledger).filter((d) => d.target === target);
	const byId = new Map(deploys.map((d) => [d.id, d]));
	const settles = settleRows(ledger).filter((s) => byId.has(s.dp));
	const settled = new Set(settles.map((s) => s.dp));
	const newest = settles.at(-1);
	const ok = settles.filter((s) => s.ok).at(-1);
	return {
		unsettled: deploys.filter((d) => !settled.has(d.id)).map((d) => d.id),
		newestFailed: newest !== undefined && !newest.ok,
		base: ok === undefined ? null : byId.get(ok.dp)!.sha,
	};
}

/**
 * U3 (§ 2.2 (a)): the merge lifecycle rows of `repo` written after `mark`. A `merge-done:` counts when its token's
 * `merge-inflight:` names the repo or cannot be found. Row 6 calls this again inside its admission transaction.
 */
export function mergesSince(ledger: LedgerFacts, repo: string, mark: number): ConditionInstance[] {
	const inflight = inflightRows(ledger);
	const out: ConditionInstance[] = [];
	for (const r of inflight) if (r.rowid > mark && sameRepo(r.repo, repo)) out.push({ id: "U3", facts: [`merge-inflight ${r.token}`] });
	for (const d of doneRows(ledger)) {
		if (d.rowid <= mark) continue;
		const of = inflight.find((r) => r.token === d.token);
		if (of === undefined || sameRepo(of.repo, repo)) out.push({ id: "U3", facts: [`merge-done ${d.token}`] });
	}
	return out;
}

/** Is `now` inside the window (§ 2.4 D1)? Mon–Thu and Fri spans in the window's time zone; no weekend. */
export function insideWindow(w: DeployWindow, now: Date): boolean {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: w.tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
	const part = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
	const minutes = Number(part("hour")) * 60 + Number(part("minute"));
	const day = part("weekday");
	const s = ["Mon", "Tue", "Wed", "Thu"].includes(day) ? w.monThu : day === "Fri" ? w.fri : null;
	return s !== null && minutes >= s[0] && minutes < s[1];
}

/** The major version a dependency spec names (`^1.2.3` → 1), or null for a spec with none (a URL, `workspace:*`, `latest`). */
function major(spec: unknown): number | null {
	if (typeof spec !== "string") return null;
	const m = /^\s*(?:[\^~]|[<>]=?|=)?\s*v?(\d+)(?:\.|$|\s|-)/.exec(spec);
	return m ? Number(m[1]) : null;
}
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

const BAD_CONCLUSIONS: Record<string, true> = { failure: true, cancelled: true, timed_out: true, action_required: true, stale: true };

/** One evaluation's accumulator: each condition instance, and E0 for a fact that could not be read. */
class Tally {
	readonly instances: ConditionInstance[] = [];
	readonly notes: string[] = [];
	add(id: ConditionId, ...facts: string[]): void {
		this.instances.push({ id, facts });
	}
	/** Run a fact read; any failure is E0 naming the fact (its detail goes to the notes, never the hash). */
	async fact<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
		try {
			return await fn();
		} catch (err) {
			const fact = err instanceof FactError ? err.fact : name;
			const detail = err instanceof FactError ? err.detail : err instanceof Error ? err.message : String(err);
			this.add("E0", `read ${fact}`);
			this.notes.push(`E0 read ${fact}: ${detail}`);
			return undefined;
		}
	}
}

function verdictOf(t: Tally, base: Omit<Verdict, "outcome" | "conditions" | "warnings" | "ids" | "sha256" | "notes">): Verdict {
	const all = canonicalInstances(t.instances);
	const conditions = all.filter((i) => CONDITION[i.id].outcome !== "warn");
	const warnings = all.filter((i) => CONDITION[i.id].outcome === "warn");
	const has = (o: OutcomeClass): boolean => conditions.some((i) => CONDITION[i.id].outcome === o);
	const outcome: Outcome = has("hold") ? "hold" : has("escalate") ? "escalate" : has("defer") ? "defer" : "routine";
	const ids = [...new Set(conditions.map((i) => i.id))];
	return { ...base, outcome, conditions, warnings, ids, sha256: instancesHash(conditions), notes: [...t.notes] };
}

/** The input of a deploy evaluation: the bash call and the workload of the lane making it. */
export interface DeployCall extends BashCall {
	workloadId: string;
}

/**
 * Evaluate a deploy call (§ 2.3, § 2.4). First identify a target of a parsed policy; no parsed target leaves the
 * original workflow reservation in charge (R5 takes precedence over R6). For an identifiable target, failed policy
 * authentication is E0 with no other fact read (R15). Otherwise every predicate names every condition that holds.
 */
export async function evaluateDeploy(call: DeployCall, facts: DeployFacts, shipped?: { sha: string; deployId: string }): Promise<DeployEvaluation> {
	const auth = policyAuth(facts);
	const match = auth.policy === null ? null : matchCall(call, auth.policy);
	if (match === null) return { kind: "not-target" };
	const t = new Tally();
	const empty = { target: match?.target.name ?? null, repo: match?.target.repo ?? null, authenticated: auth.authenticated, head: null, base: null, mark: null, checks: 0 };
	if (!auth.authenticated || auth.policy === null || match === null) {
		t.add("E0", auth.authenticated ? "policy shape" : "policy not authenticated");
		t.notes.push(`E0 ${auth.problem ?? "no policy"}`);
		return { kind: "verdict", ...verdictOf(t, empty) };
	}
	const policy = auth.policy;
	const target = match.target;
	const repo = target.repo;
	if (match.kind === "near") t.add("E7", ...match.differing);

	const mark = await t.fact("ledger mark", () => facts.ledger.mark());
	const stakes = await t.fact("workload stakes", () => facts.ledger.stakes(call.workloadId));
	if (stakes === "production") t.add("E1");
	const history = await t.fact("ledger deploy rows", () => targetHistory(facts.ledger, target.name));
	if (history) {
		for (const dp of history.unsettled) if (dp !== shipped?.deployId) t.add("U1", `deploy ${dp}`);
		if (history.newestFailed) t.add("E8");
	}
	const base = history?.base ?? null;

	const read = async (fact: string, req: GhRequest, allowMissing = false): Promise<unknown | null> => {
		const r = await facts.gh(req);
		if (r.ok) return r.json;
		if (allowMissing && r.notFound) return null;
		throw new FactError(fact, r.error);
	};
	const rest = (path: string, paginate = false): GhRequest => ({ kind: "rest", path, paginate });
	const headOf = async (r: string, ref: string, fact: string): Promise<string> => sha(fstr(await read(fact, rest(`repos/${r}/commits/${encodeURIComponent(ref)}`)), "sha", fact), fact);

	await t.fact("default branch", async () => {
		const b = fstr(await read("default branch", rest(`repos/${repo}`)), "default_branch", "default branch");
		if (b !== target.ref) {
			t.add("E0", "default branch is not --ref");
			t.notes.push(`E0 ${repo}'s default branch is ${b}, the declared --ref is ${target.ref}`);
		}
	});
	const head = shipped ? sha(shipped.sha, "shipped head") : (await t.fact("head", () => headOf(repo, target.ref, "head"))) ?? null;

	if (head !== null) {
		await t.fact("workflow blob", async () => {
			const blob = fstr(await read("workflow blob", rest(`repos/${repo}/contents/.github/workflows/${target.file}?ref=${head}`)), "sha", "workflow blob");
			if (blob !== target.workflowBlob) {
				t.add("E0", "workflow blob");
				t.notes.push(`E0 .github/workflows/${target.file} at ${head} is blob ${blob}, the accepted one is ${target.workflowBlob}`);
			}
		});
	}

	// O1: every target of an earlier order group has its default-branch head deployed.
	const group = policy.order.findIndex((g) => g.includes(target.name));
	for (const name of group > 0 ? policy.order.slice(0, group).flat() : []) {
		const p = policy.targets.find((x) => x.name === name)!;
		await t.fact(`predecessor ${name}`, async () => {
			const pHead = await headOf(p.repo, p.ref, `head of ${name}`);
			const pBase = targetHistory(facts.ledger, name).base;
			if (pHead !== pBase) t.add("O1", `target ${name}`);
		});
	}

	let checks = 0;
	if (head !== null) {
		await t.fact("check-runs", async () => {
			const ps = pages(await read("check-runs", rest(`repos/${repo}/commits/${head}/check-runs?filter=all&per_page=100`, true)), "check-runs");
			const runs = ps.flatMap((p) => farr(p, "check_runs", "check-runs"));
			const total = fnum(ps[0], "total_count", "check-runs");
			if (runs.length < total) throw new FactError("check-runs", `${runs.length} of ${total} listed (incomplete pagination)`);
			const groups = new Map<string, { name: string; app: string; runs: { id: number; status: string; conclusion: string | null }[] }>();
			for (const r of runs) {
				const name = fstr(r, "name", "check-runs");
				const app = fstr(field(r, "app", "check-runs"), "slug", "check-runs");
				const conclusion = field(r, "conclusion", "check-runs");
				if (conclusion !== null && typeof conclusion !== "string") throw new FactError("check-runs", "conclusion is not a string or null");
				const key = `${name}\0${app}`;
				const g = groups.get(key) ?? { name, app, runs: [] };
				g.runs.push({ id: fnum(r, "id", "check-runs"), status: fstr(r, "status", "check-runs"), conclusion: conclusion as string | null });
				groups.set(key, g);
			}
			for (const c of target.requiredChecks) {
				if (!groups.has(`${c.name}\0${c.app}`)) t.add("E2", `check ${c.name} app ${c.app} missing`);
			}
			for (const g of groups.values()) {
				g.runs.sort((a, b) => a.id - b.id);
				const latest = g.runs.at(-1)!;
				checks++;
				const label = `check ${g.name} app ${g.app}`;
				const required = target.requiredChecks.some((c) => c.name === g.name && c.app === g.app);
				if (latest.status !== "completed") t.add("E2", `${label} ${latest.status}`);
				else if (latest.conclusion !== null && BAD_CONCLUSIONS[latest.conclusion]) t.add("E2", `${label} ${latest.conclusion}`);
				else if (required && latest.conclusion !== "success") t.add("E2", `${label} ${latest.conclusion ?? "no conclusion"}`);
				else if (required && g.runs.slice(0, -1).some((r) => r.status !== "completed" || r.conclusion !== "success")) t.add("W2", `${label} passed on a re-run`);
				else if (!required && (latest.conclusion === "skipped" || latest.conclusion === "neutral")) t.add("W2", `${label} ${latest.conclusion}`);
			}
		});
		await t.fact("commit statuses", async () => {
			const ps = pages(await read("commit statuses", rest(`repos/${repo}/commits/${head}/status?per_page=100`, true)), "commit statuses");
			const statuses = ps.flatMap((p) => farr(p, "statuses", "commit statuses"));
			const total = fnum(ps[0], "total_count", "commit statuses");
			if (statuses.length < total) throw new FactError("commit statuses", `${statuses.length} of ${total} listed (incomplete pagination)`);
			for (const s of statuses) {
				const context = fstr(s, "context", "commit statuses");
				const state = fstr(s, "state", "commit statuses");
				checks++;
				if (state !== "success") t.add("E2", `status ${context} ${state}`);
			}
		});
	}

	// E3: auto-merge on an open PR, a merge queue on the default branch.
	await t.fact("open pull requests", async () => {
		const ps = pages(await read("open pull requests", rest(`repos/${repo}/pulls?state=open&per_page=100`, true)), "open pull requests");
		for (const p of ps) {
			if (!Array.isArray(p)) throw new FactError("open pull requests", "a page is not a list");
			for (const pr of p) if (field(pr, "auto_merge", "open pull requests") !== null) t.add("E3", `auto-merge pr ${fnum(pr, "number", "open pull requests")}`);
		}
	});
	await t.fact("merge queue", async () => {
		const [owner, name] = repo.split("/") as [string, string];
		const json = await read("merge queue", {
			kind: "graphql",
			query: "query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id}}}",
			vars: { owner, name, branch: target.ref },
		});
		const repository = field(field(json, "data", "merge queue"), "repository", "merge queue");
		if (field(repository, "mergeQueue", "merge queue") !== null) t.add("E3", "merge queue");
	});

	// B…H: E4, E5, E9, W1, W3, W4; E6.
	if (base === null) t.add("E6", "no B");
	if (target.rollback === null) t.add("E6", "no rollback");
	if (base !== null) {
		await t.fact("successful run at B", async () => {
			const json = await read("successful run at B", rest(`repos/${repo}/actions/workflows/${target.file}/runs?head_sha=${base}&status=success&per_page=1`));
			farr(json, "workflow_runs", "successful run at B");
			if (fnum(json, "total_count", "successful run at B") === 0) t.add("E6", "no successful run at B");
		});
	}
	if (base !== null && head !== null) {
		await t.fact("compare", async () => {
			const ps = pages(await read("compare", rest(`repos/${repo}/compare/${base}...${head}?per_page=100`, true)), "compare");
			const total = fnum(ps[0], "total_commits", "compare");
			const commits = ps.flatMap((p) => farr(p, "commits", "compare"));
			const files = farr(ps[0], "files", "compare");
			if (files.length >= COMPARE_FILE_CAP || commits.length < total) {
				t.add("E0", "compare capped");
				t.notes.push(`E0 compare ${base.slice(0, 7)}...${head.slice(0, 7)} lists ${files.length} files and ${commits.length} of ${total} commits`);
				return;
			}
			let lines = 0;
			const paths = new Set<string>();
			const packages: string[] = [];
			for (const f of files) {
				const name = fstr(f, "filename", "compare");
				const status = fstr(f, "status", "compare");
				lines += fnum(f, "additions", "compare") + fnum(f, "deletions", "compare");
				paths.add(name);
				if (isObj(f) && typeof f.previous_filename === "string") paths.add(f.previous_filename);
				if (name.split("/").at(-1) === "package.json" && status !== "added" && status !== "removed") packages.push(name);
			}
			for (const p of paths) {
				if ([...MIGRATION_GLOBS, ...target.migrations].some((g) => new Bun.Glob(g).match(p))) t.add("E4", `path ${p}`);
				if ([...SENSITIVE_GLOBS, ...target.sensitive].some((g) => new Bun.Glob(g).match(p))) t.add("E5", `path ${p}`);
			}
			if (lines > policy.lines.escalate) t.add("E9", `lines ${lines}`);
			if (lines > policy.lines.warn) t.add("W3", `lines ${lines}`);
			const dirs = new Set([...paths].filter((p) => p.includes("/")).map((p) => p.split("/")[0]!));
			if (dirs.size > policy.dirs.warn) t.add("W4", `dirs ${dirs.size}`);
			for (const p of packages) {
				const at = async (ref: string): Promise<Obj | null> => {
					const json = await read(`${p} at ${ref.slice(0, 7)}`, rest(`repos/${repo}/contents/${p}?ref=${ref}`), true);
					if (json === null) return null;
					if (fstr(json, "encoding", `${p} contents`) !== "base64") throw new FactError(`${p} contents`, "not base64");
					const parsed: unknown = JSON.parse(Buffer.from(fstr(json, "content", `${p} contents`), "base64").toString("utf8"));
					if (!isObj(parsed)) throw new FactError(`${p} contents`, "not a JSON object");
					return parsed;
				};
				const [before, after] = [await at(base), await at(head)];
				if (before === null || after === null) continue;
				for (const k of DEP_FIELDS) {
					const b = isObj(before[k]) ? (before[k] as Obj) : {};
					const a = isObj(after[k]) ? (after[k] as Obj) : {};
					for (const dep of Object.keys(a)) {
						const [mb, ma] = [major(b[dep]), major(a[dep])];
						if (mb !== null && ma !== null && mb !== ma) t.add("W1", `${p} ${dep} ${mb}->${ma}`);
					}
				}
			}
		});
	}

	// E11: an as2 merge of the repo with no merge-done:, and its PR not merged into H.
	await t.fact("merge rows", async () => {
		const done = new Set(doneRows(facts.ledger).map((d) => d.token));
		for (const r of inflightRows(facts.ledger)) {
			if (!sameRepo(r.repo, repo) || done.has(r.token)) continue;
			let resolved = false;
			if (head !== null) {
				const pr = await read(`pull ${r.pr}`, rest(`repos/${repo}/pulls/${r.pr}`));
				const merged = field(pr, "merged", `pull ${r.pr}`);
				const mergeSha = field(pr, "merge_commit_sha", `pull ${r.pr}`);
				if (merged === true && typeof mergeSha === "string" && /^[0-9a-f]{40}$/.test(mergeSha)) {
					const status = fstr(await read(`pull ${r.pr} in H`, rest(`repos/${repo}/compare/${head}...${mergeSha}`)), "status", `pull ${r.pr} in H`);
					resolved = status === "behind" || status === "identical";
				}
			}
			if (!resolved) t.add("E11", `pr ${r.pr}`, `token ${r.token}`);
		}
	});

	if (!insideWindow(policy.window, facts.now())) t.add("D1");

	// E10: the gate's own health probe, after every read that can stop it short.
	const health = await facts.httpsGet(target.health.url);
	if (!health.ok) {
		t.add("E10", "health unreachable");
		t.notes.push(`E10 ${target.health.url}: ${health.error}`);
	} else if (health.status !== target.health.status) t.add("E10", `health ${health.status}`);

	// E3: the head read again at the end; U3: merge rows of the repo written since M.
	if (head !== null && !shipped) {
		const again = await t.fact("head again", () => headOf(repo, target.ref, "head again"));
		if (again !== undefined && again !== head) t.add("E3", "ref moved");
	}
	if (mark !== undefined) {
		const since = await t.fact("merge rows since M", () => mergesSince(facts.ledger, repo, mark));
		for (const i of since ?? []) t.instances.push(i);
	}

	return { kind: "verdict", ...verdictOf(t, { target: target.name, repo, authenticated: true, head, base, mark: mark ?? null, checks }) };
}

/** Settle evaluates the commit that actually shipped with the same predicates, not a second condition engine. */
export async function evaluateShippedDeploy(call: { workloadId: string; target: string; sha: string; deployId: string }, facts: DeployFacts): Promise<DeployEvaluation> {
	const auth = policyAuth(facts);
	const target = auth.policy?.targets.find((t) => t.name === call.target);
	if (!target) {
		const conditions: ConditionInstance[] = [{ id: "E0", facts: ["shipped target unavailable"] }];
		return { kind: "verdict", outcome: "escalate", target: call.target, repo: null, authenticated: auth.authenticated, head: call.sha, base: null, mark: null, checks: 0, conditions, warnings: [], ids: ["E0"], sha256: instancesHash(conditions), notes: [auth.problem ?? "shipped target unavailable"] };
	}
	return evaluateDeploy({ workloadId: call.workloadId, command: target.command, cwd: ".", env: {} }, facts, { sha: call.sha, deployId: call.deployId });
}

/** A `gh pr merge` call's verdict (§ 3.4 M1 path, U2): hold > escalate > routine. `head` is the PR head M1 records. */
export interface MergeVerdict {
	outcome: "hold" | "escalate" | "routine";
	repo: string;
	pr: number | null;
	/** The PR head (`--match-head-commit`), when M1 holds and it could be read; null is `head unknown`. */
	head: string | null;
	conditions: ConditionInstance[];
	ids: ConditionId[];
	sha256: string;
	notes: string[];
}

/**
 * Evaluate a `gh pr merge` on `repo`: M1 on the code constant plus the policy's `mergeTriggered` only when the policy is
 * authenticated (an unauthenticated policy never shrinks the list); U2 when a deploy of a target of the repo is unsettled.
 * A deploy whose target the policy (authenticated or not) cannot map to a repo holds every merge: it may be this repo's.
 */
export async function evaluateMerge(call: { repo: string; pr: number | null }, facts: DeployFacts): Promise<MergeVerdict> {
	const auth = policyAuth(facts);
	const notes: string[] = [];
	const instances: ConditionInstance[] = [];
	const triggered = [...MERGE_TRIGGERED, ...(auth.authenticated && auth.policy ? auth.policy.mergeTriggered : [])];
	try {
		const settled = new Set(settleRows(facts.ledger).map((s) => s.dp));
		for (const d of deployRows(facts.ledger)) {
			if (settled.has(d.id)) continue;
			const t = auth.policy?.targets.find((x) => x.name === d.target);
			if (t === undefined || sameRepo(t.repo, call.repo)) instances.push({ id: "U2", facts: [`deploy ${d.id}`] });
		}
	} catch (err) {
		instances.push({ id: "U2", facts: ["ledger unreadable"] });
		notes.push(`U2 the deploy rows could not be read (${err instanceof Error ? err.message : String(err)})`);
	}
	let head: string | null = null;
	if (triggered.some((r) => sameRepo(r, call.repo))) {
		instances.push({ id: "M1", facts: [] });
		if (call.pr !== null) {
			const r = await facts.gh({ kind: "rest", path: `repos/${call.repo}/pulls/${call.pr}`, paginate: false });
			try {
				if (!r.ok) throw new Error(r.error);
				head = sha(fstr(field(r.json, "head", "pull head"), "sha", "pull head"), "pull head");
			} catch (err) {
				notes.push(`M1 head unknown: ${err instanceof Error ? err.message : String(err)}`);
			}
		} else notes.push("M1 head unknown: the call names no PR number");
	}
	const conditions = canonicalInstances(instances);
	const outcome = conditions.some((i) => i.id === "U2") ? "hold" : conditions.length > 0 ? "escalate" : "routine";
	return { outcome, repo: call.repo, pr: call.pr, head, conditions, ids: [...new Set(conditions.map((i) => i.id))], sha256: instancesHash(conditions), notes };
}
