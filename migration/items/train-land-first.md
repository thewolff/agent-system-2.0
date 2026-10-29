---
title: Fast PR checks gate merges while the full suite verifies main after landing
status: building
workload: wl-mvq4edbaf13vnk
pr: 369
---

**Purpose.** Land-first changes the merge train from repeated full-suite PR checks to a small hosted check before merge and a full Mac suite on main after landing. This item records the operator contract and its activation sequence.

## Fast PR check and full main check

For each PR head with current main merged in, the runner computes the transitive fast set: tests importing changed files, tests that name changed files, tests importing those tests' changed dependencies, and the configured smoke files. Changed TypeScript/JavaScript files are transpiled without execution. The hosted fast check runs on GitHub-hosted Ubuntu; all selected Linux tests must execute. `as2/full-suite` remains the same strict required status, must be on an up-to-date head, and is posted only by the runner. A fast green is not a full-suite result.

After each landing the runner runs the full suite on Mac main, coalescing requests to the newest main commit. The verdict is immutable per commit: green, red, or implausible; inconclusive attempts are bounded. Landing stops when main is red or unknown, or too many commits are ahead of the last verified green. One loud incident names the suspect landings since that green and the evidence, then directs recovery. Landing resumes only after a green believable main or a designated repair has been confirmed.

## Exceptions and holds

Schema migrations (`ledger/schema.sql` or the `SCHEMA_VERSION` line) and changes to files whose basenames are configured in `fullBeforeMerge` require the full Mac suite before merge. Production stakes alone are not an exception: production PRs take the same fast check and run the full Mac suite on main after merge (Jo's in-mvrb4j2tvie8zz). Production signoff accepts a current-head fast green while land-first is enabled; its Jo, review and protection requirements remain unchanged. The 13 macOS-only and five Linux-portability test files run only in the post-merge Mac suite, with the reasons in `profile/config.yml`. The fifth, `surface/test/test-runner-smoke.test.ts`, was found by the hosted Ubuntu run of 2026-10-28. The zsh and bubblewrap tests remain in the hosted fast check; its workflow installs both.

A red or unknown main is a hold, not permission to keep merging. A regression wakes repair; an infrastructure stop waits for the runner or infrastructure to recover. Each commit gets bounded blocks of three inconclusive attempts. When a block is exhausted, the tick alerts once and stops retrying until Jo says `main-retry <repo>`, which opens the next bounded block. A red or implausible verdict is never retried for that commit. Recovery is restartable from ledger state and retained run evidence; errors and fallback reasons are explicit.

The strict `as2/full-suite` ruleset is unchanged. `lane_full_test` keeps its name and invokes the runner gate: on land-first repositories it runs the fast check unless a schema or `fullBeforeMerge` exception requires full scope. Close coverage is unchanged in principle: a merged fast-green PR is covered by a green believable main run on its merge commit or a later main commit. The runner still owns the full-suite slice semantics; a green full result completes that slice, timeout is an error, and diagnostic solo runs never turn a red full result green.

## Activation and recovery

Activation is a ledger word, not a profile flag. After this workflow lands, keep land-first off and run shadow mode until a real green believable main verdict establishes verified commit G and the `as2-verified` tag; retain the main-run receipt. **Only then** Jo reruns `install/as2test-setup.sh` and runs `install/install.sh --control-root=verified`. A setup rerun before the tag exists breaks the refresh sequence. Never infer that live setup ran from a documentation change.

Believable counts the tree's test files minus `testRunner.mainSkip` in `profile/config.yml`: the 10 files that need an installed OMP skip every test under `_as2test`, so with them counted no main run could reach 95 % of files (185 of 195 is 94.9 %). Each listed file still runs in every full suite and still turns a run red when it fails; it only stops counting toward the 95 %.

Before Jo says `land-first agent-system-2.0 on`, complete the proof deferred from the build by Jo's `in-mvr66z3o61b7qe`:
- Dispatch the real hosted fast workflow against a real PR head through the verified ref, retain its run URL and artifact, and judge its JUnit against the selected Linux set.
- Measure the fast sets for the last 20 code landings and retain their actual Linux execution seconds. A changed-path replay on the current graph or selection milliseconds is not Linux runtime evidence.
- Retain the real shadow-main verdict, setup/install outputs, verified root/tag/bundle/preflight checks, and hosted/timing receipts together. Keep land-first off if a proof fails or evidence is missing; fix the named failure and repeat the affected proof before enabling.

If setup, tag refresh, verified-root promotion, preflight, or installation fails, fail loudly: retain the command output and run evidence, keep land-first off (or let the existing hold refuse activation), fix the named failure, then restart the appropriate setup/promotion step and verify the tag, `verified/current`, bundle source and runner preflight before issuing the activation word. Do not conceal failure with a fallback or manually fabricate a green/tag. `main-retry <repo>` is for an exhausted inconclusive infrastructure block after repair, not for red verdicts.

### Requested off versus completed off

`land-first <repo> off` atomically records Jo's instruction, the raw off word, and a `land-first-off-pending: <repo> <instruction>` marker. Its acknowledgement says **off requested**. Fast/tree publications then fail the live activation guard; normal merges remain held even though the raw activation word is off.

The tick and runner share a repository publication mutex. A separate SQLite file derived from the configured runs database keeps network calls outside ledger transactions. Open-head listing, status reads and provenance classification happen outside the mutex; each final activation check/status post and the final off-completion write use short, deadline-bound sections. The tick identifies fast checks and tree carries from actual runner admission plans (a tree carry can have a full-scope result), then revokes their successes. Genuine full-suite results remain untouched. Only after successful reconciliation does a short ledger write record `land-first-off-complete: <repo> <instruction>`; releasing this pending marker is not another activation word.

One failed head does not hide another: each is reported, no completion is recorded, and the next scheduled tick retries remaining successes once per head. A listing, provenance, ledger or mutex failure leaves the hold pending with its failure visible. Each explicit off-instruction block allows three reconciliation attempts; exhaustion keeps merges held, stops automatic network retries and names the repair step. After fixing the reported failure, Jo says `land-first <repo> off` again to start a fresh block. Off failures do not consume the normal landing-revocation retry budget. Repeated off requests have separate instruction ids, so completing an older request cannot clear a newer one. A later on takes effect only after all requested revocations reconcile, never by clearing pending markers. Legacy off records without a pending marker remain off without a synthetic migration.


## Non-land-first behavior

With land-first off, existing strict full-suite behavior remains: PR requests run the full suite and `as2/full-suite` is the merge gate. Shadow main runs and verifier promotion do not gate merges. No hosted fast-only green may substitute for the existing full-suite status.

## Deliberate scope boundary

The residual adversarial class in which a lane deliberately routes around the merge hold is out of scope by Jo's ruling; this plan addresses normal, non-adversarial paths. The readable-call hold remains a lone foreground merge command, and every other readable merge request remains reserved for Jo.
