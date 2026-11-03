#!/usr/bin/env bash
# agent-system 2.0: the Phoenix LaunchAgent install step (wl-mv65t5d34lts00, PLAN.md §§ 3, 8). Phoenix is on
# by default: install/install.sh runs `on` on macOS unless observability.phoenix is off, and only from the
# user's own HOME (guard_domain below refuses any other). Idempotent and safe from the top: every check runs
# before anything is written, and a second `on` rewrites the same files and reloads the job.
#
#   on      Checks macOS, launchctl, the `phoenix` uv tool (its Python, from the tool's #! line, must
#           carry the arize-phoenix version phoenix-serve.py was checked against), and that the
#           Phoenix home is not inside a git work tree (a checkout that a lane cleanup could remove,
#           or a repo the trace data could be committed to). Then creates <home>/{bin,data} (0700,
#           the home too), copies phoenix-run.sh, phoenix-serve.py and phoenix-footprint.py into <home>/bin (the plist
#           never points into a checkout), fills install/com.agent-system-2.phoenix.plist into
#           <launch agents>/com.agent-system-2.phoenix.plist, boots a loaded job out (and waits for
#           launchd to drop it), bootstraps gui/<uid>, waits up to PHOENIX_HEALTH_WAIT seconds for
#           http://127.0.0.1:<port>/healthz, prints the listeners and the undo.
#   off     Boots the job out and deletes the plist. Fails closed like install.sh
#           --chaos-nightly=off: only `launchctl print` exiting 113 with "Could not find service"
#           counts as not loaded; any other answer keeps the plist and exits 1. The data is kept; its
#           `rm -r` is printed, never run.
#   status  Prints the plist, loaded or not, the wrapper's and Phoenix's pid, Phoenix's RSS and
#           memory footprint (the figure the cap compares), the listeners on the two ports and the health answer.
#
# Usage: bash install/phoenix-agent.sh on|off|status
# Env (defaults in brackets; the overrides exist for tests):
#   PHOENIX_AGENT_HOME       [$HOME/.agent-system-2/phoenix] bin/, data/ and launchd.log
#   LAUNCH_AGENTS_DIR        [$HOME/Library/LaunchAgents]
#   LAUNCHCTL                [launchctl]
#   PHOENIX_TOOL             [`phoenix` on PATH] the arize-phoenix uv tool's entry script
#   PHOENIX_AGENT_PORT       [6006] Phoenix HTTP (UI, OTLP/HTTP) port on 127.0.0.1
#   PHOENIX_AGENT_GRPC_PORT  [4317] Phoenix OTLP gRPC port on 127.0.0.1
#   PHOENIX_HEALTH_WAIT      [240] seconds `on` waits for /healthz (cold starts measured 17 s and 83 s to bind;
#                            below phoenix-run.sh's 300 s BIND_DEADLINE, past which the wrapper kills Phoenix)
# Exit: 0 done (status: loaded and healthy)
#       1 launchctl failed or could not confirm the job's state (off: plist kept), Phoenix not
#         healthy in time (on: the job stays loaded; launchd.log tail printed), or status found it
#         not loaded or not healthy
#       2 a check refused before anything was written, or a usage error
# Undo of `on`: bash install/phoenix-agent.sh off   (then, for the data: the printed rm -r)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.agent-system-2.phoenix"
TEMPLATE="$REPO/install/$LABEL.plist"
WRAPPER_SRC="$REPO/install/phoenix-run.sh"
SHIM_SRC="$REPO/install/phoenix-serve.py"
FOOTPRINT_SRC="$REPO/install/phoenix-footprint.py"
PHOENIX_HOME="${PHOENIX_AGENT_HOME:-$HOME/.agent-system-2/phoenix}"
AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$AGENTS_DIR/$LABEL.plist"
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
PORT="${PHOENIX_AGENT_PORT:-6006}"
GRPC_PORT="${PHOENIX_AGENT_GRPC_PORT:-4317}"
HEALTH_WAIT="${PHOENIX_HEALTH_WAIT:-240}"
SERVICE="gui/$UID/$LABEL"
UNDO="bash $REPO/install/phoenix-agent.sh off"

step() { printf '==> %s\n' "$*"; }
fail() { printf 'phoenix-agent: FAIL: %s\n' "$1" >&2; exit "${2:-1}"; }
# Temp files of an interrupted or refused `on` never outlive the run.
trap 'rm -f "$PLIST.tmp.$$" "$PHOENIX_HOME/bin/phoenix-run.sh.tmp.$$" "$PHOENIX_HOME/bin/phoenix-serve.py.tmp.$$" "$PHOENIX_HOME/bin/phoenix-footprint.py.tmp.$$"' EXIT

