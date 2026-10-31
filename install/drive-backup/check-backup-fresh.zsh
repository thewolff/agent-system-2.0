#!/bin/zsh
# Outside watcher for the nightly Drive backup. launchd runs it at 9 AM (com.plumb.as2-drive-backup-check).
#   zsh check-backup-fresh.zsh
# Raises ONE alert listing every problem found if:
#   - last-run.json is missing, unreadable, older than 26 h, its result is not "success", or its own alert has no
#     sign of being shown (alert_ack_problem, lib.zsh); a run still in progress (progress.json, pid alive, inside
#     its step deadline) is reported, not alarmed, unless it started more than 12 h ago or is past a step deadline
#   - the archive root is missing after it once existed, or has never existed 7 days after the first run
#   - any public archive is older than 3 days (an .offsite marker does not hide it: a claimed archive leaves the
#     public dir, so one still there was never claimed)
#   - any claimed archive is older than 3 days and not yet deleted (stuck ones say so)
#   - on Sundays: backup-nightly.zsh --verify-restore fails (evict, read the newest archive + ledger back from
#     Google's servers, compare sha256)
#   - its own state file cannot be written
# Writes last-check.json every run (before and after the weekly test); the nightly job reports it if it goes stale,
# is malformed, or records an alert with no sign of being shown (the watcher is watched).
# Overrides (tests only): AS2_LOG (state dir = its directory), AS2_ARCHIVE_ROOT, AS2_CLAIMS, AS2_ALERT_CMD,
#   AS2_ALERT_FALLBACK, AS2_ALERT_ACK, AS2_ALERT_ACK_WINDOW, AS2_NOW_EPOCH, AS2_FORCE_VERIFY=1, AS2_VERIFY_TIMEOUT, AS2_UNDER_LAUNCHD=1;
#   the rest pass through to --verify-restore.

emulate -L zsh
setopt no_unset pipe_fail extended_glob
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin

HERE=${0:A:h}
STATE=${AS2_LOG:+${AS2_LOG:h}}; STATE=${STATE:-$HERE}
CLOG=$STATE/check-backup-fresh.log
HEARTBEAT=$STATE/last-run.json
PROGRESS_FILE=$STATE/progress.json
CHECK_BEAT=$STATE/last-check.json
FIRST_RUN=$STATE/first-run-epoch
ROOT_SEEN=$STATE/archive-root-seen
ARCHIVE_ROOT=${AS2_ARCHIVE_ROOT:-/Users/jowolff/agent-scratch/agent-system-2.0/scratch-archive}
CLAIMS=${AS2_CLAIMS:-$HERE/claims}
ALERT_CMD=${AS2_ALERT_CMD:-$HERE/quiet-alarm.zsh}
ALERT_FALLBACK=${AS2_ALERT_FALLBACK:-/usr/bin/osascript}
VERIFY_TIMEOUT=${AS2_VERIFY_TIMEOUT:-7200}
MAX_AGE=$(( 26*3600 ))
ARCHIVE_MAX_AGE=$(( 3*86400 ))
ROOT_GRACE=$(( 7*86400 ))
RUN_MAX=$(( 12*3600 ))
JQ=/usr/bin/jq
PROGRESS=""          # bounded() progress receipts belong to the nightly job only
MODE_LABEL=check

source "$HERE/lib.zsh" || { print -u2 "cannot source $HERE/lib.zsh"; exit 1 }
ALERT_ACK=${AS2_ALERT_ACK:-3}
ALERT_ACK_WINDOW=${AS2_ALERT_ACK_WINDOW:-21600}
NOW=${AS2_NOW_EPOCH:-$EPOCHSECONDS}

[[ ${AS2_UNDER_LAUNCHD:-0} == 1 ]] || exec > >(tee -a "$CLOG") 2>&1
local -a PROBLEMS NOTES
problem() { PROBLEMS+=( "$*" ); info "PROBLEM: $*" }
note() { NOTES+=( "$*" ); info "note: $*" }
write_beat() { # <result>
  local body
  body=$($JQ -n --arg at "$(ts)" --argjson at_epoch $EPOCHSECONDS --arg result "$1" --arg alert "$ALERT_STATUS" \
    --arg alert_result "$ALERT_RESULT" --argjson alert_epoch $ALERT_EPOCH \
    --argjson problems "$( (( ${#PROBLEMS} )) && print -rl -- $PROBLEMS | $JQ -R . | $JQ -sc . || print '[]')" \
    --argjson notes "$( (( ${#NOTES} )) && print -rl -- $NOTES | $JQ -R . | $JQ -sc . || print '[]')" \
    '{at:$at, at_epoch:$at_epoch, result:$result, alert:$alert, alert_result:$alert_result, alert_epoch:$alert_epoch,
      problems:$problems, notes:$notes}' 2>&1) || return 1
  write_file "$CHECK_BEAT" "$body"
}

print -r -- "$(ts) == check-backup-fresh start"

# 0. is a nightly run in progress right now?
RUNNING=0
if [[ -f $PROGRESS_FILE ]]; then
  ppid_=$($JQ -r '.pid // empty' "$PROGRESS_FILE" 2>/dev/null); pfin=$($JQ -r '.finished // false' "$PROGRESS_FILE" 2>/dev/null)
  pstart=$($JQ -r '.start_epoch // empty' "$PROGRESS_FILE" 2>/dev/null); pdl=$($JQ -r '.step_deadline_epoch // empty' "$PROGRESS_FILE" 2>/dev/null)
  pstep=$($JQ -r '.step // empty' "$PROGRESS_FILE" 2>/dev/null)
  if [[ $ppid_ != <-> || $pstart != <-> || $pdl != <-> ]]; then
    problem "$PROGRESS_FILE is unreadable or malformed"
  elif [[ $pfin != true ]] && kill -0 $ppid_ 2>/dev/null && pgrep -f backup-nightly.zsh | grep -qx $ppid_; then
    RUNNING=1
    if (( pdl > 0 && NOW > pdl + 600 )); then
      problem "nightly run pid $ppid_ is hung: step '$pstep' passed its deadline $(( (NOW - pdl) / 60 )) min ago"
    elif (( NOW - pstart > RUN_MAX )); then
      problem "nightly run pid $ppid_ has been running $(( (NOW - pstart) / 3600 )) h (limit 12 h), now in step '$pstep'"
    else
      note "nightly run pid $ppid_ in progress since $(( (NOW - pstart) / 60 )) min, step '$pstep' (a run on wake after sleep looks like this)"
    fi
  fi
fi

# 1. nightly heartbeat
if [[ ! -f $HEARTBEAT ]]; then
  (( RUNNING )) || problem "no $HEARTBEAT: the nightly backup has never finished a run here (is com.plumb.as2-drive-backup loaded?)"
else
  end=$($JQ -r '.end_epoch // empty' "$HEARTBEAT" 2>/dev/null); res=$($JQ -r '.result // empty' "$HEARTBEAT" 2>/dev/null)
  if [[ $end != <-> || -z $res ]]; then
    problem "$HEARTBEAT is unreadable or incomplete"
  else
    age=$(( NOW - end ))
    info "last nightly run: result $res, ended $(( age / 3600 )) h ago"
    if (( age > MAX_AGE )); then
      if (( RUNNING )); then note "last finished run ended $(( age / 3600 )) h ago; a run is in progress"
      else problem "last nightly run ended $(( age / 3600 )) h ago (limit 26 h): the Mac was powered off at 2:30 AM (a sleeping Mac runs the job on wake), or launchd did not start it"
      fi
    fi
    if [[ $res != success ]]; then
      n=$($JQ -r '.counts.failed // 0' "$HEARTBEAT"); first=$($JQ -r '.failures[0] | "\(.step): \(.path): \(.error)"' "$HEARTBEAT" 2>/dev/null)
      pin=$($JQ -r '[.failures[]? | select(.error | test("schema pin changed")) | "\(.step): \(.error)"] | first // empty' "$HEARTBEAT" 2>/dev/null)
      [[ -n $pin ]] && problem "schema pin changed: Drive for desktop's format no longer matches what the backup was verified against, so nothing is proven or deleted until a person re-verifies it and updates the pin. $pin"
      problem "last nightly run result is '$res' with $n failure(s); first: $first"
    fi
    al=$(alert_ack_problem "$HEARTBEAT" $NOW $ALERT_ACK_WINDOW)
    [[ -n $al ]] && problem "the nightly run's own alert: $al"
    if [[ $($JQ -r '.archive_root // empty' "$HEARTBEAT" 2>/dev/null) == absent-never-seen ]]; then
      fr=$(<$FIRST_RUN 2>/dev/null) || fr=$NOW
      (( NOW - fr > ROOT_GRACE )) && problem "archive root $ARCHIVE_ROOT has never existed, $(( (NOW - fr) / 86400 )) days after the first backup run (no archive made yet, or the path is wrong)"
    fi
  fi
fi

# 2. public archives waiting too long (a marker does not hide one)
if [[ -d $ARCHIVE_ROOT ]]; then
  local -a old
  for a in $ARCHIVE_ROOT/<->-<->-<->/*.tar.gz(N.); do
    zstat -A mt +mtime -- "$a" 2>/dev/null || continue
    if (( NOW - mt[1] > ARCHIVE_MAX_AGE )); then
      local why=""
      [[ -e $a.offsite ]] && why=" (has an .offsite marker but was never claimed)"
      [[ -e $a.stuck ]] && why+=" (stuck)"
      old+=( "$a$why" )
    fi
  done
  (( ${#old} )) && problem "${#old} public archive(s) older than 3 days, not claimed by the backup: ${(j:, :)old}"
elif [[ -f $ROOT_SEEN ]]; then
  problem "archive root $ARCHIVE_ROOT is missing, but it existed before"
fi

# 3. claimed archives not yet deleted
keep_local=$($JQ -r '.keep_local // false' "$HEARTBEAT" 2>/dev/null)
local -a held
for cd in $CLAIMS/<->-<->-<->/*.d(N/); do
  origin=$(<$cd/origin 2>/dev/null) || origin=$cd
  [[ -f $cd/${origin:t} ]] || continue
  ce=$(<$cd/claimed_epoch 2>/dev/null) || ce=0
  [[ $ce == <-> ]] || ce=0
  (( NOW - ce > ARCHIVE_MAX_AGE )) || continue
  [[ $keep_local == true && -f $cd/receipt ]] && continue
  ed=""; [[ -f $cd/envelope ]] && { ed=$(<$cd/envelope); ed=${ed#envelope_dir=} }
  if [[ -n $ed && -d $ed ]]; then
    [[ $keep_local == true && -f $ed/receipt ]] && continue
    if [[ -f $ed/stuck ]]; then held+=( "$origin (in envelope $ed, STUCK: fix the cause, then delete $ed/stuck)" )
    elif [[ -f $ed/receipt ]]; then held+=( "$origin (in envelope $ed: proven, deletion re-proof keeps failing or has not run)" )
    else held+=( "$origin (in envelope $ed: not proven yet)" )
    fi
  elif [[ -f $cd/stuck ]]; then held+=( "$origin (STUCK: fix the cause, then delete $cd/stuck)" )
  elif [[ -f $cd/receipt ]]; then held+=( "$origin (proven, deletion re-proof keeps failing or has not run)" )
  else held+=( "$origin (not proven yet)" )
  fi
done
(( ${#held} )) && problem "${#held} claimed archive(s) older than 3 days still on disk: ${(j:, :)held}"

# 4. weekly restore test (Sunday); record a heartbeat first so a long test cannot hide this check
if [[ $(strftime '%u' $NOW) == 7 || ${AS2_FORCE_VERIFY:-0} == 1 ]]; then
  write_beat verifying || problem "could not write $CHECK_BEAT"
  info "Sunday: running backup-nightly.zsh --verify-restore (deadline ${VERIFY_TIMEOUT}s)"
  out=$(bounded $VERIFY_TIMEOUT "weekly verify-restore" /usr/bin/env AS2_NO_ALERT=1 /bin/zsh "$HERE/backup-nightly.zsh" --verify-restore 2>&1); vrc=$?
  print -r -- "$out" | sed 's/^/    verify| /'
  if (( vrc != 0 )); then
    local -a fls; fls=( "${(@M)${(@f)out}:#*FAILED*}" ); fl=${fls[1]:-}
    problem "weekly restore test failed (exit $vrc): ${${fl#*FAILED }:-$(print -r -- "$out" | tail -1)}"
  fi
fi

# 5. heartbeat for whoever watches this watcher (the nightly job)
result=$( (( ${#PROBLEMS} )) && print problems || print ok )
write_beat $result || { problem "could not write $CHECK_BEAT (the nightly job will report this watcher as stale)"; result=problems }

if (( ${#PROBLEMS} )); then
  popup="${#PROBLEMS} problem(s): ${(j: | :)PROBLEMS}. Log: $CLOG"
  alert "as2 Drive backup check" "$popup" "The Drive backup check found ${#PROBLEMS} problems. Details are in the log."
  write_beat $result || info "could not record alert delivery in $CHECK_BEAT"
  print -r -- "$(ts) == check finished: ${#PROBLEMS} problem(s), alert $ALERT_STATUS, exit 1"
  exit 1
fi
print -r -- "$(ts) == check finished: ok${NOTES:+ (${#NOTES} note(s))}"
exit 0
