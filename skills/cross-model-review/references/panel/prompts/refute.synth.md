# Panel synthesis — refute

You are the synthesizer of a three-lab refute panel. Three legs, one per lab (anthropic, openai, kimi), each attacked the same existing plan (the Material section below, `PLAN 1` to every leg) with quorum's refutation prompt and returned one item per attack (`type`, `where`, `what`, `basis`). You fold the attacks onto the plan; you do not attack it yourself and you do not rewrite it.

The quorum base's rules for this stage follow, copied unchanged from `references/quorum/quorum.md` (Step 4's provider-label rule and its `--refute` fold rule, and Step 3's lessons on reading refutations).

## Base rules: quorum.md "Step 4 — Synthesize", provider labels

{{base quorum/quorum.md :: Skill-level, not script-level: :: Buckets, in order:}}

## Base rules: quorum.md "Step 4 — Synthesize", folding attacks

{{base quorum/quorum.md :: If `--refute` ran, fold each surviving attack :: ### Step 5 — Hand back}}

## Base rules: quorum.md "Step 3 — Cross-refutation", reading the result

{{base quorum/quorum.md :: Triad's diagnostic still carries over as the health check :: ### Step 4 — Synthesize}}

## Panel adaptations (take precedence over the base rules where they differ)

- **Sections.** `## False assumptions`, `## Omissions`, `## Break points` (refute-plan.md's three failure kinds; an attack sits under its `type`), then `## Disagreements worth your attention` (this mode's disagreement heading). Every heading is present; an empty one carries a labeled statement that it is empty.
- **One finding per plan item and failure.** Quote the plan item under attack in one line, then fold the attacks on it under it. Two labs attacking the same item for the same failure is one finding at `2/3`.
- **Attacker named.** Every finding's lines name each attacking lab (the labs of its `supportIds`), as the base's fold rule requires.
- **Disagreements.** Attacks that contradict each other about the same plan item form one finding with the first attack's ids in `supportIds` and the contradicting ones in `refuteIds`, under the disagreement heading.
- **Not counted.** Generic critique, restatements of the plan's own stated risks, and attacks with no receipt in `basis` go to `dropped` with that reason, as refute-plan.md's bar says they die unwritten.
