---
title: The nightly Google Drive backup as two repo launchd jobs (install.sh --drive-backup)
status: building
workload: wl-mvwkt821jx4d6e
pr: none
---
The nightly Google Drive backup (thewolff/jo-issues#300; plan `/Users/jowolff/agent-scratch/agent-system-2.0/wl-mvwkt821jx4d6e/PLAN.md`, slice 5, R8 and R11) moves from a scratch folder with hand-loaded `com.plumb.*` plists into the repo's install machinery, the way the other launchd jobs are done.

**What ships.**

- Two templates in the ledger-backup / daily-report form: `install/com.agent-system-2.drive-backup.plist` runs `/bin/zsh install/drive-backup/backup-nightly.zsh` at 02:30, and `install/com.agent-system-2.drive-backup-check.plist` runs `/bin/zsh install/drive-backup/check-backup-fresh.zsh` at 09:00. Both set `HOME`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `AS2_UNDER_LAUNCHD=1`, `AS2_BUN` (absolute), `AS2_REPO` and `AS2_LEDGER_DB` (the needs-you writer's), with `AbandonProcessGroup`, `RunAtLoad` false, `ProcessType` Background, the checkout as working directory, and logs in the state dir. The nightly one also sets `AS2_KEEP_LOCAL`.
- `install/install.sh --drive-backup` fills, writes and loads both (`load_job`); `--drive-backup=off` boots both out and deletes both plists before any install step (`job_off`), like `--daily-report=off`. The flag is refused, with nothing written, off macOS, without bun on PATH, without `/usr/bin/sqlite3`, `/usr/bin/jq` or `/usr/bin/perl`, or when the installer's `AS2_KEEP_LOCAL` is not unset, `0` or `1`; given twice, or an =off form mixed with an installing flag, it is refused too. `ledger/test/install.test.ts` covers these cases against a fake launchctl and a temp HOME.
- Both scripts default their state dir to `$HOME/agent-scratch/agent-system-2.0/drive-backup/state` (created if missing) and their claims dir to `$HOME/agent-scratch/agent-system-2.0/drive-backup/claims`, instead of next to the script, so a manual run and the launchd jobs share them and nothing is written inside the checkout. Their messages name the new labels `com.agent-system-2.drive-backup[-check]`.
- Manifest rows for both templates; `install/drive-backup/README.md` and the user guide's "Nightly Google Drive backup" section describe the install, the needs-you lines and the off form.

**The load line.** Jo runs it in Terminal from the main checkout at the landed commit (an agent's shell gets `Bootstrap failed: 5`):

```
AS2_KEEP_LOCAL=1 bash install/install.sh --drive-backup
launchctl kickstart gui/$(id -u)/com.agent-system-2.drive-backup
```

The kickstart runs the nightly job once, so any macOS prompt for Drive's folders shows while Jo is at the screen.

**Ledger only at first.** Until PR #396 lands the archive producer (`scratch-archive.ts`) there is no archive root, so the first nights back up only the ledger snapshot. The Sunday restore test verifies the ledger and notes the archive part as not applicable while the first run is under 7 days old; after that the 9 AM check reports the archive root `has never existed` each morning until #396 lands (expected; plan "How it fails").

**Follow-up.** Jo chose `split`: this workload ends when the PR is green and reviewed. The load, the first real night (the ledger snapshot row, `last-run.json` success, `last-check.json` ok and the `drive-backup: check ok` entry) and the PR #396 decision are a follow-up workload.
