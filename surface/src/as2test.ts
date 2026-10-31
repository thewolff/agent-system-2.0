// The `_as2test` user's side of the outside-the-fence test runner (MIGRATION.md item 24; the approved
// plan of workload wl-muraerdsgw7gn4, revision 12, § 2.3 step 3 and § 3.1).
//
// What lives here:
// - `renderExecWrapper`: the root-owned sh wrapper `/usr/local/libexec/as2test/exec`, the one
//   command the sudoers line allows. The root, the bun path, the script path, the child env and the
//   sweep's reach are fixed in its text; argv picks only the subcommand and its operands, and the
//   wrapper checks their shape and arity before it execs `surface/scripts/test-exec.ts` (installed
//   as a single-file bundle) under `env -i`;
// - `execArgv`, the sudo argv the runner spawns (test-run.ts `wrapperArgv`, with the exec path a
//   test may move), and the exit-code names;
// - the preflight (§ 3.1): the paths `probe` opens as `_as2test` and the decision over its answers,
//   the install facts (SOURCE, the account, owners, modes, hashes) and the decision over them;
// - `parseSource`, the SOURCE file the refresh helper writes (install/as2test-setup.sh wrote it before);
// - `renderRefreshHelper`: the root-owned sh helper `/usr/local/libexec/as2test/refresh` (workload
//   wl-mv718fxhwwcn40, PLAN revision 6, § 1.1). It takes no arguments, fetches the `as2-verified` tag
//   (AS2_VERIFIED_TAG, PLAN wl-mvq4edbaf13vnk § 2 "The bundle") from the fixed AS2TEST_ORIGIN into a
//   root-owned mirror, builds test-exec at the tag's commit as an unprivileged build user, and installs
//   `exec`, `test-exec.js` and `SOURCE`; the runner calls it through `sudo -n` when `installDecision`
//   reports drift (§ 1.2);
// - a small CLI the setup script and the helper call: `render-exec`, `render-refresh` and `bundle-inputs`.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defaultLedgerPath } from "../../ledger/src/locality";
import { STUCK_DEFAULTS } from "./stuck-detect";
import { parseInstalledOmp, parseResourceCosts, readInstalledOmp, runtimeTreeHash, verifyTrustedPath } from "./test-resources";
import { AS2TEST_EXEC, AS2TEST_ROOT, AS2TEST_USER, WRAPPER_EXIT, type WrapperCall, runsDbOf, wrapperArgv } from "./test-run";

// ---- the wrapper ---------------------------------------------------------------------------------

/** The installed wrapper's directory: `exec`, `bun`, `test-exec.js`, `refresh`, `SOURCE` and `refresh.d/`. */
export const AS2TEST_LIBEXEC = dirname(AS2TEST_EXEC);
/** The sudoers drop-in setup writes (§ 3.1 step 4). */
export const AS2TEST_SUDOERS = "/etc/sudoers.d/as2test";
/** The installed files under AS2TEST_LIBEXEC whose sha-256 SOURCE records. */
export const INSTALLED_FILES = ["exec", "bun", "test-exec.js", "refresh"] as const;
export type InstalledFile = (typeof INSTALLED_FILES)[number];
/** The installed files the refresh helper rebuilds from the `as2-verified` tag's commit; only setup writes the others. */
export const REBUILT_FILES = ["exec", "test-exec.js"] as const satisfies readonly InstalledFile[];
/** The PATH the wrapper and test-exec run with; the child's PATH puts its shim dir in front. */
export const WRAPPER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** The real git test-exec runs and the child's shim execs. */
export const REAL_GIT = "/usr/bin/git";
/** The installed wrapper's sweep: every process of `_as2test` but the sweeper and its ancestors (pkill's default exclusion). */
export const UID_SWEEP = `/usr/bin/pkill -U ${AS2TEST_USER}`;
/** The sweep's SIGTERM → SIGKILL grace and its wait for `locks/sweep.db` (§ 2.3 steps 1 and 3). */
export const KILL_GRACE_MS = 10_000;
export const SWEEP_LOCK_WAIT_MS = 60_000;
/** The stuck capture's one deadline at a part's cap, before its group is killed (PLAN wl-mvq4edh02r5z40 D5). */
export const CAPTURE_MS = 20_000;

export type SweepScope = "uid" | "groups";

export interface ExecWrapperOptions {
	/** The as2test root: `stage/`, `runs/`, `locks/sweep.db` beneath it. */
	root: string;
	/** The bun binary test-exec and the tests run on. */
	bun: string;
	/** test-exec: the installed bundle, or surface/scripts/test-exec.ts in a test. */
	script: string;
	/** Trusted, fixed calibration/runtime config paths; never selected by staged proof caps. */
	resourcesPath?: string;
	ompRuntimePath?: string;
	/** `uid` for the installed wrapper; `groups` for a wrapper a test renders (§ 2.3 step 3). */
	sweepScope: SweepScope;
	/** Test-only, `groups` renders only: the pause-hook directory (`<dir>/<run>.<point>.pause|reached|go`). */
	hooks?: string;
	/** Test-only, `groups` renders only: the SIGTERM → SIGKILL grace (default 10 s). */
	killGraceMs?: number;
	/** Test-only, `groups` renders only: the most a sweep waits for `locks/sweep.db` (default 60 s). */
	sweepLockWaitMs?: number;
	/** Test-only, `groups` renders only: the stuck capture's deadline at a part's cap (default 20 s). */
	captureMs?: number;
	/** Test-only, `groups` renders only: the stuck-worker detector's tick (PLAN wl-mvq8x4pkjmx69s D2; default 1 s). */
	detectTickMs?: number;
	/** Test-only, `groups` renders only: how long a signature must hold to match (D2; default 5 s). */
	detectPersistMs?: number;
	/** Test-only, `groups` renders only: the signature capture's deadline on a match (D3; default 3 s). */
	signatureCaptureMs?: number;
	/** Test-only, `groups` renders only: the enforce stop's SIGTERM → SIGKILL grace (D3; default 1.5 s). */
	stopGraceMs?: number;
	/** Test-only, `groups` renders only: append each detector tick's observation to `<work>/<part>.stuck-trace.jsonl` (D3). */
	detectTrace?: boolean;
}

/** What the wrapper hands test-exec in `AS2TEST_EXEC_CONFIG`; test-exec validates it again. */
export interface ExecConfig {
	root: string;
	bun: string;
	resourcesPath: string;
	ompRuntimePath: string;
	/** `groups`, or exactly UID_SWEEP. */
	sweep: string;
	hooks: string | null;
	killGraceMs: number;
	sweepLockWaitMs: number;
	captureMs: number;
	detectTickMs: number;
	detectPersistMs: number;
	signatureCaptureMs: number;
	stopGraceMs: number;
	detectTrace: boolean;
}

export class WrapperRenderError extends Error {}

const plainAbs = (p: string): boolean => isAbsolute(p) && resolve(p) === p && !/[\n\0]/.test(p);
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The config a render fixes; throws WrapperRenderError on a value the wrapper must not carry. */
export function execConfigOf(o: ExecWrapperOptions): ExecConfig {
	for (const [k, v] of [["root", o.root], ["bun", o.bun], ["script", o.script]] as const) {
		if (typeof v !== "string" || !plainAbs(v)) throw new WrapperRenderError(`${k} must be a normalized absolute path: ${String(v)}`);
	}
	for (const [k, v] of [["resourcesPath", o.resourcesPath], ["ompRuntimePath", o.ompRuntimePath]] as const) {
		if (v !== undefined && !plainAbs(v)) throw new WrapperRenderError(`${k} must be a normalized absolute path`);
	}
	if (o.sweepScope !== "uid" && o.sweepScope !== "groups") throw new WrapperRenderError(`sweepScope must be uid or groups: ${String(o.sweepScope)}`);
	const testOnly = o.hooks !== undefined || o.killGraceMs !== undefined || o.sweepLockWaitMs !== undefined || o.captureMs !== undefined
		|| o.detectTickMs !== undefined || o.detectPersistMs !== undefined || o.signatureCaptureMs !== undefined || o.stopGraceMs !== undefined || o.detectTrace !== undefined;
	if (testOnly && o.sweepScope !== "groups") {
		throw new WrapperRenderError("hooks, killGraceMs, sweepLockWaitMs, captureMs, detectTickMs, detectPersistMs, signatureCaptureMs, stopGraceMs and detectTrace are test-only: a uid render carries none");
	}
	if (o.hooks !== undefined && !plainAbs(o.hooks)) throw new WrapperRenderError(`hooks must be a normalized absolute path: ${o.hooks}`);
	if (o.detectTrace !== undefined && typeof o.detectTrace !== "boolean") throw new WrapperRenderError("detectTrace must be a boolean");
	const ms = (v: number | undefined, d: number, k: string): number => {
		if (v === undefined) return d;
		if (!Number.isSafeInteger(v) || v < 0) throw new WrapperRenderError(`${k} must be a whole number of ms`);
		return v;
	};
	const detectTickMs = ms(o.detectTickMs, STUCK_DEFAULTS.tickMs, "detectTickMs");
	if (detectTickMs < 1) throw new WrapperRenderError("detectTickMs must be 1 ms or more");
	return {
		root: o.root, bun: o.bun, sweep: o.sweepScope === "uid" ? UID_SWEEP : "groups", hooks: o.hooks ?? null,
		resourcesPath: o.resourcesPath ?? join(dirname(o.bun), "resources.json"), ompRuntimePath: o.ompRuntimePath ?? join(dirname(o.bun), "installed-omp.json"),
		killGraceMs: ms(o.killGraceMs, KILL_GRACE_MS, "killGraceMs"), sweepLockWaitMs: ms(o.sweepLockWaitMs, SWEEP_LOCK_WAIT_MS, "sweepLockWaitMs"),
		captureMs: ms(o.captureMs, CAPTURE_MS, "captureMs"),
		detectTickMs, detectPersistMs: ms(o.detectPersistMs, STUCK_DEFAULTS.persistMs, "detectPersistMs"),
		signatureCaptureMs: ms(o.signatureCaptureMs, STUCK_DEFAULTS.signatureCaptureMs, "signatureCaptureMs"),
		stopGraceMs: ms(o.stopGraceMs, STUCK_DEFAULTS.stopGraceMs, "stopGraceMs"), detectTrace: o.detectTrace ?? false,
	};
}

/**
 * The wrapper's check of one test operand (`solo`'s and each of `fast`'s), the body of its sh function `check_test`: `./<plain
 * relative path>` whose basename is a Bun test file name, so no operand reaches bun as an option or a path outside the clone.
 */
const TEST_OPERAND_SH = [
	'case "$1" in ./*) ;; *) refuse "test must be ./<relative path>" ;; esac;',
	'_rel=${1#./}; case "/$_rel/" in *//*|*"/../"*|*"/./"*) refuse "test is not a plain relative path" ;; esac;',
	'case "${_rel##*/}" in *[._]test.ts|*[._]test.tsx|*[._]test.js|*[._]test.jsx|*[._]test.mjs|*[._]test.cjs|*[._]test.mts|*[._]test.cts|*[._]spec.ts|*[._]spec.tsx|*[._]spec.js|*[._]spec.jsx|*[._]spec.mjs|*[._]spec.cjs|*[._]spec.mts|*[._]spec.cts) ;; *) refuse "not a Bun test file name" ;; esac;',
].join(" ");

/**
 * The `exec` wrapper's sh text (§ 2.3 step 3). It checks the run id against `^tr-[a-z0-9]+$`, the
 * subcommand and its exact arity, then replaces itself with test-exec under `env -i` and a fixed
 * env: PATH, LANG, TERM, SHELL, USER and LOGNAME (from `id -un`, not the caller), the config, and
 * an existing private `runs/<id>/.wrapper-tmp` TMPDIR before Bun starts. Bootstrap validates argv,
 * fences on `<root>/stage/current`, and rejects symlinked areas/run/temp paths before creating anything.
 * `fast` (PLAN wl-mvq4edbaf13vnk D4) takes one or more test operands, each checked as `solo`'s one is.
 */
