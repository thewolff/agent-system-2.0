# Shared setup for the fake-Drive suites (test-fake-drive*.zsh). Sourced, never run: each suite part sets its options
# (emulate zsh, no_unset pipe_fail extended_glob) and HERE (its own directory), sources this file, sets
# `trap cleanup EXIT`, runs its fixtures and ends with `suite_end`. Each part is self-seeding: it gets its
# own temp dir T, its own fake Drive, fake DriveFS metadata DB, fake ledger, alert stubs and fake server read, and makes
# every archive and state it needs itself, so the parts run alone and in any order.
# Contained: every path a part writes is under T (HOME, TMPDIR, the job's temp dir, fake Drive, fake archives, claims,
# state, alert results). T is left in place at the end for inspection; nothing is moved or written outside it. It never
# touches the real Drive, archives, ledger or launchd.
# Deterministic (Jo's timing rule, decision log 2026-10-28--0840): nothing here sleeps or races a background process.
# Time comes from the job's test seams: AS2_CLOCK_CMD reads the fake clock $T/clock, which stands still unless a step
# moves it; AS2_PROOF_POLL_HOOK runs one pass of the fake uploader and then moves that clock one second before each
# proof pass (AS2_PROOF_POLL=0: no real wait between passes), so "never proves within AS2_PROOF_TIMEOUT=N" is N
# passes; AS2_RUNSTAMP gives every run its own stamp. Each test that drives a deadline is marked
# `timing-under-test`. Every other wait is on a real event with a failure-only guard (wait_for, 30 s).
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
zmodload zsh/datetime zsh/system zsh/stat zsh/zselect
[[ -n ${HERE:-} && -f $HERE/backup-nightly.zsh ]] || { print -u2 "fake-drive-fixture.zsh: set HERE to install/drive-backup before sourcing it"; exit 99 }
REAL_TMP=${TMPDIR:-/tmp}
T=$(mktemp -d "$REAL_TMP/as2-drive-test.XXXXXX") || { print -u2 "mktemp failed"; exit 99 }
[[ -d $T ]] || { print -u2 "no test dir"; exit 99 }
mkdir -p $T/home $T/tmp $T/state $T/src || exit 99
export HOME=$T/home TMPDIR=$T/tmp AS2_TMPDIR=$T/tmp
print "test dir: $T"
SQL=/usr/bin/sqlite3
FAILS=0
ok()  { print "PASS: $*" }
bad() { print "FAIL: $*"; FAILS=$((FAILS+1)) }
check() { local d=$1; shift; if eval "$*"; then ok "$d"; else bad "$d"; fi }
# wait_for <what> <condition> [guard seconds, default 30]: polls a real condition every 10 ms. The guard is
# failure-only: on the expected path the condition holds long before it, and when it trips the reason is printed and
# 1 returned.
wait_for() { local k g=${3:-30}; for k in {1..$(( g * 100 ))}; do eval "$2" && return 0; zselect -t 1; done; print "guard: $1 did not happen within $g s"; return 1 }

