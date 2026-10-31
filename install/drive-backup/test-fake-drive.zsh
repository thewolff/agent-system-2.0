#!/bin/zsh
# Fake-Drive suite, core part: the real server-read gate's fixtures, a dry run, seven nights of one batch of archives
# (claim, upload, prove, re-prove, STUCK, recovery, delete), a restore by plain copy and --verify-restore.
# The fake Drive, fake DriveFS metadata DB, fake server read and stub alerts are set up by fake-drive-fixture.zsh
# (its header says what is faked and how time is driven); the other parts are test-fake-drive-*.zsh.
#   zsh test-fake-drive.zsh        prints PASS/FAIL lines, ends with "RESULT: <n> failure(s)", exits n
emulate -L zsh
setopt no_unset pipe_fail extended_glob
HERE=${0:A:h}
source $HERE/fake-drive-fixture.zsh || { print -u2 "cannot source $HERE/fake-drive-fixture.zsh"; exit 99 }
trap cleanup EXIT

print "\n### the real server-read gate (server-read.zsh) against modelled macOS observations"
mkdir -p $T/server-read-fixtures
srout=$(zsh "$HERE/test-server-read.zsh" "$HERE/server-read.zsh" $T/server-read-fixtures 2>&1); src=$?
print -r -- "$srout" | sed -E "s#$T#\$T#g"
for l in ${(f)srout}; do case $l in PASS:*) ok "server-read: ${l#PASS: }";; FAIL:*) bad "server-read: ${l#FAIL: }";; esac; done
check "server-read fixtures: exit 0" '(( src == 0 ))'

