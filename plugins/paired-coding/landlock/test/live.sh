#!/bin/sh
# Live checks of pair-landlock against the running kernel. Run as a non-root user on Linux
# with Landlock ABI 3 or later. Needs coreutils and perl (perl reports the raw errno of
# link(2), rename(2) and connect(2)).
#
#   sh test/live.sh [path/to/pair-landlock]
#
# Default binary: ../bin/pair-landlock-$(uname -m)-linux. Exits non-zero if any case fails.
set -u

here=$(cd "$(dirname "$0")" && pwd)
BIN=${1:-$here/../bin/pair-landlock-$(uname -m)-linux}
[ "$(id -u)" != 0 ] || { echo "run this as a non-root user"; exit 2; }

pass=0
failed=0
ok() { pass=$((pass + 1)); echo "PASS  $1"; }
bad() { failed=$((failed + 1)); echo "FAIL  $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1  ($3)"; else bad "$1  (want: $2, got: $3)"; fi; }

# perl one-liners that print "ok" or "<errno> <message>" for one syscall.
P_LINK='link($ARGV[0], $ARGV[1]) ? print "ok\n" : print 0+$!, " $!\n"'
P_RENAME='rename($ARGV[0], $ARGV[1]) ? print "ok\n" : print 0+$!, " $!\n"'
P_TRUNC='truncate($ARGV[0], 0) ? print "ok\n" : print 0+$!, " $!\n"'
P_OPENW='open(my $f, ">>", $ARGV[0]) ? print "ok\n" : print 0+$!, " $!\n"'
P_ABSTRACT='use Socket; socket(my $s, AF_UNIX, SOCK_STREAM, 0) or do { print 0+$!, " $!\n"; exit }; connect($s, pack_sockaddr_un("\0$ARGV[0]")) ? print "ok\n" : print 0+$!, " $!\n"'
P_PATHSOCK='use Socket; socket(my $s, AF_UNIX, SOCK_STREAM, 0) or do { print 0+$!, " $!\n"; exit }; connect($s, pack_sockaddr_un($ARGV[0])) ? print "ok\n" : print 0+$!, " $!\n"'
P_PAIR='use Socket; socketpair(my $p1, my $p2, AF_UNIX, SOCK_STREAM, 0) or do { print 0+$!, " $!\n"; exit }; syswrite($p1, "hi"); sysread($p2, my $x, 2); print "$x\n"'
P_KILL='kill(9, $ARGV[0]) ? print "ok\n" : print 0+$!, " $!\n"'
P_TCGETS='open(my $f, "<", $ARGV[0]) or die "open: $!"; ioctl($f, 0x5401, my $b = "\0" x 64) ? print "ok\n" : print 0+$!, " $!\n"'
# Runs "$@" (stdin passed through, stdout to /dev/null), sends it signal $1 after 0.5 s unless
# $1 is empty, and prints how it ended: "exit <code>" or "signal <number>". A shell's $? folds
# the two together; this tells them apart.
ended() {
  perl -e 'my $sig = shift; my $p = fork // die; if (!$p) { open STDOUT, ">", "/dev/null"; exec @ARGV; exit 127 }
    if ($sig ne "") { select undef, undef, undef, 0.5; kill $sig, $p } waitpid($p, 0);
    print $? & 127 ? "signal " . ($? & 127) . "\n" : "exit " . ($? >> 8) . "\n"' "$@"
}

abi=$("$BIN" --abi) || { echo "Landlock is missing or below ABI 3 here (--abi printed '$abi'); nothing to test"; exit 1; }
echo "kernel $(uname -r), $(uname -m), uid $(id -u), Landlock ABI $abi, binary $BIN"

W=$(mktemp -d)
mkdir -p "$W/repo/newdir" "$W/repo/mkdirok" "$W/outside" "$W/tmp/a" "$W/tmp/b"
printf old > "$W/repo/listed.txt"
printf old > "$W/repo/sibling.txt"
printf secret > "$W/outside/secret.txt"
printf target > "$W/outside/via-link.txt"
ln -s "$W/outside/secret.txt" "$W/repo/link-to-secret"
ln -s "$W/repo/listed.txt" "$W/outside/link-to-listed"
printf x > "$W/repo/newdir/existing.txt"

