---
title: Quota headroom guard at hand and lane spawns; strong-row OpenAI entry on gpt-6.1-sol
status: building
workload: wl-mv71x5rwdu7eo0
pr: 150
number: 136
---
**Built on branch `wl/wl-mv71x5rwdu7eo0`.** Workload `wl-mv71x5rwdu7eo0` (cheaper routing, normal stakes). This is v1 only, as Jo cut it (in-mv8qzqym1ihmv4): the quota headroom guard (in-mv8p5m2t005tts) plus the strong-row OpenAI entry moved to gpt-6.1-sol. The plan is revision 6 at `~/agent-scratch/agent-system-2.0/wl-mv71x5rwdu7eo0/PLAN.md`, approved by Jo. The routing report, the sizing fix, the cheaper review tier, Opus at medium effort and Haiku 5.5 come later on the same workload.

## Historical scope and replacement

This item retains the original workload, PR and migration number. The behavior below records that delivery, not the replacement policy. [Window-scaled headroom pace and budget protection](headroom-pace-window-scaled.md) documents the approved change under `wl-mv958y95fk07wg`; its independent review, runner proof and landing are still pending at this documentation handoff.

The original fixed first-hour warm-up could reject a weekly budget at 6% used after 60 minutes: its projected full-week usage was 10.08. The replacement waits `max(60 minutes, window length × 0.2)` before projection (33h36m for a week). It can also retain a mature, week-pace-only source when the first configured other-lab budget burns strictly faster, even if that comparator is quota-out. This is budget protection, not permission to change a named model, build lab, review pin or legal spawn destination. Hard source limits and exhaustion are never waived; actual moves use base decisions only. Missing comparison evidence preserves the ordinary refusal.

The replacement uses `decisionFor` and exceptional-admission `retained` notes instead of the original reason-only API. See the successor's **Recent evidence and comparator order**, **Decision API and routing boundaries**, and **Observed proof and pending delivery** sections for the measurement contract and supplied proof. Its **Plumb handoff — after merge, before pull** section owns the separate live-checkout sequence; this item does not claim that action has happened.

## Original delivery

**What changed.**
- `classifier/src/headroom.ts` reads the quota-watch polls (`~/agent-scratch/agent-system-2.0/quota-watch/polls.jsonl`; `AS2_HEADROOM_POLLS` overrides the path) and says whether a `provider/model` is projected to run out of quota.
  - **Pace rule (original).** A limit is out when its window's own pace, carried to the reset, reaches 1.0, measured as used ÷ elapsed × window length (Jo, in-mv8spn0cssasjk). The original implementation projected nothing in a window's first hour; the successor replaces that fixed warm-up.
  - **5-hour rule.** A 5-hour window over 0.80 is out for every provider. This absorbs the 80 % launcher refusal planned in wl-mv654hoqwpfhmo.
  - **Tier limits.** A limit scoped to a model tier binds only that tier's models: Fable's 7d meter never takes Opus out.
  - **Fail-open.** Stale (over 15 min), missing or empty polls leave nothing out.
- The quota watcher (`watch.py`, outside the repo) now writes `limits` on each poll line, with each limit's `resetsAt` from `omp usage --json`.
- **Hand spawns** (`classifier/extension.ts` `usableRow`) skip an entry that is out, as `projected out: <reason>`, and write one `headroom-skip: <selector> token <dt> <reason>` entry per skipped entry. Builds and reviews differ:
  - A build whose lane-lab entries are all out is refused. It never moves to another lab.
  - A review loses the out lab. If no other lab is left, the existing review-park question fires.
- **Lane spawns** (`surface/scripts/lane.ts`, at the RPC runner's own spawn) differ by whether Jo named the model:
  - A lane model Jo named on an out lab is refused before omp starts. `launch-failed: … headroom: named <model>, <reason>` and `lane-died:` are written by lane-runner.
  - An unnamed lane whose model is out is moved by RPC `set_model` to the first strong-row entry with room, confirmed by `get_state` before its first prompt. That move is recorded as `lane-headroom: <from> -> <to> (<reason>)`.
  - If every strong-row entry is out, the lane ends never-ready at stage headroom.
  - The interactive `as2 lane <wl>` path is not guarded.
- **New prefixes.** `lane-headroom` is a reserved control prefix that only lane-runner writes. `headroom-skip` is a classifier machinery prefix. `lane_record_entry` refuses both.
- **gpt-6.1-sol.** The strong row's OpenAI entry is `openai-codex/gpt-6.1-sol`. Through `REVIEW_ROW_FROM`, every OpenAI review and every OpenAI-lane strong build runs on it. SPEC-2.0.md has the amendment "Amended 2026-10-14 — OpenAI reviews on gpt-6.1-sol".

**Install.** The guard runs from the repo. The tier-row change reaches lanes when the profile is installed after merge.

**Rollback.** Revert the original PR to reverse this historical delivery. The `limits` field in `watch.py` is harmless to leave in place. Reversing the window-scaled replacement means reverting its own PR; any live stopgap edit remains a separate Plumb action, as documented in the successor's **Rollback** section.
