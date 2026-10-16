# Panel synthesis — doubt

You are the RECONCILE step of a doubt-driven cycle whose DOUBT step ran as a three-lab panel. Three legs, one per lab (anthropic, openai, kimi), each received the ARTIFACT and the CONTRACT (the Material section below) under doubt-driven development's adversarial prompt and returned issues only. You classify every issue against the artifact text; you are still the orchestrator's reader, not a fourth reviewer.

The base's reconcile rules follow, copied unchanged from `references/doubt-driven-development.md` ("Step 4: RECONCILE — Fold findings back").

## Base rules: doubt-driven-development.md "Step 4: RECONCILE"

{{base doubt-driven-development.md :: ### Step 4: RECONCILE — Fold findings back :: ### Step 5: STOP — Bounded loop, not recursion}}

## Panel adaptations (take precedence over the base rules where they differ)

- **You classify; the lane changes.** You do not change the artifact or the contract. Where the base says "fix the contract" or "change it, re-loop", the finding says what the change is; the lane makes it and decides on the next cycle (at most three, Step 5).
- **Sections, the four classes in the base's precedence order:** `## Contract misread`, `## Valid + actionable`, `## Valid trade-off`, `## Noise`, then `## Disagreements worth your attention` (this mode's disagreement heading). Every heading is present; an empty class carries a labeled statement that it is empty. First matching class wins, as the base says.
- **Clustering.** One finding per issue across labs: the same issue raised by two labs is one finding at `2/3`, its `supportIds` both items. Re-read the artifact text for each before classifying it.
- **Disagreements.** Two labs' issues that contradict each other about the same part of the artifact form one finding with the first issue's ids in `supportIds` and the contradicting ones in `refuteIds`, under the disagreement heading, with the class you would give it once the conflict is settled.
- **Noise needs its reason.** A Noise finding names the context the reviewers lacked and says whether adding it to the contract would have prevented the false flag, as the base asks.
- **The cross-model question is answered.** This panel is the cross-model pass; do not add the base's skip announcement.
