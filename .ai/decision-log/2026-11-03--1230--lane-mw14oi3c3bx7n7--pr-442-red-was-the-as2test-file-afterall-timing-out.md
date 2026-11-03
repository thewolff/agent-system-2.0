---
status: resolved
durable: false
author: lane-mw14oi3c3bx7n7-1
date: 2026-11-03
---

# PR #442's red full run was the as2test.test.ts file-level afterAll timing out, not a defect in the PR

## Decision

Merge-train task tt-mw14mi0lswkg7q (train wl-mw05au5wioxw4a) returned PR #442 red at head e4637ddb. Fix workload wl-mw14oi3c3bx7n7 changes no code: this entry gives the PR a new head, and the train works it again there.

## Why

- Run tr-0mw138m2ntnse4p failed one case: `surface/test/as2test.test.ts > (unnamed)`, "a beforeEach/afterEach hook timed out for this test." after 5028 ms (full.log, the line after the "--help says a corrupt sweep.db is repaired" pass). The file run alone in the same run passed 111 of 111.
- The only hook in that file is the file-level `afterAll` that releases abandoned cases, re-hashes every template tree and removes it (added by PR #430, commit 071c28c1, "as2test fixtures own their cleanup"). It ran past Bun's default 5 s hook timeout under full-suite load.
- PR #442's diff against origin/main touches only files under `.ai/decision-log/`; it touches neither that test nor anything it exercises.
- The same "(unnamed)" hook timeout in as2test.test.ts appears in earlier red runs (tr-0mvr3slyqkgbzac, tr-0mvskhqnl998o93, tr-0mvskxpfhjxpixi, tr-0mvtwa5xl147t4h); this run is the first since #430 landed.

## Dead ends

- Fixing the hook on this docs PR: raising its timeout is a tuned timeout the timing rule forbids, and making the template check cheaper is test-timing work outside a decision-log batch. Reported to the orchestrator for its owner instead.
