---
title: Test-timing audits, finite isolated proof series and measured resource admission
status: building
workload: wl-mvtueivmiujnom
pr: none
---

## Scope

This is the tools cause batch, not completion of the eight-cause timing-fix workload. It reuses `surface/src/timing-lint.ts` rather than adding a second timing policy. The other causes still need their own reviewed fixes, fixed isolated series and train landings.

`USER-GUIDE.md`, under **Timing audits and proof series** and **Resource and installed-OMP provisioning**, documents the command interface and rollout boundary.

## Changes

- `scripts/timing-audit.ts` reconciles historical/current/pinned-main inventories, emits current static findings separately from lexical subprocess observations and generates exact shrink-only baseline updates. Apply requires both baseline and scanned-source hashes.
- `scripts/timing-rewrite.ts` admits restricted source-range transforms after whole-source Bun syntax admission. It emits semantic case mappings and refuses stale hashes, unsupported shapes, timeout/skip edits and speculative readiness/clock injection. The parser has no dependency on the operator's package cache.
- `scripts/timing-proof.ts` submits/inspects manifests through the existing runner. Two proof-only tables in the existing `runs.db` preserve manifests and immutable iteration identities. They do not duplicate the execution lock or use normal `test-requested`/`test-run` settlement.
- File series use five baseline and twenty candidate isolated runs per file. Final full series require five fresh full executions and cannot consume main/PR greens, carry or cache results. A two-solo smoke has `completionProof: false`.
- Each iteration joins the ordinary FIFO and releases it before its next iteration. Actual JUnit identities, candidate budgets, setup/cleanup markers, executor argv, resource receipts and containment/removal are checked. Assertion-red baseline observations may continue; candidate red, interruption or incomplete evidence ends the series. Reusing a failed candidate through changed labels, budgets, diagnosis or workload is refused.
- Cleanup retains the existing self-cleanup guard: after verified containment and evidence import, the same lock/current ownership transfers to a cleanup-only identity before removing the successful iteration's world. Interrupted transfers preserve evidence and are recovered by the next ordinary owner.
- `surface/src/test-resources.ts` admits a positive worker count from CPU/current-memory inputs and explicit measured worker/reserve costs. `fullWorkers` is a ceiling, never a forced count. Actual Bun file/case scheduling controls and selected inputs are frozen per part in `<part-stem>.resources.json`. Nested subprocess costs must be included in calibration; Bun's concurrent-case limit is not an OS process limit.
- Proof caps admit only `productionBudget` and `installedOmp` booleans. The production flag reaches only admitted proof children. Installed OMP requires the actual `_as2test` identity and a root-owned, verified self-contained runtime tree; a manifest cannot select paths, commands, credentials or another user.

## Deployment hold

Do not land/activate this executor before a measured policy is additively provisioned. The new ordinary execution path refuses missing `resources.json`, so activation refuses it first (review F2): setup refuses before its plan, before replacing any installed wrapper, bundle, bun, helper or SOURCE (a legacy SOURCE included), unless `--resources` names a valid measured policy or a valid root-owned one is already installed; the refresh helper refuses (exit 71) to fetch without a regular root-owned `resources.json` no group or other can write; and the fetched commit's `render-exec` refuses an absent or invalid policy, which holds under a helper installed before that check. A host without the policy therefore keeps its working install and reports `bundle-refresh-failed` until provisioning, rather than activating an executor that fails every admission. The current lane has not performed privileged provisioning or claimed a calibrated production policy.

The host observer must measure an already-admitted ordinary serial run on the existing executor, not invoke the new proof path to manufacture its own calibration. Record actual worker/controller/descendant peaks, host load and the historical utility-load reservation methodology. Sample maxima are observations, not automatically safe costs. Keep the raw evidence and an explicit reviewed safety assumption with the policy's calibration receipt.

