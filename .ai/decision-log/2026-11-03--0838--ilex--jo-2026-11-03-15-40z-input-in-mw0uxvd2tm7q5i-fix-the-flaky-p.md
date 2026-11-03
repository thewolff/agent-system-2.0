---
date: 2026-11-03T08:38-08:00
engineer: Ilex
session: wl-mw0uy5obrqir4w
status: resolved
durable: false
supersedes:
workload: wl-mw0uy5obrqir4w
---

# Jo (2026-11-03 ~15:40Z, input in-mw0uxvd2tm7q5i): fix the flaky printf property test that turned main red at cee14f65 (run tr-0mw0nuddeukx8vy).

Failing test: gates/test/printf-property.test.ts, "printfOutput matches bash printf on every form it evaluates". Mismatch: ["\n%b\7%02d"] gate="\n\u000700" bash="". Inputs are seeded (rng(20260929)), so the same case passes on other runs; the gate's own output is correct.

Cause (Jo's diagnosis): the test helper bashPrintf (around line 49) runs spawnSync("bash", …) and returns stdout without checking r.error, r.status or r.signal. A bash spawn that fails under full-suite load reads as empty output and is reported as a gate mismatch.

Change: fix the helper so a failed or killed bash spawn is retried a bounded number of times, then fails with the real spawn error. It is never compared as "". Do not change the gate's printf code or the seed.

Done when: a test proves a simulated failed spawn is no longer counted as a mismatch, and the full suite is green through lane_full_test.

Verification constraint: verify only through lane_full_test. No direct `bun test surface/test/as2test.test.ts` until PR #430 lands (host-wide /private/tmp/as2test-refresh.* collision).

Ceiling: small (Jo's word).

## How it fails
- The retry hides a real gate mismatch. Surfaces in the new test. Recovery: a successful bash run whose output differs from the gate must still fail the property test, and the lane's test asserts this. Retry bound: none; this is a correctness requirement.
- Bash keeps failing past the retry bound. Surfaces as a test failure naming the spawn error (r.error, status or signal), not as a gate mismatch. Recovery: the lane reports the error. Retry bound: the helper's bounded retry count.
- lane_full_test comes back red on an unrelated flake or as2test collision. Surfaces in the run's failures. Recovery: diagnose; re-run only if the failure is outside this change. Retry bound: 2 runs, then message the orchestrator.

done: The printf property test helper retries a failed or killed bash spawn a bounded number of times and then fails naming the spawn error instead of comparing "", a test proves a simulated failed spawn is not counted as a mismatch while a differing successful bash output still fails, and the full suite is green through lane_full_test on the PR.
done-because: gates/test/printf-property.test.ts bashPrintf now succeeds only on no error, null signal and status 0, retries a failed or killed spawn at once up to BASH_ATTEMPTS=3, then throws naming every attempt's error/status/signal/stderr; a failed spawn's stdout is never compared (commit 08c29dc8, PR https://github.com/thewolff/agent-system-2.0/pull/438). Fake-spawn tests prove EAGAIN-once is not a mismatch, a differing successful output is still one mismatch, and exhausted EAGAIN/SIGKILL/status-1 throw after 3 attempts; fails-before copy fails 4 of 5 new tests (/Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mw0uy5obrqir4w/fails-before/fails-before.log). Cross-lab review sl-printf-review: no findings. Full suite green at 08c29dc8 via lane_full_test tr-0mw0vda2ltgher9: 7941 pass, 0 fail, 134 skip.

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode autonomous, opened 2026-11-03T15:43:47.003Z.

## What changed

- sl-printf-plan: Plan the bashPrintf spawn-failure fix: slice cut, requirements with enforcers, How it fails; cross-lab plan review — artifact: Jo approved q-mw0v4v4rnan1hz (in-mw0v9unh3aev71); plan /Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0uy5obrqir4w/PLAN.md, review /Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0uy5obrqir4w/PLAN-REVIEW-r1.md
- sl-printf-fix: bashPrintf spawn seam with 3 immediate attempts and a named spawn error; shared bashMismatches; fake-spawn tests; fails-before proof in scratch — artifact: bun test gates/test/printf-property.test.ts -> 8 pass 0 fail (lane run); fails-before copy 4 fail as expected: /Users/jowolff/agent-scratch/agent-system-2.0/scratch/wl-mw0uy5obrqir4w/fails-before/fails-before.log; timing-lint 12 pass (hand run)
- sl-printf-review: Cross-lab findings-only review of the committed diff against PLAN.md — artifact: sl-printf-review cross-lab review of 08c29dc8: review-findings {"findings":[]}; transcript history://sl-printf-review
- sl-printf-pr: Merge origin/main, run declared artifact on final tree, push wl/wl-mw0uy5obrqir4w, open PR — artifact: https://github.com/thewolff/agent-system-2.0/pull/438 at 08c29dc8 (contains origin/main cee14f65); bun test gates/test/printf-property.test.ts -> 8 pass 0 fail on that tree
- sl-full-mw0uy5obrqir4w-1: full suite outside the fence at PR #438 — artifact: test-run tr-0mw0vda2ltgher9: green at 08c29dc8e76e7a792aafb88aadb3613fc4e10c84 on PR #438; full 7941/0/134; alone: none; /Users/jowolff/.agent-system-2/test-runs/tr-0mw0vda2ltgher9

## Decisions made (and why)

- jo answered "approve" to q-mw0v4v4rnan1hz (/Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0uy5obrqir4w/PLAN.md
- sl-printf-fix: bashPrintf spawn seam, 3 immediate attempts, throw naming error/status/signal/stderr; shared bashMismatches; fake-spawn tests
- sl-printf-review: cross-lab findings-only review of the settled diff against PLAN.md
- sl-printf-pr: merge origin/main, declared artifact, push, PR, lane_full_test green
prompt-only: R4: gate printf code, seeds and generators unchanged; checked in diff review, no test pins a file left alone
tradeoff: success = no error, no signal, status 0; probe: all 478 compared cases exit 0, a future non-zero case would throw
tradeoff: retries are immediate (timing rule forbids sleeps), so a sustained load spike can still exhaust 3 attempts
review: pass, sl-printf-plan cross-lab strong hand, /Users/jowolff/agent-scratch/agent-system-2.0/wl-mw0uy5obrqir4w/PLAN-REVIEW-r1.md)
- assumption (orchestrator-surface): brief-judged: change-large confidence 0.73 judge typesafe/jev-1.13.0
- assumption (classifier): pair-exposure: lane-mw0uy5obrqir4w-1 on
- assumption (classifier): pair-signal: taste no 1 ambiguous no 0.96 judge typesafe/jev-1.13.0 tokens 1062 cost 0.000044604
- assumption (lane-mw0uy5obrqir4w-1): builder-lab: anthropic lane lane-mw0uy5obrqir4w-1 model anthropic/claude-opus-5-5
- assumption (lane-mw0uy5obrqir4w-1, sl-printf-plan): hand-spawn: dt-mw0v0baq57967334 session /Users/jowolff/.agent-system-2/lanes/wl-mw0uy5obrqir4w/sessions/2026-11-03T15-43-51-579Z_01a1a214-c11b-7000-9eb6-daa3c80af5f6 spawn sl-printf-plan review yes group dg-mw0v0baq64fb801e row openai-codex/gpt-6.1-sol
- assumption (lane-mw0uy5obrqir4w-1, sl-printf-plan): hand-settled: dt-mw0v0baq57967334 routing rt-mw0v49cz8wzw78
- assumption (lane-mw0uy5obrqir4w-1, sl-printf-plan): review-round: sl-printf-plan round 1 token dt-mw0v0baq57967334 group dg-mw0v0baq64fb801e verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{"tests":1},"minor":{}},"titles":[{"severity":"major","kind":"tests","title":"Add an exhausted error-set spawn case to prove the required spawn-error diagnostic"}]}
- assumption (lane-mw0uy5obrqir4w-1, sl-printf-plan): review-loop-end: sl-printf-plan reason pass
- assumption (lane-mw0uy5obrqir4w-1, sl-printf-fix): artifact-command: bun test gates/test/printf-property.test.ts
- assumption (lane-mw0uy5obrqir4w-1, sl-printf-fix): hand-spawn: dt-mw0vaedo7c8630bc session /Users/jowolff/.agent-system-2/lanes/wl-mw0uy5obrqir4w/sessions/2026-11-03T15-43-51-579Z_01a1a214-c11b-7000-9eb6-daa3c80af5f6 spawn sl-printf-fix review no group dg-mw0vaedo1e14bcdf row anthropic/claude-opus-5-5
- assumption (lane-mw0uy5obrqir4w-1, sl-printf-fix): hand-settled: dt-mw0vaedo7c8630bc routing rt-mw0vc70lukpoge
- assumption (lane-mw0uy5obrqir4w-1, sl-printf-review): hand-spawn: dt-mw0vclt2c0e24946 session /Users/jowolff/.agent-system-2/lanes/wl-mw0uy5obrqir4w/sessions/2026-11-03T15-43-51-579Z_01a1a214-c11b-7000-9eb6-daa3c80af5f6 spawn sl-printf-review review yes group dg-mw0vclt2bcdb35d8 row openai-codex/gpt-6.1-sol
- assumption (lane-mw0uy5obrqir4w-1, sl-printf-pr): artifact-command: bun test gates/test/printf-property.test.ts
- assumption (lane-mw0uy5obrqir4w-1, sl-printf-review): hand-settled: dt-mw0vclt2c0e24946 routing rt-mw0ve57zha0z9r
- assumption (lane-mw0uy5obrqir4w-1, sl-printf-review): review-round: sl-printf-review round 1 token dt-mw0vclt2c0e24946 group dg-mw0vclt2bcdb35d8 verdict accepted blocking 0 counts {"counts":{"blocking":{},"major":{},"minor":{}},"titles":[]}
- assumption (lane-mw0uy5obrqir4w-1, sl-printf-review): review-loop-end: sl-printf-review reason pass

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
