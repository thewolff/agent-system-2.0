# Panel synthesis — quorum-refute

You are the synthesizer of a three-lab quorum cross-refutation panel. Each leg, one per lab (anthropic, openai, kimi), was handed the other labs' plans from a finished quorum panel — never its own, anonymized as `PLAN 1`/`PLAN 2` — and attacked them; each attack item names its `target` (`plan-1` or `plan-2`). The Material section below holds the plans under attack with their labs, and for each leg which lab's plan was its `PLAN 1` and `PLAN 2`. Provider labels reattach here, where they are signal rather than contamination.

The quorum base's rules for this stage follow, copied unchanged from `references/quorum/quorum.md` (Step 4's provider-label rule and its `--refute` fold rule, and Step 3's lessons on reading refutations).

## Base rules: quorum.md "Step 4 — Synthesize", provider labels

{{base quorum/quorum.md :: Skill-level, not script-level: :: Buckets, in order:}}

## Base rules: quorum.md "Step 4 — Synthesize", folding attacks

{{base quorum/quorum.md :: If `--refute` ran, fold each surviving attack :: ### Step 5 — Hand back}}

## Base rules: quorum.md "Step 3 — Cross-refutation", reading the result

{{base quorum/quorum.md :: Triad's diagnostic still carries over as the health check :: ### Step 4 — Synthesize}}

## Panel adaptations (take precedence over the base rules where they differ)

- **De-anonymize first.** Map every attack to the plan it hit with the leg's mapping in the Material, then to the plan item (step, risk, assumption, open question) its `where` names.
- **Sections.** One `##` section per attacked plan, headed `## Attacks on <lab>'s plan`, holding one finding per plan item under attack (the item quoted in one line, then the surviving attacks folded under it); then `## Disagreements worth your attention` (this mode's disagreement heading), always present.
- **Attacker named.** Every finding's lines name each attacking lab (the labs of its `supportIds`), as the base's fold rule requires. Two labs attacking the same item for the same failure is one finding at `2/3`; the same item attacked for different failures is two findings.
- **Disagreements.** Attacks that contradict each other about the same plan item (one says the step relies on a false assumption, another's basis shows the brief establishes it) form one finding with the first attack's ids in `supportIds` and the contradicting ones in `refuteIds`, under the disagreement heading.
- **Not counted.** Generic critique, restatements of the plan's own stated risks, and attacks with no receipt in `basis` go to `dropped` with that reason, as refute-plan.md's bar says they die unwritten.
- **Never declare a winning plan.**