# loaded | absent | unknown: <why>. Only exit 113 with "Could not find service" means absent (what
# launchd answers for a label it does not have; install/install.sh --chaos-nightly=off relies on it).
service_state() {
	local err status
	if err="$("$LAUNCHCTL" print "$SERVICE" 2>&1 >/dev/null)"; then
		echo loaded
		return
	else
		status=$?
	fi
	if [ "$status" = 113 ] && [[ "$err" == *"Could not find service"* ]]; then
		echo absent
	else
		echo "unknown: launchctl print $SERVICE exited $status (${err:-no stderr})"
	fi
}

# Boot a loaded job out and wait until launchd no longer has it (bootstrap refuses a label it still
# holds). Fails closed on any state it cannot read.
bootout_if_loaded() {
	local state i
	state="$(service_state)"
	case "$state" in
		absent) step "no job loaded at $SERVICE"; return ;;
		loaded) ;;
		*) fail "$state; whether the job is loaded is unknown${1:+; $1}" 1 ;;
	esac
	"$LAUNCHCTL" bootout "$SERVICE" || fail "launchctl bootout $SERVICE exited $?${1:+; $1}" 1
	for ((i = 0; i < 30; i++)); do
		state="$(service_state)"
		case "$state" in
			absent) step "booted out: $SERVICE"; return ;;
			loaded) sleep 1 ;;
			*) fail "after bootout, $state${1:+; $1}" 1 ;;
		esac
	done
	fail "$SERVICE is still loaded 30 s after bootout${1:+; $1}" 1
}

listeners() {
	/usr/sbin/lsof -nP -iTCP:"$PORT" -iTCP:"$GRPC_PORT" -sTCP:LISTEN 2>/dev/null || echo "    (nothing listening on $PORT or $GRPC_PORT)"
}

healthy() {
	/usr/bin/curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null
}

# The pid of the Phoenix process this job runs: the wrapper is the pid launchd reports for the job, and
# Phoenix is its phoenix-serve.py child. Empty when the job has no running process.
job_phoenix_pid() {
	local wrapper_pid
	wrapper_pid="$("$LAUNCHCTL" print "$SERVICE" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -n 1 || true)"
	[ -n "$wrapper_pid" ] || return 0
	pgrep -P "$wrapper_pid" -f phoenix-serve.py | head -n 1 || true
}

