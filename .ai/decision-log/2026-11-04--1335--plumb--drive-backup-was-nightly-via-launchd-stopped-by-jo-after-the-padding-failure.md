# Drive backup was a nightly launchd job; stopped by Jo 11/4 after the envelope padding failure

- status: open
- author: Plumb
- date: 2026-11-04 13:35 PST
- ticket: thewolff/jo-issues#300

## What was true
- The as2 Drive backup ran nightly from launchd (`~/Library/LaunchAgents/com.agent-system-2.drive-backup.plist`, 02:30) with a 09:00 freshness check (`com.agent-system-2.drive-backup-check.plist`). Script: `/Users/jowolff/agent-scratch/agent-system-2.0/drive-backup/backup-nightly.zsh`.
- Transport is Google Drive for desktop (Stream files mode) at `~/Library/CloudStorage/GoogleDrive-jdwolff85@gmail.com/My Drive/as2-backup/`; the job copies archives there and proves the cloud copy from Drive's own records plus a server read-back. No API, no rclone (drive-backup/README.md:3,36).
- 2026-11-04 02:33 run: 59 archives claimed, 22 uploaded and proven, 1 failure — the small-archive envelope `env-20261104T023004.e` died on `head: illegal byte count -- 0` while writing 0 bytes of padding (backup-nightly.log 02:33:14). The 37 small archives stayed local. The 09:00 check alerted on it.
- Jo, 11:40 AM: "we should stop with the backup". Plumb booted out both jobs; plists moved to `~/Library/LaunchAgents/disabled/`.

## Why no decision-log entry existed
The build and every run were logged only on the ticket (#300) and in `drive-backup/state/*.log`; no entry was written here. This entry is the record.

## Open
- Whether to re-enable after fixing the zero-padding branch (a one-line guard: skip `head -c 0`). Undo of the stop: `mv ~/Library/LaunchAgents/disabled/com.agent-system-2.drive-backup*.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/501 <each plist>`.