export function renderExecWrapper(o: ExecWrapperOptions): string {
	const config = execConfigOf(o);
	const alnum = "abcdefghijklmnopqrstuvwxyz0123456789";
	return [
		"#!/bin/sh",
		"# agent-system 2.0 test runner: the _as2test wrapper (MIGRATION.md item 24), rendered by",
		"# surface/src/as2test.ts renderExecWrapper. Root, bun, script, env and the sweep's reach are fixed",
		"# here; argv chooses only the subcommand and its operands. Exit 64 is a refusal.",
		`# sweep: ${config.sweep === "groups" ? "groups (a test render: only the process groups this wrapper started)" : config.sweep}`,
		"PATH=" + WRAPPER_PATH,
		"export PATH",
		"umask 022",
		`refuse() { printf 'as2test: refused: %s\\n' "$1" >&2; exit ${WRAPPER_EXIT.refused}; }`,
		'[ "$#" -ge 2 ] || refuse "usage: exec <subcommand> <run id> [operand...]"',
		`case "$2" in tr-|tr-*[!${alnum}]*) refuse "run id must match ^tr-[a-z0-9]+\\$" ;; tr-*) ;; *) refuse "run id must match ^tr-[a-z0-9]+\\$" ;; esac`,
		'case "$1" in',
		'\tfull|sweep) [ "$#" -eq 2 ] || refuse "$1 takes exactly <run id>" ;;',
		'\tprepare|solo|base-prepare|base-solo|cleanup) [ "$#" -eq 3 ] || refuse "$1 takes exactly <run id> and one operand" ;;',
		'\tprobe) [ "$#" -ge 3 ] || refuse "probe takes <run id> and one or more paths" ;;',
		'\tfast) [ "$#" -ge 3 ] || refuse "fast takes <run id> and one or more ./<test file>" ;;',
		'\t*) refuse "unknown subcommand" ;;',
		"esac",
		// Reject malformed operands before bootstrap has any filesystem side effect.
		`check_test() { ${TEST_OPERAND_SH} }`,
		'case "$1" in',
		'\tprepare|base-prepare) [ "${#3}" -eq 40 ] || refuse "not a full sha"; case "$3" in *[!0123456789abcdef]*) refuse "not a full sha" ;; esac ;;',
		`\tcleanup) case "$3" in tr-|tr-*[!${alnum}]*) refuse "old run id is malformed" ;; tr-*) ;; *) refuse "old run id is malformed" ;; esac; [ "$3" != "$2" ] || refuse "cleanup never deletes its own run" ;;`,
		'\tsolo|base-solo) check_test "$3" ;;',
		'\tfast) n=0; for t do n=$((n + 1)); [ "$n" -gt 2 ] || continue; check_test "$t"; done ;;',
		'\tprobe) n=0; for p do n=$((n + 1)); [ "$n" -gt 2 ] || continue; case "$p" in /*) ;; *) refuse "probe takes absolute paths" ;; esac; done ;;',
		"esac",
		// Resolve only the fixed root. Everything below it must be a plain, physical directory.
		`root=$(CDPATH= cd -P ${shq(config.root)} && pwd -P) || refuse "root is missing"`,
		'plain_dir() { [ -d "$1" ] && [ ! -L "$1" ] && [ "$(CDPATH= cd -P "$1" && pwd -P)" = "$1" ]; }',
		'for area in stage runs locks; do plain_dir "$root/$area" || refuse "$root/$area is not a plain directory"; done',
		'current=$(/bin/cat "$root/stage/current" 2>/dev/null) || current=',
		// Match test-exec's trim(), including current files published with trailing newlines.
		'current=${current#"${current%%[![:space:]]*}"}; current=${current%"${current##*[![:space:]]}"}',
		`[ "$current" = "$2" ] || { printf 'as2test: fenced: current does not name %s\\n' "$2" >&2; exit ${WRAPPER_EXIT.fenced}; }`,
		'case "$1" in prepare|base-prepare)',
		'\tstage_run="$root/stage/$2"; bundle="$stage_run/repo.bundle"',
		`\t[ -e "$bundle" ] || { printf 'as2test: failed: bundle is missing\\n' >&2; exit ${WRAPPER_EXIT.failed}; }`,
		'\tplain_dir "$stage_run" && [ -f "$bundle" ] && [ ! -L "$bundle" ] || refuse "bundle is not a plain staged file" ;;',
		'esac',
		'work="$root/runs/$2"',
		'tmp="$work/.wrapper-tmp"',
		'if [ "$1" = cleanup ]; then',
		'\told="$root/runs/$3"',
		'\tif [ -e "$old" ] || [ -L "$old" ]; then plain_dir "$old" || refuse "$old is not a real directory"; fi',
		'fi',
		'if [ -e "$work" ] || [ -L "$work" ]; then',
		'\tplain_dir "$work" && [ -O "$work" ] || refuse "$work is not an owned plain directory"',
		'\tif [ "$1" = prepare ]; then',
		'\t\tplain_dir "$tmp" || refuse "$work already exists"',
		'\t\tfor p in "$work"/* "$work"/.[!.]* "$work"/..?*; do',
		'\t\t\t[ -e "$p" ] || [ -L "$p" ] || continue',
		'\t\t\t[ "$p" = "$tmp" ] || refuse "$work already exists"',
		'\t\tdone',
		'\tfi',
		'else',
		'\tcase "$1" in full|solo|base-prepare|base-solo|fast) refuse "$work does not exist (prepare first)" ;; esac',
		'\t(umask 077; /bin/mkdir "$work") || refuse "cannot create $work"',
		'fi',
		'if [ -e "$tmp" ] || [ -L "$tmp" ]; then',
		'\tplain_dir "$tmp" && [ -O "$tmp" ] && [ "$(/usr/bin/find "$tmp" -prune -type d -perm 0700)" = "$tmp" ] || refuse "$tmp is not an owned private plain directory"',
		'else',
		'\t(umask 077; /bin/mkdir "$tmp") || refuse "cannot create $tmp"',
		'fi',
		"me=$(/usr/bin/id -un) || refuse \"no user name\"",
		`exec /usr/bin/env -i PATH=${WRAPPER_PATH} LANG=en_US.UTF-8 TERM=dumb SHELL=/bin/sh USER="$me" LOGNAME="$me" TMPDIR="$tmp" \\`,
		`\tAS2TEST_EXEC_CONFIG=${shq(JSON.stringify(config))} \\`,
		`\t${shq(o.bun)} ${shq(o.script)} "$@"`,
		"",
	].join("\n");
}

/** The argv the runner spawns: `sudo -n -u _as2test <exec> <subcommand> <run id> …` (test-run.ts `wrapperArgv`). */
export function execArgv(call: WrapperCall, exec: string = AS2TEST_EXEC): string[] {
	return wrapperArgv(call, exec);
}

/** The name of a wrapper exit code, or null for any other code (for `full` and `solo`, bun's own exit). */
export function wrapperExitName(code: number | null): keyof typeof WRAPPER_EXIT | null {
	for (const [k, v] of Object.entries(WRAPPER_EXIT) as [keyof typeof WRAPPER_EXIT, number][]) if (v === code) return k;
	return null;
}

/** The caps file the runner writes before `full` and `solo`: `<root>/stage/<run id>/caps.json`. */
export function capsPathOf(runId: string, root: string = AS2TEST_ROOT): string {
	return join(root, "stage", runId, "caps.json");
}

// ---- the preflight's probes (§ 3 table, § 3.1) ----------------------------------------------------

/** Jo's credential paths, relative to HOME: `probe` must not open any of them as `_as2test` (§ 3, Home directory). */
export const CREDENTIAL_PATHS = [
	".ssh", ".config/gh", ".agent-system-2", ".omp", "Library/Keychains", ".netrc", ".aws", ".codex/auth.json", ".git-credentials",
	".config/git/credentials", ".gnupg", ".docker/config.json", ".kube/config", ".npmrc",
] as const;

/** `any`: `_as2test` must neither open nor write the path; `write`: it must not write it (reading is allowed). */
export type ProbeForbid = "any" | "write";
export interface ProbeItem {
	path: string;
	forbid: ProbeForbid;
	why: string;
}

/**
 * The paths the preflight probes as `_as2test`, for the paths the runner itself resolved: every
 * credential path under HOME; the ledger (`AGENT_SYSTEM_LEDGER_DB` or the default), its directory,
 * `-wal` and `-shm`; the runs root and its `runs.db`; `<stage>/current` (readable by design, never
 * writable); HOME, the main checkout and the lanes root (never writable). A path listed twice keeps
 * the stricter rule.
 */
export function preflightProbes(o: {
	env: Record<string, string | undefined>;
	runsRoot: string;
	mainCheckout: string;
	lanesRoot: string;
	root?: string;
}): ProbeItem[] {
	const home = o.env.HOME;
	if (!home || !isAbsolute(home)) throw new Error("preflightProbes needs an absolute HOME");
	const ledger = defaultLedgerPath(o.env);
	const items: ProbeItem[] = [
		...CREDENTIAL_PATHS.map((p) => ({ path: join(home, p), forbid: "any" as const, why: "credential" })),
		{ path: ledger, forbid: "any", why: "ledger" },
		{ path: dirname(ledger), forbid: "any", why: "ledger directory" },
		{ path: `${ledger}-wal`, forbid: "any", why: "ledger wal" },
		{ path: `${ledger}-shm`, forbid: "any", why: "ledger shm" },
		{ path: resolve(o.runsRoot), forbid: "any", why: "runs root" },
		{ path: runsDbOf(resolve(o.runsRoot)), forbid: "any", why: "runs lock" },
		{ path: join(o.root ?? AS2TEST_ROOT, "stage", "current"), forbid: "write", why: "current" },
		{ path: resolve(home), forbid: "write", why: "home" },
		{ path: resolve(o.mainCheckout), forbid: "write", why: "main checkout" },
		{ path: resolve(o.lanesRoot), forbid: "write", why: "lanes root" },
	];
	const out = new Map<string, ProbeItem>();
	for (const it of items) {
		const had = out.get(it.path);
		if (!had || (had.forbid === "write" && it.forbid === "any")) out.set(it.path, it);
	}
	return [...out.values()];
}

/** The probe call for these items (paths in order). */
export function probeCall(runId: string, items: readonly ProbeItem[]): WrapperCall {
	return { sub: "probe", runId, paths: items.map((i) => i.path) };
}

/** One line of `probe`'s stdout: whether `_as2test` opened the path for reading, and whether it may write it. */
export interface ProbeAnswer {
	path: string;
	read: boolean;
	write: boolean;
}

/** `probe`'s stdout: one JSON object per line. */
export function probeAnswerLine(a: ProbeAnswer): string {
	return JSON.stringify({ path: a.path, read: a.read, write: a.write });
}

/** `probe`'s answers, or null when any line is not one. */
export function parseProbeAnswers(stdout: string): ProbeAnswer[] | null {
	const out: ProbeAnswer[] = [];
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		let v: unknown;
		try {
			v = JSON.parse(line);
		} catch {
			return null;
		}
		if (!v || typeof v !== "object" || !("path" in v) || !("read" in v) || !("write" in v)) return null;
		const { path, read, write } = v;
		if (typeof path !== "string" || typeof read !== "boolean" || typeof write !== "boolean") return null;
		out.push({ path, read, write });
	}
	return out;
}

export type Verdict = { ok: true; summary: string } | { ok: false; reason: string };