# JSON string escaping for a command, and the ruleset lines the cases run under.
json() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
# A ruleset line: files given as a JSON array, then the command.
rules_with() { printf '{"files":%s,"command":%s}\n' "$1" "$(json "$2")"; }
rules() {
  printf '{"files":["%s"],"dirs":[{"path":"%s"},{"path":"%s","make_dir":true}],"rw_trees":["%s"],"command":%s}\n' \
    "$W/repo/listed.txt" "$W/repo/newdir" "$W/repo/mkdirok" "$W/tmp" "$(json "$1")"
}
sandboxed() { rules "$1" | "$BIN" 2>&1; }
inside_perl() { rules "perl -e '$1' $2" | "$BIN" 2>&1; }

echo "--- files: a listed file can be rewritten and truncated"
sandboxed "printf new > $W/repo/listed.txt" >/dev/null
check "rewrite listed file" new "$(cat "$W/repo/listed.txt")"
check "truncate(2) listed file" ok "$(inside_perl "$P_TRUNC" "$W/repo/listed.txt")"
check "listed file is empty after truncate" 0 "$(wc -c < "$W/repo/listed.txt" | tr -d ' ')"
sandboxed ": > $W/repo/listed.txt; printf again >> $W/repo/listed.txt" >/dev/null
check "O_TRUNC then append on listed file" again "$(cat "$W/repo/listed.txt")"

echo "--- files: an unlisted sibling is refused"
check "open unlisted sibling for write" "13 Permission denied" "$(inside_perl "$P_OPENW" "$W/repo/sibling.txt")"
check "truncate(2) unlisted sibling" "13 Permission denied" "$(inside_perl "$P_TRUNC" "$W/repo/sibling.txt")"
check "unlisted sibling unchanged" old "$(cat "$W/repo/sibling.txt")"
check "create a new file beside the listed file" "13 Permission denied" "$(inside_perl "$P_OPENW" "$W/repo/new-beside.txt")"
check "rename listed file within its own dir" "13 Permission denied" "$(inside_perl "$P_RENAME" "$W/repo/listed.txt $W/repo/renamed.txt")"

echo "--- dirs: new files, and directories only with make_dir"
sandboxed "printf hi > $W/repo/newdir/fresh.txt" >/dev/null
check "create and write a new file in a dirs entry" hi "$(cat "$W/repo/newdir/fresh.txt" 2>&1)"
check "mkdir in a dirs entry without make_dir" "13 Permission denied" "$(inside_perl 'mkdir($ARGV[0]) ? print "ok\n" : print 0+$!, " $!\n"' "$W/repo/newdir/sub")"
check "mkdir in a dirs entry with make_dir" ok "$(inside_perl 'mkdir($ARGV[0]) ? print "ok\n" : print 0+$!, " $!\n"' "$W/repo/mkdirok/sub")"
check "symlink in a dirs entry" "13 Permission denied" "$(inside_perl 'symlink($ARGV[0], $ARGV[1]) ? print "ok\n" : print 0+$!, " $!\n"' "$W/outside/secret.txt $W/repo/newdir/sym")"
check "delete a file in a dirs entry" "13 Permission denied" "$(inside_perl 'unlink($ARGV[0]) ? print "ok\n" : print 0+$!, " $!\n"' "$W/repo/newdir/existing.txt")"
check "existing file in a dirs entry is writable (documented)" ok "$(inside_perl "$P_OPENW" "$W/repo/newdir/existing.txt")"

