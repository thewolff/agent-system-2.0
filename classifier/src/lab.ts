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
 * - `reviewRow`: the tier row a review dispatch plans on (Jo's OpenAI-reviewer rule, `REVIEW_ROW_FROM`).
 * - `KIMI_OUT_RULE`: Jo's standing rule that a review parked only because Kimi is out runs same-lab
 *   (PLAN wl-mv5xay6bjp0268); `builderRoles` orders a same-lab hand least-involved builder lab first.
 */
import { type EntryRow, type InstructionRow, LANE_RUNNER_BY, LANE_STARTER_BY, type QuestionRow, type RoutingRow } from "../../ledger/src/index";
import { SURFACE_BY } from "../../surface/src/types";
import { type HandSessionModels, handSessionModels } from "./hand-session";
import { type Kind, type Routing, type Stakes, type Tier, topTwoKinds } from "./route";
import { modelIdentity, type TierTable } from "./tier-table";

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

// Jev capability card: skills/jev/SKILL.md (read before changing this call or its threshold)
/** A dispatch is a review when its kind is judge, or it was low-confidence with judge in its top two. */
export function isReviewDispatch(routing: Pick<Routing, "kind" | "lowConfidence" | "topTwo">): boolean {
	return routing.kind === "judge" || (routing.lowConfidence && routing.topTwo.includes("judge"));
}

// Jev capability card: skills/jev/SKILL.md (read before changing this call or its threshold)
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
export const reviewWithheldBody = (token: string) => `review-withheld: ${token}`;
export const reviewParkBody = (questionId: string, sliceId: string) => `review-park: ${questionId} slice ${sliceId}`;
export const reviewSameLabBody = (instructionId: string, token: string) => `review-same-lab: ${instructionId} token ${token}`;
export const laneBuilderBody = (lab: Lab | null, laneId: string, model: string) => `builder-lab: ${lab ?? "unknown"} lane ${laneId} model ${model}`;
export const handBuilderBody = (lab: Lab | null, token: string, model: string) => `builder-lab: ${lab ?? "unknown"} hand ${token} model ${model}`;

/** A `review-same-lab-rule:` entry (PLAN wl-mv5xay6bjp0268 § 2.2): Jo's Kimi-out rule let review hand `token` run same-lab. */
export interface ReviewSameLabRule {
	input: string;
	slice: string;
	token: string;
	/** The builder labs the hand may run on, in the order it tries them. */
	labs: string[];
	/** Why Kimi was skipped (the rule's evidence), free text. */
	kimi: string;
}

/** Written by the classifier, as the lane id, immediately before that token's `hand-spawn:` in one transaction. */
export function reviewSameLabRuleBody(r: { slice: string; token: string; labs: readonly string[]; kimi: string }): string {
	return `review-same-lab-rule: ${KIMI_OUT_RULE.input} slice ${r.slice} token ${r.token} labs ${r.labs.join(",")} kimi ${r.kimi}`;
}

export function parseReviewSameLabRule(body: string): ReviewSameLabRule | null {
	const m = REVIEW_SAME_LAB_RULE.exec(body.trim());
	if (!m) return null;
	return { input: m[1]!, slice: m[2]!, token: m[3]!, labs: m[4]!.split(",").filter(Boolean), kimi: m[5]! };
}

const HAND_SPAWN = /^hand-spawn:\s+(\S+)\s+session\s+(.+?)\s+spawn\s+(\S+)\s+review\s+(yes|no)\s+group\s+(\S+)\s+row\s+(.*)$/;
const HAND_SETTLED = /^hand-settled:\s+(\S+)\s+routing\s+(\S+)$/;
const REVIEW_WITHHELD = /^review-withheld:\s+(\S+)$/;
const REVIEW_PARK = /^review-park:\s+(\S+)\s+slice\s+(\S+)$/;
const REVIEW_SAME_LAB = /^review-same-lab:\s+(\S+)\s+token\s+(\S+)$/;
const REVIEW_SAME_LAB_RULE = /^review-same-lab-rule:\s+(\S+)\s+slice\s+(\S+)\s+token\s+(\S+)\s+labs\s+(\S+)\s+kimi\s+(.+)$/;
const BUILDER_LAB = /^builder-lab:\s+(\S+)\s+(lane|hand)\s+(\S+)\s+model\s+(\S+)$/;
const BUILDER_LAB_VOID = /^builder-lab-void:\s+hand\s+(\S+)\s+by\s+(\S+)$/;
const LANE_STARTED = /^lane-started:\s+(\S+)/;
/** `controlEntries`' lane-scoped parse of the two death signals (surface/src/launch.ts). */
const LANE_LIFECYCLE = /^lane-(started|exit):\s+(lane-\S+)(?:\s[\s\S]*)?$/;
const LANE_END = /^(lane-ready|launch-failed|lane-exit):\s+(\S+)/;

type Entry = Pick<EntryRow, "kind" | "body"> & { slice_id?: string | null };
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

/** token → routing id, from `hand-settled:` entries. */
export function settledTokens(entries: readonly Entry[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const body of bodies(entries)) {
		const m = HAND_SETTLED.exec(body);
		if (m) out.set(m[1]!, m[2]!);
	}
	return out;
}

/** Tokens a `review-withheld:` entry names. */
export function withheldTokens(entries: readonly Entry[]): Set<string> {
	return new Set(bodies(entries).flatMap(b => REVIEW_WITHHELD.exec(b)?.[1] ?? []));
}

/** The token a `hand-settled:` entry links to `routingId`, if any. */
export function tokenOfRouting(entries: readonly Entry[], routingId: string): string | null {
	for (const [token, id] of settledTokens(entries)) if (id === routingId) return token;
	return null;
}

// ---- D3: who built the work ------------------------------------------------------------------

/** The builders of a workload. A non-empty `unknown` means the provenance is unknown: every lab built it. */
export interface Builders {
	labs: Lab[];
	unknown: string[];
}

export function isBuilder(builders: Builders, lab: Lab): boolean {
	return builders.unknown.length > 0 || builders.labs.includes(lab);
}

/** The labs a review is routed off: every lab when the provenance is unknown. */
export function excludedLabs(builders: Builders): Lab[] {
	return builders.unknown.length > 0 ? [...LABS] : builders.labs;
}

export function describeBuilders(builders: Builders): string {
	return builders.unknown.length > 0 ? `every lab: ${builders.unknown.join("; ")}` : builders.labs.join(", ") || "none recorded";
}

/** The ledger reads `builderLabs` needs; `Ledger` satisfies it structurally. */
export interface BuilderLedgerView {
	entries(workloadId: string): Pick<EntryRow, "kind" | "body" | "created_by" | "created_at">[];
	routings(workloadId: string): Pick<RoutingRow, "kind" | "pull_up_to" | "probabilities" | "outcome" | "models" | "ran_models" | "session_root" | "agent_id">[];
}

/**
 * D3: the labs that built `workloadId`, from the ledger.
 * 1. Every lane with a `lane-started:` entry needs a `builder-lab: … lane <id>` entry; one without
 *    makes the provenance unknown, except a runner lane that provably never received a prompt
 *    (MIGRATION.md item 85): every `lane-started:` of it written by the runner, no `lane-ready:` (the
 *    runner writes it immediately before the first prompt), and a `launch-failed:` or `lane-exit:` from
 *    the runner or the starter (fixed writers a lane cannot forge). Every `builder-lab:` entry's model
 *    counts (lanes, and review hands withheld for changing the work), except a hand's entries named by a
 *    `builder-lab-void: hand <dt> by <instruction>` entry the surface wrote (PLAN wl-muq13bkdghblmo
 *    step 10: a false mark cannot be deleted from the append-only ledger). The same body from any
 *    other writer is ignored, and a void never removes a `lane` mark.
 * 2. Every non-review `routings` row: its `ran_models`, or every model of its row when its models are
 *    unknown (`refused-model-unknown`).
 * 3. Every `hand-spawn:` token with no `hand-settled:` entry: a hand in flight counts every model of
 *    its row. `liveReviews` are review tokens this process holds in flight; they are checked by their
 *    own fingerprint at settle, so they are not counted (a review running beside another review is
 *    not a builder unless it changes the work, which the other's fingerprint sees). A hand is dead
 *    (PLAN wl-mv45jcsi4h3nr4 D1) when a later entry (ledger order, not timestamps) is a `lane-exit:`
 *    of the lane that wrote its spawn or a `lane-started:` of another lane, written by the lane runner
 *    or the lane starter; a dead hand counts only the models that answered in its session file (D2,
 *    `sessionModels`): its unclaimed `<key>.jsonl` / `<key>-<N>.jsonl` files opened at or after its
 *    spawn and before the first `hand-spawn:` of a successor of its lane (a writer whose first entry
 *    on the workload comes after the lane's first). No file, or no answer in one, counts nothing.
 * A model on a provider with no lab makes the provenance unknown (D1).
 */
export function builderLabs(
	view: BuilderLedgerView,
	workloadId: string,
	liveReviews: ReadonlySet<string> = new Set(),
	sessionModels: HandSessionModels = handSessionModels,
): Builders {
	const { labs, unknown } = builderWalk(view, workloadId, liveReviews, sessionModels);
	return { labs, unknown };
}

/**
 * How a builder lab took part in the work (PLAN wl-mv5xay6bjp0268 § 2.3), least involved first:
 * `review`, only through review hands (a withheld review's `builder-lab: … hand` mark, an unsettled or
 * dead review hand); `hand`, a non-review hand (its routing row, or unsettled or dead); `lane`, a lane's
 * `builder-lab: … lane` mark.
 */
export type BuilderRole = "review" | "hand" | "lane";
const ROLE_RANK: Readonly<Record<BuilderRole, number>> = { review: 1, hand: 2, lane: 3 };

/** Each builder lab's most involved role, read by `builderLabs`' own walk of the ledger (same arguments). */
export function builderRoles(
	view: BuilderLedgerView,
	workloadId: string,
	liveReviews: ReadonlySet<string> = new Set(),
	sessionModels: HandSessionModels = handSessionModels,
): Partial<Record<Lab, BuilderRole>> {
	return builderWalk(view, workloadId, liveReviews, sessionModels).roles;
}

function builderWalk(
	view: BuilderLedgerView,
	workloadId: string,
	liveReviews: ReadonlySet<string>,
	sessionModels: HandSessionModels,
): Builders & { roles: Partial<Record<Lab, BuilderRole>> } {
	const labs = new Set<Lab>();
	const unknown: string[] = [];
	const roles: Partial<Record<Lab, BuilderRole>> = {};
	const count = (model: string, where: string, role: BuilderRole) => {
		const lab = labOf(model);
		if (!lab) {
			unknown.push(`${where} ran on ${model}: ${unknownLabReason(providerOf(model))}`);
			return;
		}
		labs.add(lab);
		const held = roles[lab];
		if (held === undefined || ROLE_RANK[role] > ROLE_RANK[held]) roles[lab] = role;
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
		count(builder[4]!, `${builder[2]} ${builder[3]}`, builder[2] === "lane" ? "lane" : "review");
	}
	// A runner lane that ended before lane-ready: never received a prompt, so no model turn ran on it (item 85).
	const notRunner = new Set<string>();
	const readied = new Set<string>();
	const ended = new Set<string>();
	for (const e of entries) {
		if (e.kind !== "assumption") continue;
		const start = LANE_STARTED.exec(e.body);
		if (start && e.created_by !== LANE_RUNNER_BY) notRunner.add(start[1]!);
		const end = LANE_END.exec(e.body);
		if (!end) continue;
		if (end[1] === "lane-ready") readied.add(end[2]!);
		else if (e.created_by === LANE_RUNNER_BY || e.created_by === LANE_STARTER_BY) ended.add(end[2]!);
	}
	for (const lane of started) {
		if (covered.has(lane) || (ended.has(lane) && !readied.has(lane) && !notRunner.has(lane))) continue;
		unknown.push(`lane ${lane} has a lane-started: entry and no builder-lab: entry, so the lab it ran on is unknown`);
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
		if (settled.has(spawn.token) || (spawn.review && liveReviews.has(spawn.token))) continue;
		const dead = deaths.some(d => d.at > at && (d.exit ? d.laneId === by : d.laneId !== by));
		if (!dead) {
			for (const model of spawn.row) count(model, `unsettled hand ${spawn.token}`, spawn.review ? "review" : "hand");
			continue;
		}
		const claimed = new Set(routings.flatMap(r => (r.session_root === spawn.root && r.agent_id !== null ? [r.agent_id] : [])));
		// U: the earliest spawn by a successor of the spawn's lane, a writer whose first entry comes after
		// its own (entries are oldest first, so the first such spawn has the earliest `created_at`).
		const until = spawns.find(s => firstAt.get(s.by)! > firstAt.get(by)!)?.createdAt ?? null;
		const answered = sessionModels({ root: spawn.root, key: spawn.spawnKey, claimed, from: createdAt, until });
		for (const model of answered) count(model, `dead hand ${spawn.token}`, spawn.review ? "review" : "hand");
	}
	for (const row of routings) {
		if (isReviewRouting(row)) continue;
		const models = row.ran_models !== null ? parseList(row.ran_models) : row.outcome === "refused-model-unknown" ? parseList(row.models) : [];
		for (const model of models) count(model, `a ${row.kind} hand`, "hand");
	}
	return { labs: LABS.filter(lab => labs.has(lab)), unknown, roles };
}

function parseList(json: string): string[] {
	try {
		const list = JSON.parse(json);
		return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string") : [];
	} catch {
		return [];
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

// ---- The row a review plans on ---------------------------------------------------------------

/**
 * Jo's standing rule (in-mv5qdfvskukmbk): a review that routes to OpenAI runs on gpt-6-sol, never
 * gpt-6-astra. Jo chose to build it here, not in the tier table (in-mv5qfm8910ycjk): gpt-6-sol is
 * already the strong row's OpenAI entry, and `tierTableFromConfig` refuses one model in two tiers
 * (a fallback to it would pull up a tier), so the deep row and profile/config.yml stay unchanged
 * and non-review deep spawns keep the deep row. Each entry names a lab whose review entries on the
 * deep row come from the named tier's row instead. It holds until the review-cost framework
 * workload lands or Jo says otherwise; ending it is deleting the entry.
 */
export const REVIEW_ROW_FROM: Readonly<Partial<Record<Lab, Tier>>> = { openai: "strong" };

/**
 * The row a review dispatch on `tier` plans on. On `deep`: the deep row with every entry of a lab
 * named in `REVIEW_ROW_FROM` replaced, at that lab's first deep entry, by the named tier's entries
 * of the same lab (identities de-duplicated); a lab with none there loses its deep entries and
 * never falls back to them. Other labs' entries stay where they are. Any other tier: its row.
 */
export function reviewRow(table: TierTable, tier: Tier): string[] {
	const row = table[tier];
	if (tier !== "deep") return [...row];
	const out: string[] = [];
	const replaced = new Set<Lab>();
	for (const selector of row) {
		const lab = labOf(selector);
		const from = lab === null ? undefined : REVIEW_ROW_FROM[lab];
		if (lab === null || from === undefined) {
			out.push(selector);
			continue;
		}
		if (replaced.has(lab)) continue;
		replaced.add(lab);
		const seen = new Set<string>();
		for (const entry of table[from]) {
			if (labOf(entry) !== lab || seen.has(modelIdentity(entry))) continue;
			seen.add(modelIdentity(entry));
			out.push(entry);
		}
	}
	return out;
}

// ---- Jo's Kimi-out rule (PLAN wl-mv5xay6bjp0268) -----------------------------------------------

/**
 * Jo's standing rule (input in-mv5xafhywe3w8w, 2026-10-13): a review that parks only because Kimi is out goes same-lab with
 * no question (PLAN wl-mv5xay6bjp0268). It ends at the end of 2026-10-31 America/Los_Angeles (2026-11-01T00:00-07:00, PDT)
 * or on Jo's word, whichever is first; ending it early is setting `endsAt` to the moment of Jo's word, merging, and relaunching
 * the lanes. `rowOmission`: the installed tier rows dropped moonshot for this outage (2026-10-12 14:28 PDT), so a review row
 * with no kimi entry counts as Kimi out while the rule is active.
 */
export const KIMI_OUT_RULE = { input: "in-mv5xafhywe3w8w", endsAt: Date.parse("2026-11-01T00:00:00-07:00"), rowOmission: true } as const;
export const kimiOutRuleActive = (now: number) => now < KIMI_OUT_RULE.endsAt;

/** A Kimi quota or suspension refusal's message (Moonshot's 429 "account suspended due to insufficient balance"). */
export const KIMI_QUOTA_MESSAGE = /exceeded_current_quota|insufficient balance|suspended/i;

/**
 * PLAN wl-mv5xay6bjp0268 § 2.4: does a failed turn's 429 mark its kimi-lab provider refused? Only while the rule is active,
 * only on a kimi-lab provider, and only for a quota or suspension message; every other 429 is an ordinary rate limit.
 */
export function isKimiQuotaRefusal(provider: string, status: number | null, message: string | null, now: number): boolean {
	return kimiOutRuleActive(now) && status === 429 && labOf(provider) === "kimi" && KIMI_QUOTA_MESSAGE.test(message ?? "");
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
	/**
	 * Each builder lab's role (`builderRoles`): with it a same-lab plan orders the builder labs' entries least-involved lab
	 * first (a lab with no role, then `review` < `hand` < `lane`), then by row order (PLAN wl-mv5xay6bjp0268 § 2.3).
	 */
	roles?: Partial<Record<Lab, BuilderRole>>;
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
 * goes on. A grant appends the builder's entries after the other labs' and is always one hand; given
 * `roles`, the builder's entries go least-involved lab first (§ 2.3), each lab's in row order.
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
		// Without `roles` every rank is 0; Array.prototype.sort is stable, so equal ranks keep row order.
		const rank = (selector: string) => {
			const role = input.roles?.[labOf(selector)!];
			return role === undefined ? 0 : ROLE_RANK[role];
		};
		const models = [...others, ...usable.filter(builder).sort((a, b) => rank(a) - rank(b))];
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
