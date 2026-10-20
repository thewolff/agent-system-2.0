#!/usr/bin/env bash
# agent-system 2.0 install (migration steps M2 ledger, M6 profile + skills).
#
# Reads install/manifest.tsv (SPEC-2.0.md § B8: the manifest IS the machinery table) and installs
# each row by its kind. Today that means: create or verify the ledger from the manifest's one
# ledger-schema row, using its one ledger-init row, take the first scheduled copy with its one
# ledger-backup row, (macOS) write the periodic backup job from its one ledger-backup-agent row
# into $HOME/Library/LaunchAgents (written, never loaded: the load command is printed at the end),
# and build the OMP profile: render the `profile` row profile/config.yml with {repo} filled into
# $HOME/.omp/profiles/<profile>/agent/config.yml, place the `profile` row profile/models.yml beside
# it, render the `profile` row profile/AGENTS.md (the OMP harness card, which OMP loads into every
# top-level session of the profile as user context) with {repo} filled into the same directory, link
# the `profile` rows profile/OMP-HARNESS.md (the full harness guide) and profile/OMP-RUNTIME.md (its
# runtime companion) there, and link every `tier` row
# into $HOME/.omp/profiles/<profile>/agent/agents/. `skill` rows
# (skills/<name>/SKILL.md or plugins/<p>/skills/<n>/SKILL.md) and `skill-asset` rows are used in place through the profile's
# skills.customDirectories; the render is refused when its skills.includeSkills is not exactly
# the set of `skill` rows, or when a `skill` row lacks a frontmatter description (omp://skills.md:
# the native provider requires one). Each `launcher` row (bin/<name>, destination
# {local_bin}/<name>) is linked to $HOME/.local/bin/<name> the way the tier files are, so `as2`
# is one word on PATH; the directory is created if absent and a notice is printed when it is not
# on PATH. The `profile` row profile/mcp.json is placed beside config.yml: OMP reads a profile's
# user MCP config from that profile's own agent directory only, so the ctx MCP server reaches an as2
# session through this file and not through ~/.omp/agent/mcp.json. The profile's session directory
# is registered as a named ctx `pi` history root (per-machine ctx state, not a manifest row), so
# as2 transcripts are in the ctx index. The tracing switch (observability.phoenix) keeps its installed
# value across a re-install, and on macOS, unless that value is off and only when $HOME is this user's
# own home, the Phoenix LaunchAgent is (re)installed with install/phoenix-agent.sh on; a Phoenix that
# does not start is reported and does not fail the install. The last line names the providers the rendered profile
# routes to and says each needs a /login once per profile (the profile's setupVersion skips OMP's
# first-launch sign-in scene).
# File links also install in the default OMP profile (persistent seats do not use the as2 profile):
# ~/.omp/agent/extensions/as2-open-links.ts points into this checkout. If herdr is on PATH, its
# as2.file-links plugin is linked from install/herdr-file-links; without herdr one notice is printed.
# Reversal: herdr plugin unlink as2.file-links; remove the default-profile extension symlink.
#
# Three flags (macOS only), each optional and usable together. --chaos-nightly also writes the nightly
# chaos job: the template install/com.agent-system-2.chaos.plist filled with this checkout, the
# absolute bun path, $HOME and a PATH of the bun, omp and git directories, written to
# $HOME/Library/LaunchAgents/com.agent-system-2.chaos.plist and loaded with
# `launchctl bootstrap gui/$UID` (a loaded copy is booted out first). Its log goes to
# $HOME/agent-scratch/agent-system-2.0/chaos/launchd.log. --scratch-sweep writes the daily scratch
# sweep job the same way: install/com.agent-system-2.scratch-sweep.plist filled with this checkout,
# the absolute bun path, $HOME and the ledger path, written to
# $HOME/Library/LaunchAgents/com.agent-system-2.scratch-sweep.plist and loaded; it runs
# surface/scripts/scratch-sweep.ts at 04:30 local time, logging to
# $HOME/agent-scratch/agent-system-2.0/scratch-sweep/launchd.log. --train-tick writes the merge train's
# tick (PLAN wl-mv8s8srodefytc rev 17.1 D10) the same way: install/com.agent-system-2.train-tick.plist
# filled with this checkout, the absolute bun path, $HOME, the ledger path, the profile name and a PATH
# of the gh, bun, omp, git and osascript directories, written to
# $HOME/Library/LaunchAgents/com.agent-system-2.train-tick.plist and loaded; it runs
# surface/scripts/train-tick.ts every 300 s, logging to
# $HOME/agent-scratch/agent-system-2.0/train-tick/launchd.log. Each flag's =off form only boots
# that job out and deletes its plist, then exits: it runs right after the arguments are read, before
# the bun check and every install step, so it needs no bun, writes no ledger and registers nothing
# (stopping a job never depends on a reinstall succeeding). It fails closed: when launchctl is missing
# or cannot confirm the job is absent, it says why, keeps the plist and exits 1. The =off forms
# may be given together; an =off form with an installing flag is refused. Without a flag nothing
# about its job is written, read or run.
#
# Usage:   bash install/install.sh [--chaos-nightly | --chaos-nightly=off] [--scratch-sweep | --scratch-sweep=off]
#                                  [--train-tick | --train-tick=off]
# Env:     AGENT_SYSTEM_LEDGER_DB   ledger file (default: $HOME/.agent-system-2/ledger.db)
#          AGENT_SYSTEM_PROFILE     OMP profile name (default: agent-system-2); the profile lives at
#                                   $HOME/.omp/profiles/<profile>/agent (omp://config-usage.md § Profiles)
# Exit:    0 installed, or (=off) each named job is confirmed not loaded and its plist is gone
#          1 other failure (=off: launchctl not on PATH, `launchctl print` failed for a reason other
#            than "Could not find service", or bootout failed, each with the plist kept; or the
#            plist removal failed)
#          2 manifest or profile check failed, an argument other than the flags (or a flag twice, or
#            an =off form with an installing flag), --chaos-nightly refused: not macOS, or omp or git
#            not on PATH, or --scratch-sweep refused: not macOS, or --train-tick refused: not macOS, gh,
#            bun, omp, git or osascript not on PATH, or `gh auth status` failed (nothing written)
#          3 ledger path refused as synced or network folder (nothing written)
#          4 the ledger file exists at a schema version other than the supported one (5), e.g. a
#            version-1 to -4 ledger from before schema v5 (nothing written; no upgrade exists:
#            move the file aside and re-run to create a new ledger)
#
# Order matters: every check runs before anything is written, so a failed install leaves the
# machine as it found it. Safe to re-run: an existing ledger at the current schema is untouched,
# and the backup job's plist is rewritten with the same content.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$REPO/install/manifest.tsv"
# Directories whose every file must have a manifest row. Listed ahead of the steps that create
# them so a new directory cannot slip in unchecked.
MACHINERY_DIRS=(ledger install extensions agents profile skills plugins tiers classifier gates bin surface contract voice)
# The one schema file the ledger module applies (ledger/src/index.ts SCHEMA_PATH). The manifest's
# ledger-schema row must name exactly this file; the init script re-checks it against the module.
CANONICAL_SCHEMA="ledger/schema.sql"
LEDGER_DB="${AGENT_SYSTEM_LEDGER_DB:-$HOME/.agent-system-2/ledger.db}"
# launchd runs the job with / as its working directory, so the plist carries an absolute path.
case "$LEDGER_DB" in /*) LEDGER_ABS="$LEDGER_DB" ;; *) LEDGER_ABS="$PWD/$LEDGER_DB" ;; esac
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PROFILE_NAME="${AGENT_SYSTEM_PROFILE:-agent-system-2}"
PROFILE_DIR="$HOME/.omp/profiles/$PROFILE_NAME/agent"
LOCAL_BIN="$HOME/.local/bin"

step() { printf '==> %s\n' "$*"; }
fail() { printf 'install: FAIL: %s\n' "$1" >&2; exit "${2:-1}"; }

# The three launchd jobs: each off unless its flag names it (empty = do nothing about it at all).
CHAOS=""
SWEEP=""
TICK=""
USAGE="usage: bash install/install.sh [--chaos-nightly | --chaos-nightly=off] [--scratch-sweep | --scratch-sweep=off] [--train-tick | --train-tick=off]"
for arg in "$@"; do
	case "$arg" in
		--chaos-nightly | --chaos-nightly=off)
			[ -z "$CHAOS" ] || fail "$USAGE; the chaos flag is given twice: $*" 2
			if [ "$arg" = --chaos-nightly ]; then CHAOS=on; else CHAOS=off; fi ;;
		--scratch-sweep | --scratch-sweep=off)
			[ -z "$SWEEP" ] || fail "$USAGE; the scratch-sweep flag is given twice: $*" 2
			if [ "$arg" = --scratch-sweep ]; then SWEEP=on; else SWEEP=off; fi ;;
		--train-tick | --train-tick=off)
			[ -z "$TICK" ] || fail "$USAGE; the train-tick flag is given twice: $*" 2
			if [ "$arg" = --train-tick ]; then TICK=on; else TICK=off; fi ;;
		*) fail "$USAGE; got: $*" 2 ;;
	esac
done
# An =off form stops its job and exits before any install step, so it cannot share a run with a flag
# that installs one.
if { [ "$CHAOS" = off ] || [ "$SWEEP" = off ] || [ "$TICK" = off ]; } && { [ "$CHAOS" = on ] || [ "$SWEEP" = on ] || [ "$TICK" = on ]; }; then
	fail "$USAGE; an =off form stops a job and exits, so it cannot be combined with a flag that installs one; got: $*" 2
fi

CHAOS_LABEL="com.agent-system-2.chaos"
CHAOS_TEMPLATE="$REPO/install/$CHAOS_LABEL.plist"
CHAOS_PLIST="$LAUNCH_AGENTS/$CHAOS_LABEL.plist"
CHAOS_LOG_DIR="$HOME/agent-scratch/agent-system-2.0/chaos"
SWEEP_LABEL="com.agent-system-2.scratch-sweep"
SWEEP_TEMPLATE="$REPO/install/$SWEEP_LABEL.plist"
SWEEP_PLIST="$LAUNCH_AGENTS/$SWEEP_LABEL.plist"
SWEEP_LOG_DIR="$HOME/agent-scratch/agent-system-2.0/scratch-sweep"
TICK_LABEL="com.agent-system-2.train-tick"
TICK_TEMPLATE="$REPO/install/$TICK_LABEL.plist"
TICK_PLIST="$LAUNCH_AGENTS/$TICK_LABEL.plist"
TICK_LOG_DIR="$HOME/agent-scratch/agent-system-2.0/train-tick"

# An =off form: stop the job and delete its plist (job_off NAME LABEL PLIST), then exit, before anything
# else runs. It reads no manifest, needs no bun, and writes nothing but the plist removal. It fails
# closed: only `launchctl print` exiting 113 with "Could not find service" on stderr (what launchd
# answers for a label it does not have, checked 2026-10-12 on macOS 26.6 against
# gui/<uid>/com.agent-system-2.nonexistent-probe: exit 113, stderr "Bad request." then "Could not find
# service ...") confirms the job is absent. Any other failure, or no launchctl at all, cannot tell
# absent from loaded, so the plist is kept and the run exits 1: deleting the plist of a job that may
# still be loaded would leave it running with no file to show for it.
job_off() {
	local name="$1" service="gui/$UID/$2" plist="$3" print_err print_status
	step "$name off: $service, $plist"
	command -v launchctl >/dev/null 2>&1 \
		|| fail "launchctl not found on PATH, so whether $service is loaded is unknown; $plist is kept" 1
	if print_err="$(launchctl print "$service" 2>&1 >/dev/null)"; then print_status=0; else print_status=$?; fi
	if [ "$print_status" = 0 ]; then
		launchctl bootout "$service" || fail "launchctl bootout $service exited $?; $plist is kept" 1
		step "$name booted out: $service"
	elif [ "$print_status" = 113 ] && [[ "$print_err" == *"Could not find service"* ]]; then
		step "$name: no job loaded at $service"
	else
		fail "launchctl print $service exited $print_status (${print_err:-no stderr}), so whether the job is loaded is unknown; $plist is kept" 1
	fi
	if [ -e "$plist" ] || [ -L "$plist" ]; then
		rm -f "$plist" || fail "could not remove $plist" 1
		step "$name removed: $plist"
	else
		step "$name: no plist at $plist"
	fi
	step "$name off: no job loaded, no plist"
}
if [ "$CHAOS" = off ] || [ "$SWEEP" = off ] || [ "$TICK" = off ]; then
	if [ "$CHAOS" = off ]; then job_off "chaos nightly" "$CHAOS_LABEL" "$CHAOS_PLIST"; fi
	if [ "$SWEEP" = off ]; then job_off "scratch sweep" "$SWEEP_LABEL" "$SWEEP_PLIST"; fi
	if [ "$TICK" = off ]; then job_off "train tick" "$TICK_LABEL" "$TICK_PLIST"; fi
	step "nothing else was run or written"
	exit 0
fi

command -v bun >/dev/null 2>&1 || fail "bun not found on PATH (the ledger module runs on bun:sqlite)"

# One pass over a launchd template: each @NAME@ in the template is replaced by its value from the
# NAME=value arguments, XML-escaped; substituted text is never scanned again, so a value may contain
# "@REPO@" or "&" literally. An @NAME@ in the template with no value here fails the render.
fill_template() {
	bun -e '
		const [template, ...pairs] = process.argv.slice(1);
		const values = new Map(pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
		const escape = (s) => s.replace(/[&<>"\x27]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "\x27": "&apos;" })[c]);
		const text = (await Bun.file(template).text()).replace(/@([A-Z_]+)@/g, (token, name) => {
			if (!values.has(name)) { console.error(`install: ${template} has ${token}, which has no value`); process.exit(1); }
			return escape(values.get(name));
		});
		process.stdout.write(text.endsWith("\n") ? text : text + "\n");
	' "$@"
}

# Write a filled launchd template and (re)load it: load_job NAME LABEL TEMPLATE PLIST LOGDIR NAME=value...
# launchd keeps the plist a job was bootstrapped with and refuses to bootstrap a label that is already
# loaded, so a loaded job is booted out before the new plist replaces it; `launchctl print` exits 113
# for a label that is not loaded. The filled plist must lint before anything is booted out.
load_job() {
	local name="$1" label="$2" template="$3" plist="$4" logdir="$5" status
	shift 5
	step "$name: install/${template##*/} -> $plist"
	mkdir -p "$LAUNCH_AGENTS" "$logdir"
	fill_template "$template" "$@" >"$plist.tmp.$$" \
		|| { rm -f "$plist.tmp.$$"; fail "$name job template ${template##*/} could not be filled" 1; }
	/usr/bin/plutil -lint "$plist.tmp.$$" >/dev/null || { rm -f "$plist.tmp.$$"; fail "the filled $name job plist does not lint" 1; }
	if launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
		launchctl bootout "gui/$UID/$label" || { status=$?; rm -f "$plist.tmp.$$"; fail "launchctl bootout gui/$UID/$label exited $status" 1; }
	fi
	mv -f "$plist.tmp.$$" "$plist"
	launchctl bootstrap "gui/$UID" "$plist" || fail "launchctl bootstrap gui/$UID $plist exited $?" 1
}

