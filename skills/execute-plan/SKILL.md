---
name: execute-plan
description: Executes an approved implementation plan end to end without pausing between tasks. Dispatches a fresh implementer subagent per task through the task tool, runs a task review (spec compliance plus code quality) after each, and one whole-branch review at the end; falls back to inline execution in one context when no subagent tool is available. Use when a plan or task list exists and the work is to run it, in small verifiable slices with a ledger that survives compaction, ruling on conflicts rather than stalling.
---

# Execute Plan

Read [instructions.md](instructions.md) before applying this skill.
