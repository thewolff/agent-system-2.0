---
status: open
author: plumb
date: 2026-10-19
---

# The jo-wolff-plugins re-pin is folded into the pair-handoff workload's second PR

## Decision

Jo, 2026-10-19 at about 12:35 PM PDT: "FOLD IT IN". This answers Plumb's question whether the plugin re-pin goes on the second PR of the workload "make pair offers visible and fix the pair handoff" (wl-mvb9mw00ycfjeo). Jo's ask: "I ALSO WANT THEM IN ILEX. AS2 AND ANY SUB LANES."

The second PR now carries three items. Vendoring paired-coding (item 2 in `2026-10-19--1215--plumb--by-hand-pairing-lanes-get-brief-and-paired-coding.md`) is done as part of item 3:

3. Re-pin i-have-audhd, ask-graham and paired-coding from jo-wolff-plugins origin/main, and load the adapters for lanes as well as the orchestrator.

## Basis

- `plugins/VENDOR.md:14-15` pins i-have-audhd 1.0.0 and ask-graham 0.2.0. The marketplace clone at 8a820c0 has i-have-audhd 1.3.0, ask-graham 0.5.0 and paired-coding 1.3.2.
- `plugins/VENDOR.md:39-42`: the vendored adapters load only for `AGENT_SYSTEM_ROLE=orchestrator`.
- `plugins/VENDOR.md:85` (C11): upgrading OMP's default profile never updates as2's pinned copies.
- One PR, not two, because the re-pin and the paired-coding vendoring edit the same three places: `plugins/VENDOR.md`, `install/manifest.tsv` and `includeSkills`.

## Not covered here

Plumb's own default-profile i-have-audhd (1.2.0, marketplace 1.3.0). The fix is `omp plugin marketplace update jo-wolff-plugins && omp plugin upgrade i-have-audhd@jo-wolff-plugins`. Plumb's charter forbids it to install anything, so Jo or Tinker runs it.

## Delivery

Ilex paste: `.tmp/paste-pair-handoff-repin-plugins.txt`, put on Jo's clipboard. Not yet confirmed sent.
