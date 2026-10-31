#!/bin/zsh
# Fake-Drive suite, crash part 1 (OpenAI review round 6, R6-B2): a two-member envelope's deleting run is killed right
# after each early retirement step of its first member (AS2_CRASH_AFTER, the job's crash seam: it sends itself
# SIGKILL, so nothing after the step runs, as in a crash or power loss): the marker written, the member's archive
# deleted, the member's receipt written. After each crash the next run converges with no failure, no new upload, the
# same number of envelopes on Drive, every member's receipt present and the envelope retired; a further run reports
# nothing (crash_case in fake-drive-fixture.zsh). The later steps are in test-fake-drive-crash-late.zsh.
#   zsh test-fake-drive-crash.zsh        prints PASS/FAIL lines, ends with "RESULT: <n> failure(s)", exits n
emulate -L zsh
setopt no_unset pipe_fail extended_glob
HERE=${0:A:h}
source $HERE/fake-drive-fixture.zsh || { print -u2 "cannot source $HERE/fake-drive-fixture.zsh"; exit 99 }
trap cleanup EXIT
export AS2_ENVELOPE_FLOOR=60000      # archives of a few hundred bytes go into envelopes

crash_case 1 marker
crash_case 2 unlink
crash_case 3 member-receipt
check "no alert was raised by any crash case" '[[ $(alerts) == 0 ]]'

suite_end
