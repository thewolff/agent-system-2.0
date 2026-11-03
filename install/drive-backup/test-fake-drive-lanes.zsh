#!/bin/zsh
# Fake-Drive suite, closed lane folders (PLAN wl-mw14khl4uf388q "The nightly", slice sl-lb-nightly; R5, R6, R10, R13):
# the real backup-nightly.zsh runs surface/scripts/lane-archive.ts (produce before the claim phase, retire after the
# receipts phase) with $AS2_BUN on a real temp ledger whose four workloads closed three days ago, and the fake Drive.
#   - produce -> claim -> one lane alone (large) and one in an envelope (small) -> prove; nothing deleted
#   - AS2_KEEP_LOCAL=1 purges nothing: a K1 night with every receipt in place keeps every folder, archive and claim
#   - the 20 h gate: a K0 night before AS2_REPROVE_AFTER confirms nothing; "fake 20 h" is AS2_REPROVE_AFTER=0 (an
#     injected setting, never a wait), and that night confirms with AS2_BUN unset (`lanes: skipped: AS2_BUN unset`)
#   - a 0 -> 1 switch between confirm and retire purges nothing: the next night at K1 holds every proven lane
#   - --dry-run lists what produce would tar and retire would remove, and changes nothing
#   - AS2_LANE_ONLY passes through: a K0 night retires that one lane alone; the next K0 night retires the rest
#   - nothing on Drive is deleted or overwritten; every failure line would be in last-run.json (none here)
#   - `bin/as2 lane restore <wl>` (this checkout) puts the single and the envelope lane back in place, byte-identical
#     to a copy taken before any night (diff -r) with the same modes and link targets
# Needs AS2_BUN (surface/test/drive-backup.test.ts passes the bun running it; fake-drive-fixture.zsh keeps it as
# FIXTURE_BUN). Setup: fake-drive-fixture.zsh; the DriveFS DB is reached through <T>/DriveFS/<account digits>/, the
# layout the producer's quota reader pins (lane-archive.ts readDriveQuota), with a driveway_account record.
#   zsh test-fake-drive-lanes.zsh        prints PASS/FAIL lines, ends with "RESULT: <n> failure(s)", exits n
emulate -L zsh
setopt no_unset pipe_fail extended_glob
HERE=${0:A:h}
source $HERE/fake-drive-fixture.zsh || { print -u2 "cannot source $HERE/fake-drive-fixture.zsh"; exit 99 }
trap cleanup EXIT
if [[ -z $FIXTURE_BUN || ! -x $FIXTURE_BUN ]]; then
  bad "AS2_BUN is not an executable bun ('$FIXTURE_BUN'); surface/test/drive-backup.test.ts passes it, a hand run sets it"
  suite_end
fi
REPO=$FIXTURE_REPO
export AS2_BUN=$FIXTURE_BUN AS2_REPO=$REPO
export AS2_ENVELOPE_FLOOR=20000   # the 60 KB lanes go alone, the small one into an envelope
LANES=$HOME/.agent-system-2/lanes LSTATE=$T/state/lane-archives
mkdir -p $LANES $T/pre-delete

print "\n### setup: the DriveFS account dir, its quota record, a real ledger with four workloads closed 3 days ago"
ACCOUNT=104857600000000000001
mkdir -p $T/DriveFS && ln -s $T $T/DriveFS/$ACCOUNT || bad "cannot make the DriveFS account dir"
export AS2_DRIVEFS_DB=$T/DriveFS/$ACCOUNT/metadata_sqlite_db
pbm() { print -rn -- "$(pv $(( ($1 << 3) | 2 )))$(pv $(( ${#2} / 2 )))$2" }   # <field> <hex of an embedded message>
TOTAL=2203318222848 USED=353493959565
quota=$(pbv 1 $TOTAL)$(pbv 3 $USED)$(pbv 6 1)$(pbv 8 $(( TOTAL - USED )))
blob=$(pbv 1 1)$(pbm 2 "$(pbm 1 "$(pbs 3 'Test User')$(pbs 11 $ACCOUNT)")$(pbm 3 "$(pbm 1 $quota)")")$(pbv 13 1)
$SQL "$FDB" "insert into properties values('driveway_account', x'$blob')" || bad "cannot write the driveway_account record"
AS2L=$T/as2/ledger.db; mkdir -p ${AS2L:h}
WLS=( ${(f)"$($FIXTURE_BUN -e "
import { Ledger } from '$REPO/ledger/src/index.ts';
import { SURFACE_BY } from '$REPO/surface/src/types.ts';
const at = new Date(Date.now() - 3 * 86400000).toISOString();
const l = Ledger.open('$AS2L', { create: true, backup: false, backupOnOpen: false, clock: () => at });
try {
  for (let i = 0; i < 4; i++) {
    const wl = l.openWorkload({ by: SURFACE_BY, brief: 'lane round trip ' + i, stakes: 'normal', mode: 'autonomous' });
    l.closeWorkload(wl, { by: SURFACE_BY });
    console.log(wl);
  }
} finally { l.close(); }
" 2>&1)"} )
check "the ledger holds four closed workloads" '(( ${#WLS} == 4 )) && [[ ${WLS[1]} == wl-* && ${WLS[4]} == wl-* ]]'
(( ${#WLS} == 4 )) || { print -rl -- "ledger setup said:" $WLS; suite_end }
export AS2_LEDGER_DB=$AS2L
LA=${WLS[1]} LB=${WLS[2]} LC=${WLS[3]} LD=${WLS[4]}

# mklane <wl> <pad bytes>: a lane folder with nested dirs, modes, a read-only file, an executable and a symlink, every
# mtime two hours back (the producer's quiet hour), and its pre-delete copy (cp -Rp keeps modes, times and links).
QUIET=$(strftime '%Y%m%d%H%M.%S' $(( EPOCHSECONDS - 7200 )))
mklane() {
  local d=$LANES/$1
  mkdir -p $d/sessions/sub
  print -r -- "runner log $1" > $d/runner.log
  print -r -- "{\"n\":1,\"wl\":\"$1\"}" > $d/sessions/s1.jsonl
  print -r -- '{"deep":1}' > $d/sessions/sub/deep.json; chmod 640 $d/sessions/sub/deep.json
  print -r -- "read only" > $d/frozen.txt; chmod 444 $d/frozen.txt
  print -r -- '#!/bin/sh' > $d/hook.sh; chmod 755 $d/hook.sh
  ln -s sessions/s1.jsonl $d/latest
  (( $2 )) && head -c $2 /dev/urandom > $d/pad.bin
  /usr/bin/find $d -exec /usr/bin/touch -h -t $QUIET {} +
  /bin/cp -Rp $d $T/pre-delete/$1
}
# same_as_copy <wl>: the folder in place equals its pre-delete copy: diff -r, and every entry's mode and link target
modes() { (cd $1 && /usr/bin/find . -exec /usr/bin/stat -f '%N %Sp %Y' {} + | sort) }
same_as_copy() { [[ -d $LANES/$1 ]] && /usr/bin/diff -r $LANES/$1 $T/pre-delete/$1 >/dev/null && [[ $(modes $LANES/$1) == $(modes $T/pre-delete/$1) ]] }
intact() { local w; for w; do same_as_copy $w || return 1; [[ ! -e $LANES/$w.offsite ]] || return 1; done }
rec() { jq -r ".$2" $LSTATE/$1.json }          # <wl> <key>: a field of the lane's live record
marker() { jq -r ".$2" $LANES/$1.offsite }     # <wl> <key>: a field of the lane marker
lanes_line() { print "    lanes: $(hb .lanes)"; jq -r '.failures[] | "    failure [\(.step)] \(.path): \(.error)"' $T/state/last-run.json }
clean() { [[ $RC == 0 && $(hb .counts.failed) == 0 && $(hb .result) == success ]] }
mklane $LA 60000; mklane $LB 0; mklane $LC 60000

print "\n### night 1, AS2_KEEP_LOCAL=1: produce, claim, one lane alone and one in an envelope, prove"
export AS2_KEEP_LOCAL=1
night "night 1 (K1)"; lanes_line
check "night 1: clean; produce tarred the three closed lanes; retire held them (no offsite proof yet)" \
  'clean && [[ $(hb .counts.lanes_tarred) == 3 && $(hb .counts.lanes_held) == 3 && $(hb .counts.lanes_retired) == 0 && $(hb .lanes) == "produce: tarred=3 recovered=0 skipped=0 failed=0 eligible=3; retire: retired=0 held=3 requeued=0 finished=0 failed=0" ]]'
AA=$(rec $LA archive) AB=$(rec $LB archive) AC=$(rec $LC archive)
day=${AA:h:t}
check "night 1: records pending, tars named <archive root>/<UTC date>/<wl>.lane.tar.gz" \
  '[[ $(rec $LA state) == pending && $(rec $LB state) == pending && $AA == $ARCH/$day/$LA.lane.tar.gz && $AB == $ARCH/$day/$LB.lane.tar.gz && $AC == $ARCH/$day/$LC.lane.tar.gz ]]'
CA=$(cdir $day/${AA:t}) CB=$(cdir $day/${AB:t}) CC2=$(cdir $day/${AC:t})
E=$(ed_of $day/${AB:t})
check "night 1: the large lanes uploaded alone and proven, the small one in a proven envelope; the claimed tars are the records' (sha256)" \
  '[[ -f $CA/receipt && ! -f $CA/envelope && -f $CC2/receipt && -n $E && -f $E/receipt && $(kvf $CA/receipt sha256) == $(rec $LA sha256) && $(shasum -a 256 $CB/${AB:t} | cut -d" " -f1) == $(rec $LB sha256) ]]'
check "night 1: every lane folder in place, unchanged, no marker" 'intact $LA $LB $LC'
DRIVE0=$(drive_sums)

print "\n### night 2, AS2_KEEP_LOCAL=1 with every receipt in place: nothing is purged"
night "night 2 (K1, re-proof due)"; lanes_line
check "night 2 (K1): clean; proven and kept, nothing deleted, no lane retired" \
  'clean && (( $(hb .counts.kept_local) >= 2 )) && [[ $(hb .counts.offsite_and_deleted) == 0 && $(hb .counts.lanes_retired) == 0 && $(hb .counts.lanes_tarred) == 0 ]]'
check "night 2 (K1): claimed tars and lane folders all kept, no .offsite, no marker" \
  'intact $LA $LB $LC && [[ -f $CA/${AA:t} && -f $CB/${AB:t} && -f $CC2/${AC:t} && ! -e $AA.offsite && ! -e $AB.offsite && ! -e $AC.offsite ]]'

print "\n### night 3, AS2_KEEP_LOCAL=0 before the 20 h re-proof: nothing confirmed, nothing retired"
export AS2_KEEP_LOCAL=0
AS2_REPROVE_AFTER=72000 night "night 3 (K0, 20 h not yet passed)"; lanes_line
check "night 3: clean; waiting re-proof, nothing deleted or retired" \
  'clean && (( $(hb .counts.waiting_reproof) >= 2 )) && [[ $(hb .counts.offsite_and_deleted) == 0 && $(hb .counts.lanes_retired) == 0 ]] && intact $LA $LB $LC'

print "\n### night 4: fake 20 h (AS2_REPROVE_AFTER=0), K0, AS2_BUN unset: confirm and .offsite; the lane phases skip"
unset AS2_BUN
night "night 4 (K0, re-proof due, AS2_BUN unset)"; lanes_line
export AS2_BUN=$FIXTURE_BUN
check "night 4: clean; last-run.json lanes says skipped: AS2_BUN unset, lane counts 0" \
  'clean && [[ $(hb .lanes) == "skipped: AS2_BUN unset" && $(hb .counts.lanes_tarred) == 0 && $(hb .counts.lanes_retired) == 0 ]] && grep -q "lanes: skipped: AS2_BUN unset" $T/state/run.log'
check "night 4: the three lane tars confirmed like scratch archives: claimed copies deleted, .offsite naming the tar's sha256, receipts in receipts/" \
  '[[ $(hb .counts.offsite_and_deleted) == 3 && $(kvf $AA.offsite sha256) == $(rec $LA sha256) && $(kvf $AB.offsite sha256) == $(rec $LB sha256) && -n $(kvf $AB.offsite envelope_drive_path) && $(kvf $AC.offsite sha256) == $(rec $LC sha256) && -f $RCPT/$day/${AA:t}/receipt && ! -e $CA && ! -e $CB ]]'
check "night 4: lane folders untouched (retire did not run)" 'intact $LA $LB $LC'

print "\n### night 5: the knob switched 0 -> 1 between confirm and retire: nothing is purged"
export AS2_KEEP_LOCAL=1
night "night 5 (K1 after a K0 confirm)"; lanes_line
check "night 5: clean; retire held all three proven lanes (--keep-local 1), retired none" \
  'clean && [[ $(hb .counts.lanes_held) == 3 && $(hb .counts.lanes_retired) == 0 && $(hb .lanes) == *"retire: retired=0 held=3 requeued=0 finished=0 failed=0" ]] && grep -q "$LA: proven offsite (.*); --keep-local 1 keeps the folder" $T/state/run.log'
check "night 5: every lane folder in place, unchanged, no marker; records still pending" 'intact $LA $LB $LC && [[ $(rec $LA state) == pending && $(rec $LC state) == pending ]]'

print "\n### --dry-run at K0: lists what produce would tar and retire would remove, changes nothing"
export AS2_KEEP_LOCAL=0
mklane $LD 0
lsnap() { (cd $T && /usr/bin/find home state/lane-archives state/receipts scratch-archive claims CloudStorage \
  -exec /usr/bin/stat -f '%N %z %m %p %Y' {} + 2>&1 | sort) }
S0=$(lsnap)
night "dry run (K0)" --dry-run > $T/dry.out; cat $T/dry.out
check "dry run: exit 0; produce would tar the new lane, retire would retire the three proven ones" \
  '[[ $RC == 0 ]] && grep -q "lanes produce: skip $LD: DRY RUN: would tar \$T/home/.agent-system-2/lanes/$LD" $T/dry.out && [[ $(grep -c "lanes retire: skip wl-.*: DRY RUN: would retire" $T/dry.out) == 3 ]]'
check "dry run: nothing under the lanes root, lane state, receipts, archive root, claims or Drive changed" '[[ $(lsnap) == $S0 ]]'

print "\n### a producer fail line reaches last-run.json and the alert: Drive quota short (1000 bytes left), K1"
export AS2_KEEP_LOCAL=1
short=$(pbv 1 1)$(pbm 2 "$(pbm 1 "$(pbs 3 'Test User')$(pbs 11 $ACCOUNT)")$(pbm 3 "$(pbm 1 "$(pbv 1 $TOTAL)$(pbv 3 $(( TOTAL - 1000 )))$(pbv 6 1)$(pbv 8 1000)")")")$(pbv 13 1)
$SQL "$FDB" "update properties set value=x'$short' where property='driveway_account'" || bad "cannot shorten the quota"
a0=$(alerts)
AS2_LANE_ONLY=$LD night "quota short (K1, AS2_LANE_ONLY=$LD)"; lanes_line
qfail='.failures[] | select(.step == "lane-produce") | .path + " | " + .error'
check "quota short: the run fails; failures name lane-produce, the script, the quota and that no lane is tarred tonight" \
  '(( RC != 0 )) && [[ $(hb .counts.failed) == 1 && $(hb .counts.lanes_tarred) == 0 && $(jq -r $qfail $T/state/last-run.json) == "$REPO/surface/scripts/lane-archive.ts | Drive quota: 1000 bytes remain"*"1 eligible lanes"*"; no lane tarred tonight" && $(hb .lanes) == "produce: tarred=0 recovered=0 skipped=0 failed=1 eligible=1; retire: "* ]]'
check "quota short: one alert whose popup carries the lane-produce failure" \
  '(( $(alerts) == a0 + 1 )) && tail -1 $T/alerts.log | grep -q "lane-produce: $REPO/surface/scripts/lane-archive.ts: Drive quota: "'
check "quota short: nothing tarred, every folder and record as before" '[[ ! -e $LSTATE/$LD.json ]] && intact $LA $LB $LC $LD'
$SQL "$FDB" "update properties set value=x'$blob' where property='driveway_account'" || bad "cannot put the quota back"
export AS2_KEEP_LOCAL=0

print "\n### night 6, K0, AS2_LANE_ONLY=<one lane>: retire takes that lane alone"
AS2_LANE_ONLY=$LC night "night 6 (K0, AS2_LANE_ONLY=$LC)"; lanes_line
check "night 6: clean; one lane retired, nothing tarred (the new lane is not the only one)" \
  'clean && [[ $(hb .counts.lanes_retired) == 1 && $(hb .counts.lanes_tarred) == 0 && $(hb .lanes) == "produce: tarred=0 recovered=0 skipped=0 failed=0 eligible=0; retire: retired=1 held=0 requeued=0 finished=0 failed=0" ]]'
check "night 6: that lane's folder gone, its marker offsite naming the restore command; the others in place" \
  '[[ ! -e $LANES/$LC && $(marker $LC state) == offsite && $(marker $LC tar_sha256) == $(jq -r .sha256 $LSTATE/done/$LC.json) && $(marker $LC restore) == "as2 lane restore $LC" ]] && intact $LA $LB'

print "\n### night 7, K0: the rest retired; the new lane tarred"
night "night 7 (K0)"; lanes_line
check "night 7: clean; two lanes retired, the new one tarred" \
  'clean && [[ $(hb .counts.lanes_retired) == 2 && $(hb .counts.lanes_tarred) == 1 && $(hb .counts.lanes_held) == 1 ]]'
check "night 7: both folders gone, markers offsite: the single lane names its Drive copy, the envelope lane its envelope and member" \
  '[[ ! -e $LANES/$LA && ! -e $LANES/$LB && $(marker $LA state) == offsite && $(marker $LA drive_path) == $(kvf $AA.offsite drive_path) && $(marker $LB state) == offsite && $(marker $LB envelope_drive_path) == $(kvf $AB.offsite envelope_drive_path) && $(marker $LB member) == $(kvf $AB.offsite member) ]]'
check "no lane-archive attempt dir or .removing-* tree left" '[[ -z $(print -l $LSTATE/tmp/*(N) $LANES/.removing-*(N)) ]]'
check "nothing on Drive deleted or overwritten since night 1" '[[ -z $(comm -23 <(print -r -- $DRIVE0 | sort) <(drive_sums | sort)) ]]'

print "\n### bin/as2 lane restore (this checkout) puts the single and the envelope lane back, byte-identical"
export AS2_LANE_ARCHIVE_STATE=$LSTATE
for w in $LA $LB; do
  o=$(PATH=${FIXTURE_BUN:h}:$PATH $REPO/bin/as2 lane restore $w 2>&1); rrc=$?
  print -r -- "${o//$T/\$T}" | sed 's/^/    /'
  check "restore $w: exit 0; diff -r against the pre-delete copy clean, same modes and link targets; the marker retired" \
    '(( rrc == 0 )) && same_as_copy $w && [[ ! -e $LANES/$w.offsite && -n $(print -l $LANES/$w.offsite.restored-*(N)) && -f $LSTATE/restored/$w.json ]]'
done

suite_end
