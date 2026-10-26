---
title: A by-hand `as2 lane` starts holding its prompt; the three jo-wolff-plugins re-pinned and loaded for lanes
status: building
workload: wl-mvb9mw00ycfjeo
pr: 258
---
Jo's amendments to issue 53 (in-mvfn25k1yesl4w "ADD BOTH", in-mvfnbo3ofundvk "FOLD IT IN"), after `migration/items/pair-offer-own-line.md` (PR 243). Plan: `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvb9mw00ycfjeo/PLAN-2.md` (rev 4).

What changed:
- By-hand first prompt. `as2 lane wl-…` writes prompt.md as the autonomous prompt plus a `## Workload state now` section (the workload's slices, open questions, pending messages and recent entries, from the ledger render), and passes it to omp as one `@<prompt.md>` argument, so the session's first user message is the lane prompt. A `--resume` gets the fresh context once more; a model mismatch still starts a fresh session. The launch notice says `first prompt supplied from <path>`. The autonomous RPC argv and prompt are unchanged.
- `AGENT_SYSTEM_BY_HAND=1` marks a by-hand lane. `laneEnv` drops an inherited value, so autonomous lanes and their hands never carry it.
- Re-pin. plugins/i-have-audhd (1.3.0), plugins/ask-graham (0.5.0) and new plugins/paired-coding (1.3.2) are copied from jo-wolff-plugins origin/main 8a820c0f91e22e34248980822d7e57bffd0a06da without tests; plugins/VENDOR.md holds the pin, source digests, the integration delta and the clash table.
- Roles. plugins/index.ts loads AuDHD and Graham for the orchestrator and lanes, paired-coding only for a by-hand lane, and nothing for hands. A child session (`ctx.agent.kind === "sub"`, or headerless with a parent session) gets no adapter behaviour: handlers are gated trampolines, registrations replay once on the first enabled session_start.
- One copy. profile/config.yml lists paired-coding in includeSkills (25 skills), adds its skills dir, and disables the marketplace copies of all three adapters (`extension-module:i-have-audhd-omp`, `ask-graham-omp`, `paired-coding-omp`).
- Gates. pair_write, pair_edit and pair_run pass the same P-11 rows, fence and clean-shell check as write, edit and bash (gates/src/pair-call.ts, plugins/paired-as2.ts). Authorization is by tool call id and argument fingerprint, so arguments rewritten after the gate are refused at execute. A pair_run of a declared artifact records its real outcome; a run that executed and then stopped pairing records a failure.

Deployment: this reaches Ilex and new lanes only after /Users/jowolff/code/agent-system-2.0 is on main and `as2 install` has re-run; running sessions keep their old adapter registrations until restarted.

## Train-return fence fixture repair

The returned task `tt-mvhbgiv1a05xc0` includes five-second metadata-test timeouts.
`gates/test/fence.test.ts` now snapshots paths and file digests in process rather than
launching `shasum` and `cut` for every file. Assertions and timeouts are unchanged.
The snapshot still records directories, hashes file-symlink targets and does not
traverse directory symlinks.

A standalone scratch-fixture comparison matched the former snapshot output, detected
file mutations/additions and preserved symlink behavior. Three local comparisons on
40 regular files took 425–458 ms for the shell pipeline and 1.05–1.22 ms in process.
Those measurements establish fixture overhead reduction, not a full-suite timeout fix.
The local complete fence file could not exercise nested Seatbelt controls: child
`sandbox-exec` calls exited 71 with `sandbox_apply: Operation not permitted`.
Full acceptance requires the external runner at the repaired PR head.