/** The probe half of the preflight: `probe` answered (exit 0 or 65) for every item, and none is reachable its forbidden way. */
export function probeDecision(items: readonly ProbeItem[], exit: number | null, stdout: string): Verdict {
	if (exit !== WRAPPER_EXIT.ok && exit !== WRAPPER_EXIT.probeReachable) return { ok: false, reason: `probe did not answer (exit ${exit ?? "signal"})` };
	const answers = parseProbeAnswers(stdout);
	if (!answers) return { ok: false, reason: "probe output is not one answer per line" };
	const byPath = new Map(answers.map((a) => [a.path, a]));
	const reached: string[] = [];
	for (const it of items) {
		const a = byPath.get(it.path);
		if (!a) return { ok: false, reason: `probe gave no answer for ${it.path}` };
		if (it.forbid === "any" && a.read) reached.push(`_as2test can read ${it.path} (${it.why})`);
		if (a.write) reached.push(`_as2test can write ${it.path} (${it.why})`);
	}
	if (reached.length > 0) return { ok: false, reason: reached.join("; ") };
	return { ok: true, summary: `probe: ${items.length} paths unreachable as ${AS2TEST_USER}` };
}

// ---- SOURCE and the install facts (§ 3.1 Setup, Preflight) ------------------------------------------

/** What install/as2test-setup.sh recorded. */
export interface SourceRecord {
	source: string;
	sourceSha: string;
	bunVersion: string;
	user: string;
	uid: number;
	gid: number;
	jo: string;
	joUid: number;
	/** sha-256 of each installed file, by name under the libexec dir. */
	files: Record<string, string>;
	/** sha-256 of each bundle input, by path relative to the source checkout. */
	inputs: Record<string, string>;
	/** What setup created and undo may remove: `user`, `group`, and absolute paths. */
	created: string[];
}

const HEX64 = /^[0-9a-f]{64}$/;
/**
 * The `source` and `source-sha` of the provisional SOURCE setup writes before the helper's first run
 * (renderProvisionalSource): never what the helper writes, so the helper never answers `current` over it.
 */
export const PROVISIONAL = "provisional";

/**
 * SOURCE: `#` comments, then one `<key> <value…>` per line. Single keys: `version 1`, `source`,
 * `source-sha`, `bun-version`, `user`, `uid`, `gid`, `jo`, `jo-uid`. Repeated keys: `file <name>
 * <sha256>`, `input <relative path> <sha256>`, `created <user|group|absolute path>`. Only the
 * provisional SOURCE setup writes before the helper's first run (`source-sha provisional`) may list
 * no input.
 */
export function parseSource(text: string): { ok: true; source: SourceRecord } | { ok: false; error: string } {
	const single = new Map<string, string>();
	const files: Record<string, string> = {};
	const inputs: Record<string, string> = {};
	const created: string[] = [];
	for (const [i, raw] of text.split("\n").entries()) {
		const line = raw.trimEnd();
		if (line === "" || line.startsWith("#")) continue;
		const sp = line.indexOf(" ");
		if (sp <= 0) return { ok: false, error: `SOURCE line ${i + 1}: no value` };
		const key = line.slice(0, sp);
		const value = line.slice(sp + 1);
		if (key === "file" || key === "input") {
			const m = /^(\S+) ([0-9a-f]{64})$/.exec(value);
			if (!m) return { ok: false, error: `SOURCE line ${i + 1}: ${key} needs <path> <sha256>` };
			(key === "file" ? files : inputs)[m[1]!] = m[2]!;
		} else if (key === "created") {
			if (value !== "user" && value !== "group" && !plainAbs(value)) return { ok: false, error: `SOURCE line ${i + 1}: created needs user, group or an absolute path` };
			created.push(value);
		} else if (["version", "source", "source-sha", "bun-version", "user", "uid", "gid", "jo", "jo-uid"].includes(key)) {
			if (single.has(key)) return { ok: false, error: `SOURCE line ${i + 1}: ${key} twice` };
			single.set(key, value);
		} else return { ok: false, error: `SOURCE line ${i + 1}: unknown key ${key}` };
	}
	if (single.get("version") !== "1") return { ok: false, error: "SOURCE has no `version 1`" };
	const int = (k: string): number | null => {
		const v = single.get(k);
		return v !== undefined && /^\d+$/.test(v) ? Number(v) : null;
	};
	const [uid, gid, joUid] = [int("uid"), int("gid"), int("jo-uid")];
	for (const k of ["source", "source-sha", "bun-version", "user", "jo"]) if (!single.get(k)) return { ok: false, error: `SOURCE has no ${k}` };
	if (uid === null || gid === null || joUid === null) return { ok: false, error: "SOURCE needs numeric uid, gid and jo-uid" };
	for (const f of INSTALLED_FILES) if (!files[f]) return { ok: false, error: `SOURCE has no file ${f}` };
	if (Object.keys(inputs).length === 0 && single.get("source-sha") !== PROVISIONAL) return { ok: false, error: "SOURCE lists no bundle input" };
	return {
		ok: true,
		source: {
			source: single.get("source")!, sourceSha: single.get("source-sha")!, bunVersion: single.get("bun-version")!, user: single.get("user")!,
			uid, gid, jo: single.get("jo")!, joUid, files, inputs, created,
		},
	};
}

/** Who should own a path setup left: root (gid wheel), Jo (gid `_as2test`) or `_as2test` (gid `_as2test`). */
export type OwnerRole = "root" | "jo" | "as2test";
export interface LayoutItem {
	path: string;
	kind: "file" | "dir";
	owner: OwnerRole;
	mode: number;
	/** The INSTALLED_FILES name, for the installed files under libexec. */
	file?: InstalledFile;
}

/** Every path setup and the refresh helper leave, with its owner and mode (§ 3.1 Setup 2–4; PLAN wl-mv718fxhwwcn40 § 1.2). `current` is the runner's, not setup's. */
export function installLayout(p: { libexec?: string; root?: string; sudoers?: string } = {}): LayoutItem[] {
	const libexec = p.libexec ?? AS2TEST_LIBEXEC;
	const root = p.root ?? AS2TEST_ROOT;
	return [
		{ path: libexec, kind: "dir", owner: "root", mode: 0o755 },
		...INSTALLED_FILES.map((f) => ({ path: join(libexec, f), kind: "file" as const, owner: "root" as const, mode: 0o755, file: f })),
		{ path: join(libexec, "SOURCE"), kind: "file", owner: "root", mode: 0o755 },
		// The helper's lock, mirror and staged copies: root-only, so `_as2test` cannot read them.
		{ path: join(libexec, "refresh.d"), kind: "dir", owner: "root", mode: 0o700 },
		{ path: p.sudoers ?? AS2TEST_SUDOERS, kind: "file", owner: "root", mode: 0o440 },
		{ path: root, kind: "dir", owner: "root", mode: 0o755 },
		{ path: join(root, "stage"), kind: "dir", owner: "jo", mode: 0o750 },
		{ path: join(root, "runs"), kind: "dir", owner: "as2test", mode: 0o755 },
		{ path: join(root, "locks"), kind: "dir", owner: "root", mode: 0o755 },
		{ path: join(root, "locks", "sweep.db"), kind: "file", owner: "as2test", mode: 0o600 },
	];
}

export interface StatFact {
	path: string;
	/** null when lstat failed. */
	type: "file" | "dir" | "symlink" | "other" | null;
	uid: number;
	gid: number;
	mode: number;
}

export interface InstallFacts {
	/** The account as dscl reports it, or null when the user or group is missing. */
	account: { uid: number; gid: number } | null;
	/** SOURCE parsed, or why it could not be. */
	source: { ok: true; source: SourceRecord } | { ok: false; error: string };
	/** Every layout path, lstat'ed. */
	stats: StatFact[];
	/** sha-256 of each installed file (null when unreadable). */
	fileHashes: Record<string, string | null>;
	/** sha-256 of each SOURCE input in the runner's checkout (null when unreadable). */
	inputHashes: Record<string, string | null>;
	layout: LayoutItem[];
	/**
	 * Trusted installed calibration/runtime validation, when SOURCE records these artifacts: resources.json's trusted path
	 * (every ancestor) and content (its own owner and mode are a layout item, so the owner ids are installDecision's), and
	 * the installed-OMP pin and tree.
	 */
	executionPolicyError?: string;
}

const sha256File = (p: string): string | null => {
	try {
		return createHash("sha256").update(readFileSync(p)).digest("hex");
	} catch {
		return null;
	}
};

function statFact(path: string): StatFact {
	try {
		const s = lstatSync(path);
		return { path, type: s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : s.isDirectory() ? "dir" : "other", uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 };
	} catch {
		return { path, type: null, uid: -1, gid: -1, mode: 0 };
	}
}

/** `dscl . -read <record> <key>` → the integer value, or null. */
export type DsclRead = (record: string, key: string) => number | null;

const realDscl: DsclRead = (record, key) => {
	const r = Bun.spawnSync(["/usr/bin/dscl", ".", "-read", record, key], { stdout: "pipe", stderr: "ignore" });
	if (r.exitCode !== 0) return null;
	const m = new RegExp(`^${key}:\\s*(\\d+)\\s*$`, "m").exec(r.stdout.toString());
	return m ? Number(m[1]) : null;
};

/**
 * The install facts the preflight decides on, read as Jo (§ 3.1 Preflight). `checkout` is the runner's checkout, whose bundle inputs must match SOURCE.
 * `trustedOwners` (default root only) are the uids the measured policy's path may be owned by, every ancestor included; a test install adds its own uid.
 */
export function readInstall(p: { checkout: string; libexec?: string; root?: string; sudoers?: string; dscl?: DsclRead; trustedOwners?: readonly number[] }): InstallFacts {
	const libexec = p.libexec ?? AS2TEST_LIBEXEC;
	const dscl = p.dscl ?? realDscl;
	const layout = installLayout(p);
	let source: InstallFacts["source"];
	try {
		source = parseSource(readFileSync(join(libexec, "SOURCE"), "utf8"));
	} catch (e) {
		source = { ok: false, error: `SOURCE unreadable: ${(e as Error).message}` };
	}
	const uid = dscl(`/Users/${AS2TEST_USER}`, "UniqueID");
	const userGid = dscl(`/Users/${AS2TEST_USER}`, "PrimaryGroupID");
	const gid = dscl(`/Groups/${AS2TEST_USER}`, "PrimaryGroupID");
	const account = uid !== null && gid !== null && userGid === gid ? { uid, gid } : null;
	const fileHashes: Record<string, string | null> = {};
	for (const f of INSTALLED_FILES) fileHashes[f] = sha256File(join(libexec, f));
	if (source.ok) for (const name of ["resources.json", "installed-omp.json"]) {
		if (source.source.files[name]) fileHashes[name] = sha256File(join(libexec, name));
	}
	const inputHashes: Record<string, string | null> = {};
	if (source.ok) {
		for (const rel of Object.keys(source.source.inputs)) {
			const abs = resolve(p.checkout, rel);
			inputHashes[rel] = relative(p.checkout, abs).startsWith("..") ? null : sha256File(abs);
		}
	}
	// A SOURCE that records the measured resource policy makes it part of the install: root-owned, 0644, a regular file,
	// on a physical path whose every ancestor is trusted-owned and not group- or world-writable, holding measured costs.
	const policyLayout: LayoutItem[] = source.ok && source.source.files[RESOURCE_POLICY] ? [{ path: join(libexec, RESOURCE_POLICY), kind: "file", owner: "root", mode: 0o644 }] : [];
	const errors: string[] = [];
	if (policyLayout.length > 0) {
		const policy = join(libexec, RESOURCE_POLICY);
		try {
			verifyTrustedPath(policy, p.trustedOwners);
			const why = resourcePolicyContentError(policy);
			if (why !== null) errors.push(why);
		} catch (e) {
			errors.push(e instanceof Error ? e.message : String(e));
		}
	}
	if (source.ok && source.source.files["installed-omp.json"]) {
		try { readInstalledOmp(join(libexec, "installed-omp.json")); } catch (e) { errors.push(`installed-omp.json: ${e instanceof Error ? e.message : String(e)}`); }
	}
	const executionPolicyError = errors.length > 0 ? `trusted execution policy: ${errors.join("; ")}; repair provisioning (${SETUP_RESOURCES}), not wrapper argv` : undefined;
	const all = [...layout, ...policyLayout];
	return { account, source, stats: all.map((l) => statFact(l.path)), fileHashes, inputHashes, layout: all, ...(executionPolicyError ? { executionPolicyError } : {}) };
}

/** The measured resource policy every ordinary and proof part of the executor requires, beside the installed bun (execConfigOf's default). */
export const RESOURCE_POLICY = "resources.json";
const SETUP_RESOURCES = "install/as2test-setup.sh --resources=/absolute/measured-policy.json";

/** Why the policy file's content is unusable (unreadable, not JSON, or not measured costs parseResourceCosts admits), or null. */
function resourcePolicyContentError(path: string): string | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (e) {
		return `${path} cannot be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`;
	}
	try {
		parseResourceCosts(JSON.parse(text));
	} catch (e) {
		return `${path} is not a measured resource policy: ${(e as Error).message}`;
	}
	return null;
}

/**
 * Why the executor that `render-exec` renders must not be activated over `path` (review F2), or null. Every refresh helper,
 * main's installed one included, runs the fetched commit's `render-exec` before it stages anything, so this refusal holds
 * whatever helper text a host carries: the policy must be a regular file (not a symlink), owned by its directory's owner
 * (root on a real install, where the preflight and setup hold that directory root-owned), not group- or world-writable, and
 * measured costs parseResourceCosts admits. The executor checks the whole trusted path again before every part.
 */
export function activationPolicyError(path: string): string | null {
	let s;
	try {
		s = lstatSync(path);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? `${path} is missing` : `${path} cannot be read: ${code ?? (e as Error).message}`;
	}
	if (s.isSymbolicLink() || !s.isFile()) return `${path} is ${s.isSymbolicLink() ? "a symlink" : "not a regular file"}`;
	let dirUid: number;
	try {
		dirUid = lstatSync(dirname(path)).uid;
	} catch (e) {
		return `${dirname(path)} cannot be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`;
	}
	if (s.uid !== dirUid) return `${path} is owned by uid ${s.uid}, not by ${dirname(path)}'s owner ${dirUid}`;
	if ((s.mode & 0o022) !== 0) return `${path} is group- or world-writable (mode ${(s.mode & 0o7777).toString(8)})`;
	return resourcePolicyContentError(path);
}

/** The ids the owner roles stand for: root and wheel are 0 on a real install; a test passes its own. */
export interface OwnerIds {
	root: number;
	wheel: number;
	jo: number;
}

const RERUN = "re-run install/as2test-setup.sh";

/**
 * Why the install half failed (PLAN wl-mv718fxhwwcn40 § 1.2): `install` only setup can fix;
 * `file-drift` (an installed `exec` or `test-exec.js` missing, not a regular file, or off its
 * SOURCE hash) and `input-drift` (a SOURCE input differs in the runner's checkout) the refresh
 * helper can.
 */
export type InstallFailKind = "install" | "file-drift" | "input-drift";
export type InstallVerdict = { ok: true; summary: string } | { ok: false; kind: InstallFailKind; reason: string };

/**
 * The install half of the preflight (§ 3.1 Preflight; PLAN wl-mv718fxhwwcn40 § 1.2). The groups
 * run in order and the first failing one sets the kind:
 * 1. `install`: the account, SOURCE, SOURCE's ids against the account's and Jo's, every layout
 *    item's type, owner and mode (a rebuilt file only when it exists as a regular file; resources.json, root 0644, when
 *    SOURCE records it), the trusted execution policy's content and SOURCE hash, and the hashes of the files only setup
 *    writes (`bun`, `refresh`). The reason says to re-run setup.
 * 2. `file-drift`: a rebuilt file (`exec`, `test-exec.js`) missing, not a regular file, or off its hash.
 * 3. `input-drift`: a SOURCE input differs in the runner's checkout.
 */
export function installDecision(f: InstallFacts, ids: OwnerIds): InstallVerdict {
	const install = (reason: string): InstallVerdict => ({ ok: false, kind: "install", reason: `${reason}; ${RERUN}` });
	if (!f.account) return install(`the ${AS2TEST_USER} account is missing or its user and group ids differ`);
	if (!f.source.ok) return install(f.source.error);
	const src = f.source.source;
	if (src.user !== AS2TEST_USER || src.uid !== f.account.uid || src.gid !== f.account.gid) {
		return install(`SOURCE records ${src.user} ${src.uid}:${src.gid}, the account is ${f.account.uid}:${f.account.gid}`);
	}
	if (src.joUid !== ids.jo) return install(`SOURCE was set up for uid ${src.joUid}, not ${ids.jo}`);
	const rebuilt = (name: InstalledFile | undefined): boolean => name !== undefined && (REBUILT_FILES as readonly InstalledFile[]).includes(name);
	const want = (r: OwnerRole): [number, number] => (r === "root" ? [ids.root, ids.wheel] : r === "jo" ? [ids.jo, src.gid] : [src.uid, src.gid]);
	for (const [i, l] of f.layout.entries()) {
		const s = f.stats[i]!;
		// A rebuilt file that is missing or not a regular file is file-drift, decided below.
		if (rebuilt(l.file) && s.type !== "file") continue;
		if (s.type !== l.kind) return install(`${l.path} is ${s.type ?? "missing"}, expected a ${l.kind}`);
		const [u, g] = want(l.owner);
		if (s.uid !== u || s.gid !== g) return install(`${l.path} is owned ${s.uid}:${s.gid}, expected ${u}:${g}`);
		if (s.mode !== l.mode) return install(`${l.path} has mode ${s.mode.toString(8)}, expected ${l.mode.toString(8)}`);
	}
	if (f.executionPolicyError) return install(f.executionPolicyError);
	for (const name of ["resources.json", "installed-omp.json"]) {
		if (src.files[name] && f.fileHashes[name] !== src.files[name]) return install(`installed ${name} does not match its sha-256 in SOURCE`);
	}
	for (const name of INSTALLED_FILES) {
		if (!rebuilt(name) && f.fileHashes[name] !== src.files[name]) return install(`installed ${name} does not match its sha-256 in SOURCE`);
	}
	for (const name of REBUILT_FILES) {
		const at = f.layout.findIndex((l) => l.file === name);
		const type = at >= 0 ? f.stats[at]!.type : null;
		if (type === null) return { ok: false, kind: "file-drift", reason: `installed ${name} is missing` };
		if (type !== "file") return { ok: false, kind: "file-drift", reason: `installed ${name} is a ${type}, not a regular file` };
		if (f.fileHashes[name] !== src.files[name]) return { ok: false, kind: "file-drift", reason: `installed ${name} does not match its sha-256 in SOURCE` };
	}
	for (const [rel, sha] of Object.entries(src.inputs)) {
		if (f.inputHashes[rel] !== sha) return { ok: false, kind: "input-drift", reason: `${rel} in this checkout differs from the installed test-exec bundle` };
	}
	return { ok: true, summary: `install: ${AS2TEST_USER} ${src.uid}:${src.gid}, bun ${src.bunVersion}, source ${src.source} at ${src.sourceSha.slice(0, 12)}` };
}

/** The preflight's verdict (§ 3.1): the install checks, then the probe; the first failure is the reason, never a fallback. */
export function preflightDecision(install: Verdict, probe: Verdict): Verdict {
	if (!install.ok) return { ok: false, reason: `preflight: ${install.reason}` };
	if (!probe.ok) return { ok: false, reason: `preflight: ${probe.reason}` };
	return { ok: true, summary: `${install.summary}; ${probe.summary}` };
}

// ---- the refresh helper (PLAN wl-mv718fxhwwcn40 § 1.1) ---------------------------------------------

/** The one origin an installed helper fetches the verified tag from: fixed in its text, never read from a remote. */
export const AS2TEST_ORIGIN = "https://github.com/thewolff/agent-system-2.0.git";
/**
 * The tag the runner points at the verified commit (PLAN wl-mvq4edbaf13vnk § 2 "The bundle"): the refresh helper fetches
 * `refs/tags/<this>` and builds its commit, never origin/main, so the bundle is only ever verified code.
 */
export const AS2_VERIFIED_TAG = "as2-verified";
/** The preflight's reason codes (§ 1.3): the helper failed, or a drift outlived its success. */
export const REFRESH_FAILED = "bundle-refresh-failed";
export const CHECKOUT_DRIFT = "checkout-drift";
/** The helper's exit codes (§ 1.1). */
export const REFRESH_EXIT = { ok: 0, usage: 64, lock: 69, fetch: 70, build: 71, install: 72, notRoot: 77 } as const;
/** How long a helper waits for another helper's lock, in seconds (§ 1.1 Lock). */
export const REFRESH_LOCK_WAIT_S = 600;
/** Where the helper makes its build directory (§ 1.1 Build). */
export const REFRESH_BUILD_PARENT = "/private/tmp";
/**
 * The helper's own cap, in seconds: past it, it signals itself ALRM and stops as on a TERM. The runner
 * cannot bound the helper itself (Jo's user cannot signal a root process), so this is what does; the
 * runner's cap sits a minute above it, above the kill grace and the cleanup bound too.
 */
export const REFRESH_CAP_S = 14 * 60;
/** On a signal, how long the helper waits after TERM before it KILLs the running step's process tree, in seconds. */
export const REFRESH_KILL_GRACE_S = 3;
/**
 * The helper's cleanup bound, in seconds: one deadline shared by every removal from a stop or the exit on
 * (the .new staging files, then the build dir), and one for removing a stale build dir before a build. A
 * removal past it is killed and left, named on stderr, and a later helper removes a left build dir. So the
 * helper exits, and its lock goes, within REFRESH_CAP_S + REFRESH_KILL_GRACE_S + this, under the runner's cap.
 */
export const REFRESH_CLEANUP_S = 30;
/** The argument the helper's env -i re-exec adds, so the re-exec'd shell does not re-exec again; an installed helper is never called with it. */
const REFRESH_CLEAN_ARG = "--as2test-refresh-clean-env";
/**
 * Variables that steer git and its transports, curl, the dynamic loader, the /usr/bin/git xcrun shim or a
 * shell. The scrub already leaves none of them; the helper unsets them after it anyway, belt and braces.
 */
const REFRESH_UNSET = [
	"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_SYSTEM", "GIT_ATTR_NOSYSTEM",
	"GIT_ATTR_SOURCE", "GIT_REPLACE_REF_BASE", "GIT_NO_REPLACE_OBJECTS", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_ASKPASS",
	"SSH_ASKPASS", "GIT_PROXY_COMMAND", "GIT_ALLOW_PROTOCOL", "GIT_PROTOCOL_FROM_USER", "GIT_SSL_NO_VERIFY", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "GIT_SSL_CERT", "GIT_SSL_KEY",
	"GIT_CURL_VERBOSE", "GIT_TRACE", "GIT_TRACE_PACKET", "GIT_TRACE_SETUP", "GIT_TRACE2", "GIT_TRACE2_EVENT", "GIT_TRACE2_PERF", "GIT_PAGER", "GIT_EDITOR", "GIT_EXTERNAL_DIFF",
	"http_proxy", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY", "CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR",
	"DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_FALLBACK_FRAMEWORK_PATH", "DYLD_VERSIONED_LIBRARY_PATH",
	"DYLD_VERSIONED_FRAMEWORK_PATH", "DYLD_IMAGE_SUFFIX", "LD_LIBRARY_PATH", "LD_PRELOAD", "DEVELOPER_DIR", "SDKROOT", "TOOLCHAINS", "XDG_CONFIG_HOME", "ENV", "BASH_ENV", "CDPATH",
];