# --chaos-nightly is checked here, before anything is written: launchd is macOS only, and the job's
# PATH is built from where bun, omp and git are now (launchd's own PATH has none of ~/.bun/bin), so
# a missing omp or git refuses the flag rather than writing a job that cannot start a session.
# (The CHAOS_*, SWEEP_* and TICK_* label, template, plist and log names are set above, beside the =off path.)
if [ "$CHAOS" = on ]; then
	[ "$(uname -s)" = Darwin ] || fail "--chaos-nightly is a launchd job; this is not macOS" 2
	[ -f "$CHAOS_TEMPLATE" ] || fail "--chaos-nightly: no template at $CHAOS_TEMPLATE" 2
	CHAOS_PATH=""
	for tool in bun omp git; do
		tool_bin="$(type -P "$tool")" || fail "--chaos-nightly: $tool not found on PATH; the chaos job's PATH needs it" 2
		case "$tool_bin" in /*) ;; *) tool_bin="$PWD/$tool_bin" ;; esac
		if [ "$tool" = bun ]; then CHAOS_BUN="$tool_bin"; fi
		CHAOS_PATH="${CHAOS_PATH:+$CHAOS_PATH:}$(dirname "$tool_bin")"
	done
	# The tool directories first, then the system ones; each directory once, in first-seen order.
	dirs="$CHAOS_PATH:/usr/bin:/bin:/usr/sbin:/sbin"
	CHAOS_PATH=""
	while IFS= read -r -d: dir; do
		case ":$CHAOS_PATH:" in *":$dir:"*) ;; *) CHAOS_PATH="${CHAOS_PATH:+$CHAOS_PATH:}$dir" ;; esac
	done <<<"$dirs:"
fi

# --scratch-sweep is checked here too, before anything is written: launchd is macOS only. The job runs
# bun (absolute) and du (system PATH), so it needs no omp or git.
if [ "$SWEEP" = on ]; then
	[ "$(uname -s)" = Darwin ] || fail "--scratch-sweep is a launchd job; this is not macOS" 2
	[ -f "$SWEEP_TEMPLATE" ] || fail "--scratch-sweep: no template at $SWEEP_TEMPLATE" 2
	SWEEP_BUN="$(type -P bun)" || fail "--scratch-sweep: bun not found on PATH" 2
	case "$SWEEP_BUN" in /*) ;; *) SWEEP_BUN="$PWD/$SWEEP_BUN" ;; esac
fi

# --train-tick is checked here too, before anything is written (PLAN wl-mv8s8srodefytc rev 17.1 D10 F15): the tick runs gh,
# launches lanes (bun, omp, git) and notifies (osascript), so its PATH is built from where each is now, the way the chaos
# job's is; a missing tool, or a gh that is not logged in, refuses the flag rather than writing a tick that cannot act.
if [ "$TICK" = on ]; then
	[ "$(uname -s)" = Darwin ] || fail "--train-tick is a launchd job; this is not macOS" 2
	[ -f "$TICK_TEMPLATE" ] || fail "--train-tick: no template at $TICK_TEMPLATE" 2
	TICK_PATH=""
	for tool in gh bun omp git osascript; do
		tool_bin="$(type -P "$tool")" || fail "--train-tick: $tool not found on PATH; the train tick's PATH needs it" 2
		case "$tool_bin" in /*) ;; *) tool_bin="$PWD/$tool_bin" ;; esac
		if [ "$tool" = bun ]; then TICK_BUN="$tool_bin"; fi
		TICK_PATH="${TICK_PATH:+$TICK_PATH:}$(dirname "$tool_bin")"
	done
	dirs="$TICK_PATH:/usr/bin:/bin:/usr/sbin:/sbin"
	TICK_PATH=""
	while IFS= read -r -d: dir; do
		case ":$TICK_PATH:" in *":$dir:"*) ;; *) TICK_PATH="${TICK_PATH:+$TICK_PATH:}$dir" ;; esac
	done <<<"$dirs:"
	gh_status="$(gh auth status 2>&1)" || fail "--train-tick: \`gh auth status\` failed, so the tick could not read PRs or file alerts: $(printf '%s' "$gh_status" | tail -n 1)" 2
fi

# ---- 1. read and validate the manifest ------------------------------------------------------
step "reading manifest $MANIFEST"
[ -f "$MANIFEST" ] || fail "no manifest at $MANIFEST" 2
# [[ == ]] honours nocasematch (BASH_ENV can set it); the membership checks below must be exact.
shopt -u nocasematch
# One path per line, wrapped in newlines, so membership is a builtin [[ ]] match: no process per row.
paths=$'\n'
rows=0
header_seen=0
line_no=0
schema_rows=""
init_rows=""
backup_rows=""
agent_rows=""
config_rows=""
models_rows=""
mcp_rows=""
card_rows=""
guide_rows=""
runtime_rows=""
tier_rows=""
launcher_rows=""
skill_names=""
while IFS= read -r line || [ -n "$line" ]; do
	line_no=$((line_no + 1))
	case "$line" in '#'* | '') continue ;; esac
	if [ "$header_seen" -eq 0 ]; then
		[ "$line" = "$(printf 'path\tkind\tdestination')" ] || fail "manifest line $line_no: expected header 'path<TAB>kind<TAB>destination'" 2
		header_seen=1
		continue
	fi
	IFS=$'\t' read -r path kind dest extra <<<"$line"
	[ -n "${path:-}" ] && [ -n "${kind:-}" ] && [ -n "${dest:-}" ] && [ -z "${extra:-}" ] \
		|| fail "manifest line $line_no: need exactly three TAB-separated fields: $line" 2
	[ -f "$REPO/$path" ] || fail "manifest line $line_no: $path does not exist in the repo" 2
	[ ! -L "$REPO/$path" ] || fail "manifest line $line_no: $path is a symbolic link; machinery artifacts are regular files" 2
	case "$kind" in
		ledger-schema)
			[ "$dest" = "{ledger_db}" ] || fail "manifest line $line_no: ledger-schema destination must be {ledger_db}" 2
			schema_rows="$schema_rows$path"$'\n' ;;
		ledger-init) [ "$dest" = "-" ] || fail "manifest line $line_no: kind $kind is used in place; destination must be -" 2
			init_rows="$init_rows$path"$'\n' ;;
		ledger-backup) [ "$dest" = "-" ] || fail "manifest line $line_no: kind $kind is used in place; destination must be -" 2
			backup_rows="$backup_rows$path"$'\n' ;;
		ledger-backup-agent)
			[ "$dest" = "{launch_agents}/${path##*/}" ] || fail "manifest line $line_no: ledger-backup-agent destination must be {launch_agents}/${path##*/}" 2
			agent_rows="$agent_rows$path"$'\n' ;;
		profile)
			[ "$dest" = "{profile}/agent/${path##*/}" ] || fail "manifest line $line_no: profile destination must be {profile}/agent/${path##*/}" 2
			case "$path" in
				profile/config.yml) config_rows="$config_rows$path"$'\n' ;;
				profile/models.yml) models_rows="$models_rows$path"$'\n' ;;
				profile/mcp.json) mcp_rows="$mcp_rows$path"$'\n' ;;
				profile/AGENTS.md) card_rows="$card_rows$path"$'\n' ;;
				profile/OMP-HARNESS.md) guide_rows="$guide_rows$path"$'\n' ;;
				profile/OMP-RUNTIME.md) runtime_rows="$runtime_rows$path"$'\n' ;;
				*) fail "manifest line $line_no: kind profile is only profile/config.yml, profile/models.yml, profile/mcp.json, profile/AGENTS.md, profile/OMP-HARNESS.md and profile/OMP-RUNTIME.md; got $path" 2 ;;
			esac ;;
		tier)
			[ "$dest" = "{profile}/agent/agents/${path##*/}" ] || fail "manifest line $line_no: tier destination must be {profile}/agent/agents/${path##*/}" 2
			case "$path" in tiers/*.md) ;; *) fail "manifest line $line_no: kind tier is tiers/<name>.md; got $path" 2 ;; esac
			tier_rows="$tier_rows$path"$'\n' ;;
		skill)
			[ "$dest" = "-" ] || fail "manifest line $line_no: kind skill is used in place through the profile's customDirectories; destination must be -" 2
			# skill_names holds each skill's directory, repo-relative: skills/<n> or plugins/<p>/skills/<n>.
			case "$path" in
				skills/*/SKILL.md)
					name="${path#skills/}"; name="${name%/SKILL.md}"
					case "$name" in */*) fail "manifest line $line_no: kind skill is one level under skills/ (omp://skills.md); got $path" 2 ;; esac ;;
				plugins/*/skills/*/SKILL.md)
					plugin="${path#plugins/}"; plugin="${plugin%%/*}"
					name="${path#plugins/"$plugin"/skills/}"; name="${name%/SKILL.md}"
					case "$name" in */*) fail "manifest line $line_no: kind skill is one level under plugins/<p>/skills/ (omp://skills.md); got $path" 2 ;; esac ;;
				*) fail "manifest line $line_no: kind skill is skills/<name>/SKILL.md or plugins/<plugin>/skills/<name>/SKILL.md; got $path" 2 ;;
			esac
			skill_names="$skill_names${path%/SKILL.md}"$'\n' ;;
		skill-asset)
			[ "$dest" = "-" ] || fail "manifest line $line_no: kind skill-asset is used in place; destination must be -" 2
			case "$path" in skills/* | plugins/*/skills/*) ;; *) fail "manifest line $line_no: kind skill-asset lives under skills/ or plugins/<p>/skills/; got $path" 2 ;; esac ;;
		launcher)
			[ "$dest" = "{local_bin}/${path##*/}" ] || fail "manifest line $line_no: launcher destination must be {local_bin}/${path##*/}" 2
			case "$path" in bin/*) ;; *) fail "manifest line $line_no: kind launcher is bin/<name>; got $path" 2 ;; esac
			case "${path#bin/}" in */*) fail "manifest line $line_no: kind launcher is one level under bin/; got $path" 2 ;; esac
			[ -x "$REPO/$path" ] || fail "manifest line $line_no: launcher $path is not executable" 2
			launcher_rows="$launcher_rows$path"$'\n' ;;
		ledger-module | module | extension | data | test | doc | install) [ "$dest" = "-" ] || fail "manifest line $line_no: kind $kind is used in place; destination must be -" 2 ;;
		*) fail "manifest line $line_no: unknown kind '$kind' (this installer knows ledger-schema, ledger-module, ledger-init, ledger-backup, ledger-backup-agent, module, extension, tier, profile, skill, skill-asset, launcher, data, test, doc, install)" 2 ;;
	esac
	if [[ $paths == *$'\n'"$path"$'\n'* ]]; then fail "manifest line $line_no: duplicate row for $path" 2; fi
	paths="$paths$path"$'\n'
	rows=$((rows + 1))
