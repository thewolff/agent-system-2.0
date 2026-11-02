# as2 Drive backup

A nightly job that copies as2's archived scratch folders and a snapshot of the ledger to Google Drive, unchanged (no encryption, Jo's decision 2026-10-28). It removes a local scratch archive only after three things: Drive for desktop's own records prove the cloud copy on two separate nights at least 20 hours apart, the local copy Drive for desktop keeps has been evicted, and the Drive copy then reads back from Google's servers byte-identical. Small archives make that trip inside a nightly envelope (see "Small archives: the nightly envelope").

Two launchd jobs run it, installed and loaded from the repo with `bash install/install.sh --drive-backup` (see "Before the first run").

## Files

| File | What it does |
|---|---|
| `backup-nightly.zsh` | The nightly job. Also has `--dry-run`, `--prove-only <file>` and `--verify-restore` modes. |
| `lib.zsh` | Shared helpers: the deadline runner (`bounded`), progress receipts, the alert and its delivery check. |
| `server-read.zsh` | Reads one Drive file from Google's servers: evicts the local copy, proves no complete local copy is left, reads it, checks that the read downloaded it, prints the sha256. |
| `check-backup-fresh.zsh` | The outside watcher, run at 9 AM. Alerts when the nightly job didn't run, hung, failed, has no sign its alert was shown, or left archives behind. On Sundays it also runs the restore test. |
| `install/com.agent-system-2.drive-backup.plist` | launchd template (in the repo's `install/`): runs `backup-nightly.zsh` nightly at 2:30 AM. `install.sh --drive-backup` fills, writes and loads it. |
| `install/com.agent-system-2.drive-backup-check.plist` | launchd template (in the repo's `install/`): runs `check-backup-fresh.zsh` daily at 9:00 AM. Installed with the nightly one. |
| `test-fake-drive.zsh`, `test-fake-drive-*.zsh` | Self-tests against a fake Drive, a fake DriveFS database, a fake server read and stub alerts, in parts that each run alone: `test-fake-drive.zsh` (the core nights, restore by copy, `--verify-restore`; it runs `test-server-read.zsh` first), `-proofs` (adversarial proofs and bounded hangs), `-envelope` (small archives in envelopes), `-envelope-stops` (runs that stop part-way), `-regress` and `-regress-single` (round-6 upload-record regressions for envelopes and single archives), `-crash` and `-crash-late` (a run killed after each retirement step; the round-6 envelope failure text) and `-jobs` (setup failures, the 9 AM check, the ledger-only Sunday). Each part gets its own temp dir, which it leaves in place. |
| `fake-drive-fixture.zsh` | The shared setup the fake-Drive parts source (fake Drive, fake DriveFS database and uploader, fake clock, alert stubs, helpers). Not a test itself. |
| `test-server-read.zsh` | Fixtures for `server-read.zsh`: a copy of the real script with only `osascript`, `stat` and `shasum` stubbed, 17 cases (the round-3 and round-4 reviews' cases among them; case 17 holds a full copy in the cache for the whole drain wait, on the `AS2_CLOCK_CMD` fake clock). |

Files the jobs write in the state dir, `~/agent-scratch/agent-system-2.0/drive-backup/state/` (created if missing; a manual run and the launchd jobs use the same one; `AS2_LOG` moves it for tests):

- logs: `backup-nightly.log`, `check-backup-fresh.log` (under launchd, the jobs' own output goes there too), `alert-delivery.log`
- `last-run.json`, written by every real run whatever the outcome
- `progress.json`: which step the current run is in, and that step's deadline
- `last-verify.json` and `last-check.json`. `last-check.json` `confirm` says what became of the morning confirmation: `written: <entry id>`, `skipped: AS2_BUN unset`, `failed: …`, or `not attempted: the check found problems`.
- `alerts/<stamp>-<pid>.result`: quiet-alarm's exit status for each alert, written when the popup returns
- `ledger-snapshots.tsv`: one receipt per proven ledger snapshot
- `receipts/<date>/<name>/`: the record of each archive once it is offsite and deleted
- `receipts/envelopes/<date>/env-<run stamp>.e/`: the record of each retired envelope, with its `members` list
- `backup-nightly.lock`, `first-run-epoch`, `archive-root-seen`

The claims dir, `~/agent-scratch/agent-system-2.0/drive-backup/claims/` (on the archive root's volume, outside any checkout; `AS2_CLAIMS` moves it for tests):

- `claims/<date>/<name>.d/`: archives the job has taken over and not yet deleted
- `claims/envelopes/<date>/env-<run stamp>.e/`: an envelope of small archives not yet retired (`members`, `upload`, `receipt`, `attempts`, `stuck`)

## Before the first run (Jo)

1. Drive for desktop is running and signed in to jdwolff85@gmail.com in Stream files mode. The job expects `/Users/jowolff/Library/CloudStorage/GoogleDrive-jdwolff85@gmail.com/My Drive`.
2. Check the setup without changing anything, from the main checkout:

   ```
   zsh install/drive-backup/backup-nightly.zsh --dry-run
   ```

3. Install and load both jobs, from the main checkout, in Terminal (an agent's shell gets `Bootstrap failed: 5` from launchctl):

   ```
   AS2_KEEP_LOCAL=1 bash install/install.sh --drive-backup
   launchctl kickstart gui/$(id -u)/com.agent-system-2.drive-backup
   ```

   The installer writes `~/Library/LaunchAgents/com.agent-system-2.drive-backup.plist` and `com.agent-system-2.drive-backup-check.plist` from the templates and loads both. Before loading either it prints a `drive backup retention:` step line with the `AS2_KEEP_LOCAL` value, and `AS2_KEEP_LOCAL <old> -> <new>` when the run changes it; its last step line names the schedule, the state dir, the `AS2_KEEP_LOCAL` value and the off command. If the check job fails to load after the nightly one loaded, the failure names the nightly job as loaded and its `AS2_KEEP_LOCAL`. The kickstart runs the nightly job once, now, so any macOS prompt for access to Drive's folders shows while you are at the screen. Its result is in `~/agent-scratch/agent-system-2.0/drive-backup/state/last-run.json`.

`AS2_KEEP_LOCAL=1` is the cautious first weeks: the job uploads and proves everything but never deletes a local archive. `0` lets it delete a local archive once its Drive copy is proven on two nights and read back from Google's servers. Omitted (unset or empty), the installer keeps the installed nightly job's value, so a plain `bash install/install.sh --drive-backup` reload never changes retention; only a first install with it omitted gets `0`. To turn deletion on, run the install line with `AS2_KEEP_LOCAL=0`; to turn it off, with `AS2_KEEP_LOCAL=1`; the installer rewrites and reloads both plists. Any other value is refused, and so is an omitted one when the installed nightly plist gives no `0` or `1` (set it explicitly then). Until PR #396 lands the archive producer there is no archive root, so the nightly job backs up only the ledger.

What the plists set (and the jobs read): `HOME`; `PATH=/usr/bin:/bin:/usr/sbin:/sbin` (each script then sets its own); `AS2_UNDER_LAUNCHD=1` (launchd writes the log, so the script does not copy its output there again); `AS2_BUN`, `AS2_REPO` and `AS2_LEDGER_DB` (the needs-you writer: the absolute bun, this checkout and the ledger the install used; with `AS2_BUN` unset, as in a manual run, the needs-you step is recorded as `skipped`); and, in the nightly plist only, `AS2_KEEP_LOCAL` (`0` or `1`). Both jobs have `AbandonProcessGroup` (the detached popup wrapper outlives the run) and `RunAtLoad` false.

The installer refuses the flag (exit 2, nothing written) off macOS, without bun on PATH, without `/usr/bin/sqlite3`, `/usr/bin/jq` (macOS 15 and later) or `/usr/bin/perl`, with a bad `AS2_KEEP_LOCAL`, or with `AS2_KEEP_LOCAL` omitted while the installed nightly plist gives no `0` or `1`.

To stop both jobs: `bash install/install.sh --drive-backup=off`. It boots both out and deletes both plists, and touches nothing else: the state dir, the claims and everything on Drive stay.

The backups are not encrypted. Anyone with access to the Google account can read the archives and the ledger.

## What one archive goes through

The archive producer is as2's workload close (`scratch-archive.ts`, PR #396). It writes `scratch-archive/<YYYY-MM-DD>/<name>.tar.gz` by hard link, with in-progress files named `<name>.tar.gz.partial-<12 hex>`.

1. **Claim (night 1).** The job claims a final `<name>.tar.gz` only if:
   - its link count is 1 (the producer has finished linking it)
   - its ctime is at least 10 minutes old
   - no `.offsite` marker sits next to it

   It first writes `<name>.tar.gz.attempts` at the original path. The producer's `freeName` treats that file as holding the name, so the name isn't reused while the job holds the archive. Then it renames the archive (one `rename(2)` on the same volume) into `claims/<date>/<name>.tar.gz.d/`. If the inode changed during the rename, it puts the file back. From here on, only this job touches the file. The producer's 04:30 sweep never sees it.
2. **Upload (night 1).** sha256, md5 and size of the claimed file, then `cp -n` to a new path that is never overwritten: `My Drive/as2-backup/scratch-archive/<date>/<name without .tar.gz>.<first 16 hex of the sha256>.<run stamp>.tar.gz`.
3. **Prove (night 1).** It waits, up to `AS2_PROOF_TIMEOUT` (default 3600 s) shared by all files, for the proof described below. It then writes `claims/.../receipt`, which binds the Drive path, the Drive item id, the head revision id, md5, size and sha256. **Nothing is deleted on this night.**
4. **Confirm and delete (a later night, at least 20 h after the receipt).**
   - prove again, and require the same item id and the same revision as in the receipt
   - read the whole Drive copy from Google's servers with `server-read.zsh` (below) and compare its sha256 with the receipt
   - recheck the claimed file's sha256
   - prove a third time
   - require that nothing has appeared at the original path (so a marker is never written beside a different file)
   - write `<original path>.offsite`, delete the claimed file, move the claim dir to `receipts/`, and remove `<original path>.attempts`

The ledger goes through the same upload and prove steps every night. It uses `sqlite3 -readonly ledger.db ".backup <tmp>"` (SQLite's online backup), then `pragma quick_check` and gzip, and it goes to `My Drive/as2-backup/ledger/<date>/ledger-<run stamp>-<sha16>.db.gz`. The live ledger is opened read-only. Ledger snapshots are never deleted, locally or on Drive.

The `.offsite` marker format, one `key=value` per line:

```
drive_path=/Users/jowolff/Library/CloudStorage/GoogleDrive-jdwolff85@gmail.com/My Drive/as2-backup/scratch-archive/2026-10-27/wl-aaa.0123456789abcdef.20261028T023012.tar.gz
drive_item_id=1LstHS6eMyhE0HgtZSHyoB1tDTl2FuFgb
drive_revision=0B12kMp8Kmcd_...
sha256=...
md5=...
bytes=...
first_proven_at=2026-10-28T02:31:12-0700
reproven_at=2026-10-29T02:31:40-0700
server_read_back=sha256 match after eviction
receipt=/Users/jowolff/agent-scratch/agent-system-2.0/drive-backup/state/receipts/2026-10-27/wl-aaa.tar.gz/receipt
```

Running it again is safe. Each step's state lives in the claim dir:

- a claimed archive or envelope with `upload` but no `receipt` is proven again at the recorded Drive path instead of uploaded again. The `upload` record is written before the copy, and only a receipt replaces it: a failed copy, a proof timeout and a proof error all keep it, count the night, and the next night proves that same Drive path again (OpenAI review round 6, R6-B1). A recorded path that is missing or doesn't answer locally is no proof the copy isn't on Drive, so the job never uploads afresh on its own; after 3 failed nights the item is `STUCK` and its message names the Drive path. A person confirms there is no Drive copy at that path before deleting `upload` (and `stuck`), and only then does the next night upload it under a new name.
- an earlier Drive object is never overwritten or deleted
- each retirement step can be interrupted: the next run finishes it (see "A run that stops part-way")

Two runs never overlap: the run takes `backup-nightly.lock` with `flock`.

## Small archives: the nightly envelope

The server read-back (below) only proves that bytes came from Google when the file is larger than everything Drive for desktop's content cache could hold. The cache's side files alone were 2,508,920 bytes in round 5 of the review, and 30 of the 56 measured scratch archives were smaller than that (21 were under 32 KiB). Uploaded alone, those archives could never pass the gate, so they would go `STUCK` and alarm every night. The job does not parse the SQLite WAL or shared-memory formats to shrink that floor; it makes the uploaded object large instead.

- **Threshold.** The larger of 4 × the bytes in `content_cache/chunks.db-wal`, `chunks.db-shm` and `METADATA`, and 16 MiB. It is measured once per run. A claimed archive smaller than that goes into tonight's envelope; anything at or above it is uploaded alone, as before. If the content cache can't be measured, small and large archives alike are kept and the failure says so.
- **Envelope.** One per night, holding that night's small archives: `claims/envelopes/<date>/env-<run stamp>.e/` with a `members` file (claim dir, path inside the tar, sha256, bytes, original path). Each member's claim dir gets an `envelope` file naming it. The upload is a plain tar, `MANIFEST.tsv` first (member, sha256, bytes, original path), then `PAD` (random bytes), then each archive unchanged as `<date>/<name>`. The padding brings the tar to at least the threshold. Before uploading, the job re-hashes every member, checks the tar's size, and extracts each member from the built tar to check its sha256.
- **Upload, proof, confirmation.** Exactly as for a large archive: `cp -n` to `My Drive/as2-backup/scratch-archive/<date>/env-<run stamp>.<sha16>.<run stamp>.tar`, Drive for desktop's records on the first night, then on a night at least 20 h later the re-proof, the server read-back of the whole envelope, and its sha256 against the receipt.
- **Deleting members.** Only after all of that, and only if every member not yet retired is still on disk with its recorded sha256 and its original path is still free, does the job write each such member's `.offsite` marker and delete it. One member failing those checks keeps every member still local; members a run that stopped part-way already retired remain offsite.
- **Failures.** A failing envelope is one failure that names the envelope and lists its members in two groups: `still local, kept: …` and `already retired (offsite marker present, archive gone): …` (a run that stopped part-way can leave some retired). Every member still local is kept. Failed nights are counted on the envelope; at 3 it gets `stuck` and each member still local gets `<original>.stuck`. A proof error or timeout never rebuilds the envelope: the next night proves the same recorded Drive copy again.
- **A run that stops part-way.** The `members` file is written in a hidden `.env-<stamp>.tmp` dir and renamed into place only after every member has its `envelope` file. A run that stops before the rename leaves pointers to a dir that doesn't exist; the next night removes the unfinished build and envelopes those archives again. The `upload` record is written before the copy, and the next night proves the recorded Drive path again whether or not its local pathname exists. Retiring members after the deleting night's checks goes one member at a time: `<original>.offsite` naming the envelope, the claimed archive deleted, the member's `receipt` written in its claim dir, the claim dir moved to `receipts/<date>/<name>/`; once every member is done the envelope dir moves to `receipts/envelopes/`. The next run reads each claim's `envelope` pointer before anything else and recognises where a stopped run left a member (OpenAI review round 6, R6-B2): archive still in its claim dir (checked and retired as usual), archive gone with `<original>.offsite` naming this envelope's Drive path and sha256 and the member's sha256 (its remaining steps are finished, no Drive check needed), or claim dir already in `receipts/` with a receipt naming this envelope (done). The envelope retires only when every member is finished. An archive that is gone with no such marker, and no envelope left to explain it, is a failure for a person, named.

An envelope member's `.offsite` marker:

```
envelope_drive_path=/Users/jowolff/Library/CloudStorage/GoogleDrive-jdwolff85@gmail.com/My Drive/as2-backup/scratch-archive/2026-10-29/env-20261029T023001.0123456789abcdef.20261029T023001.tar
envelope_item_id=...
envelope_revision=...
envelope_sha256=...
member=2026-10-29/wl-tiny.tar.gz
sha256=...            (of the member itself)
bytes=...
first_proven_at=...
reproven_at=...
server_read_back=envelope sha256 match (server-read.zsh)
restore=tar -xf <envelope_drive_path> -C <dir> 2026-10-29/wl-tiny.tar.gz
receipt=/Users/jowolff/agent-scratch/agent-system-2.0/drive-backup/state/receipts/2026-10-29/wl-tiny.tar.gz/receipt
```

## Proof of upload

The job reads Drive for desktop's own metadata database read-only (`sqlite3 -readonly "file:...?mode=ro"`): `~/Library/Application Support/Google/DriveFS/<account id>/metadata_sqlite_db`. The database is picked by matching its `driveway_account` property to the Drive folder's account. All reads for one proof happen inside one SQLite read transaction, so they all see the same moment.

A copy counts as proven only when all of these hold:

0. **The layout matches what was verified.** `properties.sync_engine_schema_version` and the sha256 of the five table definitions (`item_properties`, `items`, `local_stable_ids`, `properties`, `stable_parents`) equal the values pinned in `backup-nightly.zsh`. The run also checks this at setup, so a Drive for desktop update that changes the layout stops the run before anything is claimed.
1. **Exactly one live item at every level.** Walking the path from My Drive's `root_id` through `stable_parents` and `local_title` finds exactly one item at each level that isn't trashed or a tombstone. Two items with the same name is a proof error.
2. **It's in the cloud.** The item is a file with a cloud id. Local placeholders are `local-<n>` and are listed in `local_stable_ids`.
3. **No unknown or pending properties.** `local-content-size`, `dirty-handle` and `modified-date` mean the upload is still running. Any other key not on the verified list also means "not proven".
4. **The `proto` record decodes cleanly and matches.** The item's `proto` decodes completely as protobuf, and every top-level field number and wire type is on the verified list. Fields 1, 2, 14, 48 and 78 each appear exactly once, and:
   - field 1 = the item id
   - field 2 = the walked parent's id
   - field 14 = `items.file_size` = the uploaded file's size
   - field 48 = the uploaded file's md5
   - field 78 = the head revision id

   The md5 is matched only in field 48, never as a substring anywhere in the record. That checksum is computed by Drive from the bytes it stored. The Drive API documents `md5Checksum` as "Output only. The MD5 checksum for the content of the file." (https://developers.google.com/workspace/drive/api/reference/rest/v3/files).
5. **The extended attribute agrees.** If the file has the `com.google.drivefs.item-id#S` extended attribute, it names the same item.
6. **The receipt still matches (deleting night only).** The item id and the revision id are the same ones recorded when it was first proven.

The proof has three outcomes: `0` proven, `1` not proven yet (keep waiting until the deadline), `2` the proof itself broke (a layout change, an ambiguous path, an id mismatch). Only `0` counts.

**What this proof is and isn't.** It is Drive for desktop's local record of what the Drive server reported back after the upload. It isn't a Drive API call, and it depends on an undocumented database layout, which is why the layout is pinned. The independent check is the server read-back on the deleting night.

## Server read-back

A plain read of a Drive file can be served from the copy Drive for desktop keeps on this Mac, so a read-back alone would not show that Google holds the bytes. `server-read.zsh <file> <DriveFS account dir>` prints `sha256=<hex>` and exits 0 only when all of these hold, in this order. Any other result is exit 1, and the job deletes nothing.

1. `NSFileManager evictUbiquitousItemAtURL:error:` on the file succeeds. Apple: "This method doesn't remove the item from iCloud. It removes only the local version." (https://developer.apple.com/documentation/foundation/filemanager/evictubiquitousitem(at:)). Drive for desktop streams through macOS File Provider (https://support.google.com/drive/answer/12178485), and the call works on its files.
2. Within 20 s the file is dataless: `SF_DATALESS` (0x40000000) is set in its flags and it has 0 blocks on disk.
3. Drive for desktop's content cache matches the layout verified on this Mac and could hold fewer bytes than the file, so it cannot hold a complete copy. The layout is pinned: `<account dir>/content_cache` holds only the regular files `chunks.db`, `chunks.db-shm`, `chunks.db-wal` and `METADATA`, plus directories named `d<number>` that hold only regular files. Anything else fails: an unknown entry, a subdirectory, a symlink, or something that can't be read. The schema of `chunks.db` is pinned too (`PIN_CHUNKS_SCHEMA`, the sha256 of its `sqlite_master` rows; on 2026-10-28 it was one table, `ranges (id INTEGER PRIMARY KEY NOT NULL, ranges_proto BLOB)`). A different schema fails with `DriveFS content cache schema pin changed`, because an unknown table could hold the whole file inline. The bytes counted are: every `d<n>` blob file, the length of every column of every row in `chunks.db`, and the whole size of `chunks.db-wal`, `chunks.db-shm` and `METADATA`, which are counted without being parsed. Cost: while the -wal is large (1,685,112 bytes on 2026-10-28), files smaller than these side files can't pass, so they are kept rather than deleted. A copy that was just read passes through the cache and leaves it within about a minute, so the script waits up to 120 s (`AS2_SERVER_READ_DRAIN` overrides it, in seconds; the fixtures use 5).
4. After the cache check, and again right before the read, the file is still dataless with 0 blocks. A file that came back at any point during the wait fails, because another reader could have brought a local copy back.
5. The script reads the file and takes its sha256.
6. After the read the file is no longer dataless and has blocks, which shows the read caused a download.

Why this is enough: from check 4 until the read there is no complete copy in any place that was checked. So any download in that window, whether by this read or by another process, had to fetch the bytes from Google, and check 6 shows that a download happened. The one gap is a place outside `content_cache` and outside the file itself that holds file content. None was found on this Mac. The layout pin makes a new one inside `content_cache` fail instead of pass.

The weekly restore test uses the same script. `fileproviderctl` and `brctl` are not used, because both refuse to run from Plumb's sandbox ("Trying to invoke fileproviderctl from a sandboxed process").

`test-server-read.zsh [helper]` runs the real helper against fixtures, with only `osascript`, `stat` and `shasum` stubbed. Cases 11 to 16 cover the content cache: a whole copy inline in an unknown `chunks.db` table (refused as schema pin changed), a whole copy in a `ranges` row, a -wal as large as the file, a `METADATA` as large as the file (all three counted and refused), an unreadable `chunks.db`, and an extra table (schema pin changed). Real run on 2026-10-28 (`/tmp/as2-server-read-real4.log`): exit 0, the cache could hold 2,245,240 bytes (all in the side files; an earlier run the same evening saw 1,981,560, so the -wal grows) against the 4,194,304-byte test file, and the sha256 read back matched the source.

## Tested on the real Drive, 2026-10-28

All test files are under `My Drive/as2-backup/setup-check/`.

- **Proof.** `backup-nightly.zsh --prove-only` on a new 73-byte file written at 16:52:37 went through these states:
  - "no metadata row yet"
  - "local-only (`local-6611`)"
  - "upload pending (`modified-date`)" for about 10 s
  - proven at 16:52:55 as item `1LstHS6eMyhE0HgtZSHyoB1tDTl2FuFgb`, with revision `0B12kMp8Kmcd_MGx5…` and md5 `f38b3b83…`, which equals `md5 -q` of the file
- **Proof, 4 MiB.** `evict-check-20261028T172556.bin` (4,194,304 random bytes) went `local-7219` → `modified-date` pending → proven at 17:26:19, 23 s after the copy, as item `1FAHusRAbaOeLnwiuGvLX8u09-KLaW-Qm`, md5 `c61aef4a…`, which equals the md5 of the source.
- **Eviction and server read-back.** Before eviction that file had flags 64 and 8192 blocks. After eviction it had flags 1073741920 (`SF_DATALESS` set) and 0 blocks, and the content cache held no blob files. Reading it took 6.5 s and gave sha256 `c4ac0b1d…`, equal to the source. Afterwards it had 8192 blocks again and a 4 MiB blob in the content cache, which was empty again within 50 s. At 18:01:43, `server-read.zsh` on the same file exited 0 in 3 s: it evicted the file, found it dataless, found a 0-byte cache, saw it still dataless before the read, and saw the read materialize it (flags 64, 8192 blocks). It printed sha256 `c4ac0b1d…` (log `/tmp/as2-server-read-real2.log`).
- **Envelope.** At 19:11:41 a 16,786,944-byte envelope, built with the job's own tar command around one 323-byte gzip member plus 16 MiB of padding, was copied to `setup-check/env-check-20261028T191141.tar`. A `server-read.zsh` attempt straight after the copy refused it; the next one, 30 s later, exited 0: the cache could hold 2,517,160 bytes (all side files) against the 16,786,944-byte envelope, the read materialized it, and the sha256 `8737c3f4…` equals the built envelope's. `tar -xf <envelope> -C <dir> 2026-10-29/wl-tiny.tar.gz` then gave the member back with sha256 `98a604cf…`, equal to the original (log `/tmp/as2-envelope-real.log`).
- **Census** of this Mac's DriveFS database: the field meanings in proof check 4 hold for every cloud file record that has a field 48. The census script is `/tmp/as2-proto-census2.zsh`, which is outside this folder and is temporary.
- Not tested on the real Drive: an upload that never finishes (Drive offline, quota full). The fake-Drive test covers that path.

## Restore

The backups are plain files, so a restore is a copy. Finder works (drag the file out of the Google Drive location with Option held, so it copies instead of moving; Google: "Dragging items in and out of a Google Drive folder will **move** them. The cloud file will be trashed if moved out." https://support.google.com/drive/answer/12178485). From a terminal:

**A scratch archive** (the Drive path and sha256 are in its `.offsite` marker):

```
cp -n "/Users/jowolff/Library/CloudStorage/GoogleDrive-jdwolff85@gmail.com/My Drive/as2-backup/scratch-archive/2026-10-27/wl-aaa.0123456789abcdef.20261028T023012.tar.gz" ~/Desktop/wl-aaa.tar.gz
shasum -a 256 ~/Desktop/wl-aaa.tar.gz
mkdir ~/Desktop/wl-aaa-restored && tar -xzf ~/Desktop/wl-aaa.tar.gz -C ~/Desktop/wl-aaa-restored
```

Compare the printed sha256 with `sha256` in the marker.

**A small archive inside an envelope** (its marker has `envelope_drive_path` and `member` instead of `drive_path`). Extract just that member, then compare its sha256 with `sha256` in the marker:

```
mkdir ~/Desktop/restored
tar -xf "/Users/jowolff/Library/CloudStorage/GoogleDrive-jdwolff85@gmail.com/My Drive/as2-backup/scratch-archive/2026-10-29/env-20261029T023001.0123456789abcdef.20261029T023001.tar" -C ~/Desktop/restored 2026-10-29/wl-tiny.tar.gz
shasum -a 256 ~/Desktop/restored/2026-10-29/wl-tiny.tar.gz
```

The envelope is a plain tar (not gzipped); `tar -tf <envelope>` lists it and `MANIFEST.tsv` inside it names every member with its sha256.

**The ledger** (the newest Drive path is the last line of `ledger-snapshots.tsv`, column 2; column 3 is its sha256):

```
cp -n "<path from ledger-snapshots.tsv>" ~/Desktop/ledger.db.gz
gunzip ~/Desktop/ledger.db.gz
sqlite3 ~/Desktop/ledger.db "pragma quick_check"
```

Before replacing the live `~/.agent-system-2/ledger.db`, stop as2. Move the old file and its `-wal` and `-shm` files aside (don't delete them), then put the restored file in place. `cp -n` never overwrites an existing file. Reading a streamed file downloads it, so Drive for desktop has to be running.

**Weekly restore test.** `backup-nightly.zsh --verify-restore` takes the newest archive receipt, the newest envelope receipt and the newest ledger snapshot. For each it evicts the local copy, reads it back from Google's servers, and compares the sha256 with the recorded one. It also checks the tar, extracts one member from the envelope (`tar -xf <envelope> -C <dir> <member>`) and compares its sha256 with the one recorded when it joined, runs `quick_check` on the ledger, and writes `last-verify.json` (`result`, `archive`, `notes`, `failures`). The ledger is always verified. With neither an archive nor an envelope receipt, the archive part depends on `archive-root-seen`, the same 7-day grace the 9 AM check uses: while the archive root has never existed, or first existed under 7 days ago, `archive` is `not applicable: no archive made yet` and a note says why (not a failure: the ledger-only period before as2 makes its first archive). After that, no receipt is a `verify-archive` failure. `check-backup-fresh.zsh` runs it on Sundays, with a 2-hour deadline.

## How it fails

The job sends at most one alert per run. Every failure is also in `backup-nightly.log` and in the `failures` list of `last-run.json` (path, step, error). A real run writes `last-run.json` whatever the outcome, including an unplanned exit. Every external command runs under a deadline: 60 s for small steps, 5 min for eviction, 1 h for hashing, copying and reading back. A command past its deadline has its whole process group killed, and that archive counts as failed for the night. `progress.json` shows the current step and its deadline.

**The needs-you line.** While `com.agent-system-2.drive-backup-check.plist` is installed and no check entry (ok or failed) is newer than 30 h, Jo's needs-you list shows `Drive backup check missed: …`. If the check has never written an entry, the plist file's time is the baseline. The line does not expire; the next check entry clears it. On a clean run the 9 AM check writes `drive-backup: check ok` and records the result in last-check.json `confirm`. If that write fails, the check counts it as a problem and alerts.

**How an alert goes out.** Each alert uses three channels, in the order set by the alarm rule (silent channels first, then a silent popup; nothing plays a sound until Jo asks for it). (1) A needs-you entry: `surface/scripts/drive-backup-notice.ts` writes `drive-backup: <nightly|check> failed <date> — <text> — <state file>` on the standing workload. Jo's needs-you list shows `Drive backup <job> failed <date>: <text> — <state file>` until the next clean 9 AM check writes `drive-backup: check ok`. The writer runs as `$AS2_BUN run $AS2_REPO/surface/scripts/drive-backup-notice.ts` on `$AS2_LEDGER_DB`, bounded to 60 s. With AS2_BUN unset (a manual run) the step is recorded as `skipped: AS2_BUN unset`. (2) A macOS notification, with no sound. (3) quiet-alarm's silent popup, which speaks only on "Read it to me". A broken channel never stops the next one. The state file's `alert` field records all three: `<popup>; notification rc <n>; needs-you <written: en-…|skipped: …|failed: …>`. The other job reports every failed channel. quiet-alarm exits 0 only after its popup was shown and answered, 1 when the popup could not be shown, and 3 when Jo picked "Read it to me" and the sound or speech failed. A detached wrapper writes that exit status to `alerts/<stamp>-<pid>.result` when quiet-alarm returns. A running process is never taken as delivery. The other job reads the result named in the state file:

- `rc=0`: the popup was shown (and, if Jo picked Read it to me, the sound and speech played)
- `rc=3` with a `quiet-alarm: audio FAILED: afplay rc <n> (…); say rc <m> (…)` line: the popup was shown and Jo picked Read it to me, but the sound or the speech failed. The state file's `alert` reads `audio failed: …` when the result came inside the window; either way the other job reports `the read-aloud failed: …`
- any other `rc`, or an immediate failure: reported at once as "not delivered" or "the popup failed"
- no result 6 hours after the alert: reported as "no sign the popup was shown". This covers a popup that stalled before showing, and also one still sitting unanswered on the screen.

| What broke | What you see | What happened to the data | Next step |
|---|---|---|---|
| Drive folder missing (signed out, account changed) | Alert `drive-root: … Drive root missing`; `result: setup-failed` | Nothing touched | Sign in to Drive for desktop. |
| Google Drive app or its File Provider extension not running | Alert `drive-app: … not running` | Nothing touched | Open Google Drive. |
| Drive's metadata DB not found or unreadable | Alert `drivefs-db: …` | Nothing touched | Check that Drive for desktop is set up for jdwolff85@gmail.com. |
| A Drive for desktop update changed its database layout | Alert `drivefs-schema: DriveFS metadata schema pin changed: …` | Nothing touched, nothing claimed or deleted | The proof has to be re-verified for the new layout and the pins updated. Until then, nothing is backed up. |
| On the deleting night the content cache's `chunks.db` schema no longer matches the pin | The nightly alert title starts `schema pin changed,` and the text starts `Schema pin changed (confirm): no proven server read … DriveFS content cache schema pin changed …`; the 9 AM check also alerts `schema pin changed: …` | Archives kept, no markers | Re-verify `server-read.zsh` against the new cache format, then update `PIN_CHUNKS_SCHEMA`. Until then nothing is deleted locally; uploads and proofs carry on. |
| Another run is still going | Alert `lock: …` | Nothing touched | Usually a slow previous night. `progress.json` says where it is. |
| The archive root vanished after it once existed | Alert `archive-root: … existed on an earlier run` | Nothing touched | Check the path and the disk. |
| No private temp dir | Alert `tempdir: …` | Nothing touched | Check disk space. |
| One archive fails to hash, or its Drive path is taken or can't be checked before the copy | Alert naming that archive and the step; the others carry on | That archive stays in `claims/`; no `upload` record was written | The next night retries it. |
| A step hangs (Drive stops answering, a read blocks) | `TIMEOUT: <step> did not finish within Ns` in the log; the alert names the archive | That archive kept; the run carries on | Usually clears; repeated nights end in `stuck`. |
| An upload isn't proven by the deadline | Alert `prove: … not proven (timeout): <last reason> …; the upload record stays and the next night proves <Drive path> again` | Archive kept, `upload` kept | The next night proves the same copy again, never a fresh upload. After 3 failed nights it is `STUCK` (row below). |
| The proof itself errors (two items with the same name, an unknown proto field) | Alert `prove: … not proven (failed): <reason> …` | Archive kept, `upload` kept | Look at the reason. The next night proves the same copy again; 3 failed nights make it `STUCK`. |
| The copy to Drive fails (cp exits nonzero, or its deadline passes) | Alert `copy: cp to <Drive path> failed: …; the upload record … stays` | Archive kept, `upload` kept (it was written before the copy) | The copy may have reached Drive anyway, so the next night proves that path, never a new upload. |
| On the deleting night there is no proven server read: the local copy can't be evicted, the file comes back before the read, the content cache doesn't match the verified layout or still holds a complete copy, or the read didn't download | Alert `confirm: no proven server read …` with the reason | Archive kept, no marker | Check that Drive for desktop is running. A cache layout change needs `server-read.zsh` re-verified. If this happens every night, the 9 AM check reports the archive as `proven, deletion re-proof keeps failing` after 3 days, and the third failed night marks it `STUCK`. |
| On the deleting night the Drive item, its revision, or its server bytes differ from the receipt (replaced, edited or trashed on Drive) | Alert `confirm: … re-proof … failed` or `reads back from the server as sha256 …` | Archive kept, no marker | Find out what changed the Drive copy. |
| The original path holds a new file on the deleting night | Alert `confirm: … exists again (a different file)` | Archive kept, no marker beside the newcomer | The producer reused the name; tell the agent. |
| The same archive fails 3 nights in a row | Alert says `STUCK after 3 failed nights … <path>`, and when it has an upload record `the upload record names the Drive copy <Drive path> …; a person confirms there is no Drive copy at <Drive path> before deleting claims/…/upload to allow a fresh upload`; `claims/…/stuck` (with the same text) and `<original>.stuck` appear | Archive kept in `claims/`; later nights skip it without alerting again; no further copy | Fix the cause, then delete `claims/<date>/<name>.d/stuck`. The next night retries it from zero, proving the recorded Drive copy again. Delete `upload` too only after confirming there is no Drive copy at the path it names. |
| An envelope fails (a member changed or vanished, the tar can't be built, the copy, proof, server read or re-proof fails) | One failure naming the envelope and its members: `… (envelope of N small archive(s); still local, kept: …; already retired (offsite marker present, archive gone): …)` | Every member still local kept in `claims/`, no marker for them | As for a large archive. The night is counted on the envelope; a proof timeout or error keeps `upload` and the next night proves the same copy. |
| An envelope fails 3 nights in a row | Alert `STUCK … envelope <dir> (… members …; the upload record names the Drive copy <Drive path> …)`; `<envelope>/stuck` and each local member's `<original>.stuck` | Every member still local is kept; already-retired members remain offsite. Later nights skip the envelope | Fix the cause, then delete `claims/envelopes/<date>/env-<stamp>.e/stuck`. Delete its `upload` too only after confirming there is no Drive copy at the path it names. |
| A run stopped part-way through retiring an envelope's members (crash, power loss) | Nothing: the next run finishes the stopped member's remaining steps and the rest | Members already deleted stay retired; the others are retired as usual | None. A claim whose archive is gone with no marker naming its envelope and no live envelope is the `claim dir … has no archive file` failure; a person checks where it went. |
| The content cache can't be measured for the envelope threshold | Alert `envelope: … cannot work out the envelope threshold …` for each claimed archive not yet uploaded | Archives kept | Check Drive for desktop; `content_cache` belongs next to its metadata DB. |
| An envelope on Drive is lost or corrupt after its members were deleted | The weekly restore test fails `verify-envelope-…` for the newest envelope; a restore by hand fails its sha256 check | Every small archive in that envelope is gone at once | This is why no member is deleted before the envelope's two-night proof, its server read-back sha256, and every member's own sha256 all hold. |
| Ledger snapshot, gzip, copy or proof fails | Alert `ledger-<step>: …`; `"ledger": "failed"` | Live ledger untouched | The next night takes a new snapshot. |
| The job never ran | 9 AM check alert `last nightly run ended N h ago … powered off at 2:30 AM (a sleeping Mac runs the job on wake), or launchd did not start it`, or `no last-run.json` | n/a | Check `launchctl print gui/$(id -u)/com.agent-system-2.drive-backup`; reload both jobs with `bash install/install.sh --drive-backup` from the main checkout, in Terminal (with `AS2_KEEP_LOCAL` omitted it keeps the installed value). |
| The job is still running at 9 AM | Nothing, if it is inside its step deadline and started under 12 h ago (`last-check.json` has a note); an alert `is hung` or `running N h` otherwise | n/a | A hung run's step is in `progress.json`. |
| Last night failed | 9 AM check alert: `last nightly run result is 'failure' … first: …` | See that night's alert | The same as the matching row above. |
| The nightly alert was not shown | 9 AM check alert: `the nightly run's own alert: not delivered …`, `the popup failed …` or `no sign the popup was shown …` | n/a | Check `alert-delivery.log`, the `alerts/` result file and `quiet-alarm.zsh`. |
| Read it to me was silent | 9 AM check alert `the nightly run's own alert: the read-aloud failed: … afplay rc <n> (…); say rc <m> (…)`, or nightly `watcher-alert: the 9 AM check's alert: the read-aloud failed: …` | n/a | The popup reached Jo; only the sound or speech failed. Check the `alerts/` result file for each command's stderr, then the Mac's output device and `say`/`afplay` by hand. |
| The 9 AM check's alert was not shown | Nightly alert `watcher-alert: the 9 AM check's alert: …` | n/a | Same as the row above. |
| The needs-you entry was not written | 9 AM check alert `the nightly run's own alert: the needs-you entry was not written: …`, or nightly `watcher-alert: … the needs-you entry was not written: …` | n/a | Check AS2_BUN, AS2_REPO and AS2_LEDGER_DB in the plist, then run the writer by hand with the same arguments. |
| The notification failed | `the notification failed: rc <n> (…)` in the other job's alert | n/a | Allow notifications for the job (System Settings > Notifications). |
| The morning confirmation was not written | 9 AM check alert `the morning confirmation (drive-backup: check ok) was not written …` | n/a | As for the needs-you entry; the Drive backup line stays until a check ok lands. |
| A public archive is older than 3 days (never claimed), with or without a marker | 9 AM check alert listing each path | Archive kept | Usually comes with a setup failure above. |
| A claimed archive is older than 3 days and not deleted | 9 AM check alert listing each one (`STUCK`, `proven…`, `not proven yet`; an envelope member says `in envelope <dir>` and the envelope's state) | Archive kept | See the matching row above. |
| The archive root has never existed 7 days after the first run | 9 AM check alert `has never existed` | n/a | No archive was ever made, or the path is wrong. |
| The weekly restore test fails | Alert `as2 Drive restore test: … verify-<step>` | Nothing deleted | Treat the backup as unproven; copy the file back by hand (Restore above) and compare. Before the archive root is 7 days old with no archive yet, no archive receipt is a note in `last-verify.json` (`archive: not applicable: no archive made yet`), not this failure. |
| The 9 AM watcher stopped running, never started, or its state is malformed | Nightly alert `watcher: …` | n/a | Check `launchctl print gui/$(id -u)/com.agent-system-2.drive-backup-check`; reload both jobs with `bash install/install.sh --drive-backup` from the main checkout, in Terminal (with `AS2_KEEP_LOCAL` omitted it keeps the installed value). |
| A state file can't be written | Alert `heartbeat: …` or `could not write last-check.json` | n/a | Check disk space and permissions. |
| The state dir can't be created | The run stops before anything else with `cannot create the state dir …` on stderr (the Terminal on a manual run); under launchd no state file is written, so Jo's needs-you list shows `Drive backup check missed: …` after 30 h | Nothing touched | Check that `~/agent-scratch/agent-system-2.0/` is writable; the install line in "Before the first run" creates the dir. |

What the job never does:

- delete or overwrite anything on Drive
- prune ledger snapshots
- delete a local archive without a receipt that was re-proven on a later night and a matching read-back from Google's servers
- touch a `.partial-*` file, a `.verify-*` folder, or an archive with more than one link

The 04:30 scratch sweep removes `.offsite`, `.attempts` and `.stuck` only once the sidecar itself is past 14 days and its archive is gone.

## Overrides for testing

`AS2_DRIVE_ROOT`, `AS2_DRIVEFS_DB`, `AS2_ARCHIVE_ROOT`, `AS2_CLAIMS`, `AS2_LEDGER_DB`, `AS2_LOG` (state files go next to it), `AS2_ALERT_CMD`, `AS2_ALERT_FALLBACK`, `AS2_ALERT_ACK`, `AS2_ALERT_ACK_WINDOW`, `AS2_NO_ALERT=1`, `AS2_SKIP_APP_CHECK=1`, `AS2_PROOF_TIMEOUT`, `AS2_PROOF_POLL`, `AS2_CLAIM_QUIET`, `AS2_REPROVE_AFTER`, `AS2_T_SHORT`, `AS2_T_LONG`, `AS2_T_SERVER_READ`, `AS2_SERVER_READ_CMD`, `AS2_SERVER_READ_DRAIN`, `AS2_TMPDIR`, `AS2_UNDER_LAUNCHD=1`, `AS2_ENVELOPE_FLOOR` (bytes; default 16 MiB). The checker also takes `AS2_NOW_EPOCH`, `AS2_FORCE_VERIFY=1` and `AS2_VERIFY_TIMEOUT`.

Test seams, each a no-op when unset, so the suites never wait on wall time (Jo's timing rule, decision log 2026-10-28--0840):

- `AS2_CLOCK_CMD`: a command printing the current epoch seconds. Every in-run deadline reads it instead of the system clock: the proof wait (`backup-nightly.zsh`), the bounded command runner (`lib.zsh` `bounded`), the alert's result window (`lib.zsh` `alert`) and the pause between `server-read.zsh`'s drain scans. A test moves this clock past a deadline instead of waiting for it.
- `AS2_PROOF_POLL_HOOK`: a command the proof wait runs before each proof pass. The fake-Drive suite uses it to run its fake uploader once, synchronously. A failing hook is a failure of the run.
- `AS2_RUNSTAMP`: the run stamp (`YYYYMMDDTHHMMSS`) in Drive names, so two test runs in one second get distinct names.
- `AS2_CRASH_AFTER=<step>[:<n>]`: the run kills itself with SIGKILL right after the first (or n-th) time it completes `<step>`, one of `upload-recorded` (the upload record written, before the copy), `marker` (a member's `.offsite` written), `unlink` (a member's archive deleted), `member-receipt`, `claim-moved` and `envelope-moved`. Nothing after the step runs (no heartbeat, no alert), as in a crash. The crash and regression suites use it.

```
zsh install/drive-backup/test-fake-drive.zsh
zsh install/drive-backup/test-fake-drive-proofs.zsh
zsh install/drive-backup/test-fake-drive-envelope.zsh
zsh install/drive-backup/test-fake-drive-envelope-stops.zsh
zsh install/drive-backup/test-fake-drive-regress.zsh
zsh install/drive-backup/test-fake-drive-regress-single.zsh
zsh install/drive-backup/test-fake-drive-crash.zsh
zsh install/drive-backup/test-fake-drive-crash-late.zsh
zsh install/drive-backup/test-fake-drive-jobs.zsh
```

Each part's last line is `RESULT: 0 failure(s)` when everything passes, and the exit status is the failure count. Each part sets up its own fake Drive and data from `fake-drive-fixture.zsh`, so they run alone and in any order; each prints its test dir and leaves it in place. In the repo, `bun test surface/test/drive-backup.test.ts` runs every `test-*.zsh` here (macOS only), each under its own temp HOME and TMPDIR; `bun test surface/test/drive-backup.test.ts -t test-fake-drive-crash` runs one part (a test is named after its file).
