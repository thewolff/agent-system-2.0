---
date: 2026-10-27T13:49-07:00
engineer: Ilex
session: wl-mv746bobfbygow
status: resolved
durable: false
supersedes:
workload: wl-mv746bobfbygow
---

# Jo (2026-10-13, input in-mv745ubcsvolxc): "Open a normal workload after the local-push one: before a held request reaches Jo, Jev judges whether it touches anything real. Throwaway at 0.9+ confidence goes to the daily count, not Jo. Jev never approves; held stays held."

Notes (Ilex):
- **What changes.** Today every P-11 row 6 reserved-request entry shows up as a numbered needs-you line, `approve en-… / deny en-…`. After this change, before such an entry becomes a needs-you line, the Jev judge (typesafe/jev) classifies the held command as either touching something real or throwaway.
  - Throwaway: only scratch paths such as mktemp or /tmp dirs the command creates, dry runs against repos the command builds itself, or read-only work in the lane's own worktree.
  - Real: anything else, including Jo's repos, as2's own .git, the ledger, ~/.omp, network remotes, credentials, and anything unresolvable.
- **Routing.**
  - Throwaway at confidence ≥ 0.9: no needs-you line. The entry is counted in the daily held-probe count. The scheduled row wl-mv73ug7lmwwcn4 does this today, and monitoring wl-mv654hoqwpfhmo's daily report takes it over.
  - Real, or below 0.9, or Jev down, slow or erroring: the needs-you line as today. A Jev failure never hides a request.
- **Jev never approves.** A held request stays held. The command still does not run, and the lane gets the same refusal it gets today. Only the surfacing to Jo changes. Jo can still answer any counted request by id. The daily count lists the ids, so nothing is lost.
- **Record.** Each judgment is written to the ledger: verdict, confidence, Jev version, cost. Monitoring's Jev accuracy work (items 8–9, REPORT row 14 replay) can then measure it. The plan says how a misjudged real request would be noticed.
- **Proof.**
  - Regression tests fail before the change, proven on a separate unpacked copy:
    - a /tmp-only dry-run push request does not reach needs-you;
    - a held request touching the as2 repo does;
    - a Jev timeout surfaces the request.
  - Replay over today's live held requests (en-mv70eyk0kbwoao … en-mv73rkfckeg934) with each verdict, as a check against real data.
  - Cost per call stated.
- **Sequencing.** After the local-push workload wl-mv73ymkyzgmqkg, which removes most /tmp push holds at the source. No build slice before that workload's PR merges (check `git log origin/main`).
- **Coordinate.**
  - Monitoring wl-mv654hoqwpfhmo (daily report, Jev accuracy);
  - cheaper routing wl-mv71x5rwdu7eo0 (Jev call cost);
  - paired mode wl-mv67564rdkfvnk (shared jev `askChoices` in classifier/src/judge-ask.ts; reuse it);
  - PR #106's needs-you counting, now merged.
  Name shared files.
- MIGRATION item. Full suite via lane_full_test. Merging stays Jo's (merge commit, green-first). Cross-lab review.
- **Lane budget.** Jo holds 4 running lanes (in-mv71ja9ygqgsu8). This workload opens user-driven and waits behind the local-push workload.

done: Before a P-11 row 6 held request reaches Jo's needs-you, the Jev judge classifies whether it touches anything real; requests judged throwaway at confidence 0.9 or higher go to the daily count instead of needs-you, real, low-confidence or unjudged requests surface as today, and Jev never approves (the request stays held); each verdict is in the ledger; regression tests fail before the change; a replay over today's held requests shows the verdicts; and the full suite is green at the PR head.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode user-driven, opened 2026-10-13T20:08:59.291Z.

## What changed

- none

## Decisions made (and why)

- jo (surface): Jo: "Open a normal workload after the local-push one: before a held request reaches Jo, Jev judges whether it touches anything real. Throwaway at 0.9+ confidence goes to the daily count, not Jo. Jev never approves; held stays held." — reading: Before a P-11 row 6 held request reaches Jo, the Jev judge decides whether it touches anything real. A request judged throwaway at confidence 0.9 or higher goes to the daily count, not to Jo's needs-you. Jev never approves anything; a held request stays held. Sequencing: after the local-push workload wl-mv73ymkyzgmqkg, so no build slice starts before that workload's PR merges.
- jo (surface): withdraw wl-mv746bobfbygow
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8wabq64u6): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: change-large confidence 0.69 judge typesafe/jev-1.13.0

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
