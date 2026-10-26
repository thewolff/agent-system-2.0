---
title: Split lane-script.test.ts so it no longer sets the floor of a parallel full pass
status: open
workload: none
pr: none
---
Deferred from workload `wl-mvg2kzuvwngdmo` by Jo's word (in-mvg5jvjprdc2dc, 2026-10-20), so the parallel full part (`migration/items/test-runner-parallel-files.md`) could ship first.

**Why.** `surface/test/lane-script.test.ts` takes about 290 s, 30 % of a serial full pass (measured 2026-10-19, `MEASURE.md` in the workload's plan directory). Under `bun test --parallel=6` one file runs on one worker, so it sets the floor of the pass. The projection (a model, not a measurement) puts a 6-worker pass at about 340 to 357 s as is and 204 to 224 s with the file split in three.

**What.** Split it by its six top-level describes (about 17, 109, 90, 9, 31 and 25 s) into three files of about 126, 90 and 65 s, with the shared fixtures in a helper module beside them. Each file keeps its own `roots` list and its own `afterAll` drain, settle and removal. Test bodies stay as they are. A static name-inventory diff (old file at base against the three new files) must match one for one. The new files need `install/manifest.tsv` rows, and the old row goes.

**Prior work.** A first cut is kept at `~/agent-scratch/agent-system-2.0/wl-mvg2kzuvwngdmo/split-deferred/` (three test files, `lane-script-fixtures.ts`, and `name-diff.ts`, which exited 0 at 61 of 61 declarations). It was not run to green: lane-script tests time out inside a lane fence on the unchanged file as well, so only the outside-the-fence runner can prove it.
