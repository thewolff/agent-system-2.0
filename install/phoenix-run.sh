#!/bin/bash
# agent-system 2.0: the process launchd runs for com.agent-system-2.phoenix (wl-mv65t5d34lts00,
# PLAN.md § 3 "The Phoenix LaunchAgent"). Starts phoenix-serve.py (beside this file) with the
# arize-phoenix uv tool's Python and watches it for its whole life:
#
#  (a) memory cap, PHOENIX_MEM_CAP_MB (default 1536) MiB, two layers.
#      Kernel layer, where macOS accepts it: the soft `ulimit -v` and `ulimit -d` (the limits the
#      kernel enforces) are set to the cap just before Phoenix is forked, so Phoenix inherits them,
#      and put back right after, so this wrapper's own samplers, lsof and sleep never run under them.
#      Each is logged as applied or with the shell's refusal; a refusal never fails the start.
#      Watchdog layer, always: every 1 s Phoenix's physical footprint (phoenix-footprint.py beside
#      this file, run with the same Python): what Phoenix holds, compressed or swapped pages included,
#      not RSS, which macOS keeps far below that under memory pressure (PLAN.md § 8.3). One sample
#      above the cap is logged, Phoenix gets SIGKILL at once and this wrapper exits 75. If the kernel
#      layer is refused, the cap means: the footprint may pass the cap for at most one 1 s sample
#      before SIGKILL. A sample that cannot be taken while Phoenix is alive fails closed: logged,
#      SIGKILL, exit 78.
#  (b) bind check: `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` every 1 s until both PHOENIX_PORT and
#      PHOENIX_GRPC_PORT listen on 127.0.0.1 (logged once as "bound"), then every 10 s. Any listener
#      whose address is not 127.0.0.1 is logged, Phoenix gets SIGKILL and this wrapper exits 78; so
#      does "not bound" 300 s after start, so an lsof that sees nothing cannot pass as clean.
#  TERM or INT (launchctl bootout) is forwarded to Phoenix; SIGKILL after 15 s if it is still up.
#
# Written for /bin/bash 3.2 (the plist runs it with /bin/bash). Every log line goes to stdout,
# which the plist sends to ~/.agent-system-2/phoenix/launchd.log.
#
# Env:  PHOENIX_PORT (6006), PHOENIX_GRPC_PORT (4317), PHOENIX_MEM_CAP_MB (1536),
#       PHOENIX_PYTHON (default $HOME/.local/share/uv/tools/arize-phoenix/bin/python); every other
#       PHOENIX_* variable (PHOENIX_WORKING_DIR, ...) passes through to Phoenix. PHOENIX_HOST is
#       always 127.0.0.1.
# Exit: Phoenix's own exit status when it exits by itself (78 from the shim: unchecked version)
#       75 memory cap: one footprint sample above PHOENIX_MEM_CAP_MB, Phoenix killed
#       78 a listener not on 127.0.0.1, or Phoenix's footprint cannot be sampled, or the two ports not
#          both bound on 127.0.0.1 within BIND_DEADLINE (300) s; Phoenix killed. Or a bad setting
#          (cap, ports, python, shim, sampler), Phoenix never started
#       143 TERM/INT forwarded and Phoenix stopped
set -u
# Listener addresses such as *:4317 are data, never globs.
set -f
BIND_DEADLINE=300

PORT="${PHOENIX_PORT:-6006}"
GRPC_PORT="${PHOENIX_GRPC_PORT:-4317}"
CAP_MB="${PHOENIX_MEM_CAP_MB:-1536}"
PY="${PHOENIX_PYTHON:-$HOME/.local/share/uv/tools/arize-phoenix/bin/python}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SHIM="$HERE/phoenix-serve.py"
FOOTPRINT="$HERE/phoenix-footprint.py"

log() { printf '%s phoenix-run[%s]: %s\n' "$(/bin/date '+%Y-%m-%dT%H:%M:%S%z')" "$$" "$*"; }
refuse() { log "refusing to start: $*"; exit 78; }

case "$CAP_MB" in '' | *[!0-9]*) refuse "PHOENIX_MEM_CAP_MB is not a whole number of MiB: '$CAP_MB'" ;; esac
case "$PORT$GRPC_PORT" in *[!0-9]*) refuse "PHOENIX_PORT and PHOENIX_GRPC_PORT must be numbers: '$PORT' '$GRPC_PORT'" ;; esac
[ -x "$PY" ] || refuse "no executable Python at PHOENIX_PYTHON=$PY"
[ -r "$SHIM" ] || refuse "no shim at $SHIM"
[ -r "$FOOTPRINT" ] || refuse "no footprint sampler at $FOOTPRINT"
CAP_KIB=$((CAP_MB * 1024))

export PHOENIX_HOST=127.0.0.1 PHOENIX_PORT="$PORT" PHOENIX_GRPC_PORT="$GRPC_PORT"
log "starting Phoenix: $PY $SHIM; HTTP 127.0.0.1:$PORT, gRPC 127.0.0.1:$GRPC_PORT; memory cap $CAP_MB MiB ($CAP_KIB KiB): kernel layer tried below, watchdog SIGKILL on the first 1 s footprint sample above it"