/** The SOURCE facts setup owns, fixed in the helper's text; the helper writes them into every SOURCE. */
export interface SourceFacts {
	bunVersion: string;
	user: string;
	uid: number;
	gid: number;
	jo: string;
	joUid: number;
	/** What setup created and undo may remove: `user`, `group`, and absolute paths. */
	created: string[];
}

export interface RefreshHelperOptions {
	/** Where the as2-verified tag is fetched from: AS2TEST_ORIGIN for an installed helper; a local bare repo in a test render. */
	origin: string;
	/** The libexec dir: the helper is `<libexec>/refresh`, its lock, mirror and staged copies are in `<libexec>/refresh.d`. */
	libexec: string;
	/** The as2test root the rebuilt `exec` is rendered with. */
	root: string;
	/** The bun the build runs on: `<libexec>/bun` for an installed helper. */
	bun: string;
	facts: SourceFacts;
	/** The user the build runs as (`nobody`), through `sudo -n -u`; null runs it as the caller (a test render). */
	buildUser: string | null;
	/** true for an installed helper: it exits 77 unless uid 0, and installs root:wheel. false installs with the caller's ids. */
	asRoot: boolean;
	/** How long to wait for another helper's lock, in seconds (default REFRESH_LOCK_WAIT_S). */
	lockWaitS?: number;
	/** Test-only: the helper's own cap, in seconds (default REFRESH_CAP_S); an asRoot render carries only the default. */
	capS?: number;
	/** Test-only: allow git's file protocol, for a local bare origin. */
	allowFileProtocol?: boolean;
	/**
	 * Test-only: each staging install sleeps this many seconds after it writes its `.new` copy, standing in for
	 * a stalled install, so a test can signal the helper mid-install; an asRoot render carries none.
	 */
	stallS?: number;
	/** Test-only: the helper's cleanup bound, in seconds (default REFRESH_CLEANUP_S); an asRoot render carries only the default. */
	cleanupS?: number;
	/**
	 * Test-only: the build user's removal of a build dir's src and out sleeps this many seconds first, standing in
	 * for a stalled removal, so a test can see the cleanup bound end it; an asRoot render carries none.
	 */
	cleanupStallS?: number;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const HTTPS_ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/[A-Za-z0-9._~/-]+$/;

/** The SOURCE lines the helper writes around `source-sha`; throws WrapperRenderError on an option the helper must not carry. */
function refreshSourceLines(o: RefreshHelperOptions): { head: string[]; facts: string[]; lockWaitS: number; capS: number; cleanupS: number } {
	for (const [k, v] of [["libexec", o.libexec], ["root", o.root], ["bun", o.bun]] as const) {
		if (typeof v !== "string" || !plainAbs(v)) throw new WrapperRenderError(`${k} must be a normalized absolute path: ${String(v)}`);
	}
	const fileOrigin = typeof o.origin === "string" && (plainAbs(o.origin) || (o.origin.startsWith("file://") && plainAbs(o.origin.slice("file://".length))));
	if (typeof o.origin !== "string" || !(HTTPS_ORIGIN.test(o.origin) || (o.allowFileProtocol === true && fileOrigin))) {
		throw new WrapperRenderError(`origin must be an https URL${o.allowFileProtocol ? ", a file:// URL or an absolute path" : ""}: ${String(o.origin)}`);
	}
	if (o.buildUser !== null && (typeof o.buildUser !== "string" || !NAME.test(o.buildUser))) throw new WrapperRenderError(`buildUser must be a user name or null: ${String(o.buildUser)}`);
	if (typeof o.asRoot !== "boolean") throw new WrapperRenderError("asRoot must be true or false");
	if (o.asRoot) {
		// An installed helper runs as root: it fetches only the fixed origin, over https, and never runs main's code as root.
		if (o.origin !== AS2TEST_ORIGIN) throw new WrapperRenderError(`an asRoot render fetches only ${AS2TEST_ORIGIN}`);
		if (o.allowFileProtocol) throw new WrapperRenderError("allowFileProtocol is test-only: an asRoot render carries none");
		if (o.buildUser === null) throw new WrapperRenderError("an asRoot render needs a buildUser: root never runs main's code");
		if (o.capS !== undefined && o.capS !== REFRESH_CAP_S) throw new WrapperRenderError(`capS is test-only: an asRoot render caps itself at ${REFRESH_CAP_S} s`);
		if (o.stallS !== undefined) throw new WrapperRenderError("stallS is test-only: an asRoot render carries none");
		if (o.cleanupS !== undefined && o.cleanupS !== REFRESH_CLEANUP_S) throw new WrapperRenderError(`cleanupS is test-only: an asRoot render bounds its cleanup at ${REFRESH_CLEANUP_S} s`);
		if (o.cleanupStallS !== undefined) throw new WrapperRenderError("cleanupStallS is test-only: an asRoot render carries none");
	}
	const lockWaitS = o.lockWaitS ?? REFRESH_LOCK_WAIT_S;
	if (!Number.isSafeInteger(lockWaitS) || lockWaitS < 0) throw new WrapperRenderError("lockWaitS must be a whole number of seconds");
	const capS = o.capS ?? REFRESH_CAP_S;
	if (!Number.isSafeInteger(capS) || capS < 1) throw new WrapperRenderError("capS must be a whole number of seconds, at least 1");
	if (o.stallS !== undefined && (!Number.isSafeInteger(o.stallS) || o.stallS < 1)) throw new WrapperRenderError("stallS must be a whole number of seconds, at least 1");
	const cleanupS = o.cleanupS ?? REFRESH_CLEANUP_S;
	if (!Number.isSafeInteger(cleanupS) || cleanupS < 1) throw new WrapperRenderError("cleanupS must be a whole number of seconds, at least 1");
	if (o.cleanupStallS !== undefined && (!Number.isSafeInteger(o.cleanupStallS) || o.cleanupStallS < 1)) throw new WrapperRenderError("cleanupStallS must be a whole number of seconds, at least 1");
	const f = o.facts;
	if (!f || typeof f !== "object") throw new WrapperRenderError("facts are required");
	for (const [k, v] of [["user", f.user], ["jo", f.jo]] as const) if (typeof v !== "string" || !NAME.test(v)) throw new WrapperRenderError(`facts.${k} must be a user name: ${String(v)}`);
	for (const [k, v] of [["uid", f.uid], ["gid", f.gid], ["joUid", f.joUid]] as const) {
		if (!Number.isSafeInteger(v) || v < 0) throw new WrapperRenderError(`facts.${k} must be a whole number: ${String(v)}`);
	}
	if (typeof f.bunVersion !== "string" || !/^[0-9A-Za-z.+-]+$/.test(f.bunVersion)) throw new WrapperRenderError(`facts.bunVersion must be a version: ${String(f.bunVersion)}`);
	if (!Array.isArray(f.created)) throw new WrapperRenderError("facts.created must be a list");
	for (const c of f.created) if (c !== "user" && c !== "group" && !(typeof c === "string" && plainAbs(c))) throw new WrapperRenderError(`facts.created needs user, group or an absolute path: ${String(c)}`);
	const head = [
		`# as2test SOURCE: written by ${join(o.libexec, "refresh")} (surface/src/as2test.ts renderRefreshHelper), read by the runner's preflight (parseSource) and by install/as2test-setup.sh --undo`,
		"version 1",
		`source ${o.origin}`,
	];
	const facts = [
		`bun-version ${f.bunVersion}`, `user ${f.user}`, `uid ${f.uid}`, `gid ${f.gid}`, `jo ${f.jo}`, `jo-uid ${f.joUid}`, ...f.created.map((c) => `created ${c}`),
	];
	// The helper's SOURCE must stay one parseSource (this one, and main's before this change) accepts.
	const sample = [...head, `source-sha ${"0".repeat(40)}`, ...facts, ...INSTALLED_FILES.map((n) => `file ${n} ${"0".repeat(64)}`), `input x ${"0".repeat(64)}`, ""].join("\n");
	const parsed = parseSource(sample);
	if (!parsed.ok) throw new WrapperRenderError(`the helper's SOURCE would not parse: ${parsed.error}`);
	return { head, facts, lockWaitS, capS, cleanupS };
}

/**
 * The refresh helper's process functions (CODE-REVIEW-r2 finding 2), sh text the helper carries verbatim;
 * exported so a test runs them on processes it starts. `run` starts each step as a process group of its
 * own, and these find the step's processes from that group at the moment they are called, so `stop`
 * never signals a pid list it read earlier without checking it again.
 */
export const REFRESH_STEP_SH = [
	"# pids_under <pid>: it and every process under it, each listed while its parent still lives.",
	`pids_under() { printf '%s\\n' "$1"; for _p in $(/usr/bin/pgrep -a -P "$1"); do pids_under "$_p"; done; }`,
	"# step_pids <pgid>: the step's processes now: each member of its process group, and every process under one.",
	`step_pids() { for _m in $(/usr/bin/pgrep -a -g "$1"); do pids_under "$_m"; done | /usr/bin/sort -u; }`,
	"# still_ours <pgid> <pid...>: those of the pids that are the step's now (step_pids), one a line.",
	`still_ours() { _g=$1; shift; _now=" $(step_pids "$_g" | /usr/bin/tr '\\n' ' ') "; for _p; do case "$_now" in *" $_p "*) printf '%s\\n' "$_p" ;; esac; done; }`,
	"# kill_ours <signal> <pgid> <pid...>: the signal to those of the pids that are the step's now, and to no other.",
	`kill_ours() { _s=$1; shift; _o=$(still_ours "$@"); [ -z "$_o" ] || /bin/kill "-$_s" $_o 2>/dev/null; }`,
	"# Why a pid these find is the step's, on macOS. run forks each step with set -m, so the step is a process",
	"# group whose id is its first pid, and what it starts stays in that group unless it leaves it. XNU never",
	"# hands out a pid equal to the id of a live process group (bsd/kern/kern_fork.c, the pid allocation loop's",
	"# pghash_exists_locked check; POSIX fork: the child's pid matches no active process group id), so while",
	"# the group has a member, a member of it is this step's; and a process under a live member is that",
	"# member's own child. A pid listed at TERM gets the KILL only if it is still one of these when the KILL is",
	"# sent. What is left: the whole group ends and its id comes back as the leader of a new group inside the",
	`# ${REFRESH_KILL_GRACE_S} s grace, which needs XNU's sequential pid counter to pass PID_MAX (99,999) and wrap in that time;`,
	"# and a process that leaves the group and outlives its parent gets the TERM but not the KILL.",
].join("\n");

/**
 * The refresh helper's sh text (PLAN wl-mv718fxhwwcn40 § 1.1): `<libexec>/refresh`, the one command
 * the second sudoers line allows, with no arguments. Unless its environment is exactly the fixed one
 * it re-execs itself under `env -i`, takes the lock on `refresh.d/lock` (fd 9, lockf), removes the build
 * dir an earlier run left (within the cleanup bound), fetches the `as2-verified` tag (AS2_VERIFIED_TAG) from the fixed origin
 * into the root-owned mirror `refresh.d/mirror.git`, and answers `current <sha12>` when the installed SOURCE is
 * byte for byte the SOURCE it would write. Before the fetch it refuses (71) unless `<libexec>/resources.json`, the
 * measured resource policy the executor requires (RESOURCE_POLICY), is a regular file it owns and no group or other can
 * write; the fetched commit's `render-exec` refuses an absent or invalid one too (activationPolicyError), which holds even
 * under a helper rendered before this check. Otherwise it unpacks the tag's commit into a fresh build dir, runs bun
 * build, `bundle-inputs` and `render-exec` there as the build
 * user, reads the outputs through the build user into the root-only `refresh.d/stage`, checks the
 * staged copies, and installs `exec`, `test-exec.js` and `SOURCE` (last) through dotted `.new` names
 * and a rename. A HUP, INT or TERM, or its own cap (`capS`), ends the running step's process tree and
 * exits 71 with nothing renamed. Its cleanup (the .new files on a stop, the build dir at exit) is bounded
 * by `cleanupS`: a removal past it is killed and left, so the helper exits within cap + grace + cleanupS.
 */
export function renderRefreshHelper(o: RefreshHelperOptions): string {
	const { head, facts, lockWaitS, capS, cleanupS } = refreshSourceLines(o);
	const printLines = (xs: string[]) => `\tprintf '%s\\n' ${xs.map(shq).join(" ")}`;
	const gitConfig = ["-c core.hooksPath=/dev/null", "-c protocol.allow=never", "-c protocol.https.allow=always", ...(o.allowFileProtocol ? ["-c protocol.file.allow=always"] : [])].join(" ");
	const asUser = o.buildUser === null ? "" : `/usr/bin/sudo -n -u ${shq(o.buildUser)} `;
	const cleanArg = shq(REFRESH_CLEAN_ARG);
	return [
		"#!/bin/sh",
		"# agent-system 2.0 test runner: the test-exec bundle refresh helper (workload wl-mv718fxhwwcn40, PLAN",
		"# § 1.1), rendered by surface/src/as2test.ts renderRefreshHelper. It takes no arguments: every value is",
		`# fixed here, and it never reads its caller's env, cwd or checkout. It fetches the ${AS2_VERIFIED_TAG} tag from ORIGIN into a`,
		"# root-owned mirror, builds test-exec as the build user, checks what the build user hands back, and",
		"# installs exec, test-exec.js and SOURCE (last). It never writes itself or the sudoers file. Without the measured",
		"# resources.json the executor requires (a regular file it owns, not group- or world-writable) it fetches nothing.",
		"# Exit: 0 refreshed or current · 64 usage · 69 lock · 70 fetch · 71 build, check, signal or cap · 72 install · 77 not root.",
		"# Stdout: one line, `refreshed <old12>..<new12>` or `current <sha12>`.",
		`# build user: ${o.buildUser ?? "the caller (a test render)"}; ${o.asRoot ? "runs as root only" : "a test render: installs with the caller's ids"}`,
		"#",
		"# The scrub. Unless the environment is exactly the fixed one (HOME and PATH as below, plus the shell's",
		"# own PWD, SHLVL=1 and _=/usr/bin/env), the helper re-execs itself under env -i. Up to that exec it runs",
		"# only case, exec, exit and absolute paths, none of which an imported shell function replaces, so no",
		"# inherited value or function skips the scrub. The argument the re-exec adds only stops a second",
		"# re-exec: a re-exec'd shell that still sees another environment stops instead.",
		`case "$(/usr/bin/env -0 | /usr/bin/tr '\\n\\000' '\\001\\n' | /usr/bin/grep -v -e '^PWD=' -e '^SHLVL=1$' -e '^_=/usr/bin/env$' | /usr/bin/sort)" in`,
		`'HOME=/var/empty\nPATH=${WRAPPER_PATH}') ;;`,
		"*)",
		`\tcase "\${1-}" in ${cleanArg}) exec /usr/bin/env -i /bin/sh -c "printf 'as2test-refresh: %s\\\\n' 'the environment is not the fixed one after the env -i re-exec' >&2; exit ${REFRESH_EXIT.build}" ;; esac`,
		`\texec /usr/bin/env -i PATH=${WRAPPER_PATH} HOME=/var/empty /bin/sh ${shq(join(o.libexec, "refresh"))} ${cleanArg} "$@" ;;`,
		"esac",
		`[ "\${1-}" != ${cleanArg} ] || shift`,
		"umask 022",
		"cd / || exit 71",
		"# Belt and braces: the scrub leaves none of these; none may steer git, curl, the loader or a shell.",
		`unset ${REFRESH_UNSET.join(" ")}`,
		`die() { printf 'as2test-refresh: %s\\n' "$2" >&2; exit "$1"; }`,
		`LIBEXEC=${shq(o.libexec)}`,
		'SELF="$LIBEXEC/refresh"',
		`[ "$#" -eq 0 ] || die ${REFRESH_EXIT.usage} "usage: $SELF (it takes no arguments)"`,
		...(o.asRoot
			? [`[ "$(/usr/bin/id -u)" = 0 ] || die ${REFRESH_EXIT.notRoot} "must run as root: sudo -n $SELF"`, "OWN_U=root", "OWN_G=wheel"]
			: ["OWN_U=$(/usr/bin/id -u) || exit 72", "OWN_G=$(/usr/bin/id -g) || exit 72"]),
		`ROOT=${shq(o.root)}`,
		`BUN=${shq(o.bun)}`,
		`ORIGIN=${shq(o.origin)}`,
		'STATE="$LIBEXEC/refresh.d"',
		'MIRROR="$STATE/mirror.git"',
		'STAGE="$STATE/stage"',
		"BUILD=",
		"MADE=",
		"CHILD=",
		"WATCHDOG=",
		"CLEANUP_BY=",
		"LEFT=",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_TERMINAL_PROMPT=0",
		"export GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL GIT_TERMINAL_PROMPT",
		"",
		`g() { /usr/bin/git --git-dir="$MIRROR" ${gitConfig} "$@" 9>&-; }`,
		`as_build() { ${asUser}/usr/bin/env -i PATH=${WRAPPER_PATH} HOME="$BUILD" TMPDIR="$BUILD" "$@" 9>&-; }`,
		"# build_step <stdout file, or - for stderr> <command...>: run as the build user, in $BUILD/src.",
		`build_step() { as_build /bin/sh -c 'cd -- "$1" || exit 1; o=$2; shift 2; if [ "$o" = - ]; then exec "$@" 1>&2; fi; exec "$@" > "$o"' as2test-build "$BUILD/src" "$@"; }`,
		"# take <name>: $BUILD/out/<name>, read as the build user, into the root-only stage. Root never opens a path in $BUILD.",
		`take() { run /dev/null ${asUser}/bin/cat -- "$BUILD/out/$1" > "$STAGE/$1" || die ${REFRESH_EXIT.build} "cannot read the built $1 as the build user"; }`,
		`h256() { if [ -f "$1" ] && [ ! -L "$1" ]; then /usr/bin/shasum -a 256 < "$1" | /usr/bin/awk '{ print $1 }'; else echo missing; fi; }`,
		`isblob() { [ "$(g cat-file -t "$SHA:$1" 2>/dev/null)" = blob ]; }`,
		`blob256() { if isblob "$1"; then g cat-file blob "$SHA:$1" | /usr/bin/shasum -a 256 | /usr/bin/awk '{ print $1 }'; else echo missing; fi; }`,
		`okrel() { case "$1" in "" | /* | . | .. | ./* | ../* | */. | */.. | */./* | */../* | *//* | */) return 1 ;; *[!A-Za-z0-9._/@+-]*) return 1 ;; esac; }`,
		"# write_source <exec> <test-exec.js> <inputs list>: the SOURCE for $SHA, on stdout.",
		"write_source() {",
		printLines(head),
		`\tprintf 'source-sha %s\\n' "$SHA"`,
		printLines(facts),
		`\tprintf 'file exec %s\\n' "$(h256 "$1")"`,
		`\tprintf 'file bun %s\\n' "$(h256 "$LIBEXEC/bun")"`,
		`\tprintf 'file test-exec.js %s\\n' "$(h256 "$2")"`,
		`\tprintf 'file refresh %s\\n' "$(h256 "$SELF")"`,
		`\tprintf 'file ${RESOURCE_POLICY} %s\\n' "$(h256 "$LIBEXEC/${RESOURCE_POLICY}")"`,
		`\tif [ -e "$LIBEXEC/installed-omp.json" ]; then printf 'file installed-omp.json %s\\n' "$(h256 "$LIBEXEC/installed-omp.json")"; fi`,
		`\twhile IFS= read -r rel || [ -n "$rel" ]; do printf 'input %s %s\\n' "$rel" "$(blob256 "$rel")"; done < "$3"`,
		"}",
		"# check_inputs: every path bundle-inputs listed is a plain relative path and a file at $SHA; it says why not on stderr.",
		"check_inputs() {",
		'\twhile IFS= read -r rel || [ -n "$rel" ]; do',
		`\t\tokrel "$rel" || die ${REFRESH_EXIT.build} "bundle-inputs listed a path that is not a plain relative path"`,
		`\t\tisblob "$rel" || die ${REFRESH_EXIT.build} "bundle-inputs listed $rel, which is not a file at $SHA"`,
		'\tdone < "$STAGE/inputs"',
		"}",
		"# stage_new <name>: the staged copy to its dotted .new name in LIBEXEC.",
		`stage_new() { /usr/bin/install -o "$OWN_U" -g "$OWN_G" -m 0755 "$STAGE/$1" "$LIBEXEC/.$1.new"${o.stallS === undefined ? "" : ` && /bin/sleep ${o.stallS}`}; }`,
		`drop_new() { /bin/rm -f "$LIBEXEC/.exec.new" "$LIBEXEC/.test-exec.js.new" "$LIBEXEC/.SOURCE.new"; }`,
		"# run <stdin file> <command...>: the command in the background, as a process group of its own (set -m), waited",
		"# for. sh runs a trap only once its foreground command exits; a trap interrupts wait at once, and stop then ends",
		"# the step. So from the traps on, every command that can block runs through run, under the cap, or, as a",
		"# removal of what a run leaves, through bounded, under the cleanup bound. Only builtins, the pgrep, kill, date",
		"# and short sleeps with which run, stop, bounded and cleanup watch and end those, and the final renames run in",
		"# the foreground.",
		`run() { _in=$1; shift; set -m; "$@" < "$_in" & CHILD=$!; set +m; wait "$CHILD"; _rc=$?; CHILD=; return "$_rc"; }`,
		...REFRESH_STEP_SH.split("\n"),
		"# deadline: the epoch second the cleanup bound ends at, counted from now (0, already past, when date fails).",
		`deadline() { _n=$(/bin/date +%s) || _n=0; case "$_n" in "" | *[!0-9]*) _n=0 ;; esac; echo "$((_n + ${cleanupS}))"; }`,
		"# bounded <by> <what> <command...>: a removal of what a run leaves. It starts as run starts a step (a process",
		"# group of its own), with no stdin and without fd 9, so nothing it leaves running holds the lock, and its group",
		"# is polled until the epoch second <by>. Past that, KILL to its processes that are still its own (kill_ours),",
		"# one stderr line naming <what> as left, LEFT set, and the helper goes on without waiting for them.",
		"bounded() {",
		'\t_by=$1; _what=$2; shift 2',
		'\tset -m; "$@" </dev/null 9>&- & _b=$!; set +m',
		"\twhile :; do",
		'\t\t/usr/bin/pgrep -g "$_b" >/dev/null',
		'\t\t[ "$?" -ne 1 ] || { wait "$_b"; return; }',
		'\t\t_n=$(/bin/date +%s) && [ "$_n" -lt "$_by" ] 2>/dev/null || break',
		"\t\t/bin/sleep 0.2",
		"\tdone",
		'\tkill_ours KILL "$_b" $(step_pids "$_b")',
		`\tLEFT=1; printf 'as2test-refresh: left %s: its removal did not end within the ${cleanupS} s cleanup bound\\n' "$_what" >&2; return 1`,
		"}",
		"# rm_tree <dir>: the dir's src and out, removed as the build user; root never opens a path in a build dir.",
		`rm_tree() { as_build ${o.cleanupStallS === undefined ? "" : `/bin/sh -c '/bin/sleep ${o.cleanupStallS}; exec "$@"' as2test-stall `}/bin/rm -rf "$1/src" "$1/out" 2>/dev/null; }`,
		"# remove_build <by> <dir>: a build dir removed, bounded by <by>: rm_tree, then the dir. When rm_tree is left, so",
		"# is the dir, with LEFT set. A removal that ends but fails (a file the build user made immutable, say) leaves the",
		"# dir too: a test of the dir's own name, builtins only and no path in it opened, then sets LEFT and says so.",
		"remove_build() {",
		"\tLEFT=",
		'\tbounded "$1" "the build dir $2" rm_tree "$2"',
		'\t[ -n "$LEFT" ] || bounded "$1" "the build dir $2" /bin/rm -rf "$2"',
		`\t[ -n "$LEFT" ] || { [ ! -e "$2" ] && [ ! -L "$2" ]; } || { LEFT=1; printf 'as2test-refresh: left the build dir %s: its removal failed\\n' "$2" >&2; }`,
		"}",
		`# stop <why>: on HUP, INT, TERM or the cap's ALRM. TERM to the running step's processes (as root it reaches the`,
		`# build user's processes too), KILL after ${REFRESH_KILL_GRACE_S} s to those still the step's, the .new staging files removed within the`,
		"# cleanup bound, and exit 71 with nothing renamed; cleanup (EXIT) then removes the build dir within what is left",
		"# of that bound. A signal between run's fork and its CHILD=, or during a bounded removal, finds the step through $!,",
		"# which is never the watchdog's group once a step has started.",
		"stop() {",
		"\ttrap '' HUP INT TERM ALRM",
		'\t_g=${CHILD:-$!}',
		'\t[ "$_g" != "$WATCHDOG" ] || _g=',
		'\t_k=$([ -z "$_g" ] || step_pids "$_g")',
		'\tif [ -n "$_k" ]; then',
		'\t\tkill_ours TERM "$_g" $_k',
		"\t\t_i=0",
		`\t\twhile [ "$_i" -lt ${REFRESH_KILL_GRACE_S * 5} ] && [ -n "$(still_ours "$_g" $_k)" ]; do /bin/sleep 0.2; _i=$((_i + 1)); done`,
		'\t\tkill_ours KILL "$_g" $_k',
		"\tfi",
		'\t[ -n "$CLEANUP_BY" ] || CLEANUP_BY=$(deadline)',
		'\tbounded "$CLEANUP_BY" "the .new staging files in $LIBEXEC" drop_new',
		`\tdie ${REFRESH_EXIT.build} "$1; nothing was installed"`,
		"}",
		"# cleanup: on EXIT, with signals ignored from here on. The watchdog's group ended; the build dir removed within the",
		"# cleanup bound (one deadline with stop's removal), found through $MADE when a signal came between mktemp and BUILD=.",
		"# A build dir left here is named in $MADE, and the next run removes it.",
		"cleanup() {",
		"\ttrap '' HUP INT TERM ALRM",
		'\t[ -z "$WATCHDOG" ] || { _w=$(step_pids "$WATCHDOG"); [ -z "$_w" ] || /bin/kill -TERM $_w 2>/dev/null; }',
		'\t[ -n "$BUILD" ] || [ -z "$MADE" ] || [ ! -s "$MADE" ] || IFS= read -r BUILD < "$MADE"',
		'\t[ -n "$BUILD" ] || return 0',
		'\t[ -n "$CLEANUP_BY" ] || CLEANUP_BY=$(deadline)',
		'\tremove_build "$CLEANUP_BY" "$BUILD"',
		"}",
		"",
		"# Signals and the cap. The runner caps the helper too, but Jo's user cannot signal a root process: it",
		"# signals only its own sudo, which may never pass the signal on. So the helper bounds itself: past",
		`# ${capS} s a watchdog signals it ALRM, only while the watchdog is still its child (so never a reused pid;`,
		"# pgrep's -a keeps the watchdog, its own ancestor, in the list), and stop ends it. The watchdog is a",
		"# process group of its own, as each step is, so cleanup ends it through step_pids.",
		"trap cleanup EXIT",
		`trap 'stop "ended by a signal"' HUP INT TERM`,
		`trap 'stop "stopped at its own ${capS} s cap"' ALRM`,
		"set -m",
		`/bin/sh -c '/bin/sleep "$1"; /usr/bin/pgrep -a -P "$2" | /usr/bin/grep -qx "$$" && /bin/kill -ALRM "$2"' as2test-watchdog ${capS} $$ </dev/null >/dev/null 2>&1 &`,
		"WATCHDOG=$!",
		"set +m",
		"",
		"# The lock: held by this shell's fd 9 until it exits, across the fetch, the build and every rename.",
		`run /dev/null /bin/mkdir -p -m 0700 "$STATE" || die ${REFRESH_EXIT.lock} "cannot make $STATE"`,
		'exec 9>>"$STATE/lock"',
		`run /dev/null /usr/bin/lockf -s -t ${lockWaitS} 9 || die ${REFRESH_EXIT.lock} "another refresh holds $STATE/lock (waited ${lockWaitS} s)"`,
		"",
		"# A build dir an earlier run left: its cleanup's removal passed the bound or failed, or that helper was killed. Under the lock",
		"# no other run's build dir exists; the last run's is the one named in $STAGE/build, the run's $MADE. If it is",
		"# still a dir of ours, made by mktemp's pattern, it goes within the cleanup bound before this run empties the",
		"# stage; if it is left again, the helper stops and the name stays for the next run.",
		"OLD_BUILD=",
		'[ ! -s "$STAGE/build" ] || IFS= read -r OLD_BUILD < "$STAGE/build" || OLD_BUILD=',
		`case "$OLD_BUILD" in ${REFRESH_BUILD_PARENT}/as2test-refresh.??????) case "\${OLD_BUILD##*.}" in *[!A-Za-z0-9]*) OLD_BUILD= ;; esac ;; *) OLD_BUILD= ;; esac`,
		`if [ -n "$OLD_BUILD" ] && run /dev/null /usr/bin/find "$OLD_BUILD" -maxdepth 0 -type d ${o.buildUser === null ? '-user "$OWN_U"' : `\\( -user ${shq(o.buildUser)} -o -user "$OWN_U" \\)`} > "$STAGE/stale" 2>/dev/null && [ -s "$STAGE/stale" ]; then`,
		'\tremove_build "$(deadline)" "$OLD_BUILD"',
		`\t[ -z "$LEFT" ] || die ${REFRESH_EXIT.build} "cannot remove $OLD_BUILD, the build dir an earlier run left, within ${cleanupS} s"`,
		"fi",
		`run /dev/null /bin/rm -rf "$STAGE" && run /dev/null /bin/mkdir -m 0700 "$STAGE" || die ${REFRESH_EXIT.build} "cannot empty $STAGE"`,
		"",
		"# The measured resource policy (review F2): every ordinary and proof part of the executor this helper installs",
		"# requires it, so without it, or with one that is not a regular file this helper's owner owns and no group or other",
		"# can write, nothing is fetched, built or replaced. The fetched commit's render-exec checks its content as well.",
		`run /dev/null /usr/bin/find "$LIBEXEC/${RESOURCE_POLICY}" -maxdepth 0 -type f -user "$OWN_U" ! -perm -0020 ! -perm -0002 > "$STAGE/policy" 2>/dev/null`,
		`[ -s "$STAGE/policy" ] || die ${REFRESH_EXIT.build} "$LIBEXEC/${RESOURCE_POLICY}, the measured resource policy the executor requires, is missing, not a regular file owned by $OWN_U, or group- or world-writable; nothing was fetched or installed: provision it with ${SETUP_RESOURCES}"`,
		"",
		`# The fetch: the ${AS2_VERIFIED_TAG} tag only (PLAN wl-mvq4edbaf13vnk § 2: the commit the runner verified), from ORIGIN only,`,
		"# into the root-owned mirror; its commit (an annotated tag peeled) is what the build checks out. Values a command",
		"# prints reach the shell through a stage file and read, a builtin, never a foreground $(...).",
		`[ -d "$MIRROR" ] || run /dev/null /usr/bin/git ${gitConfig} init -q --bare --template= "$MIRROR" >&2 || die ${REFRESH_EXIT.fetch} "cannot make the mirror $MIRROR"`,
		`run /dev/null g fetch -q --no-tags "$ORIGIN" '+refs/tags/${AS2_VERIFIED_TAG}:refs/tags/${AS2_VERIFIED_TAG}' >&2 || die ${REFRESH_EXIT.fetch} "fetching the ${AS2_VERIFIED_TAG} tag from $ORIGIN failed"`,
		`run /dev/null g rev-parse -q --verify 'refs/tags/${AS2_VERIFIED_TAG}^{commit}' > "$STAGE/sha" || die ${REFRESH_EXIT.fetch} "the mirror has no ${AS2_VERIFIED_TAG} tag naming a commit"`,
		`SHA=; IFS= read -r SHA < "$STAGE/sha" || die ${REFRESH_EXIT.fetch} "the mirror has no ${AS2_VERIFIED_TAG} tag naming a commit"`,
		`case "$SHA" in *[!0-9a-f]*) die ${REFRESH_EXIT.fetch} "the ${AS2_VERIFIED_TAG} tag's commit is not a sha" ;; esac`,
		`[ "\${#SHA}" -eq 40 ] || die ${REFRESH_EXIT.fetch} "the ${AS2_VERIFIED_TAG} tag's commit is not a full sha"`,
		`run /dev/null /usr/bin/awk '$1 == "source-sha" { print $2; exit }' "$LIBEXEC/SOURCE" > "$STAGE/old" 2>/dev/null`,
		'OLD=; IFS= read -r OLD < "$STAGE/old"',
		"# none without a SOURCE, or over a provisional one (setup's, before the first run).",
		'case "$OLD" in "" | *[!0-9a-f]*) OLD=none ;; esac',
		"",
		`# Current: the installed SOURCE is byte for byte what this helper would write for the ${AS2_VERIFIED_TAG} commit, so the`,
		"# installed files match it too. A legacy or foreign SOURCE never is, and is rebuilt.",
		'if [ -f "$LIBEXEC/SOURCE" ]; then',
		`\trun /dev/null /usr/bin/awk '$1 == "input" { print $2 }' "$LIBEXEC/SOURCE" > "$STAGE/inputs.installed" || die ${REFRESH_EXIT.build} "cannot read $LIBEXEC/SOURCE"`,
		`\trun /dev/null write_source "$LIBEXEC/exec" "$LIBEXEC/test-exec.js" "$STAGE/inputs.installed" > "$STAGE/SOURCE.current" || die ${REFRESH_EXIT.build} "cannot write $STAGE/SOURCE.current"`,
		`\tif run /dev/null /usr/bin/cmp -s "$STAGE/SOURCE.current" "$LIBEXEC/SOURCE"; then printf 'current %.12s\\n' "$SHA"; exit 0; fi`,
		"fi",
		"",
		`# The build, as ${o.buildUser ?? "the caller"}: the fetched code never runs as root.`,
		'MADE="$STAGE/build"',
		`run /dev/null /usr/bin/mktemp -d ${REFRESH_BUILD_PARENT}/as2test-refresh.XXXXXX > "$MADE" || die ${REFRESH_EXIT.build} "cannot make a build directory"`,
		`IFS= read -r BUILD < "$MADE" || die ${REFRESH_EXIT.build} "cannot make a build directory"`,
		`run /dev/null /bin/mkdir "$BUILD/src" "$BUILD/out" || die ${REFRESH_EXIT.build} "cannot make $BUILD/src and $BUILD/out"`,
		...(o.buildUser === null ? [] : [`run /dev/null /usr/sbin/chown -R ${shq(o.buildUser)} "$BUILD" || die ${REFRESH_EXIT.build} "cannot hand $BUILD to ${o.buildUser}"`]),
		`run /dev/null g archive --format=tar -o "$STAGE/src.tar" "$SHA" || die ${REFRESH_EXIT.build} "git archive of $SHA failed"`,
		`run "$STAGE/src.tar" as_build /usr/bin/tar -x -f - -C "$BUILD/src" || die ${REFRESH_EXIT.build} "unpacking $SHA failed"`,
		'run /dev/null /bin/rm -f "$STAGE/src.tar"',
		`run /dev/null build_step - "$BUN" build --target=bun --outfile="$BUILD/out/test-exec.js" --metafile="$BUILD/out/meta.json" surface/scripts/test-exec.ts || die ${REFRESH_EXIT.build} "bun build of surface/scripts/test-exec.ts at $SHA failed"`,
		`run /dev/null build_step "$BUILD/out/inputs" "$BUN" surface/src/as2test.ts bundle-inputs "$BUILD/out/meta.json" "$BUILD/src" || die ${REFRESH_EXIT.build} "as2test.ts bundle-inputs at $SHA failed"`,
		`run /dev/null build_step "$BUILD/out/exec" "$BUN" surface/src/as2test.ts render-exec --root "$ROOT" --bun "$LIBEXEC/bun" --script "$LIBEXEC/test-exec.js" --sweep-scope uid || die ${REFRESH_EXIT.build} "as2test.ts render-exec at $SHA failed (its reason is on the line above)"`,
		"take exec",
		"take test-exec.js",
		"take inputs",
		"",
		"# The checks, on the staged copies only.",
		`[ -s "$STAGE/exec" ] || die ${REFRESH_EXIT.build} "the built exec is empty"`,
		`[ -s "$STAGE/test-exec.js" ] || die ${REFRESH_EXIT.build} "the built test-exec.js is empty"`,
		`[ -s "$STAGE/inputs" ] || die ${REFRESH_EXIT.build} "bundle-inputs listed no input"`,
		`run /dev/null check_inputs || exit ${REFRESH_EXIT.build}`,
		`run /dev/null write_source "$STAGE/exec" "$STAGE/test-exec.js" "$STAGE/inputs" > "$STAGE/SOURCE" || die ${REFRESH_EXIT.build} "cannot write $STAGE/SOURCE"`,
		`if run /dev/null /usr/bin/grep -q ' missing$' "$STAGE/SOURCE"; then die ${REFRESH_EXIT.build} "the new SOURCE lacks a hash"; fi`,
		"",
		"# The install: each staged copy to a dotted .new name, then one rename each, SOURCE last.",
		"for f in exec test-exec.js SOURCE; do",
		`\trun /dev/null stage_new "$f" || { run /dev/null drop_new; die ${REFRESH_EXIT.install} "installing $f into $LIBEXEC failed"; }`,
		"done",
		"# The renames, SOURCE last. Signals are ignored for these three, so a signal never leaves them half done.",
		"# They are the one foreground stretch the cap does not reach, and need not: each is one rename(2) of a",
		"# root-owned file within LIBEXEC, one directory on one volume, which moves no data and waits on no",
		"# other process.",
		"trap '' HUP INT TERM ALRM",
		"for f in exec test-exec.js SOURCE; do",
		`\t/bin/mv -f "$LIBEXEC/.$f.new" "$LIBEXEC/$f" || die ${REFRESH_EXIT.install} "moving $f into place in $LIBEXEC failed"`,
		"done",
		`printf 'refreshed %.12s..%.12s\\n' "$OLD" "$SHA"`,
		"",
	].join("\n");
}

/** The sha-256 a provisional SOURCE records for `exec` and `test-exec.js`, which only the helper builds: no file has it. */
const NO_FILE_SHA = "0".repeat(64);

/**
 * The provisional SOURCE install/as2test-setup.sh installs before the helper's first run (CODE-REVIEW-r1
 * finding 1). It records everything setup owns, from the options the helper is rendered with (the facts
 * and the created list) and the sha-256 of the installed `bun` and `refresh`, so --undo and a re-run of
 * setup read it like any SOURCE. `source` and `source-sha` are PROVISIONAL and it lists no input, so the
 * helper never answers `current` over it; `exec` and `test-exec.js` carry a sha-256 no file has, so
 * installDecision calls the install `file-drift` and the runner's preflight runs the helper.
 */
export function renderProvisionalSource(o: RefreshHelperOptions, hashes: { bun: string; refresh: string }): string {
	const { facts } = refreshSourceLines(o);
	for (const [k, v] of Object.entries(hashes)) if (typeof v !== "string" || !HEX64.test(v)) throw new WrapperRenderError(`the ${k} sha-256 must be 64 hex digits: ${String(v)}`);
	const text = [
		`# as2test SOURCE, provisional: written by install/as2test-setup.sh before ${join(o.libexec, "refresh")} first runs and replaces it; read by the runner's preflight (parseSource) and by install/as2test-setup.sh --undo`,
		"version 1", `source ${PROVISIONAL}`, `source-sha ${PROVISIONAL}`, ...facts,
		`file exec ${NO_FILE_SHA}`, `file bun ${hashes.bun}`, `file test-exec.js ${NO_FILE_SHA}`, `file refresh ${hashes.refresh}`, "",
	].join("\n");
	const parsed = parseSource(text);
	if (!parsed.ok) throw new WrapperRenderError(`the provisional SOURCE would not parse: ${parsed.error}`);
	return text;
}

/**
 * `render-refresh`'s flags, which `render-provisional-source` shares: each valued flag once (`--created`
 * repeats), plus `--as-root` and `--allow-file-protocol`, and the command's own `extra` valued flags.
 */
function refreshArgv(cmd: string, argv: string[], extra: readonly string[] = []): { options: RefreshHelperOptions; extra: Record<string, string> } {
	const valued = ["--origin", "--libexec", "--root", "--bun", "--user", "--uid", "--gid", "--jo", "--jo-uid", "--bun-version", "--created", "--build-user", "--lock-wait-s", ...extra];
	const switches = ["--as-root", "--allow-file-protocol"];
	const one = new Map<string, string>();
	const created: string[] = [];
	const on = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i]!;
		if (switches.includes(k)) {
			on.add(k);
			continue;
		}
		if (!valued.includes(k) || i + 1 >= argv.length) throw new WrapperRenderError(`${cmd}: unknown flag or missing value: ${k}`);
		const v = argv[++i]!;
		if (k === "--created") created.push(v);
		else if (one.has(k)) throw new WrapperRenderError(`${cmd}: ${k} given twice`);
		else one.set(k, v);
	}
	const need = (k: string): string => {
		const v = one.get(k);
		if (v === undefined) throw new WrapperRenderError(`${cmd} needs ${k}`);
		return v;
	};
	const int = (k: string): number => {
		const v = need(k);
		if (!/^[0-9]+$/.test(v)) throw new WrapperRenderError(`${cmd}: ${k} must be a whole number`);
		return Number(v);
	};
	const options: RefreshHelperOptions = {
		origin: one.get("--origin") ?? AS2TEST_ORIGIN,
		libexec: need("--libexec"),
		root: need("--root"),
		bun: need("--bun"),
		facts: { bunVersion: need("--bun-version"), user: need("--user"), uid: int("--uid"), gid: int("--gid"), jo: need("--jo"), joUid: int("--jo-uid"), created },
		buildUser: one.get("--build-user") ?? null,
		asRoot: on.has("--as-root"),
		lockWaitS: one.has("--lock-wait-s") ? int("--lock-wait-s") : undefined,
		allowFileProtocol: on.has("--allow-file-protocol"),
	};
	return { options, extra: Object.fromEntries(extra.map((k) => [k, need(k)])) };
}

