#!/bin/zsh
# Self-test against a fake Drive root, a fake DriveFS metadata DB (the real table definitions, a protobuf `proto`
# encoded like Drive for desktop's), a fake server read and stub alert commands. The real server-read.zsh gate
# has its own fixtures in test-server-read.zsh, which this test runs first.
# Contained: every path it writes is under the temp dir T it creates (HOME, TMPDIR, the job's temp dir, fake
# Drive, fake archives, claims, state, alert results). T is left in place at the end for inspection; nothing is
# moved or written outside it. It never touches the real Drive, archives, ledger or launchd.
#   zsh test-fake-drive.zsh        prints PASS/FAIL lines, ends with "RESULT: <n> failure(s)", exits n
# Deterministic (Jo's timing rule, decision log 2026-10-28--0840): nothing here sleeps or races a background process.
# Time comes from the job's test seams: AS2_CLOCK_CMD reads the fake clock $T/clock, which stands still unless a step
# moves it; AS2_PROOF_POLL_HOOK runs one pass of the fake uploader and then moves that clock one second before each
# proof pass (AS2_PROOF_POLL=0: no real wait between passes), so "never proves within AS2_PROOF_TIMEOUT=N" is N
# passes; AS2_RUNSTAMP gives every run its own stamp. Each test that drives a deadline is marked
# `timing-under-test`. Every other wait is on a real event with a failure-only guard (wait_for, 30 s).
emulate -L zsh
setopt no_unset pipe_fail extended_glob
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
zmodload zsh/datetime zsh/system zsh/stat zsh/zselect
HERE=${0:A:h}
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

# Processes the suite starts and must end: the two DB holders, a fake "running nightly", a backgrounded night.
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

