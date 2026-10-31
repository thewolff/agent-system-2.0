#!/bin/zsh
# Fixtures for the server-read gate, built the way the round-3 reviewer built theirs: a copy of the real helper
# with only /usr/bin/osascript, /usr/bin/stat and /usr/bin/shasum swapped for stubs that model what macOS
# reports. Every scan, wait and decision in the helper runs unchanged.
#   zsh test-server-read.zsh [<helper>] [<work dir>]
# Defaults: ./server-read.zsh, a new temp dir (left in place). Prints PASS/FAIL lines; exits with the failures.
# Reviewer's originals, all under $TMPDIR: as2-review3-evict-race2-bawp6r22 (rematerialized during the drain
# wait), as2-review3-fixtures-azf99ykt (a full copy in an unrecognised cache namespace) and
# as2-review4-inline-cache-v2tc_ea3 (a full copy in a BLOB inside an accepted chunks.db, case 11).
emulate -L zsh
setopt no_unset pipe_fail extended_glob
zmodload zsh/zselect
HELPER=${1:-${0:A:h}/server-read.zsh}
W=${2:-$(mktemp -d "${TMPDIR:-/tmp}/as2-server-read-fixtures.XXXXXX")} || exit 99
[[ -f $HELPER && -d $W ]] || { print -u2 "usage: zsh test-server-read.zsh [<helper>] [<work dir>]"; exit 99 }
integer FAILS=0
ok() { print -r -- "PASS: $1" }
bad() { print -r -- "FAIL: $1"; FAILS+=1 }
print "server-read fixtures for $HELPER in $W"

