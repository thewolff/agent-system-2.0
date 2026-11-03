#!/bin/zsh
# Jo, 2026-10-28: no sound until Jo dismisses a popup (alarms kept talking during calls).
# Usage: zsh quiet-alarm.zsh "<title>" "<popup text>" "<spoken text>"
# Shows a SILENT popup that waits for Jo. "Read it to me" then plays the Glass sound and speaks the text;
# "Dismiss (no voice)" makes no sound at all. Return/Escape picks the silent button.
#
# Exit status (2026-10-28, daily-report relay review): 0 when the popup was shown, whether Jo picked a button,
# dismissed it, or it gave up, and any sound Jo asked for played; 1 when the popup itself could not be shown (any
# AppleScript error other than "User canceled" -128), with the error on stderr. Earlier versions always exited 0; both
# existing callers (bun-omp-monday-alarm.zsh, disk-rule-machinery-alarm.zsh) ignore the status, so they behave as before.
# 3 (2026-10-31, drive-backup final review F1) when the popup was shown and Jo picked "Read it to me" but the Glass sound
# or the speech failed: both are still tried, and one stderr line names each command's exit status and its stderr,
# `quiet-alarm: audio FAILED: afplay rc <n> (<stderr>); say rc <m> (<stderr>)`. Before this, a failed afplay or say
# was discarded and the run exited 0, so drive-backup's lib.zsh recorded a delivered alarm.
# Apple event timeout (2026-11-02, Jo's report in-mvzkfa7dsszkrt): the display dialog is sent to System Events inside an
# explicit `with timeout of <n> seconds` block. Without one AppleScript waits only its default two minutes for the reply
# and then fails with -1712 (AppleScript Language Guide, "with timeout": "By default, when an application fails to
# respond to a command, AppleScript waits for two minutes before reporting an error and halting execution"; it "does
# not cancel the operation"). Every Drive backup popup of 2026-11-01/02 that Jo did not answer within two minutes was
# recorded as "System Events got an error: AppleEvent timed out. (-1712)", exit 1, 123-125 s after the alert started.
# The timeout is the give-up time plus 60 s when QUIET_ALARM_GIVE_UP_SECS is set, else 31536000 s (one year), so the
# popup waits for Jo. The exit-status contract above is unchanged; a timeout that still fires remains exit 1.
# Registration (2026-11-03, PLAN wl-mw0vs9uc3xqtka D3, Jo's registry rule q-mw175xfx2etc13): with QUIET_ALARM_REGISTER set,
# the alert path's popup worker (surface/scripts/alert-popup.ts) can cancel this popup, because the alert pass signals only
# processes recorded by pid and lstart. This script then appends one `<pid> <lstart> <name>` line to that file for its own
# zsh first, and for each osascript, afplay and say right after starting it (each runs in the background, is recorded, and
# is waited for, so its exit status and streams are what they are without registration). A failed recording is one
# `quiet-alarm: register FAILED: …` line on stderr and the popup goes on. Without QUIET_ALARM_REGISTER (the doctor's popup,
# drive-backup) nothing is recorded and every helper runs in the foreground, as before.
# Optional environment:
#   QUIET_ALARM_GIVE_UP_SECS  close the popup by itself after this many seconds (unset: waits for Jo, up to one year).
#   QUIET_ALARM_OSASCRIPT     the osascript binary (test seam; default /usr/bin/osascript).
#   QUIET_ALARM_AFPLAY        the afplay binary (test seam; default /usr/bin/afplay).
#   QUIET_ALARM_SAY           the say binary (test seam; default /usr/bin/say).
#   QUIET_ALARM_REGISTER      the file the registration lines are appended to (unset: no registration).
#   QUIET_ALARM_PS            the ps that reads each lstart under registration (test seam; default /bin/ps).
title=$1 text=$2 spoken=$3
give_up=${QUIET_ALARM_GIVE_UP_SECS:-0}
[[ $give_up == <-> ]] || give_up=0
# ---- registration: start
reg=${QUIET_ALARM_REGISTER:-}
if [[ -n $reg ]]; then
  # regerr keeps this script's stderr for register's failure lines, whatever a helper's own capture redirects fd 2 to.
  exec {regerr}>&2
  zmodload zsh/parameter || { print -r -u $regerr -- "quiet-alarm: register FAILED: zsh/parameter did not load, so nothing is recorded in $reg"; reg= }
