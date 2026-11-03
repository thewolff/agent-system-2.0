---
date: 2026-10-27T13:49-07:00
engineer: Ilex
session: wl-mv73ymkyzgmqkg
status: resolved
durable: false
supersedes:
workload: wl-mv73ymkyzgmqkg
---

# Jo (2026-10-13, input in-mv73xjyepfqlts): "Open a normal workload, after PR 107: P-11 row 6 lets git push through when every destination is a local path, no network remote. One exception stays held: pushes into as2's own repo (~/code/agent-system-2.0 .git, shared by lane worktrees). Jo: agents push locally freely."

Notes (Ilex):
- **Jo's standing rule (2026-10-13): agents push locally freely.** Row 6 allows a `git push` when every destination it resolves to is a local path, with no network remote involved. That covers a filesystem path, a `file://` URL, or a remote whose effective push URL is one of those. The push is allowed whatever the branch names, protected names included, because no network remote is involved.
- **The one exception stays held:** any push whose destination is as2's own repository, /Users/jowolff/code/agent-system-2.0/.git, which lane worktrees share (worktrees under /Users/jowolff/code/agent-system-2.0-lanes/ resolve to it). Its protected-branch and reserved rules stay as they are today. The plan says how the gate resolves a destination to that git dir: realpath, git rev-parse --git-common-dir, worktree gitdir files, symlinks.
- **Resolving the destination.** It has to be the effective push URL, not just the command-line word. That means:
  - `remote.<name>.pushurl` and multiple pushurls;
  - `url.<base>.insteadOf` and `pushInsteadOf`;
  - remote groups;
  - `-c` overrides;
  - `--receive-pack` and `remote.<name>.receivepack` (which can execute shell);
  - `ext::` and other transport helpers.
  The private-data review already found ways around a single-destination guard (wl-mv6zl15365nf9c PLAN-REVIEW findings: pushurl, insteadOf, remote groups, receivepack). Reuse its findings, and coordinate so the two workloads share one resolver. Anything the gate cannot resolve to a local path stays held, as today. Any transport helper or receive-pack override stays held.
- **Row 8 as well.** Row 8 (push test evidence) currently refuses local scratch pushes with "no passing test record" and "origin has no default branch". Jo's intent is that local pushes go through freely, so the plan covers row 8's handling of local-only destinations too, or says why row 8 is left alone. (Ilex's reading of "push locally freely".)
- **Sequencing.** No build slice until PR #107 (lane-owned scratch, AS2_SCRATCH) is merged on origin/main. Check with `git log origin/main`. The plan may be written before then.
- **Coordinate.**
  - The merge train wl-mv6144px2e2n7k (#107);
  - private data wl-mv6zl15365nf9c (row 19 push gate, shared destination resolver);
  - the for-loop workload wl-mv65f7lqigfclc and the row-6 bypass replacement wl-mv4sweogs5xdkw (same r06-reserved.ts);
  - monitoring wl-mv654hoqwpfhmo (REPORT row 14 replay).
  Name shared files: gates/src/rows/r06-reserved.ts, the row 8 file, gates/src/shell-parse.ts.
- **Loosening a refusal.** The plan shows that no refusal other workloads depend on is weakened. Any bypass a reviewer finds becomes a probe under item 83's probe-suite rule, payloads in a fixture file. Probes are judged by the gate functions on fixtures, never by live pushes (Jo's no-live-probe rule, in-mv73ug7j25jy0w).
- Regression tests fail before the change, proven on a separate unpacked copy:
  - a push to a /tmp bare repo is allowed;
  - a push to a `file://` URL is allowed;
  - a push to a remote whose pushurl rewrites to GitHub stays held;
  - a push into /Users/jowolff/code/agent-system-2.0/.git from a lane worktree stays held.
  Guard-replay row-6 delta over the live ledger's held requests, with a memory cap and timeout. MIGRATION item. Full suite via lane_full_test. Merging stays Jo's (merge commit, green-first). Cross-lab review.
- **Lane budget.** Jo holds 4 running lanes (in-mv71ja9ygqgsu8). This workload opens user-driven and waits for PR #107 to merge.

done: P-11 row 6 (and row 8, unless the plan shows why not) lets a git push through when every effective destination resolves to a local path with no network remote, while pushes into /Users/jowolff/code/agent-system-2.0/.git (shared by lane worktrees), unresolvable destinations, transport helpers and receive-pack overrides stay held; no build slice started before PR #107 merged; regression tests fail before the change; the guard-replay delta is reported; a MIGRATION item records it; and the full suite is green at the PR head.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode user-driven, opened 2026-10-13T20:03:00.178Z.

## What changed

- none

## Decisions made (and why)

- jo (surface): Jo: "Open a normal workload, after PR 107: P-11 row 6 lets git push through when every destination is a local path, no network remote. One exception stays held: pushes into as2's own repo (~/code/agent-system-2.0 .git, shared by lane worktrees). Jo: agents push locally freely." — reading: Jo's rule: agents push locally freely. P-11 row 6 lets a git push through when every destination is a local path and no network remote is involved. Ilex reads row 8 as included too. The one exception stays held: pushes into as2's own repo, /Users/jowolff/code/agent-system-2.0/.git, which the lane worktrees share. Sequencing: this comes after PR #107. No build slice starts until #107 has merged, and then it takes the next free lane slot ahead of the rest of the relaunch queue (Ilex's default reading of 'after PR 107'; Jo can place it elsewhere).
- jo (surface): Jo: "Open a normal workload, after PR 107: P-11 row 6 lets git push through when every destination is a local path, no network remote. One exception stays held: pushes into as2's own repo (~/code/agent-system-2.0 .git, shared by lane worktrees). Jo: agents push locally freely." — reading: Jo sent the local-push request again, word for word the same as in-mv73yrst5kfd34. It is already open as this workload, so no second workload was opened. This restates the same rule: agents push locally freely, and as2's own .git stays held. Sequencing is unchanged: after PR #107.
- jo (surface): withdraw wl-mv73ymkyzgmqkg
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8waj7ir4n): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: change-large confidence 0.85 judge typesafe/jev-1.13.0

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
