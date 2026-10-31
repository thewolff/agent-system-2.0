#!/bin/zsh
# Fixtures for the alert's three channels (lib.zsh alert, needs_you_write, alert_ack_problem) and the 9 AM check's
# morning confirmation (check-backup-fresh.zsh), PLAN wl-mvwkt821jx4d6e slice 3, R6 and R7:
#   - the channel order: the needs-you entry, then the soundless notification, then the silent popup
#   - a needs-you writer that fails or hangs is named in the state file, the notification and popup still go, and the
#     other job reports it; AS2_BUN unset records `skipped: AS2_BUN unset`, never nothing
#   - the check job writes `check ok` on a clean run and `check failed` (through its alert) on a problem
# Stubs stand in for every channel and log each call, in call order, to $T/calls.log: $T/bun.zsh for $AS2_BUN (the
# writer; $T/bun.mode = ok | fail | hang), $T/osascript.zsh for the notification ($T/osascript.mode = ok | fail) and
# $T/popup.zsh for quiet-alarm. Nothing real is touched: no ledger, no notification, no popup, no launchd.
#   zsh test-alert.zsh        prints PASS/FAIL lines, ends with "RESULT: <n> failure(s)", exits n
# Deterministic (Jo's timing rule, decision log 2026-10-28--0840): no fixed waits. AS2_ALERT_ACK=0, so the alert does not
# wait for the popup's result; the suite waits on the popup stub's own log line and result file (wait_for, a failure-only
# guard). Two deadline tests drive the fake clock $T/clock through AS2_CLOCK_CMD and are marked `timing-under-test`: the
# writer's 60 s bound, and the popup's acknowledgement window when the popup stub moves the clock before the alert's next
# clock read (R7-T1). T is left in place for inspection (the bun test wrapper removes its root on a pass).
emulate -L zsh
setopt no_unset pipe_fail extended_glob
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
zmodload zsh/datetime zsh/zselect
unset AS2_CLOCK_CMD AS2_BUN AS2_REPO AS2_LEDGER_DB
HERE=${0:A:h}
T=$(mktemp -d "${TMPDIR:-/tmp}/as2-alert-test.XXXXXX") || { print -u2 "mktemp failed"; exit 99 }
[[ -d $T ]] || { print -u2 "no test dir"; exit 99 }
print "test dir: $T"
JQ=/usr/bin/jq
integer FAILS=0
ok()  { print -r -- "PASS: $*" }
bad() { print -r -- "FAIL: $*"; FAILS+=1 }
check() { local d=$1; shift; if eval "$*"; then ok "$d"; else bad "$d"; fi }
# wait_for <what> <condition> [guard seconds, default 30]: polls a real condition every 10 ms; the guard is failure-only.
wait_for() { local k g=${3:-30}; for k in {1..$(( g * 100 ))}; do eval "$2" && return 0; zselect -t 1; done; print -r -- "guard: $1 did not happen within $g s"; return 1 }
trap ': > $T/bun.release; : > $T/popup-holds.release' EXIT   # a hung writer or held popup stub still waiting ends now

# ---------- stubs ----------
cat > $T/bun.zsh <<EOF
#!/bin/zsh
zmodload zsh/zselect
print -r -- "NEEDSYOU \$*" >> $T/calls.log
print -rl -- "\$@" > $T/bun.args
case \$(<$T/bun.mode) in
  ok) n=\$(wc -l < $T/calls.log | tr -d ' '); print -r -- "wrote en-stub\$n on wl-standing: drive-backup: (stub)" ;;
  fail) print -u2 -r -- "drive-backup-notice: the entry could not be written to $T/ledger.db (database is locked); nothing written"; exit 1 ;;
  hang)
    : > $T/bun.started
    for k in {1..6000}; do [[ -e $T/bun.release ]] && break; zselect -t 1; done
    [[ -e $T/bun.release ]] || { print -u2 "bun.zsh: never released ($T/bun.release absent after 60 s)"; exit 3 } ;;
