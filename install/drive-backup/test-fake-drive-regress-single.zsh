#!/bin/zsh
# Fake-Drive suite, round-6 regression part 2, single large archives (OpenAI review round 6, R6-B1): once an upload
# record exists only a receipt replaces it. Two proof timeouts, and a copy that fails after its bytes landed followed
# by an existence check that fails; each time the uploader (or Drive) recovers and the third night proves the
# ORIGINAL copy, with exactly one copy on the fake Drive. Then a copy that never proves goes STUCK after the third
# failed night naming its Drive path, with no further copy; and a run killed between recording the upload and the copy
# re-proves that path (never a new upload) until a person deletes the record. Nothing is deleted in this part
# (AS2_REPROVE_AFTER is far away). The envelope cases are in test-fake-drive-regress.zsh. Setup: fake-drive-fixture.zsh.
#   zsh test-fake-drive-regress-single.zsh        prints PASS/FAIL lines, ends with "RESULT: <n> failure(s)", exits n
emulate -L zsh
setopt no_unset pipe_fail extended_glob
HERE=${0:A:h}
source $HERE/fake-drive-fixture.zsh || { print -u2 "cannot source $HERE/fake-drive-fixture.zsh"; exit 99 }
trap cleanup EXIT
export AS2_REPROVE_AFTER=999999   # nothing is deleted

print "\n### D: a single large archive's proof times out on two nights; the uploader recovers; the third night proves the same copy"
mk $ARCH/2026-11-04/wl-big1.tar.gz 90000
upmode off
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=2 on two nights (fake clock: AS2_CLOCK_CMD)
AS2_PROOF_TIMEOUT=2 night "D night 1: copied, never proven"
D1=$(cdir 2026-11-04/wl-big1.tar.gz); D1OBJ=$(kvf $D1/upload drive_path)
check "D night 1: one copy, the upload record kept, count 1" '[[ -n $D1OBJ && -f $D1OBJ && $(arch_copies 2026-11-04/wl-big1.tar.gz) == 1 && $(head -1 $D1/attempts) == 1 && ! -f $D1/envelope ]]'
AS2_PROOF_TIMEOUT=2 night "D night 2: the re-proof times out again"
check "D night 2: the same record re-proved, no new upload, one copy, count 2" '[[ $(hb .counts.uploaded) == 0 && $(kvf $D1/upload drive_path) == $D1OBJ && $(arch_copies 2026-11-04/wl-big1.tar.gz) == 1 && $(head -1 $D1/attempts) == 2 ]]'
upmode good
night "D night 3: the uploader recovered"
check "D night 3: the original copy is proven; no new upload; exactly one copy on Drive" 'nofail wl-big1.tar.gz && [[ $(hb .counts.uploaded) == 0 && $(kvf $D1/receipt drive_path) == $D1OBJ && $(arch_copies 2026-11-04/wl-big1.tar.gz) == 1 ]]'

print "\n### D2: a single large archive's copy lands but cp fails; the next night its path's existence check fails; the third night proves the same copy"
copy_fails_after_landing "$SA/2026-11-05"
mk $ARCH/2026-11-05/wl-big2.tar.gz 90000
upmode off
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=2 (fake clock: AS2_CLOCK_CMD)
AS2_PROOF_TIMEOUT=2 night "D2 night 1: the copy lands, cp exits 1"
D2=$(cdir 2026-11-05/wl-big2.tar.gz); D2OBJ=$(kvf $D2/upload drive_path 2>/dev/null)
check "D2 night 1: the upload was recorded before the copy; cp failed (step copy) with the bytes on Drive; the record kept" '[[ -n $D2OBJ && -s $D2OBJ && $(fail_step wl-big2.tar.gz) == copy && $(head -1 $D2/attempts) == 1 ]]'
stat_fails "$SA/2026-11-05"
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=2 (fake clock: AS2_CLOCK_CMD)
AS2_PROOF_TIMEOUT=2 night "D2 night 2: the existence check fails; the uploader is still off"
check "D2 night 2: no new upload, the same record, count 2" '[[ $(hb .counts.uploaded) == 0 && $(kvf $D2/upload drive_path) == $D2OBJ && $(head -1 $D2/attempts) == 2 ]]'
answers_again "$SA/2026-11-05"; upmode good
night "D2 night 3: Drive answers again"
check "D2 night 3: the original copy is proven; no new upload; exactly one copy on Drive" 'nofail wl-big2.tar.gz && [[ $(hb .counts.uploaded) == 0 && $(kvf $D2/receipt drive_path) == $D2OBJ && $(arch_copies 2026-11-05/wl-big2.tar.gz) == 1 ]]'

print "\n### E: a copy that never proves goes STUCK after the third failed night, naming its Drive path, with no further copy"
mk $ARCH/2026-11-06/wl-stuck.tar.gz 90000
print 'wl-stuck.????????????????.*.tar.gz' > $T/uploader.bad
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=2 on three nights (fake clock: AS2_CLOCK_CMD)
for k in 1 2 3; do AS2_PROOF_TIMEOUT=2 night "E night $k: never proven"; done
E1=$(cdir 2026-11-06/wl-stuck.tar.gz); E1OBJ=$(kvf $E1/upload drive_path)
check "E: STUCK after the third failed night; one copy; the record still names it" '[[ -f $E1/stuck && -f $ARCH/2026-11-06/wl-stuck.tar.gz.stuck && $(head -1 $E1/attempts) == 3 && $(arch_copies 2026-11-06/wl-stuck.tar.gz) == 1 && -f $E1OBJ ]]'
check "E: the STUCK alert and stuck file name the Drive path and the person step before a fresh upload" 'tail -1 $T/alerts.log | grep -qF "a person confirms there is no Drive copy at $E1OBJ before deleting $E1/upload" && grep -qF "a person confirms there is no Drive copy at $E1OBJ" $E1/stuck'
n_alerts=$(alerts)
night "E night 4: skipped"
check "E night 4: skipped as stuck, no copy, no new alert" '[[ $(hb ".skipped_stuck | map(select(endswith(\"wl-stuck.tar.gz\"))) | length") == 1 && $(hb .counts.uploaded) == 0 && $(arch_copies 2026-11-06/wl-stuck.tar.gz) == 1 && $(alerts) == $n_alerts ]]'

print "\n### F: a run killed after recording the upload and before the copy: the next nights prove that path, never upload again"
mk $ARCH/2026-11-07/wl-cut.tar.gz 90000
AS2_CRASH_AFTER=upload-recorded night "F: killed right after recording the upload"
F1=$(cdir 2026-11-07/wl-cut.tar.gz); F1OBJ=$(kvf $F1/upload drive_path 2>/dev/null)
check "F: the run was killed with the record written and nothing copied" '(( RC == 137 )) && [[ -n $F1OBJ && ! -e $F1OBJ && $(arch_copies 2026-11-07/wl-cut.tar.gz) == 0 ]]'
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=2 on three nights (fake clock: AS2_CLOCK_CMD)
for k in 1 2 3; do AS2_PROOF_TIMEOUT=2 night "F night $k after the kill: the recorded path never proves"; done
check "F: three nights proved only the recorded path (no upload), then STUCK naming it" '[[ $(arch_copies 2026-11-07/wl-cut.tar.gz) == 0 && -f $F1/stuck && $(kvf $F1/upload drive_path) == $F1OBJ ]] && grep -qF "a person confirms there is no Drive copy at $F1OBJ" $F1/stuck'
rm -f $F1/upload $F1/stuck   # the person confirmed there is no Drive copy at that path
night "F: after the person's step: a fresh upload under a new name, proven"
check "F: one fresh upload, proven" '[[ $(hb .counts.uploaded) == 1 && -f $F1/receipt && $(kvf $F1/receipt drive_path) != $F1OBJ && $(arch_copies 2026-11-07/wl-cut.tar.gz) == 1 ]]'

suite_end
