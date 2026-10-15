---
title: The OMP harness guide and start card ship in the as2 profile
status: building
workload: wl-mv8k0fby51uakg
pr: 144
---
**Built on branch `wl/wl-mv8k0fby51uakg`.** Until now no as2 agent was told what its harness offers: which OMP slash commands exist in its mode, which launch flags as2 passes, and which of OMP's settings are machinery-owned. Agents guessed, suggested `/settings` edits that the next install overwrote, or typed slash commands that OMP never dispatches from model output.

Two files now carry that knowledge, both verified against OMP 18.8.6 and its source:

- **The guide**, `profile/OMP-HARNESS.md`. It covers every built-in slash command, the as2 profile's dynamic commands, the launch flags as2's launchers pass, and every OMP setting. Each entry has its OMP source anchor (`pi-coding-agent@18.8.6 src/<file>` plus a `name:`/`id:` string) and a verdict per role: Ilex, a lane, a seat. `install/install.sh` links it to `~/.omp/profiles/<profile>/agent/OMP-HARNESS.md`, so an edit in the checkout is live without a re-install. Nothing loads it automatically. Agents read it on demand, and hands are pointed to it by a line in each hand tier file (`tiers/fast.md`, `tiers/standard.md`, `tiers/strong.md`, `tiers/deep.md`).
- **The start card**, `profile/AGENTS.md`. It holds the short rules, the commands Ilex may suggest to Jo, the launch flags and the settings that are `use` or `machinery-owned` for Ilex or lanes. The installer renders it like `config.yml` (`{repo}` becomes the checkout's absolute path; a surviving `{repo}` refuses the install with exit 2, nothing written) into `~/.omp/profiles/<profile>/agent/AGENTS.md`. There OMP loads it into every top-level session of the profile, Ilex and every lane, as native user context. OMP strips `AGENTS.md` from subagents, so hands never see the card.

The verdict vocabulary, defined in the guide's § Verdict key and roles:

- `use` (when): for a slash command, Jo types it and Ilex may suggest it. No agent can type one, because OMP dispatches slash commands only from user prompt text, and a lane's runner sends none. For settings and skills, the role acts through it.
- `machinery-owned`: set by `profile/config.yml` or the launcher. Change the template and re-install, never `/settings`, because install section 5 rewrites the profile's `config.yml`.
- `Jo only`: Jo's call in the TUI; an agent does not take it.
- `not for as2` (why): with the lane shorthands `(TUI-only)` (the command does not exist in rpc) and `(no sender)` (rpc would run it, but nothing sends it).

Graham's paired-mode note: see profile/OMP-HARNESS.md § Pairing and workspace directories.

Re-verifying on an OMP upgrade. `ledger/test/omp-harness.test.ts` checks that the guide's `verified-omp: X.Y.Z` header line has the same major.minor as `VERIFIED_HOST` in `gates/src/host.ts`. It also checks that the card is at most 8000 bytes, starts with its marker line and names the guide by its `{repo}` path. A patch upgrade passes that test unnoticed. On any OMP upgrade:

1. Rerun the three count commands at the top of the guide.
2. Re-check each changed command, flag and setting row against the new OMP source, and update the anchors and verdicts.
3. Bump the `verified-omp` line and the card's `verified-omp:` sentence.
4. Re-run `bash install/install.sh`.

A minor upgrade also bumps `VERIFIED_HOST` after `gates/test/host.test.ts` passes on the new host, and the guide test then fails until the guide is bumped too.