esac
EOF
cat > $T/osascript.zsh <<EOF
#!/bin/zsh
print -r -- "NOTIFICATION \$*" >> $T/calls.log
[[ \$(<$T/osascript.mode) == ok ]] || { print -u2 "execution error: Not authorized to send Apple events (-1743)"; exit 1 }
EOF
cat > $T/popup.zsh <<EOF
#!/bin/zsh
print -r -- "POPUP \$1" >> $T/calls.log
print "quiet-alarm: choice=Dismiss (no voice)"
EOF
chmod +x $T/bun.zsh $T/osascript.zsh $T/popup.zsh
print ok > $T/bun.mode; print ok > $T/osascript.mode
mkdir -p $T/repo/surface/scripts $T/claims || exit 99
: > $T/ledger.db
export AS2_REPO=$T/repo AS2_LEDGER_DB=$T/ledger.db AS2_ALERT_CMD=$T/popup.zsh AS2_ALERT_FALLBACK=$T/osascript.zsh AS2_ALERT_ACK=0 \
  AS2_ARCHIVE_ROOT=$T/no-archive-root AS2_CLAIMS=$T/claims AS2_UNDER_LAUNCHD=1

channels() { [[ -s $T/calls.log ]] || return 0; print -r -- ${(j: :)${(f)"$(cut -d' ' -f1 $T/calls.log)"}} }
arg_after() { local a=( "${(@f)$(<$T/bun.args)}" ) i; for i in {1..$(( ${#a} - 1 ))}; do [[ ${a[$i]} == $1 ]] && { print -r -- ${a[$i+1]}; return 0 }; done; return 1 }

# alert_in <state dir> <MODE_LABEL> [VAR=value ...]: one alert() as the job of that mode makes it, in its own process;
# ALERT_STATUS / ALERT_RESULT / ALERT_EPOCH go to <state dir>/alert.json, as the jobs put them in their state files.
alert_in() {
  local s=$1 m=$2; shift 2
  mkdir -p $s
  env "$@" /bin/zsh -fc '
    emulate -L zsh; setopt no_unset pipe_fail extended_glob
    STATE=$1 PROGRESS="" MODE_LABEL=$2 ALERT_CMD=$AS2_ALERT_CMD ALERT_FALLBACK=$AS2_ALERT_FALLBACK ALERT_ACK=$AS2_ALERT_ACK
    source $3/lib.zsh || exit 99
    alert "as2 Drive backup: 2 failure(s)" "copy: /arch/2026-10-30/wl-a.tar.gz: cp exited 1 (and 1 more). Details: $STATE/last-run.json" "The as2 Drive backup has 2 failures."
    /usr/bin/jq -n --arg a "$ALERT_STATUS" --arg r "$ALERT_RESULT" --argjson e $ALERT_EPOCH "{alert:\$a, alert_result:\$r, alert_epoch:\$e}" > $STATE/alert.json
  ' alert-in $s $m $HERE > $s/alert.out 2>&1
}
st() { $JQ -r "$1" $2/alert.json }
# popup_done <state json>: the popup stub ran and the result file that state file names is there (the detached wrapper
# writes it after the stub). alert_in's alerts are in <dir>/alert.json, the check job's in <dir>/last-check.json.
popup_done() { wait_for "the popup recorded in $1" "grep -q '^POPUP' $T/calls.log && [[ -f \$($JQ -r '.alert_result // empty' $1 2>/dev/null) ]]" }
# A clean or failed nightly heartbeat for the checker: beat <state dir> <result> <end epoch> [alert.json to take the alert from]
beat() {
  local alert='{"alert":"none","alert_result":"","alert_epoch":0}'
  [[ -n ${4:-} ]] && alert=$(<$4)
  $JQ -n --arg r $2 --argjson e $3 --argjson al "$alert" '{start_epoch:($e - 600), end_epoch:$e, result:$r, archive_root:"present",
    keep_local:false, counts:{failed:(if $r == "success" then 0 else 2 end)},
    failures:(if $r == "success" then [] else [{step:"copy", path:"/arch/2026-10-30/wl-a.tar.gz", error:"cp exited 1"}] end)} + $al' > $1/last-run.json
}
# The checker's clock: now, moved back a day on a Sunday so the weekly restore test never runs here.
NOW=$EPOCHSECONDS; [[ $(strftime '%u' $NOW) == 7 ]] && NOW=$(( NOW - 86400 ))
checker() { # <state dir>: runs check-backup-fresh.zsh against it; CRC and COUT
  COUT=$(AS2_LOG=$1/run.log AS2_NOW_EPOCH=$NOW /bin/zsh $HERE/check-backup-fresh.zsh 2>&1); CRC=$?
}

print "\n### the channel order, the writer working (R6)"
export AS2_BUN=$T/bun.zsh
: > $T/calls.log
S=$T/s-order; alert_in $S run
popup_done $S/alert.json || bad "the popup stub ran"
check "the channels run in order: needs-you entry, notification, popup" '[[ $(channels) == "NEEDSYOU NOTIFICATION POPUP" ]]'
check "the writer is run as bun run <repo>/surface/scripts/drive-backup-notice.ts" '[[ $(sed -n 1,2p $T/bun.args | tr "\n" " ") == "run $T/repo/surface/scripts/drive-backup-notice.ts " ]]'
check "the entry: nightly failed, on AS2_LEDGER_DB, naming last-run.json, the title's count and the popup text" \
  '[[ $(arg_after --job) == nightly && $(arg_after --result) == failed && $(arg_after --ledger) == $T/ledger.db && $(arg_after --state) == $S/last-run.json && $(arg_after --text) == "2 failure(s): copy: /arch/2026-10-30/wl-a.tar.gz: cp exited 1 (and 1 more). Details: $S/last-run.json" ]]'
check "the notification is soundless: display notification with a title, no sound name" 'grep "^NOTIFICATION" $T/calls.log | grep -q "display notification (item 2 of argv) with title (item 1 of argv)" && ! grep -qi "sound" $T/calls.log'
check "ALERT_STATUS records all three: popup first, then notification rc 0, then needs-you written with the entry id" \
  '[[ $(st .alert $S) == (sent|shown):*"; notification rc 0; needs-you written: en-stub1" ]]'
beat $S failure $(( NOW - 3600 )) $S/alert.json
check "the other job finds nothing wrong with a fully delivered alert" '[[ -z $(source $HERE/lib.zsh; alert_ack_problem $S/last-run.json $NOW 21600) ]]'

print "\n### a failing writer: named in last-run.json, reported by the check job (R7)"
print fail > $T/bun.mode; : > $T/calls.log
S=$T/s-fail; alert_in $S run
popup_done $S/alert.json || bad "the popup stub ran"
check "the notification and the popup still go after the failed write, in order" '[[ $(channels) == "NEEDSYOU NOTIFICATION POPUP" ]]'
check "ALERT_STATUS names the failed write: the writer, its exit and its stderr" \
  '[[ $(st .alert $S) == *"; needs-you failed: $T/repo/surface/scripts/drive-backup-notice.ts exit 1: drive-backup-notice: the entry could not be written to $T/ledger.db (database is locked); nothing written" ]]'
beat $S failure $(( NOW - 3600 )) $S/alert.json
check "last-run.json carries it" '$JQ -r .alert $S/last-run.json | grep -q "needs-you failed: .*database is locked"'
print ok > $T/bun.mode; : > $T/calls.log
checker $S
check "the 9 AM check reports the nightly's failed needs-you write as a problem" \
  '(( CRC == 1 )) && $JQ -r ".problems[]" $S/last-check.json | grep -q "^the nightly run'"'"'s own alert: the needs-you entry was not written: .*database is locked"'
popup_done $S/last-check.json || bad "the check's popup stub ran"
check "the check's alert writes check failed first, naming last-check.json, then notification and popup" \
  '[[ $(channels) == "NEEDSYOU NOTIFICATION POPUP" && $(arg_after --job) == check && $(arg_after --result) == failed && $(arg_after --state) == $S/last-check.json && $(arg_after --text) == *"problem(s): "*"needs-you entry was not written"* ]]'
check "last-check.json records the check's own alert with its needs-you entry written" '[[ $($JQ -r .alert $S/last-check.json) == *"; needs-you written: en-stub1" && $($JQ -r .confirm $S/last-check.json) == "not attempted: the check found problems" ]]'

print "\n### the other direction: a failed needs-you write in last-check.json, read the way the nightly job reads it"
print fail > $T/bun.mode; : > $T/calls.log
S=$T/s-checkfail; alert_in $S check
popup_done $S/alert.json || bad "the popup stub ran"
check "a check-mode alert writes check failed naming last-check.json" '[[ $(arg_after --job) == check && $(arg_after --state) == $S/last-check.json ]]'
$JQ '. + {at_epoch:'$NOW', result:"problems"}' $S/alert.json > $S/last-check.json
check "alert_ack_problem on last-check.json names the failed needs-you write (backup-nightly.zsh reports it as watcher-alert)" \
  '[[ $(source $HERE/lib.zsh; alert_ack_problem $S/last-check.json $NOW 21600) == "the needs-you entry was not written: "*"database is locked"* ]]'

print "\n### the check job's morning confirmation"
print ok > $T/bun.mode; : > $T/calls.log
S=$T/s-clean; mkdir -p $S; beat $S success $(( NOW - 3600 ))
checker $S
check "a clean check exits 0 and writes check ok naming last-check.json, with no notification or popup" \
  '(( CRC == 0 )) && [[ $(channels) == NEEDSYOU && $(arg_after --job) == check && $(arg_after --result) == ok && $(arg_after --state) == $S/last-check.json && $(arg_after --text) == "no problems; last nightly run: result success, ended "* ]]'
check "last-check.json: result ok, confirm written with the entry id" '[[ $($JQ -r .result $S/last-check.json) == ok && $($JQ -r .confirm $S/last-check.json) == "written: en-stub1" ]]'
print fail > $T/bun.mode; : > $T/calls.log
S=$T/s-clean-fail; mkdir -p $S; beat $S success $(( NOW - 3600 ))
checker $S
popup_done $S/last-check.json || bad "the check's popup stub ran"
check "a clean check whose check ok write fails: a problem, alerted (needs-you tried again, notification, popup)" \
  '(( CRC == 1 )) && $JQ -r ".problems[]" $S/last-check.json | grep -q "^the morning confirmation (drive-backup: check ok) was not written" && [[ $(channels) == "NEEDSYOU NEEDSYOU NOTIFICATION POPUP" ]]'
check "last-check.json: confirm failed, and the alert's own needs-you failure named" \
  '[[ $($JQ -r .confirm $S/last-check.json) == "failed: "*"database is locked"* && $($JQ -r .alert $S/last-check.json) == *"; needs-you failed: "* ]]'

print "\n### AS2_BUN unset (a manual run): skipped, said so, never silent"
unset AS2_BUN; print ok > $T/bun.mode; : > $T/calls.log
S=$T/s-nobun; alert_in $S run
popup_done $S/alert.json || bad "the popup stub ran"
check "no writer call; the notification then the popup still go" '[[ $(channels) == "NOTIFICATION POPUP" ]]'
check "ALERT_STATUS says needs-you skipped: AS2_BUN unset" '[[ $(st .alert $S) == *"; needs-you skipped: AS2_BUN unset" ]]'
check "a skip is not reported as a failed channel" '[[ -z $(source $HERE/lib.zsh; alert_ack_problem $S/alert.json $NOW 21600) ]]'
: > $T/calls.log
S=$T/s-nobun-clean; mkdir -p $S; beat $S success $(( NOW - 3600 ))
checker $S
check "a clean check without AS2_BUN exits 0 and records confirm skipped" '(( CRC == 0 )) && [[ -z $(channels) && $($JQ -r .confirm $S/last-check.json) == "skipped: AS2_BUN unset" ]]'

print "\n### AS2_BUN set, AS2_REPO unset: a failure naming the missing variable"
: > $T/calls.log
S=$T/s-norepo; alert_in $S run AS2_BUN=$T/bun.zsh AS2_REPO=
popup_done $S/alert.json || bad "the popup stub ran"
check "no writer call; the failure names AS2_REPO; the other job reports it" \
  '[[ $(channels) == "NOTIFICATION POPUP" && $(st .alert $S) == *"; needs-you failed: AS2_BUN is set but AS2_REPO unset"* && $(source $HERE/lib.zsh; alert_ack_problem $S/alert.json $NOW 21600) == "the needs-you entry was not written: AS2_BUN is set but AS2_REPO unset"* ]]'

print "\n### a failing notification is recorded and reported (R7)"
print fail > $T/osascript.mode; : > $T/calls.log
S=$T/s-notif; alert_in $S run AS2_BUN=$T/bun.zsh
popup_done $S/alert.json || bad "the popup stub ran"
check "the popup still goes after a failed notification; the failure is in ALERT_STATUS and reported" \
  '[[ $(channels) == "NEEDSYOU NOTIFICATION POPUP" && $(st .alert $S) == *"; notification rc 1 ("*"-1743))"* && $(source $HERE/lib.zsh; alert_ack_problem $S/alert.json $NOW 21600) == "the notification failed: rc 1 (execution error: "*"(-1743))" ]]'
print ok > $T/osascript.mode

print "\n### the restore test's alert (verify mode) names last-verify.json"
: > $T/calls.log
S=$T/s-verify; alert_in $S verify AS2_BUN=$T/bun.zsh
popup_done $S/alert.json || bad "the popup stub ran"
check "verify mode: nightly failed, last-verify.json, text marked restore test" '[[ $(arg_after --job) == nightly && $(arg_after --state) == $S/last-verify.json && $(arg_after --text) == "restore test: 2 failure(s): "* ]]'

print "\n### a hung writer is cut at its 60 s bound; the notification and popup still go"
# timing-under-test: needs_you_write's 60 s bound (bounded 60, lib.zsh) (fake clock: AS2_CLOCK_CMD)
# The suite waits for the stub to start (the real event), then moves the fake clock 61 s on.
print hang > $T/bun.mode; : > $T/calls.log; rm -f $T/bun.started $T/bun.release
print 1000000 > $T/clock
S=$T/s-hang; mkdir -p $S
alert_in $S run AS2_BUN=$T/bun.zsh AS2_CLOCK_CMD="/bin/cat $T/clock" &
apid=$!
wait_for "the writer stub starting" '[[ -f $T/bun.started ]]' || bad "the hung writer stub started"
# The alert's clock reader runs concurrently: publish by rename so it never reads a truncated, empty clock (R7-T2).
print 1000061 > $T/clock.tmp && /bin/mv -f -- $T/clock.tmp $T/clock
wait_for "the alert finishing after the bound" '[[ -f $S/alert.json ]]' || bad "the alert finished after the writer's bound"
wait $apid
popup_done $S/alert.json || bad "the popup stub ran"
check "the hung write is failed as a timeout (exit 124), then the notification and the popup go" \
  '[[ $(channels) == "NEEDSYOU NOTIFICATION POPUP" && $(st .alert $S) == *"; needs-you failed: "*" exit 124: TIMEOUT: needs-you entry did not finish within 60s"* ]]'
: > $T/bun.release

print "\n### the popup's acknowledgement window when the popup stub moves the clock first (R7-T1)"
# timing-under-test: popup acknowledgement window (fake clock: AS2_CLOCK_CMD)
# Forces the child-first order: the popup stub moves the fake clock 1000 s on (a popup left open) and then holds, and the
# gated clock makes every read taken after the alert logged its popup as sent (alert-delivery.log) wait until that move
# is done. An alert that read its 1 s window's end before starting the popup sees the clock past it and returns `sent`;
# one that read it after the start gets a deadline 1 s past a clock that no longer moves, and waits until the popup is
# released. The gate's own limit and the suite's wait are failure-only guards.
print ok > $T/bun.mode; : > $T/calls.log; rm -f $T/popup-holds.advanced $T/popup-holds.release $T/gate.timeout
print 1000000 > $T/clock
S=$T/s-ackwin; mkdir -p $S
cat > $T/popup-holds.zsh <<EOF
#!/bin/zsh
zmodload zsh/zselect
print -r -- "POPUP \$1" >> $T/calls.log
c=\$(<$T/clock) && print -r -- \$(( c + 1000 )) > $T/clock.tmp && /bin/mv -f -- $T/clock.tmp $T/clock && : > $T/popup-holds.advanced
for k in {1..6000}; do [[ -e $T/popup-holds.release ]] && break; zselect -t 1; done
[[ -e $T/popup-holds.release ]] || { print -u2 "popup-holds.zsh: never released ($T/popup-holds.release absent after 60 s)"; exit 3 }
print "quiet-alarm: choice=Dismiss (no voice)"
EOF
cat > $T/gated-clock.zsh <<EOF
#!/bin/zsh
zmodload zsh/zselect
if /usr/bin/grep -q ' alert ' $S/alert-delivery.log 2>/dev/null; then
  for k in {1..3000}; do [[ -e $T/popup-holds.advanced ]] && break; zselect -t 1; done
  [[ -e $T/popup-holds.advanced ]] || print -r -- "gated-clock.zsh: the popup stub had not moved the clock 30 s after the alert was sent" >> $T/gate.timeout
fi
print -r -- \$(<$T/clock)
EOF
alert_in $S run AS2_BUN=$T/bun.zsh AS2_ALERT_CMD=$T/popup-holds.zsh AS2_ALERT_ACK=1 AS2_CLOCK_CMD="/bin/zsh $T/gated-clock.zsh" &
apid=$!
wait_for "the alert returning once the moved clock passes its window" '[[ -f $S/alert.json ]]' 15 || bad "the alert returns while the popup is still held, once the moved clock is past its window"
: > $T/popup-holds.release
wait $apid
check "the popup stub moved the clock before the alert's next read, and the gate never hit its limit" \
  '[[ -f $T/popup-holds.advanced && $(<$T/clock) == 1001000 && ! -e $T/gate.timeout ]]'
check "the alert's window ended on the moved clock: the popup is sent, its result still awaited" \
  '[[ $(st .alert $S) == "sent: awaiting the popup'"'"'s result in "*"; notification rc 0; needs-you written: "* ]]'

print "\nRESULT: $FAILS failure(s)"
exit $FAILS