done <"$MANIFEST"
[ "$header_seen" -eq 1 ] || fail "manifest has no header row" 2
# The ledger kinds are run, not just listed, so each must name exactly one file; the schema row
# must name the one file the module applies, so a misclassified or missing row cannot pass.
for kind_rows in "ledger-schema:$schema_rows" "ledger-init:$init_rows" "ledger-backup:$backup_rows" "ledger-backup-agent:$agent_rows" "profile config.yml:$config_rows" "profile models.yml:$models_rows" "profile mcp.json:$mcp_rows" "profile AGENTS.md:$card_rows" "profile OMP-HARNESS.md:$guide_rows" "profile OMP-RUNTIME.md:$runtime_rows"; do
	kind="${kind_rows%%:*}"
	list="${kind_rows#*:}"
	count="$(printf '%s' "$list" | grep -c . || true)"
	[ "$count" -eq 1 ] || fail "manifest needs exactly one $kind row; found $count${list:+: $(printf '%s' "$list" | tr '\n' ' ')}" 2
done
SCHEMA_ROW="${schema_rows%$'\n'}"
INIT_ROW="${init_rows%$'\n'}"
BACKUP_ROW="${backup_rows%$'\n'}"
AGENT_ROW="${agent_rows%$'\n'}"
[ "$SCHEMA_ROW" = "$CANONICAL_SCHEMA" ] \
	|| fail "manifest's ledger-schema row names $SCHEMA_ROW; the ledger module applies $CANONICAL_SCHEMA and nothing else" 2
CONFIG_ROW="${config_rows%$'\n'}"
MODELS_ROW="${models_rows%$'\n'}"
MCP_ROW="${mcp_rows%$'\n'}"
CARD_ROW="${card_rows%$'\n'}"
GUIDE_ROW="${guide_rows%$'\n'}"
RUNTIME_ROW="${runtime_rows%$'\n'}"
[ -n "$tier_rows" ] || fail "manifest has no tier rows; the profile needs its tiers/<name>.md agents" 2
[ -n "$skill_names" ] || fail "manifest has no skill rows; the profile's includeSkills would allow nothing" 2
step "manifest ok: $rows rows (schema $SCHEMA_ROW, $(printf '%s' "$tier_rows" | grep -c .) tiers, $(printf '%s' "$skill_names" | grep -c .) skills)"

# ---- 2. every file under a machinery directory has a row (P-11: manifest-or-fail) ------------
# Symbolic links are listed separately and refused outright: find -type f skips them, and a link
# can point anywhere (outside the repo, at another artifact, at nothing), so none is accepted.
step "checking machinery directories for unmanifested files and symbolic links: ${MACHINERY_DIRS[*]}"
missing=""
links=""
for dir in "${MACHINERY_DIRS[@]}"; do
	[ -e "$REPO/$dir" ] || [ -L "$REPO/$dir" ] || continue
	while IFS= read -r file; do
		rel="${file#"$REPO"/}"
		[[ $paths == *$'\n'"$rel"$'\n'* ]] || missing="$missing  $rel"$'\n'
	done < <(find "$REPO/$dir" -type f ! -name '.DS_Store' ! -path '*/node_modules/*' | LC_ALL=C sort)
	while IFS= read -r link; do
		links="$links  ${link#"$REPO"/} -> $(readlink "$link")"$'\n'
	done < <(find "$REPO/$dir" -type l ! -path '*/node_modules/*' | LC_ALL=C sort)
