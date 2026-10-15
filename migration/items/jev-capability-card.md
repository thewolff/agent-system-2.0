---
title: "`jev`: a Jev capability card as installed skill #23, linked from every Jev call site"
status: open
workload: wl-mv8s8swjr478qo
pr: 147
---
**Built on branch `wl/wl-mv8s8swjr478qo`.** Workload `wl-mv8s8swjr478qo` (normal stakes; PLAN rev 3 at `~/agent-scratch/agent-system-2.0/wl-mv8s8swjr478qo/PLAN.md`, two plan reviews, approved by Jo).
`skills/jev/SKILL.md` says what Jev is good, weak and untested at, built only from Plumb's measured profile, which is committed verbatim under `research/jev-profile/` (JEV-PROFILE.md, three evidence files, and the Jev 1.14 release digest); every figure on the card names its file and section heading there.
Every measurement on the card is of `jev-1.13.0` only; `jev-latest` moves to 1.14.0 about 2026-10-21, and the card says which as2 call sites check the answering model (slice routing only) and which do not.
Registered as skill #23: `install/manifest.tsv`, `profile/config.yml` `includeSkills`, `install/fresh-machine-test.sh`, `skills/VENDOR.md`, DESIGN-2.0.md § C6.1. Every Jev call site in this repo carries the line `Jev capability card: skills/jev/SKILL.md (read before changing this call or its threshold)`.