mkdir -p $ARCH/2026-10-20 $ARCH/2026-10-27 $ARCH/2026-10-28
mk $ARCH/2026-10-27/wl-aaa.tar.gz 300000
mk $ARCH/2026-10-28/wl-bbb.tar.gz 200000
mk $ARCH/2026-10-28/wl-bbb.2.tar.gz 100000
print junk > $ARCH/2026-10-28/wl-ccc.tar.gz.partial-0123456789ab      # in-progress tar: never touched
mk $T/src/linked.tar.gz 1000; ln $T/src/linked.tar.gz $ARCH/2026-10-28/wl-lnk.tar.gz   # nlink 2: producer mid-link
print "drive_path=old" > $ARCH/2026-10-20/wl-old.tar.gz.offsite         # an old marker, archive long gone
for f in $ARCH/*/*.tar.gz; do shasum -a 256 $f; done > $T/orig.sha

before=$(snapshot)
night "dry run" --dry-run
check "dry run: exit 0, no file changed, no last-run.json" '[[ $RC == 0 && $(snapshot) == $before && ! -e $T/state/last-run.json ]]'

print 'wl-bbb.????????????????.*.tar.gz' > $T/uploader.bad   # <id>.<sha16>.<stamp>.tar.gz; not wl-bbb.2.*
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=4 = 4 proof passes of 1 fake second (fake clock: AS2_CLOCK_CMD)
# Night 1's popup stays open (alert-holds.zsh) until the test answers it below.
AS2_ALERT_CMD=$T/alert-holds.zsh AS2_PROOF_TIMEOUT=4 night "night 1: claims; wl-bbb never proves (real md5 only in an unrelated proto field)"
check "night 1 exits nonzero" '(( RC != 0 ))'
check "three quiet nlink-1 archives claimed out of the public dir; .attempts holds each name" '[[ ! -e $ARCH/2026-10-27/wl-aaa.tar.gz && ! -e $ARCH/2026-10-28/wl-bbb.tar.gz && ! -e $ARCH/2026-10-28/wl-bbb.2.tar.gz && -f $(cdir 2026-10-27/wl-aaa.tar.gz)/wl-aaa.tar.gz && -f $ARCH/2026-10-27/wl-aaa.tar.gz.attempts && -f $ARCH/2026-10-28/wl-bbb.tar.gz.attempts ]]'
check "nlink-2 archive and .partial left alone" '[[ -f $ARCH/2026-10-28/wl-lnk.tar.gz && -f $ARCH/2026-10-28/wl-ccc.tar.gz.partial-0123456789ab ]]'
check "nothing deleted on the night of the first proof; receipts for aaa and bbb.2" '[[ $(hb .counts.offsite_and_deleted) == 0 && $(hb .counts.proven) == 2 && -f $(cdir 2026-10-27/wl-aaa.tar.gz)/receipt && -f $(cdir 2026-10-28/wl-bbb.2.tar.gz)/receipt && ! -f $(cdir 2026-10-28/wl-bbb.tar.gz)/receipt ]]'
check "receipt binds item id and revision" 'grep -q "^drive_item_id=cloud" $(cdir 2026-10-27/wl-aaa.tar.gz)/receipt && grep -q "^drive_revision=0Bfakerev" $(cdir 2026-10-27/wl-aaa.tar.gz)/receipt'
check "wl-bbb: 1 failure at step prove, count 1, its copy was rejected (md5 only in the title field)" '[[ $(hb .counts.failed) == 1 && $(hb ".failures[0].step") == prove && $(hb ".failures[0].path") == *wl-bbb.tar.gz && $(head -1 $(cdir 2026-10-28/wl-bbb.tar.gz)/attempts) == 1 ]] && grep -q "cloud md5 0000" $T/state/run.log'
check "Drive names are unique and keep .tar.gz (<id>.<sha16>.<stamp>.tar.gz), stored unchanged" '[[ -n ${(M)${(f)"$(snapshot)"}:#*/wl-aaa.[0-9a-f](#c16).[0-9](#c8)T[0-9](#c6).tar.gz} ]] && cmp -s $(cdir 2026-10-27/wl-aaa.tar.gz)/wl-aaa.tar.gz "$(grep "^drive_path=" $(cdir 2026-10-27/wl-aaa.tar.gz)/receipt | cut -d= -f2-)"'
check "one alert, sent and awaiting the popup result; notification sent too" '[[ $(alerts) == 1 && $(hb .alert) == sent* && $(hb .alert) == *"notification rc 0"* && -n $(hb .alert_result) ]] && grep -q NOTIFICATION $T/fallback.log'
check "ledger: proven, unique object under ledger/<date>/" '[[ $(hb .ledger) == proven && $(wc -l < $T/state/ledger-snapshots.tsv | tr -d " ") == 1 ]] && grep -qE "ledger/[0-9-]+/ledger-[0-9T]+-[0-9a-f]{16}.db.gz	" $T/state/ledger-snapshots.tsv'
: > $T/alert-holds.release      # Jo answers the popup
wait_for "the answered popup's result file" '[[ -f $(hb .alert_result) ]]' || bad "night 1's popup result was written"
check "the popup's result arrives (rc=0: it was shown)" '[[ $(head -1 $(hb .alert_result)) == rc=0 ]]'
sums1=$(drive_sums)
bbbdst=$(kvf $(cdir 2026-10-28/wl-bbb.tar.gz)/upload drive_path)
bbb_copies() { print -rl -- "$DRIVE"/as2-backup/scratch-archive/2026-10-28/wl-bbb.[0-9a-f](#c16).*.tar.gz(N) | grep -c . }   # not wl-bbb.2.*
check "wl-bbb keeps its upload record, which names its one Drive copy" '[[ -n $bbbdst && -f $bbbdst && $(bbb_copies) == 1 ]]'

# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=4 (fake clock: AS2_CLOCK_CMD)
AS2_PROOF_TIMEOUT=4 night "night 2: deleting re-proof for aaa and bbb.2; bbb re-proves its old copy and fails again"
check "aaa and bbb.2 deleted after re-proof + server read-back; .offsite at the original path; .attempts gone" '[[ $(hb .counts.offsite_and_deleted) == 2 && ! -e $(cdir 2026-10-27/wl-aaa.tar.gz) && -f $ARCH/2026-10-27/wl-aaa.tar.gz.offsite && ! -e $ARCH/2026-10-27/wl-aaa.tar.gz.attempts && -f $T/state/receipts/2026-10-27/wl-aaa.tar.gz/receipt ]]'
check "the Drive copy was read through the server-read gate" 'grep -q "EVICT .*/wl-aaa\.[0-9a-f]*\..*\.tar\.gz" $T/evict.log && grep -q "read back from Google.s servers (proven server read)" $T/state/run.log'
check "marker records item id, revision, sha256 and both proofs" 'grep -q "^drive_revision=0Bfakerev" $ARCH/2026-10-27/wl-aaa.tar.gz.offsite && grep -q "^reproven_at=" $ARCH/2026-10-27/wl-aaa.tar.gz.offsite && grep -q "^sha256=[0-9a-f]\{64\}$" $ARCH/2026-10-27/wl-aaa.tar.gz.offsite'
check "bbb re-proved its earlier copy (no new upload), count 2" '[[ $(hb .counts.uploaded) == 0 && $(head -1 $(cdir 2026-10-28/wl-bbb.tar.gz)/attempts) == 2 ]] && grep -q "re-proving the earlier upload" $T/state/run.log'
check "night 2 wrote a second ledger object; the first one is unchanged" '[[ $(wc -l < $T/state/ledger-snapshots.tsv | tr -d " ") == 2 ]] && print -r -- "$sums1" | (cd "$DRIVE" && shasum -a 256 -c - >/dev/null)'

# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=4 (fake clock: AS2_CLOCK_CMD)
AS2_PROOF_TIMEOUT=4 night "night 3: bbb re-proves the same copy again (no new upload), still fails, reaches the limit"
check "after night 3: stuck in claims and at the original path, count 3, still the one upload record and no new copy" '[[ -f $(cdir 2026-10-28/wl-bbb.tar.gz)/stuck && -f $ARCH/2026-10-28/wl-bbb.tar.gz.stuck && $(head -1 $(cdir 2026-10-28/wl-bbb.tar.gz)/attempts) == 3 && $(hb .counts.uploaded) == 0 && $(kvf $(cdir 2026-10-28/wl-bbb.tar.gz)/upload drive_path) == $bbbdst && $(bbb_copies) == 1 ]]'
check "night 3 alert names wl-bbb as STUCK; heartbeat newly_stuck lists it" 'tail -1 $T/alerts.log | grep -q "STUCK.*wl-bbb.tar.gz" && [[ $(hb ".newly_stuck[0]") == *wl-bbb.tar.gz* ]]'
check "the STUCK alert and claims/.../stuck name the Drive path and the person step before a fresh upload" 'tail -1 $T/alerts.log | grep -qF "a person confirms there is no Drive copy at $bbbdst" && grep -qF "before deleting $(cdir 2026-10-28/wl-bbb.tar.gz)/upload" $(cdir 2026-10-28/wl-bbb.tar.gz)/stuck'
n_alerts=$(alerts)
night "night 4: stuck archive is skipped, not retried"
check "night 4: exit 0, skipped_stuck 1, no upload, no new alert" '[[ $RC == 0 && $(hb .counts.skipped_stuck) == 1 && $(hb .counts.uploaded) == 0 && $(alerts) == $n_alerts ]]'

: > $T/uploader.bad; rm -f $(cdir 2026-10-28/wl-bbb.tar.gz)/stuck
night "night 5: a person cleared claims/.../stuck and the cause (Drive recorded the copy); bbb re-proves the same copy and proves it"
check "night 5: the same Drive copy is proven (no new upload); its receipt names it" '[[ $(hb .counts.uploaded) == 0 && $(kvf $(cdir 2026-10-28/wl-bbb.tar.gz)/receipt drive_path) == $bbbdst && ! -e $(cdir 2026-10-28/wl-bbb.tar.gz)/upload ]]'
night "night 6: bbb deleted after re-proof"
check "bbb deleted, .offsite written, .stuck and .attempts gone" '[[ $RC == 0 && ! -e $(cdir 2026-10-28/wl-bbb.tar.gz) && -f $ARCH/2026-10-28/wl-bbb.tar.gz.offsite && ! -e $ARCH/2026-10-28/wl-bbb.tar.gz.stuck && ! -e $ARCH/2026-10-28/wl-bbb.tar.gz.attempts ]]'
check ".partial, nlink-2 archive and the old marker untouched" '[[ -f $ARCH/2026-10-28/wl-ccc.tar.gz.partial-0123456789ab && -f $ARCH/2026-10-28/wl-lnk.tar.gz && $(<$ARCH/2026-10-20/wl-old.tar.gz.offsite) == drive_path=old ]]'
check "no Drive object was ever overwritten or deleted" 'print -r -- "$sums1" | (cd "$DRIVE" && shasum -a 256 -c - >/dev/null)'

print "\n### restore by plain copy (README): archive and ledger"
mkdir $T/restored
aobj=$(grep '^drive_path=' $ARCH/2026-10-27/wl-aaa.tar.gz.offsite | cut -d= -f2-)
cp -n "$aobj" $T/restored/wl-aaa.tar.gz
want=$(awk '/wl-aaa/{print $1}' $T/orig.sha); got=$(shasum -a 256 $T/restored/wl-aaa.tar.gz | awk '{print $1}')
check "copied-back archive sha256 equals the original and the marker" '[[ $want == $got ]] && grep -qx "sha256=$got" $ARCH/2026-10-27/wl-aaa.tar.gz.offsite && tar -tzf $T/restored/wl-aaa.tar.gz >/dev/null'
lobj=$(tail -1 $T/state/ledger-snapshots.tsv | cut -f2)
cp -n "$lobj" $T/restored/l.db.gz && gunzip $T/restored/l.db.gz
check "copied-back ledger has the 3 rows" '[[ $($SQL $T/restored/l.db "select group_concat(body) from events") == one,two,three ]]'

print "\n### --verify-restore"
zsh "$HERE/backup-nightly.zsh" --verify-restore 2>&1 | sed -E "s#$T#\$T#g" | grep -E 'archive:|restore OK|quick_check|FAILED'; rc=${pipestatus[1]}
check "verify-restore passes" '(( rc == 0 )) && [[ $(jq -r .result $T/state/last-verify.json) == success ]]'
newest=( $T/state/receipts/*/*/receipt(N.om) $T/no-receipt-found ); cp $newest[1] $T/receipt.bak 2>/dev/null
sed -i '' 's/^sha256=.*/sha256=0000000000000000000000000000000000000000000000000000000000000000/' $newest[1]
zsh "$HERE/backup-nightly.zsh" --verify-restore 2>&1 | sed -E "s#$T#\$T#g" | grep -E 'FAILED|ALERT'; rc=${pipestatus[1]}
check "verify-restore fails and alerts when the recorded hash does not match" '(( rc != 0 )) && tail -1 $T/alerts.log | grep -q "restore test"'
cp $T/receipt.bak $newest[1]

suite_end