echo "--- links and renames across directories (REFER is never granted)"
check "hard link from outside into a dirs entry" "18 Invalid cross-device link" "$(inside_perl "$P_LINK" "$W/outside/secret.txt $W/repo/newdir/hl")"
check "hard link from outside into an rw_tree" "18 Invalid cross-device link" "$(inside_perl "$P_LINK" "$W/outside/secret.txt $W/tmp/hl")"
sandboxed "printf m > $W/repo/newdir/moveme" >/dev/null
check "rename out of a dirs entry" "13 Permission denied" "$(inside_perl "$P_RENAME" "$W/repo/newdir/moveme $W/outside/moved")"
check "rename out of an rw_tree into a dirs entry" "18 Invalid cross-device link" "$(sandboxed "printf t > $W/tmp/t; perl -e '$P_RENAME' $W/tmp/t $W/repo/newdir/t")"
check "mv out of a dirs entry (copy fallback) also refused" 1 "$(sandboxed "mv $W/repo/newdir/moveme $W/outside/moved 2>$W/tmp/mv.err; echo \$?")"
check "moveme still in place" m "$(cat "$W/repo/newdir/moveme")"

echo "--- dirs with remove: delete and rename files under it, never directories, never out of it"
mkdir -p "$W/repo/clean/sub" "$W/repo/clean/emptysub" "$W/repo/clean2"
printf a > "$W/repo/clean/a.txt"
printf b > "$W/repo/clean/b.txt"
printf s > "$W/repo/clean/sub/s.txt"
printf r > "$W/repo/clean/sub/r.txt"
printf o > "$W/repo/clean/out.txt"
printf t > "$W/repo/clean/to-tmp.txt"
# listed.txt is a files entry; clean and clean2 are remove entries; newdir is a plain dirs entry.
rules_rm() {
  printf '{"files":["%s","/dev/null"],"dirs":[{"path":"%s","remove":true},{"path":"%s","remove":true},{"path":"%s"}],"rw_trees":["%s"],"command":%s}\n' \
    "$W/repo/listed.txt" "$W/repo/clean" "$W/repo/clean2" "$W/repo/newdir" "$W/tmp" "$(json "$1")"
}
rm_sandboxed() { rules_rm "$1" | "$BIN" 2>&1; }
rm_perl() { rules_rm "perl -e '$1' $2" | "$BIN" 2>&1; }
check "rm in a remove entry" gone "$(rm_sandboxed "rm $W/repo/clean/a.txt && [ ! -e $W/repo/clean/a.txt ] && echo gone")"
check "mv within a remove entry" b "$(rm_sandboxed "mv $W/repo/clean/b.txt $W/repo/clean/b2.txt && cat $W/repo/clean/b2.txt")"
check "sed -i in a subdirectory of a remove entry" S "$(rm_sandboxed "sed -i s/s/S/ $W/repo/clean/sub/s.txt && cat $W/repo/clean/sub/s.txt")"
check "rm in a subdirectory of a remove entry" gone "$(rm_sandboxed "rm $W/repo/clean/sub/r.txt && [ ! -e $W/repo/clean/sub/r.txt ] && echo gone")"
check "rename(2) from one remove entry to another" ok "$(rm_perl "$P_RENAME" "$W/repo/clean/b2.txt $W/repo/clean2/b.txt")"
check "rename(2) out of a remove entry to an ungranted dir" "13 Permission denied" "$(rm_perl "$P_RENAME" "$W/repo/clean/out.txt $W/outside/out.txt")"
check "mv out of a remove entry to an ungranted dir is refused" 1 "$(rm_sandboxed "mv $W/repo/clean/out.txt $W/outside/out.txt 2>/dev/null; echo \$?")"
check "the file mv tried to take out is still in place" o "$(cat "$W/repo/clean/out.txt")"
check "rename(2) out of a remove entry into an rw_tree (no REFER there)" "18 Invalid cross-device link" "$(rm_perl "$P_RENAME" "$W/repo/clean/to-tmp.txt $W/tmp/to-tmp.txt")"
check "rename(2) from a remove entry into a plain dirs entry (no REFER there)" "18 Invalid cross-device link" "$(rm_perl "$P_RENAME" "$W/repo/clean/to-tmp.txt $W/repo/newdir/to-tmp.txt")"
check "hard link from outside into a remove entry" "18 Invalid cross-device link" "$(rm_perl "$P_LINK" "$W/outside/secret.txt $W/repo/clean/hl")"
check "rmdir in a remove entry" "13 Permission denied" "$(rm_perl 'rmdir($ARGV[0]) ? print "ok\n" : print 0+$!, " $!\n"' "$W/repo/clean/emptysub")"
check "symlink in a remove entry" "13 Permission denied" "$(rm_perl 'symlink($ARGV[0], $ARGV[1]) ? print "ok\n" : print 0+$!, " $!\n"' "$W/outside/secret.txt $W/repo/clean/sym")"
check "rm of a files entry is refused next to remove entries" kept "$(rm_sandboxed "rm -f $W/repo/listed.txt 2>/dev/null; [ -e $W/repo/listed.txt ] && echo kept")"
check "rm in a plain dirs entry is still refused" kept "$(rm_sandboxed "rm -f $W/repo/newdir/existing.txt 2>/dev/null; [ -e $W/repo/newdir/existing.txt ] && echo kept")"

