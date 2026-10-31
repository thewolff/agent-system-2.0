#!/usr/bin/env bash
# agent-system 2.0: set up the `_as2test` user the outside-the-fence test runner runs lane code as
# (MIGRATION.md item 24; the approved plan of workload wl-muraerdsgw7gn4, revision 12, § 3.1), and the
# root-owned refresh helper that rebuilds its test-exec bundle from the commit the `as2-verified` tag
# names (refs/tags/as2-verified; workload wl-mv718fxhwwcn40, PLAN revision 6, § 1.4; wl-mvq4edbaf13vnk § 2).
#
# Run it as yourself, from a clean checkout of thewolff/agent-system-2.0: the helper it installs is
# rendered from this checkout's HEAD. It uses sudo for each privileged step (SPEC-2.0.md § A4
# reserved), previews every change (the helper's full text and sha-256 included), and asks before
# making any. It refuses, before the preview, a checkout whose origin is not
# git@github.com:thewolff/agent-system-2.0(.git) or https://github.com/thewolff/agent-system-2.0(.git),
# a checkout with uncommitted changes to tracked files, and a machine where /usr/bin/git does not run.
#
#   1. group and user _as2test (dscl): the first id >= 600 free as both a user id and a group id,
#      recorded in SOURCE and reused on a re-run; UserShell /usr/bin/false, NFSHomeDirectory
#      /var/empty, IsHidden 1; in no other group. An _as2test user or group that SOURCE does not
#      record is refused, never taken over.
#   2. /Users/Shared/as2test (root:wheel 0755) with stage/ (you:_as2test 0750), runs/
#      (_as2test 0755) and locks/ (root:wheel 0755) holding sweep.db (_as2test 0600, empty).
#   3. /usr/local/libexec/as2test (root:wheel 0755; every parent root-owned and not group- or
#      world-writable): resources.json (root:wheel 0644, the measured resource policy, first: see
#      below), bun (a copy of your bun) and refresh (the helper, surface/src/as2test.ts
#      renderRefreshHelper), both root:wheel 0755, refresh.d (root:wheel 0700, the helper's lock,
#      mirror and staged copies), and a provisional SOURCE (root:wheel 0755, staged as .SOURCE.new and
#      moved in): the ids, what setup created and the sha-256 of bun and refresh, with exec and
#      test-exec.js not built yet. --undo and a re-run read it, and the runner's preflight finds
#      exec and test-exec.js unbuilt (file-drift) and runs the helper, so a failed step 5 is retried.
#   4. /etc/sudoers.d/as2test (root:wheel 0440), after checking the policy includes
#      /private/etc/sudoers.d; checked with `visudo -cf`, then the whole policy with `visudo -c`,
#      before it is moved in. Two lines:
#        <you> ALL=(_as2test) NOPASSWD: /usr/local/libexec/as2test/exec
#        <you> ALL=(root) NOPASSWD: /usr/local/libexec/as2test/refresh ""
#   5. Last, `sudo -k` (drops your cached sudo credential) and `sudo -n .../refresh` through the new
#      rule: the helper fetches refs/tags/as2-verified (the commit the runner verified; land-first
#      reconciliation may re-point it at the admitted current head) from
#      https://github.com/thewolff/agent-system-2.0.git, builds that commit's test-exec as nobody, and
#      installs exec (the wrapper), test-exec.js and SOURCE (the origin and the tag's sha, the bun
#      version, the ids, what setup created, and the sha-256 of each installed file, resources.json
#      included, and of every bundle input) over the provisional one.
#
# The measured resource policy is required (review F2): every test part the installed executor runs
# admits its workers from <libexec>/resources.json, and there are no default costs. Setup refuses
# before the plan, so before it replaces any installed wrapper, bundle, helper or SOURCE, unless
# --resources names a valid policy or a valid root-owned one is already installed; the helper itself
# refuses to fetch without one, and the fetched commit's render-exec refuses an absent or invalid one.
#
# The runner's preflight calls the helper itself when the bundle drifts. Re-run setup after a bun
# upgrade or a change to the helper's text (the preflight says "re-run install/as2test-setup.sh"
# when only setup can fix the install). A re-run also repairs a corrupt or missing locks/sweep.db:
# setup recreates it empty when it is not an empty _as2test-owned 0600 file.
#
# Usage:   bash install/as2test-setup.sh [--dry-run]          set up, or re-run to refresh
#          bash install/as2test-setup.sh --undo [--dry-run]   remove only what SOURCE says setup created
#          bash install/as2test-setup.sh --help
#   --dry-run  checks and prints the plan, then stops; nothing is changed and sudo is not called.
#   --undo     refuses while a run holds the runs lock (<runs root>/runs.db, a heartbeat under 60 s).
#   --resources=/absolute/file.json   measured worker CPU/memory (including nested subprocess peaks)
#                                      and host + historical-load reserves; no guessed defaults.
#                                      Required unless a valid root-owned <libexec>/resources.json is
#                                      already installed, which a re-run then keeps.
#   --omp-artifact=/absolute/dir --omp-version=<exact --version stdout>
#                                      provision a verified self-contained tree with bin/omp, bin/bun
#                                      and all transitive files; symlinks are refused. Not downloaded.
# Env:     AGENT_SYSTEM_TEST_RUNS, AGENT_SYSTEM_LEDGER_DB   locate the runs lock --undo checks
#          AS2TEST_SETUP_TEST_PREFIX   tests only: every target path moves under this directory and
#                                      "root-owned" means owned by the caller
#          AS2TEST_SETUP_TEST_ORIGIN   tests only, and only with AS2TEST_SETUP_TEST_PREFIX: a local
#                                      bare repo (absolute path) that is both the checkout's required
#                                      origin and the helper's; the helper is a test render (file
#                                      protocol allowed, no root check, builds as the caller)
# Exit:    0 done, or plan printed · 1 refused or failed (the message says which; a refusal changes
#          nothing) · 2 usage
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }
fail() { printf 'as2test-setup: %s\n' "$1" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

MODE=apply
DRY=0
RESOURCES=
OMP_ARTIFACT=
OMP_VERSION=
for arg in "$@"; do
	case "$arg" in
	--dry-run) DRY=1 ;;
	--undo) MODE=undo ;;
	--resources=*) RESOURCES="${arg#*=}" ;;
	--omp-artifact=*) OMP_ARTIFACT="${arg#*=}" ;;
	--omp-version=*) OMP_VERSION="${arg#*=}" ;;
	-h | --help) usage; exit 0 ;;
	*) usage >&2; exit 2 ;;
	esac
