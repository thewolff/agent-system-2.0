#!/bin/zsh
# Fake-Drive suite, jobs part: setup failures (schema drift, Drive root, temp dir, archive root, lock) stop the run and
# still write a heartbeat; a never-existing archive root is tracked; alert delivery and state-write failures are
# reported; the 9 AM check-backup-fresh.zsh (stale, in progress, hung, old public and claimed archives, no heartbeat,
# the Sunday restore test, its own state); the nightly watches the watcher; and the ledger-only period's Sunday
# restore test (no archive yet: the ledger is verified and the archive part is "not applicable" until the 7-day
# archive-root grace ends). Setup: fake-drive-fixture.zsh.
#   zsh test-fake-drive-jobs.zsh        prints PASS/FAIL lines, ends with "RESULT: <n> failure(s)", exits n
emulate -L zsh
setopt no_unset pipe_fail extended_glob
HERE=${0:A:h}
source $HERE/fake-drive-fixture.zsh || { print -u2 "cannot source $HERE/fake-drive-fixture.zsh"; exit 99 }
trap cleanup EXIT

print "\n### seed: one archive proven, so the archive root has been seen and the restore test has a receipt"
mk $ARCH/2026-10-28/wl-seed.tar.gz 1000
night "seed night" >/dev/null
check "seed: wl-seed proven, archive root seen" '[[ -f $(rcpt_of 2026-10-28/wl-seed.tar.gz) && -f $T/state/archive-root-seen ]]'

print "\n### proof source layout drift stops the run before anything is touched"
before=$(snapshot)
$SQL "$FDB" "update properties set value=x'0A1A73796E635F656E67696E655F736368656D615F76657273696F6E1803' where property='sync_engine_schema_version'"
night "schema version changed"
check "schema drift: setup-failed at drivefs-schema, nothing touched" '(( RC != 0 )) && [[ $(hb .result) == setup-failed && $(hb ".failures[0].step") == drivefs-schema && $(snapshot) == $before ]]'
$SQL "$FDB" "update properties set value=x'0A1A73796E635F656E67696E655F736368656D615F76657273696F6E1802' where property='sync_engine_schema_version'"

print "\n### setup failures stop at once and still write a heartbeat"
AS2_DRIVE_ROOT=$T/no-such-drive night "Drive root absent"
check "absent Drive root: setup-failed, nothing touched" '(( RC != 0 )) && [[ $(hb .result) == setup-failed && $(hb ".failures[0].step") == drive-root && $(snapshot) == $before ]]'
AS2_TMPDIR=$T/no-such-tmp night "temp dir cannot be created"
check "no temp dir: setup-failed at tempdir, nothing touched" '(( RC != 0 )) && [[ $(hb .result) == setup-failed && $(hb ".failures[0].step") == tempdir && $(snapshot) == $before ]]'
mv $ARCH $T/arch-moved
night "archive root vanished after it was seen"
check "missing archive root (seen before): setup-failed at archive-root" '(( RC != 0 )) && [[ $(hb ".failures[0].step") == archive-root ]]'
mv $T/arch-moved $ARCH
zsystem flock -f HOLD $T/state/backup-nightly.lock
night "another run holds the lock"
check "lock held: setup-failed at lock" '(( RC != 0 )) && [[ $(hb ".failures[0].step") == lock ]]'
zsystem flock -u $HOLD

print "\n### archive root that never existed is tracked, not silent"
# its own state and claims dirs: a fresh install has neither, and wl-seed stays in this part's claims
AS2_ARCHIVE_ROOT=$T/never AS2_CLAIMS=$T/claims2 AS2_LOG=$T/state2/run.log night "fresh install, no archive root yet" >/dev/null 2>&1; mkdir -p $T/state2
AS2_ARCHIVE_ROOT=$T/never AS2_CLAIMS=$T/claims2 AS2_LOG=$T/state2/run.log night "fresh install, no archive root yet" >/dev/null
check "absent-never-seen recorded" '[[ $(jq -r .archive_root $T/state2/last-run.json) == absent-never-seen ]]'
print $(( EPOCHSECONDS - 8*86400 )) > $T/state2/first-run-epoch
out=$(AS2_ARCHIVE_ROOT=$T/never AS2_CLAIMS=$T/claims2 AS2_LOG=$T/state2/run.log zsh "$HERE/check-backup-fresh.zsh" 2>&1)
check "checker flags a root that has never existed after 7 days" '[[ $out == *"has never existed"* ]]'

