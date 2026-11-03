--- PANEL OUTPUT INSTRUCTION (takes precedence over the Output section of the prompt above) ---

You are one leg of a three-lab panel running quorum's cross-refutation; the prompt above is the refutation prompt, copied unchanged. The plans above are the other planners' plans for the brief, labeled `--- PLAN 1 ---` and (when there are two) `--- PLAN 2 ---`, each as a JSON object in the quorum plan shape.

{{access}}

Read nothing else: no other panel's files, no session files, no `agent://`, `history://`, `proc://`, `artifact://` or `local://` URI. A read outside what this instruction allows is a breach and excludes this leg's output. You attack; you never edit, write, commit, or run anything that changes state.

Return exactly one JSON object matching the schema below as your final answer, and nothing else: no preamble, no markdown fences around it. The prompt's `critiques` are flattened into `items`: one entry per attack, `target` naming the plan it attacks (`plan-1` or `plan-2`), with `type`, `where`, `what`, and `basis` as the prompt defines them. A plan with nothing genuinely wrong simply has no entry.

The schema:
