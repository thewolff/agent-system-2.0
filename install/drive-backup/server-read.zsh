#!/bin/zsh
# Read one file in My Drive from Google's servers: evict Drive for desktop's local copy, prove that no complete
# local copy is left anywhere this Mac could serve it from, then read it, and print its sha256.
#   zsh server-read.zsh <file in My Drive> <DriveFS account dir, the one holding metadata_sqlite_db>
# Exit 0 and the last line "sha256=<64 hex>" only when every step below holds; exit 1 and the reason otherwise.
# The caller deletes a local archive only on exit 0 with the receipt's sha256, so every unclear case fails.
#
#   1. NSFileManager evictUbiquitousItemAtURL:error: on the file succeeds. Apple: "It removes only the local
#      version." Nothing else is evicted, and nothing in the cache is touched (this script only reads it).
#   2. The file becomes dataless (SF_DATALESS 0x40000000 in st_flags, 0 blocks) within 20 s.
#   3. Drive for desktop's content cache has the layout and format verified on 2026-10-28 and can hold fewer
#      bytes than the file, so it cannot hold a complete copy. The layout is pinned: <account dir>/content_cache
#      holds only the regular files chunks.db, chunks.db-shm, chunks.db-wal and METADATA plus directories
#      d<number>, and each d<number> holds only regular files. Anything else (another entry, a subdirectory, a
#      symlink, an entry that cannot be read or stat'ed) fails: an unrecognised place could hold a full copy.
#      chunks.db is opened read-only and its schema is pinned (PIN_CHUNKS_SCHEMA); a changed schema fails as
#      "schema pin changed". The bytes counted as cached are: every d<number> file, the byte length of every
#      column of every row in chunks.db, and the whole -wal, -shm and METADATA files. A download passes through
#      the cache and leaves it within about a minute, so the script waits up to 120 s for it to drain.
#      Cost of counting the -wal whole: while it is large (1,685,112 bytes on 2026-10-28) a smaller file fails.
#   4. Right after the cache check, and again right before the read, the file is still dataless with 0 blocks.
#      A file that rematerialized at any point up to then fails (another reader may have brought back a copy
#      before the cache was shown to hold none).
#   5. The read: sha256 of the file. Reading a dataless file makes the File Provider download it.
#   6. After the read the file is materialized (not dataless, blocks > 0): the read caused a download.
#
# Between check 4 and the read there is no complete local copy anywhere checked, so any materialization in
# that window, by this read or by another process, can only have fetched the bytes from Google. Check 6 shows
# that a fetch happened after check 4. What this does not cover: a place that holds file content outside
# content_cache and outside the file itself. None was found on this Mac (2026-10-28).
#
# Observed 2026-10-28 on this Mac: a 4 MiB file in My Drive/as2-backup/setup-check went from flags 64, 8192
# blocks to flags 1073741920 (SF_DATALESS set), 0 blocks; the cache held 0 blob files; reading it back took
# 6.5 s, returned the uploaded sha256, and left the file materialized (flags 64, 8192 blocks).
emulate -L zsh
setopt no_unset pipe_fail extended_glob
zmodload zsh/stat zsh/zselect
(( $# == 2 )) || { print -u2 "usage: zsh server-read.zsh <file in My Drive> <DriveFS account dir>"; exit 2 }
f=$1 acct=$2
fail() { print -r -- "$*"; exit 1 }
[[ -f $f && ! -L $f ]] || fail "not a regular file: $f"
cache=$acct/content_cache

# st_flags, blocks, size of $f into ST (zstat has no st_flags: BSD stat)
local -a ST
stat_f() {
  local o; o=$(/usr/bin/stat -f '%f %b %z' -- "$f" 2>&1) || fail "cannot stat $f: $o"
  ST=( ${=o} )
  (( ${#ST} == 3 )) && [[ ${ST[1]} == <-> && ${ST[2]} == <-> && ${ST[3]} == <-> ]] || fail "stat said: $o"
}
dataless() { (( (ST[1] & 0x40000000) && ST[2] == 0 )) }

# Content cache format verified on this Mac (2026-10-28): chunks.db has exactly one table,
#   CREATE TABLE ranges (id INTEGER PRIMARY KEY NOT NULL, ranges_proto BLOB)
# This is the sha256 of every sqlite_master row as type<US>name<US>tbl_name<US>sql, ordered by type and name,
# one per line (sqlite3 -list output). Any other schema is refused as "schema pin changed".
PIN_CHUNKS_SCHEMA=1be31c4b266e570d8f0611adcda1b1478bbdca70ca1ab14aa73658019dae09e1
SQLITE=/usr/bin/sqlite3

# q <sql>: one read-only query on chunks.db; killed after 20 s (perl alarm survives exec); waits 5 s on a lock.
q() {
  /usr/bin/perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"' 20 \
    $SQLITE -readonly -batch -noheader -list -cmd '.timeout 5000' "file:$cache/chunks.db?mode=ro" "$1" 2>&1
}

# chunks_bytes: checks the chunks.db schema pin, then prints the bytes chunks.db holds in its rows: the summed
# byte length of every column of every row of every table (column types in SQLite are advisory, so all columns
# count, TEXT and numbers by their byte form). Run in $(...): on any failure it prints the reason and exits 1.
chunks_bytes() {
  local o h t c rc; local -a tabs cols terms; integer sum=0
  o=$(q "select type||char(31)||name||char(31)||tbl_name||char(31)||coalesce(sql,'') from sqlite_master order by type, name;") \
    || fail "cannot read the schema of $cache/chunks.db (sqlite3 exit $?): ${o//$'\n'/; }; a full local copy cannot be ruled out"
  # openssl, not shasum: the fixtures stub /usr/bin/shasum as "the read", and this hash is not a read of the file
  h=$(print -r -- "$o" | /usr/bin/openssl dgst -sha256 -r 2>&1) || fail "cannot hash the chunks.db schema: $h"; h=${h%% *}
  # sqlite3 -list prints char(31) as the two characters ^_ (that rendering is what the pin hashes); show it as |
  [[ $h == $PIN_CHUNKS_SCHEMA ]] || { o=${o//'^_'/|}; fail "DriveFS content cache schema pin changed: chunks.db schema sha256 $h, verified $PIN_CHUNKS_SCHEMA (${o//$'\n'/; }). Deletion is blocked until server-read.zsh is re-verified against the new format and PIN_CHUNKS_SCHEMA updated." }
  o=$(q "select name from sqlite_master where type='table' order by name;") || fail "cannot list the tables of chunks.db: $o"
  tabs=( "${(@f)o}" )
  for t in ${tabs:#}; do
    o=$(q "select name from pragma_table_info('${t//\'/\'\'}');") || fail "cannot list the columns of chunks.db table $t: $o"
    cols=( "${(@f)o}" ); terms=()
    for c in ${cols:#}; do terms+=( "coalesce(length(cast(\"${c//\"/\"\"}\" as blob)),0)" ); done
    (( ${#terms} )) || fail "chunks.db table $t has no readable columns"
    o=$(q "select coalesce(sum(${(j:+:)terms}),0) from \"${t//\"/\"\"}\";") || fail "cannot read chunks.db table $t: $o"
    [[ $o == <-> ]] || fail "chunks.db table $t byte count said: $o"
    sum+=o
  done
  print -r -- $sum
}

# Sets CACHED to every byte the content cache could hold as a copy: the d<n>/ files, the row bytes in chunks.db,
# and the whole -wal, -shm and METADATA files (counted, not parsed). NBLOBS counts the d<n>/ files. Fails on
# anything outside the verified layout, on an unreadable entry, and on a changed chunks.db schema.
integer CACHED NBLOBS ROW_BYTES SIDE_BYTES
scan_cache() {
  CACHED=0 NBLOBS=0 ROW_BYTES=0 SIDE_BYTES=0
  [[ -d $cache && ! -L $cache && -r $cache && -x $cache ]] || fail "DriveFS content cache missing or unreadable: $cache"
  local -a top sub; local e b o; local -A s
  top=( $cache/*(DN) )
  (( ${#top} )) || fail "DriveFS content cache is empty, not the verified layout: $cache"
  [[ -f $cache/chunks.db && ! -L $cache/chunks.db ]] || fail "DriveFS content cache has no chunks.db, not the verified layout: $cache"
  for e in $top; do
    zstat -L -s -H s -- "$e" 2>/dev/null || fail "cannot stat cache entry $e"
    case ${e:t} in
      chunks.db)
        [[ ${s[mode]} == -* ]] || fail "cache entry $e is not a regular file; not the verified layout" ;;
      chunks.db-shm|chunks.db-wal|METADATA)
        [[ ${s[mode]} == -* ]] || fail "cache entry $e is not a regular file; not the verified layout"
        SIDE_BYTES+=${s[size]} ;;
      d<->)
        [[ ${s[mode]} == d* ]] || fail "cache entry $e is not a directory; not the verified layout"
        [[ -r $e && -x $e ]] || fail "cache directory $e is unreadable"
        sub=( $e/*(DN) )
        for b in $sub; do
          zstat -L -s -H s -- "$b" 2>/dev/null || fail "cannot stat cache blob $b"
          [[ ${s[mode]} == -* ]] || fail "cache entry $b is not a regular file; not the verified layout"
          CACHED+=${s[size]}; NBLOBS+=1
        done ;;
      *) fail "unrecognised entry in the DriveFS content cache: $e; not the verified layout, so a full local copy cannot be ruled out" ;;
    esac
  done
  o=$(chunks_bytes) || fail "$o"
  ROW_BYTES=$o
  CACHED+=$(( ROW_BYTES + SIDE_BYTES ))
}

# 1. evict
o=$(/usr/bin/osascript -l JavaScript -e 'ObjC.import("Foundation")
function run(a) {
  var e = Ref()
  if ($.NSFileManager.defaultManager.evictUbiquitousItemAtURLError($.NSURL.fileURLWithPath(a[0]), e)) return "evict ok"
  return "evict failed: " + (e[0] ? ObjC.unwrap(e[0].localizedDescription) + " (" + ObjC.unwrap(e[0].domain) + " " + e[0].code + ")" : "no error object")
}' "$f" 2>&1)
[[ $o == "evict ok" ]] || fail "${o:-osascript printed nothing}"

# 2. dataless within 20 s (eviction is asynchronous in the File Provider)
for i in {1..40}; do stat_f; dataless && break; zselect -t 50; done
dataless || fail "still not dataless after eviction (flags ${ST[1]}, ${ST[2]} blocks)"
integer SIZE=${ST[3]}
(( SIZE > 0 )) || fail "file is empty; a read could not show a download"

# 3. pinned cache layout and format, able to hold less than the file, within the drain wait (default 120 s;
#    AS2_SERVER_READ_DRAIN shortens it for tests, which can only make the gate refuse sooner)
# Clock seam (tests), as lib.zsh's clock_now: with AS2_CLOCK_CMD set (a command printing epoch seconds), the 5 s
# pause between scans lasts until that clock has moved 5 s on, so a test controls when the next scan comes and what
# happens before it. Unset (every real run), the pause is the same zselect as before the seam. A clock command that
# fails or prints anything else refuses the read, and so does a test clock that has not moved 5 s within 300 s of
# real polling (a stuck test clock fails, it never hangs).
drain_clock() {
  local o rc
  o=$(eval "$AS2_CLOCK_CMD" 2>&1); rc=$?
  (( rc == 0 )) && [[ $o == <->(|.<->) ]] || fail "drain wait: AS2_CLOCK_CMD ($AS2_CLOCK_CMD) exited $rc and printed '${o//$'\n'/; }' instead of epoch seconds"
  CLK=${o%%.*}
}
drain_pause() {
  [[ -z ${AS2_CLOCK_CMD:-} ]] && { zselect -t 500; return 0 }
  integer CLK until g
  drain_clock; until=$(( CLK + 5 ))
  for g in {1..30000}; do drain_clock; (( CLK < until )) || return 0; zselect -t 1; done
  fail "drain wait: the AS2_CLOCK_CMD clock ($AS2_CLOCK_CMD) did not move 5 s on within 300 s of polling; it reads $CLK"
}
integer DRAIN_TRIES=$(( ${AS2_SERVER_READ_DRAIN:-120} / 5 )); (( DRAIN_TRIES >= 1 )) || DRAIN_TRIES=1
for k in {1..$DRAIN_TRIES}; do scan_cache; (( CACHED < SIZE )) && break; (( k < DRAIN_TRIES )) && drain_pause; done
(( CACHED < SIZE )) || fail "DriveFS content cache can still hold $CACHED bytes after the drain wait ($NBLOBS blob file(s), $ROW_BYTES in chunks.db rows, $SIDE_BYTES in chunks.db-wal/-shm/METADATA), not less than the file's $SIZE; a local copy may remain"

# 4. still dataless after the cache check, and again right before the read
stat_f; dataless || fail "file rematerialized during the cache check (flags ${ST[1]}, ${ST[2]} blocks); a local copy may have been read back"
(( ST[3] == SIZE )) || fail "file size changed from $SIZE to ${ST[3]}"
scan_cache; (( CACHED < SIZE )) || fail "DriveFS content cache grew to $CACHED bytes before the read ($NBLOBS blob file(s), $ROW_BYTES in chunks.db rows, $SIDE_BYTES in chunks.db-wal/-shm/METADATA)"
stat_f; dataless || fail "file rematerialized right before the read (flags ${ST[1]}, ${ST[2]} blocks)"

# 5. the read
h=$(/usr/bin/shasum -a 256 -- "$f" 2>&1) || fail "read failed: $h"
h=${h%% *}
[[ $h == [0-9a-f](#c64) ]] || fail "shasum said: $h"

# 6. the read caused a download
stat_f
dataless && fail "file is still dataless after a full read; the bytes did not come through a download"
(( ST[2] > 0 && ST[3] == SIZE )) || fail "after the read: ${ST[2]} blocks, size ${ST[3]} (expected $SIZE)"
print -r -- "server read: evicted, dataless, cache could hold $CACHED bytes ($NBLOBS blob file(s), $ROW_BYTES in chunks.db rows, $SIDE_BYTES in chunks.db-wal/-shm/METADATA) < $SIZE, chunks.db schema pin matches, still dataless before the read, materialized by it (flags ${ST[1]}, ${ST[2]} blocks)"
print -r -- "sha256=$h"