print "\n### alert delivery and state-write failures are reported"
mk $ARCH/2026-10-28/wl-al.tar.gz 1000
print 'wl-al.????????????????.*.tar.gz' > $T/uploader.bad; upmode good
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=3, and the alert's ALERT_ACK result window: the dying popup
# stub's result arrives before the fake clock moves (fake clock: AS2_CLOCK_CMD)
AS2_ALERT_CMD=$T/alert-dies.zsh AS2_PROOF_TIMEOUT=3 night "a failing night whose popup cannot be shown" >/dev/null
check "popup failure recorded at once; notification sent" '[[ $(hb .alert) == failed* && $(hb .alert) == *"notification rc 0"* ]] && grep -q NOTIFICATION $T/fallback.log'
out=$(zsh "$HERE/check-backup-fresh.zsh" 2>&1)
check "checker reports the nightly's failed popup" '[[ $out == *"own alert: not delivered"* ]]'
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=3, and the alert's ALERT_ACK result window: the stalled stub
# moves the fake clock past it (fake clock: AS2_CLOCK_CMD)
AS2_ALERT_CMD=$T/alert-stalls.zsh AS2_PROOF_TIMEOUT=3 night "a failing night whose popup stalls without showing" >/dev/null
stall_res=$(hb .alert_result)
check "stalled popup is never called delivered" '[[ $(hb .alert) == sent* && ! -f $(hb .alert_result) ]]'
out=$(AS2_NOW_EPOCH=$(( EPOCHSECONDS + 7*3600 )) zsh "$HERE/check-backup-fresh.zsh" 2>&1)
check "7 h later, no result: the checker alarms (no sign the popup was shown)" '[[ $out == *"no sign the popup was shown"* ]]'
out=$(zsh "$HERE/check-backup-fresh.zsh" 2>&1)
check "inside the 6 h window, no alarm about that popup yet" '[[ $out != *"no sign the popup was shown"* ]]'
# the stalled stub ends now (it exits 1: never shown); wait for its result so nothing writes into $T later
: > $T/alert-stalls.release
wait_for "the stalled popup stub ending" '[[ -f $stall_res ]]' || bad "the stalled popup stub ended when released"
mv $T/state/last-run.json $T/lr.bak; mkdir $T/state/last-run.json
night "heartbeat cannot be written" >/dev/null
check "heartbeat write failure becomes a failure and is alerted" '(( RC != 0 )) && tail -1 $T/alerts.log | grep -q "failure"' 
rmdir $T/state/last-run.json; mv $T/lr.bak $T/state/last-run.json
: > $T/uploader.bad

