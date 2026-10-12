#!/usr/bin/env bash
# Fresh-machine install test (SPEC-2.0.md § B8, P-4 gate): clone this repo into a temp dir, run the
# installer with a temp $HOME, and prove the ledger and its first scheduled copy land under that
# $HOME, and that the OMP profile lands under it too: config.yml rendered from profile/config.yml
# with {repo} filled, models.yml beside it, the six tier files linked into agents/, and OMP's own
# skill discovery under that HOME and profile listing exactly the manifest's `skill` rows (the
# 21 of DESIGN-2.0.md § C6.1) with decoy skills planted in ~/.claude and ~/.agents not among them,
# and OMP's own extension loading under that HOME and profile loading exactly the three configured
# extensions in the order surface, gates, classifier, with no load error. The launcher
# (`launcher` rows, bin/as2) is linked at $HOME/.local/bin/as2, `as2 --print` prints the exact omp
# command under zsh and bash alike, and `as2 off` / `as2 on` flip gates.fence.enabled in the
# rendered profile config. The installed OMP reads the rendered setupVersion, it equals that OMP's
# CURRENT_SETUP_VERSION and selects no first-launch setup scene, and install's last line names the
# providers the profile routes to with the once-per-profile /login (M7 finding 2); the eleven
# look-and-feel keys copied from Jo's default profile are in the rendered profile at their values
# and the installed OMP reads each one back. The profile's mcp.json (profile/mcp.json) lands beside
# config.yml and OMP's own MCP discovery under that HOME and profile finds exactly the ctx server,
# from that file, with decoy servers planted in the default profile's mcp.json and ~/.claude.json
# not among them; and the profile's sessions directory is a named ctx `pi` history root under that
# HOME's ctx data root, registered once however often install runs (M8 ctx wiring).
# Also proves the refusals: an unmanifested file or any symbolic link under a machinery
# directory fails install; a wrong, missing or duplicated ledger-schema row fails install; a
# profile whose includeSkills differs from the manifest fails install and writes no profile; a
# synced-folder ledger path fails install, including one reached through a symlink; a version-1
# ledger (the schema of 94f06b9 and of 71a576e) fails install with exit 4 and is left unchanged.
# And the periodic backup job (macOS): the launchd plist written under the temp $HOME lints, and
# the exact command it would run (argv, environment, working directory) takes a due copy while a
# writer holds the ledger open, then exits nonzero when the due copy cannot be written. A ledger
# whose snapshot fails (a malformed page) makes the job exit nonzero on every run and leaves no
# file that counts as a copy; a HOME and a ledger path holding "@REPO@" and "&" land in the plist
# exactly as given. The backup plist is never loaded. And the nightly chaos job (macOS, step 13),
# against a fake `launchctl` first on PATH that records its argv: an install without the flag
# writes no chaos plist and runs no launchctl; --chaos-nightly writes a plist that lints, holds
# exactly the four quarter-hour StartCalendarInterval entries and absolute paths (bun, the clone's
# surface/scripts/chaos.ts, HOME, a PATH of the bun, omp and git directories, the log under
# ~/agent-scratch/agent-system-2.0/chaos, whose directory install creates) and no ledger variable,
# and bootstraps it into gui/<uid>; a re-run boots the loaded job out first; --chaos-nightly=off
# boots it out and deletes the plist; the flag is refused with exit 2 and nothing written when omp
# is not on PATH, and so is an unknown argument. No real launchctl runs.
#
# Usage:   bash install/fresh-machine-test.sh
# Env:     FRESH_TEST_ROOT  where the temp clone and temp HOME go (default: ${TMPDIR:-/tmp})
#          FRESH_TEST_LOG   also tee all output to this file (optional)
# Exit:    0 every check passed · 1 a check failed (the failing step is the last "==>" line)
#
# Writes only inside a new directory under FRESH_TEST_ROOT; the real $HOME and the source
# checkout are never written. The work directory is left in place as evidence; its path is printed.
# If the source checkout has uncommitted files, they are overlaid onto the clone (listed in the
# output) so the test covers the tree as it stands, not only the last commit.
set -euo pipefail

if [ -n "${FRESH_TEST_LOG:-}" ]; then
	mkdir -p "$(dirname "$FRESH_TEST_LOG")"
	exec > >(tee "$FRESH_TEST_LOG") 2>&1
fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${FRESH_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$ROOT"
WORK="$(mktemp -d "$ROOT/fresh-machine.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)" # a TMPDIR with a trailing slash would otherwise leave "//" in every path the installer renders without it
CLONE="$WORK/repo"
FAKE_HOME="$WORK/home"
SQLITE3="$(command -v sqlite3)"
[ -x /usr/bin/sqlite3 ] && SQLITE3=/usr/bin/sqlite3

step() { printf '\n==> %s\n' "$*"; }
ok() { printf 'PASS: %s\n' "$*"; }
die() { printf 'FAIL: %s\n' "$*"; exit 1; }

# Run the clone's installer as a fresh machine would: only PATH and the temp HOME, nothing else
# inherited (no OMP_*, no AGENT_SYSTEM_LEDGER_DB). Extra VAR=value pairs may follow.
run_install() {
	env -i PATH="$PATH" HOME="$FAKE_HOME" "$@" bash "$CLONE/install/install.sh"
}

printf 'fresh-machine install test\n'
printf 'date: %s\nsource: %s\nsource HEAD: %s\nwork dir: %s\nbun: %s\nsqlite3: %s (%s)\n' \
	"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SRC" "$(git -C "$SRC" rev-parse HEAD)" "$WORK" \
	"$(bun --version)" "$SQLITE3" "$("$SQLITE3" --version | cut -d' ' -f1)"

step "1. clone the repo into the work dir"
git clone --quiet --no-hardlinks "$SRC" "$CLONE"
ok "cloned to $CLONE at $(git -C "$CLONE" rev-parse --short HEAD)"

step "2. overlay uncommitted files from the source checkout"
overlay="$(git -C "$SRC" ls-files --modified --others --exclude-standard)"
if [ -z "$overlay" ]; then
	ok "source is clean; testing the commit as cloned"
else
	printf '%s\n' "$overlay" | while IFS= read -r f; do
		if [ -f "$SRC/$f" ]; then
			mkdir -p "$(dirname "$CLONE/$f")"
			cp -p "$SRC/$f" "$CLONE/$f"
			printf '  overlaid: %s\n' "$f"
		fi
	done
	ok "overlay done"
fi

step "3. install with a temp HOME: $FAKE_HOME"
mkdir -p "$FAKE_HOME"
run_install || die "install exited $?"
LEDGER="$FAKE_HOME/.agent-system-2/ledger.db"
[ -f "$LEDGER" ] || die "no ledger at $LEDGER"
ok "ledger created at $LEDGER"

