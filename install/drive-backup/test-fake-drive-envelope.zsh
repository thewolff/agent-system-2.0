#!/bin/zsh
# Fake-Drive suite, envelope part 1: small archives travel in a nightly envelope (OpenAI review round 5, R5-B1): the
# mixed night, the plain-tar layout, the deleting night, restore and --verify-restore of a member, the 4 x side-file
# threshold, and an envelope that never proves (STUCK as one item naming its Drive copy, then recovered by re-proving
# the same copy). Runs that stop part-way are in test-fake-drive-envelope-stops.zsh. Setup: fake-drive-fixture.zsh.
#   zsh test-fake-drive-envelope.zsh        prints PASS/FAIL lines, ends with "RESULT: <n> failure(s)", exits n
emulate -L zsh
setopt no_unset pipe_fail extended_glob
HERE=${0:A:h}
source $HERE/fake-drive-fixture.zsh || { print -u2 "cannot source $HERE/fake-drive-fixture.zsh"; exit 99 }
trap cleanup EXIT

print "\n### small archives travel in a nightly envelope (OpenAI review round 5, R5-B1)"
mkdir -p $ARCH/2026-10-29
head -c 10000 /dev/zero > $CC/chunks.db-wal          # side files 10000 bytes: 4 x 10000 is under the 60000 floor used here
mk $ARCH/2026-10-29/wl-t1.tar.gz 100; mk $ARCH/2026-10-29/wl-t2.tar.gz 20000; mk $ARCH/2026-10-29/wl-big.tar.gz 90000
for f in $ARCH/2026-10-29/wl-{t1,t2,big}.tar.gz; do shasum -a 256 $f; done >> $T/orig.sha
t1size=$(/usr/bin/stat -f %z $ARCH/2026-10-29/wl-t1.tar.gz)   # /usr/bin: zsh/stat (loaded above) shadows `stat`
AS2_ENVELOPE_FLOOR=60000 AS2_REPROVE_AFTER=999999 night "mixed night: two small archives and one large one"
E1=$(ed_of 2026-10-29/wl-t1.tar.gz); E1OBJ=$(kvf $E1/receipt drive_path)
check "mixed night: the sub-32-KiB archive ($t1size bytes) and a 20 KB one share one envelope; the large one goes alone" '(( t1size < 32768 )) && nofail 2026-10-29 && [[ -n $E1 && -d $E1 && $(ed_of 2026-10-29/wl-t2.tar.gz) == $E1 && ! -f $(cdir 2026-10-29/wl-big.tar.gz)/envelope && -f $(cdir 2026-10-29/wl-big.tar.gz)/receipt && -f $E1/receipt && $(hb .counts.enveloped) == 2 ]]'
check "the Drive envelope is a plain tar: MANIFEST.tsv, PAD, both members unchanged; at least the 60000-byte threshold" '[[ $(tar -tf "$E1OBJ" | tr "\n" " ") == "MANIFEST.tsv PAD 2026-10-29/wl-t1.tar.gz 2026-10-29/wl-t2.tar.gz " && $(tar -xOf "$E1OBJ" 2026-10-29/wl-t2.tar.gz | shasum -a 256 | cut -d" " -f1) == $(osha wl-t2.tar.gz) ]] && (( $(/usr/bin/stat -f %z "$E1OBJ") >= 60000 )) && grep -q "envelope threshold 60000 bytes" $T/state/run.log'
check "nothing deleted on the envelope's first-proof night" '[[ -f $(cdir 2026-10-29/wl-t1.tar.gz)/wl-t1.tar.gz && -f $(cdir 2026-10-29/wl-t2.tar.gz)/wl-t2.tar.gz && $(hb .counts.offsite_and_deleted) == 0 ]]'
night "the envelope's deleting night"
check "both members deleted after the envelope's re-proof and server read; the large archive too" 'nofail 2026-10-29 && [[ ! -e $(cdir 2026-10-29/wl-t1.tar.gz) && ! -e $(cdir 2026-10-29/wl-t2.tar.gz) && ! -e $(cdir 2026-10-29/wl-big.tar.gz) && -f $ARCH/2026-10-29/wl-big.tar.gz.offsite && ! -e $E1 && -f $T/state/receipts/envelopes/${E1:h:t}/${E1:t}/receipt && -f $T/state/receipts/2026-10-29/wl-t1.tar.gz/receipt ]] && grep -q "EVICT .*/env-[0-9T]*\.[0-9a-f]*\.[0-9T]*\.tar " $T/evict.log'
check ".offsite names the envelope, the member and its sha256" '[[ $(kvf $ARCH/2026-10-29/wl-t1.tar.gz.offsite envelope_drive_path) == $E1OBJ && $(kvf $ARCH/2026-10-29/wl-t1.tar.gz.offsite member) == 2026-10-29/wl-t1.tar.gz && $(kvf $ARCH/2026-10-29/wl-t1.tar.gz.offsite sha256) == $(osha wl-t1.tar.gz) && ! -e $ARCH/2026-10-29/wl-t1.tar.gz.attempts ]]'
mkdir $T/restored-env; tar -xf "$E1OBJ" -C $T/restored-env 2026-10-29/wl-t1.tar.gz
check "README restore: tar -xf <envelope> -C <dir> <member> gives back the original bytes" '[[ $(shasum -a 256 $T/restored-env/2026-10-29/wl-t1.tar.gz | cut -d" " -f1) == $(osha wl-t1.tar.gz) ]]'
zsh "$HERE/backup-nightly.zsh" --verify-restore 2>&1 | sed -E "s#$T#\$T#g" | grep -E 'envelope|member|FAILED'; rc=${pipestatus[1]}
check "verify-restore reads the envelope back and extracts a member with the recorded sha256" '(( rc == 0 )) && grep -q "member 2026-10-29/wl-t1.tar.gz extracted from the Drive envelope: sha256 matches the record" $T/state/run.log'

print "\n### the envelope is at least 4 x the side files when that is above the 16 MiB floor"
head -c 5242880 /dev/zero > $CC/chunks.db-wal
mk $ARCH/2026-10-29/wl-t3.tar.gz 300
AS2_ENVELOPE_FLOOR=16777216 AS2_REPROVE_AFTER=999999 night "a 5 MiB -wal, default floor"
E3=$(ed_of 2026-10-29/wl-t3.tar.gz); E3OBJ=$(kvf $E3/receipt drive_path)
check "envelope is at least 4 x 5242880 = 20971520 bytes (above the 16 MiB floor)" '[[ -f $E3/receipt ]] && (( $(/usr/bin/stat -f %z "$E3OBJ") >= 20971520 )) && grep -q "envelope threshold 20971520 bytes" $T/state/run.log'
: > $CC/chunks.db-wal
night "its deleting night" >/dev/null
check "wl-t3 retired through its envelope" '[[ ! -e $(cdir 2026-10-29/wl-t3.tar.gz) && -f $ARCH/2026-10-29/wl-t3.tar.gz.offsite ]]'

print "\n### an envelope that never proves keeps every member and goes stuck as one item"
mk $ARCH/2026-10-29/wl-t4.tar.gz 100; mk $ARCH/2026-10-29/wl-t5.tar.gz 200
print 'env-*.tar' > $T/uploader.bad
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=4 on three nights (fake clock: AS2_CLOCK_CMD)
AS2_ENVELOPE_FLOOR=60000 AS2_PROOF_TIMEOUT=4 night "envelope never proves (night 1)"
E4=$(ed_of 2026-10-29/wl-t4.tar.gz); E4OBJ=$(kvf $E4/upload drive_path)
check "envelope proof failure: both members kept, one failure naming the envelope and both members as still local" '(( RC != 0 )) && [[ -f $(cdir 2026-10-29/wl-t4.tar.gz)/wl-t4.tar.gz && -f $(cdir 2026-10-29/wl-t5.tar.gz)/wl-t5.tar.gz && ! -e $ARCH/2026-10-29/wl-t4.tar.gz.offsite && $(head -1 $E4/attempts) == 1 ]] && jq -r ".failures[] | select(.path == \"$E4\") | .error" $T/state/last-run.json | grep -q "still local, kept: .*wl-t4.tar.gz, .*wl-t5.tar.gz; already retired (offsite marker present, archive gone): none"'
AS2_ENVELOPE_FLOOR=60000 AS2_PROOF_TIMEOUT=4 night "envelope never proves (night 2)" >/dev/null
AS2_ENVELOPE_FLOOR=60000 AS2_PROOF_TIMEOUT=4 night "envelope never proves (night 3)"
check "third failed night: envelope STUCK, each member has .stuck, the alert names the envelope and both members" '[[ -f $E4/stuck && -f $ARCH/2026-10-29/wl-t4.tar.gz.stuck && -f $ARCH/2026-10-29/wl-t5.tar.gz.stuck ]] && tail -1 $T/alerts.log | grep -q "STUCK.*envelope .*wl-t4.tar.gz, .*wl-t5.tar.gz"'
check "the STUCK alert and the envelope's stuck file name its one Drive copy and the person step before a fresh upload" '[[ $(env_copies $E4) == 1 && $(kvf $E4/upload drive_path) == $E4OBJ ]] && tail -1 $T/alerts.log | grep -qF "a person confirms there is no Drive copy at $E4OBJ" && grep -qF "before deleting $E4/upload" $E4/stuck'
check "no member was deleted on any failing night" '[[ -f $(cdir 2026-10-29/wl-t4.tar.gz)/wl-t4.tar.gz && -f $(cdir 2026-10-29/wl-t5.tar.gz)/wl-t5.tar.gz && ! -e $ARCH/2026-10-29/wl-t5.tar.gz.offsite ]]'
AS2_ENVELOPE_FLOOR=60000 night "a stuck envelope is skipped" >/dev/null
check "stuck envelope skipped, not retried" '[[ $(hb ".skipped_stuck | map(select(. == \"$E4\")) | length") == 1 ]]'
: > $T/uploader.bad; rm -f $E4/stuck
for k in 1 2 3; do AS2_ENVELOPE_FLOOR=60000 night "cleared: envelope retries ($k)" >/dev/null; done
check "after a person cleared it: both members retired, .stuck and .attempts gone" '[[ ! -e $(cdir 2026-10-29/wl-t4.tar.gz) && ! -e $(cdir 2026-10-29/wl-t5.tar.gz) && -f $ARCH/2026-10-29/wl-t5.tar.gz.offsite && ! -e $ARCH/2026-10-29/wl-t4.tar.gz.stuck && ! -e $ARCH/2026-10-29/wl-t4.tar.gz.attempts && ! -e $E4 ]]'
check "the envelope that recovered was the same Drive copy, re-proven (one object for it on Drive)" '[[ $(env_copies $E4) == 1 && $(kvf $T/state/receipts/envelopes/${E4:h:t}/${E4:t}/receipt drive_path) == $E4OBJ && $(kvf $ARCH/2026-10-29/wl-t4.tar.gz.offsite envelope_drive_path) == $E4OBJ ]]'

suite_end
