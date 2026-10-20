---
title: Daily Jev re-rank of both backlogs with resumable project-board sync and undo
status: building
workload: wl-mvh42n85yo0m4g
pr: https://github.com/thewolff/agent-system-2.0/pull/299
---

## Purpose

This item documents the daily Jev re-rank of open issues in `thewolff/jo-issues` and `thewolff/agent-system-2.0`, plus synchronization of the `thewolff` project board. It adds a manual command and optional hourly catch-up scheduling on macOS and Linux. The board token is isolated to board GraphQL reads and writes; issue-list and comment calls use the active GitHub account, and the command never switches GitHub accounts.

## Run and inspect

Run `as2 backlog-rank` for the due run. It ranks both backlogs, synchronizes the board, and records one result comment on `thewolff/jo-issues#153` per run. The normal due check skips an already successful or abandoned run on the current local day. `as2 backlog-rank --now` resumes any unfinished run first, then starts a fresh run even if today's run already finished.

`as2 backlog-rank --dry-run` prints the proposed order, scores, skipped pins, and board diff without writing to GitHub or posting a comment. It may append newly received Jev answers to the local cache. It requires a configured goals file. `as2 backlog-rank --undo <backup.json>` reconciles the board's item set, writable values, and archive state to that run's backup; if interrupted, run the same command again to finish. Undo prints differences in content-derived fields that it cannot restore as well as any writable values that remain unrestored.

## State and configuration

State lives in `$AGENT_SYSTEM_BACKLOG_RANK_DIR`, or by default `$HOME/.agent-system-2/backlog-rank/`, on macOS and Linux. Create `goals.md` there with one `goal:` line per goal; a missing file or no goal lines refuses a run. Jev reads these goals as written. Optional `pins.json` is a JSON array of `{ "repo": "jo-issues" | "agent-system-2.0", "number": N, "position": P, "why": "..." }` objects. Positions are exact, 1-based slots: open pinned issues stay at those positions and other issues fill the gaps in Jev order. Invalid, duplicate, or impossible placements refuse before Jev or board writes. Closed or missing pinned issues are skipped and reported without moving other pins.

Jo's current placements are:

```json
[
  { "repo": "jo-issues", "number": 174, "position": 1, "why": "Jo's pinned placement" },
  { "repo": "jo-issues", "number": 173, "position": 3, "why": "Jo's pinned placement" },
  { "repo": "jo-issues", "number": 170, "position": 5, "why": "Jo's pinned placement" },
  { "repo": "jo-issues", "number": 172, "position": 6, "why": "Jo's pinned placement" },
  { "repo": "jo-issues", "number": 168, "position": 10, "why": "Jo's pinned placement" }
]
```

`cache.jsonl` stores validated Jev answer sets by issue text, filed date, goals, and question version. Unchanged inputs reuse cached answers across days; an edited issue or changed goals require a new answer. A failed or malformed answer fails before board writes. Run state is under `runs/<run-id>/`: `order.json` is the ranked order, `backup.json` is the pre-mutation board snapshot, `attempts.jsonl` records attempts and writes, and `jev.jsonl` records Jev call metadata. `last-run.json` tracks the latest run. A transaction held in `lock.sqlite` prevents overlapping invocations and releases automatically on process exit; `lock` contains diagnostic metadata only and is never stale-owner authority. Keep this directory writable and backed up: it contains the undo material and resumable state.

Backups contain all board field values, including archived items. Undo restores the item set and writable item-level values (text, number, date, single-select, iteration, and supported multi-select fields), plus archive state. Labels, assignees, milestones, repository, linked PRs, reviewers, titles, and issue fields are content-derived from the issue and are not written by this tool; undo reports their differences rather than changing the issue. Preserve each run's backup before making any manual board changes you may need to reverse.

The snapshot is flushed to a temporary file and published without replacing an existing backup. Its SHA-256 checksum, structure and project identity are validated before mutations, including on retries. Keep `backup.json` unchanged: an incomplete or modified backup refuses mutation rather than being silently replaced.

## Optional hourly catch-up

`bash install/install.sh --backlog-rank` installs and loads the hourly job: launchd on macOS and a systemd **user** timer on Linux. `bash install/install.sh --backlog-rank=off` stops/removes that job. The Linux timer has persistent catch-up: after a missed timer event, the next timer start catches up. A systemd user timer runs only while the user manager is active; enable linger for the account if it must run while logged out. The installer prints this caveat and does not change linger settings. Manual `as2 backlog-rank` remains available regardless of scheduling.

The job logs and run data are separate: scheduled-job stdout/stderr go to the backlog-rank log directory, while detailed order, attempts, cache, and backups stay in the state directory. A pending run resumes on a later hourly fire; after its third failed attempt it is marked abandoned and receives its one failure comment. Comment posting is marker-checked so a retry after a lost response does not duplicate the run's comment.