print "\n### the real server-read gate (server-read.zsh) against modelled macOS observations"
mkdir -p $T/server-read-fixtures
srout=$(zsh "$HERE/test-server-read.zsh" "$HERE/server-read.zsh" $T/server-read-fixtures 2>&1); src=$?
print -r -- "$srout" | sed -E "s#$T#\$T#g"
for l in ${(f)srout}; do case $l in PASS:*) ok "server-read: ${l#PASS: }";; FAIL:*) bad "server-read: ${l#FAIL: }";; esac; done
check "server-read fixtures: exit 0" '(( src == 0 ))'

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
# blocked read-back below.
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
# the real md5 inside the title field (an unrelated field must not prove). $T/uploader.mode: good | off.
# $T/uploader.counters carries the next stable id and the revision counter from one pass to the next.
print good > $T/uploader.mode; : > $T/uploader.bad; print "100 0" > $T/uploader.counters
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
# signature (size:mtime) its last revision was made from
local -A kid idof sigof
local row p rel parent prev comp cur sid pid sig md5 title bad pat rev cid ph
local -a f sz mt
for row in "${(@f)$($SQL -separator $'\t' "$FDB" "select i.stable_id, ifnull(sp.parent_stable_id,''), i.local_title, i.trashed, i.id, ifnull(fs.sig,'') from items i left join stable_parents sp on sp.item_stable_id=i.stable_id left join fake_seen fs on fs.stable_id=i.stable_id")}"; do
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
    [[ ${idof[$parent]} == local-* || $sig != "$sz:${mt[1]}" ]] || continue
    md5=$(/sbin/md5 -q "$p"); title=${p:t}; bad=0
    for pat in ${(f)"$(<$T/uploader.bad)"}; do [[ -n $pat && $title == ${~pat} ]] && bad=1; done
    r=$((r+1)); rev="0Bfakerev$(printf %06d $r)xx"
    cid=cloud$parent
    if (( bad )); then ph=$(fproto $cid $pid "$title $md5" $sz 00000000000000000000000000000000 $rev)
    else ph=$(fproto $cid $pid "$title" $sz $md5 $rev); fi
    $SQL "$FDB" "update items set id='$cid', proto=x'$ph', file_size=$sz where stable_id=$parent; delete from local_stable_ids where stable_id=$parent;
      delete from item_properties where item_stable_id=$parent; insert into item_properties values($parent,'local-title',cast('$title' as blob),3),($parent,'version-counter',x'01',2);
      insert or replace into fake_seen values($parent,'$sz:${mt[1]}','$rev');" || exit 1
    idof[$parent]=$cid sigof[$parent]="$sz:${mt[1]}"
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
mkdir -p $ARCH/2026-10-20 $ARCH/2026-10-27 $ARCH/2026-10-28
mk() { local d=$T/payload/${1:h:t}-${1:t}; mkdir -p $d; head -c $2 /dev/urandom > $d/data.bin; tar -czf $1 -C $d . }
mk $ARCH/2026-10-27/wl-aaa.tar.gz 300000
mk $ARCH/2026-10-28/wl-bbb.tar.gz 200000
mk $ARCH/2026-10-28/wl-bbb.2.tar.gz 100000
print junk > $ARCH/2026-10-28/wl-ccc.tar.gz.partial-0123456789ab      # in-progress tar: never touched
mk $T/src/linked.tar.gz 1000; ln $T/src/linked.tar.gz $ARCH/2026-10-28/wl-lnk.tar.gz   # nlink 2: producer mid-link
print "drive_path=old" > $ARCH/2026-10-20/wl-old.tar.gz.offsite         # an old marker, archive long gone
for f in $ARCH/*/*.tar.gz; do shasum -a 256 $f; done > $T/orig.sha
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

# The envelope threshold is read from Drive for desktop's content cache next to the metadata DB; empty side files
# and a 800-byte floor keep every archive above it (they go alone) until the envelope section below.
CC=$T/content_cache; mkdir -p $CC; : > $CC/chunks.db-wal; : > $CC/chunks.db-shm; : > $CC/METADATA
export AS2_DRIVE_ROOT=$DRIVE AS2_DRIVEFS_DB=$FDB AS2_ARCHIVE_ROOT=$ARCH AS2_CLAIMS=$CLAIMS AS2_LEDGER_DB=$LEDGER \
       AS2_ALERT_CMD=$T/alert.zsh AS2_ALERT_FALLBACK=$T/fallback.zsh AS2_ALERT_ACK=1 AS2_SKIP_APP_CHECK=1 \
       AS2_PROOF_POLL=0 AS2_PROOF_TIMEOUT=6 AS2_LOG=$T/state/run.log AS2_CLAIM_QUIET=0 AS2_REPROVE_AFTER=0 \
       AS2_SERVER_READ_CMD=$T/evict.zsh AS2_ENVELOPE_FLOOR=800 \
       AS2_CLOCK_CMD="/bin/cat ${(q)T}/clock" AS2_PROOF_POLL_HOOK="/bin/zsh ${(q)T}/proof-hook.zsh"
# Every run gets its own stamp (AS2_RUNSTAMP), so runs in one second never share a Drive name. The counter is a file,
# so a night run in a background subshell (the blocked read-back below) takes a number too.
print 0 > $T/runstamp.counter
next_stamp() { local n=$(( $(<$T/runstamp.counter) + 1 )); print $n > $T/runstamp.counter; STAMP=$(printf '20990101T%06d' $n) }
night() { print "\n### $1"; shift; next_stamp; AS2_RUNSTAMP=$STAMP zsh "$HERE/backup-nightly.zsh" "$@" 2>&1 | sed -E "s#$T#\$T#g"; RC=${pipestatus[1]}; print -r -- "--> exit $RC" }

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

# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=4 (fake clock: AS2_CLOCK_CMD)
AS2_PROOF_TIMEOUT=4 night "night 2: deleting re-proof for aaa and bbb.2; bbb re-proves its old copy and fails again"
check "aaa and bbb.2 deleted after re-proof + server read-back; .offsite at the original path; .attempts gone" '[[ $(hb .counts.offsite_and_deleted) == 2 && ! -e $(cdir 2026-10-27/wl-aaa.tar.gz) && -f $ARCH/2026-10-27/wl-aaa.tar.gz.offsite && ! -e $ARCH/2026-10-27/wl-aaa.tar.gz.attempts && -f $T/state/receipts/2026-10-27/wl-aaa.tar.gz/receipt ]]'
check "the Drive copy was read through the server-read gate" 'grep -q "EVICT .*/wl-aaa\.[0-9a-f]*\..*\.tar\.gz" $T/evict.log && grep -q "read back from Google.s servers (proven server read)" $T/state/run.log'
check "marker records item id, revision, sha256 and both proofs" 'grep -q "^drive_revision=0Bfakerev" $ARCH/2026-10-27/wl-aaa.tar.gz.offsite && grep -q "^reproven_at=" $ARCH/2026-10-27/wl-aaa.tar.gz.offsite && grep -q "^sha256=[0-9a-f]\{64\}$" $ARCH/2026-10-27/wl-aaa.tar.gz.offsite'
check "bbb re-proved its earlier copy (no new upload), count 2" '[[ $(hb .counts.uploaded) == 0 && $(head -1 $(cdir 2026-10-28/wl-bbb.tar.gz)/attempts) == 2 ]] && grep -q "re-proving the earlier upload" $T/state/run.log'
check "night 2 wrote a second ledger object; the first one is unchanged" '[[ $(wc -l < $T/state/ledger-snapshots.tsv | tr -d " ") == 2 ]] && print -r -- "$sums1" | (cd "$DRIVE" && shasum -a 256 -c - >/dev/null)'

# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=4 (fake clock: AS2_CLOCK_CMD)
AS2_PROOF_TIMEOUT=4 night "night 3: bbb uploads afresh (new name), still fails, reaches the limit"
check "after night 3: stuck in claims and at the original path, count 3" '[[ -f $(cdir 2026-10-28/wl-bbb.tar.gz)/stuck && -f $ARCH/2026-10-28/wl-bbb.tar.gz.stuck && $(head -1 $(cdir 2026-10-28/wl-bbb.tar.gz)/attempts) == 3 && $(hb .counts.uploaded) == 1 ]]'
check "night 3 alert names wl-bbb as STUCK; heartbeat newly_stuck lists it" 'tail -1 $T/alerts.log | grep -q "STUCK.*wl-bbb.tar.gz" && [[ $(hb ".newly_stuck[0]") == *wl-bbb.tar.gz ]]'
n_alerts=$(alerts)
night "night 4: stuck archive is skipped, not retried"
check "night 4: exit 0, skipped_stuck 1, no upload, no new alert" '[[ $RC == 0 && $(hb .counts.skipped_stuck) == 1 && $(hb .counts.uploaded) == 0 && $(alerts) == $n_alerts ]]'

: > $T/uploader.bad; rm -f $(cdir 2026-10-28/wl-bbb.tar.gz)/stuck
night "night 5: a person cleared claims/.../stuck and the cause; bbb re-proves its last (bad) copy once, then"
night "night 6: bbb uploads a fresh copy and proves it"
night "night 7: bbb deleted after re-proof"
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

# ---------- adversarial proof cases (B1/B2) ----------
# helpers: the newest claim's receipt and its item
rcpt_of() { print -r -- $(cdir $1)/receipt }
item_sid() { $SQL "$FDB" "select stable_id from items where id='$(grep '^drive_item_id=' $1 | cut -d= -f2)'" }
fresh() { # <date/name> <bytes>: a new public archive, proven by one night (receipt written, not deleted)
  mk $ARCH/$1 $2; AS2_REPROVE_AFTER=999999 night "prove $1" >/dev/null
}

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