# Kernel layer: soft limits for the fork that becomes Phoenix only (see the header).
OLD_V="$(ulimit -S -v)"
OLD_D="$(ulimit -S -d)"
for flag in v d; do
	if ulimit -S "-$flag" "$CAP_KIB" 2>/dev/null; then
		log "kernel layer: ulimit -$flag $CAP_KIB applied"
	else
		log "kernel layer: ulimit -$flag $CAP_KIB refused: $(ulimit -S "-$flag" "$CAP_KIB" 2>&1)"
	fi
done
"$PY" "$SHIM" &
CHILD=$!
ulimit -S -v "$OLD_V" 2>/dev/null || log "kernel layer: could not restore the wrapper's soft ulimit -v $OLD_V"
ulimit -S -d "$OLD_D" 2>/dev/null || log "kernel layer: could not restore the wrapper's soft ulimit -d $OLD_D"

stop_child() {
	kill -KILL "$CHILD" 2>/dev/null
	wait "$CHILD" 2>/dev/null
}

on_term() {
	log "TERM/INT received; forwarding TERM to Phoenix pid $CHILD"
	kill -TERM "$CHILD" 2>/dev/null
	i=0
	while kill -0 "$CHILD" 2>/dev/null && [ "$i" -lt 15 ]; do
		/bin/sleep 1
		i=$((i + 1))
	done
	if kill -0 "$CHILD" 2>/dev/null; then
		log "Phoenix pid $CHILD still up 15 s after TERM; SIGKILL"
		stop_child
	else
		wait "$CHILD" 2>/dev/null
	fi
	log "stopped; exit 143"
	exit 143
}
trap on_term TERM INT

BOUND=0
TICK=0
while :; do
	if ! kill -0 "$CHILD" 2>/dev/null; then
		wait "$CHILD"
		status=$?
		log "Phoenix pid $CHILD exited $status; exit $status"
		exit "$status"
	fi

	# -I -S: no site packages or user env, so a sample is the interpreter's startup and one libSystem call.
	fp_out="$("$PY" -I -S "$FOOTPRINT" "$CHILD" 2>&1)"
	case "$fp_out" in
		'' | *[!0-9]*)
			# No number: Phoenix exited between the two checks (handled at the loop's top), or the sampler
			# failed. The cap fails closed, never open.
			if kill -0 "$CHILD" 2>/dev/null; then
				log "memory cap: cannot sample Phoenix pid $CHILD's footprint (sampler said: ${fp_out:-nothing}); the cap cannot be enforced; SIGKILL"
				stop_child
				log "memory cap: Phoenix killed; exit 78"
				exit 78
			fi
			continue
			;;
	esac
	if [ "$fp_out" -gt "$CAP_KIB" ]; then
		log "memory cap: footprint sample $fp_out KiB > cap $CAP_KIB KiB ($CAP_MB MiB); SIGKILL Phoenix pid $CHILD"
		stop_child
		log "memory cap: Phoenix killed; exit 75"
		exit 75
	fi

	if [ "$BOUND" = 0 ] || [ $((TICK % 10)) = 0 ]; then
		listeners="$(/usr/sbin/lsof -nP -a -p "$CHILD" -iTCP -sTCP:LISTEN -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p')"
		for addr in $listeners; do
			case "$addr" in
				127.0.0.1:*) ;;
				*)
					log "bind check: Phoenix pid $CHILD listens on $addr, not 127.0.0.1 (all: $(echo $listeners)); SIGKILL"
					stop_child
					log "bind check: Phoenix killed; exit 78"
					exit 78
					;;
			esac
		done
		# Each port is matched on its own: one pattern for both would need a space between the two
		# addresses that the first match has already used, so it never matched them side by side.
		seen=" $(echo $listeners) "
		case "$seen" in *" 127.0.0.1:$PORT "*) http_up=1 ;; *) http_up=0 ;; esac
		case "$seen" in *" 127.0.0.1:$GRPC_PORT "*) grpc_up=1 ;; *) grpc_up=0 ;; esac
		case "$http_up$grpc_up" in
			11)
				if [ "$BOUND" = 0 ]; then
					BOUND=1
					log "bound: $(echo $listeners)"
				fi
				;;
			*)
				# lsof seeing nothing at all (denied, failing, or Phoenix wedged) must not pass as a clean check:
				# before the first bind it has until the deadline; after it, the check fails closed at once
				# (review r1: an inspection failure after binding must not disable the guard for the process's life).
				if [ "$BOUND" = 1 ]; then
					log "bind check: 127.0.0.1:$PORT and 127.0.0.1:$GRPC_PORT no longer both visible to lsof (seen: $(echo $listeners)); the bind check cannot be enforced; SIGKILL"
					stop_child
					log "bind check: Phoenix killed; exit 78"
					exit 78
				fi
				if [ "$SECONDS" -ge "$BIND_DEADLINE" ]; then
					log "bind check: 127.0.0.1:$PORT and 127.0.0.1:$GRPC_PORT not both listening ${SECONDS} s after start (seen: $(echo $listeners)); SIGKILL"
					stop_child
					log "bind check: Phoenix killed; exit 78"
					exit 78
				fi
				;;
		esac
	fi

	TICK=$((TICK + 1))
	/bin/sleep 1 &
	wait $!
done