done
if [ -n "$links" ]; then
	printf 'install: these symbolic links are under a machinery directory:\n%s' "$links" >&2
	fail "symbolic links under machinery directories are not installed; replace each with a regular file and a manifest row" 2
fi
if [ -n "$missing" ]; then
	printf 'install: these files are under a machinery directory and have no manifest row:\n%s' "$missing" >&2
	fail "unmanifested artifacts; add a row to install/manifest.tsv or move the file out" 2
fi
step "no unmanifested files, no symbolic links"

# ---- 2b. render the profile and check it before anything is written ---------------------------
# {repo} in the template becomes this checkout's absolute path; substituted text is never scanned
# again. The render is refused (exit 2, nothing written) when the result is not YAML, when a
# {repo} survives, when skills.customDirectories is not exactly [<repo>/skills] followed by one
# <repo>/plugins/<p>/skills per vendored plugin with a `skill` row (sorted; plugins/VENDOR.md), when
# two skill rows share a name, when skills.includeSkills is not exactly the names of the manifest's
# `skill` rows, or when a `skill` row's SKILL.md has no frontmatter description (omp://skills.md:
# the native provider drops such a skill, and the allowlist would then name a skill that never
# loads).
step "profile: rendering $CONFIG_ROW for profile $PROFILE_NAME"
set +e
RENDERED="$(bun -e '
	const [template, repo, ...names] = process.argv.slice(1);
	const fail = (m) => { console.error(`install: profile: ${m}`); process.exit(1); };
	const text = (await Bun.file(template).text()).split("{repo}").join(repo);
	if (text.includes("{repo}")) fail("a {repo} survived the render");
	let doc;
	try { doc = Bun.YAML.parse(text); } catch (e) { fail(`rendered ${template} is not YAML: ${e.message}`); }
	const skills = doc && typeof doc === "object" ? doc.skills : undefined;
	if (!skills || typeof skills !== "object") fail(`${template} has no skills: block`);
	const dirs = skills.customDirectories;
	// Each argument is a skill directory, repo-relative: skills/<n> or plugins/<p>/skills/<n>. Its
	// parent is the customDirectory OMP scans one level down; <n> is the name includeSkills lists.
	const rows = [...new Set(names)].sort().map((d) => ({ dir: d, parent: d.slice(0, d.lastIndexOf("/")), name: d.slice(d.lastIndexOf("/") + 1) }));
	const seen = new Map();
	for (const r of rows) {
		if (seen.has(r.name)) fail(`skill name ${r.name} is provided twice: ${seen.get(r.name)} and ${r.dir}`);
		seen.set(r.name, r.dir);
	}
	const plugins = [...new Set(rows.map((r) => r.parent).filter((p) => p !== "skills"))].sort();
	const wantDirs = [`${repo}/skills`, ...plugins.map((p) => `${repo}/${p}`)];
	if (!Array.isArray(dirs) || dirs.length !== wantDirs.length || dirs.some((d, i) => d !== wantDirs[i])) fail(`skills.customDirectories must be exactly ${JSON.stringify(wantDirs)} (<repo>/skills, then each plugin skills dir with a skill row, sorted); got ${JSON.stringify(dirs)}`);
	const want = rows.map((r) => r.name).sort();
	const have = Array.isArray(skills.includeSkills) ? [...new Set(skills.includeSkills.map(String))].sort() : null;
	if (!have) fail("skills.includeSkills must be a list");
	const missing = want.filter((n) => !have.includes(n));
	const extra = have.filter((n) => !want.includes(n));
	if (missing.length || extra.length) fail(`skills.includeSkills differs from the manifest skill rows; missing from config: [${missing}] not in manifest: [${extra}]`);
	for (const r of rows) {
		const path = `${repo}/${r.dir}/SKILL.md`;
		const head = (await Bun.file(path).text()).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
		let fm;
		try { fm = head ? Bun.YAML.parse(head[1]) : null; } catch (e) { fail(`${path}: frontmatter is not YAML: ${e.message}`); }
		if (!fm || typeof fm !== "object" || typeof fm.description !== "string" || !fm.description.trim()) fail(`${path}: frontmatter has no description (omp://skills.md requires one)`);
		if (fm.name !== undefined && fm.name !== r.name) fail(`${path}: frontmatter name ${JSON.stringify(fm.name)} differs from its directory ${r.name}`);
	}
	process.stdout.write(text.endsWith("\n") ? text : text + "\n");
