#!/bin/zsh
# Fake-Drive suite, adversarial proofs part: the deleting night refuses on a changed revision, a trashed item, an
# unknown proto field, a changed read-back, a refused server read (and its STUCK and 9 AM report), a content-cache
# schema pin change, a reused original path; the claim window; a blocked read-back bounded by its deadline while the
# other archives carry on. Setup: fake-drive-fixture.zsh.
#   zsh test-fake-drive-proofs.zsh        prints PASS/FAIL lines, ends with "RESULT: <n> failure(s)", exits n
emulate -L zsh
setopt no_unset pipe_fail extended_glob
HERE=${0:A:h}
source $HERE/fake-drive-fixture.zsh || { print -u2 "cannot source $HERE/fake-drive-fixture.zsh"; exit 99 }
trap cleanup EXIT

item_sid() { $SQL "$FDB" "select stable_id from items where id='$(grep '^drive_item_id=' $1 | cut -d= -f2)'" }

print "\n### revision changed on Drive after the receipt: no delete"
fresh 2026-10-28/wl-rev.tar.gz 40000
check "wl-rev has a receipt" '[[ -f $(rcpt_of 2026-10-28/wl-rev.tar.gz) ]]'
AS2_REPROVE_AFTER=999999 night "a night inside the 20 h window" >/dev/null
check "a run before the 20 h re-proof window deletes nothing" '[[ -f $(cdir 2026-10-28/wl-rev.tar.gz)/wl-rev.tar.gz && $(hb .counts.waiting_reproof) -ge 1 && $(hb .counts.offsite_and_deleted) == 0 ]]'
upmode off
sid=$(item_sid $(rcpt_of 2026-10-28/wl-rev.tar.gz))
$SQL "$FDB" "update items set proto=cast(replace(cast(proto as text),'0Bfakerev','0Bchanged') as blob) where stable_id=$sid" 2>/dev/null \
  || $SQL "$FDB" "update items set proto=x'$(fproto cloud$sid x x 1 00000000000000000000000000000000 0Bchangedrevision)' where stable_id=$sid"
night "revision changed"
check "changed revision: nonzero, archive kept, step confirm" '(( RC != 0 )) && [[ -f $(cdir 2026-10-28/wl-rev.tar.gz)/wl-rev.tar.gz && $(hb ".failures[0].step") == confirm ]]'

print "\n### item trashed on Drive after the receipt: no delete"
upmode good
fresh 2026-10-28/wl-tr.tar.gz 40000
upmode off
sid=$(item_sid $(rcpt_of 2026-10-28/wl-tr.tar.gz))
$SQL "$FDB" "update items set trashed=1, is_tombstone=1 where stable_id=$sid"
night "item trashed"
check "trashed item: archive kept, failure names it" '(( RC != 0 )) && [[ -f $(cdir 2026-10-28/wl-tr.tar.gz)/wl-tr.tar.gz ]] && jq -r ".failures[].path" $T/state/last-run.json | grep -q wl-tr.tar.gz'

print "\n### unknown proto field on the item: no delete"
$SQL "$FDB" "update items set trashed=0, is_tombstone=0, proto=proto||x'$(pbv 999 1)' where stable_id=$sid"
night "unknown proto field"
check "unknown field 999: archive kept, reason says layout not verified" '[[ -f $(cdir 2026-10-28/wl-tr.tar.gz)/wl-tr.tar.gz ]] && grep -q "unknown proto field 999/0" $T/state/run.log'

print "\n### Drive copy changed after the receipt (read-back differs, metadata unchanged): no delete"
upmode good
fresh 2026-10-28/wl-rb.tar.gz 40000
upmode off
rbobj=$(grep '^drive_path=' $(rcpt_of 2026-10-28/wl-rb.tar.gz) | cut -d= -f2-)
cp "$rbobj" $T/rb.bak; print -n X >> "$rbobj"; touch -r $T/rb.bak "$rbobj"
night "read-back differs"
check "read-back mismatch: archive kept, step confirm" '[[ -f $(cdir 2026-10-28/wl-rb.tar.gz)/wl-rb.tar.gz ]] && grep -q "reads back from the server as sha256" $T/state/run.log'
cp $T/rb.bak "$rbobj"

