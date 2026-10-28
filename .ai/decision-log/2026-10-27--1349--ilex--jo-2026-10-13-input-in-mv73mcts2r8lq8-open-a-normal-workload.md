---
date: 2026-10-27T13:49-07:00
engineer: Ilex
session: wl-mv73n0xd49vqps
status: resolved
durable: false
supersedes:
workload: wl-mv73n0xd49vqps
---

# Jo (2026-10-13, input in-mv73mcts2r8lq8): "Open a normal workload, front of queue: lane resume prompts stop re-sending repo facts and decision log (surface/src/launch.ts firstPrompt). Evidence: /Users/jowolff/agent-scratch/agent-system-2.0/openai-compaction-loop/REPORT.md"

Notes (Ilex), from REPORT.md (Needs you, second QUESTION; § 2):
- **Cause.** Every relaunch into the same lane session sends the whole brief again, repo facts plus "## Decision-log context", as a new user message. OpenAI native (V2) compaction keeps real user messages word for word, up to v2RetainedMessageBudget = 64000 estimated tokens. The resent briefs therefore pile up as a floor that compaction can't go below.
  - The gpt-6-astra lane on wl-mv4rzy53lb8oao carried one decision-log copy in each of its 5 user messages. Its post-compaction floor rose 48,107 → 58,853 → 74,929 → 85,774 tokens.
  - The sol lane's brief was 458,591 chars, 98.4% of it decision log.
  - The 32 KB decision-log cap (item 107, c8a175f) shrinks one brief but does not stop resumes piling up.
- **Change.** In surface/src/launch.ts firstPrompt, a resume into an existing session (`--resume <session>`) sends only what is new since that session's last prompt: the wake line, new instructions, answers and messages. It does not re-embed the repo facts block or the decision-log context the session already holds. A fresh session (no resume, a model change that starts a new session, or a session file that is missing) still gets the full first prompt. The plan names how launch knows whether the resumed session already carries facts and decision log, for example a marker entry or the session file. If it can't tell, it sends the full prompt.
- **Proof.**
  - A regression test fails before the change, proven on a separate unpacked copy: a resume prompt into an existing session does not carry the facts or decision-log sections, and a fresh session does.
  - Measure prompt size before and after on a real resumed lane.
  - Smoke: relaunch a real lane into its session and show the prompt without the duplicated sections.
- **Coordinate.**
  - Monitoring wl-mv654hoqwpfhmo (item 2 drift check; lane cache cost, REPORT row 17);
  - cheaper routing wl-mv71x5rwdu7eo0;
  - private data wl-mv6zl15365nf9c, which changes where the decision log is read from.
  Name shared files.
- **Out of scope.** REPORT.md's first QUESTION: porting `methodOrder`, `modelThresholds` and `extendedContext` from the live profile into profile/config.yml. That one stays with Jo.
- MIGRATION item. Full suite via lane_full_test. Merging stays Jo's (merge commit, green-first). Cross-lab review.
- **Lane budget.** Jo holds 4 running lanes (in-mv71ja9ygqgsu8). This workload opens user-driven and goes to the front of the relaunch queue (Jo).

done: A lane relaunched into an existing session gets a first prompt without the repo facts block or decision-log context that the session already holds, while a fresh session still gets the full prompt; a regression test fails before the change; a real resumed lane shows the smaller prompt with sizes before and after; a MIGRATION item records it; and the full suite is green at the PR head.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode user-driven, opened 2026-10-13T19:53:58.897Z.

## What changed

- none

## Decisions made (and why)

- jo (surface): Jo: "Open a normal workload, front of queue: lane resume prompts stop re-sending repo facts and decision log
 (surface/src/launch.ts firstPrompt). Evidence:
 /Users/jowolff/agent-scratch/agent-system-2.0/openai-compaction-loop/REPORT.md" — reading: Lane resume prompts stop re-sending repo facts and the decision log (surface/src/launch.ts firstPrompt). The evidence is /Users/jowolff/agent-scratch/agent-system-2.0/openai-compaction-loop/REPORT.md: OpenAI V2 compaction keeps every resent brief word for word, so the floor rises with each resume. Relaunch queue under the 4-lane hold, superseding in-mv734peen6fvnk: 1. this workload wl-mv73n0xd49vqps 2. cheaper routing wl-mv71x5rwdu7eo0 3. runner speed wl-mv615mkeaf1yio 4. clickable file links wl-mv720a2pph9d6o 5. the PR #101 fix wl-mv6t0dlejgzvuo 6. the paste-drop fix wl-mv65nllu5g181s 7. monitoring wl-mv654hoqwpfhmo 8. the skill-writing gate wl-mv72nurvlwba4g 9. jo-deck wl-mv6zfcyl8s54w0 10. vendored-skill licences wl-mv72a3eo35lyps 11. the skill bump wl-mv734imdks3mdc 12. the rest of the ceiling queue
- jo (surface): Jo: "The template already has methodOrder, modelThresholds and extendedContext: PRs 131, 132 and 133 are merged
 (origin/main profile/config.yml lines 57-63). The report read a stale local main. Nothing to ask Jo." — reading: No port is needed. origin/main's profile/config.yml (lines 57-63) already has methodOrder, modelThresholds and extendedContext, because PRs 131, 132 and 133 are merged. REPORT.md's first QUESTION came from a stale local main. The resume-prompt workload wl-mv73n0xd49vqps does not touch profile/config.yml for these keys. (answers q-mv73qrnq0kaz28)
- jo (surface): withdraw wl-mv73n0xd49vqps
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8wa6k9f78): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: change-small confidence 0.84 judge typesafe/jev-1.13.0

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