# Processes a part starts and must end: the two DB holders, a fake "running nightly", a backgrounded night.
typeset -a FAKE_RUNNING HOLDERS
all_gone() { local p; for p; do kill -0 $p 2>/dev/null && return 1; done; return 0 }
cleanup() {
  : > $T/alert-holds.release; : > $T/alert-stalls.release; : > $T/fake-run.release   # a stub still waiting ends now
  (( ${#FAKE_RUNNING} )) && kill $FAKE_RUNNING 2>/dev/null
  exec 7>&- 8>&- 2>/dev/null
  # the holders exit on EOF; wait for that (the real event) so nothing writes into $T after the suite returns
  (( ${#HOLDERS} )) && wait_for "the DB holder processes exiting" 'all_gone $HOLDERS' 10
  print "test dir left in place: $T"
}
trap cleanup EXIT

# ---- fake Drive for desktop: the real five table definitions, the real schema-version property ----
DRIVE="$T/CloudStorage/GoogleDrive-test@example.com/My Drive"; mkdir -p "$DRIVE"
FDB=$T/metadata_sqlite_db
$SQL "$FDB" '
CREATE TABLE "item_properties" ("item_stable_id" INTEGER NOT NULL, "key" TEXT NOT NULL, "value" BLOB NOT NULL, "value_type" INTEGER NOT NULL,PRIMARY KEY("item_stable_id", "key"));
CREATE TABLE "items" ("stable_id" INTEGER PRIMARY KEY NOT NULL, "id" TEXT UNIQUE NOT NULL, "proto" BLOB, "trashed" BOOLEAN NOT NULL, "starred" BOOLEAN NOT NULL, "is_owner" BOOLEAN NOT NULL, "mime_type" TEXT NOT NULL COLLATE NOCASE, "is_folder" BOOLEAN NOT NULL, "modified_date" INTEGER, "shared_with_me_date" INTEGER, "viewed_by_me_date" INTEGER, "file_size" INTEGER, "is_tombstone" BOOLEAN NOT NULL, "local_title" TEXT, "subscribed" BOOLEAN NOT NULL, "team_drive_stable_id" INTEGER, "inaccessible_inheritance_broken" BOOLEAN NOT NULL);
CREATE TABLE "local_stable_ids" ("stable_id" INTEGER PRIMARY KEY NOT NULL);
CREATE TABLE "properties" ("property" TEXT PRIMARY KEY NOT NULL, "value" BLOB);
CREATE TABLE "stable_parents" ("item_stable_id" INTEGER NOT NULL, "parent_stable_id" INTEGER NOT NULL,"local_title_hash" INTEGER NOT NULL, PRIMARY KEY("item_stable_id", "parent_stable_id"));
CREATE TABLE fake_seen (stable_id INTEGER PRIMARY KEY, sig TEXT, rev TEXT);
INSERT INTO items VALUES(1,"ROOTID",NULL,0,0,1,"application/vnd.google-apps.folder",1,NULL,NULL,NULL,NULL,0,"My Drive",1,NULL,0);
INSERT INTO properties VALUES("root_id", cast("ROOTID" as blob));
INSERT INTO properties VALUES("sync_engine_schema_version", X'"'"'0A1A73796E635F656E67696E655F736368656D615F76657273696F6E1802'"'"');
PRAGMA journal_mode=wal;' >/dev/null || { print "fake DB setup failed"; exit 99 }
LEDGER=$T/ledger.db
$SQL $LEDGER "PRAGMA journal_mode=wal; create table events(id integer primary key, body text); insert into events(body) values('one'),('two'),('three');" >/dev/null
# Drive for desktop and the as2 daemon keep these WAL DBs open; the job opens both -readonly.
mkfifo $T/hold-fdb $T/hold-ledger
$SQL "$FDB" < $T/hold-fdb > $T/hold-fdb.out 2>&1 &!
HOLDERS+=( $! )
$SQL "$LEDGER" < $T/hold-ledger > $T/hold-ledger.out 2>&1 &!
HOLDERS+=( $! )
exec 7>$T/hold-fdb 8>$T/hold-ledger
print "select 'held';" >&7; print "select 'held';" >&8
wait_for "the fake Drive for desktop opening its DB" '[[ -f $T/hold-fdb.out && $(<$T/hold-fdb.out) == held ]]' || bad "a reader holds the fake DriveFS DB open"
wait_for "the fake as2 daemon opening the ledger" '[[ -f $T/hold-ledger.out && $(<$T/hold-ledger.out) == held ]]' || bad "a reader holds the fake ledger open"

# The fake clock every deadline in the job reads (AS2_CLOCK_CMD). It starts at the real time and moves only when
# clock-add.zsh moves it: one second per proof pass (proof-hook.zsh), a popup left open (the alert stubs), and the
# blocked read-back in the proofs part.
print -r -- $EPOCHSECONDS > $T/clock
cat > $T/clock-add.zsh <<'EOF'
#!/bin/zsh
# clock-add.zsh <clock file> <seconds>: moves the fake clock forward; the rename means a reader never sees a part-written file
c=$(<$1) && print -r -- $(( c + $2 )) > $1.tmp.$$ && /bin/mv -f -- $1.tmp.$$ $1
EOF
clock_add() { /bin/zsh $T/clock-add.zsh $T/clock $1 }

# protobuf encoding, as DriveFS stores items.proto (sourced here and by the fake uploader)
cat > $T/proto.zsh <<'EOF'
pv() { local n=$1 o="" b; while true; do b=$(( n & 127 )); n=$(( n >> 7 )); (( n )) && o+=$(printf %02x $(( b | 128 ))) || { o+=$(printf %02x $b); break }; done; print -rn -- $o }
pbs() { local hx=$(print -rn -- "$2" | /usr/bin/xxd -p | /usr/bin/tr -d '\n'); print -rn -- "$(pv $(( ($1 << 3) | 2 )))$(pv $(( ${#hx} / 2 )))$hx" }
pbv() { print -rn -- "$(pv $(( ($1 << 3) | 0 )))$(pv $2)" }
# file proto: id, parent id, title, mime, size, md5 (field 48), head revision (field 78); extra fields optional
fproto() { # <id> <parent id> <title> <size> <md5> <rev> [extra hex]
  print -rn -- "$(pbs 1 $1)$(pbs 2 $2)$(pbs 3 $3)$(pbs 4 application/octet-stream)$(pbv 5 0)$(pbv 14 $4)$(pbs 46 '')$(pbs 48 $5)$(pbs 78 $6)${7:-}"
}
EOF
source $T/proto.zsh

# Fake uploader, one pass per proof pass (the job runs proof-hook.zsh as AS2_PROOF_POLL_HOOK before each one): new
# files appear first as local-N (in local_stable_ids, local-content-size), then get a cloud id, revision and proto; a
# file whose bytes change gets a new revision. Basenames matching a glob in $T/uploader.bad get field 48 = zeros and
# the real md5 inside the title field (an unrelated field must not prove: Drive has not recorded the upload right);
# when a file stops matching (the test clears the glob: Drive recovered) it gets a new revision with the right md5.
# Basenames matching a glob in $T/uploader.dup also get a second live item with the same title in the same folder
# (a proof error: the path is ambiguous) until the test trashes the `dup-*` rows. $T/uploader.mode: good | off.
# $T/uploader.counters carries the next stable id and the revision counter from one pass to the next.
print good > $T/uploader.mode; : > $T/uploader.bad; : > $T/uploader.dup; print "100 0" > $T/uploader.counters
cat > $T/uploader-pass.zsh <<'EOF'
#!/bin/zsh
emulate -L zsh
setopt no_unset pipe_fail extended_glob
zmodload zsh/stat
T=${0:A:h}
DRIVE="$T/CloudStorage/GoogleDrive-test@example.com/My Drive" FDB=$T/metadata_sqlite_db SQL=/usr/bin/sqlite3
source $T/proto.zsh
[[ $(<$T/uploader.mode) == good ]] || exit 0
local -a cnt; cnt=( $(<$T/uploader.counters) )
integer n=${cnt[1]} r=${cnt[2]}
# one read of the whole tree: live (untrashed) children by "<parent stable id>/<title>", every item's id and the
# signature (size:mtime:bad) its last revision was made from; the dup-* rows are the test's, not the uploader's
local -A kid idof sigof
local row p rel parent prev comp cur sid pid sig md5 title bad dup pat rev cid ph
local -a f sz mt
for row in "${(@f)$($SQL -separator $'\t' "$FDB" "select i.stable_id, ifnull(sp.parent_stable_id,''), i.local_title, i.trashed, i.id, ifnull(fs.sig,'') from items i left join stable_parents sp on sp.item_stable_id=i.stable_id left join fake_seen fs on fs.stable_id=i.stable_id where i.id not like 'dup-%'")}"; do
  [[ -n $row ]] || continue
  f=( "${(@ps:\t:)row}" )
  idof[${f[1]}]=${f[5]} sigof[${f[1]}]=${f[6]}
  [[ ${f[4]} == 0 && -n ${f[2]} ]] && kid[${f[2]}/${f[3]}]=${f[1]}
done
for p in "$DRIVE"/**/*(N); do
  [[ -p $p ]] && continue
  rel=${p#$DRIVE/}; parent=1 prev=1 cur=""
  for comp in ${(s:/:)rel}; do
    cur=${cur:+$cur/}$comp
    sid=${kid[$parent/$comp]:-}
    if [[ -z $sid ]]; then
      n=$((n+1)); sid=$n
      if [[ -d $DRIVE/$cur ]]; then
        $SQL "$FDB" "insert into items values($sid,'cloud$sid',NULL,0,0,1,'application/vnd.google-apps.folder',1,NULL,NULL,NULL,0,0,'$comp',1,NULL,0); insert into stable_parents values($sid,$parent,0);" || exit 1
        idof[$sid]=cloud$sid
      else
        $SQL "$FDB" "insert into items values($sid,'local-$sid',NULL,0,0,1,'application/octet-stream',0,NULL,NULL,NULL,0,0,'$comp',1,NULL,0); insert into stable_parents values($sid,$parent,0); insert into local_stable_ids values($sid); insert into item_properties values($sid,'local-content-size',x'01',2);" || exit 1
        idof[$sid]=local-$sid
      fi
      sigof[$sid]="" kid[$parent/$comp]=$sid
    fi
    prev=$parent parent=$sid
  done
  if [[ -f $p ]]; then
    pid=${idof[$prev]:-} sig=${sigof[$parent]:-}
    zstat -A sz +size -- "$p"; zstat -A mt +mtime -- "$p"
    title=${p:t}; bad=0 dup=0
    for pat in ${(f)"$(<$T/uploader.bad)"}; do [[ -n $pat && $title == ${~pat} ]] && bad=1; done
    for pat in ${(f)"$(<$T/uploader.dup)"}; do [[ -n $pat && $title == ${~pat} ]] && dup=1; done
    [[ ${idof[$parent]} == local-* || $sig != "$sz:${mt[1]}:$bad" ]] || continue
    md5=$(/sbin/md5 -q "$p")
    r=$((r+1)); rev="0Bfakerev$(printf %06d $r)xx"
    cid=cloud$parent
    if (( bad )); then ph=$(fproto $cid $pid "$title $md5" $sz 00000000000000000000000000000000 $rev)
    else ph=$(fproto $cid $pid "$title" $sz $md5 $rev); fi
    $SQL "$FDB" "update items set id='$cid', proto=x'$ph', file_size=$sz where stable_id=$parent; delete from local_stable_ids where stable_id=$parent;
      delete from item_properties where item_stable_id=$parent; insert into item_properties values($parent,'local-title',cast('$title' as blob),3),($parent,'version-counter',x'01',2);
      insert or replace into fake_seen values($parent,'$sz:${mt[1]}:$bad','$rev');" || exit 1
    if (( dup )); then
      n=$((n+1))
      $SQL "$FDB" "insert into items select $n,'dup-$parent',NULL,0,0,1,'application/octet-stream',0,NULL,NULL,NULL,$sz,0,'$title',1,NULL,0 where not exists (select 1 from items where id='dup-$parent');
        insert into stable_parents select $n,$prev,0 where exists (select 1 from items where stable_id=$n and id='dup-$parent');" || exit 1
    fi
    idof[$parent]=$cid sigof[$parent]="$sz:${mt[1]}:$bad"
  fi
done
print -r -- "$n $r" > $T/uploader.counters
EOF
cat > $T/proof-hook.zsh <<'EOF'
#!/bin/zsh
# AS2_PROOF_POLL_HOOK: one pass of the fake uploader, then one second of fake time (the proof poll interval) passes
/bin/zsh ${0:A:h}/uploader-pass.zsh || { print -u2 "fake uploader pass failed"; exit 1 }
/bin/zsh ${0:A:h}/clock-add.zsh ${0:A:h}/clock 1
EOF
upmode() { print -r -- $1 > $T/uploader.mode }   # <good|off>: the next proof pass's uploader pass reads it

ARCH=$T/scratch-archive CLAIMS=$T/claims
mkdir -p $ARCH
mk() { local d=$T/payload/${1:h:t}-${1:t}; mkdir -p $d ${1:h}; head -c $2 /dev/urandom > $d/data.bin; tar -czf $1 -C $d . }
: >> $T/orig.sha
# Alert stubs. quiet-alarm exits 0 only after its popup was shown, 1 if it could not be shown. None sleeps:
# alert.zsh's popup is answered at once; alert-holds.zsh's popup stays open until the test creates
# $T/alert-holds.release; alert-stalls.zsh never shows one (it ends when the suite does). A stub whose popup stays
# open moves the fake clock 1000 s on, past the job's result window (AS2_ALERT_ACK), the way real time passes while a
# popup waits. The stubs' own waits poll a release file every 10 ms; their limits are failure-only guards.
cat > $T/alert.zsh <<'EOF'
#!/bin/zsh
print -r -- "ALERT title=$1 | popup=$2" >> ${0:A:h}/alerts.log
print "quiet-alarm: choice=Dismiss (no voice)"
EOF
cat > $T/alert-holds.zsh <<'EOF'
#!/bin/zsh
zmodload zsh/zselect
T=${0:A:h}
print -r -- "ALERT title=$1 | popup=$2" >> $T/alerts.log
/bin/zsh $T/clock-add.zsh $T/clock 1000
for k in {1..6000}; do [[ -e $T/alert-holds.release ]] && break; zselect -t 1; done
[[ -e $T/alert-holds.release ]] || { print -u2 "alert-holds.zsh: the popup was never answered ($T/alert-holds.release absent after 60 s)"; exit 3 }
print "quiet-alarm: choice=Dismiss (no voice)"
EOF
cat > $T/alert-dies.zsh <<'EOF'
#!/bin/zsh
print -r -- "DIES title=$1" >> ${0:A:h}/alerts-dies.log
print -u2 "quiet-alarm: popup FAILED (osascript exit 1): no GUI session"
exit 1
EOF
cat > $T/alert-stalls.zsh <<'EOF'
#!/bin/zsh
zmodload zsh/zselect
T=${0:A:h}
print -r -- "STALLS title=$1" >> $T/alerts-stalls.log
/bin/zsh $T/clock-add.zsh $T/clock 1000
for k in {1..60000}; do [[ -e $T/alert-stalls.release ]] && break; zselect -t 1; done
[[ -e $T/alert-stalls.release ]] || { print -u2 "alert-stalls.zsh: never released ($T/alert-stalls.release absent after 600 s)"; exit 3 }
exit 1
EOF
print -r -- '#!/bin/zsh' > $T/fallback.zsh; print -r -- "print -r -- \"NOTIFICATION \$*\" >> $T/fallback.log" >> $T/fallback.zsh; chmod +x $T/fallback.zsh
# Fake server read (the real one is server-read.zsh, tested by test-server-read.zsh): logs the file and prints
# its sha256 like the real one; $T/evict.mode = ok | fail | schema (the real script's schema-pin refusal text)
print ok > $T/evict.mode
cat > $T/evict.zsh <<EOF
#!/bin/zsh
print -r -- "EVICT \$1 | \$2" >> $T/evict.log
case \$(<$T/evict.mode) in
  fail) print "file rematerialized during the cache check (flags 64, 8 blocks); a local copy may have been read back"; exit 1 ;;
  schema) print "DriveFS content cache schema pin changed: chunks.db schema sha256 ae28, verified 1be3 (table|blob_store|blob_store|CREATE TABLE blob_store(id integer primary key, body blob)). Deletion is blocked until server-read.zsh is re-verified against the new format and PIN_CHUNKS_SCHEMA updated."; exit 1 ;;
esac
h=\$(/usr/bin/shasum -a 256 -- "\$1") || exit 1
print "server read: (fake)"
print "sha256=\${h%% *}"
EOF
: > $T/alerts.log; : > $T/evict.log
snapshot() { (cd $T && find scratch-archive claims CloudStorage -type f 2>/dev/null | sort) }
drive_sums() { (cd "$DRIVE" && find . -type f -exec shasum -a 256 {} + 2>/dev/null | sort -k2) }
alerts() { wc -l < $T/alerts.log | tr -d ' ' }
hb() { jq -r "$1" $T/state/last-run.json }
cdir() { print -r -- $CLAIMS/$1.d }
kvf() { grep "^$2=" $1 | head -1 | cut -d= -f2- }
rcpt_of() { print -r -- $(cdir $1)/receipt }
ed_of() { local l; l=$(<$(cdir $1)/envelope) && print -r -- ${l#envelope_dir=} }
envs_on_drive() { print -rl -- "$DRIVE"/as2-backup/scratch-archive/*/env-*.tar(N) | grep -c . }
nofail() { ! jq -r '.failures[].path' $T/state/last-run.json | grep -q -- "$1" }
osha() { awk -v n="/$1" 'index($2, n) {print $1}' $T/orig.sha }

# The envelope threshold is read from Drive for desktop's content cache next to the metadata DB; empty side files
# and a 800-byte floor keep every archive above it (they go alone) unless a part sets a higher AS2_ENVELOPE_FLOOR.
CC=$T/content_cache; mkdir -p $CC; : > $CC/chunks.db-wal; : > $CC/chunks.db-shm; : > $CC/METADATA
export AS2_DRIVE_ROOT=$DRIVE AS2_DRIVEFS_DB=$FDB AS2_ARCHIVE_ROOT=$ARCH AS2_CLAIMS=$CLAIMS AS2_LEDGER_DB=$LEDGER \
       AS2_ALERT_CMD=$T/alert.zsh AS2_ALERT_FALLBACK=$T/fallback.zsh AS2_ALERT_ACK=1 AS2_SKIP_APP_CHECK=1 \
       AS2_PROOF_POLL=0 AS2_PROOF_TIMEOUT=6 AS2_LOG=$T/state/run.log AS2_CLAIM_QUIET=0 AS2_REPROVE_AFTER=0 \
       AS2_SERVER_READ_CMD=$T/evict.zsh AS2_ENVELOPE_FLOOR=800 \
       AS2_CLOCK_CMD="/bin/cat ${(q)T}/clock" AS2_PROOF_POLL_HOOK="/bin/zsh ${(q)T}/proof-hook.zsh"
# Every run gets its own stamp (AS2_RUNSTAMP), so runs in one second never share a Drive name. The counter is a file,
# so a night run in a background subshell (the blocked read-back in the proofs part) takes a number too.
print 0 > $T/runstamp.counter
next_stamp() { local n=$(( $(<$T/runstamp.counter) + 1 )); print $n > $T/runstamp.counter; STAMP=$(printf '20990101T%06d' $n) }
night() { print "\n### $1"; shift; next_stamp; AS2_RUNSTAMP=$STAMP zsh "$HERE/backup-nightly.zsh" "$@" 2>&1 | sed -E "s#$T#\$T#g"; RC=${pipestatus[1]}; print -r -- "--> exit $RC" }
fresh() { # <date/name> <bytes>: a new public archive, proven by one night (receipt written, not deleted)
  mk $ARCH/$1 $2; AS2_REPROVE_AFTER=999999 night "prove $1" >/dev/null
}

# ---- Drive copies and failures (the round-6 regression and envelope parts) ----
SA="$DRIVE/as2-backup/scratch-archive"
env_copies() { print -rl -- "$SA"/*/${1:t:r}.*.tar(N) | grep -c . }              # <envelope dir>: its copies on Drive
arch_copies() { print -rl -- "$SA"/${1:h}/${${1:t}%.tar.gz}.*.tar.gz(N) | grep -c . }   # <date>/<name>: its copies on Drive
fail_step() { jq -r --arg p "$1" '.failures[] | select(.path == $p or (.path | endswith($p))) | .step' $T/state/last-run.json }
fail_text() { jq -r --arg p "$1" '.failures[] | select(.path == $p or (.path | endswith($p))) | .error' $T/state/last-run.json }
# A Drive folder a copy can land in while cp still fails: every new file in it inherits an entry that denies writing
# its attributes, so cp writes all the bytes and then exits 1 ("could not copy extended attributes").
copy_fails_after_landing() { mkdir -p "$1" && /bin/chmod +a "everyone deny writeattr,writeextattr,writesecurity,file_inherit" "$1" }
# A Drive folder whose entries do not answer a stat (permission denied): the existence check of a recorded copy fails
stat_fails() { /bin/chmod -N "$1" && /bin/chmod +a "everyone deny search" "$1" }
answers_again() { /bin/chmod -N "$1" }

# ---- crash cases (test-fake-drive-crash*.zsh) ----
RCPT=$T/state/receipts
# marker_ok <original> <envelope Drive path>: its .offsite names that envelope and the member's own sha256
marker_ok() { [[ -f $1.offsite && $(kvf $1.offsite envelope_drive_path) == $2 && $(kvf $1.offsite sha256) == $(osha ${1:t}) ]] }
# step[:n] (AS2_CRASH_AFTER) -> what the killed run must have left (a = first member, b = second)
typeset -A CRASH_LEFT
CRASH_LEFT=(
  marker          '-f $a.offsite && -f $ca/${a:t} && ! -e $b.offsite'
  unlink          '-f $a.offsite && -d $ca && ! -e $ca/${a:t} && ! -e $ca/receipt && -f $cb/${b:t}'
  member-receipt  '-f $ca/receipt && ! -e $ca/${a:t} && -f $cb/${b:t}'
  claim-moved     '! -e $ca && -d $RCPT/$day/${a:t} && -f $cb/${b:t} && -d $E'
  envelope-moved  '! -e $E && -f $RCPT/envelopes/${E:h:t}/${E:t}/receipt && ! -e $ca && ! -e $cb'
  unlink:2        '! -e $ca && -f $RCPT/$day/${a:t}/receipt && -f $b.offsite && -d $cb && ! -e $cb/${b:t}'
)
# crash_case <k> <step>: a two-member envelope (members wl-r<k>a, wl-r<k>b on 2026-11-0<k>) proven; its deleting run
# killed right after <step> (AS2_CRASH_AFTER); then the next run must converge (no failure, no new upload, the same
# envelope count on Drive, both members retired, the envelope retired) and a further run must report nothing.
# Leaves day a b ca cb E EOBJ n0 set for the caller.
crash_case() {
  local k=$1 step=$2
  day=2026-11-0$k a=$ARCH/2026-11-0$k/wl-r${k}a.tar.gz b=$ARCH/2026-11-0$k/wl-r${k}b.tar.gz
  mk $a 100; mk $b 200; shasum -a 256 $a $b >> $T/orig.sha
  ca=$(cdir $day/${a:t}) cb=$(cdir $day/${b:t})
  print "\n### crash case $k: killed right after '$step'"
  AS2_REPROVE_AFTER=999999 night "case $k: a two-member envelope, proven" >/dev/null
  E=$(ed_of $day/${a:t}); EOBJ=$(kvf $E/receipt drive_path); n0=$(envs_on_drive)
  check "case $k: both members in one proven envelope, nothing deleted yet" '[[ -n $E && -f $E/receipt && $(ed_of $day/${b:t}) == $E && -f $ca/${a:t} && -f $cb/${b:t} ]]'
  AS2_CRASH_AFTER=$step night "case $k: the deleting run, killed right after '$step'"
  check "case $k: the run was killed right after '$step' and left that state" '(( RC == 137 )) && grep -q "AS2_CRASH_AFTER=$step: killing this run" $T/state/run.log && [[ '"${CRASH_LEFT[$step]}"' ]]'
  night "case $k: the next run after the crash"
  check "case $k: converges: exit 0, no failure, no new upload, $n0 envelope(s) on Drive as before" '[[ $RC == 0 && $(hb .counts.failed) == 0 && $(hb .counts.uploaded) == 0 && $(envs_on_drive) == $n0 ]]'
  check "case $k: both members retired: markers name the envelope, receipts in receipts/ with no local copy of either archive, claim dirs and .attempts gone, the envelope retired" 'marker_ok $a $EOBJ && marker_ok $b $EOBJ && [[ ! -e $ca && ! -e $cb && ! -e $a && ! -e $b && -f $RCPT/$day/${a:t}/receipt && -f $RCPT/$day/${b:t}/receipt && ! -e $RCPT/$day/${a:t}/${a:t} && ! -e $RCPT/$day/${b:t}/${b:t} && $(kvf $RCPT/$day/${a:t}/receipt envelope_drive_path) == $EOBJ && ! -e $a.attempts && ! -e $b.attempts && ! -e $E && -f $RCPT/envelopes/${E:h:t}/${E:t}/receipt ]]'
  night "case $k: a further run"
  check "case $k: a further run reports nothing: exit 0, no failure, nothing deleted or uploaded" '[[ $RC == 0 && $(hb .counts.failed) == 0 && $(hb .counts.offsite_and_deleted) == 0 && $(hb .counts.uploaded) == 0 ]]'
}

suite_end() { # the part's last line: the alerts it raised, the ledger untouched, RESULT, exit with the failure count
  print "\n### alerts raised (stub log):"; sed -E "s#$T#\$T#g; s/^/    /" $T/alerts.log | cut -c1-300
  print "\n### live (fake) ledger untouched: $($SQL $LEDGER 'select count(*) from events') rows"
  print "\nRESULT: $FAILS failure(s)"
  exit $FAILS
}
