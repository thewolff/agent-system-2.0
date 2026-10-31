#!/bin/zsh
# Nightly as2 backup to Google Drive for desktop (Stream files mode).
#
#   zsh backup-nightly.zsh                        real run (launchd runs this at 2:30 AM)
#   zsh backup-nightly.zsh --dry-run              check setup, list what would happen, change nothing
#   zsh backup-nightly.zsh --prove-only <file>    run the upload proof on one file in My Drive, change nothing
#   zsh backup-nightly.zsh --verify-restore       read the newest archive receipt's Drive copy and the newest ledger
#                                                 snapshot, compare sha256, check the tar and the ledger's quick_check
#
# One archive's life (producer contract: CloseArchivesScratch, scratch-archive.ts, PR #396):
#   claim    a final <root>/<date>/<name>.tar.gz with nlink 1 whose ctime is at least 10 min old is renamed
#            (rename(2), same volume) into claims/<date>/<name>.d/. Before the rename <name>.attempts is written at
#            the original path; the producer's freeName treats it as holding the name, so the name is never reused.
#            From here on only this job touches the file; the producer's sweep never sees it.
#   upload   sha256, md5 and size of the claimed file; copy it unchanged (no encryption, Jo 2026-10-28) with cp -n to
#            the unique, never-overwritten Drive path
#            My Drive/as2-backup/scratch-archive/<date>/<id>.<sha256 first 16>.<run stamp>.tar.gz
#   prove    wait (one shared deadline) until Drive for desktop's own metadata records the upload (see prove_once);
#            write a receipt binding the Drive item id, its head revision id, md5 and size. Nothing is deleted.
#   confirm  on a LATER run, at least 20 h after the receipt: prove again against the receipt (same item, same
#            revision, same md5 and size), read it from Google's servers (server-read.zsh: evict the local copy,
#            prove none is left, read, check the read downloaded it) and compare its sha256, recheck the claimed
#            file's sha256, prove once more, then write <original path>.offsite, delete the claimed file, and move
#            the receipt to receipts/. AS2_KEEP_LOCAL=1 stops before this step (receipts only, nothing deleted).
# Small archives travel in a nightly envelope (OpenAI review round 5, R5-B1): the server-read gate can only prove a
# read came from Google when the file is larger than everything Drive for desktop's content cache could hold, and
# its side files alone are ~2.5 MB. So a claimed archive smaller than the envelope threshold
# max(4 x the content cache's side-file bytes, 16 MiB) is not uploaded alone. Each night's small archives go into one
# envelope: claims/envelopes/<date>/env-<run stamp>.e/ lists them (members: claim dir, path in the tar, sha256,
# bytes, original path); each member's claim dir gets an `envelope` file naming it. The envelope is a plain tar
# (MANIFEST.tsv, PAD of random bytes, then each archive unchanged as <date>/<name>) at least as large as the
# threshold, uploaded with cp -n to as2-backup/scratch-archive/<date>/env-<stamp>.<sha16>.<run stamp>.tar, proven,
# and confirmed exactly like a large archive (receipt, 20 h, re-proof, server read, sha256). Only then is every
# member re-hashed against its recorded sha256 and deleted, with <original>.offsite naming the envelope and the
# member. A failing envelope keeps every member and is counted (and goes stuck) as one item.
# Plus each night the ledger: sqlite3 -readonly .backup, quick_check, gzip, unique Drive path
#   as2-backup/ledger/<date>/ledger-<run stamp>-<sha256 first 16>.db.gz, proven, receipt appended. Never deleted.
#
# Fault tolerance (Jo's standing principles, decision log 2026-10-27 fault-tolerance-principles):
#   - setup failures (lock, Drive root/app, DriveFS DB or its schema, archive root, temp dir) stop the run
#   - one archive failing never stops the others; every failure is reported (path, step, error)
#   - every external command runs under a deadline (bounded, lib.zsh); progress.json says which step until when
#   - no retries inside a run; a failed archive is retried by the next night; after 3 failed nights it gets
#     claims/.../stuck (and <original>.stuck) and is skipped until a person deletes claims/.../stuck
#   - never deletes without a re-proved receipt, never deletes or overwrites anything on Drive
#   - every real run writes last-run.json (start, end, result, counts, failures, alert delivery), success or not
#
# Overrides (tests only): AS2_DRIVE_ROOT, AS2_DRIVEFS_DB, AS2_ARCHIVE_ROOT, AS2_CLAIMS, AS2_LEDGER_DB, AS2_LOG
#   (state files live next to it), AS2_ALERT_CMD, AS2_ALERT_FALLBACK, AS2_NO_ALERT=1, AS2_SKIP_APP_CHECK=1,
#   AS2_PROOF_TIMEOUT, AS2_PROOF_POLL, AS2_CLAIM_QUIET, AS2_REPROVE_AFTER, AS2_T_SHORT, AS2_T_LONG (seconds),
#   AS2_SERVER_READ_CMD, AS2_T_SERVER_READ, AS2_TMPDIR, AS2_UNDER_LAUNCHD=1 (plists set it), AS2_ENVELOPE_FLOOR (bytes).
# Test seams, each a no-op when unset: AS2_RUNSTAMP (the run stamp, YYYYMMDDTHHMMSS, so runs in one second get
#   distinct names), AS2_PROOF_POLL_HOOK (a command run before each proof pass), AS2_CLOCK_CMD (lib.zsh clock_now: a
#   command printing the epoch seconds every in-run deadline reads).
# Settings: AS2_KEEP_LOCAL=1 (upload and prove, never delete).

emulate -L zsh
setopt pipe_fail no_unset extended_glob
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin

HERE=${0:A:h}
SCRIPT=${0:A}
MODE=run
PROVE_ARG=""
case "${1:-}:$#" in
  :0) ;;
  --dry-run:1) MODE=dry ;;
  --prove-only:2) MODE=prove; PROVE_ARG=$2 ;;
  --verify-restore:1) MODE=verify ;;
  *) print -u2 "usage: zsh backup-nightly.zsh [--dry-run | --prove-only <file in My Drive> | --verify-restore]"; exit 2 ;;
esac
MODE_LABEL=$MODE

LOG=${AS2_LOG:-$HERE/backup-nightly.log}
STATE=${LOG:h}
HEARTBEAT=$STATE/last-run.json
PROGRESS=$STATE/progress.json
[[ $MODE == run ]] || PROGRESS=""
VERIFY_BEAT=$STATE/last-verify.json
WATCHER_BEAT=$STATE/last-check.json
FIRST_RUN=$STATE/first-run-epoch
ROOT_SEEN=$STATE/archive-root-seen
LEDGER_RECEIPTS=$STATE/ledger-snapshots.tsv
RECEIPTS=$STATE/receipts
CLAIMS=${AS2_CLAIMS:-$HERE/claims}
ARCHIVE_ROOT=${AS2_ARCHIVE_ROOT:-/Users/jowolff/agent-scratch/agent-system-2.0/scratch-archive}
LEDGER_DB=${AS2_LEDGER_DB:-$HOME/.agent-system-2/ledger.db}
ALERT_CMD=${AS2_ALERT_CMD:-$HERE/quiet-alarm.zsh}
ALERT_FALLBACK=${AS2_ALERT_FALLBACK:-/usr/bin/osascript}
DEFAULT_MYDRIVE="/Users/jowolff/Library/CloudStorage/GoogleDrive-jdwolff85@gmail.com/My Drive"
KEEP_LOCAL=${AS2_KEEP_LOCAL:-0}
PROOF_TIMEOUT=${AS2_PROOF_TIMEOUT:-3600}
PROOF_POLL=${AS2_PROOF_POLL:-10}
CLAIM_QUIET=${AS2_CLAIM_QUIET:-600}          # producer is done with a final archive long before this
REPROVE_AFTER=${AS2_REPROVE_AFTER:-72000}    # 20 h between the first proof and the deleting re-proof
WATCHER_GRACE=$(( 36*3600 ))                 # first run -> watcher heartbeat must exist by then
T_SHORT=${AS2_T_SHORT:-60}                   # sqlite query, stat, xattr, mkdir, rm
T_LONG=${AS2_T_LONG:-3600}                   # hash, copy into Drive, read back, ledger .backup
STUCK_AFTER=3
SERVER_READ_CMD=${AS2_SERVER_READ_CMD:-$HERE/server-read.zsh}   # run with /bin/zsh <file> <DriveFS account dir>
T_SERVER_READ=${AS2_T_SERVER_READ:-$(( T_LONG + 300 ))}   # evict and drain (up to 140 s) plus the read (as T_LONG)
ENVELOPE_FLOOR=${AS2_ENVELOPE_FLOOR:-16777216}   # 16 MiB: the smallest envelope, and the size under which an archive goes into one
ENVELOPE_FACTOR=4                                # the envelope is at least 4 x the content cache's side files
SQLITE=/usr/bin/sqlite3   # not the Android SDK sqlite3 that is first on Jo's PATH
JQ=/usr/bin/jq

# DriveFS layout this proof was verified against (2026-10-28, Drive for desktop on this Mac). Any difference is a
# proof error: the archive is kept and the run reports it.
PIN_SCHEMA=0A1A73796E635F656E67696E655F736368656D615F76657273696F6E1802
PIN_TABLES_SHA=4ffa7d5b7c2780b8cff9cbe935b861b7d927402a1b4775f1ac02553e4ad37f02   # sha256 of the five tables' "name:sql" joined by \n, in name order
PIN_FIELDS=( 1/2 2/2 3/2 4/2 5/0 7/0 10/0 11/0 13/0 14/0 22/0 23/0 26/0 31/0 44/0 45/2 46/2 47/2 48/2 55/2 57/2
             63/0 69/0 75/0 78/2 84/2 88/0 89/0 93/2 94/0 111/2 124/0 125/2 132/2 133/2 136/2 140/2 160/0 )
PROPS_DONE=( content-entry crtime file-provider-pre-create-id local-content-modified-date local-insertion-time local-title version-counter )
# modified-date: seen for ~5 s on a fresh upload while it committed (2026-10-28 16:51:11), gone at the next poll.
PROPS_PENDING=( local-content-size dirty-handle modified-date )

source "$HERE/lib.zsh" || { print -u2 "cannot source $HERE/lib.zsh"; exit 1 }
ALERT_ACK=${AS2_ALERT_ACK:-3}
ALERT_ACK_WINDOW=${AS2_ALERT_ACK_WINDOW:-21600}   # 6 h for a popup's result before the other job alarms

if [[ ${AS2_UNDER_LAUNCHD:-0} != 1 ]]; then
  exec > >(tee -a "$LOG") 2>&1
fi

START_TS=$(ts); START_EPOCH=$EPOCHSECONDS
# AS2_RUNSTAMP (test seam): two test runs in one second need distinct Drive names; it keeps the real stamp's form.
if [[ -n ${AS2_RUNSTAMP:-} ]]; then
  [[ $AS2_RUNSTAMP == [0-9](#c8)T[0-9](#c6) ]] || { print -u2 -r -- "AS2_RUNSTAMP '$AS2_RUNSTAMP' is not YYYYMMDDTHHMMSS; nothing done"; exit 2 }
  RUNSTAMP=$AS2_RUNSTAMP
else
  RUNSTAMP=$(strftime '%Y%m%dT%H%M%S' $EPOCHSECONDS)
fi
TODAY=$(strftime '%Y-%m-%d' $EPOCHSECONDS)

# ---------- small bounded helpers (print the value, or the error and return nonzero) ----------
sha256_of() { local o; o=$(bounded $T_LONG "sha256 $1" /usr/bin/shasum -a 256 -- "$1" 2>&1) || { print -r -- "$o"; return 1 }
              [[ ${o%% *} == [0-9a-f](#c64) ]] || { print -r -- "shasum said: $o"; return 1 }; print -r -- ${o%% *} }
md5_of() { local o; o=$(bounded $T_LONG "md5 $1" /sbin/md5 -q -- "$1" 2>&1) || { print -r -- "$o"; return 1 }
           [[ $o == [0-9a-f](#c32) ]] || { print -r -- "md5 said: $o"; return 1 }; print -r -- $o }
size_of() { local o; o=$(bounded $T_SHORT "stat $1" /usr/bin/stat -f %z -- "$1" 2>&1) || { print -r -- "$o"; return 1 }
            [[ $o == <-> ]] || { print -r -- "stat said: $o"; return 1 }; print -r -- $o }
kv() { # <file> <key>: value of key=value line
  local l; for l in "${(@f)$(<$1)}"; do [[ $l == $2=* ]] && { print -r -- "${l#$2=}"; return 0 }; done; return 1
}

# ---------- failures, alert, heartbeat ----------
local -a F_PATH F_STEP F_ERR NEW_STUCK SKIPPED_STUCK
fail_item() { # <path> <step> <error>  record and keep going
  F_PATH+=( "$1" ); F_STEP+=( "$2" ); F_ERR+=( "$3" )
  info "FAILED [$2] $1: $3"
}
typeset -A C; C=( seen 0 claimed 0 uploaded 0 proven 0 waiting_reproof 0 deleted 0 kept_local 0 enveloped 0 )
LEDGER_RESULT=not-run RESULT="" ROOT_STATE=present
json_array() { (( $# )) || { print -r -- '[]'; return 0 }; print -rl -- "$@" | $JQ -R . | $JQ -sc . }
failures_json() {
  local i out='[]'
  (( ${#F_PATH} )) || { print -r -- "$out"; return 0 }
  for i in {1..${#F_PATH}}; do
    out=$($JQ -c --arg p "${F_PATH[$i]}" --arg s "${F_STEP[$i]}" --arg e "${F_ERR[$i]}" '. + [{path:$p, step:$s, error:$e}]' <<<"$out")
  done
  print -r -- "$out"
}
write_heartbeat() { # <result>; returns nonzero if it could not be written
  local tmp=$HEARTBEAT.tmp.$$ body
  body=$($JQ -n --arg start "$START_TS" --argjson start_epoch $START_EPOCH --arg end "$(ts)" --argjson end_epoch $EPOCHSECONDS \
    --arg result "$1" --arg log "$LOG" --arg ledger "$LEDGER_RESULT" --arg root "$ROOT_STATE" --arg alert "$ALERT_STATUS" \
    --arg alert_result "$ALERT_RESULT" --argjson alert_epoch $ALERT_EPOCH \
    --argjson seen ${C[seen]} --argjson claimed ${C[claimed]} --argjson uploaded ${C[uploaded]} --argjson proven ${C[proven]} \
    --argjson waiting ${C[waiting_reproof]} --argjson deleted ${C[deleted]} --argjson kept ${C[kept_local]} --argjson enveloped ${C[enveloped]} \
    --argjson failed ${#F_PATH} --argjson keep_local $(( KEEP_LOCAL == 1 )) \
    --argjson new_stuck "$(json_array $NEW_STUCK)" --argjson skipped_stuck "$(json_array $SKIPPED_STUCK)" \
    --argjson failures "$(failures_json)" \
    '{start:$start, start_epoch:$start_epoch, end:$end, end_epoch:$end_epoch, result:$result, log:$log,
      archive_root:$root, keep_local:($keep_local==1), alert:$alert, alert_result:$alert_result, alert_epoch:$alert_epoch,
      counts:{public_archives_seen:$seen, claimed:$claimed, uploaded:$uploaded, proven:$proven,
              waiting_reproof:$waiting, offsite_and_deleted:$deleted, kept_local:$kept, enveloped:$enveloped, failed:$failed,
              newly_stuck:($new_stuck|length), skipped_stuck:($skipped_stuck|length)},
      ledger:$ledger, newly_stuck:$new_stuck, skipped_stuck:$skipped_stuck, failures:$failures}' 2>&1) || { info "heartbeat JSON: $body"; return 1 }
  write_file "$HEARTBEAT" "$body"
}
NORMAL_EXIT=0
finish() { NORMAL_EXIT=1; exit $1 }
setup_fail() { # <step> <path> <error>: stop at once
  fail_item "$2" "$1" "$3"
  RESULT=setup-failed
  finish 1
}

WORK=""
on_exit() {
  local rc=$?
  trap - EXIT
  if (( NORMAL_EXIT == 0 )); then
    fail_item "$SCRIPT" aborted "exit $rc during step '${CUR_STEP:-?}' (not a planned exit)"
    (( rc == 0 )) && rc=1
  fi
  if [[ -n $WORK && -d $WORK ]]; then
    local o; o=$(bounded $T_SHORT "remove temp dir" /bin/rm -rf -- "$WORK" 2>&1) || fail_item "$WORK" cleanup "could not remove temp dir: $o"
  fi
  if [[ $MODE == run ]]; then
    [[ -z $RESULT ]] && RESULT=$( (( rc == 0 && ${#F_PATH} == 0 )) && print success || print failure )
    write_heartbeat "$RESULT" || { fail_item "$HEARTBEAT" heartbeat "could not write last-run.json"; RESULT=failure; rc=1 }
  fi
  if (( ${#F_PATH} > 0 )) && [[ $MODE == (run|verify) && ${AS2_NO_ALERT:-0} != 1 ]]; then
    # One alert per run: the first failure, how many more, and every newly stuck archive.
    local more="" stuck="" what="as2 Drive backup" where="$HEARTBEAT and $LOG" pin="" i
    [[ $MODE == verify ]] && { what="as2 Drive restore test"; where=$LOG }
    (( ${#F_PATH} > 1 )) && more=" (and $(( ${#F_PATH} - 1 )) more)"
    (( ${#NEW_STUCK} )) && stuck="STUCK after $STUCK_AFTER failed nights, no longer retried until its claims/.../stuck file is deleted: ${(j:, :)NEW_STUCK}. "
    # A pin refusal blocks every proof or deletion until a person re-verifies and updates the pin: name it first.
    for i in {1..${#F_ERR}}; do [[ ${F_ERR[$i]} == *"schema pin changed"* ]] && { pin="Schema pin changed (${F_STEP[$i]}): ${F_ERR[$i]} "; break }; done
    alert "$what: ${pin:+schema pin changed, }${#F_PATH} failure(s)" \
      "${pin}${stuck}${F_STEP[1]}: ${F_PATH[1]}: ${F_ERR[1]}${more}. Details: $where" \
      "The $what has ${#F_PATH} failures. Details are in the log."
    # record the delivery result; the 9 AM check reports a failed delivery
    [[ $MODE == run ]] && { write_heartbeat "$RESULT" || info "could not record alert delivery in $HEARTBEAT" }
  fi
  [[ -n $PROGRESS ]] && write_file "$PROGRESS" "{\"pid\":$$,\"mode\":\"$MODE\",\"start_epoch\":$START_EPOCH,\"step\":\"finished\",\"step_deadline_epoch\":0,\"updated_epoch\":$EPOCHSECONDS,\"finished\":true}"
  print -r -- "$(ts) == run finished ($MODE), exit $rc"
  exit $rc
}
trap on_exit EXIT

say_step "as2 Drive backup start (mode=$MODE, pid $$)"

# ---------- setup: each failure here stops the run ----------
if [[ $MODE == (run|verify) ]]; then
  { : >> "$STATE/backup-nightly.lock" } 2>/dev/null && zsystem flock -t 0 -f LOCK_FD "$STATE/backup-nightly.lock" 2>/dev/null \
    || setup_fail lock "$STATE/backup-nightly.lock" "another backup-nightly.zsh run holds the lock (two runs never overlap), or the lock file cannot be opened"
fi
[[ $MODE == run && ! -f $FIRST_RUN ]] && { write_file "$FIRST_RUN" "$EPOCHSECONDS" || setup_fail state "$FIRST_RUN" "state dir not writable" }
progress "setup" 0

say_step "setup 1: Drive for desktop"
MYDRIVE=${AS2_DRIVE_ROOT:-$DEFAULT_MYDRIVE}
bounded $T_SHORT "stat Drive root" /bin/test -d "$MYDRIVE" || setup_fail drive-root "$MYDRIVE" "Drive root missing or not answering (is Drive for desktop signed in?)"
if [[ ${AS2_SKIP_APP_CHECK:-0} != 1 ]]; then
  pgrep -x "Google Drive" >/dev/null || setup_fail drive-app "Google Drive.app" "not running; streamed files only exist while it runs. Open Google Drive."
  pgrep -f DFSFileProviderExtension >/dev/null || setup_fail drive-app DFSFileProviderExtension "File Provider extension not running. Quit and reopen Google Drive."
fi
ACCOUNT_EMAIL=${${MYDRIVE:h:t}#GoogleDrive-}
info "drive root: $MYDRIVE (account $ACCOUNT_EMAIL)"

say_step "setup 2: DriveFS metadata DB (the proof source) and its layout"
sq() { bounded $T_SHORT "DriveFS query" $SQLITE -readonly -bail -cmd '.timeout 5000' "file:$DRIVEFS_DB?mode=ro" "$@" 2>&1 }
TABLES_SQL="select hex(group_concat(name||':'||sql, char(10))) from (select name, sql from sqlite_master where type='table' and name in ('item_properties','items','local_stable_ids','properties','stable_parents') order by name)"
if [[ -n ${AS2_DRIVEFS_DB:-} ]]; then
  DRIVEFS_DB=$AS2_DRIVEFS_DB
else
  DRIVEFS_DB=""
  for db in $HOME/Library/Application\ Support/Google/DriveFS/<->/metadata_sqlite_db(N); do
    DRIVEFS_DB=$db
    out=$(sq "select count(*) from properties where property='driveway_account' and instr(value, cast('$ACCOUNT_EMAIL' as blob))>0") && [[ $out == 1 ]] && break
    DRIVEFS_DB=""
  done
  [[ -n $DRIVEFS_DB ]] || setup_fail drivefs-db "$HOME/Library/Application Support/Google/DriveFS" "no metadata_sqlite_db for $ACCOUNT_EMAIL"
fi
pins=$(sq "select 'schema|'||ifnull((select hex(value) from properties where property='sync_engine_schema_version'),''); select 'tables|'||($TABLES_SQL);") \
  || setup_fail drivefs-db "$DRIVEFS_DB" "unreadable: $pins"
pins_ok() { # <query output with schema| and tables| lines>: prints a reason and returns 1 on drift
  local l s="" t=""
  for l in "${(@f)1}"; do [[ $l == schema\|* ]] && s=${l#schema|}; [[ $l == tables\|* ]] && t=${l#tables|}; done
  [[ $s == $PIN_SCHEMA ]] || { print -r -- "sync_engine_schema_version is $s, the proof was verified against $PIN_SCHEMA"; return 1 }
  t=$(print -rn -- "$t" | /usr/bin/xxd -r -p | /usr/bin/shasum -a 256); t=${t%% *}
  [[ $t == $PIN_TABLES_SHA ]] || { print -r -- "table definitions hash $t, the proof was verified against $PIN_TABLES_SHA"; return 1 }
}
why=$(pins_ok "$pins") || setup_fail drivefs-schema "$DRIVEFS_DB" "DriveFS metadata schema pin changed: Drive for desktop's database layout changed ($why). No archive can be proven or deleted until the proof is re-verified for the new layout and the pins updated."
info "DriveFS metadata DB: $DRIVEFS_DB (layout matches the verified pins)"
DRIVEFS_DIR=${DRIVEFS_DB:h}

# ---------- proof ----------
# proto_decode <hex>: top-level protobuf fields into PF_NUM/PF_WT/PF_VAL (varint as decimal, bytes as lowercase hex).
# Returns 1 (PF_ERR set) on any malformed or truncated input; the whole blob has to be consumed.
proto_decode() {
  local h=${1:l} i=1 n=${#1} b v sh len wt
  PF_NUM=() PF_WT=() PF_VAL=() PF_ERR=""
  rdvar() { # sets v from h at i
    v=0 sh=0
    while true; do
      (( i + 1 <= n )) || { PF_ERR="truncated varint at byte $(( (i-1)/2 ))"; return 1 }
      b=$(( 16#${h[i,i+1]} )); i=$(( i + 2 ))
      (( sh < 63 )) || { PF_ERR="varint too long"; return 1 }
      v=$(( v | ((b & 127) << sh) )); sh=$(( sh + 7 ))
      (( b & 128 )) || break
    done
  }
  [[ $h == [0-9a-f]# ]] && (( n % 2 == 0 )) || { PF_ERR="not hex"; return 1 }
  while (( i <= n )); do
    rdvar || return 1
    PF_NUM+=( $(( v >> 3 )) ); wt=$(( v & 7 )); PF_WT+=( $wt )
    case $wt in
      0) rdvar || return 1; PF_VAL+=( "$v" ) ;;
      1) (( i + 15 <= n )) || { PF_ERR="truncated fixed64"; return 1 }; PF_VAL+=( "${h[i,i+15]}" ); i=$(( i + 16 )) ;;
      2) rdvar || return 1; len=$v
         (( i + 2*len - 1 <= n )) || { PF_ERR="field ${PF_NUM[-1]} overruns the blob"; return 1 }
         PF_VAL+=( "${h[i,i+2*len-1]}" ); i=$(( i + 2*len )) ;;
      5) (( i + 7 <= n )) || { PF_ERR="truncated fixed32"; return 1 }; PF_VAL+=( "${h[i,i+7]}" ); i=$(( i + 8 )) ;;
      *) PF_ERR="wire type $wt in field ${PF_NUM[-1]}"; return 1 ;;
    esac
  done
  (( ${#PF_NUM} == ${#PF_VAL} )) || { PF_ERR="internal: field/value count mismatch"; return 1 }
}
unhex() { local x=$1 k c s=""; for (( k = 1; k < ${#x}; k += 2 )); do c=$(( 16#${x[k,k+1]} )); s+=${(#)c}; done; print -rn -- "$s" }

# prove_once <drive file> <md5> <size> [<receipt item id> <receipt revision>]
# Proven means, from ONE consistent read (one sqlite read transaction) of Drive for desktop's own database:
#   0. the schema version and the five table definitions equal the pins above
#   1. walking the path from My Drive's root_id through stable_parents + local_title finds exactly one live item
#      at every level (more than one is an error, none is "not yet")
#   2. the item is a file with a cloud id (local placeholders are "local-<n>" and sit in local_stable_ids)
#   3. every item_properties key is known: none of PROPS_PENDING (upload still running), nothing unknown
#   4. items.proto decodes completely; every top-level field number/wire type is in PIN_FIELDS; fields
#      1 (id), 2 (parent id), 14 (size), 48 (md5, 32 hex chars), 78 (head revision id) each occur exactly once;
#      field 1 = items.id, field 2 = the parent's id, field 14 = items.file_size = the uploaded size,
#      field 48 = the uploaded file's md5 (Drive API md5Checksum: computed by Drive from the bytes it stored)
#   5. the xattr com.google.drivefs.item-id#S, if present and not a local id, names the same item
#   6. with a receipt: the same item id and the same head revision id as when it was first proven
# Verified 2026-10-28 on this Mac: field meanings hold for all 4,608 cloud blob files in this DB that carry a
# field 48 (census script in the README); a new upload flips from local-N/size 0/local-content-size to all of
# the above at once. This is Drive for desktop's record of what the Drive server returned, not a server API call.
# Prints "proven <item id> <revision> ..." or a reason. Returns 0 proven, 1 not proven (yet), 2 proof error.
prove_once() {
  local f=$1 want_md5=$2 want_size=$3 want_id=${4:-} want_rev=${5:-}
  [[ $want_md5 == [0-9a-f](#c32) && $want_size == <-> ]] || { print "bad md5/size argument"; return 2 }
  [[ $f == $MYDRIVE/?* ]] || { print "not under My Drive: $f"; return 2 }
  local rel=${f#$MYDRIVE/} sq1="'" vals="" k=0 comp
  local -a comps; comps=( ${(s:/:)rel} )
  for comp in $comps; do k=$(( k + 1 )); vals+="${vals:+,}($k,'${comp//$sq1/$sq1$sq1}')"; done
  local n=${#comps}
  local cte="WITH RECURSIVE c(d,t) AS (VALUES $vals),
    w(d,sid) AS (SELECT 0, i.stable_id FROM items i, properties p WHERE p.property='root_id' AND i.id=cast(p.value AS text)
      UNION ALL SELECT w.d+1, i.stable_id FROM w JOIN c ON c.d=w.d+1 JOIN stable_parents sp ON sp.parent_stable_id=w.sid
        JOIN items i ON i.stable_id=sp.item_stable_id AND i.local_title=c.t AND i.trashed=0 AND i.is_tombstone=0)"
  local out
  out=$(sq "BEGIN;
    select 'schema|'||ifnull((select hex(value) from properties where property='sync_engine_schema_version'),'');
    select 'tables|'||($TABLES_SQL);
    $cte select 'walk|'||d||'|'||count(*) from w group by d order by d;
    $cte select 'item|'||i.id||'|'||(i.stable_id in (select stable_id from local_stable_ids))||'|'||i.is_folder||'|'||ifnull(i.file_size,-1)
         ||'|'||ifnull((select group_concat(key, ',') from item_properties p where p.item_stable_id=i.stable_id),'')
         ||'|'||ifnull((select pi.id from items pi where pi.stable_id=(select sid from w where d=$(( n - 1 )) limit 1)),'')
         ||'|'||ifnull(hex(i.proto),'')
       from items i where i.stable_id in (select sid from w where d=$n);
    COMMIT;") || { print "DriveFS DB query failed: $out"; return 2 }
  local why; why=$(pins_ok "$out") || { print "DriveFS metadata schema pin changed: $why"; return 2 }
  local l; local -a walk items
  for l in "${(@f)out}"; do
    [[ $l == walk\|* ]] && walk+=( ${l#walk|} )
    [[ $l == item\|* ]] && items+=( ${l#item|} )
  done
  local -A cnt; for l in $walk; do cnt[${l%%|*}]=${l#*|}; done
  [[ ${cnt[0]:-0} == 1 ]] || { print "My Drive root not found exactly once (${cnt[0]:-0})"; return 2 }
  for k in {1..$n}; do
    [[ -n ${cnt[$k]:-} ]] || { print "no live metadata row for '${comps[$k]}' yet"; return 1 }
    (( cnt[$k] == 1 )) || { print "ambiguous: ${cnt[$k]} live items named '${comps[$k]}'"; return 2 }
  done
  (( ${#items} == 1 )) || { print "expected one item row, got ${#items}"; return 2 }
  local -a c; c=( "${(@s:|:)items[1]}" )
  (( ${#c} == 7 )) || { print "unexpected item row shape (${#c} columns)"; return 2 }
  local id=${c[1]} inlocal=${c[2]} folder=${c[3]} fsize=${c[4]} keys=${c[5]} parent=${c[6]} hex=${c[7]}
  [[ $folder == 0 ]] || { print "is a folder"; return 2 }
  [[ $id == local-* || $inlocal == 1 ]] && { print "item still local-only ($id)"; return 1 }
  local key
  for key in ${(s:,:)keys}; do
    (( ${PROPS_PENDING[(Ie)$key]} )) && { print "upload pending (item property $key)"; return 1 }
    # Unknown keys never prove; they may be transient, so keep polling, and a deadline reached with one still
    # present is reported with this reason.
    (( ${PROPS_DONE[(Ie)$key]} )) || { print "unknown DriveFS item property '$key' (layout not verified for it; not proven)"; return 1 }
  done
  [[ -n $hex ]] || { print "item has no proto yet"; return 1 }
  proto_decode "$hex" || { print "proto does not decode: $PF_ERR"; return 2 }
  local -A once val; local j fw
  for j in {1..${#PF_NUM}}; do
    fw=${PF_NUM[$j]}/${PF_WT[$j]}
    (( ${PIN_FIELDS[(Ie)$fw]} )) || { print "unknown proto field $fw (layout not verified)"; return 2 }
    case ${PF_NUM[$j]} in 1|2|14|48|78) once[${PF_NUM[$j]}]=$(( ${once[${PF_NUM[$j]}]:-0} + 1 )); val[${PF_NUM[$j]}]=${PF_VAL[$j]} ;; esac
  done
  for k in 1 2 14 48 78; do
    [[ ${once[$k]:-0} == 1 ]] && continue
    [[ $k == (48|78) && ${once[$k]:-0} == 0 ]] && { print "no checksum/revision recorded yet (field $k)"; return 1 }
    print "proto field $k occurs ${once[$k]:-0} times"; return 2
  done
  local p_id=$(unhex ${val[1]}) p_parent=$(unhex ${val[2]}) p_md5=$(unhex ${val[48]}) p_rev=$(unhex ${val[78]})
  [[ $p_id == $id ]] || { print "proto id $p_id != items.id $id"; return 2 }
  [[ -n $parent && $p_parent == $parent ]] || { print "proto parent $p_parent != walked parent ${parent:-none}"; return 2 }
  [[ ${val[14]} == $fsize ]] || { print "proto size ${val[14]} != items.file_size $fsize"; return 2 }
  [[ $p_md5 == [0-9a-f](#c32) ]] || { print "proto md5 field is not 32 hex chars"; return 2 }
  [[ $p_rev == [A-Za-z0-9_-](#c10,200) ]] || { print "proto revision field has an unexpected form"; return 2 }
  if [[ -n $want_id ]]; then
    [[ $id == $want_id ]] || { print "Drive item is $id, the receipt says $want_id (replaced on Drive)"; return 2 }
    [[ $p_rev == $want_rev ]] || { print "Drive revision is $p_rev, the receipt says $want_rev (changed on Drive)"; return 2 }
  fi
  local xid
  if xid=$(bounded $T_SHORT "xattr $f" /usr/bin/xattr -p 'com.google.drivefs.item-id#S' "$f" 2>/dev/null); then
    [[ $xid == local-* || $xid == $id ]] || { print "xattr item id $xid != DB item $id"; return 2 }
  fi
  [[ $fsize == $want_size ]] || { print "cloud size $fsize != $want_size"; return 1 }
  [[ $p_md5 == $want_md5 ]] || { print "cloud md5 $p_md5 != $want_md5 (older revision, or upload not finished)"; return 1 }
  print "proven $id $p_rev size $want_size md5 $want_md5"
  return 0
}

if [[ $MODE == prove ]]; then
  f=$PROVE_ARG; [[ $f == /* ]] || f=$MYDRIVE/$f
  say_step "prove-only: $f (reading it computes its md5; a streamed file is downloaded)"
  bounded $T_SHORT "stat $f" /bin/test -f "$f" || { info "not a file: $f"; finish 1 }
  m=$(md5_of "$f") || { info "cannot read $f: $m"; finish 1 }
  s=$(size_of "$f") || { info "cannot stat $f: $s"; finish 1 }
  rc=0; msg=$(prove_once "$f" "$m" "$s") || rc=$?
  info "$msg"
  print -r -- "$(ts) == prove-only result: rc $rc (0 proven, 1 not proven, 2 proof error)"
  finish $rc
fi

say_step "setup 3: archive root $ARCHIVE_ROOT and claims dir $CLAIMS"
if bounded $T_SHORT "stat archive root" /bin/test -d "$ARCHIVE_ROOT"; then
  [[ -r $ARCHIVE_ROOT && -x $ARCHIVE_ROOT ]] || setup_fail archive-root "$ARCHIVE_ROOT" "not readable"
  [[ $MODE == run && ! -f $ROOT_SEEN ]] && { write_file "$ROOT_SEEN" "$EPOCHSECONDS" || setup_fail state "$ROOT_SEEN" "state dir not writable" }
elif [[ -f $ROOT_SEEN ]]; then
  setup_fail archive-root "$ARCHIVE_ROOT" "missing, but it existed on an earlier run (moved, unmounted or misconfigured?)"
else
  ROOT_STATE=absent-never-seen
  info "archive root does not exist yet and never has (no archive made yet); the 9 AM check reports this after 7 days"
fi
if [[ $MODE == run ]]; then
  [[ -d $CLAIMS ]] || zf_mkdir -p -m 700 -- "$CLAIMS" || setup_fail claims "$CLAIMS" "cannot create the claims dir"
fi

say_step "setup 4: private temp dir"
WORK=$(mktemp -d "${AS2_TMPDIR:-${TMPDIR:-/tmp}}/as2-drive-backup.XXXXXX") || setup_fail tempdir "${AS2_TMPDIR:-${TMPDIR:-/tmp}}" "mktemp failed"
chmod 700 "$WORK" || setup_fail tempdir "$WORK" "chmod failed"

# server_sha <Drive file> <label>: server-read.zsh evicts Drive for desktop's local copy, proves no complete
# local copy is left (dataless file, pinned content-cache layout holding less than the file, rechecked right
# before the read), reads the file and checks the read caused a download. Prints the sha256, or the reason,
# and returns nonzero on any failure; the caller then deletes nothing.
server_sha() {
  local o h; local -a ol
  o=$(bounded $T_SERVER_READ "server read $2" /bin/zsh "$SERVER_READ_CMD" "$1" "$DRIVEFS_DIR" 2>&1) \
    || { print -r -- "no proven server read, so the bytes could have come from this Mac instead of Google: ${o//$'\n'/; }"; return 1 }
  ol=( "${(@f)o}" ); h=${ol[-1]#sha256=}
  [[ ${ol[-1]} == sha256=* && $h == [0-9a-f](#c64) ]] || { print -r -- "server read printed no sha256: ${o//$'\n'/; }"; return 1 }
  (( ${#ol} > 1 )) && info "$2: ${ol[-2]}" >&2
  print -r -- "$h"
}

# ---------- envelope helpers (small archives; see the header) ----------
local -a M_CD M_MEM M_SHA M_BYTES M_ORIG
M_ERR=""
envelope_members() { # <envelope dir>: its members file into M_CD M_MEM M_SHA M_BYTES M_ORIG; 1 and M_ERR if malformed
  M_CD=() M_MEM=() M_SHA=() M_BYTES=() M_ORIG=() M_ERR=""
  [[ -f $1/members ]] || { M_ERR="no members file in $1"; return 1 }
  local l; local -a f
  for l in "${(@f)$(<$1/members)}"; do
    [[ -n $l ]] || continue
    f=( "${(@ps:\t:)l}" )
    (( ${#f} == 5 )) && [[ ${f[3]} == [0-9a-f](#c64) && ${f[4]} == <-> ]] || { M_ERR="malformed line in $1/members: $l"; return 1 }
    M_CD+=( "${f[1]}" ); M_MEM+=( "${f[2]}" ); M_SHA+=( "${f[3]}" ); M_BYTES+=( "${f[4]}" ); M_ORIG+=( "${f[5]}" )
  done
  (( ${#M_CD} )) || { M_ERR="empty members file in $1"; return 1 }
}
ENV_THRESH="" ENV_SIDE="" ENV_ERR=""
envelope_threshold() { # once per run: ENV_THRESH = max(ENVELOPE_FACTOR x side-file bytes, ENVELOPE_FLOOR); 1 and ENV_ERR if unmeasurable
  [[ -n $ENV_THRESH ]] && return 0
  local cc=$DRIVEFS_DIR/content_cache f s t=0
  bounded $T_SHORT "stat content cache" /bin/test -d "$cc" || { ENV_ERR="Drive for desktop's content cache $cc is missing or not answering"; return 1 }
  for f in chunks.db-wal chunks.db-shm METADATA; do
    [[ -e $cc/$f ]] || continue
    s=$(size_of "$cc/$f") || { ENV_ERR="cannot size $cc/$f: $s"; return 1 }
    t=$(( t + s ))
  done
  ENV_SIDE=$t
  ENV_THRESH=$(( ENVELOPE_FACTOR * t > ENVELOPE_FLOOR ? ENVELOPE_FACTOR * t : ENVELOPE_FLOOR ))
  info "envelope threshold $ENV_THRESH bytes: the larger of $ENVELOPE_FACTOR x $t content-cache side-file bytes and $ENVELOPE_FLOOR"
}

# ---------- --verify-restore ----------
if [[ $MODE == verify ]]; then
  say_step "verify-restore: newest archive receipt, newest envelope (one member extracted) and newest ledger snapshot, read from Google's servers"
  local -a rcpts; rcpts=()
  for r in $RECEIPTS/*/*/receipt(N.) $CLAIMS/*/*.d/receipt(N.); do zstat -A mt +mtime -- "$r" && rcpts+=( "${mt[1]} $r" ); done
  picked=""
  for r in ${(nO)rcpts}; do
    r=${r#* }
    d=$(kv "$r" drive_path) && h=$(kv "$r" sha256) && [[ $h == [0-9a-f](#c64) ]] && { picked=$r; break }
  done
  if [[ -z $picked ]]; then
    info "no individually uploaded archive has a receipt yet"
  else
    info "archive: $d (receipt $picked)"
    if ! got=$(server_sha "$d" "archive"); then fail_item "$d" verify-archive-read "$got"
    elif [[ $got != $h ]]; then fail_item "$d" verify-archive-hash "Drive copy sha256 $got != recorded $h"
    else
      info "archive restore OK: sha256 $got"
      bounded $T_LONG "tar -t" /usr/bin/tar -tzf "$d" >/dev/null 2>&1 || fail_item "$d" verify-archive-tar "the Drive copy is not a readable tar.gz"
    fi
  fi
  # The newest envelope: a server read of the whole envelope, then one member extracted the way README § Restore
  # says (tar -xf <envelope> -C <dir> <member>) and compared with the sha256 recorded when it joined the envelope.
  local -a ercpts; ercpts=()
  for r in $RECEIPTS/envelopes/*/*.e/receipt(N.) $CLAIMS/envelopes/*/*.e/receipt(N.); do zstat -A mt +mtime -- "$r" && ercpts+=( "${mt[1]} $r" ); done
  epicked=""
  for r in ${(nO)ercpts}; do
    r=${r#* }
    ed_=$(kv "$r" drive_path) && eh=$(kv "$r" sha256) && [[ $eh == [0-9a-f](#c64) ]] && envelope_members "${r:h}" && { epicked=$r; break }
  done
  if [[ -z $epicked ]]; then
    info "no envelope has a receipt yet"
  else
    info "envelope: $ed_ (receipt $epicked)"
    if ! got=$(server_sha "$ed_" "envelope"); then fail_item "$ed_" verify-envelope-read "$got"
    elif [[ $got != $eh ]]; then fail_item "$ed_" verify-envelope-hash "Drive copy sha256 $got != recorded $eh"
    else
      info "envelope restore OK: sha256 $got"
      mem=${M_MEM[1]} msha=${M_SHA[1]}
      zf_mkdir -m 700 -- "$WORK/restore"
      if ! o=$(bounded $T_LONG "extract $mem" /usr/bin/tar -xf "$ed_" -C "$WORK/restore" "$mem" 2>&1); then
        fail_item "$ed_" verify-envelope-member "cannot extract $mem from the Drive envelope: $o"
      elif ! o=$(sha256_of "$WORK/restore/$mem"); then fail_item "$ed_" verify-envelope-member "extracted $mem is unreadable: $o"
      elif [[ $o != $msha ]]; then fail_item "$ed_" verify-envelope-member "member $mem extracted from the Drive envelope has sha256 $o, recorded $msha"
      else info "member $mem extracted from the Drive envelope: sha256 matches the record"
      fi
    fi
  fi
  [[ -z $picked && -z $epicked ]] && fail_item "$RECEIPTS" verify-archive "no archive or envelope receipt with a drive_path and sha256"
  lrow=""; if [[ -f $LEDGER_RECEIPTS ]]; then local -a lrows; lrows=( "${(@f)$(<$LEDGER_RECEIPTS)}" ); lrow=${lrows[-1]:-}; fi
  if [[ -z $lrow ]]; then
    fail_item "$LEDGER_RECEIPTS" verify-ledger "no ledger snapshot receipt recorded yet"
  else
    local -a lr; lr=( "${(@ps:\t:)lrow}" )   # proven_at, drive_path, sha256 of the .db.gz, item id, revision
    info "ledger: ${lr[2]}"
    if ! got=$(server_sha "${lr[2]}" "ledger"); then fail_item "${lr[2]}" verify-ledger-read "$got"
    elif [[ $got != ${lr[3]} ]]; then fail_item "${lr[2]}" verify-ledger-hash "Drive copy sha256 $got != recorded ${lr[3]}"
    else
      info "ledger restore OK: sha256 $got"
      if bounded $T_LONG gunzip /bin/zsh -fc '/usr/bin/gunzip -c -- "$1" > "$2"' zsh "${lr[2]}" "$WORK/l.db" 2>/dev/null; then
        chk=$(bounded $T_LONG "quick_check" $SQLITE "$WORK/l.db" "pragma quick_check;" 2>&1)
        [[ $chk == ok ]] && info "ledger snapshot opens, quick_check ok" || fail_item "${lr[2]}" verify-ledger-sqlite "quick_check: $chk"
      else
        fail_item "${lr[2]}" verify-ledger-gunzip "not valid gzip"
      fi
    fi
  fi
  vresult=$( (( ${#F_PATH} )) && print failure || print success )
  body=$($JQ -n --arg at "$(ts)" --argjson at_epoch $EPOCHSECONDS --arg result $vresult --argjson failures "$(failures_json)" \
    '{at:$at, at_epoch:$at_epoch, result:$result, failures:$failures}')
  write_file "$VERIFY_BEAT" "$body" || fail_item "$VERIFY_BEAT" verify-state "could not write last-verify.json"
  say_step "verify-restore: $vresult (temp copies removed on exit)"
  (( ${#F_PATH} )) && finish 1 || finish 0
fi

# ---------- outside watcher of the watcher ----------
if [[ $MODE == run ]]; then
  if [[ -f $WATCHER_BEAT ]]; then
    wat=$($JQ -r '.at_epoch // empty' "$WATCHER_BEAT" 2>/dev/null)
    if [[ $wat != <-> ]]; then fail_item "$WATCHER_BEAT" watcher "last-check.json is unreadable or malformed"
    elif (( EPOCHSECONDS - wat > 26*3600 )); then fail_item "$WATCHER_BEAT" watcher "check-backup-fresh.zsh has not run for over 26 h (is com.plumb.as2-drive-backup-check loaded?)"
    fi
    wal=$(alert_ack_problem "$WATCHER_BEAT" $EPOCHSECONDS $ALERT_ACK_WINDOW)
    [[ -n $wal ]] && fail_item "$WATCHER_BEAT" watcher-alert "the 9 AM check's alert: $wal"
  else
    first=$(<$FIRST_RUN)
    (( EPOCHSECONDS - first > WATCHER_GRACE )) && fail_item "$WATCHER_BEAT" watcher "check-backup-fresh.zsh has never written last-check.json, $(( (EPOCHSECONDS - first) / 3600 )) h after the first backup run (is com.plumb.as2-drive-backup-check loaded?)"
  fi
fi

# ---------- claim bookkeeping ----------
attempts_of() { [[ -f $1/attempts ]] || { print 0; return }; local -a al; al=( "${(@f)$(<$1/attempts)}" ); [[ ${al[1]:-} == <-> ]] && print ${al[1]} || print 0 }
claim_failed() { # <claim dir> <step> <error>: record, count the night, mark stuck at the limit
  local cd=$1 origin=$(<$1/origin)
  fail_item "$origin" "$2" "$3 (claimed copy: $cd)"
  [[ $MODE == dry ]] && return 0
  local n=$(( $(attempts_of "$cd") + 1 ))
  write_file "$cd/attempts" "$n"$'\n'"$(ts) $2: $3" || fail_item "$cd" state "cannot write $cd/attempts"
  write_file "$origin.attempts" "$n failed night(s); claimed by as2 drive-backup into $cd" || fail_item "$origin.attempts" state "cannot update"
  if (( n >= STUCK_AFTER )); then
    write_file "$cd/stuck" "$(ts) stuck after $n failed nights; last: $2: $3. Delete this file to let the next night retry." \
      || fail_item "$cd" state "cannot write $cd/stuck"
    write_file "$origin.stuck" "stuck in as2 drive-backup: see $cd/stuck" || fail_item "$origin.stuck" state "cannot write"
    NEW_STUCK+=( "$origin" )
    info "STUCK: $origin ($n failed nights). The next nights skip it until $cd/stuck is deleted."
  else
    info "failed nights for $origin: $n of $STUCK_AFTER"
  fi
}
same_volume() { local -A a b; zstat -H a -- "$1" 2>/dev/null && zstat -H b -- "$2" 2>/dev/null && [[ ${a[device]} == ${b[device]} ]] }
perl_rename() { bounded $T_SHORT "rename $1" /usr/bin/perl -e 'rename($ARGV[0], $ARGV[1]) or die "rename: $!\n"' -- "$1" "$2" }
perl_link() { bounded $T_SHORT "link $1" /usr/bin/perl -e 'link($ARGV[0], $ARGV[1]) or die "link: $!\n"' -- "$1" "$2" }

# claim <public archive>: 0 claimed, 1 not ready or gone (no failure), 2 failure (recorded)
claim() {
  local a=$1 day=${1:h:t} name=${1:t} cd=$CLAIMS/${1:h:t}/${1:t}.d o
  local -A st after
  zstat -L -H st -- "$a" 2>/dev/null || { info "gone before claim (producer dropped or expired it): $a"; return 1 }
  (( st[nlink] == 1 )) || { info "not ready (nlink ${st[nlink]}: the producer is still linking it): $a"; return 1 }
  (( EPOCHSECONDS - st[ctime] >= CLAIM_QUIET )) || { info "not ready (changed $(( EPOCHSECONDS - st[ctime] ))s ago, waits ${CLAIM_QUIET}s): $a"; return 1 }
  if [[ -e $a.offsite ]]; then fail_item "$a" claim "a public archive sits beside an existing .offsite marker; leaving both for a person"; return 2; fi
  if [[ -e $cd ]]; then fail_item "$a" claim "claim dir $cd already exists; leaving the archive for a person"; return 2; fi
  [[ $MODE == dry ]] && { info "DRY RUN: would claim $a into $cd"; return 1 }
  zf_mkdir -p -m 700 -- "$CLAIMS/$day" 2>/dev/null
  same_volume "${a:h}" "$CLAIMS/$day" || { fail_item "$a" claim "claims dir $CLAIMS is on another volume; a claim must be a rename"; return 2 }
  [[ -e $a.attempts ]] || write_file "$a.attempts" "0 failed nights; claimed by as2 drive-backup into $cd" \
    || { fail_item "$a" claim "cannot write $a.attempts (the name reservation); not claiming"; return 2 }
  zf_mkdir -m 700 -- "$cd" 2>/dev/null || { fail_item "$a" claim "cannot create $cd"; return 2 }
  write_file "$cd/origin" "$a" && write_file "$cd/claimed_epoch" "$EPOCHSECONDS" || { fail_item "$a" claim "cannot write claim metadata in $cd"; return 2 }
  if ! o=$(perl_rename "$a" "$cd/$name" 2>&1); then
    if [[ $o == *"No such file"* ]]; then
      info "gone during claim (producer dropped it): $a"
      zf_rm -f -- "$cd/origin" "$cd/claimed_epoch" "$a.attempts"; rmdir -- "$cd" 2>/dev/null
      return 1
    fi
    fail_item "$a" claim "rename into $cd failed: $o"; return 2
  fi
  zstat -L -H after -- "$cd/$name" 2>/dev/null || { fail_item "$a" claim "claimed file vanished from $cd"; return 2 }
  if [[ ${after[inode]} != ${st[inode]} || ${after[nlink]} != 1 ]]; then
    # The path was replaced between the check and the rename: put the newcomer back (link never overwrites).
    if perl_link "$cd/$name" "$a" >/dev/null 2>&1 && zf_rm -f -- "$cd/$name"; then
      zf_rm -f -- "$cd/origin" "$cd/claimed_epoch"; rmdir -- "$cd" 2>/dev/null
      info "not claimed: $a changed identity during the claim; put back"; return 1
    fi
    fail_item "$a" claim "identity changed during the claim and it could not be put back; it is in $cd"; return 2
  fi
  write_file "$cd/claimed_identity" "inode=${st[inode]} size=${st[size]} ctime=${st[ctime]}"
  info "claimed $a -> $cd/$name"
  C[claimed]=$(( C[claimed] + 1 ))
  return 0
}

# ---------- phase 0: claim quiet public archives ----------
say_step "phase 0: public archives under $ARCHIVE_ROOT"
local -a public; public=()
[[ $ROOT_STATE == present ]] && public=( $ARCHIVE_ROOT/<->-<->-<->/*.tar.gz(N.) )
C[seen]=${#public}
info "${#public} public final archive(s)"
for a in $public; do claim "$a"; done

# ---------- per-claim work ----------
# pending item i: P_KIND (archive|ledger), P_CD (claim dir or ledger path), P_DST, P_MD5, P_SIZE, P_SHA,
# P_STATE (pending|proven|failed|timeout), P_MSG, P_ID, P_REV
local -a P_KIND P_CD P_DST P_MD5 P_SIZE P_SHA P_STATE P_MSG P_ID P_REV
add_pending() { P_KIND+=( "$1" ); P_CD+=( "$2" ); P_DST+=( "$3" ); P_MD5+=( "$4" ); P_SIZE+=( "$5" ); P_SHA+=( "$6" ); P_STATE+=( pending ); P_MSG+=( "" ); P_ID+=( "" ); P_REV+=( "" ) }

confirm_and_delete() { # <claim dir>: the deleting step, only on a later run than the first proof
  local cd=$1 origin=$(<$1/origin) name=${$(<$1/origin):t} r=$1/receipt
  local dst md5 size sha iid rev msg rc got
  dst=$(kv $r drive_path) && md5=$(kv $r md5) && size=$(kv $r bytes) && sha=$(kv $r sha256) \
    && iid=$(kv $r drive_item_id) && rev=$(kv $r drive_revision) \
    || { claim_failed "$cd" confirm "receipt $r is incomplete"; return }
  rc=0; msg=$(prove_once "$dst" "$md5" "$size" "$iid" "$rev") || rc=$?
  (( rc == 0 )) || { claim_failed "$cd" confirm "re-proof against the receipt failed (rc $rc): $msg; nothing deleted"; return }
  info "re-proven: $msg"
  got=$(server_sha "$dst" "Drive copy") || { claim_failed "$cd" confirm "$got; nothing deleted"; return }
  [[ $got == $sha ]] || { claim_failed "$cd" confirm "Drive copy reads back from the server as sha256 $got, the receipt says $sha; nothing deleted"; return }
  info "Drive copy read back from Google's servers (proven server read): sha256 matches the receipt"
  got=$(sha256_of "$cd/$name") || { claim_failed "$cd" confirm "claimed archive unreadable: $got; nothing deleted"; return }
  [[ $got == $sha ]] || { claim_failed "$cd" confirm "claimed archive sha256 $got != receipt $sha; nothing deleted"; return }
  rc=0; msg=$(prove_once "$dst" "$md5" "$size" "$iid" "$rev") || rc=$?
  (( rc == 0 )) || { claim_failed "$cd" confirm "final re-proof failed (rc $rc): $msg; nothing deleted"; return }
  if [[ -e $origin || -L $origin ]]; then
    claim_failed "$cd" confirm "$origin exists again (a different file); not writing a marker beside it; nothing deleted"; return
  fi
  write_file "$origin.offsite" "drive_path=$dst"$'\n'"drive_item_id=$iid"$'\n'"drive_revision=$rev"$'\n'"sha256=$sha"$'\n'"md5=$md5"$'\n'"bytes=$size"$'\n'"first_proven_at=$(kv $r proven_at)"$'\n'"reproven_at=$(ts)"$'\n'"server_read_back=sha256 match (server-read.zsh)"$'\n'"receipt=$RECEIPTS/${cd:h:t}/$name/receipt" \
    || { claim_failed "$cd" marker "cannot write $origin.offsite; nothing deleted"; return }
  local o; o=$(bounded $T_SHORT "delete $cd/$name" /bin/rm -f -- "$cd/$name" 2>&1) || { claim_failed "$cd" delete "$o"; return }
  info "DELETED claimed archive $cd/$name (from $origin; sha256 $sha; offsite $dst item $iid revision $rev)"
  C[deleted]=$(( C[deleted] + 1 ))
  zf_rm -f -- "$origin.attempts" "$origin.stuck" 2>/dev/null || fail_item "$origin.attempts" cleanup "could not remove"
  zf_mkdir -p -m 700 -- "$RECEIPTS/${cd:h:t}" 2>/dev/null
  perl_rename "$cd" "$RECEIPTS/${cd:h:t}/$name" >/dev/null 2>&1 || fail_item "$cd" cleanup "could not move the receipt to $RECEIPTS (the archive is already deleted)"
}

upload_claim() { # <claim dir>: hash, copy unchanged to a new unique Drive path, queue for proof
  local cd=$1 origin=$(<$1/origin) name=${$(<$1/origin):t} day=${1:h:t} sha md5 size o dst
  sha=$(sha256_of "$cd/$name") && md5=$(md5_of "$cd/$name") && size=$(size_of "$cd/$name") \
    || { claim_failed "$cd" hash "cannot read the claimed archive: $sha$md5$size"; return }
  info "sha256 $sha md5 $md5 bytes $size"
  dst="$MYDRIVE/as2-backup/scratch-archive/$day/${name%.tar.gz}.${sha[1,16]}.$RUNSTAMP.tar.gz"
  if bounded $T_SHORT "stat $dst" /bin/test -e "$dst"; then claim_failed "$cd" copy "$dst already exists; never overwriting"; return; fi
  o=$(bounded $T_SHORT "mkdir ${dst:h}" /bin/mkdir -p -- "${dst:h}" 2>&1) || { claim_failed "$cd" copy "mkdir ${dst:h}: $o"; return }
  o=$(bounded $T_LONG "copy to Drive $name" /bin/cp -n -- "$cd/$name" "$dst" 2>&1) || { claim_failed "$cd" copy "cp to $dst: $o"; return }
  write_file "$cd/upload" "drive_path=$dst"$'\n'"sha256=$sha"$'\n'"md5=$md5"$'\n'"bytes=$size"$'\n'"uploaded_at=$(ts)" \
    || fail_item "$cd" state "cannot write $cd/upload (the copy is on Drive; tomorrow uploads again under a new name)"
  info "copied to $dst"
  C[uploaded]=$(( C[uploaded] + 1 ))
  add_pending archive "$cd" "$dst" "$md5" "$size" "$sha"
}

# envelope_failed <envelope dir> <step> <error>: one failure naming the envelope and every member (all kept); the
# night is counted on the envelope, which goes stuck (with <original>.stuck for each member) at the limit.
envelope_failed() {
  local ed=$1 n o; local -a origs
  envelope_members "$ed" && origs=( "${M_ORIG[@]}" )
  fail_item "$ed" "$2" "$3 (envelope of ${#origs} small archive(s), all kept: ${(j:, :)origs})"
  [[ $MODE == dry ]] && return 0
  n=$(( $(attempts_of "$ed") + 1 ))
  write_file "$ed/attempts" "$n"$'\n'"$(ts) $2: $3" || fail_item "$ed" state "cannot write $ed/attempts"
  for o in $origs; do write_file "$o.attempts" "$n failed night(s); in as2 drive-backup envelope $ed" || fail_item "$o.attempts" state "cannot update"; done
  if (( n >= STUCK_AFTER )); then
    write_file "$ed/stuck" "$(ts) stuck after $n failed nights; last: $2: $3. Delete this file to let the next night retry." \
      || fail_item "$ed" state "cannot write $ed/stuck"
    for o in $origs; do write_file "$o.stuck" "stuck in as2 drive-backup: see $ed/stuck" || fail_item "$o.stuck" state "cannot write"; done
    NEW_STUCK+=( "envelope $ed (${(j:, :)origs})" )
    info "STUCK: envelope $ed ($n failed nights). The next nights skip it until $ed/stuck is deleted."
  else
    info "failed nights for envelope $ed: $n of $STUCK_AFTER"
  fi
}

# envelope_upload <envelope dir>: re-hash every member against the members file, build the tar (MANIFEST.tsv, PAD,
# members as <date>/<name>) at least ENV_THRESH bytes, check each member reads back from it, then record the upload
# BEFORE the copy (a run that stops mid-copy re-proves that same path the next night instead of uploading again).
envelope_upload() {
  local ed=$1 id=${1:t:r} day=${1:h:t} st=$WORK/${1:t:r} env i o total=0 pad sha md5 size dst
  envelope_members "$ed" || { envelope_failed "$ed" envelope "$M_ERR"; return }
  local -a mc mm ms mb mo paths man
  mc=( "${M_CD[@]}" ) mm=( "${M_MEM[@]}" ) ms=( "${M_SHA[@]}" ) mb=( "${M_BYTES[@]}" ) mo=( "${M_ORIG[@]}" )
  for i in {1..${#mc}}; do
    o=$(sha256_of "${mc[$i]}/${mo[$i]:t}") || { envelope_failed "$ed" envelope "member ${mo[$i]} unreadable: $o"; return }
    [[ $o == ${ms[$i]} ]] || { envelope_failed "$ed" envelope "member ${mo[$i]} changed after it joined the envelope (sha256 $o, recorded ${ms[$i]})"; return }
    total=$(( total + mb[$i] ))
    paths+=( "${mc[$i]#$CLAIMS/}/${mo[$i]:t}" )
    man+=( "${mm[$i]}"$'\t'"${ms[$i]}"$'\t'"${mb[$i]}"$'\t'"${mo[$i]}" )
  done
  envelope_threshold || { envelope_failed "$ed" envelope "$ENV_ERR"; return }
  zf_mkdir -m 700 -- "$st" 2>/dev/null || { envelope_failed "$ed" envelope "cannot create $st"; return }
  write_file "$st/MANIFEST.tsv" "member"$'\t'"sha256"$'\t'"bytes"$'\t'"original path"$'\n'"${(F)man}" || { envelope_failed "$ed" envelope "cannot write the manifest"; return }
  pad=$(( ENV_THRESH - total )); (( pad < 0 )) && pad=0
  o=$(bounded $T_LONG "envelope padding" /bin/zsh -fc '/usr/bin/head -c "$1" /dev/urandom > "$2"' zsh $pad "$st/PAD" 2>&1) \
    || { envelope_failed "$ed" envelope "cannot write $pad bytes of padding: $o"; return }
  env=$st/envelope.tar
  o=$(bounded $T_LONG "envelope tar" /usr/bin/tar -cf "$env" -s ',^\([^/]*\)/\([^/]*\)\.d/[^/]*$,\1/\2,' -C "$st" MANIFEST.tsv PAD -C "$CLAIMS" $paths 2>&1) \
    || { envelope_failed "$ed" envelope "tar failed: $o"; return }
  size=$(size_of "$env") || { envelope_failed "$ed" envelope "$size"; return }
  (( size >= ENV_THRESH )) || { envelope_failed "$ed" envelope "built envelope is $size bytes, under the threshold $ENV_THRESH; not uploading"; return }
  for i in {1..${#mc}}; do
    o=$(bounded $T_LONG "envelope self-check" /bin/zsh -fc '/usr/bin/tar -xOf "$1" "$2" | /usr/bin/shasum -a 256' zsh "$env" "${mm[$i]}" 2>&1)
    [[ ${o%% *} == ${ms[$i]} ]] || { envelope_failed "$ed" envelope "self-check: ${mm[$i]} reads back from the built envelope as '${o%% *}', recorded ${ms[$i]}; not uploading"; return }
  done
  sha=$(sha256_of "$env") && md5=$(md5_of "$env") || { envelope_failed "$ed" envelope "cannot hash the built envelope: $sha$md5"; return }
  dst="$MYDRIVE/as2-backup/scratch-archive/$day/$id.${sha[1,16]}.$RUNSTAMP.tar"
  if bounded $T_SHORT "stat $dst" /bin/test -e "$dst"; then envelope_failed "$ed" copy "$dst already exists; never overwriting"; return; fi
  o=$(bounded $T_SHORT "mkdir ${dst:h}" /bin/mkdir -p -- "${dst:h}" 2>&1) || { envelope_failed "$ed" copy "mkdir ${dst:h}: $o"; return }
  write_file "$ed/upload" "drive_path=$dst"$'\n'"sha256=$sha"$'\n'"md5=$md5"$'\n'"bytes=$size"$'\n'"uploaded_at=$(ts)" \
    || { envelope_failed "$ed" state "cannot write $ed/upload before the copy; not copying"; return }
  if ! o=$(bounded $T_LONG "copy envelope to Drive" /bin/cp -n -- "$env" "$dst" 2>&1); then
    bounded $T_SHORT "stat $dst" /bin/test -e "$dst" || zf_rm -f -- "$ed/upload"
    envelope_failed "$ed" copy "cp to $dst: $o"; return
  fi
  info "copied envelope to $dst: $size bytes = ${#mc} member(s) of $total bytes, $pad bytes of padding, tar headers (threshold $ENV_THRESH)"
  C[uploaded]=$(( C[uploaded] + 1 ))
  add_pending envelope "$ed" "$dst" "$md5" "$size" "$sha"
  zf_rm -f -- "$env" "$st/PAD" "$st/MANIFEST.tsv"; rmdir -- "$st" 2>/dev/null
}

# new_envelope <claim dir>...: tonight's envelope for these small archives. The members file is written in a hidden
# .tmp dir, each member's claim dir gets an `envelope` file, and only then is the dir renamed into place; a run that
# stops before the rename leaves pointers to a dir that does not exist, and the next night envelopes them again.
new_envelope() {
  local base=$CLAIMS/envelopes/$TODAY id=env-$RUNSTAMP ed tmp cd c origin sha bytes
  local -a ok lines pointed
  ed=$base/$id.e tmp=$base/.$id.tmp
  for cd in "$@"; do
    origin=$(<$cd/origin)
    sha=$(sha256_of "$cd/${origin:t}") && bytes=$(size_of "$cd/${origin:t}") \
      || { claim_failed "$cd" hash "cannot read the claimed archive: $sha$bytes"; continue }
    ok+=( "$cd" ); lines+=( "$cd"$'\t'"${cd:h:t}/${origin:t}"$'\t'"$sha"$'\t'"$bytes"$'\t'"$origin" )
  done
  (( ${#ok} )) || return 0
  say_step "new envelope $ed for ${#ok} small archive(s)"
  undo() { zf_rm -f -- "${^pointed[@]}/envelope" "$tmp/members" 2>/dev/null; rmdir -- "$tmp" 2>/dev/null
           for c in $ok; do claim_failed "$c" envelope "$1; no envelope tonight"; done }
  zf_mkdir -p -m 700 -- "$base" 2>/dev/null
  [[ -e $ed || -e $tmp ]] && { for c in $ok; do claim_failed "$c" envelope "$ed already exists; no envelope tonight"; done; return }
  zf_mkdir -m 700 -- "$tmp" 2>/dev/null || { undo "cannot create $tmp"; return }
  write_file "$tmp/members" "${(F)lines}" || { undo "cannot write $tmp/members"; return }
  for cd in $ok; do
    write_file "$cd/envelope" "envelope_dir=$ed" || { undo "cannot write $cd/envelope"; return }
    pointed+=( "$cd" )
  done
  perl_rename "$tmp" "$ed" >/dev/null 2>&1 || { undo "cannot rename $tmp to $ed"; return }
  C[enveloped]=$(( C[enveloped] + ${#ok} ))
  envelope_upload "$ed"
}

# confirm_envelope <envelope dir>: the deleting step for an envelope, on a later run than its first proof. Everything
# is checked before any member is deleted: re-proof, server read sha256 = receipt, every member still on disk with
# its recorded sha256 and its original path still free, final re-proof.
confirm_envelope() {
  local ed=$1 r=$1/receipt dst md5 size sha iid rev msg rc got i o
  dst=$(kv $r drive_path) && md5=$(kv $r md5) && size=$(kv $r bytes) && sha=$(kv $r sha256) \
    && iid=$(kv $r drive_item_id) && rev=$(kv $r drive_revision) \
    || { envelope_failed "$ed" confirm "receipt $r is incomplete"; return }
  envelope_members "$ed" || { envelope_failed "$ed" confirm "$M_ERR"; return }
  local -a mc mm ms mb mo done_
  mc=( "${M_CD[@]}" ) mm=( "${M_MEM[@]}" ) ms=( "${M_SHA[@]}" ) mb=( "${M_BYTES[@]}" ) mo=( "${M_ORIG[@]}" )
  rc=0; msg=$(prove_once "$dst" "$md5" "$size" "$iid" "$rev") || rc=$?
  (( rc == 0 )) || { envelope_failed "$ed" confirm "re-proof against the receipt failed (rc $rc): $msg; nothing deleted"; return }
  info "envelope re-proven: $msg"
  got=$(server_sha "$dst" "envelope") || { envelope_failed "$ed" confirm "$got; nothing deleted"; return }
  [[ $got == $sha ]] || { envelope_failed "$ed" confirm "envelope reads back from the server as sha256 $got, the receipt says $sha; nothing deleted"; return }
  info "envelope read back from Google's servers (proven server read): sha256 matches the receipt"
  for i in {1..${#mc}}; do
    done_[$i]=0
    if [[ ! -e ${mc[$i]}/${mo[$i]:t} ]]; then
      # a run that stopped part-way through the deletions below: this member is already offsite and deleted
      if [[ -f ${mo[$i]}.offsite && $(kv "${mo[$i]}.offsite" envelope_drive_path) == $dst ]]; then done_[$i]=1; continue; fi
      envelope_failed "$ed" confirm "member ${mo[$i]} is missing from ${mc[$i]}; nothing deleted"; return
    fi
    got=$(sha256_of "${mc[$i]}/${mo[$i]:t}") || { envelope_failed "$ed" confirm "member ${mo[$i]} unreadable: $got; nothing deleted"; return }
    [[ $got == ${ms[$i]} ]] || { envelope_failed "$ed" confirm "member ${mo[$i]} sha256 $got != recorded ${ms[$i]}; nothing deleted"; return }
    if [[ -e ${mo[$i]} || -L ${mo[$i]} ]]; then
      envelope_failed "$ed" confirm "${mo[$i]} exists again (a different file); not writing a marker beside it; nothing deleted"; return
    fi
  done
  rc=0; msg=$(prove_once "$dst" "$md5" "$size" "$iid" "$rev") || rc=$?
  (( rc == 0 )) || { envelope_failed "$ed" confirm "final re-proof failed (rc $rc): $msg; nothing deleted"; return }
  local all=1 name day
  for i in {1..${#mc}}; do
    (( done_[$i] )) && continue
    name=${mo[$i]:t} day=${mc[$i]:h:t}
    write_file "${mo[$i]}.offsite" "envelope_drive_path=$dst"$'\n'"envelope_item_id=$iid"$'\n'"envelope_revision=$rev"$'\n'"envelope_sha256=$sha"$'\n'"member=${mm[$i]}"$'\n'"sha256=${ms[$i]}"$'\n'"bytes=${mb[$i]}"$'\n'"first_proven_at=$(kv $r proven_at)"$'\n'"reproven_at=$(ts)"$'\n'"server_read_back=envelope sha256 match (server-read.zsh)"$'\n'"restore=tar -xf <envelope_drive_path> -C <dir> ${mm[$i]}"$'\n'"receipt=$RECEIPTS/$day/$name/receipt" \
      || { fail_item "${mo[$i]}" marker "cannot write ${mo[$i]}.offsite; this member is not deleted (envelope $ed)"; all=0; continue }
    o=$(bounded $T_SHORT "delete ${mc[$i]}/$name" /bin/rm -f -- "${mc[$i]}/$name" 2>&1) || { fail_item "${mo[$i]}" delete "$o (envelope $ed)"; all=0; continue }
    info "DELETED claimed archive ${mc[$i]}/$name (from ${mo[$i]}; sha256 ${ms[$i]}; offsite as ${mm[$i]} in envelope $dst item $iid revision $rev)"
    C[deleted]=$(( C[deleted] + 1 ))
    zf_rm -f -- "${mo[$i]}.attempts" "${mo[$i]}.stuck" 2>/dev/null || fail_item "${mo[$i]}.attempts" cleanup "could not remove"
    write_file "${mc[$i]}/receipt" "envelope_drive_path=$dst"$'\n'"envelope_item_id=$iid"$'\n'"envelope_revision=$rev"$'\n'"envelope_sha256=$sha"$'\n'"envelope_receipt=$RECEIPTS/envelopes/${ed:h:t}/${ed:t}/receipt"$'\n'"member=${mm[$i]}"$'\n'"sha256=${ms[$i]}"$'\n'"bytes=${mb[$i]}"$'\n'"deleted_at=$(ts)" \
      || fail_item "${mc[$i]}" cleanup "could not write the member receipt (the archive is already deleted)"
    zf_mkdir -p -m 700 -- "$RECEIPTS/$day" 2>/dev/null
    perl_rename "${mc[$i]}" "$RECEIPTS/$day/$name" >/dev/null 2>&1 || fail_item "${mc[$i]}" cleanup "could not move the member receipt to $RECEIPTS (the archive is already deleted)"
  done
  (( all )) || return
  zf_mkdir -p -m 700 -- "$RECEIPTS/envelopes/${ed:h:t}" 2>/dev/null
  perl_rename "$ed" "$RECEIPTS/envelopes/${ed:h:t}/${ed:t}" >/dev/null 2>&1 || fail_item "$ed" cleanup "could not move the envelope receipt to $RECEIPTS/envelopes (its members are already deleted)"
}

say_step "phase 1: claimed archives under $CLAIMS"
local -a claims SMALL; claims=( $CLAIMS/<->-<->-<->/*.d(N/) ) SMALL=()   # SMALL: claim dirs for tonight's envelope
info "${#claims} claimed archive(s)"
for cd in $claims; do
  if [[ ! -f $cd/origin ]]; then fail_item "$cd" claim "claim dir without an origin file; leaving it for a person"; continue; fi
  origin=$(<$cd/origin); name=${origin:t}
  if [[ -f $cd/stuck ]]; then SKIPPED_STUCK+=( "$origin" ); info "skip (stuck, needs a person): $origin: $(<$cd/stuck)"; continue; fi
  if (( $(attempts_of "$cd") >= STUCK_AFTER )); then
    info "stuck marker was cleared for $origin; resetting its failed-night count"
    [[ $MODE == dry ]] || { write_file "$cd/attempts" "0"; zf_rm -f -- "$origin.stuck" 2>/dev/null }
  fi
  if [[ ! -f $cd/$name ]]; then fail_item "$origin" claim "claim dir $cd has no archive file; leaving it for a person"; continue; fi
  say_step "claim $cd ($origin)"
  if [[ -f $cd/envelope ]]; then
    ped=$(kv $cd/envelope envelope_dir) || ped=""
    if [[ -n $ped && -d $ped ]]; then info "in envelope $ped (handled with it)"; continue; fi
    info "its envelope ${ped:-?} was never finished (a run stopped while building it); it goes into an envelope again"
    [[ $MODE == dry ]] || zf_rm -f -- "$cd/envelope"
  fi
  if [[ -f $cd/receipt ]]; then
    if (( KEEP_LOCAL == 1 )); then info "AS2_KEEP_LOCAL=1: proven and kept"; C[kept_local]=$(( C[kept_local] + 1 )); continue; fi
    pe=$(kv $cd/receipt proven_epoch) || pe=0
    if (( EPOCHSECONDS - pe < REPROVE_AFTER )); then
      info "proven $(( (EPOCHSECONDS - pe) / 60 )) min ago; the deleting re-proof waits until $(strftime '%Y-%m-%d %H:%M' $(( pe + REPROVE_AFTER )))"
      C[waiting_reproof]=$(( C[waiting_reproof] + 1 )); continue
    fi
    [[ $MODE == dry ]] && { info "DRY RUN: would re-prove the receipt, read the Drive copy back, recheck, mark $origin.offsite, delete"; continue }
    confirm_and_delete "$cd"; continue
  fi
  if [[ -f $cd/upload ]]; then
    u=$cd/upload
    if dst=$(kv $u drive_path) && m=$(kv $u md5) && s=$(kv $u bytes) && h=$(kv $u sha256); then
      [[ $MODE == dry ]] && { info "DRY RUN: would re-prove the earlier upload $dst"; continue }
      info "re-proving the earlier upload $dst (no new upload)"
      add_pending archive "$cd" "$dst" "$m" "$s" "$h"; continue
    fi
    info "upload record incomplete; uploading again"
  fi
  s=$(size_of "$cd/$name") || { claim_failed "$cd" hash "cannot stat the claimed archive: $s"; continue }
  if ! envelope_threshold; then claim_failed "$cd" envelope "cannot work out the envelope threshold: $ENV_ERR; kept"; continue; fi
  if (( s < ENV_THRESH )); then
    [[ $MODE == dry ]] && { info "DRY RUN: $s bytes, under the envelope threshold $ENV_THRESH: would go into tonight's envelope"; continue }
    info "$s bytes, under the envelope threshold $ENV_THRESH: goes into tonight's envelope"
    SMALL+=( "$cd" ); continue
  fi
  [[ $MODE == dry ]] && { info "DRY RUN: would hash, copy to a new Drive path, prove"; continue }
  upload_claim "$cd"
done

say_step "phase 1: envelopes of small archives under $CLAIMS/envelopes"
for t in $CLAIMS/envelopes/<->-<->-<->/.env-*.tmp(N/); do
  [[ $MODE == dry ]] && { info "DRY RUN: would remove the unfinished envelope build $t"; continue }
  zf_rm -f -- "$t/members" 2>/dev/null
  if rmdir -- "$t" 2>/dev/null; then info "removed an unfinished envelope build (a run stopped while building it): $t"
  else fail_item "$t" envelope "cannot remove an unfinished envelope build; leaving it for a person"; fi
done
local -a envs; envs=( $CLAIMS/envelopes/<->-<->-<->/*.e(N/) )
info "${#envs} envelope(s) not yet retired"
for ed in $envs; do
  say_step "envelope $ed"
  if [[ -f $ed/stuck ]]; then SKIPPED_STUCK+=( "$ed" ); info "skip (stuck, needs a person): $ed: $(<$ed/stuck)"; continue; fi
  if (( $(attempts_of "$ed") >= STUCK_AFTER )); then
    info "stuck marker was cleared for $ed; resetting its failed-night count"
    if [[ $MODE != dry ]]; then
      write_file "$ed/attempts" "0"
      envelope_members "$ed" && for o in $M_ORIG; do zf_rm -f -- "$o.stuck" 2>/dev/null; done
    fi
  fi
  if [[ -f $ed/receipt ]]; then
    if (( KEEP_LOCAL == 1 )); then info "AS2_KEEP_LOCAL=1: proven and kept"; C[kept_local]=$(( C[kept_local] + 1 )); continue; fi
    pe=$(kv $ed/receipt proven_epoch) || pe=0
    if (( EPOCHSECONDS - pe < REPROVE_AFTER )); then
      info "envelope proven $(( (EPOCHSECONDS - pe) / 60 )) min ago; the deleting re-proof waits until $(strftime '%Y-%m-%d %H:%M' $(( pe + REPROVE_AFTER )))"
      C[waiting_reproof]=$(( C[waiting_reproof] + 1 )); continue
    fi
    [[ $MODE == dry ]] && { info "DRY RUN: would re-prove the envelope, read it back, recheck every member, mark and delete them"; continue }
    confirm_envelope "$ed"; continue
  fi
  if [[ -f $ed/upload ]]; then
    u=$ed/upload
    if dst=$(kv $u drive_path) && m=$(kv $u md5) && s=$(kv $u bytes) && h=$(kv $u sha256); then
      if bounded $T_SHORT "stat $dst" /bin/test -e "$dst"; then
        [[ $MODE == dry ]] && { info "DRY RUN: would re-prove the earlier envelope upload $dst"; continue }
        info "re-proving the earlier envelope upload $dst (no new upload)"
        add_pending envelope "$ed" "$dst" "$m" "$s" "$h"; continue
      fi
      info "the recorded envelope copy $dst is not on Drive (a run stopped before the copy); building the envelope again"
    else
      info "envelope upload record incomplete; building the envelope again"
    fi
    [[ $MODE == dry ]] || zf_rm -f -- "$u" "$ed/upload_retried"
  fi
  [[ $MODE == dry ]] && { info "DRY RUN: would build this envelope and upload it"; continue }
  envelope_upload "$ed"
done
(( ${#SMALL} )) && new_envelope $SMALL

say_step "phase 1: ledger snapshot from $LEDGER_DB"
ledger_fail() { fail_item "$LEDGER_DB" "ledger-$1" "$2"; LEDGER_RESULT=failed }
if [[ $MODE == dry ]]; then
  info "DRY RUN: would .backup, quick_check, gzip, copy to as2-backup/ledger/$TODAY/, then prove"
elif [[ ! -f $LEDGER_DB ]]; then
  ledger_fail missing "ledger file not found"
else
  snap=$WORK/ledger-$RUNSTAMP.db
  if ! out=$(bounded $T_LONG "ledger .backup" $SQLITE -readonly -cmd '.timeout 10000' "$LEDGER_DB" ".backup '$snap'" 2>&1); then ledger_fail backup "$out"
  elif ! chk=$(bounded $T_LONG "ledger quick_check" $SQLITE "$snap" "pragma quick_check;" 2>&1) || [[ $chk != ok ]]; then ledger_fail check "snapshot quick_check: $chk"
  elif ! out=$(bounded $T_LONG "ledger gzip" /usr/bin/gzip -9 -n -- "$snap" 2>&1); then ledger_fail gzip "$out"
  elif ! gz_sha=$(sha256_of "$snap.gz"); then ledger_fail hash "$gz_sha"
  elif ! { gz_md5=$(md5_of "$snap.gz") && gz_size=$(size_of "$snap.gz") }; then ledger_fail hash "cannot hash the snapshot"
  else
    ldst="$MYDRIVE/as2-backup/ledger/$TODAY/ledger-$RUNSTAMP-${gz_sha[1,16]}.db.gz"
    info "gz sha256 $gz_sha md5 $gz_md5 bytes $gz_size"
    if bounded $T_SHORT "stat $ldst" /bin/test -e "$ldst"; then ledger_fail copy "$ldst already exists; never overwriting"
    elif ! out=$(bounded $T_SHORT "mkdir ledger dir" /bin/mkdir -p -- "${ldst:h}" 2>&1); then ledger_fail copy "$out"
    elif ! out=$(bounded $T_LONG "copy ledger to Drive" /bin/cp -n -- "$snap.gz" "$ldst" 2>&1); then ledger_fail copy "$out"
    else
      info "copied to $ldst"; LEDGER_RESULT=uploaded
      add_pending ledger "$LEDGER_DB" "$ldst" "$gz_md5" "$gz_size" "$gz_sha"
    fi
  fi
  zf_rm -f -- "$snap" "$snap.gz" 2>/dev/null
fi

# ---------- phase 2: prove every new copy (one shared deadline, no re-uploads) ----------
if [[ $MODE == run ]] && (( ${#P_KIND} )); then
  say_step "phase 2: proving ${#P_KIND} Drive copies (deadline ${PROOF_TIMEOUT}s)"
  # Deadlines read clock_now (lib.zsh). AS2_PROOF_POLL_HOOK (test seam) runs before each proof pass; a failing hook
  # is a failure of the run, never ignored.
  if clock_now; then deadline=$(( CLOCK_NOW_S + PROOF_TIMEOUT )); else deadline=0; fi
  while true; do
    if [[ -n ${AS2_PROOF_POLL_HOOK:-} ]]; then
      hook_out=$(bounded $T_SHORT "proof poll hook" /bin/zsh -fc "$AS2_PROOF_POLL_HOOK" 2>&1) \
        || fail_item "$AS2_PROOF_POLL_HOOK" proof-hook "AS2_PROOF_POLL_HOOK failed: ${hook_out//$'\n'/; }"
    fi
    left=0
    for i in {1..${#P_KIND}}; do
      [[ ${P_STATE[$i]} == pending ]] || continue
      rc=0; msg=$(prove_once "${P_DST[$i]}" "${P_MD5[$i]}" "${P_SIZE[$i]}") || rc=$?
      P_MSG[$i]=$msg
      case $rc in
        0) P_STATE[$i]=proven; local -a w; w=( ${=msg} ); P_ID[$i]=${w[2]}; P_REV[$i]=${w[3]}; info "${P_DST[$i]}: $msg" ;;
        2) P_STATE[$i]=failed; info "${P_DST[$i]}: proof error: $msg" ;;
        *) left=$(( left + 1 )) ;;
      esac
    done
    (( left == 0 )) && break
    if ! clock_now || (( CLOCK_NOW_S >= deadline )); then
      for i in {1..${#P_KIND}}; do [[ ${P_STATE[$i]} == pending ]] && P_STATE[$i]=timeout; done
      break
    fi
    progress "proof wait ($left left)" $deadline
    zselect -t $(( PROOF_POLL * 100 ))
  done
fi

# ---------- phase 3: receipts for proven copies (deletion is a later run's re-proof) ----------
if [[ $MODE == run ]] && (( ${#P_KIND} )); then
  say_step "phase 3: receipts"
  for i in {1..${#P_KIND}}; do
    kind=${P_KIND[$i]} cd=${P_CD[$i]} dst=${P_DST[$i]} st=${P_STATE[$i]}
    if [[ $kind == ledger ]]; then
      if [[ $st == proven ]]; then
        LEDGER_RESULT=proven
        { print -r -- "$(ts)	$dst	${P_SHA[$i]}	${P_ID[$i]}	${P_REV[$i]}" >> "$LEDGER_RECEIPTS" } 2>/dev/null \
          || ledger_fail receipt "cannot append $LEDGER_RECEIPTS"
        info "ledger offsite and proven: $dst"
      else
        ledger_fail prove "not proven ($st): ${P_MSG[$i]}"
      fi
      continue
    fi
    if [[ $st != proven ]]; then
      # A proof error: the next night uploads afresh under a new name. A first timeout: the next night re-proves
      # the same copy (a large upload can outlast the window); a second one: a fresh upload.
      if [[ $st == failed || -f $cd/upload_retried ]]; then zf_rm -f -- "$cd/upload" "$cd/upload_retried" 2>/dev/null
      elif [[ $st == timeout ]]; then write_file "$cd/upload_retried" "$(ts)" || true
      fi
      if [[ $kind == envelope ]]; then envelope_failed "$cd" prove "not proven ($st): ${P_MSG[$i]}; nothing deleted"
      else claim_failed "$cd" prove "not proven ($st): ${P_MSG[$i]}; nothing deleted"; fi
      continue
    fi
    if write_file "$cd/receipt" "drive_path=$dst"$'\n'"drive_item_id=${P_ID[$i]}"$'\n'"drive_revision=${P_REV[$i]}"$'\n'"sha256=${P_SHA[$i]}"$'\n'"md5=${P_MD5[$i]}"$'\n'"bytes=${P_SIZE[$i]}"$'\n'"proven_at=$(ts)"$'\n'"proven_epoch=$EPOCHSECONDS"$'\n'"proof=drivefs-metadata v1 (pinned layout; item id, head revision, md5, size)"; then
      zf_rm -f -- "$cd/upload" "$cd/upload_retried" 2>/dev/null
      C[proven]=$(( C[proven] + 1 ))
      zf_rm -f -- "$cd/attempts" 2>/dev/null
      if [[ $kind == envelope ]]; then
        envelope_members "$cd" && for o in $M_ORIG; do
          write_file "$o.attempts" "0 failed nights; proven inside envelope $cd, deletion after re-proof" || fail_item "$o.attempts" state "cannot update"
        done
      else
        write_file "$(<$cd/origin).attempts" "0 failed nights; proven, deletion after re-proof; claimed into $cd" || fail_item "$(<$cd/origin).attempts" state "cannot update"
      fi
      info "receipt written: $cd/receipt (deleted by a run at least $(( REPROVE_AFTER / 3600 )) h from now, after re-proof)"
    elif [[ $kind == envelope ]]; then
      envelope_failed "$cd" receipt "cannot write $cd/receipt"
    else
      claim_failed "$cd" receipt "cannot write $cd/receipt"
    fi
  done
fi

# ---------- summary ----------
if [[ $MODE == dry ]]; then
  say_step "dry run done: ${C[seen]} public archive(s), ${#claims} claimed, ${#envs} envelope(s), ${#SKIPPED_STUCK} stuck; nothing changed"
  finish 0
fi
say_step "summary: public ${C[seen]}, claimed ${C[claimed]}, put in a new envelope ${C[enveloped]}, uploaded ${C[uploaded]}, proven ${C[proven]}, waiting re-proof ${C[waiting_reproof]}, offsite+deleted ${C[deleted]}, failed ${#F_PATH}, newly stuck ${#NEW_STUCK}, skipped stuck ${#SKIPPED_STUCK}, ledger $LEDGER_RESULT"
if (( ${#F_PATH} )); then
  for i in {1..${#F_PATH}}; do info "failure $i: [${F_STEP[$i]}] ${F_PATH[$i]}: ${F_ERR[$i]}"; done
fi
(( ${#F_PATH} == 0 )) && finish 0 || finish 1