' "$REPO/$CONFIG_ROW" "$REPO" $skill_names)"
status=$?
set -e
[ "$status" -eq 0 ] || fail "profile render refused" 2
step "profile ok: includeSkills matches the $(printf '%s' "$skill_names" | grep -c .) skill rows; every skill has a description"

# The tracing switch survives a re-install (wl-mv65t5d34lts00 PLAN.md § 8.1): the installed profile's
# observability.phoenix, as written, replaces the template's in the render, so `as2 phoenix off` stays off and
# only a fresh profile starts at the template's all. One line says which; a render that does not take the value
# alone is refused like any other render.
set +e
RENDERED="$(printf '%s\n' "$RENDERED" | bun "$REPO/surface/scripts/tracing.ts" carry "$PROFILE_DIR/config.yml")"
status=$?
set -e
[ "$status" -eq 0 ] || fail "profile render refused (tracing switch carry exited $status)" 2

# The providers this profile routes to, for the login line printed after a successful install
# (section 7): every model named in the rendered task.agentModelOverrides and modelRoles, in that
# order, so the line follows the tier table rather than a second copy of it. Read here, before
# anything is written, so a profile naming no provider refuses the install instead of printing an
# empty line at the end.
PROVIDERS="$(printf '%s' "$RENDERED" | bun -e '
	const doc = Bun.YAML.parse(await Bun.stdin.text());
	const models = [...Object.values(doc?.task?.agentModelOverrides ?? {}).flat(), ...Object.values(doc?.modelRoles ?? {})];
	const providers = [...new Set(models.filter((m) => typeof m === "string" && m.includes("/")).map((m) => m.slice(0, m.indexOf("/"))))];
	if (!providers.length) { console.error("install: profile: the rendered config names no provider/model in task.agentModelOverrides or modelRoles"); process.exit(1); }
	console.log(providers.join(", "));
')" || fail "profile render refused" 2

# The profile's MCP config (profile/mcp.json) must be an MCP config OMP will read: a JSON object
# whose mcpServers names the ctx server. Checked here, before anything is written.
bun -e '
	let doc;
	try { doc = JSON.parse(await Bun.file(process.argv[1]).text()); } catch (e) { console.error(`install: profile: ${process.argv[1]} is not JSON: ${e.message}`); process.exit(1); }
	if (!doc?.mcpServers?.ctx?.command) { console.error(`install: profile: ${process.argv[1]} has no mcpServers.ctx with a command`); process.exit(1); }
' "$REPO/$MCP_ROW" || fail "profile mcp.json refused" 2

# The harness card (profile/AGENTS.md) is rendered like config.yml: {repo} becomes this checkout's
# absolute path, substituted text is never scanned again, and a {repo} that survives refuses the
# install (exit 2, nothing written). The card names the guide by that path, and OMP strips
# AGENTS.md from subagents, so hands reach the guide through the line in their tier file instead.
step "profile: rendering $CARD_ROW (the OMP harness card) for profile $PROFILE_NAME"
CARD="$(bun -e '
	const [template, repo] = process.argv.slice(1);
	const text = (await Bun.file(template).text()).split("{repo}").join(repo);
	if (text.includes("{repo}")) { console.error(`install: profile: a {repo} survived the render of ${template}`); process.exit(1); }
	process.stdout.write(text);
' "$REPO/$CARD_ROW" "$REPO")" || fail "profile harness card render refused" 2

# ---- 3. install the ledger ---------------------------------------------------------------------
# ledger-init creates or verifies the ledger from the ledger-schema row. It refuses a schema file
# other than the module's (exit 2) and a synced or network folder (exit 3, ledger/src/locality.ts),
# both before it creates anything.
step "ledger: $LEDGER_DB (schema $SCHEMA_ROW, init $INIT_ROW)"
set +e
bun run "$REPO/$INIT_ROW" "$LEDGER_DB" --schema "$REPO/$SCHEMA_ROW"
status=$?
set -e
case "$status" in 0) ;; 2 | 3 | 4) fail "ledger init exited $status" "$status" ;; *) fail "ledger init exited $status" 1 ;; esac

# ledger-backup: the backup job. Running it once here gives a fresh machine its first copy in the
# ledger's own namespace under backups/; it exits nonzero when a due copy cannot be taken.
step "ledger backup: $BACKUP_ROW"
bun run "$REPO/$BACKUP_ROW" "$LEDGER_DB" || fail "ledger backup exited $?" 1