step "3b. the OMP profile landed under the temp HOME"
PROFILE="$FAKE_HOME/.omp/profiles/agent-system-2/agent"
[ -f "$PROFILE/config.yml" ] || die "no rendered config at $PROFILE/config.yml"
grep -qF '{repo}' "$PROFILE/config.yml" && die "rendered config still holds {repo}"
grep -qF -- "- \"$CLONE/skills\"" "$PROFILE/config.yml" || die "rendered config does not point customDirectories at $CLONE/skills"
grep -qF -- "- \"$CLONE/classifier/extension.ts\"" "$PROFILE/config.yml" || die "rendered config does not name the classifier extension by the clone's path"
grep -qF -- "- \"$CLONE/gates/index.ts\"" "$PROFILE/config.yml" || die "rendered config does not name the gates extension by the clone's path"
cmp -s "$CLONE/profile/models.yml" "$PROFILE/models.yml" || die "models.yml under the profile differs from profile/models.yml"
ok "config.yml rendered with {repo}=$CLONE; models.yml placed beside it"
TIERS="$(cd "$CLONE/tiers" && find . -maxdepth 1 -name '*.md' -type f | sed 's|^\./||' | LC_ALL=C sort)"
[ "$(printf '%s' "$TIERS" | grep -c .)" -eq 6 ] || die "expected six tier files in tiers/, found: $TIERS"
for t in $TIERS; do
	[ -L "$PROFILE/agents/$t" ] || die "$PROFILE/agents/$t is not a symbolic link"
	[ "$(readlink "$PROFILE/agents/$t")" = "$CLONE/tiers/$t" ] || die "$PROFILE/agents/$t links to $(readlink "$PROFILE/agents/$t"), not $CLONE/tiers/$t"
	[ -f "$PROFILE/agents/$t" ] || die "$PROFILE/agents/$t does not resolve"
done
ok "six tier agents linked: $(printf '%s' "$TIERS" | tr '\n' ' ')"

step "3c. OMP skill discovery under the temp HOME and profile lists exactly the manifest's skill rows"
# Decoys in the places OMP would otherwise read skills from: the profile turns those providers off
# and its includeSkills names the manifest rows, so neither may appear.
mkdir -p "$FAKE_HOME/.claude/skills/decoy-claude-user" "$FAKE_HOME/.agents/skills/decoy-agents-user" "$FAKE_HOME/.omp/profiles/agent-system-2/agent/skills/decoy-profile-native"
for d in "$FAKE_HOME/.claude/skills/decoy-claude-user" "$FAKE_HOME/.agents/skills/decoy-agents-user" "$FAKE_HOME/.omp/profiles/agent-system-2/agent/skills/decoy-profile-native"; do
	printf -- '---\nname: %s\ndescription: decoy skill; must not be listed\n---\n# decoy\n' "${d##*/}" >"$d/SKILL.md"
