# Shared helpers for backup-nightly.zsh and check-backup-fresh.zsh. Sourced, never run.
# Callers set: STATE (state dir), PROGRESS (progress file or ""), ALERT_CMD, ALERT_FALLBACK, MODE_LABEL.
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

# Alert with a positive delivery signal. quiet-alarm shows a popup and blocks until Jo answers it; it exits 0
# only after the popup was shown (a button, Dismiss, or give-up) and 1 when the popup could not be shown. A
# detached wrapper records that exit status in $STATE/alerts/<id>.result when quiet-alarm returns, so:
#   result rc=0         the popup was displayed (the positive signal)
#   result rc!=0        the popup failed
#   no result yet       not known: shown and waiting, or stalled before showing
# Process liveness is never taken as delivery. The macOS notification is sent on every alert, so a popup that
# stalls silently still leaves a notification. ALERT_STATUS / ALERT_RESULT / ALERT_EPOCH go into the caller's
# state file; the other job runs alert_ack_problem on them and alarms when no rc=0 result arrived in time.
ALERT_STATUS=none ALERT_RESULT="" ALERT_EPOCH=0
alert() { # <title> <popup> <spoken>
  local alog=$STATE/alert-delivery.log adir=$STATE/alerts id res
  info "ALERT: $1 / $2"
  ALERT_EPOCH=$EPOCHSECONDS
  id=$(strftime '%Y%m%dT%H%M%S' $EPOCHSECONDS)-$$
  res=$adir/$id.result
  if [[ ! -f $ALERT_CMD ]]; then
    ALERT_STATUS="failed: alert command missing: $ALERT_CMD"
  elif ! { [[ -d $adir ]] || zf_mkdir -m 700 -- "$adir" 2>/dev/null }; then
    ALERT_STATUS="failed: cannot create $adir to record the popup's result"
  else
    ALERT_RESULT=$res
    print -r -- "$(ts) alert $id pid $$: $1" >> "$alog" 2>/dev/null
    /bin/zsh -fc 'zmodload zsh/datetime; o=$(/bin/zsh "$1" "$2" "$3" "$4" 2>&1); rc=$?
      print -r -- "$o" >> "$6"
      print -rl -- "rc=$rc" "at_epoch=$EPOCHSECONDS" "$o" > "$5.tmp" && /bin/mv -f -- "$5.tmp" "$5"' \
      zsh "$ALERT_CMD" "$1" "$2" "$3" "$res" "$alog" </dev/null >/dev/null 2>&1 &!
    # An immediate failure (no GUI session, osascript error) is known within seconds. Under the test clock
    # (AS2_CLOCK_CMD) the same ALERT_ACK seconds are read from clock_now, and the wait ends when the result is there.
    if [[ -z ${AS2_CLOCK_CMD:-} ]]; then
      zselect -t $(( ${ALERT_ACK:-3} * 100 ))
    else
      local ack_end
      if clock_now; then
        ack_end=$(( CLOCK_NOW + ${ALERT_ACK:-3} ))
        while [[ ! -f $res ]] && clock_now && (( CLOCK_NOW < ack_end )); do zselect -t 5; done
      fi
    fi
    if [[ -f $res && $(<$res) != rc=0* ]]; then
      ALERT_STATUS="failed: the popup could not be shown ($res)"
    elif [[ -f $res ]]; then
      ALERT_STATUS="shown: popup answered ($res)"
    else
      ALERT_STATUS="sent: awaiting the popup's result in $res"
    fi
  fi
  info "alert delivery: $ALERT_STATUS"
  local fo frc=0
  fo=$(bounded 15 "notification" "$ALERT_FALLBACK" -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' "$1" "$2" 2>&1) || frc=$?
  ALERT_STATUS+="; notification rc $frc${fo:+ ($fo)}"
  info "notification: rc $frc ${fo}"
}

# alert_ack_problem <state json> <now epoch> <window seconds>: prints a problem with the alert recorded in that
# file, or nothing. Problems: delivery failed at once; the popup reported a failure; no result after the window.
alert_ack_problem() {
  local al res ep
  al=$(/usr/bin/jq -r '.alert // empty' "$1" 2>/dev/null)
  res=$(/usr/bin/jq -r '.alert_result // empty' "$1" 2>/dev/null)
  ep=$(/usr/bin/jq -r '.alert_epoch // 0' "$1" 2>/dev/null)
  [[ $al == failed* ]] && { print -r -- "not delivered: $al"; return 0 }
  [[ -n $res ]] || return 0
  if [[ -f $res ]]; then
    local -a rl; rl=( "${(@f)$(<$res)}" )
    [[ ${rl[1]:-} == rc=0 ]] || print -r -- "the popup failed (${rl[1]:-empty result}; see $res)"
    return 0
  fi
  [[ $ep == <-> ]] || ep=0
  (( $2 - ep > $3 )) && print -r -- "no sign the popup was shown: no result in $res $(( ($2 - ep) / 3600 )) h after it was sent (stalled before showing, or still open and unanswered)"
  return 0
}
