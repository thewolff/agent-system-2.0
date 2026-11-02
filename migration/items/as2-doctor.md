---
title: as2 doctor, one check that says whether as2's important parts are up
status: building
workload: wl-mvwks11ye3x9zu
pr: 422
---
`as2 doctor` checks the launchd jobs and their dependencies, ctx, the ledger and its backup, Ilex's seat and mailbox, gh, disk and MCP load failures. It prints one line per part with its evidence and fix, and exits 0, 1 (a part failed) or 2 (bad argument or crash). `install/install.sh` runs it last and exits 5 with `install incomplete` when it fails. A doctor job (`com.agent-system-2.doctor`, every 600 s) and the train tick (ctx only) raise a stay-up popup and a needs-you line when a part is down. Plan: `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvwks11ye3x9zu/PLAN.md`. Guide: `USER-GUIDE.md`, "Is as2 up?".

After the merge, Jo does this:

1. Re-run `bash install/install.sh` from his own Terminal.
2. Run any bootstrap one-liner it prints (`launchctl bootstrap gui/$(id -u) <plist>`).
3. Run `as2 doctor`.
