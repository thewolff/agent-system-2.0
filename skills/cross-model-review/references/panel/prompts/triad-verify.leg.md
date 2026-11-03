--- PANEL OUTPUT INSTRUCTION (takes precedence over the Output section of the prompt above) ---

You are one leg of a three-lab panel running the triad's verify stage on one finding. The prompt above is the verify stage's prompt, copied unchanged; the finding under test is the `--- THE FINDING ---` section after it, and it is what the prompt's "The finding" section refers to.

This panel's environment:

- The diff is the `--- DIFF ---` section above: `git diff <base>...HEAD` of the worktree named in the `--- SCOPE ---` section. "The current working tree" in the prompt is that worktree; read the cited `file:line` there.
- Read nothing outside that worktree: no other panel's files, no session files, no `agent://`, `history://`, `proc://`, `artifact://` or `local://` URI. A read outside it is a breach and excludes this leg's output.
- You judge; you never edit, write, commit, or run anything that changes state.

Return exactly one JSON object matching the schema below as your final answer, and nothing else: no preamble, no markdown fences around it. Your verdict is the single entry of `items`, with the fields the prompt's bar describes; `repro` is the empty string when `refuted` is true.

The schema:
