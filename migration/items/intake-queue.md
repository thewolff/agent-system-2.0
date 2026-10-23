---
title: Intake queue
status: open
workload: wl-mvbcjadqgblr7k
pr: 305
---
**Carries PR #158 (`migration/items/rank-ordered-launch.md`) whole.** Built by workload `wl-mvbcjadqgblr7k` (plan rev 3 at `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvbcjadqgblr7k/PLAN.md`, D1–D9) on PR #158's branch, using #158's `rankOpen`, rank gate and drain order unchanged in shape. It adds the intake queue, which #158 does not have: a new ask waits in rank order while the started work outnumbers the lane slots, instead of opening one more workload that competes for a slot.

Ported onto main by workload `wl-mvifaz8r8dieps` as PR #305, which merges #158's head a643caf and #264's head d8e2ed18 and supersedes #264.

**What changed.**
- Queued is a control entry, not a schema status (D1). The open tool writes `queued: <reason>` (prefix `queued`, writer the surface alone, `queuedBody` in `surface/src/launch.ts`) in the open's own transaction. `queuedOf` reads it: the workload is queued until its first `launch:` attempt of any cause. No schema change; `ledger/schema.sql` stays at its version.
- The cap (D2). `startedIdle` (`surface/src/rank-launch.ts`): open workloads, not the standing one, not `due:`, not queued, with a launch attempt or a slice, and no live holder. While more of them exist than `laneCap` (`AGENT_SYSTEM_MAX_LANES`, default 3), the open tool queues the ask. The ask is still a whole open workload, with its `done:`, `repo:`, ceiling and Jev ask.
- `intake` on `orchestrator_open_workload` (D3, `surface/extensions/workload.ts`). Omitted: the cap rule. `queue`: queued whatever the count. `now` with `inputId`: opens past the cap only on Jo's unspent input row, spent once inside the open's transaction (a surface `reading:` on the standing workload); without one it opens nothing.
- Queue order is rank order (D4). `queueOrder` is `rankOpen` filtered to queued workloads; `queuePosition` gives N of M. The open result reads `queued, position N of M (rank order; moves as ranks change)` after waiting for the ask's Jev signal under one deadline (`RANK_ASK_TIMEOUT_MS`), or `queued, then started at once: …` when a slot took it during that wait.
- The queue gate and the drain (D5, D6). `queueGate`, composed into `rankGate` / `decideRanked` in every `jevRank` mode (`show` included), admits a queued autonomous workload only when no queued autonomous workload ranked above it can launch now; otherwise `queued: position N`. `drainCandidates` / `drainPick` walk queued workloads in queue order, so two free slots launch the top two in one drain. Jo's `launch-requested:` and `as2 lane wl-…` are never gated and end the queued state.
- User-driven asks (D7) keep a queue position but never take a lane slot.
- What Jo sees (D8). The wake line and the one-liner of a queued workload carry `queued #N of M` (`surface/src/render.ts`); after its launch attempt the tag is gone. A queued workload is never a needs-you line: the held/no-lane warning skips it (`surface/src/errors.ts`), while a held lane message on it still surfaces. `tiers/orchestrator.md` tells Ilex to relay `queued, position N`, to pass `intake: "queue"` for every non-flow ask while Jo's flow-repair ruling (in-mvfiztvfi7ez28) stands, and to pass `intake: "now"` only with Jo's own input id.
- Flow signals unchanged (D9). A queued ask stays `status='open'`, so ROOT-CAUSE signal 2 still counts it. USER-GUIDE.md § *Intake queue* gives a separate read-only `sqlite3 -readonly` query for the queued count.
- Tests: `surface/test/intake-queue.test.ts` (new, manifest row added), `surface/test/render.test.ts` (the `queued #N of M` tag and its end at launch).

**Budget invariant batching.** The port's full suite exposed a five-second timeout in the aggregate `surface/test/decision-log.test.ts` byte-budget invariant. It keeps all 1,227 seeded budget cases and their assertions in independent batches of at most 16, with each fixture initialized once in `beforeAll`; no timeout or production-rendering change.

**Final-head close cases.** The port's full suite also exposed a five-second aggregate timeout in `surface/test/close-fresh.test.ts`. Its metadata-only and code-changing merged-PR scenarios now register as separate tests, preserving both fixtures, outcomes and every assertion under the existing timeout.

**After merge.** PR #305 carries #158's change, so no separate #158 merge is needed; pull after #305 lands. Run `install/install.sh` so the installed orchestrator tier (`{profile}/agent/agents/orchestrator.md`) carries the intake rule, then restart Ilex so the open tool's `intake` parameter and the render load. No config change: the cap reads the existing `AGENT_SYSTEM_MAX_LANES`.

**Out of scope.** A `queued` schema status (needs a schema version 6 and a ledger upgrade path); a second score or order for the queue; changing ROOT-CAUSE signal 2; deciding which asks are flow fixes (Ilex's judgment under Jo's ruling, prompt-only).

**Live acceptance.** After the merge, the install step and an Ilex restart: the next ask Ilex opens while started-but-idle workloads exceed the lane cap (or with `intake: "queue"`) gets a `queued:` entry, Ilex tells Jo `queued, position N`, the wake line shows `queued #N of M`, and when a lane frees the drain launches the queue top with cause `first`.

**Rollback.** Revert the PR. A queued ask is already an open workload; its `queued:` entry stays in the ledger as history, and Jo's launch word starts any of them at once.
