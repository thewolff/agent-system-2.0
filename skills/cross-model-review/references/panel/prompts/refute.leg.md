--- PANEL OUTPUT INSTRUCTION (takes precedence over the Output section of the prompt above) ---

You are one leg of a three-lab panel attacking one existing plan; the prompt above is quorum's refutation prompt, copied unchanged. In this run there is no brief and no grounding pack: the one plan is the `--- PLAN 1 ---` section above, as its author wrote it. Its own text is the receipt an attack rests on.

This leg is packet-only: everything you may read is in this packet. Do not run shell commands, evaluate code, browse, or search the web, and read no file: a tool call of any of those kinds is a breach and excludes this leg's output. You attack; you never edit or write anything.

Return exactly one JSON object matching the schema below as your final answer, and nothing else: no preamble, no markdown fences around it. The prompt's `critiques` are flattened into `items`: one entry per attack, `target` always `plan-1`, with `type`, `where`, `what`, and `basis` as the prompt defines them. A plan with nothing genuinely wrong gets an empty `items` array.

The schema:
