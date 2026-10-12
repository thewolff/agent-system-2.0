/**
 * Labs and the cross-lab review rule (PLAN wl-mupu0sx2o046io D1–D6; MIGRATION.md follow-up 23).
 * No OMP import and no I/O beyond the ledger view a caller passes in and a dead hand's session file
 * (`builderLabs`' replaceable reader), so the classifier (classifier/extension.ts) and the surface's
 * plan-review check read one rule.
 *
 * - D1: provider → lab is an explicit map. A provider not in it has no lab and is never counted as
 *   independent: a candidate entry on it is not a reviewer, a builder on it makes the builders every lab.
 * - D2: a dispatch (and a settled `routings` row, read back) is a review when its kind is `judge`, or
 *   it was low-confidence with `judge` in its top two.
 * - D3: `builderLabs` reads who built the work from the ledger; a dead hand (its lane exited or was
 *   replaced before it settled) is read from its session file, the one I/O a caller can replace.
 * - D4–D6: `reviewPlan` decides one hand, a production fan-out, or a park.
 */
import { type EntryRow, type InstructionRow, LANE_RUNNER_BY, LANE_STARTER_BY, type QuestionRow, type RoutingRow } from "../../ledger/src/index";
import { SURFACE_BY } from "../../surface/src/types";
import { type HandSessionModels, handSessionModels } from "./hand-session";
import { countRounds, reviewRoundBody, UNKNOWN } from "./rounds";
import { type Kind, type Routing, type Stakes, topTwoKinds } from "./route";
import { modelIdentity } from "./tier-table";

export type Lab = "anthropic" | "openai" | "kimi";
/** Every lab, in the order the tier rows list them. */
export const LABS: readonly Lab[] = ["anthropic", "openai", "kimi"];

// D1: one explicit map. A provider must be added here before a review can count it as another lab.
// `kimi-code` stays after the tier rows moved to `moonshot` (Jo, in-muq3zh77r02g3k): older ledger rows name it.
const PROVIDER_LAB: Readonly<Record<string, Lab>> = {
	anthropic: "anthropic",
	openai: "openai",
	"openai-codex": "openai",
	"kimi-code": "kimi",
	moonshot: "kimi",
};

/** The provider of a `provider/model[:level]` selector (or a bare provider name). */
export function providerOf(selector: string): string {
	return selector.trim().split("/")[0]!;
}

/** The lab of a `provider/model` selector; `null` for a provider the map does not name. */
export function labOf(selector: string): Lab | null {
	const provider = providerOf(selector);
	return Object.hasOwn(PROVIDER_LAB, provider) ? PROVIDER_LAB[provider]! : null;
}

export const unknownLabReason = (provider: string) => `unknown lab for provider ${provider}; add it to classifier/src/lab.ts`;

// ---- D2: which dispatches are reviews -------------------------------------------------------

/** A dispatch is a review when its kind is judge, or it was low-confidence with judge in its top two. */
export function isReviewDispatch(routing: Pick<Routing, "kind" | "lowConfidence" | "topTwo">): boolean {
	return routing.kind === "judge" || (routing.lowConfidence && routing.topTwo.includes("judge"));
}

/**
 * D2 read-back of a settled `routings` row: `kind = judge`, or `pull_up_to` set and judge in the top
 * two of its stored probabilities. Unreadable probabilities read as not a review: a non-review row
 * counts toward the builders, and a non-review row never clears a plan (fail closed both ways).
 */
export function isReviewRouting(row: Pick<RoutingRow, "kind" | "pull_up_to" | "probabilities">): boolean {
	if (row.kind === "judge") return true;
	if (row.pull_up_to === null) return false;
	try {
		const probabilities = JSON.parse(row.probabilities) as Partial<Record<Kind, number>>;
		if (typeof probabilities !== "object" || probabilities === null) return false;
		return topTwoKinds({ choice: row.kind, confidence: 0, probabilities }).includes("judge");
	} catch {
		return false;
	}
}

// ---- Entry bodies (all `assumption` entries, written through the ledger module) ---------------

export interface HandSpawn {
	token: string;
	root: string;
	spawnKey: string | null;
	review: boolean;
	group: string;
	row: string[];
}

export const handSpawnBody = (s: HandSpawn) =>
	`hand-spawn: ${s.token} session ${s.root} spawn ${s.spawnKey ?? "-"} review ${s.review ? "yes" : "no"} group ${s.group} row ${s.row.join(",")}`;
export const handSettledBody = (token: string, routingId: string) => `hand-settled: ${token} routing ${routingId}`;
/**
 * The terminal settle of a hand whose result will never reach a lane (MIGRATION.md item 109): written by
 * the lane starter inside the `reserveLane` transaction that launches the next lane of the workload, for
 * every `hand-spawn:` of an earlier lane with no `hand-settled:`. No routing row: nothing ran that a
 * row could record. Honoured only from the starter (`settledTokens`), as `lane-exit:` is.
 */
export const handOrphanedBody = (token: string, laneId: string, reason: OrphanReason) => `hand-settled: ${token} orphaned lane ${laneId} reason ${reason}`;
export const ORPHAN_REASONS = ["superseded-without-lane-exit", "superseded-after-lane-exit"] as const;
export type OrphanReason = (typeof ORPHAN_REASONS)[number];
export const reviewWithheldBody = (token: string) => `review-withheld: ${token}`;
/**
 * `hand-cancelled: <token>`: the hand's job was cancelled before its result was shown (MIGRATION.md
 * item 109). Its routing row still records what answered; this entry is what keeps its output
 * withheld for every later delivery, in any process (`recover`).
 */
export const handCancelledBody = (token: string) => `hand-cancelled: ${token}`;
export const reviewParkBody = (questionId: string, sliceId: string) => `review-park: ${questionId} slice ${sliceId}`;
export const reviewSameLabBody = (instructionId: string, token: string) => `review-same-lab: ${instructionId} token ${token}`;
export const laneBuilderBody = (lab: Lab | null, laneId: string, model: string) => `builder-lab: ${lab ?? "unknown"} lane ${laneId} model ${model}`;
export const handBuilderBody = (lab: Lab | null, token: string, model: string) => `builder-lab: ${lab ?? "unknown"} hand ${token} model ${model}`;
/** `builder-lab-gap: <text>`: a lane whose lab `builderLabs` could not read (its `gaps`), recorded once by the classifier (MIGRATION.md item 109). */
export const laneBuilderGapBody = (gap: string) => `builder-lab-gap: ${gap}`;

const HAND_SPAWN = /^hand-spawn:\s+(\S+)\s+session\s+(.+?)\s+spawn\s+(\S+)\s+review\s+(yes|no)\s+group\s+(\S+)\s+row\s+(.*)$/;
const HAND_SETTLED = /^hand-settled:\s+(\S+)\s+routing\s+(\S+)$/;
const HAND_ORPHANED = /^hand-settled:\s+(\S+)\s+orphaned\s+lane\s+(\S+)\s+reason\s+(\S+)$/;
const REVIEW_WITHHELD = /^review-withheld:\s+(\S+)$/;
const HAND_CANCELLED = /^hand-cancelled:\s+(\S+)$/;
const REVIEW_PARK = /^review-park:\s+(\S+)\s+slice\s+(\S+)$/;
const REVIEW_SAME_LAB = /^review-same-lab:\s+(\S+)\s+token\s+(\S+)$/;
const BUILDER_LAB = /^builder-lab:\s+(\S+)\s+(lane|hand)\s+(\S+)\s+model\s+(\S+)$/;
const BUILDER_LAB_VOID = /^builder-lab-void:\s+hand\s+(\S+)\s+by\s+(\S+)$/;
const LANE_STARTED = /^lane-started:\s+(\S+)/;
/** A `lane-started:` with its JSON record (surface/src/launch.ts `laneStartedBody`); the record's `ranModel` / `model` name the lane's model. */
const LANE_STARTED_RECORD = /^lane-started:\s+(\S+)\s+(\{[\s\S]*\})$/;
/** `controlEntries`' lane-scoped parse of the two death signals (surface/src/launch.ts). */
const LANE_LIFECYCLE = /^lane-(started|exit):\s+(lane-\S+)(?:\s[\s\S]*)?$/;
const LANE_END = /^(lane-ready|launch-failed|lane-exit):\s+(\S+)/;

type Entry = Pick<EntryRow, "kind" | "body"> & { slice_id?: string | null; created_by?: string };
const bodies = (entries: readonly Entry[]) => entries.filter(e => e.kind === "assumption").map(e => e.body);

export function parseHandSpawn(body: string): HandSpawn | null {
	const m = HAND_SPAWN.exec(body);
	if (!m) return null;
	return { token: m[1]!, root: m[2]!, spawnKey: m[3] === "-" ? null : m[3]!, review: m[4] === "yes", group: m[5]!, row: m[6]!.split(",").filter(Boolean) };
}

/** Every `hand-spawn:` entry, oldest first, with the slice its entry row names. */
export function handSpawns(entries: readonly Entry[]): (HandSpawn & { sliceId: string | null })[] {
	return entries.flatMap(e => {
		const spawn = e.kind === "assumption" ? parseHandSpawn(e.body) : null;
		return spawn ? [{ ...spawn, sliceId: e.slice_id ?? null }] : [];
	});
}

/**
 * token → routing id, from `hand-settled:` entries; null for a hand the lane starter settled `orphaned`
 * (`handOrphanedBody`: no routing row). The orphaned form is honoured only from the starter; from any
 * other writer, or from an entry whose writer is not given, it settles nothing.
 */
export function settledTokens(entries: readonly Entry[]): Map<string, string | null> {
	const out = new Map<string, string | null>();
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		const m = HAND_SETTLED.exec(e.body);
		if (m) {
			out.set(m[1]!, m[2]!);
			continue;
		}
		const o = HAND_ORPHANED.exec(e.body);
		if (o && e.created_by === LANE_STARTER_BY && !out.has(o[1]!)) out.set(o[1]!, null);
	}
	return out;
}

/** A hand the lane starter settled `orphaned`, parsed; null for any other body. */
export function parseHandOrphaned(body: string): { token: string; laneId: string; reason: string } | null {
	const o = HAND_ORPHANED.exec(body.trim());
	return o ? { token: o[1]!, laneId: o[2]!, reason: o[3]! } : null;
}

/**
 * The entries that settle every orphaned hand of `entries`' workload (MIGRATION.md item 109), for the
 * lane starter to write in the transaction that launches the workload's next lane: a `hand-spawn:`
 * written by any lane (`lane-*`) with no `hand-settled:` gets `hand-settled: <token> orphaned …`, its
 * reason saying whether its lane has a `lane-exit:` (from the runner or the starter); a review hand
 * also gets its `review-round: … verdict orphaned` (terminal, not counted: `countRounds`), numbered as
 * the classifier's `writeRound` numbers it, unless one names its token already. Entries oldest first.
 */
export function orphanSettleEntries(entries: readonly (Entry & { slice_id: string | null; created_by: string; created_at: string })[]): { sliceId: string | null; body: string }[] {
	const settled = settledTokens(entries);
	const exited = new Set<string>();
	const rounded = new Set<string>();
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		const end = LANE_LIFECYCLE.exec(e.body.trim());
		if (end && end[1] === "exit" && (e.created_by === LANE_RUNNER_BY || e.created_by === LANE_STARTER_BY)) exited.add(end[2]!);
		const round = /^review-round:\s+\S+\s+round\s+\d+\s+token\s+(\S+)\s/.exec(e.body.trim());
		if (round) rounded.add(round[1]!);
	}
	const out: { sliceId: string | null; body: string }[] = [];
	for (const e of entries) {
		const spawn = e.kind === "assumption" && e.created_by.startsWith("lane-") ? parseHandSpawn(e.body.trim()) : null;
		if (!spawn || settled.has(spawn.token)) continue;
		const sliceId = e.slice_id ?? null;
		const reason: OrphanReason = exited.has(e.created_by) ? "superseded-after-lane-exit" : "superseded-without-lane-exit";
		out.push({ sliceId, body: handOrphanedBody(spawn.token, e.created_by, reason) });
		if (!spawn.review || sliceId === null || rounded.has(spawn.token)) continue;
		const count = countRounds(entries, sliceId);
		const round = count.rounds.find(r => r.group === spawn.group)?.n ?? count.next;
		out.push({ sliceId, body: reviewRoundBody({ slice: sliceId, round, token: spawn.token, group: spawn.group, verdict: "orphaned", findings: UNKNOWN }) });
	}
	return out;
}

/** Tokens a `review-withheld:` entry names. */
export function withheldTokens(entries: readonly Entry[]): Set<string> {
	return new Set(bodies(entries).flatMap(b => REVIEW_WITHHELD.exec(b)?.[1] ?? []));
}

/** Tokens a `hand-cancelled:` entry names. */
export function cancelledTokens(entries: readonly Entry[]): Set<string> {
	return new Set(bodies(entries).flatMap(b => HAND_CANCELLED.exec(b)?.[1] ?? []));
}

/** The token a `hand-settled:` entry links to `routingId`, if any. */
export function tokenOfRouting(entries: readonly Entry[], routingId: string): string | null {
	for (const [token, id] of settledTokens(entries)) if (id !== null && id === routingId) return token;
	return null;
}

// ---- D3: who built the work ------------------------------------------------------------------

/**
 * The builders of a workload. A non-empty `unknown` means the provenance is unknown: every lab built it.
 * `gaps` names the lanes whose lab could not be read at all (MIGRATION.md item 109): no `builder-lab:`
 * entry and no model in any `lane-started:` record. A gap also makes every lab a builder — a lane whose
 * lab is unknown may be any lab, so no review off it is independent (Plumb's ruling, 2026-10-12: fail
 * closed) — and the next review parks with the gap text as its reason; the classifier records each gap
 * once as a `builder-lab-gap:` entry so the cause is named in the ledger.
 */
export interface Builders {
	labs: Lab[];
	unknown: string[];
	gaps: string[];
}

/** Every lab built the work: the provenance is unknown, or a lane's lab could not be read. */
function everyLab(builders: Builders): boolean {
	return builders.unknown.length > 0 || builders.gaps.length > 0;
}

export function isBuilder(builders: Builders, lab: Lab): boolean {
	return everyLab(builders) || builders.labs.includes(lab);
}

/** The labs a review is routed off: every lab when the provenance is unknown or a lane's lab is a gap. */
export function excludedLabs(builders: Builders): Lab[] {
	return everyLab(builders) ? [...LABS] : builders.labs;
}

export function describeBuilders(builders: Builders): string {
	return everyLab(builders) ? `every lab: ${[...builders.unknown, ...builders.gaps].join("; ")}` : builders.labs.join(", ") || "none recorded";
}

/** The ledger reads `builderLabs` needs; `Ledger` satisfies it structurally. */
export interface BuilderLedgerView {
	entries(workloadId: string): Pick<EntryRow, "kind" | "body" | "created_by" | "created_at">[];
	routings(workloadId: string): Pick<RoutingRow, "kind" | "pull_up_to" | "probabilities" | "outcome" | "models" | "ran_models" | "session_root" | "agent_id">[];
}

/**
 * D3: the labs that built `workloadId`, from the ledger.
 * 1. Every lane with a `lane-started:` entry: its `builder-lab: … lane <id>` entries' models count
 *    (written by the classifier at the lane's first assistant turn on each lab). A lane with none yet
 *    (MIGRATION.md item 109: the lane is between `lane-ready:` and its first answer, or its mark was
 *    never written) counts the lab of the model its newest `lane-started:` record names — `ranModel`,
 *    what OMP's first `get_state` reported (item 85), else `model`, the one Jo named, which the runner
 *    only becomes ready on — read from records the runner or the starter wrote (fixed writers a lane
 *    cannot forge). A lane with neither is a `gap` (named; every lab is then a builder), except a runner lane
 *    that provably never received a prompt (item 85): every `lane-started:` of it written by the
 *    runner, no `lane-ready:` (the runner writes it immediately before the first prompt), and a
 *    `launch-failed:` or `lane-exit:` from the runner or the starter. Every `builder-lab:` entry's
 *    model counts (lanes, and review hands withheld for changing the work), except a hand's entries
 *    named by a `builder-lab-void: hand <dt> by <instruction>` entry the surface wrote (PLAN
 *    wl-muq13bkdghblmo step 10: a false mark cannot be deleted from the append-only ledger). The same
 *    body from any other writer is ignored, and a void never removes a `lane` mark.
 * 2. Every non-review `routings` row: its `ran_models`, or every model of its row when its models are
 *    unknown (`refused-model-unknown`).
 * 3. Every `hand-spawn:` token with no `hand-settled: … routing` entry: a hand in flight counts every
 *    model of its row. `liveReviews` are review
 *    tokens this process holds in flight; they are checked by their own fingerprint at settle, so
 *    they are not counted (a review running beside another review is not a builder unless it changes
 *    the work, which the other's fingerprint sees). A hand is dead (PLAN wl-mv45jcsi4h3nr4 D1) when the
 *    lane starter settled it `orphaned` (`settledTokens` null: terminal, but no record of what answered),
 *    or a later entry (ledger order, not timestamps) is a `lane-exit:` of the lane that wrote its spawn or
 *    a `lane-started:` of another lane, written by the lane runner or the lane starter; a dead hand
 *    counts only the models that answered in its session file (D2, `sessionModels`): its unclaimed
 *    `<key>.jsonl` / `<key>-<N>.jsonl` files opened at or after its spawn and before the first
 *    `hand-spawn:` of a successor of its lane (a writer whose first entry on the workload comes
 *    after the lane's first). No file, or no answer in one, counts nothing.
 * A model on a provider with no lab makes the provenance unknown (D1).
 */