done

CHECKOUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NAME=_as2test
PREFIX="${AS2TEST_SETUP_TEST_PREFIX:-}"
if [ -n "$PREFIX" ]; then
	case "$PREFIX" in /*) ;; *) fail "AS2TEST_SETUP_TEST_PREFIX must be absolute" ;; esac
	ROOT_UID="$(id -u)"
else
	ROOT_UID=0
fi
ROOT="$PREFIX/Users/Shared/as2test"
LIBEXEC="$PREFIX/usr/local/libexec/as2test"
SUDOERS_D="$PREFIX/etc/sudoers.d"
SUDOERS_FILE="$SUDOERS_D/as2test"
ETC_SUDOERS="$PREFIX/etc/sudoers"
SOURCE_FILE="$LIBEXEC/SOURCE"
TEST_ORIGIN="${AS2TEST_SETUP_TEST_ORIGIN:-}"
if [ -n "$TEST_ORIGIN" ]; then
	[ -n "$PREFIX" ] || fail "AS2TEST_SETUP_TEST_ORIGIN is honoured only with AS2TEST_SETUP_TEST_PREFIX; refusing"
	case "$TEST_ORIGIN" in /*) ;; *) fail "AS2TEST_SETUP_TEST_ORIGIN must be absolute" ;; esac
fi

JO="$(id -un)"
JO_UID="$(id -u)"
[ "$JO_UID" -ne 0 ] || fail "run this as yourself, not as root: it grants your user, and calls sudo for each privileged step"

# ---- what an earlier run recorded ---------------------------------------------------------------
src_get() { [ -f "$SOURCE_FILE" ] && awk -v k="$1" '$1 == k { sub(/^[^ ]+ /, ""); print; exit }' "$SOURCE_FILE"; }
src_created() { [ -f "$SOURCE_FILE" ] && awk '$1 == "created" { sub(/^[^ ]+ /, ""); print }' "$SOURCE_FILE"; }
REC_UID="$(src_get uid || true)"
REC_GID="$(src_get gid || true)"
REC_CREATED="$(src_created || true)"
recorded() { printf '%s\n' "$REC_CREATED" | grep -qxF -- "$1"; }

# ---- the runs lock (--undo) -------------------------------------------------------------------------
runs_lock_holder() {
	local ledger="${AGENT_SYSTEM_LEDGER_DB:-$HOME/.agent-system-2/ledger.db}"
	local runs="${AGENT_SYSTEM_TEST_RUNS:-$(dirname "$ledger")/test-runs}"
	local db="$runs/runs.db" now
	[ -e "$db" ] || return 0
	now="$(($(date +%s) * 1000))"
	sqlite3 -readonly "$db" "SELECT runId FROM lock WHERE id = 1 AND heartbeatAt > $((now - 60000));" ||
		fail "cannot read the runs lock in $db; refusing rather than guess"
}

# ---- undo -------------------------------------------------------------------------------------------
if [ "$MODE" = undo ]; then
	[ -f "$SOURCE_FILE" ] || fail "no $SOURCE_FILE: setup recorded nothing here, so undo removes nothing"
	holder="$(runs_lock_holder)"
	[ -z "$holder" ] || fail "run $holder holds the runs lock; undo when it has finished"
	plan=()
	recorded "$SUDOERS_FILE" && plan+=("sudo rm -f $SUDOERS_FILE")
	recorded "$LIBEXEC" && plan+=("sudo rm -rf $LIBEXEC")
	recorded "$ROOT" && plan+=("sudo rm -rf $ROOT")
	recorded user && plan+=("sudo dscl . -delete /Users/$NAME")
	recorded group && plan+=("sudo dscl . -delete /Groups/$NAME")
	while IFS= read -r c; do
		case "$c" in "" | user | group | "$SUDOERS_FILE" | "$LIBEXEC" | "$ROOT") ;; *) fail "SOURCE records an unknown created path $c; refusing" ;; esac
	done <<<"$REC_CREATED"
	say "as2test undo plan (from $SOURCE_FILE):"
	[ "${#plan[@]}" -gt 0 ] || { say "  nothing: setup created nothing it recorded"; exit 0; }
	for step in "${plan[@]}"; do say "  $step"; done
	[ "$DRY" -eq 0 ] || { say "dry run: nothing changed"; exit 0; }
	read -r -p "Remove these? [y/N] " answer || answer=""
	[ "$answer" = y ] || [ "$answer" = Y ] || fail "not confirmed; nothing changed"
	for step in "${plan[@]}"; do
		say "==> $step"
		# shellcheck disable=SC2086 # each step is a fixed command built above, its paths without spaces
		$step
	done
	say "as2test removed"
	exit 0
fi

# ---- checks (nothing is written outside a temp dir until the plan is confirmed) ---------------------
/usr/bin/git --version >/dev/null 2>&1 || fail "/usr/bin/git --version does not run; the refresh helper fetches with /usr/bin/git (install the Command Line Tools: xcode-select --install)"
gitc() { git -C "$CHECKOUT" "$@"; }
# The raw configured URL: `remote get-url` would apply url.*.insteadOf rewrites.
ORIGIN_URL="$(gitc config --get remote.origin.url 2>/dev/null || true)"
if [ -n "$TEST_ORIGIN" ]; then
	[ "$ORIGIN_URL" = "$TEST_ORIGIN" ] || fail "the checkout $CHECKOUT has origin '${ORIGIN_URL}', not the test origin $TEST_ORIGIN; refusing"
else
	case "$ORIGIN_URL" in
	git@github.com:thewolff/agent-system-2.0 | git@github.com:thewolff/agent-system-2.0.git) ;;
	https://github.com/thewolff/agent-system-2.0 | https://github.com/thewolff/agent-system-2.0.git) ;;
	*) fail "the checkout $CHECKOUT has origin '${ORIGIN_URL}', not thewolff/agent-system-2.0 (git@github.com:thewolff/agent-system-2.0(.git) or https://github.com/thewolff/agent-system-2.0(.git)); refusing" ;;
	esac
fi
dirty="$(gitc status --porcelain --untracked-files=no)" || fail "git status failed in $CHECKOUT"
[ -z "$dirty" ] || fail "the checkout $CHECKOUT has uncommitted changes to tracked files; the helper is rendered from it, so commit or stash them first: $(printf '%s' "$dirty" | tr '\n' ' ')"
command -v bun >/dev/null 2>&1 || fail "bun not found on PATH"
command -v dscl >/dev/null 2>&1 || fail "dscl not found (setup is macOS only)"
BUN_SRC="$(command -v bun)"
BUN_VERSION="$(bun --version)"
SOURCE_SHA="$(gitc rev-parse --verify -q 'HEAD^{commit}')" || fail "the checkout $CHECKOUT has no HEAD commit"
if MAIN_SHA="$(gitc rev-parse --verify -q 'refs/remotes/origin/main^{commit}')"; then
	if gitc merge-base --is-ancestor HEAD "$MAIN_SHA"; then
		ON_MAIN="HEAD is on origin/main (${MAIN_SHA:0:12}, as last fetched)"
	else
		ON_MAIN="HEAD is NOT on origin/main (${MAIN_SHA:0:12}, as last fetched)"
	fi
else
	ON_MAIN="origin/main is not fetched in this checkout, so whether HEAD is on it is unknown"
fi

dscl_int() { dscl . -read "$1" "$2" 2>/dev/null | awk -v k="$2:" '$1 == k { print $2; exit }'; }
CUR_UID="$(dscl_int "/Users/$NAME" UniqueID || true)"
CUR_GID="$(dscl_int "/Groups/$NAME" PrimaryGroupID || true)"
if [ -n "$CUR_UID" ] && [ "$CUR_UID" != "$REC_UID" ]; then
	fail "a user $NAME (uid $CUR_UID) exists that setup did not record in $SOURCE_FILE; refusing to take it over"
fi
if [ -n "$CUR_GID" ] && [ "$CUR_GID" != "$REC_GID" ]; then
	fail "a group $NAME (gid $CUR_GID) exists that setup did not record in $SOURCE_FILE; refusing to take it over"
fi
if [ -n "$REC_UID" ]; then
	ID="$REC_UID"
	[ "$REC_GID" = "$REC_UID" ] || fail "$SOURCE_FILE records uid $REC_UID and gid $REC_GID; setup uses one id for both"
else
	taken="$( { dscl . -list /Users UniqueID; dscl . -list /Groups PrimaryGroupID; } | awk '{ print $NF }')" || fail "dscl could not list ids"
	ID=600
	while printf '%s\n' "$taken" | grep -qxF -- "$ID"; do ID=$((ID + 1)); done
fi

# Every existing parent of the libexec dir is root-owned and not group- or world-writable.
d="$(dirname "$LIBEXEC")"
while [ "$d" != "/" ] && [ "$d" != "$PREFIX" ]; do
	if [ -e "$d" ]; then
		read -r owner mode <<<"$(stat -f '%u %Lp' "$d")"
		[ "$owner" = "$ROOT_UID" ] || fail "$d is owned by uid $owner, not root; the wrapper must sit in root-owned directories"
		[ $((8#$mode & 8#022)) -eq 0 ] || fail "$d is group- or world-writable (mode $mode)"
	fi
	d="$(dirname "$d")"
done

sha() { shasum -a 256 "$1" | awk '{ print $1 }'; }
created=()
while IFS= read -r c; do [ -n "$c" ] && created+=("$c"); done <<<"$REC_CREATED"
add_created() { recorded "$1" || created+=("$1"); }
[ -n "$CUR_UID" ] || add_created user
[ -n "$CUR_GID" ] || add_created group
[ -e "$ROOT" ] || add_created "$ROOT"
[ -e "$LIBEXEC" ] || add_created "$LIBEXEC"
[ -e "$SUDOERS_FILE" ] || add_created "$SUDOERS_FILE"

# The helper, rendered as you from this checkout. It writes SOURCE (these facts, the created list
# included) on every refresh; setup no longer builds test-exec.js or renders exec, and writes only the
# provisional SOURCE the helper's first run replaces.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/as2test-setup.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
# The trusted execution policy. Inputs are operator-provisioned measurement evidence / a verified,
# self-contained runtime artifact, never proof-manifest values or an installer download.
# The measured resource policy is required (review F2): every ordinary and proof part of the executor the
# helper installs admits its workers from it, so without a valid one setup stops here, before the plan,
# and nothing installed (wrapper, bundle, helper, bun or SOURCE, a legacy one included) is replaced.
POLICY="$LIBEXEC/resources.json"
if [ -n "$RESOURCES" ]; then
	case "$RESOURCES" in /*) ;; *) fail "--resources must name an absolute measured policy file" ;; esac
	bun "$CHECKOUT/surface/src/as2test.ts" validate-resources --file "$RESOURCES" >"$TMP/resources.json" ||
		fail "invalid resource calibration $RESOURCES (its reason is above); include measured nested-worker peaks and host plus historical-load reserve. Nothing changed"
elif [ -e "$POLICY" ] || [ -L "$POLICY" ]; then
	{ [ -f "$POLICY" ] && [ ! -L "$POLICY" ]; } || fail "$POLICY is not a regular file; inspect it, then re-run with --resources=/absolute/measured-policy.json. Nothing changed"
	read -r owner mode <<<"$(stat -f '%u %Lp' "$POLICY")"
	[ "$owner" = "$ROOT_UID" ] || fail "$POLICY is owned by uid $owner, not root; re-run with --resources=/absolute/measured-policy.json to reinstall it root-owned. Nothing changed"
	[ $((8#$mode & 8#022)) -eq 0 ] || fail "$POLICY is group- or world-writable (mode $mode); re-run with --resources=/absolute/measured-policy.json to reinstall it 0644. Nothing changed"
	bun "$CHECKOUT/surface/src/as2test.ts" validate-resources --file "$POLICY" >/dev/null ||
		fail "the installed $POLICY is not a valid measured resource policy (its reason is above); re-run with --resources=/absolute/measured-policy.json. Nothing changed"
else
	fail "no measured resource policy: $POLICY is missing and no --resources=/absolute/measured-policy.json was given. Every test part of the executor the refresh helper installs admits its workers from it (measured worker CPU/memory including nested subprocess peaks, host plus historical-load reserves); there are no default costs. Measure them, then re-run with --resources. Nothing changed"
fi
if [ -n "$OMP_ARTIFACT" ] || [ -n "$OMP_VERSION" ]; then
	[ -n "$OMP_ARTIFACT" ] && [ -n "$OMP_VERSION" ] || fail "--omp-artifact and --omp-version are required together"
	case "$OMP_ARTIFACT" in /*) ;; *) fail "--omp-artifact must name an absolute verified artifact directory" ;; esac
	[ -x "$OMP_ARTIFACT/bin/omp" ] && [ -x "$OMP_ARTIFACT/bin/bun" ] ||
		fail "$OMP_ARTIFACT must contain executable bin/omp and its pinned bin/bun, with all transitive files inside and no symlinks"
	bun "$CHECKOUT/surface/src/as2test.ts" render-runtime-config --artifact "$OMP_ARTIFACT" --runtime-root "$LIBEXEC/omp" --version "$OMP_VERSION" >"$TMP/installed-omp.json" ||
		fail "cannot fingerprint verified OMP artifact $OMP_ARTIFACT"
	[ ! -e "$LIBEXEC/.omp.new" ] && [ ! -L "$LIBEXEC/.omp.new" ] || fail "$LIBEXEC/.omp.new exists; inspect the interrupted provisioning evidence before a new attempt"
	if [ -e "$LIBEXEC/omp" ] || [ -L "$LIBEXEC/omp" ]; then
		cmp -s "$TMP/installed-omp.json" "$LIBEXEC/installed-omp.json" ||
			fail "$LIBEXEC/omp already holds a different pin; runtime replacement requires a separate previewed operator operation, not overwrite"
		bun "$CHECKOUT/surface/src/as2test.ts" verify-runtime-config --file "$LIBEXEC/installed-omp.json" >/dev/null ||
			fail "existing pinned runtime failed verification; repair that installation before re-running setup"
	fi
fi
flags=(--libexec "$LIBEXEC" --root "$ROOT" --bun "$LIBEXEC/bun" --user "$NAME" --uid "$ID" --gid "$ID" --jo "$JO" --jo-uid "$JO_UID" --bun-version "$BUN_VERSION")
for c in ${created[@]+"${created[@]}"}; do flags+=(--created "$c"); done
if [ -n "$TEST_ORIGIN" ]; then
	flags+=(--origin "$TEST_ORIGIN" --allow-file-protocol)
else
	flags+=(--as-root --build-user nobody)
fi
(cd "$CHECKOUT" && bun surface/src/as2test.ts render-refresh "${flags[@]}") >"$TMP/refresh" || fail "could not render the refresh helper"
# The URL as the rendered text fixes it: the one the helper fetches refs/tags/as2-verified from.
HELPER_URL="$(awk -F"'" '/^ORIGIN=/ { print $2; exit }' "$TMP/refresh")"
[ -n "$HELPER_URL" ] || fail "the rendered refresh helper names no ORIGIN"
cp "$BUN_SRC" "$TMP/bun"
# The provisional SOURCE: what setup created and owns, for --undo and a re-run until the helper's first run replaces it.
(cd "$CHECKOUT" && bun surface/src/as2test.ts render-provisional-source "${flags[@]}" --bun-sha "$(sha "$TMP/bun")" --refresh-sha "$(sha "$TMP/refresh")") >"$TMP/SOURCE" ||
	fail "could not render the provisional SOURCE"
SUDOERS_EXEC="$JO ALL=($NAME) NOPASSWD: $LIBEXEC/exec"
SUDOERS_REFRESH="$JO ALL=(root) NOPASSWD: $LIBEXEC/refresh \"\""
printf '%s\n' "# agent-system 2.0 test runner (MIGRATION.md item 24): written by install/as2test-setup.sh" "$SUDOERS_EXEC" "$SUDOERS_REFRESH" >"$TMP/sudoers"

SWEEP_DB="$ROOT/locks/sweep.db"
sweep_db_ok() { [ -f "$SWEEP_DB" ] && [ ! -L "$SWEEP_DB" ] && [ "$(stat -f '%z %u %Lp' "$SWEEP_DB")" = "0 $ID 600" ]; }

# ---- the plan ----------------------------------------------------------------------------------------
say "as2test setup plan for $JO (uid $JO_UID), bun $BUN_VERSION:"
say "  checkout $CHECKOUT at HEAD $SOURCE_SHA; $ON_MAIN"
if [ -n "$TEST_ORIGIN" ]; then BUILT_AS="the caller (a test render: no root check, file protocol allowed)"; else BUILT_AS="nobody, run as root"; fi
say "  the refresh helper is rendered from that HEAD; it fetches the as2-verified tag (refs/tags/as2-verified) from $HELPER_URL and builds that commit as $BUILT_AS"
if [ -n "$CUR_GID" ]; then say "  group $NAME gid $ID: exists (recorded)"; else
	say "  sudo dscl . -create /Groups/$NAME PrimaryGroupID $ID"
	say "  sudo dscl . -create /Groups/$NAME RealName 'as2 test runner'"
	say "  sudo dscl . -create /Groups/$NAME Password '*'"
fi
if [ -n "$CUR_UID" ]; then say "  user $NAME uid $ID: exists (recorded)"; else
	say "  sudo dscl . -create /Users/$NAME UniqueID $ID"
	say "  sudo dscl . -create /Users/$NAME PrimaryGroupID $ID"
	say "  sudo dscl . -create /Users/$NAME UserShell /usr/bin/false"
	say "  sudo dscl . -create /Users/$NAME NFSHomeDirectory /var/empty"
	say "  sudo dscl . -create /Users/$NAME IsHidden 1"
	say "  sudo dscl . -create /Users/$NAME RealName 'as2 test runner'"
	say "  sudo dscl . -create /Users/$NAME Password '*'"
fi
say "  sudo install -d -o root -g wheel -m 0755 $ROOT $ROOT/locks"
say "  sudo install -d -o $JO -g $ID -m 0750 $ROOT/stage"
say "  sudo install -d -o $ID -g $ID -m 0755 $ROOT/runs"
if sweep_db_ok; then say "  $SWEEP_DB: kept (empty, $NAME, 0600)"; else
	say "  sudo rm -f $SWEEP_DB"
	say "  sudo install -o $ID -g $ID -m 0600 /dev/null $SWEEP_DB   (new or repaired)"
fi
say "  sudo install -d -o root -g wheel -m 0755 $LIBEXEC"
say "  sudo install -d -o root -g wheel -m 0700 $LIBEXEC/refresh.d"
if [ -n "$RESOURCES" ]; then
	say "  measured resources.json from $RESOURCES, sha-256 $(sha "$TMP/resources.json"), installed before anything else in $LIBEXEC:"
	cat "$TMP/resources.json"
	say "  sudo install -o root -g wheel -m 0644 $TMP/resources.json $LIBEXEC/.resources.json.new; sudo mv -f $LIBEXEC/.resources.json.new $POLICY"
else
	say "  $POLICY: kept (the measured resource policy, root-owned, sha-256 $(sha "$POLICY"))"
fi
for f in bun refresh; do say "  sudo install -o root -g wheel -m 0755 $f $LIBEXEC/$f   (sha-256 $(sha "$TMP/$f"))"; done
say "  sudo install -o root -g wheel -m 0755 <the provisional SOURCE> $LIBEXEC/.SOURCE.new; sudo mv -f $LIBEXEC/.SOURCE.new $SOURCE_FILE"
say "    (the ids, what setup created, and bun's and refresh's sha-256; the helper's first run replaces it)"
say "  sudoers $SUDOERS_FILE (root:wheel 0440), two lines:"
say "    $SUDOERS_EXEC"
say "    $SUDOERS_REFRESH"
say "    checked first: sudo visudo -c; the policy includes /private/etc/sudoers.d (sudo grep $ETC_SUDOERS when visudo -c does not name it); sudo visudo -cf on the file"
say "  sudo install -o root -g wheel -m 0440 <the drop-in> $SUDOERS_D/.as2test.new"
say "  sudo visudo -cf $SUDOERS_D/.as2test.new; sudo visudo -c"
say "  sudo mv -f $SUDOERS_D/.as2test.new $SUDOERS_FILE"
say "  sudo -k   (drops your cached sudo credential, so the next step passes only through the new rule)"
say "  sudo -n $LIBEXEC/refresh   (last: builds exec, test-exec.js and SOURCE from the as2-verified tag's commit at $HELPER_URL)"
if [ -n "$OMP_ARTIFACT" ]; then
	say "  verified OMP artifact $OMP_ARTIFACT, pin:"
	cat "$TMP/installed-omp.json"
	say "  when absent: copy to $LIBEXEC/.omp.new, root:wheel and no group/world writes; verify the copied tree before rename to $LIBEXEC/omp"
	say "  install root-owned installed-omp.json; privileged activation remains this preview's explicit confirmation"
fi
say "  the refresh helper $LIBEXEC/refresh, sha-256 $(sha "$TMP/refresh"), in full:"
say "----- begin $LIBEXEC/refresh -----"
cat "$TMP/refresh"
say "----- end $LIBEXEC/refresh -----"
[ "$DRY" -eq 0 ] || { say "dry run: nothing changed"; exit 0; }
read -r -p "Apply this plan? [y/N] " answer || answer=""
[ "$answer" = y ] || [ "$answer" = Y ] || fail "not confirmed; nothing changed"

# ---- sudoers checks, before any change ---------------------------------------------------------------
policy="$(sudo visudo -c 2>&1)" || fail "visudo -c fails on the current policy; nothing changed: $policy"
if ! printf '%s\n' "$policy" | grep -q 'sudoers\.d' &&
	! sudo grep -Eq '^[#@]includedir[[:space:]]+(/private)?/etc/sudoers\.d[[:space:]]*$' "$ETC_SUDOERS"; then
	fail "the sudo policy does not include /private/etc/sudoers.d; add '#includedir /private/etc/sudoers.d' to /etc/sudoers with visudo, then re-run. Nothing changed"
fi
sudo visudo -cf "$TMP/sudoers" >/dev/null || fail "visudo -cf rejects the drop-in; nothing changed"

# ---- apply -----------------------------------------------------------------------------------------
step() { say "==> $*"; "$@"; }
if [ -z "$CUR_GID" ]; then
	step sudo dscl . -create "/Groups/$NAME" PrimaryGroupID "$ID"
	step sudo dscl . -create "/Groups/$NAME" RealName "as2 test runner"
	step sudo dscl . -create "/Groups/$NAME" Password "*"
fi
if [ -z "$CUR_UID" ]; then
	step sudo dscl . -create "/Users/$NAME" UniqueID "$ID"
	step sudo dscl . -create "/Users/$NAME" PrimaryGroupID "$ID"
	step sudo dscl . -create "/Users/$NAME" UserShell /usr/bin/false
	step sudo dscl . -create "/Users/$NAME" NFSHomeDirectory /var/empty
	step sudo dscl . -create "/Users/$NAME" IsHidden 1
	step sudo dscl . -create "/Users/$NAME" RealName "as2 test runner"
	step sudo dscl . -create "/Users/$NAME" Password "*"
fi
step sudo install -d -o root -g wheel -m 0755 "$ROOT" "$ROOT/locks"
step sudo install -d -o "$JO" -g "$ID" -m 0750 "$ROOT/stage"
step sudo install -d -o "$ID" -g "$ID" -m 0755 "$ROOT/runs"
if ! sweep_db_ok; then
	step sudo rm -f "$SWEEP_DB"
	step sudo install -o "$ID" -g "$ID" -m 0600 /dev/null "$SWEEP_DB"
fi
step sudo install -d -o root -g wheel -m 0755 "$LIBEXEC"
step sudo install -d -o root -g wheel -m 0700 "$LIBEXEC/refresh.d"
# The measured policy first: if installing it fails, no bun, helper or SOURCE has been replaced yet.
if [ -n "$RESOURCES" ]; then
	step sudo install -o root -g wheel -m 0644 "$TMP/resources.json" "$LIBEXEC/.resources.json.new"
	step sudo mv -f "$LIBEXEC/.resources.json.new" "$POLICY"
fi
for f in bun refresh; do step sudo install -o root -g wheel -m 0755 "$TMP/$f" "$LIBEXEC/$f"; done
# From here on --undo and a re-run read what this run created, whatever fails after it.
step sudo install -o root -g wheel -m 0755 "$TMP/SOURCE" "$LIBEXEC/.SOURCE.new"
step sudo mv -f "$LIBEXEC/.SOURCE.new" "$SOURCE_FILE"
if [ -n "$OMP_ARTIFACT" ]; then
	# Known limit: the copy, chown and chmod below run before the copied tree is hashed, so the hash only detects a
	# copy that differs from the previewed artifact once it is root-owned; safety against an adversary racing the
	# artifact or the staging dir during those steps is not established.
	if [ ! -e "$LIBEXEC/omp" ]; then
		step sudo cp -R "$OMP_ARTIFACT" "$LIBEXEC/.omp.new"
		step sudo chown -R root:wheel "$LIBEXEC/.omp.new"
		step sudo chmod -R go-w "$LIBEXEC/.omp.new"
		# Hash the root-owned copy as the operator. Nothing from the artifact executes as root.
		bun "$CHECKOUT/surface/src/as2test.ts" render-runtime-config --artifact "$LIBEXEC/.omp.new" --runtime-root "$LIBEXEC/omp" --version "$OMP_VERSION" >"$TMP/copied-omp.json" ||
			fail "cannot hash $LIBEXEC/.omp.new; retained as provisioning failure evidence"
		cmp -s "$TMP/copied-omp.json" "$TMP/installed-omp.json" ||
			fail "copied runtime differs from previewed artifact; $LIBEXEC/.omp.new retained, nothing activated"
		step sudo mv "$LIBEXEC/.omp.new" "$LIBEXEC/omp"
	fi
	step sudo install -o root -g wheel -m 0644 "$TMP/installed-omp.json" "$LIBEXEC/.installed-omp.json.new"
	step sudo mv -f "$LIBEXEC/.installed-omp.json.new" "$LIBEXEC/installed-omp.json"
	bun "$CHECKOUT/surface/src/as2test.ts" verify-runtime-config --file "$LIBEXEC/installed-omp.json" >/dev/null ||
		fail "pinned OMP post-provision verification failed; installed tree and pin retained for diagnosis"
fi

# The drop-in: staged under a name sudo's includedir skips (it contains a dot), checked, then moved.
step sudo install -o root -g wheel -m 0440 "$TMP/sudoers" "$SUDOERS_D/.as2test.new"
if ! sudo visudo -cf "$SUDOERS_D/.as2test.new" >/dev/null || ! sudo visudo -c >/dev/null; then
	sudo rm -f "$SUDOERS_D/.as2test.new"
	fail "visudo rejected the staged drop-in; it was removed and $SUDOERS_FILE is unchanged. The user, dirs, bun, refresh and the provisional SOURCE are in place: fix the policy and re-run, or undo with 'bash install/as2test-setup.sh --undo'"
fi
step sudo mv -f "$SUDOERS_D/.as2test.new" "$SUDOERS_FILE"

# Last: the helper through the new rule, with no cached credential to fall back on.
step sudo -k
if ! step sudo -n "$LIBEXEC/refresh"; then
	fail "the refresh helper failed (its message is above); everything before it is in place, and the provisional SOURCE records it. The runner's next preflight finds exec and test-exec.js unbuilt (file-drift) and runs the helper again; to retry now, fix the cause and run 'sudo -n $LIBEXEC/refresh', or re-run this script. 'bash install/as2test-setup.sh --undo' removes it all"
fi
say "as2test is set up: $LIBEXEC (SOURCE records it). The runner checks it before every run and, when it drifts, refreshes the bundle from the commit refs/tags/as2-verified names."
say "undo: bash install/as2test-setup.sh --undo"