# fixture <name>: a fresh dir with account/content_cache (a chunks.db with the schema verified on the real
# DriveFS, empty; an empty METADATA; d0, d1), a 1 MiB target, stubs, and the helper copy run.zsh. stat-stub
# reports dataless until $D/materialized exists, then materialized; shasum-stub materializes the target (as a
# real read would) unless $D/read-no-download exists.
fixture() {
  D=$W/$1; mkdir -p $D/account/content_cache/d0 $D/account/content_cache/d1 || exit 99
  /usr/bin/sqlite3 $D/account/content_cache/chunks.db 'CREATE TABLE ranges (id INTEGER PRIMARY KEY NOT NULL, ranges_proto BLOB)' || exit 99
  : > $D/account/content_cache/METADATA
  head -c 1048576 /dev/zero > $D/target
  print -r -- '#!/bin/zsh'$'\n''print "evict ok"' > $D/osascript-stub
  cat > $D/stat-stub <<EOF
#!/bin/zsh
print call >> $D/stat-count
if [[ -e $D/materialized ]]; then print "64 2048 1048576"; else print "1073741824 0 1048576"; fi
EOF
  cat > $D/shasum-stub <<EOF
#!/bin/zsh
[[ -e $D/read-no-download ]] || : > $D/materialized
exec /usr/bin/shasum "\$@"
EOF
  chmod +x $D/*-stub
  : > $D/stat-count
  sed -e "s#/usr/bin/osascript#$D/osascript-stub#g" -e "s#/usr/bin/stat #$D/stat-stub #g" -e "s#/usr/bin/shasum#$D/shasum-stub#g" \
    "$HELPER" > $D/run.zsh
}
run() { OUT=$(/bin/zsh $D/run.zsh $D/target $D/account 2>&1); RC=$?; print -r -- "  [$1] exit $RC: ${OUT//$'\n'/ | }" }

# 1. control: clean cache, the read downloads the file -> accepted, with the right sha256
fixture control
run control
want=$(/usr/bin/shasum -a 256 $D/target); want=${want%% *}
[[ $RC == 0 && $OUT == *"sha256=$want" ]] && ok "control: clean cache and a downloading read are accepted with the file's sha256" \
  || bad "control: clean cache and a downloading read are accepted with the file's sha256"

# 2. reviewer race2: a 1 MiB unrelated blob in the cache; after the first dataless stat another reader
#    materializes the target and the blob leaves the cache; the drain then succeeds
fixture race-during-drain
head -c 1048576 /dev/zero > $D/account/content_cache/d0/unrelated-blob
( while [[ ! -s $D/stat-count ]]; do zselect -t 5; done; : > $D/materialized; rm -f $D/account/content_cache/d0/unrelated-blob ) &
run race-during-drain; wait
[[ $RC != 0 && $OUT == *rematerialized* ]] && ok "rematerialized during the drain wait: refused" \
  || bad "rematerialized during the drain wait: refused"

# 3. reviewer fixtures: a complete local copy in a cache namespace the helper does not recognise
fixture unknown-namespace
mkdir -p $D/account/content_cache/new-layout; head -c 1048576 /dev/zero > $D/account/content_cache/new-layout/complete-local-copy
run unknown-namespace
[[ $RC != 0 && $OUT == *unrecognised* ]] && ok "full copy in an unrecognised cache namespace: refused" \
  || bad "full copy in an unrecognised cache namespace: refused"

# 4. a subdirectory inside a pinned d<n> dir (a nested layout the scan never verified)
fixture nested
mkdir -p $D/account/content_cache/d1/sub; head -c 1048576 /dev/zero > $D/account/content_cache/d1/sub/blob
run nested
[[ $RC != 0 && $OUT == *"not a regular file"* ]] && ok "subdirectory inside a cache d<n> dir: refused" || bad "subdirectory inside a cache d<n> dir: refused"

# 5. a symlink in the cache
fixture symlink
ln -s /etc $D/account/content_cache/d0/link
run symlink
[[ $RC != 0 && $OUT == *"not a regular file"* ]] && ok "symlink in the cache: refused" || bad "symlink in the cache: refused"

# 6. an unreadable cache dir
fixture unreadable
chmod 000 $D/account/content_cache/d1
run unreadable
chmod 700 $D/account/content_cache/d1
[[ $RC != 0 && $OUT == *unreadable* ]] && ok "unreadable cache dir: refused" || bad "unreadable cache dir: refused"

# 7. no chunks.db (the cache is not the verified one)
fixture no-chunks
rm -f $D/account/content_cache/chunks.db
run no-chunks
[[ $RC != 0 && $OUT == *chunks.db* ]] && ok "cache without chunks.db: refused" || bad "cache without chunks.db: refused"

# 8. materialized between the cache check and the read (stat call 2 onwards reports materialized)
fixture race-before-read
cat > $D/stat-stub <<EOF
#!/bin/zsh
print call >> $D/stat-count
n=\$(wc -l < $D/stat-count)
if (( n >= 2 )); then print "64 2048 1048576"; else print "1073741824 0 1048576"; fi
EOF
run race-before-read
[[ $RC != 0 && $OUT == *rematerialized* ]] && ok "rematerialized after the drain, before the read: refused" \
  || bad "rematerialized after the drain, before the read: refused"

# 9. the read did not cause a download (still dataless after it)
fixture no-download
: > $D/read-no-download
run no-download
[[ $RC != 0 && $OUT == *"still dataless after a full read"* ]] && ok "read that caused no download: refused" || bad "read that caused no download: refused"

# 10. eviction fails
fixture evict-fails
print -r -- '#!/bin/zsh'$'\n''print "evict failed: The operation couldn’t be completed. (NSCocoaErrorDomain 256)"' > $D/osascript-stub
run evict-fails
[[ $RC != 0 && $OUT == *"evict failed"* ]] && ok "eviction error: refused" || bad "eviction error: refused"

# 11. reviewer round 4: the whole target inside a BLOB of an accepted-name chunks.db with another schema
#     (blob_store(id integer primary key, body blob)), no racer: refused by the chunks.db schema pin
fixture inline-cache
rm -f $D/account/content_cache/chunks.db
/usr/bin/sqlite3 $D/account/content_cache/chunks.db "create table blob_store(id integer primary key, body blob); insert into blob_store(body) values (readfile('$D/target'));" || exit 99
run inline-cache
[[ $RC != 0 && $OUT == *"schema pin changed"* ]] && ok "full copy in a BLOB of chunks.db with an unverified schema: refused as schema pin changed" \
  || bad "full copy in a BLOB of chunks.db with an unverified schema: refused as schema pin changed"

# 12. the verified schema, with the whole target in a ranges_proto BLOB: refused by the row byte count
export AS2_SERVER_READ_DRAIN=5
fixture rows-hold-copy
/usr/bin/sqlite3 $D/account/content_cache/chunks.db "insert into ranges(ranges_proto) values (readfile('$D/target'));" || exit 99
run rows-hold-copy
[[ $RC != 0 && $OUT == *"can still hold "* && $OUT == *"1048577 in chunks.db rows"* ]] && ok "full copy in the verified chunks.db table: counted and refused" \
  || bad "full copy in the verified chunks.db table: counted and refused"

# 13. a -wal as large as the target (uncheckpointed pages can hold a copy): counted and refused
fixture wal-holds-copy
head -c 1048576 /dev/zero > $D/account/content_cache/chunks.db-wal
run wal-holds-copy
[[ $RC != 0 && $OUT == *"1048576 in chunks.db-wal/-shm/METADATA"* ]] && ok "chunks.db-wal as large as the file: counted and refused" \
  || bad "chunks.db-wal as large as the file: counted and refused"

# 14. METADATA as large as the target: counted and refused
fixture metadata-holds-copy
head -c 1048576 /dev/zero > $D/account/content_cache/METADATA
run metadata-holds-copy
[[ $RC != 0 && $OUT == *"1048576 in chunks.db-wal/-shm/METADATA"* ]] && ok "METADATA as large as the file: counted and refused" \
  || bad "METADATA as large as the file: counted and refused"
unset AS2_SERVER_READ_DRAIN

# 15. chunks.db is not a readable database
fixture chunks-corrupt
print -r -- "not a database" > $D/account/content_cache/chunks.db
run chunks-corrupt
[[ $RC != 0 && $OUT == *"cannot read the schema"* ]] && ok "unreadable chunks.db: refused" || bad "unreadable chunks.db: refused"

# 16. the verified schema plus an extra table: refused by the schema pin
fixture extra-table
/usr/bin/sqlite3 $D/account/content_cache/chunks.db 'CREATE TABLE inline_bodies (k TEXT, v BLOB)' || exit 99
run extra-table
[[ $RC != 0 && $OUT == *"schema pin changed"* ]] && ok "chunks.db with an extra table: refused as schema pin changed" || bad "chunks.db with an extra table: refused as schema pin changed"

print "RESULT: $FAILS failure(s)"
exit $FAILS