export function builderLabs(
	view: BuilderLedgerView,
	workloadId: string,
	liveReviews: ReadonlySet<string> = new Set(),
	sessionModels: HandSessionModels = handSessionModels,
): Builders {
	const labs = new Set<Lab>();
	const unknown: string[] = [];
	const gaps: string[] = [];
	const count = (model: string, where: string) => {
		const lab = labOf(model);
		if (lab) labs.add(lab);
		else unknown.push(`${where} ran on ${model}: ${unknownLabReason(providerOf(model))}`);
	};
	const entries = view.entries(workloadId);
	const routings = view.routings(workloadId);
	const voided = new Set(
		entries.filter(e => e.kind === "assumption" && e.created_by === SURFACE_BY).flatMap(e => BUILDER_LAB_VOID.exec(e.body.trim())?.[1] ?? []),
	);
	const started = new Set<string>();
	const covered = new Set<string>();
	for (const body of bodies(entries)) {
		const lane = LANE_STARTED.exec(body);
		if (lane) started.add(lane[1]!);
		const builder = BUILDER_LAB.exec(body);
		if (!builder) continue;
		if (builder[2] === "lane") covered.add(builder[3]!);
		else if (voided.has(builder[3]!)) continue;
		count(builder[4]!, `${builder[2]} ${builder[3]}`);
	}
	// A runner lane that ended before lane-ready: never received a prompt, so no model turn ran on it (item 85).
	const notRunner = new Set<string>();
	const readied = new Set<string>();
	const ended = new Set<string>();
	// The model each lane's newest runner/starter `lane-started:` record names (item 109): ranModel first, else model.
	const recorded = new Map<string, { ranModel: string | null; model: string | null }>();
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		const start = LANE_STARTED.exec(e.body);
		if (start && e.created_by !== LANE_RUNNER_BY) notRunner.add(start[1]!);
		if (start && (e.created_by === LANE_RUNNER_BY || e.created_by === LANE_STARTER_BY)) {
			const named = laneStartedModels(e.body);
			const prior = recorded.get(start[1]!) ?? { ranModel: null, model: null };
			recorded.set(start[1]!, { ranModel: named.ranModel ?? prior.ranModel, model: named.model ?? prior.model });
		}
		const end = LANE_END.exec(e.body);
		if (!end) continue;
		if (end[1] === "lane-ready") readied.add(end[2]!);
		else if (e.created_by === LANE_RUNNER_BY || e.created_by === LANE_STARTER_BY) ended.add(end[2]!);
	}
	for (const lane of started) {
		if (covered.has(lane) || (ended.has(lane) && !readied.has(lane) && !notRunner.has(lane))) continue;
		const named = recorded.get(lane);
		const model = named?.ranModel ?? named?.model ?? null;
		if (model !== null) count(model, `lane ${lane} (from its lane-started: record)`);
		else gaps.push(`lane ${lane} has a lane-started: entry, no builder-lab: entry and no model in its lane-started: record, so the lab it ran on is unknown`);
	}
	// D1 and D2 read positions in `entries` (created_at, then rowid): two entries can share a millisecond.
	const firstAt = new Map<string, number>();
	const deaths: { at: number; exit: boolean; laneId: string }[] = [];
	const spawns: { at: number; spawn: HandSpawn; by: string; createdAt: string }[] = [];
	entries.forEach((e, at) => {
		if (!firstAt.has(e.created_by)) firstAt.set(e.created_by, at);
		if (e.kind !== "assumption") return;
		const spawn = parseHandSpawn(e.body);
		if (spawn) spawns.push({ at, spawn, by: e.created_by, createdAt: e.created_at });
		const lifecycle = e.created_by === LANE_RUNNER_BY || e.created_by === LANE_STARTER_BY ? LANE_LIFECYCLE.exec(e.body.trim()) : null;
		if (lifecycle) deaths.push({ at, exit: lifecycle[1] === "exit", laneId: lifecycle[2]! });
	});
	const settled = settledTokens(entries);
	for (const { at, spawn, by, createdAt } of spawns) {
		// A routing row settles the hand: its row (step 2) carries what answered. The starter's `orphaned`
		// settle (null) is terminal accounting only, never provenance: the orphaned hand is dead, and like
		// any dead hand it counts the models that answered in its session file (MIGRATION.md item 109).
		const routed = settled.get(spawn.token);
		if ((routed !== undefined && routed !== null) || (spawn.review && liveReviews.has(spawn.token))) continue;
		const dead = routed === null || deaths.some(d => d.at > at && (d.exit ? d.laneId === by : d.laneId !== by));
		if (!dead) {
			for (const model of spawn.row) count(model, `unsettled hand ${spawn.token}`);
			continue;
		}
		const claimed = new Set(routings.flatMap(r => (r.session_root === spawn.root && r.agent_id !== null ? [r.agent_id] : [])));
		// U: the earliest spawn by a successor of the spawn's lane, a writer whose first entry comes after
		// its own (entries are oldest first, so the first such spawn has the earliest `created_at`).
		const until = spawns.find(s => firstAt.get(s.by)! > firstAt.get(by)!)?.createdAt ?? null;
		const answered = sessionModels({ root: spawn.root, key: spawn.spawnKey, claimed, from: createdAt, until });
		for (const model of answered) count(model, `dead hand ${spawn.token}`);
	}
	for (const row of routings) {
		if (isReviewRouting(row)) continue;
		const models = row.ran_models !== null ? parseList(row.ran_models) : row.outcome === "refused-model-unknown" ? parseList(row.models) : [];
		for (const model of models) count(model, `a ${row.kind} hand`);
	}
	return { labs: LABS.filter(lab => labs.has(lab)), unknown, gaps };
}

function parseList(json: string): string[] {
	try {
		const list = JSON.parse(json);
		return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string") : [];
	} catch {
		return [];
	}
}

/**
 * The models a `lane-started:` body's record names: `ranModel` (OMP's first `get_state` answer) and
 * `model` (Jo's named model), each null when absent, not a string, or the body carries no record.
 */
export function laneStartedModels(body: string): { ranModel: string | null; model: string | null } {
	const m = LANE_STARTED_RECORD.exec(body.trim());
	if (!m) return { ranModel: null, model: null };
	try {
		const record = JSON.parse(m[2]!) as { ranModel?: unknown; model?: unknown };
		return {
			ranModel: typeof record.ranModel === "string" && record.ranModel.trim() ? record.ranModel : null,
			model: typeof record.model === "string" && record.model.trim() ? record.model : null,
		};
	} catch {
		return { ranModel: null, model: null };
	}
}

// ---- D6: park questions and same-lab grants --------------------------------------------------

export const PARK_OPTIONS = ["same-lab", "wait"] as const;

/** The open `review-park:` question on `sliceId`, if any: one open park question per slice. */
export function openParkQuestion(entries: readonly Entry[], questions: readonly Pick<QuestionRow, "id" | "state" | "slice_id">[], sliceId: string): string | null {
	const parks = parkQuestions(entries, sliceId);
	return questions.find(q => q.state === "open" && q.slice_id === sliceId && parks.has(q.id))?.id ?? null;
}

/** The ids of the classifier's park questions on `sliceId` (`review-park:` entries). */
export function parkQuestions(entries: readonly Entry[], sliceId: string): Set<string> {
	const out = new Set<string>();
	for (const body of bodies(entries)) {
		const m = REVIEW_PARK.exec(body);
		if (m && m[2] === sliceId) out.add(m[1]!);
	}
	return out;
}

/** Instruction ids a `review-same-lab:` entry has spent. */
export function spentGrants(entries: readonly Entry[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const body of bodies(entries)) {
		const m = REVIEW_SAME_LAB.exec(body);
		if (m) out.set(m[1]!, m[2]!);
	}
	return out;
}

/**
 * The oldest unspent same-lab grant for `sliceId`: an `answer` instruction by `jo` to one of this
 * slice's `review-park:` questions whose body is exactly `same-lab`, not yet named by a
 * `review-same-lab:` entry. `wait`, a withdrawal, or any other body grants nothing.
 */
export function unspentGrant(
	entries: readonly Entry[],
	instructions: readonly Pick<InstructionRow, "id" | "kind" | "author" | "question_id" | "body">[],
	sliceId: string,
): string | null {
	const parks = parkQuestions(entries, sliceId);
	const spent = spentGrants(entries);
	return (
		instructions.find(i => i.kind === "answer" && i.author === "jo" && i.question_id !== null && parks.has(i.question_id) && i.body === "same-lab" && !spent.has(i.id))
			?.id ?? null
	);
}

/** The park question's body (D6). `reasons` say why each other-lab entry cannot review. */
export function parkQuestionBody(sliceId: string, builders: Builders, reasons: readonly string[]): string {
	const excluded = excludedLabs(builders).join(", ");
	const labWord = excludedLabs(builders).length > 1 ? "labs" : "lab";
	return (
		`No lab other than the builder's (${describeBuilders(builders)}) can review ${sliceId}: ${reasons.join(", ") || "no other lab's model is in the row"}. ` +
		`**same-lab**: run this one review on ${excluded}, the builder's ${labWord}. ` +
		`**wait**: hold the review until another lab is back; the lane retries later and asks again if it is still down.`
	);
}

// ---- D4–D6: the routing decision -------------------------------------------------------------

export interface ReviewPlanInput {
	/** The tier row, `provider/model[:level]` selectors in row order. */
	row: readonly string[];
	/** The row entries that passed the usability check, row order. */
	usable: readonly string[];
	builders: Builders;
	/** Effective stakes; only `production` fans out. */
	stakes: Stakes | null;
	/** A same-lab grant is held for this dispatch: the builder's entries go after the others. */
	grant: boolean;
	/** A fan-out member: only this lab's entries. */
	pin?: Lab;
	/** Why a row entry was not usable (selector → reason), for the park question and notes. */
	skipped?: Readonly<Record<string, string>>;
}

export interface ReviewMember {
	lab: Lab;
	/** What the spawn is constrained to. */
	models: string[];
	/** The allowlist `settle` checks: the row's entries of the allowed labs, as identities. */
	allow: string[];
}

export type ReviewPlan =
	| { kind: "single"; models: string[]; allow: string[]; excluded: Lab[]; sameLab: boolean; short: string | null }
	| { kind: "fanout"; members: ReviewMember[]; excluded: Lab[] }
	| { kind: "park"; excluded: Lab[]; reasons: string[] };

/**
 * One review dispatch's routing (D4–D6): the row filtered to labs outside the builders; at production
 * stakes one hand per available other lab; no other lab usable → park. A row entry whose provider
 * has no lab parks the dispatch however many other labs are usable (D1: it is never counted as
 * independent), naming it; only a same-lab grant, which claims no independence and never runs it,
 * goes on. A grant appends the builder's entries after the other labs' and is always one hand.
 * Every filter works per lab, not per entry.
 */
export function reviewPlan(input: ReviewPlanInput): ReviewPlan {
	const { row, usable, builders, stakes, grant, pin } = input;
	const excluded = excludedLabs(builders);
	const reviewer = (selector: string) => {
		const lab = labOf(selector);
		return lab !== null && !isBuilder(builders, lab) && (pin === undefined || lab === pin);
	};
	const builder = (selector: string) => {
		const lab = labOf(selector);
		return lab !== null && isBuilder(builders, lab) && pin === undefined;
	};
	const others = usable.filter(reviewer);
	const allowOthers = row.filter(reviewer).map(modelIdentity);
	const otherLabs = [...new Set(others.map(s => labOf(s)!))];
	const reasons = row.flatMap(selector => {
		const lab = labOf(selector);
		if (lab === null) return [`${selector} (${unknownLabReason(providerOf(selector))})`];
		if (pin !== undefined && lab !== pin) return [];
		if (isBuilder(builders, lab)) return grant ? [] : [`${selector} (builder lab ${lab})`];
		return usable.includes(selector) ? [] : [`${selector} (${input.skipped?.[selector] ?? "not usable"})`];
	});
	if (grant) {
		const models = [...others, ...usable.filter(builder)];
		if (models.length === 0) return { kind: "park", excluded, reasons };
		return { kind: "single", models, allow: [...allowOthers, ...row.filter(builder).map(modelIdentity)], excluded, sameLab: true, short: null };
	}
	if (others.length === 0 || row.some(s => labOf(s) === null)) return { kind: "park", excluded, reasons };
	if (stakes === "production" && pin === undefined && otherLabs.length > 1) {
		return {
			kind: "fanout",
			excluded,
			members: otherLabs.map(lab => ({
				lab,
				models: others.filter(s => labOf(s) === lab),
				allow: allowOthers.filter(s => labOf(s) === lab),
			})),
		};
	}
	// The note names why the other labs' entries are missing, not the builder's exclusion.
	const unavailable = row.filter(s => reviewer(s) && !usable.includes(s));
	const short =
		stakes === "production" && pin === undefined
			? `production review fans out to ${otherLabs.join(", ")} only${unavailable.length > 0 ? ` (${unavailable.map(s => `${s} (${input.skipped?.[s] ?? "not usable"})`).join(", ")})` : ""}`
			: null;
	return { kind: "single", models: others, allow: allowOthers, excluded, sameLab: false, short };
}