fi
# register <pid> <name>: append `<pid> <lstart> <name>` to $reg. The lstart is `ps -o lstart= -p <pid>` with its whitespace
# collapsed to single spaces: the token surface/scripts/alert-popup.ts parsePs makes of the same process's lstart in the
# pass's `ps -A -ww -o pid=,ppid=,pgid=,lstart=,command=` reading. A helper (any name but zsh) is recorded only while it is
# still this shell's running job after the read: it was not yet reaped, so the pid read was still its own. One that already
# ended needs no cancelling and gets no line.
register() {
  setopt local_options extended_glob
  local out rc werr
  out=$("${QUIET_ALARM_PS:-/bin/ps}" -o lstart= -p $1 2>&1); rc=$?
  [[ $2 == zsh || ${(j: :)jobstates} == *:$1=running* ]] || return 0
  out=${(j: :)${=out}}
  if (( rc != 0 )) || [[ $out != [^\ ]##\ [^\ ]##\ <1-31>\ <->:<->:<->\ <-> ]]; then
    print -r -u $regerr -- "quiet-alarm: register FAILED: $2 pid $1: ps -o lstart= -p $1 exited $rc: ${out:-no output}"
    return 1
  fi
  if ! werr=$( { print -r -- "$1 $out $2" >>$reg } 2>&1 ); then
    print -r -u $regerr -- "quiet-alarm: register FAILED: $2 pid $1: cannot append to $reg: ${werr:-no error text}"
    return 1
  fi
}
# run <name> <command…>: the command in the foreground; under registration, in the background with this function's stdin
# (zsh gives a background command /dev/null), recorded, then waited for, so its exit status is the command's own.
run() {
  local name=$1 pid
  shift
  [[ -z $reg ]] && { "$@"; return }
  { "$@" <&3 3<&- {regerr}>&- & } 3<&0
  pid=$!
  register $pid $name
  wait $pid
}
# ---- registration: end
[[ -n $reg ]] && register $$ zsh
errfile=$(mktemp "${TMPDIR:-/tmp}/quiet-alarm.XXXXXX") || errfile=/dev/null
choice=$(run osascript "${QUIET_ALARM_OSASCRIPT:-/usr/bin/osascript}" - "$title" "$text" "$give_up" <<'APPLESCRIPT' 2>"$errfile"
on run argv
	set giveUp to (item 3 of argv) as integer
	if giveUp > 0 then
		set waitSecs to giveUp + 60
	else
		set waitSecs to 31536000
	end if
	tell application "System Events"
		activate
		with timeout of waitSecs seconds
			if giveUp > 0 then
				set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Read it to me", "Dismiss (no voice)"} default button "Dismiss (no voice)" cancel button "Dismiss (no voice)" giving up after giveUp
				if gave up of r then return "gave up"
			else
				set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Read it to me", "Dismiss (no voice)"} default button "Dismiss (no voice)" cancel button "Dismiss (no voice)"
			end if
		end timeout
	end tell
	return button returned of r
end run
APPLESCRIPT
)
rc=$?
err=$(<"$errfile" 2>/dev/null); [[ $errfile != /dev/null ]] && rm -f "$errfile"
if (( rc != 0 )) && [[ $err != *'(-128)'* ]]; then
  echo "quiet-alarm: popup FAILED (osascript exit $rc): ${err:-no error text}" >&2
  exit 1
fi
echo "quiet-alarm: choice=${choice:-Dismiss (no voice)}"
if [[ "$choice" == "Read it to me" ]]; then
  aerr=$(run afplay "${QUIET_ALARM_AFPLAY:-/usr/bin/afplay}" /System/Library/Sounds/Glass.aiff 2>&1 >/dev/null); arc=$?
  serr=$(run say "${QUIET_ALARM_SAY:-/usr/bin/say}" "$spoken" 2>&1 >/dev/null); src=$?
  if (( arc != 0 || src != 0 )); then
    aerr=${aerr//[[:cntrl:]]/ } serr=${serr//[[:cntrl:]]/ }
    echo "quiet-alarm: audio FAILED: afplay rc $arc (${aerr:-no error text}); say rc $src (${serr:-no error text})" >&2
    exit 3
  fi
fi
exit 0
