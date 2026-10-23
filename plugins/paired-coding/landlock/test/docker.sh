#!/bin/sh
# Runs the live checks in an ubuntu:24.04 container as the non-root `ubuntu` user (uid 1000),
# then the "no Landlock" case: a seccomp profile that fails landlock_create_ruleset with
# ENOSYS, as a kernel without Landlock would. The helper must exit 120 without running the
# command, and `--abi` must print 0 and exit 120.
#
#   sh test/docker.sh [x86_64|aarch64]     default: this machine's architecture
set -eu

here=$(cd "$(dirname "$0")" && pwd)
arch=${1:-$(uname -m)}
case "$arch" in
  x86_64 | amd64) arch=x86_64 platform=linux/amd64 ;;
  aarch64 | arm64) arch=aarch64 platform=linux/arm64 ;;
  *) echo "unknown architecture: $arch"; exit 2 ;;
esac
bin="/landlock/bin/pair-landlock-$arch-linux"
run() { docker run --rm --platform "$platform" -u 1000:1000 -v "$here/..":/landlock:ro "$@"; }

run ubuntu:24.04 sh /landlock/test/live.sh "$bin"

echo "--- no Landlock (seccomp: landlock_create_ruleset -> ENOSYS)"
out=$(run --security-opt seccomp="$here/enosys-landlock.json" ubuntu:24.04 sh -c '
  printf "{\"rw_trees\":[\"/tmp\"],\"command\":\"touch /tmp/ran\"}\n" | '"$bin"' 2>&1; echo "rc=$? ran=$(test -e /tmp/ran && echo yes || echo no)"
  '"$bin"' --abi 2>&1; echo "abi_rc=$?"')
echo "$out"
expected='pair-landlock: Landlock is unavailable on this kernel (Function not implemented (os error 38))
rc=120 ran=no
0
pair-landlock: Landlock is unavailable on this kernel (Function not implemented (os error 38))
abi_rc=120'
if [ "$out" = "$expected" ]; then echo "PASS  exit 120 and nothing ran when Landlock is missing"; else echo "FAIL  no-Landlock case"; exit 1; fi
