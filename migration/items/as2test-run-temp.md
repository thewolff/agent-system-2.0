---
title: as2test per-run temporary isolation and legacy native sweep
status: open
workload: wl-mvgrfniqa0kd8g
pr: 289
---

## Why

Jo recovered the full disk by deleting 1,305 `_as2test` native extraction directories. The deployed `env -i` exec wrapper had no `TMPDIR`. Separately, `laneRoot` rebuilt its descendant environment without a temp or Bun cache root, and fake OMP used the host Text loader, causing eager `@oh-my-pi/pi-tui` resolution instead of the existing offline renderer fixture. The failure chain is recorded in the incident findings under **Cause 1**; the source anchors are `laneRoot`, fake OMP's `orchestratorSurface` call, and `surface/index.ts`'s `hostText`.

## Change

- `renderExecWrapper` fences and validates paths before creating `runs/<id>/.wrapper-tmp` with mode 0700, then passes it to Bun in the cleared environment. Run cleanup removes it with the rest of that run. Prepare recognizes only the wrapper bootstrap state and remains exclusive; existing arbitrary/partially prepared run directories are not adopted.
- The real UID sweep verifies it is running as `_as2test`, kills that user's test processes, then sweeps only immediate physical `/private/tmp` directories in the legacy `.hex-hash-hex-counter.pi-natives-darwin-arm64` family, owned by that exact UID, with mtime strictly earlier than five minutes ago. Other owners, recent entries, other families, symlinks and changed identities survive. Group-scope fixtures never inspect this shared directory.
- `laneRoot` creates fixture-contained temp/cache roots. Its fake OMP launcher disables runtime auto-install, and fake OMP injects `loadTestText`, so cold-cache tests no longer pull host terminal/native packages.

## Deployment

The existing root-owned refresh helper installs only origin/main. After merge, normal runner preflight refreshes the wrapper and test-exec bundle when it detects these changed inputs; this change does not require a new sudoers rule or account. Any explicit privileged refresh is delivered to Jo as a single preview/confirm/log/undo script, not executed by the lane. Existing in-flight runs retain their already-started process environment; the new wrapper applies to subsequent commands.

## Verification

- The descendant smoke failed before the fixture fix with `/tmp` and no cache, then passed with contained paths and cold-cache fake startup using `--no-install`.
- Real rendered-wrapper smoke observed distinct private per-run startup temp directories before script execution, removed an older run's temp tree via real cleanup, and preserved the current run.
- Isolated legacy fixtures exercise age/UID/name boundaries and preserve symlink targets; no test invokes the production shared-temp sweep.
- The lane's fence denied `ps` in a lane-script lifecycle test, before fake OMP started. The outside-fence full runner is required for that integration coverage; do not weaken the liveness check to make an in-fence test pass.

## Rollback

Revert this change and let the existing refresh helper install the reverted origin/main. An explicit operator deployment script also preserves the previous installed wrapper, bundle and SOURCE and can restore them under the helper's `refresh.d/lock`, with the required 0755 installed modes. That snapshot undo is temporary: the next runner preflight reapplies main on input drift; a lasting rollback requires reverting main. Rolling back restores the temp-leak risk; it does not recreate Jo's already-deleted legacy extraction directories. No live session history or open-workload scratch is deleted by this migration.