echo "--- the helper ends every process the command started, inside or outside its process group"
# The writer appends to bg-<case>.txt every 50 ms; once the helper returns, the file must stop
# growing. A marker in its command line finds any survivor in /proc without procps.
writer() { printf "while :; do echo t >> $W/repo/clean2/bg-%s.txt; sleep 0.05; done # pair-landlock-bg-%s-$$" "$1" "$1"; }
# "b[g]" so that grep's own command line, which holds the pattern, does not match it.
survivors() { grep -l "pair-landlock-b[g]-$1-$$" /proc/[0-9]*/cmdline 2>/dev/null | wc -l | tr -d ' '; }
stops_growing() {
  a=$(wc -c < "$W/repo/clean2/bg-$1.txt" | tr -d ' ')
  sleep 0.4
  b=$(wc -c < "$W/repo/clean2/bg-$1.txt" | tr -d ' ')
  if [ "$a" -gt 0 ] && [ "$a" = "$b" ]; then echo stopped; else echo "grew from $a to $b"; fi
}
rm_sandboxed "setsid sh -c '$(writer setsid)' </dev/null >/dev/null 2>&1 & sleep 0.3" >/dev/null
check "a setsid writer stops when the command exits" stopped "$(stops_growing setsid)"
check "no setsid writer is left" 0 "$(survivors setsid)"
rm_sandboxed "( setsid sh -c '$(writer double)' </dev/null >/dev/null 2>&1 & ); sleep 0.3" >/dev/null
check "a double-forked setsid writer stops when the command exits" stopped "$(stops_growing double)"
check "SIGTERM to the helper: it ends the run and exits 143, not by the signal" "exit 143" "$(rules_rm "setsid sh -c '$(writer term)' </dev/null >/dev/null 2>&1 & sleep 30" | ended TERM "$BIN" 2>/dev/null)"
check "SIGTERM to the helper: the setsid writer stops" stopped "$(stops_growing term)"
check "SIGTERM to the helper: no writer is left" 0 "$(survivors term)"
if [ "$abi" -ge 6 ]; then
  # The command's shell is the supervisor's child, so $PPID inside it is the supervisor.
  check "the command cannot signal the helper (ABI 6 signal scope)" "1 Operation not permitted" "$(rm_perl "$P_KILL" '$PPID')"
fi
check "a command killed by a signal: the helper exits 128 plus its number" "exit 143" "$(rules 'kill -TERM $$' | ended "" "$BIN" 2>/dev/null)"
check "SIGKILL to the helper: it dies of the signal, which the caller can tell from any end it chose" "signal 9" "$(rules 'sleep 2' | ended KILL "$BIN" 2>/dev/null)"

echo "--- symlinks are resolved at open"
check "write through a symlink to an unlisted file" "13 Permission denied" "$(inside_perl "$P_OPENW" "$W/repo/link-to-secret")"
check "unlisted symlink target unchanged" secret "$(cat "$W/outside/secret.txt")"
check "write through a symlink to the listed file" ok "$(inside_perl "$P_OPENW" "$W/outside/link-to-listed")"

