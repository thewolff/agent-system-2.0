---
title: Jev ranking (show-only first)
status: open
workload: wl-mv8k039gvogt8g
pr: none
number: 139
---
One Jev ranking path that every agent ranks open workloads through (plan `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mv8k039gvogt8g/PLAN.md` rev 5, § 2). `rankOpen` in `surface/src/rank.ts` is the only place an order of workloads is computed. Jev answers narrow factual questions per workload (does it serve each of Jo's goal lines, does it unblock Jo, cut spend, fix breakage, state a deadline and when, is it irreversible); visible code combines the answers with the fixed weights `RANK_WEIGHTS`, printed with every table. Jev is never asked how important something is. The shadow test behind the weights (`/Users/jowolff/agent-scratch/agent-system-2.0/jev-rank-test/RESULT.md`) agreed with Jo's hand order on 0.781 of pairs against 0.438 for oldest-first, on one 15-item snapshot; the weekly audit below is the running check.

Where it shows:
- `as2_rank` tool (`surface/extensions/rank.ts`), registered on every session: Ilex, lanes, hands and an interactive lane. It asks Jev for any workload with no current signal, writes `priority-signal:` rows and a `rank-shown:` row, and returns the table. The tier files say any order of workloads, PRs or next steps an agent gives Jo or acts on comes from `as2_rank`.
- Wake line under the needs-you block: `Rank (Jev, show-only): 1 … · 2 … · 3 …`, from stored rows only, no Jev call.
- `as2 rank [--top N]` in a terminal (`surface/scripts/rank.ts`): the ledger opened read-only, the same table without asking Jev, nothing written.

Show-only is the default. Launch order does not change: the drain, the open tool and the wake tick admit exactly what they admitted before, and the drain only appends a `rank-shadow` line to drain.log saying what the ranking would have picked. Needs-you order is not ranked. `migration/items/rank-ordered-launch.md` (workload wl-mv8wzytml878b4, merging after this PR) changes the default to `order` and adds Jo's ruled list and priority pause.

Jo's words, through Ilex (each needs Jo's unspent input; a lane or hand cannot set them):
- Goals: Jo states the priorities in plain words; Ilex records them with `as2_rank { goals, inputId }` as a `rank-goals:` row (1 to 6 lines). With no goals, or goals older than 7 days, only the seed goal is asked and weighs, and every view says `goals: none` or `goals: stale since <date>`. There is no goals file.
- Machinery first (Jo's word of 2026-10-14, input `in-mv8vxstcczw0zk`): `SEED_GOALS` in `surface/src/rank.ts` holds one seed goal, asked before Jo's on every signal and never stale, and the goals hash covers it, so every signal written before it reads stale and is asked again. Jev also answers `builds_enforcer` (does the item build an enforcer that governs how other work is planned, reviewed or checked); above 0.65 the item ranks in a band above every other unpinned item (pins still first), in [0.35, 0.65] it is flagged `enforcer?` and not moved, and the score is unchanged either way.
- Pin: "X first" is `as2_rank { first, inputId }`, a `rank-override:` row. A pinned workload sits above every unpinned one, newest pin first, until it closes.
- Unpin: "drop the pin on X" is `as2_rank { unpin, inputId }`, a `rank-unpin:` row.

Weekly audit (`surface/src/rank-audit.ts`, run by the wake tick, no Jev, no launchd job). Once a week it compares Jev's order with Jo's observable picks: "X first" pins, Jo's launch word (`launch-requested:`) and `as2 lane <wl>`. Each pick is scored against the `rank-shown: … by pick` snapshot written in the same transaction, with pins ignored; a pick with no snapshot is counted unscorable. The report goes to `/Users/jowolff/agent-scratch/agent-system-2.0/rank-audit/<date>.md` and one `rank-audit:` row on `wl-orchestrator` (top-1 hits, top-3 hits, mean percentile, each override with its terms). A week with no picks still writes the row.

Launch modes (`jevRank` in `profile/config.yml`, read fresh at each decision; missing or malformed reads as show). Jo's word: `as2 rank-mode show|order|parallel [--budget <usd>]`, which prints old → new and never starts omp. `as2 rank-mode show` is the reversal.
- `show`: as above, nothing changes.
- `order`: an automatic start is refused with `ranked: below <wl>` while a higher-ranked workload (pins first) can launch; the open and tick lines say "queued behind <wl> (Jev rank)". Jo's own launch word and `as2 lane` are never gated.
- `parallel`: `order`, plus a second lane starts beside running ones only when all three hold: the workloads are in different git repositories (compared by their shared git directory, so worktrees and spellings of one checkout count as one); the remaining ceilings of the running lanes and the candidate fit in the `--budget` (0 or unset means no parallel start) and the candidate is under 80 % of its ceiling; and the merge order is clear (no two scores within 0.02, and no higher-ranked brief names the lower one's id or PR). Anything unclear holds.

Why same-repo work stays serial: as2 has no declared, enforced write set. A slice's inputs are prose and nothing stops a lane writing a file it did not name, so file overlap can be ruled out only by repository. Same-repo parallel starts need an enforced write set per workload, a gates change and its own workload. Since most open work is in this one repository, `parallel` will rarely start two lanes until then.

Still open: the live acceptance. The installed profile loads extensions from the main checkout, so after Jo merges the PR and pulls, Jo restarts Ilex, states the goals and says `rank`; the relaunched lane then checks the live ledger for `rank-shown:` rows written by the orchestrator, by a lane and by a hand.