# Health that counts: /healthz answers AND the job's own Phoenix process holds the listener on $PORT, so
# another service answering on the port is never taken for this job (review r2).
job_healthy() {
	local pid
	healthy || return 1
	pid="$(job_phoenix_pid)" || return 1
	[ -n "$pid" ] && /usr/sbin/lsof -nP -a -p "$pid" -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

# One pass over the launchd template, the same contract as install.sh's fill_template: each @NAME@
# is replaced by its value from the NAME=value arguments, XML-escaped; substituted text is never
# scanned again; an @NAME@ with no value fails. Done with the tool's Python (a hard dependency of
# this step anyway), so `on` needs no bun.
fill_template() {
	"$PY" - "$@" <<'PY'
import re
import sys
from xml.sax.saxutils import escape

template, *pairs = sys.argv[1:]
values = dict(pair.split("=", 1) for pair in pairs)


def fill(match):
    if match.group(1) not in values:
        sys.exit(f"phoenix-agent: {template} has {match.group(0)}, which has no value")
    return escape(values[match.group(1)], {'"': "&quot;", "'": "&apos;"})


with open(template, encoding="utf-8") as f:
    text = re.sub(r"@([A-Z_]+)@", fill, f.read())
sys.stdout.write(text if text.endswith("\n") else text + "\n")
PY
}

# Copy src to dest with mode, through a temp file in dest's directory, so a reader never sees half
# a file and a re-run leaves identical bytes.
place() {
	local src="$1" dest="$2" mode="$3"
	cp "$src" "$dest.tmp.$$" && chmod "$mode" "$dest.tmp.$$" && mv -f "$dest.tmp.$$" "$dest" \
		|| fail "could not place $src at $dest" 1
}

# The real launchctl acts on this user's one gui/<uid> domain, whatever $HOME says, so on and off refuse it
# unless $HOME is this user's own home directory, read from the user database (dscl), never from $HOME:
# from a temp HOME, `on` would boot out the user's running Phoenix and load a job pointing into a directory
# about to be deleted (it did, from an install test, 2026-10-14). A LAUNCHCTL that is not /bin/launchctl (a
# test's stub) acts on nothing real and is let through.
guard_domain() {
	local real
	[ "$(command -v "$LAUNCHCTL" 2>/dev/null || true)" = /bin/launchctl ] || return 0
	real="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory: //p')" || real=""
	[ -n "$real" ] || fail "this user's home directory could not be read from the user database (dscl); $SERVICE is not touched" 2
	[ "$(cd "$HOME" 2>/dev/null && pwd -P)" = "$(cd "$real" 2>/dev/null && pwd -P)" ] \
		|| fail "HOME ($HOME) is not this user's home directory ($real); launchd has one $SERVICE per user, so it is not touched from here" 2
}

cmd_on() {
	guard_domain
	# ---- checks: nothing is written until every one passes ----
	[ "$(uname -s)" = Darwin ] || fail "Phoenix runs as a launchd job; this is not macOS" 2
	command -v "$LAUNCHCTL" >/dev/null 2>&1 || fail "launchctl not found (LAUNCHCTL=$LAUNCHCTL)" 2
	case "$PORT$GRPC_PORT$HEALTH_WAIT" in *[!0-9]*) fail "PHOENIX_AGENT_PORT, PHOENIX_AGENT_GRPC_PORT and PHOENIX_HEALTH_WAIT must be numbers" 2 ;; esac
	for f in "$TEMPLATE" "$WRAPPER_SRC" "$SHIM_SRC"; do
		[ -f "$f" ] || fail "missing $f" 2
	done
	local tool="${PHOENIX_TOOL:-}"
	[ -n "$tool" ] || tool="$(command -v phoenix || true)"
	[ -n "$tool" ] && [ -f "$tool" ] \
		|| fail "the phoenix tool is not on PATH (install it: uv tool install arize-phoenix)" 2
	local shebang
	shebang="$(head -n 1 "$tool")"
	PY="${shebang#\#!}"
	[ "$shebang" != "$PY" ] && [ -x "$PY" ] || fail "$tool has no #! line naming an executable Python (got: $shebang)" 2
	local want have
	want="$(sed -n 's/^CHECKED_VERSION = "\(.*\)"$/\1/p' "$SHIM_SRC")"
	have="$("$PY" -c 'from importlib.metadata import version; print(version("arize-phoenix"))' 2>/dev/null)" \
		|| fail "$PY cannot report an arize-phoenix version" 2
	[ "$have" = "$want" ] \
		|| fail "arize-phoenix is $have; phoenix-serve.py was checked against $want only (an upgrade needs the shim re-checked)" 2
	command -v git >/dev/null 2>&1 || fail "git not found, so whether $PHOENIX_HOME is inside a git work tree cannot be checked; install git or put it on PATH" 2
	local probe="$PHOENIX_HOME/data"
	while [ ! -d "$probe" ]; do probe="$(dirname "$probe")"; done
	if git -C "$probe" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
		fail "the Phoenix home $PHOENIX_HOME is inside a git work tree ($(git -C "$probe" rev-parse --show-toplevel)); set it outside any repo" 2
	fi
	step "checks passed: macOS, $LAUNCHCTL, $tool (arize-phoenix $have, $PY), $PHOENIX_HOME not in a git work tree"

	# ---- files ----
	mkdir -p "$PHOENIX_HOME/bin" "$PHOENIX_HOME/data" "$AGENTS_DIR"
	chmod 700 "$PHOENIX_HOME" "$PHOENIX_HOME/bin" "$PHOENIX_HOME/data"
	place "$WRAPPER_SRC" "$PHOENIX_HOME/bin/phoenix-run.sh" 755
	place "$SHIM_SRC" "$PHOENIX_HOME/bin/phoenix-serve.py" 644
	place "$FOOTPRINT_SRC" "$PHOENIX_HOME/bin/phoenix-footprint.py" 644
	step "copied phoenix-run.sh, phoenix-serve.py and phoenix-footprint.py into $PHOENIX_HOME/bin (0700 dirs: $PHOENIX_HOME, bin, data)"
	fill_template "$TEMPLATE" "HOME=$HOME" "PHOENIX_HOME=$PHOENIX_HOME" "PYTHON=$PY" "PORT=$PORT" "GRPC_PORT=$GRPC_PORT" \
		>"$PLIST.tmp.$$" || fail "the template ${TEMPLATE##*/} could not be filled" 1
	/usr/bin/plutil -lint "$PLIST.tmp.$$" >/dev/null || fail "the filled plist does not lint" 1

	# ---- load ----
	bootout_if_loaded "new plist not installed; the old one at $PLIST is kept"
	mv -f "$PLIST.tmp.$$" "$PLIST"
	"$LAUNCHCTL" bootstrap "gui/$UID" "$PLIST" || fail "launchctl bootstrap gui/$UID $PLIST exited $?" 1
	step "loaded: $SERVICE from $PLIST"

	# ---- health ----
	local i
	for ((i = 0; i <= HEALTH_WAIT; i++)); do
		if job_healthy; then
			step "healthy: http://127.0.0.1:$PORT/healthz answered after ${i} s, served by this job's Phoenix (pid $(job_phoenix_pid))"
			step "listeners:"
			listeners
			step "UI: http://127.0.0.1:$PORT   log: $PHOENIX_HOME/launchd.log"
			step "undo: $UNDO"
			return 0
		fi
		if [ "$i" -lt "$HEALTH_WAIT" ]; then sleep 1; fi
	done
	step "launchd.log, last 20 lines:"
	tail -n 20 "$PHOENIX_HOME/launchd.log" 2>/dev/null || echo "    (no log at $PHOENIX_HOME/launchd.log)"
	step "listeners:"
	listeners
	fail "this job's Phoenix did not answer http://127.0.0.1:$PORT/healthz from its own listener within $HEALTH_WAIT s; the job stays loaded (launchd retries it); undo: $UNDO" 1
}