print "\n### check-backup-fresh.zsh"
chk() { print "\n--- check: $1"; shift; env "$@" zsh "$HERE/check-backup-fresh.zsh" 2>&1 | sed -E "s#$T#\$T#g"; CRC=${pipestatus[1]} }
night "a good night before the checks" >/dev/null; night "and its re-proof night" >/dev/null
rm -f $T/state/last-check.json
chk "fresh success" X=1
check "fresh success: exit 0, last-check.json ok (or only notes)" '[[ $(jq -r .result $T/state/last-check.json) == ok ]] || jq -r ".problems[]" $T/state/last-check.json'
chk "30 h later" AS2_NOW_EPOCH=$(( EPOCHSECONDS + 30*3600 ))
check "stale heartbeat flagged with the sleep/power-off wording" '(( CRC != 0 )) && tail -1 $T/alerts.log | grep -q "powered off"'
# A live process whose command line names backup-nightly.zsh, standing in for a nightly run in progress until the
# test kills it (a release file is its failure-only 600 s guard)
/usr/bin/perl -e 'for (1..60000) { exit 0 if -e $ARGV[1]; select(undef, undef, undef, 0.01) } exit 3' backup-nightly.zsh $T/fake-run.release &!
fakepid=$!; FAKE_RUNNING+=( $fakepid )
print "{\"pid\":$fakepid,\"mode\":\"run\",\"start_epoch\":$(( EPOCHSECONDS - 600 )),\"step\":\"copy to Drive x\",\"step_deadline_epoch\":$(( EPOCHSECONDS + 3000 )),\"updated_epoch\":$EPOCHSECONDS}" > $T/state/progress.json
jq '.end_epoch -= 27*3600' $T/state/last-run.json > $T/lr27 && cp $T/state/last-run.json $T/lr.real && mv $T/lr27 $T/state/last-run.json
chk "last run ended 27 h ago, but a catch-up run is in progress" X=1
mv $T/lr.real $T/state/last-run.json
check "in-progress run noted, not alarmed as stale" '[[ $(jq -r ".notes[0]" $T/state/last-check.json) == *"in progress"* ]] && ! jq -r ".problems[]" $T/state/last-check.json | grep -q "limit 26 h"'
print "{\"pid\":$fakepid,\"mode\":\"run\",\"start_epoch\":$(( EPOCHSECONDS - 600 )),\"step\":\"copy to Drive x\",\"step_deadline_epoch\":$(( EPOCHSECONDS - 3600 )),\"updated_epoch\":$EPOCHSECONDS}" > $T/state/progress.json
chk "a run past its step deadline" X=1
check "hung run flagged" '(( CRC != 0 )) && tail -1 $T/alerts.log | grep -q "is hung"'
kill $fakepid 2>/dev/null; print '{"pid":1,"mode":"run","start_epoch":1,"step":"finished","step_deadline_epoch":0,"updated_epoch":1,"finished":true}' > $T/state/progress.json
wait_for "the stand-in nightly process exiting" 'all_gone $fakepid' || bad "the stand-in nightly process ended"
FAKE_RUNNING=( ${FAKE_RUNNING:#$fakepid} )
mk $ARCH/2026-10-28/wl-old.tar.gz 1000; print "drive_path=x" > $ARCH/2026-10-28/wl-old.tar.gz.offsite; touch -t 202610200000 $ARCH/2026-10-28/wl-old.tar.gz
chk "public archive older than 3 days beside a marker" X=1
check "old public archive flagged even with a marker" '(( CRC != 0 )) && tail -1 $T/alerts.log | grep -q "wl-old.tar.gz (has an .offsite marker"'
mv $ARCH/2026-10-28/wl-old.tar.gz $ARCH/2026-10-28/wl-old.tar.gz.offsite $T/src/
print $(( EPOCHSECONDS - 4*86400 )) > $(cdir 2026-10-28/wl-al.tar.gz)/claimed_epoch
chk "claimed archive older than 3 days" X=1
check "old claimed archive flagged by name" '(( CRC != 0 )) && tail -1 $T/alerts.log | grep -q "claimed archive.*wl-al.tar.gz (STUCK"'
mv $T/state/last-run.json $T/last-run.json.bak
chk "no heartbeat at all" X=1
check "missing heartbeat flagged" '(( CRC != 0 )) && tail -1 $T/alerts.log | grep -q "never finished a run"'
mv $T/last-run.json.bak $T/state/last-run.json
chk "Sunday restore test (forced)" AS2_FORCE_VERIFY=1
check "Sunday: verify-restore runs (bounded), checks an archive (wl-seed's receipt) and passes" '[[ $(jq -r .archive $T/state/last-verify.json) == checked && -f $T/state/receipts/2026-10-28/wl-seed.tar.gz/receipt ]] && grep -q "restore OK" $T/state/check-backup-fresh.log && ! jq -r ".problems[]" $T/state/last-check.json | grep -q "restore test failed"'
mv $T/state/last-check.json $T/lc.bak; mkdir $T/state/last-check.json
chk "checker state cannot be written" X=1
check "checker heartbeat write failure is a problem" '(( CRC != 0 )) && tail -1 $T/alerts.log | grep -q "could not write"'
rmdir $T/state/last-check.json; mv $T/lc.bak $T/state/last-check.json

print "\n### the nightly watches the watcher"
jq '.at_epoch = 0' $T/state/last-check.json > $T/lc && mv $T/lc $T/state/last-check.json
night "stale last-check.json" >/dev/null
check "stale watcher reported" 'jq -r ".failures[].step" $T/state/last-run.json | grep -qx watcher'
print 'not json' > $T/state/last-check.json
night "malformed last-check.json" >/dev/null
check "malformed watcher state reported" 'jq -r ".failures[].error" $T/state/last-run.json | grep -q malformed'
rm -f $T/state/last-check.json; print $(( EPOCHSECONDS - 40*3600 )) > $T/state/first-run-epoch
night "watcher never ran, 40 h after the first run" >/dev/null
check "never-started watcher reported" 'jq -r ".failures[].error" $T/state/last-run.json | grep -q "never written last-check.json"'

print "\n### ledger-only period: the Sunday restore test verifies the ledger; no archive receipt is 'not applicable' until the archive-root grace ends"
# Its own state dir, claims dir and archive root, so nothing above leaks in: no archive or envelope receipt exists.
S3=$T/state3; mkdir -p $S3
AS2_LOG=$S3/run.log AS2_ARCHIVE_ROOT=$T/never3 AS2_CLAIMS=$T/claims3 night "ledger-only: no archive root yet, the ledger is backed up" >/dev/null
check "ledger-only night: success, ledger proven, archive root absent-never-seen" '[[ $(jq -r .result $S3/last-run.json) == success && $(jq -r .ledger $S3/last-run.json) == proven && $(jq -r .archive_root $S3/last-run.json) == absent-never-seen ]]'
: > $S3/check-backup-fresh.log
chk "forced Sunday, ledger receipts only, archive root never existed" AS2_LOG=$S3/run.log AS2_ARCHIVE_ROOT=$T/never3 AS2_CLAIMS=$T/claims3 AS2_FORCE_VERIFY=1
check "ledger-only Sunday: the check job's result is ok (problems: $(jq -c .problems $S3/last-check.json)); the ledger was read back and opened; the archive part is a note, not a failure" '(( CRC == 0 )) && [[ $(jq -r .result $S3/last-check.json) == ok && $(jq -r .result $S3/last-verify.json) == success && $(jq -r .archive $S3/last-verify.json) == "not applicable: no archive made yet" && $(jq -r ".failures | length" $S3/last-verify.json) == 0 ]] && jq -r ".notes[]" $S3/last-verify.json | grep -q "has never existed (the ledger-only period)" && grep -q "ledger restore OK" $S3/check-backup-fresh.log && grep -q "quick_check ok" $S3/check-backup-fresh.log'
mkdir -p $T/root3; print $(( EPOCHSECONDS - 2*86400 )) > $S3/archive-root-seen
AS2_LOG=$S3/run.log AS2_ARCHIVE_ROOT=$T/root3 AS2_CLAIMS=$T/claims3 zsh "$HERE/backup-nightly.zsh" --verify-restore 2>&1 | sed -E "s#$T#\$T#g" | grep -E 'archive|restore OK|FAILED'; rc=${pipestatus[1]}
check "root first seen 2 days ago, no receipt: still 'not applicable' (inside the 7-day grace), exit 0" '(( rc == 0 )) && [[ $(jq -r .archive $S3/last-verify.json) == "not applicable: no archive made yet" ]] && jq -r ".notes[]" $S3/last-verify.json | grep -q "first seen 2 day(s) ago"'
print $(( EPOCHSECONDS - 8*86400 )) > $S3/archive-root-seen
: > $S3/check-backup-fresh.log
chk "forced Sunday, root first seen 8 days ago, still no archive receipt" AS2_LOG=$S3/run.log AS2_ARCHIVE_ROOT=$T/root3 AS2_CLAIMS=$T/claims3 AS2_FORCE_VERIFY=1
check "8 days after the root first existed, no receipt is the verify-archive failure; the ledger is still verified" '(( CRC != 0 )) && [[ $(jq -r .result $S3/last-verify.json) == failure && $(jq -r ".failures[0].step" $S3/last-verify.json) == verify-archive ]] && jq -r ".failures[0].error" $S3/last-verify.json | grep -q "first seen 8 day(s) ago, past the 7-day grace" && jq -r ".problems[]" $S3/last-check.json | grep -q "weekly restore test failed" && grep -q "ledger restore OK" $S3/check-backup-fresh.log'

suite_end