print "\n### small archives travel in a nightly envelope (OpenAI review round 5, R5-B1)"
kvf() { grep "^$2=" $1 | head -1 | cut -d= -f2- }
ed_of() { local l; l=$(<$(cdir $1)/envelope) && print -r -- ${l#envelope_dir=} }
envs_on_drive() { print -rl -- "$DRIVE"/as2-backup/scratch-archive/*/env-*.tar(N) | grep -c . }
nofail() { ! jq -r '.failures[].path' $T/state/last-run.json | grep -q -- "$1" }
osha() { awk -v n="/$1" 'index($2, n) {print $1}' $T/orig.sha }
night "settle the earlier archives before the envelope section" >/dev/null
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
E4=$(ed_of 2026-10-29/wl-t4.tar.gz)
check "envelope proof failure: both members kept, one failure naming the envelope and both members" '(( RC != 0 )) && [[ -f $(cdir 2026-10-29/wl-t4.tar.gz)/wl-t4.tar.gz && -f $(cdir 2026-10-29/wl-t5.tar.gz)/wl-t5.tar.gz && ! -e $ARCH/2026-10-29/wl-t4.tar.gz.offsite && $(head -1 $E4/attempts) == 1 ]] && jq -r ".failures[] | select(.path == \"$E4\") | .error" $T/state/last-run.json | grep -q "all kept: .*wl-t4.tar.gz, .*wl-t5.tar.gz"'
AS2_ENVELOPE_FLOOR=60000 AS2_PROOF_TIMEOUT=4 night "envelope never proves (night 2)" >/dev/null
AS2_ENVELOPE_FLOOR=60000 AS2_PROOF_TIMEOUT=4 night "envelope never proves (night 3)"
check "third failed night: envelope STUCK, each member has .stuck, the alert names the envelope and both members" '[[ -f $E4/stuck && -f $ARCH/2026-10-29/wl-t4.tar.gz.stuck && -f $ARCH/2026-10-29/wl-t5.tar.gz.stuck ]] && tail -1 $T/alerts.log | grep -q "STUCK.*envelope .*wl-t4.tar.gz, .*wl-t5.tar.gz"'
check "no member was deleted on any failing night" '[[ -f $(cdir 2026-10-29/wl-t4.tar.gz)/wl-t4.tar.gz && -f $(cdir 2026-10-29/wl-t5.tar.gz)/wl-t5.tar.gz && ! -e $ARCH/2026-10-29/wl-t5.tar.gz.offsite ]]'
AS2_ENVELOPE_FLOOR=60000 night "a stuck envelope is skipped" >/dev/null
check "stuck envelope skipped, not retried" '[[ $(hb ".skipped_stuck | map(select(. == \"$E4\")) | length") == 1 ]]'
: > $T/uploader.bad; rm -f $E4/stuck
for k in 1 2 3; do AS2_ENVELOPE_FLOOR=60000 night "cleared: envelope retries ($k)" >/dev/null; done
check "after a person cleared it: both members retired, .stuck and .attempts gone" '[[ ! -e $(cdir 2026-10-29/wl-t4.tar.gz) && ! -e $(cdir 2026-10-29/wl-t5.tar.gz) && -f $ARCH/2026-10-29/wl-t5.tar.gz.offsite && ! -e $ARCH/2026-10-29/wl-t4.tar.gz.stuck && ! -e $ARCH/2026-10-29/wl-t4.tar.gz.attempts && ! -e $E4 ]]'

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
E5=$(ed_of 2026-10-29/wl-c2.tar.gz); rm -f $E5/upload_retried $E5/attempts   # the state a run leaves when it stops right after the copy
n0=$(envs_on_drive)
upmode good
AS2_ENVELOPE_FLOOR=60000 AS2_REPROVE_AFTER=999999 night "after a run stopped after the copy"
check "stopped after the copy: the same Drive copy is re-proven, no second upload" '[[ -f $E5/receipt && $(hb .counts.uploaded) == 0 && $(envs_on_drive) == $n0 ]] && grep -q "re-proving the earlier envelope upload" $T/state/run.log'
mk $ARCH/2026-10-29/wl-c3.tar.gz 100
upmode off
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=2 (fake clock: AS2_CLOCK_CMD)
AS2_ENVELOPE_FLOOR=60000 AS2_PROOF_TIMEOUT=2 night "another envelope, never proven" >/dev/null
E6=$(ed_of 2026-10-29/wl-c3.tar.gz); c3obj=$(kvf $E6/upload drive_path)
mv "$c3obj" $T/c3-env.bak; rm -f $E6/upload_retried $E6/attempts   # the state a run leaves when it stops after recording the upload, before the copy
upmode good
AS2_ENVELOPE_FLOOR=60000 AS2_REPROVE_AFTER=999999 night "after a run stopped before the copy"
check "stopped before the copy: the envelope is built again, uploaded once under a new name and proven" '[[ -f $E6/receipt && $(kvf $E6/receipt drive_path) != $c3obj && $(hb .counts.uploaded) == 1 ]] && grep -q "is not on Drive (a run stopped before the copy)" $T/state/run.log'
mk $ARCH/2026-10-29/wl-d1.tar.gz 100; mk $ARCH/2026-10-29/wl-d2.tar.gz 100
AS2_ENVELOPE_FLOOR=60000 AS2_REPROVE_AFTER=999999 night "two members, proven" >/dev/null
E7=$(ed_of 2026-10-29/wl-d1.tar.gz); E7OBJ=$(kvf $E7/receipt drive_path); d1=$(cdir 2026-10-29/wl-d1.tar.gz)
# the state a run leaves when it stops after retiring wl-d1 and before wl-d2: marker written, d1 deleted and its dir moved
print -r -- "envelope_drive_path=$E7OBJ" > $ARCH/2026-10-29/wl-d1.tar.gz.offsite; rm -f $d1/wl-d1.tar.gz
mkdir -p $T/state/receipts/2026-10-29; mv $d1 $T/state/receipts/2026-10-29/wl-d1.tar.gz
night "after a run stopped part-way through an envelope's deletions"
check "stopped mid-deletion: wl-d1 counted as done, wl-d2 deleted, the envelope retired, no failure for it" 'nofail $E7 && nofail wl-d2 && [[ ! -e $(cdir 2026-10-29/wl-d2.tar.gz) && -f $ARCH/2026-10-29/wl-d2.tar.gz.offsite && ! -e $E7 && -f $T/state/receipts/envelopes/${E7:h:t}/${E7:t}/receipt ]]'
check "every crash case ends with all small archives retired (c1, c2, c3 deleted after their envelopes)" '[[ ! -e $(cdir 2026-10-29/wl-c1.tar.gz) && ! -e $(cdir 2026-10-29/wl-c2.tar.gz) && ! -e $(cdir 2026-10-29/wl-c3.tar.gz) && -f $ARCH/2026-10-29/wl-c3.tar.gz.offsite ]]'

print "\n### proof source layout drift stops the run before anything is touched"
before=$(snapshot)
$SQL "$FDB" "update properties set value=x'0A1A73796E635F656E67696E655F736368656D615F76657273696F6E1803' where property='sync_engine_schema_version'"
night "schema version changed"
check "schema drift: setup-failed at drivefs-schema, nothing touched" '(( RC != 0 )) && [[ $(hb .result) == setup-failed && $(hb ".failures[0].step") == drivefs-schema && $(snapshot) == $before ]]'
$SQL "$FDB" "update properties set value=x'0A1A73796E635F656E67696E655F736368656D615F76657273696F6E1802' where property='sync_engine_schema_version'"

print "\n### setup failures stop at once and still write a heartbeat"
AS2_DRIVE_ROOT=$T/no-such-drive night "Drive root absent"
check "absent Drive root: setup-failed, nothing touched" '(( RC != 0 )) && [[ $(hb .result) == setup-failed && $(hb ".failures[0].step") == drive-root && $(snapshot) == $before ]]'
AS2_TMPDIR=$T/no-such-tmp night "temp dir cannot be created"
check "no temp dir: setup-failed at tempdir, nothing touched" '(( RC != 0 )) && [[ $(hb .result) == setup-failed && $(hb ".failures[0].step") == tempdir && $(snapshot) == $before ]]'
mv $ARCH $T/arch-moved
night "archive root vanished after it was seen"
check "missing archive root (seen before): setup-failed at archive-root" '(( RC != 0 )) && [[ $(hb ".failures[0].step") == archive-root ]]'
mv $T/arch-moved $ARCH
zsystem flock -f HOLD $T/state/backup-nightly.lock
night "another run holds the lock"
check "lock held: setup-failed at lock" '(( RC != 0 )) && [[ $(hb ".failures[0].step") == lock ]]'
zsystem flock -u $HOLD

print "\n### archive root that never existed is tracked, not silent"
AS2_ARCHIVE_ROOT=$T/never AS2_LOG=$T/state2/run.log night "fresh install, no archive root yet" >/dev/null 2>&1; mkdir -p $T/state2
AS2_ARCHIVE_ROOT=$T/never AS2_LOG=$T/state2/run.log night "fresh install, no archive root yet" >/dev/null
check "absent-never-seen recorded" '[[ $(jq -r .archive_root $T/state2/last-run.json) == absent-never-seen ]]'
print $(( EPOCHSECONDS - 8*86400 )) > $T/state2/first-run-epoch
out=$(AS2_ARCHIVE_ROOT=$T/never AS2_LOG=$T/state2/run.log zsh "$HERE/check-backup-fresh.zsh" 2>&1)
check "checker flags a root that has never existed after 7 days" '[[ $out == *"has never existed"* ]]'

print "\n### alert delivery and state-write failures are reported"
mk $ARCH/2026-10-28/wl-al.tar.gz 1000
print 'wl-al.????????????????.*.tar.gz' > $T/uploader.bad; upmode good
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=3, and the alert's ALERT_ACK result window: the dying popup
# stub's result arrives before the fake clock moves (fake clock: AS2_CLOCK_CMD)
AS2_ALERT_CMD=$T/alert-dies.zsh AS2_PROOF_TIMEOUT=3 night "a failing night whose popup cannot be shown" >/dev/null
check "popup failure recorded at once; notification sent" '[[ $(hb .alert) == failed* && $(hb .alert) == *"notification rc 0"* ]] && grep -q NOTIFICATION $T/fallback.log'
out=$(zsh "$HERE/check-backup-fresh.zsh" 2>&1)
check "checker reports the nightly's failed popup" '[[ $out == *"own alert: not delivered"* ]]'
# timing-under-test: proof deadline, AS2_PROOF_TIMEOUT=3, and the alert's ALERT_ACK result window: the stalled stub
# moves the fake clock past it (fake clock: AS2_CLOCK_CMD)
AS2_ALERT_CMD=$T/alert-stalls.zsh AS2_PROOF_TIMEOUT=3 night "a failing night whose popup stalls without showing" >/dev/null
stall_res=$(hb .alert_result)
check "stalled popup is never called delivered" '[[ $(hb .alert) == sent* && ! -f $(hb .alert_result) ]]'
out=$(AS2_NOW_EPOCH=$(( EPOCHSECONDS + 7*3600 )) zsh "$HERE/check-backup-fresh.zsh" 2>&1)
check "7 h later, no result: the checker alarms (no sign the popup was shown)" '[[ $out == *"no sign the popup was shown"* ]]'
out=$(zsh "$HERE/check-backup-fresh.zsh" 2>&1)
check "inside the 6 h window, no alarm about that popup yet" '[[ $out != *"no sign the popup was shown"* ]]'
# the stalled stub ends now (it exits 1: never shown); wait for its result so nothing writes into $T later
: > $T/alert-stalls.release
wait_for "the stalled popup stub ending" '[[ -f $stall_res ]]' || bad "the stalled popup stub ended when released"
mv $T/state/last-run.json $T/lr.bak; mkdir $T/state/last-run.json
night "heartbeat cannot be written" >/dev/null
check "heartbeat write failure becomes a failure and is alerted" '(( RC != 0 )) && tail -1 $T/alerts.log | grep -q "failure"' 
rmdir $T/state/last-run.json; mv $T/lr.bak $T/state/last-run.json
: > $T/uploader.bad

print "\n### check-backup-fresh.zsh"
chk() { print "\n--- check: $1"; shift; env "$@" zsh "$HERE/check-backup-fresh.zsh" 2>&1 | sed -E "s#$T#\$T#g"; CRC=${pipestatus[1]} }
night "a good night before the checks" >/dev/null; night "and its re-proof night" >/dev/null
rm -f $T/state/last-check.json
chk "fresh success" X=1
check "fresh success: exit 0, last-check.json ok (or only notes)" '[[ $(jq -r .result $T/state/last-check.json) == ok ]] || jq -r ".problems[]" $T/state/last-check.json'
chk "30 h later" AS2_NOW_EPOCH=$(( EPOCHSECONDS + 30*3600 ))
check "stale heartbeat flagged with the sleep/power-off wording" '(( CRC != 0 )) && tail -1 $T/alerts.log | grep -q "powered off"'
# A live process whose command line names backup-nightly.zsh, standing in for a nightly run in progress until the
# test kills it (a release file is its failure-only 600 s guard)
/usr/bin/perl -e 'for (1..60000) { exit 0 if -e $ARGV[1]; select(undef, undef, undef, 0.01) } exit 3' backup-nightly.zsh $T/fake-run.release &!
fakepid=$!; FAKE_RUNNING+=( $fakepid )
print "{\"pid\":$fakepid,\"mode\":\"run\",\"start_epoch\":$(( EPOCHSECONDS - 600 )),\"step\":\"copy to Drive x\",\"step_deadline_epoch\":$(( EPOCHSECONDS + 3000 )),\"updated_epoch\":$EPOCHSECONDS}" > $T/state/progress.json
jq '.end_epoch -= 27*3600' $T/state/last-run.json > $T/lr27 && cp $T/state/last-run.json $T/lr.real && mv $T/lr27 $T/state/last-run.json
chk "last run ended 27 h ago, but a catch-up run is in progress" X=1
mv $T/lr.real $T/state/last-run.json
check "in-progress run noted, not alarmed as stale" '[[ $(jq -r ".notes[0]" $T/state/last-check.json) == *"in progress"* ]] && ! jq -r ".problems[]" $T/state/last-check.json | grep -q "limit 26 h"'
print "{\"pid\":$fakepid,\"mode\":\"run\",\"start_epoch\":$(( EPOCHSECONDS - 600 )),\"step\":\"copy to Drive x\",\"step_deadline_epoch\":$(( EPOCHSECONDS - 3600 )),\"updated_epoch\":$EPOCHSECONDS}" > $T/state/progress.json
chk "a run past its step deadline" X=1
check "hung run flagged" '(( CRC != 0 )) && tail -1 $T/alerts.log | grep -q "is hung"'
kill $fakepid 2>/dev/null; print '{"pid":1,"mode":"run","start_epoch":1,"step":"finished","step_deadline_epoch":0,"updated_epoch":1,"finished":true}' > $T/state/progress.json
wait_for "the stand-in nightly process exiting" 'all_gone $fakepid' || bad "the stand-in nightly process ended"
FAKE_RUNNING=( ${FAKE_RUNNING:#$fakepid} )
mk $ARCH/2026-10-28/wl-old.tar.gz 1000; print "drive_path=x" > $ARCH/2026-10-28/wl-old.tar.gz.offsite; touch -t 202610200000 $ARCH/2026-10-28/wl-old.tar.gz
chk "public archive older than 3 days beside a marker" X=1
check "old public archive flagged even with a marker" '(( CRC != 0 )) && tail -1 $T/alerts.log | grep -q "wl-old.tar.gz (has an .offsite marker"'
mv $ARCH/2026-10-28/wl-old.tar.gz $ARCH/2026-10-28/wl-old.tar.gz.offsite $T/src/
print $(( EPOCHSECONDS - 4*86400 )) > $(cdir 2026-10-28/wl-tr.tar.gz)/claimed_epoch
chk "claimed archive older than 3 days" X=1
check "old claimed archive flagged by name" '(( CRC != 0 )) && tail -1 $T/alerts.log | grep -q "claimed archive.*wl-tr.tar.gz (STUCK"'
mv $T/state/last-run.json $T/last-run.json.bak
chk "no heartbeat at all" X=1
check "missing heartbeat flagged" '(( CRC != 0 )) && tail -1 $T/alerts.log | grep -q "never finished a run"'
mv $T/last-run.json.bak $T/state/last-run.json
chk "Sunday restore test (forced)" AS2_FORCE_VERIFY=1
check "Sunday: verify-restore runs (bounded) and passes" 'grep -q "restore OK" $T/state/check-backup-fresh.log && ! jq -r ".problems[]" $T/state/last-check.json | grep -q "restore test failed"'
mv $T/state/last-check.json $T/lc.bak; mkdir $T/state/last-check.json
chk "checker state cannot be written" X=1
check "checker heartbeat write failure is a problem" '(( CRC != 0 )) && tail -1 $T/alerts.log | grep -q "could not write"'
rmdir $T/state/last-check.json; mv $T/lc.bak $T/state/last-check.json

print "\n### the nightly watches the watcher"
jq '.at_epoch = 0' $T/state/last-check.json > $T/lc && mv $T/lc $T/state/last-check.json
night "stale last-check.json" >/dev/null
check "stale watcher reported" 'jq -r ".failures[].step" $T/state/last-run.json | grep -qx watcher'
print 'not json' > $T/state/last-check.json
night "malformed last-check.json" >/dev/null
check "malformed watcher state reported" 'jq -r ".failures[].error" $T/state/last-run.json | grep -q malformed'
rm -f $T/state/last-check.json; print $(( EPOCHSECONDS - 40*3600 )) > $T/state/first-run-epoch
night "watcher never ran, 40 h after the first run" >/dev/null
check "never-started watcher reported" 'jq -r ".failures[].error" $T/state/last-run.json | grep -q "never written last-check.json"'

print "\n### alerts raised (stub log):"; sed -E "s#$T#\$T#g; s/^/    /" $T/alerts.log | cut -c1-300
print "\n### live (fake) ledger untouched: $($SQL $LEDGER 'select count(*) from events') rows"
print "\nRESULT: $FAILS failure(s)"
exit $FAILS