done
WANT="$(awk -F'\t' '$2 == "skill" { sub(/^skills\//, "", $1); sub(/\/SKILL\.md$/, "", $1); print $1 }' "$CLONE/install/manifest.tsv" | LC_ALL=C sort)"
[ "$(printf '%s' "$WANT" | grep -c .)" -eq 21 ] || die "manifest has $(printf '%s' "$WANT" | grep -c .) skill rows, expected 21 (DESIGN-2.0.md § C6.1)"
# The listing goes through the installed omp package's own discovery (Settings → cfgSkills →
# discoverSkills), the code path the CLI uses (sdk.ts `cfgSkills.get(settings)`; OMP 18.4.4 has no
# Settings.getGroup, which this step called on 18.3.0); omp has no skill-listing subcommand.
OMP_PKG="$(dirname "$(dirname "$(readlink -f "$(command -v omp)")")")"
[ -f "$OMP_PKG/src/index.ts" ] || die "omp package not found from $(command -v omp) (expected $OMP_PKG/src/index.ts)"
LISTING="$WORK/skill-listing.txt"
(cd "$WORK" && env -i PATH="$PATH" HOME="$FAKE_HOME" OMP_PROFILE=agent-system-2 bun -e "
	const m = await import('$OMP_PKG/src/index.ts');
	const { cfgSkills } = await import('$OMP_PKG/src/extensibility/settings.ts');
	const agentDir = m.getAgentDir();
	const settings = await m.Settings.loadReadOnly({ cwd: process.cwd(), agentDir });
	const { skills, warnings } = await m.discoverSkills(process.cwd(), agentDir, cfgSkills.get(settings));
	console.log('agentDir=' + agentDir);
	for (const s of [...skills].sort((a, b) => a.name.localeCompare(b.name))) console.log(s.name + '\t' + s.source + '\t' + s.filePath);
	for (const w of warnings) console.log('warning\t' + w.skillPath + '\t' + w.message);
" >"$LISTING") || die "skill discovery under $FAKE_HOME exited $?"
printf 'omp version: %s\n' "$(omp --version 2>/dev/null | head -n 1)"
sed 's/^/  /' "$LISTING"
grep -q "^agentDir=$FAKE_HOME/.omp/profiles/agent-system-2/agent\$" "$LISTING" || die "discovery did not run under the temp HOME's agent-system-2 profile"
GOT="$(awk -F'\t' 'NF == 3 && $1 != "warning" { print $1 }' "$LISTING" | LC_ALL=C sort)"
[ "$GOT" = "$WANT" ] || die "discovered skills differ from the manifest's skill rows; got: $(printf '%s' "$GOT" | tr '\n' ' ') want: $(printf '%s' "$WANT" | tr '\n' ' ')"
grep -q 'decoy' "$LISTING" && die "a decoy skill was discovered"
[ "$(awk -F'\t' 'NF == 3 && $1 != "warning" && $3 !~ "^'"$CLONE"'/skills/" ' "$LISTING" | wc -l | tr -d ' ')" -eq 0 ] || die "a discovered skill does not come from $CLONE/skills"
grep -q '^warning' "$LISTING" && die "skill discovery reported warnings"
ok "exactly 21 skills discovered, all from $CLONE/skills, no decoy, no warnings; listing kept at $LISTING"

# The same package's extension loading, as a session does it (sdk.ts discoverSessionExtensionPaths:
# cfgExtensions + cfgDisabledExtensions read from settings — OMP 18.4.4 has no Settings.get —
# ambient discovery on, then loadExtensions). The fake
# HOME holds no native, hook or plugin extensions, so what loads is exactly the rendered config's
# `extensions:` list, in its order (load order is tool_call handler order; profile/config.yml says
# why each sits where it does).
EXT_LISTING="$WORK/extension-listing.txt"
(cd "$WORK" && env -i PATH="$PATH" HOME="$FAKE_HOME" OMP_PROFILE=agent-system-2 bun -e "
	const m = await import('$OMP_PKG/src/index.ts');
	const { cfgExtensions, cfgDisabledExtensions } = await import('$OMP_PKG/src/extensibility/settings.ts');
	const agentDir = m.getAgentDir();
	const settings = await m.Settings.loadReadOnly({ cwd: process.cwd(), agentDir });
	const r = await m.discoverAndLoadExtensions(cfgExtensions.get(settings), process.cwd(), undefined, cfgDisabledExtensions.get(settings));
	for (const e of r.extensions) console.log('loaded\t' + e.path);
	for (const e of r.errors) console.log('error\t' + e.path + '\t' + e.error);
	process.exit(0);
" >"$EXT_LISTING") || die "extension loading under $FAKE_HOME exited $?"
sed 's/^/  /' "$EXT_LISTING"
grep -q '^error' "$EXT_LISTING" && die "OMP reported an extension load error"
CONFIGURED="$(bun -e "for (const p of Bun.YAML.parse(await Bun.file('$PROFILE/config.yml').text()).extensions) console.log('loaded\t' + p)")"
EXT_WANT="$(printf 'loaded\t%s\n' "$CLONE/surface/index.ts" "$CLONE/gates/index.ts" "$CLONE/classifier/extension.ts")"
[ "$CONFIGURED" = "$EXT_WANT" ] || die "the rendered config's extensions are not exactly surface, gates, classifier in that order"
[ "$(cat "$EXT_LISTING")" = "$EXT_WANT" ] || die "OMP did not load exactly surface, gates, classifier in that order"
ok "OMP loaded exactly three extensions, in order: surface, gates, classifier (the rendered config's order); no load errors; listing kept at $EXT_LISTING"

step "3c2. under the rendered profile OMP skips its first-launch wizard (M7 finding 2) and reads Jo's look-and-feel keys"
# The installed omp package's own reads, as main.ts's cold-launch gate does them: setupVersion from
# the profile's config.yml through Settings, compared with CURRENT_SETUP_VERSION, and the scenes
# whose minVersion is above it. A profile without the key reads 0 and selects every scene; the
# scenes-at-0 line shows the check is not vacuous. An installed OMP whose CURRENT_SETUP_VERSION
# differs from the template's value fails here, which is the prompt to re-pin profile/config.yml.
SETUP_LISTING="$WORK/setup-listing.txt"
(cd "$WORK" && env -i PATH="$PATH" HOME="$FAKE_HOME" OMP_PROFILE=agent-system-2 bun -e "
	const m = await import('$OMP_PKG/src/index.ts');
	const { cfgSetupVersion } = await import('$OMP_PKG/src/modes/settings.ts');
	await import('$OMP_PKG/src/session/settings.ts');
	const { lookup } = await import('$OMP_PKG/src/config/registry.ts');
	const { CURRENT_SETUP_VERSION, ALL_SCENES } = await import('$OMP_PKG/src/modes/setup.ts');
	const settings = await m.Settings.loadReadOnly({ cwd: process.cwd(), agentDir: m.getAgentDir() });
	const stored = cfgSetupVersion.get(settings);
	console.log('stored=' + stored);
	console.log('current=' + CURRENT_SETUP_VERSION);
	console.log('scenes-at-stored=' + ALL_SCENES.filter((s) => s.minVersion > stored).map((s) => s.id).join(','));
	console.log('scenes-at-0=' + ALL_SCENES.filter((s) => s.minVersion > 0).map((s) => s.id).join(','));
	for (const id of ['symbolPreset', 'composer.shape', 'theme.dark', 'theme.light', 'hideThinkingBlock', 'display.hideToolActivity', 'display.showTokenUsage', 'display.showTurnTime', 'display.shimmer', 'tui.resizeScrollback', 'tui.hyperlinks']) {
		const s = lookup(id);
		console.log('look ' + id + '=' + (s ? String(s.get(settings)) : '<not a registered setting>'));
	}
	process.exit(0);
" >"$SETUP_LISTING") || die "setup-version read under $FAKE_HOME exited $?"
sed 's/^/  /' "$SETUP_LISTING"
TEMPLATE_SETUP="$(bun -e "console.log(Bun.YAML.parse(await Bun.file('$CLONE/profile/config.yml').text()).setupVersion)")"
grep -qx "stored=$TEMPLATE_SETUP" "$SETUP_LISTING" || die "OMP read setupVersion $(sed -n 's/^stored=//p' "$SETUP_LISTING") from the rendered profile, not the template's $TEMPLATE_SETUP"
grep -qx "current=$TEMPLATE_SETUP" "$SETUP_LISTING" || die "profile/config.yml pins setupVersion $TEMPLATE_SETUP but the installed OMP's CURRENT_SETUP_VERSION is $(sed -n 's/^current=//p' "$SETUP_LISTING"); re-pin it"
grep -qx 'scenes-at-stored=' "$SETUP_LISTING" || die "the rendered setupVersion still selects setup scenes: $(sed -n 's/^scenes-at-stored=//p' "$SETUP_LISTING")"
grep -q '^scenes-at-0=.' "$SETUP_LISTING" || die "no setup scene is selected even at version 0, so this check proves nothing"
ok "rendered setupVersion $TEMPLATE_SETUP = the installed OMP's CURRENT_SETUP_VERSION; no setup scene selected (at 0: $(sed -n 's/^scenes-at-0=//p' "$SETUP_LISTING"))"
# Jo's look and feel (their default profile's keys, copied into profile/config.yml), each read back
# through OMP's own setting handle (config/registry.ts lookup) under the temp HOME's profile.
LOOK_WANT="$(printf 'look %s\n' symbolPreset=unicode composer.shape=field theme.dark=titanium theme.light=light hideThinkingBlock=true \
	display.hideToolActivity=true display.showTokenUsage=true display.showTurnTime=true display.shimmer=kitt tui.resizeScrollback=rebuild tui.hyperlinks=always)"
[ "$(grep '^look ' "$SETUP_LISTING")" = "$LOOK_WANT" ] || die "OMP's reads of the look-and-feel keys differ from Jo's values; got: $(grep '^look ' "$SETUP_LISTING" | tr '\n' ' ')"
# A value could equal OMP's default without the key being rendered, so the rendered file is read too.
LOOK_RENDERED="$(bun -e "
	const doc = Bun.YAML.parse(await Bun.file('$PROFILE/config.yml').text());
	for (const id of ['symbolPreset', 'composer.shape', 'theme.dark', 'theme.light', 'hideThinkingBlock', 'display.hideToolActivity', 'display.showTokenUsage', 'display.showTurnTime', 'display.shimmer', 'tui.resizeScrollback', 'tui.hyperlinks'])
		console.log('look ' + id + '=' + String(id.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc)));
")"
[ "$LOOK_RENDERED" = "$LOOK_WANT" ] || die "the rendered config's look-and-feel keys differ from Jo's values; got: $(printf '%s' "$LOOK_RENDERED" | tr '\n' ' ')"
ok "all eleven look-and-feel keys are in the rendered profile at Jo's values, and OMP reads each one back"

step "3d. the launcher: \$HOME/.local/bin/as2 links to the clone's bin/as2; --print, on and off"
AS2="$FAKE_HOME/.local/bin/as2"
[ -L "$AS2" ] || die "no launcher link at $AS2"
[ "$(readlink "$AS2")" = "$CLONE/bin/as2" ] || die "$AS2 links to $(readlink "$AS2"), not $CLONE/bin/as2"
reinstall_out="$(run_install)" || die "install (launcher re-run) exited $?"
printf '%s\n' "$reinstall_out" | grep -qF "note: $FAKE_HOME/.local/bin is not on PATH" || die "install did not print the not-on-PATH notice for $FAKE_HOME/.local/bin"
LOGIN_WANT="==> first launch: this profile routes to anthropic, openai-codex, moonshot, typesafe; OMP needs a login to each once per profile: run /login in the as2 session (credentials stay in $PROFILE/agent.db)"
[ "$(printf '%s\n' "$reinstall_out" | tail -n 1)" = "$LOGIN_WANT" ] || die "install's last line is '$(printf '%s\n' "$reinstall_out" | tail -n 1)', expected '$LOGIN_WANT'"
ok "install's last line names the four providers and the once-per-profile /login"
# The cwd is the clone the link resolves into, whatever directory as2 is run from (Jo's second session ran from ~/tmp).
PRINT_WANT="env OMP_PROFILE=agent-system-2 AGENT_SYSTEM_ROLE=orchestrator omp --cwd $(cd -P "$CLONE" && pwd -P)"
for sh in zsh bash; do
	command -v "$sh" >/dev/null 2>&1 || die "$sh not found; the launcher is tested under zsh and bash"
	got="$(env -i PATH="$FAKE_HOME/.local/bin:$PATH" HOME="$FAKE_HOME" "$sh" "$AS2" --print)" || die "$sh $AS2 --print exited $?"
	[ "$got" = "$PRINT_WANT" ] || die "$sh $AS2 --print printed '$got', expected '$PRINT_WANT'"
done
got="$(env -i PATH="$FAKE_HOME/.local/bin:$PATH" HOME="$FAKE_HOME" zsh -c 'cd / && as2 --print')" || die "as2 by name on PATH exited $?"
[ "$got" = "$PRINT_WANT" ] || die "as2 by name printed '$got', expected '$PRINT_WANT'"
fence_value() { bun -e "console.log(Bun.YAML.parse(await Bun.file('$PROFILE/config.yml').text()).gates.fence.enabled)"; }
[ "$(fence_value)" = true ] || die "rendered fence is not enabled before the flip"
out="$(env -i PATH="$PATH" HOME="$FAKE_HOME" zsh "$AS2" off)" || die "as2 off exited $?"
printf '%s\n' "$out"
[ "$out" = "gates.fence.enabled: true -> false ($PROFILE/config.yml)" ] || die "as2 off printed '$out'"
[ "$(fence_value)" = false ] || die "as2 off did not set gates.fence.enabled to false"
out="$(env -i PATH="$PATH" HOME="$FAKE_HOME" bash "$AS2" on)" || die "as2 on exited $?"
printf '%s\n' "$out"
[ "$(fence_value)" = true ] || die "as2 on did not set gates.fence.enabled back to true"
diff <(grep -v '^    enabled:' "$PROFILE/config.yml") <(bun -e "process.stdout.write((await Bun.file('$CLONE/profile/config.yml').text()).split('{repo}').join('$CLONE'))" | grep -v '^    enabled:') \
	|| die "as2 on/off changed something other than gates.fence.enabled"
ok "launcher linked at $AS2; --print is '$PRINT_WANT' under zsh, bash and by name on PATH; off/on flip only gates.fence.enabled"

step "3e. the ctx MCP server reaches the profile through its own mcp.json; its sessions are a ctx history root (M8 ctx wiring)"
cmp -s "$CLONE/profile/mcp.json" "$PROFILE/mcp.json" || die "mcp.json under the profile differs from profile/mcp.json"
# Decoys where the default profile and Claude Code keep MCP servers: under the as2 profile OMP reads
# its user MCP config from the profile's agent dir only (discovery/builtin.ts getAgentDir()), and the
# Claude user source is opt-in (discovery/claude.ts getUserClaude), so neither may appear.
mkdir -p "$FAKE_HOME/.omp/agent"
printf '{"mcpServers":{"decoy-default":{"type":"stdio","command":"true"}}}\n' >"$FAKE_HOME/.omp/agent/mcp.json"
printf '{"mcpServers":{"decoy-claude":{"type":"stdio","command":"true"}}}\n' >"$FAKE_HOME/.claude.json"
MCP_LISTING="$WORK/mcp-listing.txt"
(cd "$WORK" && env -i PATH="$PATH" HOME="$FAKE_HOME" OMP_PROFILE=agent-system-2 bun -e "
	const m = await import('$OMP_PKG/src/index.ts');
	const { loadAllMCPConfigs } = await import('$OMP_PKG/src/mcp/config.ts');
	await m.Settings.loadReadOnly({ cwd: process.cwd(), agentDir: m.getAgentDir() });
	const r = await loadAllMCPConfigs(process.cwd());
	for (const [name, s] of Object.entries(r.sources)) console.log(name + '\t' + s.provider + '\t' + s.path + '\t' + [r.configs[name].command, ...(r.configs[name].args ?? [])].join(' '));
	process.exit(0);
" >"$MCP_LISTING") || die "MCP discovery under $FAKE_HOME exited $?"
sed 's/^/  /' "$MCP_LISTING"
MCP_WANT="$(printf 'ctx\tnative\t%s\tctx mcp serve' "$PROFILE/mcp.json")"
[ "$(cat "$MCP_LISTING")" = "$MCP_WANT" ] || die "OMP's MCP discovery under the profile is not exactly the ctx server from $PROFILE/mcp.json"
ok "OMP discovers exactly one MCP server under the profile: ctx, from $PROFILE/mcp.json; the default-profile and ~/.claude.json decoys are not read"
CTX_ROOT="omp-agent-system-2-sessions"
if command -v ctx >/dev/null 2>&1; then
	[ -d "$PROFILE/sessions" ] || die "install did not create $PROFILE/sessions"
	roots="$(env -i PATH="$PATH" HOME="$FAKE_HOME" ctx sources --provider pi --format json | bun -e '
		for (const s of JSON.parse(await Bun.stdin.text()).sources) if (s.selection.kind === "configured") console.log(s.selection.root + "\t" + s.path + "\t" + s.status);
	')" || die "ctx sources under $FAKE_HOME exited $?"
	printf '  %s\n' "$roots"
	# A fresh profile has no transcripts yet, which ctx reports as `empty`; either status means the root is selected.
	case "$roots" in
		"$(printf '%s\t%s\t' "$CTX_ROOT" "$PROFILE/sessions")"available | "$(printf '%s\t%s\t' "$CTX_ROOT" "$PROFILE/sessions")"empty) ;;
		*) die "ctx's configured pi roots under $FAKE_HOME are not exactly $CTX_ROOT -> $PROFILE/sessions (available or empty)" ;;
	esac
	printf '%s\n' "$reinstall_out" | grep -qF "==> ctx history root: Kept pi history root '$CTX_ROOT' ($PROFILE/sessions)" \
		|| die "the re-install did not keep the existing ctx root as it was"
	[ "$(grep -c "^\[sources.roots.$CTX_ROOT\]\$" "$FAKE_HOME/.ctx/config.toml")" -eq 1 ] || die "$FAKE_HOME/.ctx/config.toml does not hold exactly one $CTX_ROOT entry"
	ok "$PROFILE/sessions is ctx pi root $CTX_ROOT under $FAKE_HOME/.ctx; the re-install kept it (one entry in config.toml)"
else
	printf '%s\n' "$reinstall_out" | grep -qF "==> note: ctx is not on PATH" || die "ctx is absent and install did not say the root was not registered"
	ok "ctx is not on PATH here; install said the root was not registered"
fi

step "4. inspect the installed ledger with raw sqlite3"
printf 'user_version=%s journal_mode=%s tables=%s triggers=%s integrity=%s\n' \
	"$("$SQLITE3" "$LEDGER" 'PRAGMA user_version;')" \
	"$("$SQLITE3" "$LEDGER" 'PRAGMA journal_mode;')" \
	"$("$SQLITE3" "$LEDGER" "SELECT group_concat(name, ',') FROM (SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name);")" \
	"$("$SQLITE3" "$LEDGER" "SELECT count(*) FROM sqlite_master WHERE type='trigger';")" \
	"$("$SQLITE3" "$LEDGER" 'PRAGMA integrity_check;')"
[ "$("$SQLITE3" "$LEDGER" 'PRAGMA user_version;')" = 5 ] || die "schema version is not 5"
[ "$("$SQLITE3" "$LEDGER" 'PRAGMA journal_mode;')" = wal ] || die "journal mode is not wal"
ok "schema version 5, WAL"
printf 'files under the temp HOME:\n'
(cd "$FAKE_HOME" && find . -type f | LC_ALL=C sort | sed 's/^/  /')
COPY="$(find "$FAKE_HOME/.agent-system-2/backups" -name 'ledger-*.db' -type f | LC_ALL=C sort | tail -n 1)"
[ -n "$COPY" ] || die "install left no scheduled copy under $FAKE_HOME/.agent-system-2/backups"
[ "$("$SQLITE3" "$COPY" 'PRAGMA user_version;')" = 5 ] && [ "$("$SQLITE3" "$COPY" 'PRAGMA integrity_check;')" = ok ] \
	|| die "the scheduled copy $COPY does not reopen as a schema-5 ledger"
ok "first scheduled copy taken by install and reopened with raw sqlite3: $COPY"

step "5. the installed ledger refuses an illegal raw write"
"$SQLITE3" "$LEDGER" "INSERT INTO workloads (id, brief, stakes, mode, created_by, created_at, changed_by, changed_at) VALUES ('wl-fresh', 'fresh-machine probe', 'throwaway', 'autonomous', 'fresh-test', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'fresh-test', strftime('%Y-%m-%dT%H:%M:%fZ','now'));" \
	|| die "legal raw insert refused"
set +e
out="$("$SQLITE3" "$LEDGER" "UPDATE workloads SET status = 'closed' WHERE id = 'wl-fresh';" 2>&1)"
status=$?
set -e
printf 'unstamped close -> exit %s: %s\n' "$status" "$out"
[ "$status" -ne 0 ] || die "unstamped update was accepted"
ok "illegal write refused by the installed file"
"$SQLITE3" "$LEDGER" "PRAGMA recursive_triggers;" | sed 's/^/recursive_triggers=/'
set +e
out="$("$SQLITE3" "$LEDGER" "REPLACE INTO workloads (id, brief, stakes, mode, created_by, created_at, changed_by, changed_at) VALUES ('wl-fresh', 'forged', 'throwaway', 'autonomous', 'fresh-test', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'fresh-test', strftime('%Y-%m-%dT%H:%M:%fZ','now'));" 2>&1)"
status=$?
set -e
printf 'raw REPLACE of an existing workload -> exit %s: %s\n' "$status" "$out"
[ "$status" -ne 0 ] || die "raw REPLACE of an existing row was accepted"
[ "$("$SQLITE3" "$LEDGER" "SELECT brief FROM workloads WHERE id = 'wl-fresh';")" = "fresh-machine probe" ] || die "raw REPLACE changed the row"
ok "raw REPLACE refused by the installed file; row unchanged"

step "6. re-run install (idempotent)"
run_install || die "second install exited $?"
[ "$("$SQLITE3" "$LEDGER" "SELECT count(*) FROM workloads WHERE id = 'wl-fresh';")" = 1 ] || die "re-install lost data"
ok "second install exit 0; existing row kept"

step "7. decoy: an unmanifested file under a machinery directory fails install"
DECOY="$CLONE/ledger/src/decoy-unmanifested.ts"
printf '// decoy: no manifest row\n' >"$DECOY"
set +e
run_install
status=$?
set -e
[ "$status" -eq 2 ] || die "install with decoy exited $status, expected 2"
ok "install refused the decoy with exit 2"
rm "$DECOY"
run_install >/dev/null || die "install after removing the decoy exited $?"
ok "decoy removed ($DECOY); install passes again"

# Expect the clone's installer to exit $1 with the remaining VAR=value pairs.
expect_install_exit() {
	local want="$1" got
	shift
	set +e
	run_install "$@"
	got=$?
	set -e
	[ "$got" -eq "$want" ] || die "install exited $got, expected $want"
}

step "7b. decoy: an unmanifested symbolic link under a machinery directory fails install"
LINK="$CLONE/ledger/unmanifested.ts"
ln -s src/index.ts "$LINK"
expect_install_exit 2
rm "$LINK"
ln -s ../../nowhere "$CLONE/ledger/src/dangling"
expect_install_exit 2
rm "$CLONE/ledger/src/dangling"
run_install >/dev/null || die "install after removing the symlinks exited $?"
ok "a symlink to a real artifact and a dangling symlink were both refused with exit 2; install passes again"

step "7c. a wrong, missing or duplicated ledger-schema manifest row fails install and writes nothing"
MANIFEST="$CLONE/install/manifest.tsv"
cp -p "$MANIFEST" "$WORK/manifest.orig"
S1_DB="$WORK/s1-home-untouched/ledger.db"
T=$'\t'
DOC_ROW="ledger/SCHEMA.md${T}doc${T}-"
SCHEMA_ROW="ledger/schema.sql${T}ledger-schema${T}{ledger_db}"
# Rewrite the original manifest, replacing whole row $1 with $2 (and $3 with $4, when given).
manifest_with() {
	awk -v a="$1" -v b="$2" -v c="${3:-}" -v d="${4:-}" '$0 == a { $0 = b } c != "" && $0 == c { $0 = d } { print }' \
		"$WORK/manifest.orig" >"$MANIFEST"
}
# swapped: the markdown doc claims to be the schema, the schema is filed as a doc
manifest_with "$DOC_ROW" "ledger/SCHEMA.md${T}ledger-schema${T}{ledger_db}" "$SCHEMA_ROW" "ledger/schema.sql${T}doc${T}-"
grep -qF "ledger/SCHEMA.md${T}ledger-schema" "$MANIFEST" && grep -qF "ledger/schema.sql${T}doc" "$MANIFEST" || die "test setup: swap did not apply"
expect_install_exit 2 AGENT_SYSTEM_LEDGER_DB="$S1_DB"
# missing: no ledger-schema row at all (schema.sql filed as a doc)
manifest_with "$SCHEMA_ROW" "ledger/schema.sql${T}doc${T}-"
grep -qF "ledger-schema${T}" "$MANIFEST" && die "test setup: schema row still present"
expect_install_exit 2 AGENT_SYSTEM_LEDGER_DB="$S1_DB"
# duplicated: a second ledger-schema row
manifest_with "$DOC_ROW" "ledger/SCHEMA.md${T}ledger-schema${T}{ledger_db}"
[ "$(grep -cF "ledger-schema${T}" "$MANIFEST")" -eq 2 ] || die "test setup: duplicate did not apply"
expect_install_exit 2 AGENT_SYSTEM_LEDGER_DB="$S1_DB"
[ ! -e "$S1_DB" ] && [ ! -e "$(dirname "$S1_DB")" ] || die "a refused manifest still wrote $S1_DB"
cp -p "$WORK/manifest.orig" "$MANIFEST"
run_install >/dev/null || die "install with the manifest restored exited $?"
ok "swapped, missing and duplicated schema rows each refused with exit 2; nothing written; install passes again"

step "7d. a profile whose includeSkills differs from the manifest's skill rows fails install and writes no profile"
CONFIG="$CLONE/profile/config.yml"
cp -p "$CONFIG" "$WORK/config.orig"
S2_HOME="$WORK/s2-home-untouched"
# one allowlisted name removed
grep -v '^    - humanizer$' "$WORK/config.orig" >"$CONFIG"
grep -q '^    - humanizer$' "$CONFIG" && die "test setup: humanizer still allowlisted"
expect_install_exit 2 HOME="$S2_HOME"
# one name added that has no skill row
awk '{ print } /^    - humanizer$/ { print "    - not-a-manifest-skill" }' "$WORK/config.orig" >"$CONFIG"
grep -q 'not-a-manifest-skill' "$CONFIG" || die "test setup: extra name did not apply"
expect_install_exit 2 HOME="$S2_HOME"
[ ! -e "$S2_HOME" ] || die "a refused profile still wrote under $S2_HOME"
cp -p "$WORK/config.orig" "$CONFIG"
# a skill row whose SKILL.md has no description
DESC_SKILL="$CLONE/skills/ctx/SKILL.md"
cp -p "$DESC_SKILL" "$WORK/skill.orig"
awk 'BEGIN { fm = 0 } /^---$/ { fm++ } !(fm == 1 && /^description:/) { print }' "$WORK/skill.orig" >"$DESC_SKILL"
grep -q '^description:' "$DESC_SKILL" && die "test setup: description still present"
expect_install_exit 2 HOME="$S2_HOME"
[ ! -e "$S2_HOME" ] || die "a refused profile still wrote under $S2_HOME"
cp -p "$WORK/skill.orig" "$DESC_SKILL"
run_install >/dev/null || die "install with the config and skill restored exited $?"
ok "a missing name, an extra name and a description-less skill each refused with exit 2; nothing written; install passes again"

step "8. a ledger path in a synced folder fails install"
SYNCED="$FAKE_HOME/Library/CloudStorage/Dropbox/ledger.db"
mkdir -p "$(dirname "$SYNCED")"
set +e
run_install AGENT_SYSTEM_LEDGER_DB="$SYNCED"
status=$?
set -e
[ "$status" -eq 3 ] || die "install with a synced ledger path exited $status, expected 3"
[ ! -e "$SYNCED" ] || die "a ledger file was created in the synced folder"
ok "synced-folder path refused with exit 3; nothing created"

step "8b. a symlink into a synced folder fails install"
ln -s "$FAKE_HOME/Library/CloudStorage/Dropbox" "$FAKE_HOME/alias"
expect_install_exit 3 AGENT_SYSTEM_LEDGER_DB="$FAKE_HOME/alias/ledger.db"
[ ! -e "$SYNCED" ] || die "a ledger file was created in the synced folder through the alias"
ok "alias path refused with exit 3; nothing created behind it"

step "9. an older-schema ledger (version 1: 94f06b9, 71a576e; version 2: 477af98, c3fcf36; version 3: de28132, b3e06bb; version 4: bd8ef73, 1fe1b6e) fails install with exit 4 and is left unchanged"
for pair in 94f06b9:1 71a576e:1 477af98:2 c3fcf36:2 de28132:3 b3e06bb:3 bd8ef73:4 1fe1b6e:4; do
	rev="${pair%%:*}"
	ver="${pair##*:}"
	OLD_DB="$WORK/old-$rev/ledger.db"
	mkdir -p "$(dirname "$OLD_DB")"
	git -C "$CLONE" show "$rev:ledger/schema.sql" | "$SQLITE3" "$OLD_DB" >/dev/null
	"$SQLITE3" "$OLD_DB" "INSERT INTO workloads (id, brief, stakes, mode, created_by, created_at, changed_by, changed_at) VALUES ('wl-old', 'written under version $ver', 'normal', 'autonomous', 'old', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'old', strftime('%Y-%m-%dT%H:%M:%fZ','now'));"
	before="$("$SQLITE3" "$OLD_DB" 'PRAGMA user_version; SELECT count(*) FROM sqlite_master; SELECT group_concat(id) FROM workloads;')"
	set +e
	out="$(run_install AGENT_SYSTEM_LEDGER_DB="$OLD_DB" 2>&1)"
	status=$?
	set -e
	printf '%s\n' "$out" | sed 's/^/  | /'
	[ "$status" -eq 4 ] || die "install on the $rev schema exited $status, expected 4"
	printf '%s' "$out" | grep -qF "is schema version $ver, which predates the supported schema (version 5)" || die "refusal message missing for version $ver"
	[ "$("$SQLITE3" "$OLD_DB" 'PRAGMA user_version; SELECT count(*) FROM sqlite_master; SELECT group_concat(id) FROM workloads;')" = "$before" ] \
		|| die "the refused $rev ledger was changed"
	[ ! -e "$(dirname "$OLD_DB")/backups" ] || die "a backup was taken of the refused $rev ledger"
	ok "$rev schema: exit 4, version still $ver, rows and schema unchanged, no copy"
done

step "10. the periodic backup job: plist under the temp HOME lints; its exact command runs against an open writer"
if [ "$(uname -s)" != Darwin ]; then
	ok "not macOS: no plist is written (systemd timer not built yet); skipped"
else
	PLIST="$FAKE_HOME/Library/LaunchAgents/com.agent-system-2.ledger-backup.plist"
	[ -f "$PLIST" ] || die "no plist at $PLIST"
	/usr/bin/plutil -lint "$PLIST" || die "plist does not lint"
	/usr/bin/plutil -convert json -o "$WORK/job.json" "$PLIST"
	printf 'job: %s\n' "$(cat "$WORK/job.json")"
	[ "$(/usr/bin/plutil -extract EnvironmentVariables.AGENT_SYSTEM_LEDGER_DB raw -o - "$PLIST")" = "$LEDGER" ] \
		|| die "the plist does not point at $LEDGER (a refused install must not rewrite it)"
	ok "plist lints and names the installed ledger"
	# Run the job exactly as launchd would: its argv, only its environment, its working directory.
	run_job() {
		bun -e '
			const job = JSON.parse(await Bun.file(process.argv[1]).text());
			const p = Bun.spawnSync(job.ProgramArguments, { env: job.EnvironmentVariables, cwd: job.WorkingDirectory, stdout: "inherit", stderr: "inherit" });
			process.exit(p.exitCode ?? 1);
		' "$WORK/job.json"
	}
	COPY_DIR="$(dirname "$(find "$FAKE_HOME/.agent-system-2/backups" -name 'ledger-*.db' -type f | LC_ALL=C sort | tail -n 1)")"
	for f in "$COPY_DIR"/ledger-*.db; do mv "$f" "$COPY_DIR/ledger-2026-01-01T00-00-00.000Z.db"; break; done
	find "$COPY_DIR" -name 'ledger-*.db' ! -name 'ledger-2026-01-01T00-00-00.000Z.db' -delete
	ok "copies in $COPY_DIR reduced to one aged copy, so the job's copy is due"
	# A writer holds the ledger open (connection open) until it gets SIGTERM, then closes it and
	# exits 0. (A first version read stdin from a FIFO; at EOF bun kept running instead of returning.)
	bun -e "
		import { Ledger } from '$CLONE/ledger/src/index.ts';
		const l = Ledger.open('$LEDGER', { backupOnOpen: false });
		l.openWorkload({ brief: 'written by the open writer', stakes: 'normal', mode: 'autonomous', by: 'writer', id: 'wl-writer' });
		const keep = setInterval(() => {}, 1 << 30);
		console.log('ready');
		await new Promise((resolve) => process.on('SIGTERM', resolve));
		clearInterval(keep);
		l.close();
		process.exit(0);
	" </dev/null >"$WORK/writer.out" 2>&1 &
	WRITER=$!
	trap 'kill "$WRITER" 2>/dev/null || true' EXIT
	for _ in $(seq 1 100); do grep -q ready "$WORK/writer.out" && break; sleep 0.1; done
	grep -q ready "$WORK/writer.out" || die "the writer never became ready: $(cat "$WORK/writer.out")"
	ok "writer $WRITER holds $LEDGER open"
	set +e
	out="$(run_job 2>&1)"
	status=$?
	set -e
	printf 'job -> exit %s: %s\n' "$status" "$out"
	[ "$status" -eq 0 ] || die "the backup job exited $status against an open writer"
	# The job prints the copy on its first line, then the off-disk line.
	TAKEN="$(printf '%s\n' "$out" | sed -n '1s/^backup ok: took //p')"
	[ -n "$TAKEN" ] && [ -f "$TAKEN" ] || die "the backup job did not take a copy"
	[ "$("$SQLITE3" "$TAKEN" "SELECT brief FROM workloads WHERE id = 'wl-writer';")" = "written by the open writer" ] \
		|| die "the copy does not hold the open writer's row"
	ok "the job took $TAKEN while the writer was open; it holds the writer's row"
	rm "$TAKEN"
	chmod 555 "$COPY_DIR"
	set +e
	out="$(run_job 2>&1)"
	status=$?
	set -e
	chmod 755 "$COPY_DIR"
	printf 'job with an unwritable backup directory -> exit %s: %s\n' "$status" "$out"
	[ "$status" -ne 0 ] || die "the backup job exited 0 although the due copy could not be written"
	ok "unwritable backup directory with an older copy present: the job exits $status"
	kill -TERM "$WRITER"
	wait "$WRITER" || die "the writer exited $?"
	trap - EXIT
	ok "writer closed its connection and exited 0"
fi

step "11. a ledger whose snapshot fails: the job exits nonzero twice and leaves no file that counts as a copy"
BAD="$WORK/malformed/ledger.db"
env -i PATH="$PATH" HOME="$FAKE_HOME" bun run "$CLONE/ledger/scripts/init.ts" "$BAD" >/dev/null || die "init of $BAD exited $?"
# Zero the first byte of the workloads table's root page (the M2 third review's reproduction).
bun -e "
	import { Database } from 'bun:sqlite';
	import { readFileSync, writeFileSync } from 'node:fs';
	const db = new Database('$BAD');
	const page = db.query(\"SELECT rootpage FROM sqlite_master WHERE name = 'workloads'\").get().rootpage;
	const size = db.query('PRAGMA page_size').get().page_size;
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	db.close();
	const bytes = readFileSync('$BAD');
	bytes[(page - 1) * size] = 0;
	writeFileSync('$BAD', bytes);
" || die "could not damage $BAD"
for attempt in 1 2; do
	set +e
	out="$(env -i PATH="$PATH" HOME="$FAKE_HOME" bun run "$CLONE/ledger/scripts/backup.ts" "$BAD" 2>&1)"
	status=$?
	set -e
	printf 'job run %s against the malformed ledger -> exit %s: %s\n' "$attempt" "$status" "$out"
	[ "$status" -ne 0 ] || die "the backup job exited 0 although no copy could be taken (run $attempt)"
done
left="$(cd "$WORK/malformed/backups" && find . -type f ! -name SOURCE | LC_ALL=C sort)"
[ -z "$left" ] || die "a failed snapshot left files in the backup directory: $left"
ok "the job exited nonzero on both runs; the backup directory holds only its SOURCE file"

step "12. a HOME and a ledger path holding @REPO@ and & are written into the plist exactly as given"
if [ "$(uname -s)" != Darwin ]; then
	ok "not macOS: no plist is written; skipped"
else
	ODD_HOME="$WORK/home-@REPO@ & co"
	ODD_DB="$WORK/db-@REPO@ & co/@REPO@&.db"
	mkdir -p "$ODD_HOME"
	env -i PATH="$PATH" HOME="$ODD_HOME" AGENT_SYSTEM_LEDGER_DB="$ODD_DB" bash "$CLONE/install/install.sh" >/dev/null \
		|| die "install with HOME=$ODD_HOME and ledger $ODD_DB exited $?"
	ODD_PLIST="$ODD_HOME/Library/LaunchAgents/com.agent-system-2.ledger-backup.plist"
	/usr/bin/plutil -lint "$ODD_PLIST" || die "the plist does not lint"
	got_db="$(/usr/bin/plutil -extract EnvironmentVariables.AGENT_SYSTEM_LEDGER_DB raw -o - "$ODD_PLIST")"
	got_home="$(/usr/bin/plutil -extract EnvironmentVariables.HOME raw -o - "$ODD_PLIST")"
	printf 'plist ledger: %s\nplist HOME: %s\n' "$got_db" "$got_home"
	[ "$got_db" = "$ODD_DB" ] && [ "$got_home" = "$ODD_HOME" ] || die "the plist rewrote the ledger path or HOME"
	/usr/bin/plutil -convert json -o "$WORK/odd-job.json" "$ODD_PLIST"
	set +e
	out="$(bun -e '
		const job = JSON.parse(await Bun.file(process.argv[1]).text());
		const p = Bun.spawnSync(job.ProgramArguments, { env: job.EnvironmentVariables, cwd: job.WorkingDirectory, stdout: "inherit", stderr: "inherit" });
		process.exit(p.exitCode ?? 1);
	' "$WORK/odd-job.json" 2>&1)"
	status=$?
	set -e
	printf 'job -> exit %s: %s\n' "$status" "$out"
	[ "$status" -eq 0 ] || die "the job written for $ODD_DB exited $status"
	ok "plist lints, names $ODD_DB and $ODD_HOME, and its job exits 0"
fi

step "13. the nightly chaos job: --chaos-nightly writes and loads it, =off boots it out and deletes it, no flag writes none"
if [ "$(uname -s)" != Darwin ]; then
	ok "not macOS: --chaos-nightly is refused there (no launchd); skipped"
else
	CHAOS_PLIST="$FAKE_HOME/Library/LaunchAgents/com.agent-system-2.chaos.plist"
	CHAOS_LABEL="gui/$(id -u)/com.agent-system-2.chaos"
	CHAOS_LOG="$FAKE_HOME/agent-scratch/agent-system-2.0/chaos/launchd.log"
	# A fake launchctl first on PATH: it appends its argv (one line per call) to a log, and keeps a
	# flag file so `print` answers as launchd does for this label (0 loaded, 113 not loaded).
	FAKE_BIN="$WORK/fake-launchctl-bin"
	LAUNCHCTL_LOG="$WORK/launchctl.log"
	LOADED="$WORK/launchctl.loaded"
	mkdir -p "$FAKE_BIN"
	{
		printf '#!/bin/bash\n'
		printf 'printf "%%s\\n" "$*" >>%q\n' "$LAUNCHCTL_LOG"
		printf 'case "$1" in\n'
		printf '\tprint) [ -e %q ] || { echo "Could not find service" >&2; exit 113; } ;;\n' "$LOADED"
		printf '\tbootstrap) touch %q ;;\n' "$LOADED"
		printf '\tbootout) rm -f %q ;;\n' "$LOADED"
		printf 'esac\n'
	} >"$FAKE_BIN/launchctl"
	chmod 755 "$FAKE_BIN/launchctl"
	chaos_install() { env -i PATH="$FAKE_BIN:$PATH" HOME="$FAKE_HOME" bash "$CLONE/install/install.sh" "$@"; }
	launchctl_calls() { if [ -e "$LAUNCHCTL_LOG" ]; then cat "$LAUNCHCTL_LOG"; fi; }

	[ ! -e "$CHAOS_PLIST" ] || die "the no-flag installs above wrote $CHAOS_PLIST"
	chaos_install >/dev/null || die "no-flag install with the fake launchctl on PATH exited $?"
	[ ! -e "$CHAOS_PLIST" ] || die "a no-flag install wrote $CHAOS_PLIST"
	[ -z "$(launchctl_calls)" ] || die "a no-flag install ran launchctl: $(launchctl_calls)"
	ok "no flag: no chaos plist under $FAKE_HOME/Library/LaunchAgents and no launchctl call"

	chaos_install --chaos-nightly || die "install --chaos-nightly exited $?"
	[ -f "$CHAOS_PLIST" ] || die "install --chaos-nightly wrote no plist at $CHAOS_PLIST"
	/usr/bin/plutil -lint "$CHAOS_PLIST" || die "the chaos plist does not lint"
	/usr/bin/plutil -convert json -o "$WORK/chaos-job.json" "$CHAOS_PLIST"
	printf 'chaos job: %s\n' "$(cat "$WORK/chaos-job.json")"
	# The PATH install resolves from the PATH it ran with (the fake bin dir holds only launchctl): the
	# bun, omp and git directories, then the system ones, each once.
	WANT_PATH=""
	for d in $(for t in bun omp git; do dirname "$(type -P "$t")"; done) /usr/bin /bin /usr/sbin /sbin; do
		case ":$WANT_PATH:" in *":$d:"*) ;; *) WANT_PATH="${WANT_PATH:+$WANT_PATH:}$d" ;; esac
	done
	bun -e '
		const [file, bun, repo, home, path, log] = process.argv.slice(1);
		const job = JSON.parse(await Bun.file(file).text());
		const want = {
			Label: "com.agent-system-2.chaos",
			ProgramArguments: [bun, `${repo}/surface/scripts/chaos.ts`, "--nightly"],
			EnvironmentVariables: { HOME: home, PATH: path },
			WorkingDirectory: repo,
			StartCalendarInterval: [{ Minute: 0 }, { Minute: 15 }, { Minute: 30 }, { Minute: 45 }],
			ProcessType: "Background",
			StandardOutPath: log,
			StandardErrorPath: log,
		};
		// The JSON from plutil does not keep the key order of the plist, so both sides are compared with sorted keys.
		const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
		if (JSON.stringify(canon(job)) !== JSON.stringify(canon(want))) { console.error(`chaos job differs; want ${JSON.stringify(want)}`); process.exit(1); }
		const paths = [...job.ProgramArguments.slice(0, 2), job.WorkingDirectory, job.StandardOutPath, job.EnvironmentVariables.HOME, ...job.EnvironmentVariables.PATH.split(":")];
		const relative = paths.filter((p) => !p.startsWith("/"));
		if (relative.length) { console.error(`not absolute: ${relative}`); process.exit(1); }
	' "$WORK/chaos-job.json" "$(type -P bun)" "$CLONE" "$FAKE_HOME" "$WANT_PATH" "$CHAOS_LOG" \
		|| die "the chaos plist is not the expected job"
	[ -d "$(dirname "$CHAOS_LOG")" ] || die "install did not create the log directory $(dirname "$CHAOS_LOG")"
	CALLS_WANT="$(printf '%s\n' "print $CHAOS_LABEL" "bootstrap gui/$(id -u) $CHAOS_PLIST")"
	[ "$(launchctl_calls)" = "$CALLS_WANT" ] || die "launchctl calls were '$(launchctl_calls)', expected '$CALLS_WANT'"
	ok "plist lints; four StartCalendarInterval entries (Minute 0, 15, 30, 45); absolute bun, chaos.ts, WorkingDirectory, HOME, PATH=$WANT_PATH and log; no ledger variable; bootstrapped into gui/$(id -u)"

	rm -f "$LAUNCHCTL_LOG"
	chaos_install --chaos-nightly >/dev/null || die "re-run of install --chaos-nightly exited $?"
	CALLS_WANT="$(printf '%s\n' "print $CHAOS_LABEL" "bootout $CHAOS_LABEL" "bootstrap gui/$(id -u) $CHAOS_PLIST")"
	[ "$(launchctl_calls)" = "$CALLS_WANT" ] || die "re-run launchctl calls were '$(launchctl_calls)', expected '$CALLS_WANT'"
	ok "a re-run boots the loaded job out before bootstrapping the rewritten plist"

	rm -f "$LAUNCHCTL_LOG"
	chaos_install --chaos-nightly=off || die "install --chaos-nightly=off exited $?"
	[ ! -e "$CHAOS_PLIST" ] || die "--chaos-nightly=off left $CHAOS_PLIST"
	CALLS_WANT="$(printf '%s\n' "print $CHAOS_LABEL" "bootout $CHAOS_LABEL")"
	[ "$(launchctl_calls)" = "$CALLS_WANT" ] || die "=off launchctl calls were '$(launchctl_calls)', expected '$CALLS_WANT'"
	rm -f "$LAUNCHCTL_LOG"
	chaos_install --chaos-nightly=off >/dev/null || die "a second --chaos-nightly=off exited $?"
	[ "$(launchctl_calls)" = "print $CHAOS_LABEL" ] || die "=off with nothing loaded ran '$(launchctl_calls)', expected only the print"
	ok "=off booted the job out of $CHAOS_LABEL and deleted the plist; with nothing loaded it only asks"

	# omp not on PATH: a PATH holding bun and the system directories only.
	NO_OMP_BIN="$WORK/no-omp-bin"
	mkdir -p "$NO_OMP_BIN"
	ln -sf "$(type -P bun)" "$NO_OMP_BIN/bun"
	NO_OMP_PATH="$FAKE_BIN:$NO_OMP_BIN:/usr/bin:/bin:/usr/sbin:/sbin"
	(PATH="$NO_OMP_PATH"; type -P omp >/dev/null) && die "test setup: omp is still on $NO_OMP_PATH"
	REFUSED_HOME="$WORK/chaos-refused-home"
	mkdir -p "$REFUSED_HOME"
	rm -f "$LAUNCHCTL_LOG"
	for args in --chaos-nightly --chaos-nightly=on; do
		set +e
		if [ "$args" = --chaos-nightly ]; then
			out="$(env -i PATH="$NO_OMP_PATH" HOME="$REFUSED_HOME" bash "$CLONE/install/install.sh" "$args" 2>&1)"
		else
			out="$(env -i PATH="$FAKE_BIN:$PATH" HOME="$REFUSED_HOME" bash "$CLONE/install/install.sh" "$args" 2>&1)"
		fi
		status=$?
		set -e
		printf '%s -> exit %s: %s\n' "$args" "$status" "$out"
		[ "$status" -eq 2 ] || die "install $args exited $status, expected 2"
	done
	[ -z "$(find "$REFUSED_HOME" -mindepth 1)" ] || die "a refused flag still wrote under $REFUSED_HOME: $(find "$REFUSED_HOME" -mindepth 1)"
	[ -z "$(launchctl_calls)" ] || die "a refused flag ran launchctl: $(launchctl_calls)"
	ok "--chaos-nightly without omp on PATH and an unknown argument are each refused with exit 2; nothing written, no launchctl call"
fi

step "all checks passed"
printf 'work dir kept as evidence: %s\n' "$WORK"