# ---- 4. the periodic backup job (ledger-backup-agent) --------------------------------------------
# macOS: fill the template and write it to $HOME/Library/LaunchAgents. Written, never loaded: the
# installer does not run launchctl for this job. Linux gets a systemd user timer later (manifest
# placeholder); until then the open-time copy is the only schedule there.
PLIST="$LAUNCH_AGENTS/${AGENT_ROW##*/}"
if [ "$(uname -s)" = Darwin ]; then
	step "backup job: $AGENT_ROW -> $PLIST"
	BUN_BIN="$(command -v bun)"
	case "$BUN_BIN" in /*) ;; *) BUN_BIN="$PWD/$BUN_BIN" ;; esac
	mkdir -p "$LAUNCH_AGENTS"
	fill_template "$REPO/$AGENT_ROW" \
		"BUN=$BUN_BIN" \
		"BACKUP_SCRIPT=$REPO/$BACKUP_ROW" \
		"LEDGER_DB=$LEDGER_ABS" \
		"HOME=$HOME" \
		"REPO=$REPO" \
		"LOG=$(dirname "$LEDGER_ABS")/ledger-backup.log" \
		>"$PLIST.tmp.$$" || { rm -f "$PLIST.tmp.$$"; fail "backup job template $AGENT_ROW could not be filled" 1; }
	/usr/bin/plutil -lint "$PLIST.tmp.$$" >/dev/null || { rm -f "$PLIST.tmp.$$"; fail "the filled backup job plist does not lint" 1; }
	mv -f "$PLIST.tmp.$$" "$PLIST"
	step "backup job written, not loaded. To load it (and after any re-install, unload first):"
	printf '    launchctl bootstrap gui/$(id -u) %q\n' "$PLIST"
	printf '  to unload:\n    launchctl bootout gui/$(id -u)/com.agent-system-2.ledger-backup\n'
else
	step "backup job: not macOS; no periodic job written (systemd timer not built yet); the open-time copy is the only schedule"
fi

# ---- 5. the OMP profile (profile + tier rows) ---------------------------------------------------
# Written last, after the ledger steps, so a refused ledger leaves no half-profile behind. The
# tier files and the harness guide are symbolic links into the checkout: an edit is live without a
# re-install, and nothing under the profile is a second copy to drift. Re-runs rewrite the same content.
step "profile: $PROFILE_DIR"
mkdir -p "$PROFILE_DIR/agents"
printf '%s' "$RENDERED" >"$PROFILE_DIR/config.yml.tmp.$$" || { rm -f "$PROFILE_DIR/config.yml.tmp.$$"; fail "could not write $PROFILE_DIR/config.yml" 1; }
mv -f "$PROFILE_DIR/config.yml.tmp.$$" "$PROFILE_DIR/config.yml"
cp -f "$REPO/$MODELS_ROW" "$PROFILE_DIR/models.yml"
cp -f "$REPO/$MCP_ROW" "$PROFILE_DIR/mcp.json"
printf '%s\n' "$CARD" >"$PROFILE_DIR/AGENTS.md.tmp.$$" || { rm -f "$PROFILE_DIR/AGENTS.md.tmp.$$"; fail "could not write $PROFILE_DIR/AGENTS.md" 1; }
mv -f "$PROFILE_DIR/AGENTS.md.tmp.$$" "$PROFILE_DIR/AGENTS.md"
step "profile written: config.yml (rendered from $CONFIG_ROW), models.yml (from $MODELS_ROW), mcp.json (from $MCP_ROW), AGENTS.md (rendered from $CARD_ROW)"
ln -sfn "$REPO/$GUIDE_ROW" "$PROFILE_DIR/${GUIDE_ROW##*/}"
step "guide linked: $PROFILE_DIR/${GUIDE_ROW##*/} -> $REPO/$GUIDE_ROW"
ln -sfn "$REPO/$RUNTIME_ROW" "$PROFILE_DIR/${RUNTIME_ROW##*/}"
step "runtime guide linked: $PROFILE_DIR/${RUNTIME_ROW##*/} -> $REPO/$RUNTIME_ROW"
while IFS= read -r tier; do
	[ -n "$tier" ] || continue
	ln -sfn "$REPO/$tier" "$PROFILE_DIR/agents/${tier##*/}"
	step "tier linked: $PROFILE_DIR/agents/${tier##*/} -> $REPO/$tier"
done <<<"$tier_rows"
step "profile ready: omp --profile $PROFILE_NAME (or OMP_PROFILE=$PROFILE_NAME); skills load from $REPO/skills"

# ---- 5b. file links in default-profile seats and herdr -------------------------------------------
# The default profile auto-discovers this extension; as2 itself loads it through gates/index.ts.
# Like tier links, this points at the checkout that `as2 install` runs from, never a lane copy
# unless somebody explicitly runs install there. No herdr command runs without a herdr on PATH.
DEFAULT_EXTENSIONS="$HOME/.omp/agent/extensions"
mkdir -p "$DEFAULT_EXTENSIONS"
ln -sfn "$REPO/gates/extensions/open-links.ts" "$DEFAULT_EXTENSIONS/as2-open-links.ts"
step "default-profile extension linked: $DEFAULT_EXTENSIONS/as2-open-links.ts -> $REPO/gates/extensions/open-links.ts"
if command -v herdr >/dev/null 2>&1; then
	herdr plugin link "$REPO/install/herdr-file-links" || fail "herdr plugin link exited $?" 1
	step "herdr file-link handler linked: as2.file-links"
else
	step "note: herdr is not on PATH; file-link handler not registered (install herdr, then re-run this script)"
fi

# ---- 6. the launcher (launcher rows) ------------------------------------------------------------
# A symbolic link into the checkout, like the tier files: the script resolves its own real path to
# find the repo, so an edit to bin/<name> is live without a re-install.
if [ -n "$launcher_rows" ]; then
	mkdir -p "$LOCAL_BIN"
	while IFS= read -r launcher; do
		[ -n "$launcher" ] || continue
		ln -sfn "$REPO/$launcher" "$LOCAL_BIN/${launcher##*/}"
		step "launcher linked: $LOCAL_BIN/${launcher##*/} -> $REPO/$launcher"
	done <<<"$launcher_rows"
	case ":$PATH:" in
		*":$LOCAL_BIN:"*) ;;
		*) step "note: $LOCAL_BIN is not on PATH; add it (e.g. in ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\") to run the launcher by name" ;;
	esac
fi

