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
# Optional environment:
#   QUIET_ALARM_GIVE_UP_SECS  close the popup by itself after this many seconds (unset: waits for Jo forever).
#   QUIET_ALARM_OSASCRIPT     the osascript binary (test seam; default /usr/bin/osascript).
#   QUIET_ALARM_AFPLAY        the afplay binary (test seam; default /usr/bin/afplay).
#   QUIET_ALARM_SAY           the say binary (test seam; default /usr/bin/say).
title=$1 text=$2 spoken=$3
give_up=${QUIET_ALARM_GIVE_UP_SECS:-0}
[[ $give_up == <-> ]] || give_up=0
errfile=$(mktemp -t quiet-alarm) || errfile=/dev/null
choice=$("${QUIET_ALARM_OSASCRIPT:-/usr/bin/osascript}" - "$title" "$text" "$give_up" <<'APPLESCRIPT' 2>"$errfile"
on run argv
	set giveUp to (item 3 of argv) as integer
	tell application "System Events"
		activate
		if giveUp > 0 then
			set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Read it to me", "Dismiss (no voice)"} default button "Dismiss (no voice)" cancel button "Dismiss (no voice)" giving up after giveUp
			if gave up of r then return "gave up"
		else
			set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Read it to me", "Dismiss (no voice)"} default button "Dismiss (no voice)" cancel button "Dismiss (no voice)"
		end if
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
  aerr=$("${QUIET_ALARM_AFPLAY:-/usr/bin/afplay}" /System/Library/Sounds/Glass.aiff 2>&1 >/dev/null); arc=$?
  serr=$("${QUIET_ALARM_SAY:-/usr/bin/say}" "$spoken" 2>&1 >/dev/null); src=$?
  if (( arc != 0 || src != 0 )); then
    aerr=${aerr//[[:cntrl:]]/ } serr=${serr//[[:cntrl:]]/ }
    echo "quiet-alarm: audio FAILED: afplay rc $arc (${aerr:-no error text}); say rc $src (${serr:-no error text})" >&2
    exit 3
  fi
fi
exit 0