echo "--- rw_trees (temp paths)"
check "write, mkdir, rename within one dir of an rw_tree" ok "$(sandboxed "printf 1 > $W/tmp/a/x && mkdir $W/tmp/a/d && perl -e '$P_RENAME' $W/tmp/a/x $W/tmp/a/y")"
check "rename across dirs inside an rw_tree" "18 Invalid cross-device link" "$(inside_perl "$P_RENAME" "$W/tmp/a/y $W/tmp/b/y")"
check "mv across dirs inside an rw_tree (copy fallback works)" 1 "$(sandboxed "mv $W/tmp/a/y $W/tmp/b/y && cat $W/tmp/b/y")"

echo "--- process and stdin"
check "no_new_privs is set" "NoNewPrivs:	1" "$(sandboxed 'grep NoNewPrivs /proc/self/status')"
check "stdin after the ruleset line reaches the command" "payload line 1
payload line 2" "$( { rules "cat > $W/repo/listed.txt"; printf 'payload line 1\npayload line 2\n'; } | "$BIN" 2>&1; cat "$W/repo/listed.txt")"
check "exit status of the command passes through" 7 "$(rules 'exit 7' | "$BIN" >/dev/null 2>&1; echo $?)"
check "SIGPIPE is default inside (yes | head ends quietly)" "y" "$(sandboxed 'yes | head -n 1')"
check "/dev/null is not writable unless listed" "13 Permission denied" "$(inside_perl "$P_OPENW" /dev/null)"
check "/dev/null writable when listed" ok "$(rules_with '["/dev/null"]' "perl -e '$P_OPENW' /dev/null" | "$BIN" 2>&1)"
check "a device ioctl outside the sandbox reaches the driver (TCGETS on /dev/null)" "25 Inappropriate ioctl for device" "$(perl -e "$P_TCGETS" /dev/null 2>&1)"
if [ "$abi" -ge 5 ]; then
  check "a device ioctl inside is refused (IOCTL_DEV handled from ABI 5, granted nowhere)" "13 Permission denied" "$(inside_perl "$P_TCGETS" /dev/null)"
else
  check "a device ioctl inside still reaches the driver below ABI 5" "25 Inappropriate ioctl for device" "$(inside_perl "$P_TCGETS" /dev/null)"
fi
chmod 644 "$W/outside/secret.txt"
sandboxed "chmod 600 $W/outside/secret.txt" >/dev/null
check "chmod of an unlisted file is not fenced: Landlock has no right for it" 600 "$(stat -c %a "$W/outside/secret.txt")"
check "the unlisted file's content is unchanged" secret "$(cat "$W/outside/secret.txt")"

echo "--- Unix sockets: abstract ones scoped from ABI 6; below ABI 9 the seccomp filter refuses every new one"
perl -e 'use Socket; socket(my $s, AF_UNIX, SOCK_STREAM, 0) or die; bind($s, pack_sockaddr_un("\0$ARGV[0]")) or die "bind: $!"; listen($s, 5) or die; sleep 20' "pair-landlock-$$" &
srv=$!
perl -e 'use Socket; socket(my $s, AF_UNIX, SOCK_STREAM, 0) or die; bind($s, pack_sockaddr_un($ARGV[0])) or die "bind: $!"; listen($s, 5) or die; sleep 20' "$W/outside/daemon.sock" &
psrv=$!
sleep 1
check "abstract socket outside the sandbox, unsandboxed connect" ok "$(perl -e "$P_ABSTRACT" "pair-landlock-$$")"
check "abstract socket outside the sandbox, sandboxed connect" "1 Operation not permitted" "$(inside_perl "$P_ABSTRACT" "pair-landlock-$$")"
check "pathname socket outside the sandbox, unsandboxed connect" ok "$(perl -e "$P_PATHSOCK" "$W/outside/daemon.sock")"
if [ "$abi" -lt 9 ]; then
  check "pathname socket outside the sandbox, sandboxed connect (seccomp, ABI < 9)" "1 Operation not permitted" "$(inside_perl "$P_PATHSOCK" "$W/outside/daemon.sock")"
