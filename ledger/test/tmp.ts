// Test temp dirs that are removed however the test process ends (PLAN wl-mv8mof9kktbh1c § 2).
//
// Every temp dir a test makes lives inside a run root: `<parent>/as2-test-run-<16 hex>`. A run root is
// created by its own watchdog, a detached `/bin/sh` (script W) that makes the root with an atomic mkdir,
// acks with its pid inside it, then blocks reading a pipe from this process. When this process ends for
// any reason (normal end, crash, SIGKILL, a kill of bun's process group) the kernel closes the pipe and
// the watchdog removes the root, and only a root its own mkdir created. In-process cleanup
// (cleanupTestTmp) empties the roots but never removes a root path itself, so no pathname is released
// and then deleted a second time.
//
// A root is trusted by identity, not by pathname: its dev and ino are recorded at the ack, and
// cleanupTestTmp touches a root (or a dir registered in it) only while lstat of the root path is still a
// real directory, not a symlink, with that dev and ino. The watchdog records `ls -di` of its root after
// its mkdir and removes the root only if the path is not a symlink and `ls -di` still matches. A root
// renamed away and replaced (by a symlink or by another dir) is left alone. The bound: the check and the
// rm are two steps, so a same-user process that swaps the root in the window between them is not covered.
//
// Importing this module does nothing by itself: a process that only imports a test helper (a fake
// binary such as surface/test/fake-omp.ts) keeps its own TMPDIR and signal handling. The preload
// (isolate-preload.ts) calls initTestTmp() first: the main root is made then, and process.env.TMPDIR
// points into it, so every later `tmpdir()` in the test process, and every child given `process.env`,
// lands inside it. Any other process makes its main root at its first tmpDir().
import type { Subprocess } from "bun";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { constants, getPriority, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * The watchdog script: argv `$1` is the root it creates, acks in, and removes once its stdin closes, only
 * while `$1` is not a symlink and `ls -di` still shows the inode its mkdir made.
 */
export const W =
	'mkdir -m 700 -- "$1" || exit 0; i=$(ls -di -- "$1"); printf "%s\\n" "$$" > "$1/.as2-watchdog"; cat >/dev/null; ' +
	'[ ! -L "$1" ] && [ "$(ls -di -- "$1" 2>/dev/null)" = "$i" ] && rm -rf -- "$1"';

/** The ack file a watchdog writes inside its root: its pid and a newline. */
const ACK_FILE = ".as2-watchdog";
const RUN_ROOT_NAME = /^as2-test-run-[0-9a-f]{16}$/;
const ATTEMPTS = 3;
const EXIT_WAIT_MS = 5000;
const TICK_MS = 2;

// Test-only seams (ledger/test/tmp-cleanup.test.ts T8, T11, T12): the shell, the script, the ack deadline.
const SH = process.env.AS2_TEST_TMP_SH || "/bin/sh";
const SCRIPT = process.env.AS2_TEST_TMP_WATCHDOG_SCRIPT || W;
const ACK_MS = Number(process.env.AS2_TEST_TMP_ACK_MS) > 0 ? Number(process.env.AS2_TEST_TMP_ACK_MS) : 5000;

/** Synchronous 2 ms ticks: the preload must hold the test run until the root is acked. */
const tick = new Int32Array(new SharedArrayBuffer(4));

/** Run roots by parent dir; each value is a root its own watchdog created and acked. */
const roots = new Map<string, string>();
/** Each run root's lstat dev and ino, recorded at its ack. */
const identities = new Map<string, { dev: bigint; ino: bigint }>();
/** Every dir tmpDir() handed out, mapped to the run root it sits directly in. */
const registered = new Map<string, string>();
/** Watchdogs whose roots are in use; held so their stdin pipes stay open for the life of the process. */
const watchdogs: Watchdog[] = [];

/**
 * A watchdog: Bun.spawn rather than node:child_process, because its stdin `end()` closes the pipe at once,
 * inside a synchronous wait; a node child's `stdin.destroy()` closes it only on a later event-loop turn.
 */
type Watchdog = Subprocess<"pipe", "ignore", "ignore">;

/**
 * Exited, as far as a synchronous wait can tell. A child this process has not reaped yet is a zombie:
 * `kill(pid, 0)` still succeeds on it, so `getpriority` (ESRCH for a zombie on macOS) is checked too.
 */
function exited(pid: number): boolean {
	for (const probe of [() => process.kill(pid, 0), () => getPriority(pid)]) {
		try {
			probe();
		} catch (e) {
			if (e instanceof Error && (("code" in e && e.code === "ESRCH") || e.message.includes("ESRCH"))) return true;
		}
	}
	return false;
}

function acked(path: string, pid: number): boolean {
	try {
		return readFileSync(join(path, ACK_FILE), "utf8") === `${pid}\n`;
	} catch {
		return false;
	}
}

/** The root path is still the dir its watchdog made: lstat is a real directory with the dev and ino seen at the ack. */
function sameRoot(root: string): boolean {
	const id = identities.get(root);
	if (!id) return false;
	let st;
	try {
		st = lstatSync(root, { bigint: true });
	} catch {
		return false;
	}
	return st.isDirectory() && !st.isSymbolicLink() && st.dev === id.dev && st.ino === id.ino;
}

/** One attempt: the acked root's watchdog, or the reason it failed (after the watchdog is done). */
function tryRoot(path: string): Watchdog | string {
	let dog: Watchdog;
	try {
		dog = Bun.spawn([SH, "-c", SCRIPT, "as2-test-tmp-watchdog", path], { detached: true, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
	} catch (e) {
		return `spawn ${SH}: ${e instanceof Error ? e.message : String(e)}`;
	}
	const pid = dog.pid;
	let reason = `no ack in ${ACK_MS} ms`;
	for (const deadline = Date.now() + ACK_MS; Date.now() < deadline; Atomics.wait(tick, 0, 0, TICK_MS)) {
		if (acked(path, pid)) {
			// The root's identity, for sameRoot(); a path that is not a real directory here never passes it.
			const st = lstatSync(path, { bigint: true, throwIfNoEntry: false });
			if (st) identities.set(path, { dev: st.dev, ino: st.ino });
			dog.unref();
			dog.stdin.unref();
			return dog;
		}
		if (exited(pid)) {
			reason = "the watchdog exited before its ack (its mkdir failed)";
			break;
		}
	}
	// Failed init: close its stdin, never kill it. A watchdog that did create the root removes it on EOF.
	dog.stdin.end();
	dog.unref();
	let settled = false;
	for (const deadline = Date.now() + EXIT_WAIT_MS; Date.now() < deadline; Atomics.wait(tick, 0, 0, TICK_MS)) {
		if (exited(pid) && !existsSync(path)) {
			settled = true;
			break;
		}
	}
	return settled ? reason : `${reason}; the watchdog was not done ${EXIT_WAIT_MS} ms after its stdin closed`;
}

/** The run root for `parent` (one per distinct parent, cached); throws when no watched root could be made. */
export function runRoot(parent: string): string {
	const known = roots.get(parent);
	if (known) return known;
	const reasons: string[] = [];
	for (let i = 0; i < ATTEMPTS; i++) {
		const path = join(parent, `as2-test-run-${randomBytes(8).toString("hex")}`);
		const got = tryRoot(path);
		if (typeof got === "string") {
			reasons.push(got);
			continue;
		}
		watchdogs.push(got);
		roots.set(parent, path);
		return path;
	}
	throw new Error(`as2 test tmp: no watched run root (${reasons.join("; ")})`);
}

/** A fresh dir `<prefix>XXXXXX` inside a watched run root, registered for cleanup: the run root made under
 * `parent` when given (a test that needs a short path), else LEDGER_TEST_TMP's, else the main run root. */
export function tmpDir(prefix: string, parent?: string): string {
	const root = parent ? runRoot(parent) : process.env.LEDGER_TEST_TMP ? runRoot(process.env.LEDGER_TEST_TMP) : mainRoot();
	const dir = mkdtempSync(join(root, prefix));
	registered.set(dir, root);
	return dir;
}

/**
 * Empties every run root (keeping its ack file) and leaves the root dirs to their watchdogs. Idempotent.
 * A root that fails sameRoot() (renamed away, replaced) is skipped, and so is every dir registered in it.
 */
export function cleanupTestTmp(): void {
	for (const [dir, root] of registered) {
		if (!sameRoot(root)) continue;
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
	registered.clear();
	for (const root of roots.values()) {
		if (!sameRoot(root)) continue;
		let names: string[];
		try {
			names = readdirSync(root);
		} catch {
			continue;
		}
		for (const name of names) {
			if (name === ACK_FILE) continue;
			try {
				rmSync(join(root, name), { recursive: true, force: true });
			} catch {}
		}
	}
}

let main: string | null = null;

/**
 * The main run root, made at the first call; TMPDIR then points into it. A startup tmpdir that is itself
 * a live run root (a nested `bun test` given its parent's TMPDIR) puts this root beside it, never inside
 * it, so ending the parent never deletes a live child's root.
 */
export function mainRoot(): string {
	if (main === null) {
		const start = tmpdir();
		const base = RUN_ROOT_NAME.test(basename(start)) && existsSync(join(start, ACK_FILE)) ? dirname(start) : start;
		main = runRoot(base);
		process.env.TMPDIR = main;
		process.on("exit", cleanupTestTmp);
	}
	return main;
}

let initialized = false;

/**
 * The preload's call, once per `bun test` process: the main root now, and in-process cleanup on SIGINT,
 * SIGTERM and SIGHUP, which then exit 128 + the signal number. Only the test runner's own process takes
 * over those signals; the watchdog removes the root however any process ends.
 */
export function initTestTmp(): void {
	if (initialized) return;
	initialized = true;
	mainRoot();
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => {
			cleanupTestTmp();
			process.exit(128 + constants.signals[signal]);
		});
	}
}