Setup adds previewed `--resources=/absolute/measured-policy.json` (required unless a valid one is installed, which a re-run keeps; installed first, before bun, the helper and SOURCE) and optional `--omp-artifact=/absolute/verified-tree --omp-version=<exact-output>`. Provisioning copies and hashes the runtime and pins its root-owned configuration without downloading packages. Known limit: the runtime's staging copy, chown and chmod into `<libexec>/.omp.new` run before the copied content is hashed; the hash catches a copy that differs from the previewed artifact, but adversarial race safety during those steps is not established and is not claimed. A different existing runtime is not silently overwritten. Any privileged operation still needs its own authorization. The refresh fetches only `refs/tags/as2-verified` from the fixed origin and builds the commit it names, not simply origin/main: the runner points the tag after a green believable main run, and land-first reconciliation may point it at the admitted head. It cannot activate an unpublished candidate worktree.

A shadow-root run verifies source behavior, not actual `_as2test` host isolation. Installed-OMP completion requires the real identity, pinned runtime, sanitized descendant environment, executed changed cases and setup/cleanup, with credential/home denial evidence. No operator-user or `mainSkip` substitute counts.

## Verification observed before review

- Automation and linter: 49 passing cases, zero failures. Actual audit CLI returned `review-required` with no ratchet errors and explicit newly unclassified files; historical classifications were not presented as fresh runtime evidence.
- Resource admission: eight passing cases. The real rendered-wrapper boundary selection passed four cases for resource receipts, concurrent-case serialization, missing-policy failure, proof-only environment and operator-runtime refusal.
- Provisioning shell syntax passed. The actual `validate-resources` CLI accepted an explicitly synthetic schema-smoke input; that input is neither measured nor approved for installation.
- Proof state/admission: nine passing cases after a failing-before regression exposed same-candidate replay through changed budget/diagnosis. The guard now refuses that replay across workloads sharing the served file.
- Queued lifecycle: eleven passing cases after diagnosing an initial `SQLITE_BUSY` from a new observer that reused the test suite's intentional zero-wait fault-injection connection. New proof observers now use the existing production SQLite contention policy; no test completion timeout was raised. The selected invocation also reported six skips outside its requested new cases; it is targeted coverage, not a skip-free full-suite result.
- New queued cases exercise actual submit/inspect and two distinct solo executions, environment descendants, queue fairness, five fresh fixture full executions despite an existing green, failure retention and two crash boundaries. Tiny fixture full executions are not the final five real full suites.

Full-suite, deployed-host calibration/activation and completion series remain unobserved. Review findings and later runtime receipts must be recorded before this item becomes done.

## How it fails

Invalid manifest/ref/tree/case evidence is rejected with the named series/iteration/file and preserved artifacts. Failed and interrupted attempts are terminal; recovery never retries a started attempt. A renamed-current/uncommitted-lock crash is recovered by republishing the next actual owner's current fence before execution. Cleanup errors remain alongside original errors. Failed worlds and imported proof evidence are retained rather than erased.

Missing/malformed calibration, unavailable resource readings, zero admitted workers or untrusted/runtime drift fail before tests launch and retain an error resource receipt. The recovery is to diagnose capacity or repair reviewed provisioning, not force one worker or raise a deadline. Fixed-load startup/teardown has bounded readiness/reaping and reports launch plus cleanup failures together.

An absent or invalid measured policy at activation stops setup (`as2test-setup: no measured resource policy …` or the named validation/owner/mode reason, `Nothing changed`, exit 1, no sudo call) or the refresh (`as2test-refresh: … resources.json … nothing was fetched or installed`, or `as2test: render-exec: refusing to render an executor that cannot admit a test part: …`, exit 71, surfaced by the runner as `bundle-refresh-failed`). In each case the installed wrapper, bundle and SOURCE are unchanged; the recovery is to measure and re-run setup with `--resources`, then let the runner refresh.

The new proof test worlds are retained when their case fails, rather than being removed by the file's ordinary afterAll. No skips, retry-until-green loop, CPU-time wall-clock substitution or no-CPU-progress enforcement policy is introduced by this batch.

## Reversal

Revert the tools source change and let the existing trusted refresh install the reverted commit once `refs/tags/as2-verified` names it. Keep proof manifests, attempts and cited raw receipts for diagnosis; do not delete runs.db or manufacture an empty history. Additive resource/runtime artifacts should remain until no installed wrapper depends on them; a helper installed by this setup also refuses to refresh without `resources.json`, so keep the policy installed while that helper is. Any later removal or restoration of privileged artifacts needs a separate previewed operator operation. A lasting rollback changes main and the tag; restoring an old installed bundle alone would be overwritten by the next drift refresh.