else
  got=$(inside_perl "$P_PATHSOCK" "$W/outside/daemon.sock")
  if [ "$got" != ok ]; then ok "pathname socket outside the sandbox, sandboxed connect (RESOLVE_UNIX)  ($got)"; else bad "pathname socket outside the sandbox, sandboxed connect (RESOLVE_UNIX)  (connected)"; fi
fi
check "socketpair still works inside" hi "$(inside_perl "$P_PAIR" "")"
check "TCP sockets can still be made inside" ok "$(sandboxed "perl -e 'use Socket; socket(my \$s, AF_INET, SOCK_STREAM, 0) ? print qq(ok\n) : print 0+\$!, qq( \$!\n)'")"
kill "$srv" "$psrv" 2>/dev/null

echo "--- name resolution still works inside (no /dev/null grant here, so grep -q, not a redirect)"
check "getent hosts localhost" resolves "$(sandboxed 'getent hosts localhost | grep -q . && echo resolves || echo "does not resolve"')"
outside_dns=$(getent hosts example.com | grep -q . && echo resolves || echo "does not resolve")
check "a DNS name resolves inside exactly when it resolves outside (example.com $outside_dns outside)" "$outside_dns" "$(sandboxed 'getent hosts example.com | grep -q . && echo resolves || echo "does not resolve"')"

echo "--- many rules under a low open-file limit: each rule descriptor is closed once its rule is added"
mkdir "$W/many"
list=""
i=0
while [ $i -lt 3000 ]; do
  : > "$W/many/f$i"
  list="$list${list:+,}\"$W/many/f$i\""
  i=$((i + 1))
done
got=$(ulimit -Sn 256 && rules_with "[$list]" "printf many > $W/many/f1500 && echo ran" | "$BIN" 2>&1; echo "rc=$?")
check "3000 file rules with a soft limit of 256 descriptors" "ran rc=0" "$(printf '%s' "$got" | tr '\n' ' ' | sed 's/ $//')"
check "the write to one granted file of the 3000 landed" many "$(cat "$W/many/f1500")"
check "a file outside the 3000 is still refused" "13 Permission denied" "$(ulimit -Sn 256 && rules_with "[$list]" "perl -e '$P_OPENW' $W/repo/sibling.txt" | "$BIN" 2>&1)"

echo "--- refused input: exit 121 and the command never runs"
marker="$W/tmp/ran"
check "malformed JSON" 121 "$(printf '{nope\n' | "$BIN" >/dev/null 2>&1; echo $?)"
check "unknown field" 121 "$(printf '{"command":"true","refer":["/"]}\n' | "$BIN" >/dev/null 2>&1; echo $?)"
check "relative path" 121 "$(printf '{"files":["repo/listed.txt"],"command":"touch %s"}\n' "$marker" | "$BIN" >/dev/null 2>&1; echo $?)"
check "symlink as a files entry" 121 "$(printf '{"files":["%s"],"command":"touch %s"}\n' "$W/outside/link-to-listed" "$marker" | "$BIN" >/dev/null 2>&1; echo $?)"
ln "$W/repo/sibling.txt" "$W/outside/sibling-hardlink"
check "multiply-linked files entry" 121 "$(printf '{"files":["%s"],"command":"touch %s"}\n' "$W/repo/sibling.txt" "$marker" | "$BIN" >/dev/null 2>&1; echo $?)"
check "directory as a files entry" 121 "$(printf '{"files":["%s"],"command":"touch %s"}\n' "$W/repo" "$marker" | "$BIN" >/dev/null 2>&1; echo $?)"
check "missing path" 121 "$(printf '{"files":["%s"],"command":"touch %s"}\n' "$W/repo/nope" "$marker" | "$BIN" >/dev/null 2>&1; echo $?)"
check "no command ran for any refused input" absent "$([ -e "$marker" ] && echo present || echo absent)"
check "--abi exits 0 at ABI >= 3" 0 "$("$BIN" --abi >/dev/null 2>&1; echo $?)"

chmod -R u+w "$W" 2>/dev/null
rm -r "$W"
echo "--- $pass passed, $failed failed"
[ "$failed" = 0 ]
