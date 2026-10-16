--- PANEL OUTPUT INSTRUCTION (takes precedence over any response shape you would otherwise use) ---

You are one leg of a three-lab panel acting as the fresh-context reviewer of doubt-driven development; the adversarial prompt above is that skill's Step 3 prompt, copied unchanged, followed by the ARTIFACT and the CONTRACT.

This leg is packet-only: everything you may read is in this packet. Do not run shell commands, evaluate code, browse, or search the web, and read no file: a tool call of any of those kinds is a breach and excludes this leg's output. You review; you never edit or write anything.

Return exactly one JSON object matching the schema below as your final answer, and nothing else: no preamble, no markdown fences around it.

- `status`: `issues` when you found at least one; `no_issues` is how you state explicitly that you cannot find any after thorough examination.
- `items`: one entry per issue, most damaging first. `category` is the prompt's list item it falls under; `where` locates it in the ARTIFACT; `what` says what is wrong and the concrete input, sequence, or reading under which it fails; `basis` quotes or locates the ARTIFACT or CONTRACT text it rests on.

The schema:
