# Shared helpers for backup-nightly.zsh and check-backup-fresh.zsh. Sourced, never run.
# Callers set: STATE (state dir), PROGRESS (progress file or ""), ALERT_CMD, ALERT_FALLBACK, MODE_LABEL (check for the 9 AM
# check; run or verify for the nightly job). The needs-you writer reads AS2_BUN, AS2_REPO and AS2_LEDGER_DB (the plists set them).
zmodload zsh/datetime zsh/stat zsh/system zsh/zselect
zmodload -F zsh/files b:zf_mv b:zf_rm b:zf_mkdir

ts() { strftime '%Y-%m-%dT%H:%M:%S%z' $EPOCHSECONDS }
say_step() { print -r -- "$(ts) == $*" }
info() { print -r -- "$(ts)    $*" }

# Atomic small-file write from builtins only: write_file <path> <content>. Returns nonzero on any failure.
# A target that exists and is not a regular file (a directory would swallow the rename) is a failure.
write_file() {
  [[ -e $1 && ! -f $1 ]] && return 1
  local tmp=$1.tmp.$$
  { print -r -- "$2" > "$tmp" } 2>/dev/null || { zf_rm -f -- "$tmp" 2>/dev/null; return 1 }
  zf_mv -f -- "$tmp" "$1" 2>/dev/null || { zf_rm -f -- "$tmp" 2>/dev/null; return 1 }
}

# Progress receipt for the outside checker: which pid is in which step, until when.
CUR_STEP=""
progress() { # <step label> <deadline epoch or 0>
  CUR_STEP=$1
  [[ -n ${PROGRESS:-} ]] || return 0
  local l=${1//[\"\\]/_}; l=${l//[[:cntrl:]]/ }
  write_file "$PROGRESS" "{\"pid\":$$,\"mode\":\"${MODE_LABEL:-}\",\"start_epoch\":${START_EPOCH:-0},\"step\":\"$l\",\"step_deadline_epoch\":$2,\"updated_epoch\":$EPOCHSECONDS}" || true
}

# Clock seam (tests): AS2_CLOCK_CMD, when set, is a command (eval'd in a subshell) that prints the current epoch
# seconds. Every in-run deadline reads the clock through clock_now: bounded() below, backup-nightly.zsh's proof wait,
# and, under the test clock only, the alert's result window (alert() keeps its fixed ALERT_ACK wait otherwise). A test
# moves that clock past a deadline instead of waiting for it. Unset (every real run): CLOCK_NOW is $EPOCHREALTIME and
# CLOCK_NOW_S $EPOCHSECONDS, which is what those deadlines read before the seam. When the command fails or prints
# anything but seconds, clock_now prints why on stderr and returns 1, and the caller takes the deadline as reached: a
# broken test clock ends a wait, it never hangs one.
CLOCK_NOW=0 CLOCK_NOW_S=0
clock_now() {
  if [[ -z ${AS2_CLOCK_CMD:-} ]]; then CLOCK_NOW=$EPOCHREALTIME CLOCK_NOW_S=$EPOCHSECONDS; return 0; fi
  local o rc
  o=$(eval "$AS2_CLOCK_CMD" 2>&1); rc=$?
  if (( rc == 0 )) && [[ $o == <->(|.<->) ]]; then CLOCK_NOW=$o CLOCK_NOW_S=${o%%.*}; return 0; fi
  print -u2 -r -- "clock: AS2_CLOCK_CMD ($AS2_CLOCK_CMD) exited $rc and printed '${o//$'\n'/; }' instead of epoch seconds; the deadline counts as reached"
  return 1
}

# bounded <seconds> <label> <command> [args...]
# Runs one external command in its own process group (perl setpgrp, then exec). On expiry: SIGTERM to the
# group, up to 2 s grace, SIGKILL, reap; returns 124 and prints "TIMEOUT ..." on stderr. Otherwise returns
# the command's exit status. stdin and other open fds pass through. The expiry reads clock_now.
bounded() {
  local t=$1 label=$2; shift 2
  local deadline=$(( EPOCHSECONDS + t )) start k rc
  progress "$label" $deadline
  # The start is read before the child exists, so a test that waits for the child to block and then moves the clock
  # can never have its move taken as the start.
  clock_now || { print -u2 -r -- "TIMEOUT: $label was not started: its deadline clock could not be read"; return 124 }
  start=$CLOCK_NOW
  /usr/bin/perl -e 'setpgrp(0,0) or die "setpgrp: $!\n"; exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!\n"' -- "$@" &
  local pid=$!
  while kill -0 $pid 2>/dev/null; do
    if ! clock_now || (( CLOCK_NOW - start >= t )); then
      kill -TERM -- -$pid 2>/dev/null
      for k in {1..40}; do kill -0 -- -$pid 2>/dev/null || break; zselect -t 5; done
      kill -KILL -- -$pid 2>/dev/null
      wait $pid 2>/dev/null
      print -u2 -r -- "TIMEOUT: $label did not finish within ${t}s; its process group was killed"
      return 124
    fi
    zselect -t 5
  done
  wait $pid; rc=$?
  return $rc
}

# The needs-you entry (PLAN wl-mvwkt821jx4d6e slice 3): needs_you_write <job nightly|check> <result failed|ok> <text> <state json>
# runs surface/scripts/drive-backup-notice.ts with $AS2_BUN from $AS2_REPO on $AS2_LEDGER_DB, bounded 60 s (a ledger locked past
# its busy retries, a hung bun). It writes one `drive-backup:` entry on the standing workload, which surface/src/errors.ts shows
# in Jo's needs-you list until the next `check ok`. NEEDS_YOU_STATUS says what happened, never nothing:
#   written: <entry id>                    the entry is in the ledger
#   skipped: AS2_BUN unset                 a manual run outside launchd (the plists set it); returns 0
#   failed: <what, exit, output>           returns 1
NEEDS_YOU_STATUS=""
needs_you_write() {
  local text=${3//[[:cntrl:]]/ } miss="" o rc=0
  if [[ -z ${AS2_BUN:-} ]]; then
    NEEDS_YOU_STATUS="skipped: AS2_BUN unset"
    info "needs-you entry: $NEEDS_YOU_STATUS"
    return 0
  fi
  [[ -n ${AS2_REPO:-} ]] || miss+=" AS2_REPO"
  [[ -n ${AS2_LEDGER_DB:-} ]] || miss+=" AS2_LEDGER_DB"
  if [[ -n $miss ]]; then
    NEEDS_YOU_STATUS="failed: AS2_BUN is set but${miss} unset; the job's plist sets all three"
    info "needs-you entry: $NEEDS_YOU_STATUS"
    return 1
  fi
  (( ${#text} > 400 )) && text="${text[1,397]}..."
  o=$(bounded 60 "needs-you entry" "$AS2_BUN" run "$AS2_REPO/surface/scripts/drive-backup-notice.ts" --ledger "$AS2_LEDGER_DB" \
    --job "$1" --result "$2" --text "$text" --state "$4" 2>&1) || rc=$?
  o=${o//[[:cntrl:]]/ }
  if (( rc == 0 )) && [[ $o == "wrote en-"* ]]; then
    NEEDS_YOU_STATUS="written: ${${o#wrote }%% *}"
  elif (( rc == 0 )); then
    NEEDS_YOU_STATUS="failed: $AS2_REPO/surface/scripts/drive-backup-notice.ts exited 0 without naming the entry it wrote: ${o:-no output}"
  else
    NEEDS_YOU_STATUS="failed: $AS2_REPO/surface/scripts/drive-backup-notice.ts exit $rc: ${o:-no output}"
  fi
  info "needs-you entry: $NEEDS_YOU_STATUS"
  [[ $NEEDS_YOU_STATUS == written:* ]]
}

# Alert on three channels, in the order the alarm rule sets (decision log 2026-10-28--1400, alarms show a silent popup
# before any sound): the silent channels first, then the silent popup; nothing here plays a sound.
#   1. the needs-you entry (needs_you_write, bounded 60 s): `<job> failed` for the job MODE_LABEL names, its state file
#   2. the macOS notification, soundless (no `sound name`, the merge train's form), bounded 15 s
#   3. quiet-alarm's silent popup, with a positive delivery signal. quiet-alarm shows a popup and blocks until Jo answers
#      it; it exits 0 only after the popup was shown (a button, Dismiss, or give-up) and any sound Jo asked for played,
#      1 when the popup could not be shown, and 3 when the popup was shown, Jo picked "Read it to me" and the sound or
#      speech failed (its `quiet-alarm: audio FAILED: …` line names both commands). A detached wrapper records that exit
#      status and quiet-alarm's output in $STATE/alerts/<id>.result when quiet-alarm returns; popup_result reads it:
#        result rc=0                          the popup was displayed (the positive signal)
#        result rc=3 with the audio line      the popup was displayed; the read-aloud Jo asked for failed
#        result any other rc                  the popup failed
#        no result yet                        not known: shown and waiting, or stalled before showing
#      Process liveness is never taken as delivery.
# A broken channel never stops the next one. ALERT_STATUS records all three as `<popup>; notification rc <n>[ (<output>)];
# needs-you <NEEDS_YOU_STATUS>`: the popup's part leads (alert_ack_problem and the fixtures read it there) and the needs-you
# part is last (its output is the free text). The popup's part is `shown: …`, `audio failed: …`, `failed: …` or `sent: …`.
# ALERT_STATUS / ALERT_RESULT / ALERT_EPOCH go into the caller's state file; the other job runs alert_ack_problem on them and
# reports every failed channel.
ALERT_STATUS=none ALERT_RESULT="" ALERT_EPOCH=0

# popup_result <result file>: sets POPUP_RESULT from the wrapper's record (rc=<n>, at_epoch=<n>, then quiet-alarm's output):
#   shown                                   rc=0
#   audio-failed <the audio FAILED line>    rc=3 and quiet-alarm's `quiet-alarm: audio FAILED: ` line (a stub's own exit 3
#                                           without that line is a popup failure)
#   failed <the rc line>                    anything else, an empty or unreadable file included
POPUP_RESULT=""
popup_result() {
  local -a rl; local l
  rl=( "${(@f)$(<$1)}" )
  if [[ ${rl[1]:-} == rc=0 ]]; then POPUP_RESULT=shown; return 0; fi
  if [[ ${rl[1]:-} == rc=3 ]]; then
    for l in $rl; do
      [[ $l == 'quiet-alarm: audio FAILED: '* ]] && { POPUP_RESULT="audio-failed ${l//[[:cntrl:]]/ }"; return 0 }
    done
  fi
  POPUP_RESULT="failed ${rl[1]:-empty result}"
}

alert() { # <title> <popup> <spoken>
  local alog=$STATE/alert-delivery.log adir=$STATE/alerts id res job=nightly st=$STATE/last-run.json text=$2 fo frc=0
  info "ALERT: $1 / $2"
  ALERT_EPOCH=$EPOCHSECONDS
  # 1. needs-you
  [[ $1 == *': '* ]] && text="${1#*: }: $2"
  case ${MODE_LABEL:-} in
    check) job=check st=$STATE/last-check.json ;;
    verify) st=$STATE/last-verify.json text="restore test: $text" ;;
  esac
  needs_you_write $job failed "$text" "$st"
  # 2. notification
  fo=$(bounded 15 "notification" "$ALERT_FALLBACK" -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' "$1" "$2" 2>&1) || frc=$?
  fo=${fo//[[:cntrl:]]/ }
  info "notification: rc $frc ${fo}"
  # 3. popup
  id=$(strftime '%Y%m%dT%H%M%S' $EPOCHSECONDS)-$$
  res=$adir/$id.result
  if [[ ! -f $ALERT_CMD ]]; then
    ALERT_STATUS="failed: alert command missing: $ALERT_CMD"
  elif ! { [[ -d $adir ]] || zf_mkdir -m 700 -- "$adir" 2>/dev/null }; then
    ALERT_STATUS="failed: cannot create $adir to record the popup's result"
  else
    ALERT_RESULT=$res
    # Under the test clock (AS2_CLOCK_CMD) the result window's end is read from clock_now before the popup wrapper starts:
    # a popup stub moves that same clock (a popup left open), and a deadline read after its move would sit past the
    # clock and never be reached (review R7-T1). A clock that cannot be read leaves ack_end empty: no wait.
    local ack_end=""
    [[ -n ${AS2_CLOCK_CMD:-} ]] && clock_now && ack_end=$(( CLOCK_NOW + ${ALERT_ACK:-3} ))
    print -r -- "$(ts) alert $id pid $$: $1" >> "$alog" 2>/dev/null
    /bin/zsh -fc 'zmodload zsh/datetime; o=$(/bin/zsh "$1" "$2" "$3" "$4" 2>&1); rc=$?
      print -r -- "$o" >> "$6"
      print -rl -- "rc=$rc" "at_epoch=$EPOCHSECONDS" "$o" > "$5.tmp" && /bin/mv -f -- "$5.tmp" "$5"' \
      zsh "$ALERT_CMD" "$1" "$2" "$3" "$res" "$alog" </dev/null >/dev/null 2>&1 &!
    # An immediate failure (no GUI session, osascript error) is known within seconds. Under the test clock the same
    # ALERT_ACK seconds run to ack_end, read above, and the wait ends when the result is there.
    if [[ -z ${AS2_CLOCK_CMD:-} ]]; then
      zselect -t $(( ${ALERT_ACK:-3} * 100 ))
    elif [[ -n $ack_end ]]; then
      while [[ ! -f $res ]] && clock_now && (( CLOCK_NOW < ack_end )); do zselect -t 5; done
    fi
    if [[ -f $res ]]; then
      popup_result $res
      case $POPUP_RESULT in
        shown) ALERT_STATUS="shown: popup answered ($res)" ;;
        audio-failed*) ALERT_STATUS="audio failed: the popup was shown and Jo picked Read it to me, but ${POPUP_RESULT#audio-failed quiet-alarm: audio FAILED: } ($res)" ;;
        *) ALERT_STATUS="failed: the popup could not be shown ($res)" ;;
      esac
    else
      ALERT_STATUS="sent: awaiting the popup's result in $res"
    fi
  fi
  info "popup delivery: $ALERT_STATUS"
  ALERT_STATUS+="; notification rc $frc${fo:+ ($fo)}; needs-you $NEEDS_YOU_STATUS"
  info "alert delivery: $ALERT_STATUS"
}

# alert_ack_problem <state json> <now epoch> <window seconds>: prints every problem with the alert recorded in that file
# (joined by "; "), or nothing. Problems: the needs-you entry was not written; the notification failed; the popup's delivery
# failed at once, the popup reported a failure, or no popup result after the window; the popup was shown but the read-aloud
# Jo picked failed (quiet-alarm exit 3, recorded at once as `audio failed: …` or found later in the result file). A skipped
# needs-you entry (AS2_BUN unset: a manual run) is not a problem; it is in the file.
alert_ack_problem() {
  local al res ep part
  local -a probs
  al=$(/usr/bin/jq -r '.alert // empty' "$1" 2>/dev/null)
  res=$(/usr/bin/jq -r '.alert_result // empty' "$1" 2>/dev/null)
  ep=$(/usr/bin/jq -r '.alert_epoch // 0' "$1" 2>/dev/null)
  if [[ $al == *'; needs-you '* ]]; then
    part=${al#*; needs-you }
    [[ $part == failed:* ]] && probs+=( "the needs-you entry was not written: ${part#failed: }" )
  fi
  if [[ $al == *'; notification rc '* ]]; then
    part=${${al#*; notification rc }%%; needs-you *}
    [[ $part == 0 || $part == '0 ('* ]] || probs+=( "the notification failed: rc $part" )
  fi
  if [[ $al == failed* ]]; then
    probs+=( "not delivered: ${al%%; notification rc *}" )
  elif [[ $al == 'audio failed:'* ]]; then
    probs+=( "the read-aloud failed: ${${al%%; notification rc *}#audio failed: }" )
  elif [[ -n $res ]]; then
    if [[ -f $res ]]; then
      popup_result $res
      case $POPUP_RESULT in
        shown) ;;
        audio-failed*) probs+=( "the read-aloud failed: the popup was shown and Jo picked Read it to me, but ${POPUP_RESULT#audio-failed quiet-alarm: audio FAILED: } (see $res)" ) ;;
        *) probs+=( "the popup failed (${POPUP_RESULT#failed }; see $res)" ) ;;
      esac
    else
      [[ $ep == <-> ]] || ep=0
      (( $2 - ep > $3 )) && probs+=( "no sign the popup was shown: no result in $res $(( ($2 - ep) / 3600 )) h after it was sent (stalled before showing, or still open and unanswered)" )
    fi
  fi
  (( ${#probs} )) && print -r -- "${(j:; :)probs}"
  return 0
}