print "\n### no proven server read: the read-back could come from this Mac, so no delete"
print fail > $T/evict.mode
night "server read refused"
check "server read refused: wl-rb kept, no marker, reason given" '(( RC != 0 )) && [[ -f $(cdir 2026-10-28/wl-rb.tar.gz)/wl-rb.tar.gz && ! -e $ARCH/2026-10-28/wl-rb.tar.gz.offsite ]] && grep -q "no proven server read" $T/state/run.log'
print "\n### the server-read gate keeps failing closed: archives pile up and both jobs say so"
cp $(cdir 2026-10-28/wl-rb.tar.gz)/claimed_epoch $T/rb.ce; print $(( EPOCHSECONDS - 4*86400 )) > $(cdir 2026-10-28/wl-rb.tar.gz)/claimed_epoch
out=$(zsh "$HERE/check-backup-fresh.zsh" 2>&1)
check "9 AM check alerts on the proven archive still on disk after 3 days" '[[ $out == *"wl-rb.tar.gz (proven, deletion re-proof keeps failing"* ]] && tail -1 $T/alerts.log | grep -q "wl-rb.tar.gz (proven, deletion re-proof keeps failing"'
cp $T/rb.ce $(cdir 2026-10-28/wl-rb.tar.gz)/claimed_epoch
night "server read refused again (third failed night for wl-rb)"
check "third refused night: wl-rb STUCK, the alert names it" '[[ -f $(cdir 2026-10-28/wl-rb.tar.gz)/stuck && -f $ARCH/2026-10-28/wl-rb.tar.gz.stuck ]] && tail -1 $T/alerts.log | grep -q "STUCK.*wl-rb.tar.gz"'
rm -f $(cdir 2026-10-28/wl-rb.tar.gz)/stuck
print "\n### the content cache schema pin no longer matches (a Drive for desktop update): no delete, both jobs name it"
print schema > $T/evict.mode
night "server read refused: chunks.db schema pin changed"
check "schema pin refusal: wl-rb kept, no marker" '(( RC != 0 )) && [[ -f $(cdir 2026-10-28/wl-rb.tar.gz)/wl-rb.tar.gz && ! -e $ARCH/2026-10-28/wl-rb.tar.gz.offsite ]]'
check "the nightly alert names the schema pin change first" 'tail -1 $T/alerts.log | grep -q "title=as2 Drive backup: schema pin changed, .* popup=Schema pin changed (confirm): .*DriveFS content cache schema pin changed"'
out=$(zsh "$HERE/check-backup-fresh.zsh" 2>&1)
check "the 9 AM check alert names the schema pin change" '[[ $out == *"schema pin changed: Drive for desktop'"'"'s format no longer matches"* ]] && tail -1 $T/alerts.log | grep -q "schema pin changed: Drive for desktop"'
print ok > $T/evict.mode

print "\n### the original path holds a new file when the deletion would happen: no marker, no delete"
upmode good
fresh 2026-10-28/wl-reuse.tar.gz 40000
rm -f $ARCH/2026-10-28/wl-reuse.tar.gz.attempts; mk $ARCH/2026-10-28/wl-reuse.tar.gz 500; touch -t 202601010000 $ARCH/2026-10-28/wl-reuse.tar.gz
AS2_CLAIM_QUIET=999999999 night "name reused at the origin"
check "reused origin: claimed archive kept, no .offsite beside the newcomer" '[[ -f $(cdir 2026-10-28/wl-reuse.tar.gz)/wl-reuse.tar.gz && ! -e $ARCH/2026-10-28/wl-reuse.tar.gz.offsite ]] && grep -q "exists again" $T/state/run.log'
mv $ARCH/2026-10-28/wl-reuse.tar.gz $T/src/reuse-newcomer.tar.gz

print "\n### claim window: an archive changed within AS2_CLAIM_QUIET is not claimed"
mk $ARCH/2026-10-28/wl-new.tar.gz 1000
AS2_CLAIM_QUIET=3600 AS2_REPROVE_AFTER=999999 night "fresh archive" >/dev/null
check "fresh archive left in the public dir" '[[ -f $ARCH/2026-10-28/wl-new.tar.gz && ! -e $(cdir 2026-10-28/wl-new.tar.gz) ]]'

print "\n### a blocking operation is bounded and the other archives continue"
fresh 2026-10-28/wl-hang.tar.gz 30000
fresh 2026-10-28/wl-ok.tar.gz 30000
hobj=$(grep '^drive_path=' $(rcpt_of 2026-10-28/wl-hang.tar.gz) | cut -d= -f2-)
mv "$hobj" $T/hang.bak; mkfifo "$hobj"       # reading it back blocks until its deadline kills the reader
# timing-under-test: bounded() deadlines on a blocked read, the re-proof's xattr (T_SHORT, 60 s) and the server read
# (AS2_T_SERVER_READ=3) (fake clock: AS2_CLOCK_CMD)
# The night runs in the background. Opening the FIFO for reading blocks until a writer comes, and none does, so each
# reader stays blocked until its deadline. The test waits for each real event, a live process of that read naming the
# FIFO (it exists only after bounded() has read its start time), then moves the fake clock past that deadline:
# 61 s for the xattr read of the item id (optional, so the re-proof goes on without it), then 4 s for the server read.
# No wall time is measured. If a guard trips, the clock jumps far ahead so any bounded wait still running ends.
running() { # <name> <text>: a live process matching <name> whose command line contains <text>
  local l; for l in ${(f)"$(/usr/bin/pgrep -lf "$1" 2>/dev/null)"}; do [[ $l == *"$2"* ]] && return 0; done; return 1
}
rm -f $T/hang-night.rc
{ trap - EXIT; AS2_T_LONG=3 AS2_T_SERVER_READ=3 AS2_CLAIM_QUIET=999999999 night "read-back of wl-hang blocks"; print -r -- $RC > $T/hang-night.rc } &
FAKE_RUNNING+=( $! ); hang_night=$!
wait_for "the re-proof's xattr read blocked on the wl-hang FIFO" 'running xattr "$hobj"' 120 \
  || bad "the re-proof's xattr read of wl-hang reached its blocked open"
clock_add 61
wait_for "the server read blocked on the wl-hang FIFO" 'running shasum "$hobj"' 120 \
  || bad "the server read of wl-hang reached its blocked open"
clock_add 4
if ! wait_for "the night with the blocked read-back finishing" '[[ -s $T/hang-night.rc ]]' 120; then
  bad "the night with the blocked read-back finished once the fake clock passed the deadlines"
  clock_add 100000
  wait_for "the night finishing after the clock jumped" '[[ -s $T/hang-night.rc ]]' 60
fi
wait $hang_night 2>/dev/null; FAKE_RUNNING=( ${FAKE_RUNNING:#$hang_night} )
check "both blocked readers' process groups were killed: the FIFO has no reader left" '! sysopen -w -o nonblock -u HANGX "$hobj" 2>/dev/null'
[[ -n ${HANGX:-} ]] && exec {HANGX}>&-
RC=$(<$T/hang-night.rc 2>/dev/null); RC=${RC:-unknown}
check "blocked read-back timed out (step confirm), wl-hang kept, wl-new and wl-ok handled, run finished" '[[ $RC == <-> ]] && (( RC != 0 )) && [[ -f $(cdir 2026-10-28/wl-hang.tar.gz)/wl-hang.tar.gz && ! -e $(cdir 2026-10-28/wl-ok.tar.gz) && -f $ARCH/2026-10-28/wl-ok.tar.gz.offsite ]] && grep -q "TIMEOUT: server read" $T/state/run.log'
rm -f "$hobj"; mv $T/hang.bak "$hobj"
check "progress.json ends as finished" '[[ $(jq -r .finished $T/state/progress.json) == true ]]'

suite_end
