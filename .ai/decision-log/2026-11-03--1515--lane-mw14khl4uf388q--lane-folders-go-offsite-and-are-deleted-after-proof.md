---
date: 2026-11-03T15:15-08:00
engineer: lane-mw14khl4uf388q
session: wl-mw14khl4uf388q
status: resolved
durable: true
supersedes:
workload: wl-mw14khl4uf388q
---

# Closed lane folders go offsite through the nightly Drive backup and are deleted locally after offsite proof

## Decision

**Jo, 2026-11-03, 12:14 PM PST (input in-mw14k72c8u38lb):** lanes were the reason the backup exists. The nightly Drive backup (install/drive-backup/backup-nightly.zsh) now backs up closed lane folders under `~/.agent-system-2/lanes`, and removes each one locally once the tar of it is proven offsite.

1. **Amends Jo's 10/28 deletion rule.** The rule, as the 10/31 ship entry records it (`2026-10-31--1308--ilex--jo-2026-10-31-input-in-mvwksx9ssac8vt-ship-the-as2-nightly-g.md`, the line "Local archives are deleted only after a confirmed upload."; the brief for this workload words it "Delete local archives only after their upload to Drive is confirmed"), covered scratch archives only. It now covers lane folders too, and with `AS2_KEEP_LOCAL=0` it turns lane deletion on: a lane folder is deleted locally only after its exact tar (by sha256) has the same offsite proof a scratch archive needs before deletion (Drive for desktop's records on two nights at least 20 hours apart, then a byte-identical read-back from Google's servers, recorded as a receipt or an `.offsite` marker), and only when the content about to be removed equals the content of that proven tar. `AS2_KEEP_LOCAL=1` still deletes nothing, now neither an archive nor a lane folder. There is no second knob.
2. **Overrules the 10/30 exclusion.** The 10/30 spec line "The 27 GiB of lane logs are excluded" (`/Users/jowolff/agent-scratch/agent-system-2.0/issue-nightly-drive-backup-2026-10-30.md`, the sentence quoted here) no longer holds: lane folders are backed up.

## Why

The lanes root held 147 folders, 32.6 GB (`du -sk`), on a disk 95% full (measured 2026-11-03, PLAN wl-mw14khl4uf388q "Facts the plan rests on"). Lane folders are the agents' session logs, the record of what each lane did; they were the reason the backup was asked for, and keeping them only on a nearly full local disk risks losing them.

## How it is binding

- `surface/scripts/lane-archive.ts produce` tars a lane only when its workload is closed more than 24 h and the folder has been quiet for an hour; it never writes inside the folder. `lane-archive.ts retire` removes a folder only in one process, after the proof above, through the scratch sweep's unchanged `detachChild`, `archiveDetached` and `purgeArchived`, and only with `--keep-local 0`, which the nightly passes from `AS2_KEEP_LOCAL`.
- `as2 lane restore <wl>` puts a lane back from Drive, verified against the marker's sha256, the receipt and every entry of the content manifest. A launch of a workload whose lane is offsite is refused, naming that command.
- Tests: `surface/test/lane-archive.test.ts`, `surface/test/lane-offsite.test.ts`, and the fake-Drive round trip `install/drive-backup/test-fake-drive-lanes.zsh` (run by `surface/test/drive-backup.test.ts`), which proves that `AS2_KEEP_LOCAL=1`, and a switch from 0 to 1 between confirm and retire, purge nothing.
- The README section "Lane folders" in `install/drive-backup/README.md` documents the phases, the marker and the restore.

## Heads-up

The installed job keeps the knob it was loaded with (`AS2_KEEP_LOCAL=1`, per the plan's measured facts on 2026-11-03), so no lane folder is deleted until Jo reloads it with `AS2_KEEP_LOCAL=0 bash install/install.sh --drive-backup` from Terminal after this lands.
