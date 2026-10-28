---
status: resolved
durable: true
author: plumb
date: 2026-10-28
---

# A test depends on timing only when timing is under test

## Decision

**Jo, 2026-10-28, about 8:40 AM PDT:** "that's defo a rule for lanes make it fucking immortalized and back it with machinery if we can."

The rule: **a test may depend on timing only when timing is the thing under test.** Otherwise it waits on the real event or condition, or calls the logic directly: no fixed sleeps, no tuned timeouts, no wall-clock races. When timing is the subject (a deadline, a stuck-detector threshold, a lease expiry), the test drives it with an injected or fake clock, so the machine's speed cannot change the result, and marks it:

```
// timing-under-test: <what timing behaviour is under test> (fake clock: <name>)
```

**Scope:** every test in as2, written by any lane, hand or seat.

## Why

as2's full suite kept going red on the merge train with tests that pass alone. They were timing-dependent tests failing on a loaded Mac at clamped priority (see `2026-10-28--0150--plumb--train-tick-runs-at-standard-priority.md`), and the fast check moves many tests to GitHub-hosted runners, which are slower and noisier still. A test that races the clock fails by the machine's load, not by the code's behaviour.

## How it is binding

1. **The rule text:** `tiers/lane.md` § "Timing in tests" (every lane loads it at start), and the same section in `tiers/fast.md`, `tiers/standard.md`, `tiers/strong.md` and `tiers/deep.md` for the hands that write the tests.
2. **The machinery:** `surface/test/timing-lint.test.ts` scans every `*.test.ts` in the repository with `surface/src/timing-lint.ts`, whose header defines each pattern: `sleep`, `timer`, `race`, `clock-assert`, `clock-elapsed`, `clock-deadline` and `test-timeout`. It is in `testRunner.fastSmoke` (`profile/config.yml`), so every pull request's fast check runs it, on the Mac and on GitHub.
3. **The opt-out** must give a reason and name a fake clock that appears as code in the covered test; a real clock, a missing clock and an opt-out that covers nothing are each reported. The clock check is by name, not by proof, so review judges whether the named clock is really fake.
4. **The ratchet:** `surface/test/timing-baseline.tsv` lists the offenders that existed when the rule was made (93 findings in 24 files at origin/main 4c1a6e5), by file, pattern and count. It only shrinks: a new finding fails the check, and so does a fixed one until its row is lowered or deleted in the same commit. The baseline total may not exceed `BASELINE_CEILING` in the test.

## Rejected

A P-11 gate row refusing a lane commit that adds an offender. The test already runs on every PR before merge, and a row sees tool calls, not trees: it would have to rebuild the commit's tree from a `git commit` command line and re-run the scan inside the gate, a large row for a check the merge gate already makes.
