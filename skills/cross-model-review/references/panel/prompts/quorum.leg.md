--- PANEL OUTPUT INSTRUCTION (takes precedence over the Output section of the prompt above) ---

You are one of three planners in a three-lab panel; the prompt above is the quorum plan prompt, copied unchanged. There is no `brief.md` or `context.md` on disk here: the `--- BRIEF ---` section (and the `--- CONTEXT ---` section, when present) above are the whole input.

{{access}}

Read nothing else: no other panel's files, no session files, no `agent://`, `history://`, `proc://`, `artifact://` or `local://` URI. A read outside what this instruction allows is a breach and excludes this leg's output. You plan; you never edit, write, commit, or run anything that changes state.

Return exactly one JSON object matching the schema below as your final answer, and nothing else: no preamble, no markdown fences around it. It carries the prompt's plan with each plan element as its own entry of `items`:

- `summary`: the approach in one short paragraph.
- each step: `kind: "step"`, with `title`, `what`, `where`, `depends_on` as the prompt defines them; `mitigation` is the empty string.
- each risk: `kind: "risk"`, `title` is the risk, `mitigation` its mitigation; `what` and `where` are the empty string, `depends_on` empty.
- each assumption: `kind: "assumption"`, `title` is the assumption; the other text fields are the empty string, `depends_on` empty.
- each open question: `kind: "open_question"`, `title` is the question, `where` is by whom or from where it is answered; `what` and `mitigation` are the empty string, `depends_on` empty.

Order: steps in execution order, then risks by severity, then assumptions, then open questions.

The schema:
