#!/bin/zsh
# Fake-Drive suite, crash part 2 (OpenAI review round 6, R6-B2 and R6-S1): a two-member envelope's deleting run is
# killed right after the later retirement steps (AS2_CRASH_AFTER): the first member's claim dir moved to receipts/,
# the envelope moved to receipts/envelopes/, and the second member's archive deleted (the first member already fully
# retired). Each converges as in crash part 1 (crash_case in fake-drive-fixture.zsh). Then R6-S1: an envelope that
# fails after one member was retired names the members still local and the ones already retired, not "all kept".
#   zsh test-fake-drive-crash-late.zsh        prints PASS/FAIL lines, ends with "RESULT: <n> failure(s)", exits n
emulate -L zsh
setopt no_unset pipe_fail extended_glob
HERE=${0:A:h}
source $HERE/fake-drive-fixture.zsh || { print -u2 "cannot source $HERE/fake-drive-fixture.zsh"; exit 99 }
trap cleanup EXIT
export AS2_ENVELOPE_FLOOR=60000      # archives of a few hundred bytes go into envelopes

crash_case 4 claim-moved
crash_case 5 envelope-moved
crash_case 6 unlink:2
check "no alert was raised by any crash case" '[[ $(alerts) == 0 ]]'

print "\n### R6-S1: an envelope that fails after a member was retired names the members still local and the ones already retired"
day=2026-11-09 a=$ARCH/2026-11-09/wl-s1a.tar.gz b=$ARCH/2026-11-09/wl-s1b.tar.gz
mk $a 100; mk $b 200; shasum -a 256 $a $b >> $T/orig.sha
ca=$(cdir $day/${a:t}) cb=$(cdir $day/${b:t})
AS2_REPROVE_AFTER=999999 night "S1: a two-member envelope, proven" >/dev/null
E=$(ed_of $day/${a:t}); EOBJ=$(kvf $E/receipt drive_path); n0=$(envs_on_drive)
AS2_CRASH_AFTER=unlink night "S1: the deleting run, killed right after the first member's archive is deleted" >/dev/null
print fail > $T/evict.mode
night "S1: the next run: the server read is refused, so the live member cannot be deleted"
check "S1: the failure names wl-s1b as still local and wl-s1a as already retired (not 'all kept')" '(( RC != 0 )) && jq -r ".failures[] | select(.path == \"$E\") | .error" $T/state/last-run.json | grep -qF "still local, kept: $b; already retired (offsite marker present, archive gone): $a" && ! jq -r ".failures[].error" $T/state/last-run.json | grep -q "all kept"'
check "S1: the retired member was finished anyway (receipt in receipts/), the live one kept with its .attempts; the retired one has none" '[[ -f $RCPT/$day/${a:t}/receipt && ! -e $ca && -f $cb/${b:t} && -f $b.attempts && ! -e $a.attempts && -d $E ]]'
print ok > $T/evict.mode
night "S1: the server read works again"
check "S1: converges: no failure, no new upload, both retired, the envelope retired" '[[ $RC == 0 && $(hb .counts.failed) == 0 && $(hb .counts.uploaded) == 0 && $(envs_on_drive) == $n0 ]] && marker_ok $a $EOBJ && marker_ok $b $EOBJ && [[ -f $RCPT/$day/${b:t}/receipt && ! -e $E ]]'

suite_end
