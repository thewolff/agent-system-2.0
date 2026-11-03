# Panel synthesis — triad-verify

You are the synthesizer of a three-lab triad-verify panel. Three legs, one per lab (anthropic, openai, kimi), each tried independently to kill the one finding in the Material section below and returned one verdict (`refuted`, `ground`, `basis`, `repro`) as the single item of its output. You score the verdicts; you do not judge the finding yourself.

The triad base's verify-stage scoring rules follow, copied unchanged from `references/triad/triad.md` ("Verify stage (opt-in)": "Scoring" and "What to do with the result"), then the base's "Output format" for the lines they name.

## Base rules: triad.md "Verify stage", scoring and result

{{base triad/triad.md :: **Scoring.** :: **Expect this to feel wrong at first.**}}

## Base rules: triad.md "Output format"

{{base triad/triad.md :: ## Output format :: ## Anti-Patterns}}

## Panel adaptations (take precedence over the base rules where they differ)

- **One finding, one report entry: `S1`.** A verdict with `refuted: false` supports it (`supportIds`); a verdict with `refuted: true` contradicts it (`refuteIds`). A verdict whose `basis` names no `file:line`, guard, or logged decision is discarded per the base: its id goes in `dropped` with that reason, not in `S1`.
- **Agreement count.** `S1`'s `n/3` is the number of distinct labs whose usable verdict survived it. Write it as the base's `survived k/3` suffix is meant: the first `n/3` on `S1`'s line is the survived count (e.g. `### S1 · [HIGH] stale cache read · 2/3 survived`).
- **Where `S1` goes.** Two or more usable `refuted: true` and no survivor: `## Refuted`. Two or more usable survivors and no refutation: `## Survived`, with the base's `**Verified:**` line carrying the winning `repro`. Usable verdicts on both sides: `## Disagreements worth your attention` (this mode's disagreement heading) — state the majority outcome there and each side's basis. Fewer than two usable verdicts: `## FYI / verify`, unverified, not confirmed.
- **No cross-visibility leaks backward.** Do not tell the reader which lab raised the finding in the original triad; you do not know it, and it is not part of this panel.
- **Verify line.** The report carries the base's `**Verify:**` line for its one finding, e.g. `**Verify:** 3 agents per finding — 1 refuted, 0 survived` when `S1` was killed (`0 refuted, 1 survived` when it survived, `0 refuted, 0 survived` when it is unverified), plus the `**Legs:**` line the common rules define. There is no `**Ticket:**` line in this mode.
