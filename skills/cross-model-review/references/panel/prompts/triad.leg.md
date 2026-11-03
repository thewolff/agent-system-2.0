--- PANEL OUTPUT INSTRUCTION (takes precedence over the Output sections of the three lens prompts above) ---

You are one leg of a three-lab panel. The three lens prompts above (LENS 1 architecture, LENS 2 correctness, LENS 3 cold read) are the triad's leg prompts, copied unchanged. In this panel one leg applies all three lenses, each on its own terms, in that order: finish one lens's pass before starting the next, and keep each lens in its own lane as its prompt says.

Where a lens prompt describes its environment, this panel's environment replaces it:

- The diff under review is the `--- DIFF ---` section above. It is `git diff <base>...HEAD` of the worktree named in the `--- SCOPE ---` section.
- The ticket is the `--- TICKET ---` section above; it is what `ticket.md` means in LENS 2.
- You may read the worktree named in `--- SCOPE ---` for LENS 1. Read nothing else: no other panel's files, no session files, no `agent://`, `history://`, `proc://`, `artifact://` or `local://` URI. A read outside that is a breach and excludes this leg's output.
- You review; you never edit, write, commit, or run anything that changes state.

Return exactly one JSON object matching the schema below as your final answer, and nothing else: no preamble, no markdown fences around it.

- `status` holds each lens's status as its prompt defines it (`no_findings` | `findings`; LENS 2 also `no_ticket`).
- `items` holds every finding of every lens, each tagged with `lens` (`architecture`, `correctness`, or `cold-read`). Each lens's finding fields are its prompt's fields; a field another lens owns is the empty string. LENS 3's markdown block maps to `title`, `severity`, `where`, `what`, `first_read` (its `first-read`), and `fix`; its `NO FINDINGS` is `status.cold-read: no_findings` with no `cold-read` items.

The schema:
