/**
 * The routing chain's rules, pure: kind → tier → pull-up → cap. No OMP import, no I/O, so the
 * rules are testable offline and the extension (classifier/extension.ts) only wires them to
 * OMP events. The model step (tier → ordered models) is classifier/src/tier-table.ts.
 */

// SPEC-2.0.md § A1.1: the five kinds, keyed on the shape of the slice brief.
export const KINDS = ["locate", "understand", "change-small", "change-large", "judge"] as const;
export type Kind = (typeof KINDS)[number];

// SPEC-2.0.md § A1.3: four tiers, names not models, ordered lowest to highest.
export const TIERS = ["fast", "standard", "strong", "deep"] as const;
export type Tier = (typeof TIERS)[number];

// SPEC-2.0.md § A1.2: the three stakes levels a workload brief carries.
export const STAKES = ["throwaway", "normal", "production"] as const;
export type Stakes = (typeof STAKES)[number];

// SPEC-2.0.md § A1.3: kind → tier is fixed in the spec; only judge reaches deep.
export const KIND_TIER: Readonly<Record<Kind, Tier>> = {
	locate: "fast",
	understand: "standard",
	"change-small": "standard",
	"change-large": "strong",
	judge: "deep",
};

// SPEC-2.0.md § B4: stakes → tier cap (throwaway/normal/production → fast/strong/deep).
export const STAKES_CAP: Readonly<Record<Stakes, Tier>> = {
	throwaway: "fast",
	normal: "strong",
	production: "deep",
};

// SPEC-2.0.md § A1.3 "Measured 2026-09-23": threshold 0.55. Flagged means at or below it (ruled
// 2026-09-29 after the M3 gate run: a brief answered at exactly 0.55 was under-served in one of two
// live draws; the sweeps in research/classifier-sample.md were computed strictly-below).
// Jev capability card: skills/jev/SKILL.md (read before changing this call or its threshold)
export const LOW_CONFIDENCE_THRESHOLD = 0.55;

export function isKind(value: unknown): value is Kind {
	return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}
export function isTier(value: unknown): value is Tier {
	return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}
export function isStakes(value: unknown): value is Stakes {
	return typeof value === "string" && (STAKES as readonly string[]).includes(value);
}

export function tierRank(tier: Tier): number {
	return TIERS.indexOf(tier);
}

/** The classifier's answer to the one choice question, as TypeSafe returns it. */
export interface KindAnswer {
	choice: Kind;
	confidence: number;
	probabilities: Partial<Record<Kind, number>>;
}

/** A tier change and why it happened; `null` on the record means no change. */
export interface TierMove {
	from: Tier;
	to: Tier;
}

export interface Routing {
	kind: Kind;
	confidence: number;
	/** The two most probable kinds by the classifier's own probabilities, most probable first. */
	topTwo: [Kind, Kind];
	lowConfidence: boolean;
	/** KIND_TIER[kind]: the tier before any pull-up or cap. */
	classifiedTier: Tier;
	pullUp: TierMove | null;
	stakes: Stakes | null;
	cap: Tier | null;
	pullDown: TierMove | null;
	/** The tier the hand is spawned on. */
	tier: Tier;
}

/**
 * The two most probable kinds. Ties break toward the higher tier, so a tie can never route lower
 * than the other reading of the brief (SPEC-2.0.md § A1.3: "never lower").
 */
export function topTwoKinds(answer: KindAnswer): [Kind, Kind] {
	const ranked = [...KINDS].sort((a, b) => {
		const byProbability = (answer.probabilities[b] ?? 0) - (answer.probabilities[a] ?? 0);
		if (byProbability !== 0) return byProbability;
		return tierRank(KIND_TIER[b]) - tierRank(KIND_TIER[a]);
	});
	return [ranked[0]!, ranked[1]!];
}

/**
 * Kind → tier → pull-up → cap for one dispatch. `stakes` is the brief's stakes field; `null`
 * (missing or unreadable) applies no cap — the six-field refusal is M4's gate, not this one.
 */
export function route(answer: KindAnswer, stakes: Stakes | null): Routing {
	if (!isKind(answer.choice)) throw new Error(`classifier returned an unknown kind: ${String(answer.choice)}`);
	if (!Number.isFinite(answer.confidence)) throw new Error("classifier returned no confidence");

	// SPEC-2.0.md § A1.3 routing step 2: kind → tier from the fixed table.
	const classifiedTier = KIND_TIER[answer.choice];
	const topTwo = topTwoKinds(answer);
	// SPEC-2.0.md § A1.3 low-confidence rule: at or below the threshold, flag the dispatch.
	const lowConfidence = answer.confidence <= LOW_CONFIDENCE_THRESHOLD;

	let tier = classifiedTier;
	let pullUp: TierMove | null = null;
	if (lowConfidence) {
		// SPEC-2.0.md § A1.3: dispatch at the higher tier of the top two kinds, never lower than
		// the classified tier; the pull-up is recorded.
		const candidate = [KIND_TIER[topTwo[0]], KIND_TIER[topTwo[1]]].reduce(
			(best, next) => (tierRank(next) > tierRank(best) ? next : best),
			classifiedTier,
		);
		if (candidate !== classifiedTier) pullUp = { from: classifiedTier, to: candidate };
		tier = candidate;
	}

	// SPEC-2.0.md § A1.3 routing step 3 and § B4: the stakes cap pulls a higher tier down; the
	// pull-down is recorded. Applied after the pull-up ("the B4 stakes cap still applies").
	const cap = stakes === null ? null : STAKES_CAP[stakes];
	let pullDown: TierMove | null = null;
	if (cap !== null) {
		const capped = tierRank(tier) > tierRank(cap) ? cap : tier;
		if (capped !== tier) pullDown = { from: tier, to: capped };
		tier = capped;
	}

	return {
		kind: answer.choice,
		confidence: answer.confidence,
		topTwo,
		lowConfidence,
		classifiedTier,
		pullUp,
		stakes,
		cap,
		pullDown,
		tier,
	};
}