// ---- the setup script's helpers ------------------------------------------------------------------

/** The bundle's inputs from `bun build --metafile` JSON, as paths relative to `checkout`, sorted; bun's own builtins left out. */
export function bundleInputs(metafileJson: string, checkout: string, cwd: string): string[] {
	const meta: unknown = JSON.parse(metafileJson);
	if (!meta || typeof meta !== "object" || !("inputs" in meta) || !meta.inputs || typeof meta.inputs !== "object") throw new Error("metafile has no inputs");
	const out = new Set<string>();
	for (const key of Object.keys(meta.inputs)) {
		if (key.startsWith("bun:") || key.startsWith("node:")) continue;
		const rel = relative(checkout, resolve(cwd, key));
		if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`bundle input ${key} lies outside ${checkout}`);
		out.add(rel);
	}
	if (out.size === 0) throw new Error("metafile lists no input");
	return [...out].sort();
}

function cli(argv: string[]): number {
	const [cmd, ...rest] = argv;
	const flag = (k: string): string | undefined => {
		const i = rest.indexOf(k);
		return i >= 0 ? rest[i + 1] : undefined;
	};
	try {
		if (cmd === "validate-resources") {
			process.stdout.write(`${JSON.stringify(parseResourceCosts(JSON.parse(readFileSync(flag("--file") ?? "", "utf8"))))}\n`);
			return 0;
		}
		if (cmd === "render-runtime-config") {
			const root = flag("--runtime-root") ?? "";
			const source = flag("--artifact") ?? root;
			const pin = parseInstalledOmp({ root, treeSha256: runtimeTreeHash(source), version: flag("--version") ?? "" });
			process.stdout.write(`${JSON.stringify(pin)}\n`);
			return 0;
		}
		if (cmd === "verify-runtime-config") {
			process.stdout.write(`${JSON.stringify(readInstalledOmp(flag("--file") ?? ""))}\n`);
			return 0;
		}
		if (cmd === "render-exec") {
			// execConfigOf refuses any scope but uid or groups, and a missing or relative path.
			const options: ExecWrapperOptions = { root: flag("--root") ?? "", bun: flag("--bun") ?? "", script: flag("--script") ?? "", sweepScope: flag("--sweep-scope") as SweepScope,
				resourcesPath: flag("--resources-path"), ompRuntimePath: flag("--omp-runtime-path") };
			// Every refresh helper builds the executor through this command, so this is where activation refuses the executor
			// its required policy is absent or invalid for, before any helper stages or replaces a file (review F2).
			const refused = activationPolicyError(execConfigOf(options).resourcesPath);
			if (refused !== null) throw new Error(`render-exec: refusing to render an executor that cannot admit a test part: ${refused}; nothing was rendered. Provision the measured policy with ${SETUP_RESOURCES}, then refresh`);
			process.stdout.write(renderExecWrapper(options));
			return 0;
		}
		if (cmd === "render-refresh") {
			process.stdout.write(renderRefreshHelper(refreshArgv(cmd, rest).options));
			return 0;
		}
		if (cmd === "render-provisional-source") {
			const { options, extra } = refreshArgv(cmd, rest, ["--bun-sha", "--refresh-sha"]);
			process.stdout.write(renderProvisionalSource(options, { bun: extra["--bun-sha"]!, refresh: extra["--refresh-sha"]! }));
			return 0;
		}
		if (cmd === "bundle-inputs" && rest.length === 2) {
			const [metafile, checkout] = rest as [string, string];
			process.stdout.write(`${bundleInputs(readFileSync(metafile, "utf8"), resolve(checkout), process.cwd()).join("\n")}\n`);
			return 0;
		}
	} catch (e) {
		process.stderr.write(`as2test: ${(e as Error).message}\n`);
		return 1;
	}
	process.stderr.write(
		[
			"usage: bun surface/src/as2test.ts render-exec --root R --bun B --script S --sweep-scope uid|groups",
			"       bun surface/src/as2test.ts render-refresh --libexec L --root R --bun B --user U --uid N --gid N --jo J --jo-uid N --bun-version V",
			"                                  [--created C]... [--origin URL] [--build-user U] [--as-root] [--lock-wait-s N] [--allow-file-protocol]",
			"       bun surface/src/as2test.ts render-provisional-source <render-refresh's flags> --bun-sha SHA256 --refresh-sha SHA256",
			"       bun surface/src/as2test.ts bundle-inputs <metafile.json> <checkout>",
			"       bun surface/src/as2test.ts validate-resources --file <measured-resources.json>",
			"       bun surface/src/as2test.ts render-runtime-config --artifact <verified-tree> --runtime-root <fixed-install-root> --version <exact-stdout>",
			"       bun surface/src/as2test.ts verify-runtime-config --file <root-owned-installed-omp.json>",
			"",
		].join("\n"),
	);
	return 2;
}

if (import.meta.main) process.exit(cli(process.argv.slice(2)));
