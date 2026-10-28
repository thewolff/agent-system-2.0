#!/usr/bin/env bash
# as2-hosted: run each test file named in $W/files in its own `bun test` process, $JOBS at a time, each under a
# $FILE_CAP_S second limit, in the runner's child env (surface/src/test-run.ts childEnv, as as2-fast.yml builds it).
# One process per file means a hung file costs only itself, and every file gets its own JUnit, log, exit code and wall
# time: $W/out/junit/<n>.xml, $W/out/logs/<n>.log, and one line in $W/out/results.tsv (file, exit, seconds).
# Exit 0 only when every file exits 0. Exit 142 on a file is the time limit (SIGALRM).
set -uo pipefail
: "${W:?}" "${JOBS:?}" "${FILE_CAP_S:?}"
mkdir -p "$W/out/junit" "$W/out/logs"
: > "$W/out/results.tsv"

one() {
	local f="$1" n start code end
	n="$(printf '%s' "${f#./}" | tr '/' '_')"
	start=$(date +%s)
	env -i PATH="$W/shim:$PATH" LANG="${LANG:-C.UTF-8}" USER="$USER" LOGNAME="${LOGNAME:-$USER}" SHELL="${SHELL:-/bin/bash}" TERM="${TERM:-dumb}" \
		HOME="$W/home" TMPDIR="$W/home/tmp" XDG_CONFIG_HOME="$W/home/.config" XDG_CACHE_HOME="$W/home/.cache" XDG_DATA_HOME="$W/home/.local/share" \
		BUN_INSTALL_CACHE_DIR="$W/home/.bun/install/cache" AGENT_SYSTEM_LEDGER_DB="$W/home/.agent-system-2/ledger.db" \
		GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$W/home/.gitconfig" GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false \
		perl -e 'alarm shift @ARGV; exec @ARGV or die "exec: $!"' "$FILE_CAP_S" \
		bun test --reporter=junit --reporter-outfile="$W/out/junit/$n.xml" "$f" > "$W/out/logs/$n.log" 2>&1 < /dev/null
	code=$?
	end=$(date +%s)
	printf '%s\t%s\t%s\n' "$f" "$code" "$((end - start))" >> "$W/out/results.tsv"
	printf '%-70s exit %3s  %4ss\n' "$f" "$code" "$((end - start))"
}
export -f one
export W FILE_CAP_S

start=$(date +%s)
xargs -P "$JOBS" -n 1 bash -c 'one "$0"' < "$W/files"
end=$(date +%s)

total=$(wc -l < "$W/files" | tr -d ' ')
ok=$(awk -F'\t' '$2 == 0' "$W/out/results.tsv" | wc -l | tr -d ' ')
capped=$(awk -F'\t' '$2 == 142' "$W/out/results.tsv" | wc -l | tr -d ' ')
printf '%s: %s files, %s passed, %s failed (%s at the %ss cap), wall %s s\n' \
	"$RUNNER_OS" "$total" "$ok" "$((total - ok))" "$capped" "$FILE_CAP_S" "$((end - start))" | tee "$W/out/summary"
echo "failing files:"
awk -F'\t' '$2 != 0 { print "  " $1 " exit " $2 " (" $3 " s)" }' "$W/out/results.tsv" | sort
[ "$ok" -eq "$total" ]
