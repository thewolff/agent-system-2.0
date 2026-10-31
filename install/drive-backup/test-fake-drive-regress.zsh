#!/bin/zsh
# Fake-Drive suite, round-6 regression part 1, envelopes (OpenAI review round 6, R6-B1): once an upload record exists
# only a receipt replaces it. Two proof timeouts, two proof errors, and a copy that fails after its bytes landed
# followed by an existence check that fails; each time the uploader (or Drive) recovers and the third night proves
# the ORIGINAL envelope copy, with exactly one copy on the fake Drive. Nothing is deleted in this part
# (AS2_REPROVE_AFTER is far away). The failed copy is staged on the Drive folder (copy_fails_after_landing: cp's
# extended-attribute step is refused on the new file), so it holds for the job-built envelope whether or not files
# carry com.apple.provenance (Jo's Mac does, GitHub's hosted macOS runner does not); the setup is checked first and a
# Mac where cp still exits 0 there fails C's setup check by name. The single-archive cases are in
# test-fake-drive-regress-single.zsh. Setup: fake-drive-fixture.zsh.
#   zsh test-fake-drive-regress.zsh        prints PASS/FAIL lines, ends with "RESULT: <n> failure(s)", exits n
emulate -L zsh
setopt no_unset pipe_fail extended_glob
HERE=${0:A:h}
source $HERE/fake-drive-fixture.zsh || { print -u2 "cannot source $HERE/fake-drive-fixture.zsh"; exit 99 }
trap cleanup EXIT
export AS2_ENVELOPE_FLOOR=60000 AS2_REPROVE_AFTER=999999   # archives of a few hundred bytes go into envelopes; nothing is deleted

print "\n### A: an envelope's proof times out on two nights; the uploader recovers; the third night proves the same copy"
mk $ARCH/2026-11-01/wl-a1.tar.gz 100; mk $ARCH/2026-11-01/wl-a2.tar.gz 200
upmode off
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=2 on two nights (fake clock: AS2_CLOCK_CMD)
AS2_PROOF_TIMEOUT=2 night "A night 1: the envelope is copied, never proven (uploader off)"
EA=$(ed_of 2026-11-01/wl-a1.tar.gz); EAOBJ=$(kvf $EA/upload drive_path)
check "A night 1: one envelope copy on Drive, the upload record kept, the night counted (step prove)" '[[ -n $EAOBJ && -f $EAOBJ && $(env_copies $EA) == 1 && $(head -1 $EA/attempts) == 1 && $(fail_step $EA) == prove ]]'
AS2_PROOF_TIMEOUT=2 night "A night 2: the re-proof times out again"
check "A night 2: the same record re-proved, no new upload, one copy, count 2" '[[ $(hb .counts.uploaded) == 0 && $(kvf $EA/upload drive_path) == $EAOBJ && $(env_copies $EA) == 1 && $(head -1 $EA/attempts) == 2 ]] && fail_text $EA | grep -qF "the next night proves $EAOBJ again"'
upmode good
night "A night 3: the uploader recovered"
check "A night 3: the original envelope copy is proven; no new upload; exactly one copy on Drive" 'nofail $EA && [[ $(hb .counts.uploaded) == 0 && -f $EA/receipt && $(kvf $EA/receipt drive_path) == $EAOBJ && $(env_copies $EA) == 1 ]]'

print "\n### B: an envelope's proof errors (two live items at its path) on two nights; Drive recovers; the third night proves the same copy"
mk $ARCH/2026-11-02/wl-b1.tar.gz 100; mk $ARCH/2026-11-02/wl-b2.tar.gz 200
print 'env-*.tar' > $T/uploader.dup
night "B night 1: the envelope's path is ambiguous on Drive (proof error)"
EB=$(ed_of 2026-11-02/wl-b1.tar.gz); EBOBJ=$(kvf $EB/upload drive_path)
check "B night 1: proof error (failed: ambiguous), the upload record kept, one copy, count 1" '[[ -n $EBOBJ && $(env_copies $EB) == 1 && $(head -1 $EB/attempts) == 1 ]] && fail_text $EB | grep -q "not proven (failed): ambiguous"'
night "B night 2: the proof errors again"
check "B night 2: the same record re-proved, no new upload, one copy, count 2" '[[ $(hb .counts.uploaded) == 0 && $(kvf $EB/upload drive_path) == $EBOBJ && $(env_copies $EB) == 1 && $(head -1 $EB/attempts) == 2 ]]'
: > $T/uploader.dup; $SQL "$FDB" "update items set trashed=1 where id like 'dup-%'"   # the second item is trashed: Drive recovered
night "B night 3: the path is no longer ambiguous"
check "B night 3: the original envelope copy is proven; no new upload; exactly one copy on Drive" 'nofail $EB && [[ $(hb .counts.uploaded) == 0 && -f $EB/receipt && $(kvf $EB/receipt drive_path) == $EBOBJ && $(env_copies $EB) == 1 ]]'

print "\n### C: an envelope's copy lands but cp fails; the next night the recorded path's existence check fails; the third night proves the same copy"
TODAY=$(strftime '%Y-%m-%d' $EPOCHSECONDS); DD=$SA/$TODAY   # the folder tonight's envelope goes to (the job's TODAY)
check "C setup: tonight's Drive folder lands a copy's bytes and then fails cp, also for a source with no extended attribute" 'copy_fails_after_landing "$DD"'
mk $ARCH/2026-11-03/wl-c1.tar.gz 100; mk $ARCH/2026-11-03/wl-c2.tar.gz 200
upmode off
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=2 (fake clock: AS2_CLOCK_CMD)
AS2_PROOF_TIMEOUT=2 night "C night 1: the copy lands, cp exits 1"
EC=$(ed_of 2026-11-03/wl-c1.tar.gz); ECOBJ=$(kvf $EC/upload drive_path)
check "C night 1: cp failed (step copy) with the bytes on Drive; the upload record kept; the night counted" '[[ -n $ECOBJ && -s $ECOBJ && $(fail_step $EC) == copy && $(head -1 $EC/attempts) == 1 && $(hb .counts.uploaded) == 0 ]] && fail_text $EC | grep -qF "the upload record $EC/upload stays"'
stat_fails "$DD"
check "C: the recorded copy's local path does not answer a stat now" '! /bin/test -e "$ECOBJ"'
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=2 (fake clock: AS2_CLOCK_CMD)
AS2_PROOF_TIMEOUT=2 night "C night 2: the existence check of the recorded copy fails; the uploader is still off"
check "C night 2: no rebuild, no new upload, the same record, count 2" '[[ $(hb .counts.uploaded) == 0 && $(kvf $EC/upload drive_path) == $ECOBJ && $(head -1 $EC/attempts) == 2 && $(fail_step $EC) == prove ]] && ! grep -q "; building the envelope again" $T/state/run.log'
answers_again "$DD"; upmode good
night "C night 3: Drive answers again and records the copy"
check "C night 3: the original envelope copy is proven; no new upload; exactly one copy on Drive" 'nofail $EC && [[ $(hb .counts.uploaded) == 0 && -f $EC/receipt && $(kvf $EC/receipt drive_path) == $ECOBJ && $(env_copies $EC) == 1 ]]'

suite_end