cmd_off() {
	guard_domain
	step "Phoenix off: $SERVICE, $PLIST"
	command -v "$LAUNCHCTL" >/dev/null 2>&1 \
		|| fail "launchctl not found (LAUNCHCTL=$LAUNCHCTL), so whether $SERVICE is loaded is unknown; $PLIST is kept" 1
	bootout_if_loaded "$PLIST is kept"
	if [ -e "$PLIST" ] || [ -L "$PLIST" ]; then
		rm -f "$PLIST" || fail "could not remove $PLIST" 1
		step "removed $PLIST"
	else
		step "no plist at $PLIST"
	fi
	step "Phoenix off: no job loaded, no plist. Data kept in $PHOENIX_HOME; to delete it (traces, bin, log):"
	printf '    rm -r %q\n' "$PHOENIX_HOME"
	step "to turn it back on: bash $REPO/install/phoenix-agent.sh on"
}

cmd_status() {
	local state ok=0 out wrapper_pid phoenix_pid
	if [ -e "$PLIST" ]; then step "plist: $PLIST"; else step "plist: none at $PLIST"; ok=1; fi
	command -v "$LAUNCHCTL" >/dev/null 2>&1 || fail "launchctl not found (LAUNCHCTL=$LAUNCHCTL)" 1
	state="$(service_state)"
	step "job $SERVICE: $state"
	if [ "$state" = loaded ]; then
		out="$("$LAUNCHCTL" print "$SERVICE" 2>/dev/null || true)"
		wrapper_pid="$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -n 1 || true)"
		printf '%s\n' "$out" | grep -E '^[[:space:]]*(state|last exit code|runs) = ' | sed 's/^[[:space:]]*/    /' || true
		if [ -n "$wrapper_pid" ]; then
			step "wrapper pid $wrapper_pid, RSS $(ps -o rss= -p "$wrapper_pid" | tr -d ' ') KiB"
			phoenix_pid="$(pgrep -P "$wrapper_pid" -f phoenix-serve.py | head -n 1 || true)"
			if [ -n "$phoenix_pid" ]; then
				# The footprint is sampled the way the wrapper does it, with the uv tool's Python (its default PHOENIX_PYTHON).
				step "Phoenix pid $phoenix_pid, RSS $(ps -o rss= -p "$phoenix_pid" | tr -d ' ') KiB, footprint $("${PHOENIX_PYTHON:-$HOME/.local/share/uv/tools/arize-phoenix/bin/python}" -I -S "$FOOTPRINT_SRC" "$phoenix_pid" 2>&1) KiB (the cap compares the footprint)"
			else
				step "Phoenix: no child process of the wrapper"
			fi
		else
			step "no running process (launchd may be waiting out ThrottleInterval after an exit)"
		fi
	else
		ok=1
	fi
	step "listeners on $PORT and $GRPC_PORT:"
	listeners
	if job_healthy; then step "health: http://127.0.0.1:$PORT/healthz OK, served by this job's Phoenix"; else step "health: http://127.0.0.1:$PORT/healthz did not answer from this job's Phoenix"; ok=1; fi
	return "$ok"
}

case "$#:${1-}" in
	1:on) cmd_on ;;
	1:off) cmd_off ;;
	1:status) cmd_status ;;
	*) fail "usage: bash install/phoenix-agent.sh on|off|status; got: $*" 2 ;;
esac
