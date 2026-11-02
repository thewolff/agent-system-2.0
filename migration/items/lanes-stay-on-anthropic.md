---
title: Lanes stay on Anthropic (set-lane-model tool, quota-move alert, weekly-out hand move)
status: building
workload: wl-mvwk0v0gmp6cjc
pr: none
---
Jo wants lanes to stay on Anthropic and to hear at once, without a sound, when one is moved off it (Jo's in-mvwk6orb520efe and in-mvwl9tkmsym86o, cut down by in-mvzllm9vlzllac). Plan: `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvwk0v0gmp6cjc/PLAN.md` (rev 5), D1, D2, D4, D5, D6.

**What ships.**
- `orchestrator_set_lane_model { workloadId, model }` (`surface/extensions/lane-model.ts`). It writes one `lane-model:` entry on an open workload and launches nothing: no `launch-requested:`, no starter, no hold released, no lease touched. A lane that holds the workload keeps its current model; the next lane on it starts on the new one. `default` clears a named model. A bad model, a missing or closed workload, the standing workload and a `due:` row are refused with nothing written.
- A quota-move alert on every lane move off a lab, whatever limit caused it, and on every build or fix hand moved to another lab on a used-up week. The move writes one `quota-move:` message for the orchestrator (a pushed signal; `lane_message` refuses the prefix) and then spawns `bun surface/scripts/lane.ts move-alert <wl> <E>` detached, where `E` is the move's event entry. The worker alerts through three channels, none of them with a sound:
  - a `NOW:` needs-you line, on fire, from the `quota-move:` message;
  - one jo-issues issue per move with a comment that starts `@thewolff` (`surface/src/jo-issues.ts`);
  - a popup with the buttons "Read it to me" and "Dismiss (no voice)". Dismiss is the default and there is no timeout. Sound plays only if Jo picks "Read it to me".
- Claims and statuses live in the ledger as `quota-move-alert: <E> <channel> <status>` entries, channel `comment` or `popup`. A claim is live only while its pid is alive and inside its deadline (comment 180 s, popup 30 s to `showing`). Three failed attempts exhaust a channel.
- The train tick gains one pass. It finds every move with a channel that is neither `ok` nor `exhausted`, settles stalled, dead and unstarted claims, and spawns `move-alert` again. It looks at closed workloads too, so a close never drops an unfinished alert.
- A failed or exhausted alert shows as a `quota-move-alert` needs-you line. When a channel is exhausted the line names the recovery: `bun surface/scripts/lane.ts move-alert <wl> <E> --again` opens one more block of 3 attempts. The line clears when both channels are `ok`.
- A build or fix hand whose lab's weekly limit is used up moves to the first usable entry of the same tier row on another lab, instead of being refused. This amends Jo's rule in-mv7hm58386f2o0 ("a build hand never runs on another lab") for that one case, as Jo's in-mvwl9tkmsym86o asks. It writes `hand-headroom: <subject> of lane <lane> <from> -> <to> (<reason>)` and the same `quota-move:` message and alert. The target lab counts as a builder, so a later review may park on `review-park:` for Jo. Reviews route as before. Every other refusal stays as it was.
- `HeadroomDecision` gains `exhausted`, the reason of a binding used-up week. Only the hand move reads it.

**If a 5-hour window comes back.** Anthropic's 5-hour limit is gone (no anthropic/5h poll rows since 2026-10-31), and nothing here waits for one. If quota-watch writes 5h rows again and a window crosses 0.8:

- an unnamed lane on the default model moves to the first in-quota entry of the strong row (today OpenAI), as it does now, and Jo gets the move alert at once with a reason that names the 5h window, so the return of the limit is never silent;
- a lane with a named model is refused before omp with the usual `launch-failed:` and `lane-died:` NOW line, naming the 5h window;
- a build or fix hand out on the 5h window alone is refused as today (`refused-no-usable-model`); nothing moved, so there is no alert. If its week is also used up, the used-up week wins and the hand moves with the alert;
- reviews route as today.

To get the wait back, Jo reopens it: `PLAN-rev4.md` in the plan directory holds the reviewed design.

**After the merge train lands it.** The orchestrator installs the change and runs the tool with `default` on each of these 11 workloads, and reports each result: wl-mv4rzy53lb8oao, wl-mv4sweogs5xdkw, wl-mv66q5b148uznk, wl-mv6uqrx6d1tjb4, wl-mv7gidggnlkem8, wl-mv8cvw0lq3rlds, wl-mv8d45mqycd8g0, wl-mvh42n85yo0m4g, wl-mvtueiqlslqoip, wl-mvrbprpi7i27to, wl-mvsw6befzoj5rv. A session already running keeps the code it loaded; Ilex and any running lane must restart to pick up the tool.