# ---- 6b. the profile's sessions as a ctx history root (M8 ctx wiring) ----------------------------
# OMP writes this profile's transcripts under $PROFILE_DIR/sessions, which is not one of ctx's
# discovered pi roots (~/.pi/agent/sessions); registering it as a named root puts as2 history in the
# index the orchestrator reads with `ctx search`. `ctx sources add … --replace` adds an absent name,
# keeps identical settings as they are, and repoints the name when the path changed (ctx docs show
# storage, § Config Overrides); the root must exist, so the directory is created first. Per-machine
# ctx state (~/.ctx/config.toml), so it lives here and not in the manifest. Without ctx on PATH the
# step is skipped with a notice: the rest of the system runs, and history reads say ctx is absent.
# Reversal: ctx sources remove "$CTX_ROOT_NAME" (history already indexed stays until a rebuild).
CTX_ROOT_NAME="omp-$PROFILE_NAME-sessions"
mkdir -p "$PROFILE_DIR/sessions"
if command -v ctx >/dev/null 2>&1; then
	ctx_out="$(ctx sources add --provider pi --root "$PROFILE_DIR/sessions" --replace "$CTX_ROOT_NAME" 2>&1)" \
		|| fail "ctx sources add $CTX_ROOT_NAME exited $?: $ctx_out" 1
	step "ctx history root: $ctx_out"
else
	step "note: ctx is not on PATH; $PROFILE_DIR/sessions is not registered as a ctx history root (install ctx, then re-run this script)"
fi

# ---- 6c. the nightly chaos run (--chaos-nightly only) ---------------------------------------------
# Only with the flag; without it this step does nothing and runs nothing (load_job, above, writes and
# loads it). Reversal: bash install/install.sh --chaos-nightly=off (handled before step 1, above).
if [ "$CHAOS" = on ]; then
	load_job "chaos nightly" "$CHAOS_LABEL" "$CHAOS_TEMPLATE" "$CHAOS_PLIST" "$CHAOS_LOG_DIR" \
		"BUN=$CHAOS_BUN" "HOME=$HOME" "REPO=$REPO" "PATH=$CHAOS_PATH"
	step "chaos nightly loaded: fires every quarter hour, runs once a night at 03:00 America/Los_Angeles; log $CHAOS_LOG_DIR/launchd.log; turn off with: bash install/install.sh --chaos-nightly=off"
fi

# ---- 6d. the daily scratch sweep (--scratch-sweep only) -------------------------------------------
# Only with the flag, the same way as 6c. The job carries the ledger this install wrote, so the sweep
# reads that ledger's workload state. Reversal: bash install/install.sh --scratch-sweep=off.
if [ "$SWEEP" = on ]; then
	load_job "scratch sweep" "$SWEEP_LABEL" "$SWEEP_TEMPLATE" "$SWEEP_PLIST" "$SWEEP_LOG_DIR" \
		"BUN=$SWEEP_BUN" "HOME=$HOME" "REPO=$REPO" "LEDGER_DB=$LEDGER_ABS"
	step "scratch sweep loaded: runs daily at 04:30 local time; reports and log in $SWEEP_LOG_DIR; turn off with: bash install/install.sh --scratch-sweep=off"
fi

# ---- 6d2. the merge train's tick (--train-tick only) ----------------------------------------------
# Only with the flag, the same way as 6c. The job carries the ledger this install wrote and the profile it rendered, so the
# tick reads and writes that ledger and the lanes it launches run on that profile. Reversal: bash install/install.sh --train-tick=off.
if [ "$TICK" = on ]; then
	load_job "train tick" "$TICK_LABEL" "$TICK_TEMPLATE" "$TICK_PLIST" "$TICK_LOG_DIR" \
		"BUN=$TICK_BUN" "HOME=$HOME" "REPO=$REPO" "LEDGER_DB=$LEDGER_ABS" "PROFILE=$PROFILE_NAME" "PATH=$TICK_PATH"
	step "train tick loaded: runs every 5 minutes; log $TICK_LOG_DIR/launchd.log; turn off with: bash install/install.sh --train-tick=off"
fi

# ---- 6e. Phoenix, on by default (wl-mv65t5d34lts00 PLAN.md § 8.1) ------------------------------------
# Phoenix, the local trace UI for as2's OMP spans: on macOS, unless observability.phoenix is off,
# install/phoenix-agent.sh on (idempotent: it rewrites the same files and reloads the job). Only when $HOME is
# this user's own home directory, read from the user database with dscl, never from $HOME (Bun's
# os.userInfo().homedir follows $HOME): launchd has one gui/<uid> domain per user, so an install into another
# HOME (a test's temp HOME) must never boot out the real job or load one pointing into that directory
# (phoenix-agent.sh refuses it too). A failing `on` (no phoenix uv tool, launchctl refused, not healthy in time)
# is reported with the retry command and does not fail the install: with Phoenix down every omp drops its spans
# silently (PLAN.md § 4). Reversal: as2 phoenix off, then bash install/phoenix-agent.sh off.
if [ "$(uname -s)" = Darwin ]; then
	phoenix_value="$(printf '%s\n' "$RENDERED" | bun -e '
		const p = Bun.YAML.parse(await Bun.stdin.text())?.observability?.phoenix;
		process.stdout.write(Array.isArray(p) ? `[${p.join(", ")}]` : String(p));
	')" || fail "the rendered profile could not be read back for observability.phoenix" 1
	user_home="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory: //p')" || user_home=""
	if [ "$phoenix_value" = off ]; then
		step "Phoenix: observability.phoenix is off, so the LaunchAgent is neither installed nor changed (to turn it on: as2 phoenix all, then bash $REPO/install/phoenix-agent.sh on)"
	elif [ -z "$user_home" ] || [ "$(cd "$HOME" && pwd -P)" != "$(cd "$user_home" 2>/dev/null && pwd -P)" ]; then
		step "Phoenix: HOME ($HOME) is not this user's home directory (${user_home:-unknown}), so the LaunchAgent is not installed from this run (launchd has one domain per user)"
	elif bash "$REPO/install/phoenix-agent.sh" on; then
		step "Phoenix: running on http://127.0.0.1:6006 for observability.phoenix: $phoenix_value (status: bash $REPO/install/phoenix-agent.sh status)"
	else
		status=$?
		step "note: Phoenix did not start (phoenix-agent.sh on exited $status; the reason is above); as2 runs without it and its omp processes drop their spans; retry: bash $REPO/install/phoenix-agent.sh on"
	fi
fi

step "install complete: ledger at $LEDGER_DB"

# ---- 7. provider login, once per profile ---------------------------------------------------------
# The profile's setupVersion (profile/config.yml) skips OMP's first-launch wizard, its sign-in scene
# included, so the one step left is logging in. Credentials go to the profile's own agent.db, so a
# new profile needs its own logins even when the default profile has them.
step "first launch: this profile routes to $PROVIDERS; OMP needs a login to each once per profile: run /login in the as2 session (credentials stay in $PROFILE_DIR/agent.db)"
