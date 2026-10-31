#!/bin/zsh
# Fake-Drive suite, envelope part 2: a run that stops part-way never loses a member or uploads an envelope twice: an
# unmeasurable envelope threshold, a run stopped mid-build, after the copy, before the copy (the recorded path is
# proven again, never rebuilt, until a person deletes the record), and mid-deletion (one member fully retired). The
# crash-after-each-step cases are in test-fake-drive-crash*.zsh. Setup: fake-drive-fixture.zsh.
#   zsh test-fake-drive-envelope-stops.zsh        prints PASS/FAIL lines, ends with "RESULT: <n> failure(s)", exits n
emulate -L zsh
setopt no_unset pipe_fail extended_glob
HERE=${0:A:h}
source $HERE/fake-drive-fixture.zsh || { print -u2 "cannot source $HERE/fake-drive-fixture.zsh"; exit 99 }
trap cleanup EXIT
mkdir -p $ARCH/2026-10-29

print "\n### a run that stops part-way never loses a member or uploads an envelope twice"
mk $ARCH/2026-10-29/wl-c1.tar.gz 100
mv $CC $T/cc.away
AS2_ENVELOPE_FLOOR=60000 night "content cache missing: the threshold cannot be measured"
check "unmeasurable threshold: wl-c1 claimed and kept, the failure says why" '(( RC != 0 )) && [[ -f $(cdir 2026-10-29/wl-c1.tar.gz)/wl-c1.tar.gz && ! -f $(cdir 2026-10-29/wl-c1.tar.gz)/envelope ]] && grep -q "cannot work out the envelope threshold" $T/state/run.log'
mv $T/cc.away $CC
ghost=$CLAIMS/envelopes/2026-10-29/env-20261029T000000.e; gtmp=$CLAIMS/envelopes/2026-10-29/.env-20261029T000000.tmp
mkdir -p $gtmp; c1=$(cdir 2026-10-29/wl-c1.tar.gz)
print -r -- "$c1	2026-10-29/wl-c1.tar.gz	$(shasum -a 256 $c1/wl-c1.tar.gz | cut -d' ' -f1)	$(/usr/bin/stat -f %z $c1/wl-c1.tar.gz)	$ARCH/2026-10-29/wl-c1.tar.gz" > $gtmp/members
print -r -- "envelope_dir=$ghost" > $c1/envelope       # the state a run leaves when it stops before renaming the build into place
n0=$(envs_on_drive)
AS2_ENVELOPE_FLOOR=60000 AS2_REPROVE_AFTER=999999 night "after a run stopped mid-build"
check "stopped mid-build: the unfinished build is removed, wl-c1 goes into a new envelope, one upload" '[[ ! -e $gtmp && ! -e $ghost && $(ed_of 2026-10-29/wl-c1.tar.gz) != $ghost && -f $(ed_of 2026-10-29/wl-c1.tar.gz)/receipt && $(( $(envs_on_drive) - n0 )) == 1 ]]'
mk $ARCH/2026-10-29/wl-c2.tar.gz 100
upmode off
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=2 (fake clock: AS2_CLOCK_CMD)
AS2_ENVELOPE_FLOOR=60000 AS2_PROOF_TIMEOUT=2 night "copy made, never proven (Drive for desktop not recording it)" >/dev/null
E5=$(ed_of 2026-10-29/wl-c2.tar.gz); rm -f $E5/attempts   # the state a run leaves when it stops right after the copy
n0=$(envs_on_drive)
upmode good
AS2_ENVELOPE_FLOOR=60000 AS2_REPROVE_AFTER=999999 night "after a run stopped after the copy"
check "stopped after the copy: the same Drive copy is re-proven, no second upload" '[[ -f $E5/receipt && $(hb .counts.uploaded) == 0 && $(envs_on_drive) == $n0 ]] && grep -q "re-proving the earlier envelope upload" $T/state/run.log'
mk $ARCH/2026-10-29/wl-c3.tar.gz 100
upmode off
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=2 (fake clock: AS2_CLOCK_CMD)
AS2_ENVELOPE_FLOOR=60000 AS2_PROOF_TIMEOUT=2 night "another envelope, never proven" >/dev/null
E6=$(ed_of 2026-10-29/wl-c3.tar.gz); c3obj=$(kvf $E6/upload drive_path)
mv "$c3obj" $T/c3-env.bak; rm -f $E6/attempts   # the state a run leaves when it stops after recording the upload, before the copy
upmode good
n0=$(envs_on_drive)
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=2 (fake clock: AS2_CLOCK_CMD)
AS2_ENVELOPE_FLOOR=60000 AS2_PROOF_TIMEOUT=2 AS2_REPROVE_AFTER=999999 night "after a run stopped before the copy"
check "stopped before the copy: the recorded Drive path is proven again, never rebuilt or uploaded again; the night is counted and names the path" '(( RC != 0 )) && [[ ! -f $E6/receipt && $(kvf $E6/upload drive_path) == $c3obj && $(hb .counts.uploaded) == 0 && $(envs_on_drive) == $n0 && $(head -1 $E6/attempts) == 1 ]] && jq -r ".failures[] | select(.path == \"$E6\") | .error" $T/state/last-run.json | grep -qF "$c3obj" && ! grep -q "; building the envelope again" $T/state/run.log'
rm -f $E6/upload   # a person confirmed there is no Drive copy at the recorded path, the step the STUCK message names
AS2_ENVELOPE_FLOOR=60000 AS2_REPROVE_AFTER=999999 night "after a person deleted the upload record"
check "after the person's step: the envelope is built again, uploaded once under a new name and proven" '[[ -f $E6/receipt && $(kvf $E6/receipt drive_path) != $c3obj && $(hb .counts.uploaded) == 1 ]]'
mk $ARCH/2026-10-29/wl-d1.tar.gz 100; mk $ARCH/2026-10-29/wl-d2.tar.gz 100
AS2_ENVELOPE_FLOOR=60000 AS2_REPROVE_AFTER=999999 night "two members, proven" >/dev/null
E7=$(ed_of 2026-10-29/wl-d1.tar.gz); E7OBJ=$(kvf $E7/receipt drive_path); d1=$(cdir 2026-10-29/wl-d1.tar.gz)
d1sha=$(shasum -a 256 $d1/wl-d1.tar.gz | cut -d' ' -f1)
# the state a run leaves when it stops after retiring wl-d1 and before wl-d2: marker written, d1 deleted and its dir moved
print -rl -- "envelope_drive_path=$E7OBJ" "envelope_sha256=$(kvf $E7/receipt sha256)" "member=2026-10-29/wl-d1.tar.gz" "sha256=$d1sha" > $ARCH/2026-10-29/wl-d1.tar.gz.offsite
rm -f $d1/wl-d1.tar.gz
print -rl -- "envelope_drive_path=$E7OBJ" "member=2026-10-29/wl-d1.tar.gz" "sha256=$d1sha" "deleted_at=(test)" > $d1/receipt
mkdir -p $T/state/receipts/2026-10-29; mv $d1 $T/state/receipts/2026-10-29/wl-d1.tar.gz
night "after a run stopped part-way through an envelope's deletions"
check "stopped mid-deletion: wl-d1 counted as done, wl-d2 deleted, the envelope retired, no failure for it" 'nofail $E7 && nofail wl-d2 && [[ ! -e $(cdir 2026-10-29/wl-d2.tar.gz) && -f $ARCH/2026-10-29/wl-d2.tar.gz.offsite && ! -e $E7 && -f $T/state/receipts/envelopes/${E7:h:t}/${E7:t}/receipt ]]'
check "every crash case ends with all small archives retired (c1, c2, c3 deleted after their envelopes)" '[[ ! -e $(cdir 2026-10-29/wl-c1.tar.gz) && ! -e $(cdir 2026-10-29/wl-c2.tar.gz) && ! -e $(cdir 2026-10-29/wl-c3.tar.gz) && -f $ARCH/2026-10-29/wl-c3.tar.gz.offsite ]]'

suite_end
