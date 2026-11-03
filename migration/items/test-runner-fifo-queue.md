---
title: Queued full-suite runs take the runner lock oldest request first
status: building
workload: wl-mvfutg9edknu2o
pr: 266
---
**Built on branch `wl/wl-mvfutg9edknu2o`, PR #266.** Workload `wl-mvfutg9edknu2o` (normal stakes, plan revision 3 at `~/agent-scratch/agent-system-2.0/wl-mvfutg9edknu2o/PLAN.md`, approved by Jo). It changes item 24's run lock (`Runner.acquire`, `surface/scripts/test-runner.ts`).

**Evidence.** A run waiting for the runs.db lock polled every 2 s, and whichever waiter polled first after a release took it. No waiter knew about any other. Jo saw runs requested around 21:2xZ and at 21:32Z passed over for more than 75 minutes by later requests (`msg-mvftk96yh3o4jk`, `msg-mvfuekpqr1siyo`).

**The fix.** runs.db gets a second table, `queue (runId TEXT PRIMARY KEY, workloadId TEXT NOT NULL, requestedAt INTEGER NOT NULL)`, created beside `lock` by `openLockDb`. `requestedAt` is the run's own `test-requested:` entry time in ms. Every acquiring attempt is still one `BEGIN IMMEDIATE` transaction. In it the run registers itself (`INSERT OR IGNORE`, so a row pruned while the run was suspended comes back at the same place) and scans the waiters ahead of it in (requestedAt, run id) order. A waiter is live while its request is unsettled and its heartbeat file is under 60 s old, or it has no heartbeat yet inside the 120 s startup lease (`queueWaiterLive`, `queueAhead` in `surface/src/test-run.ts`). Dead waiters ahead (no request, settled, dead heartbeat) are deleted; the first live one keeps the run queued. Then the holder check runs as before. Taking the lock deletes the run's own row, and a run that ends without the lock deletes it too. Stale-holder takeover, the startup lease, queued too long, the reservation and `publishIfOwner` are unchanged; a stale holder is now taken over by the oldest live waiter, not by the first poller.

**Mixed versions.** The `lock` table and every reader and writer of it are unchanged, so a runner still on the old code (any run live at deploy) keeps working against the same runs.db and ignores the queue: it can still take the lock out of order. FIFO is exact once every waiting runner runs the new code. A request whose runner has not reached its first acquiring attempt (milliseconds after spawn) is not yet in the queue.

**Tests:** `surface/test/test-runner.test.ts` (the lock queue: T1, a stale-holder takeover waits for the stopped oldest waiter, then A, B, C acquire in request order, failing on the base code; T2, the four dead waiter kinds are pruned and never block; T2b, live waiters that are no process do block; T3, a waiter pruned while stopped re-joins at its place) and `surface/test/test-run.test.ts` (`queueWaiterLive`, `queueAhead`).
