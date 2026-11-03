// hook-marker: atomic `.reached` publication (workload wl-mw01xdcflkdnq0, slice sl-lf-marker: the sl-timing-marker batch).
// Once its `.pause` is armed, a hook publishes `<base>.reached` (its pid, the time and its info), and test readers parse
// it as soon as the file exists (test-runner.test.ts `reached`, as2test.test.ts). A plain writeFileSync creates the file
// and then fills it, so such a reader can read it empty or half written: `SyntaxError: JSON Parse error: Unexpected EOF`
// (main run tr-0mvzppuviapf3ya at ddcffa60). The three writers (the synchronous and asynchronous runner hooks in
// surface/scripts/test-runner.ts, the executor hook in surface/scripts/test-exec.ts) write a temporary file beside
// `.reached` and rename it over, so a reader sees no file or the whole payload.
//
// Method: a write seam. Each writer runs as its own bun process under a preload (SEAM) that replaces fs.writeFileSync for
// paths in the hooks directory: it writes the first half of the data, announces the hold with a file in the seam
// directory, blocks opening a FIFO until the test opens its other end, then writes the rest. While the writer is held
// mid-write the test reads `.reached`: an atomic publisher has nothing there yet (the half sits in its temporary file),
// a plain writeFileSync shows the half payload. The seam also replaces fs.existsSync: a hook polls `<base>.go` only once
// it has published, so the writer's first look for a hooks-directory `.go` announces "published" with a file in the wait
// directory, and the test then reads `.reached` once more, expecting the complete payload.
//
// Every wait is on a real event (a directory event or the writer's exit); no sleep, no timer. Each wait watches its own
// directory, where the event it waits for is the first one: Bun 1.3.14's fs.watch drops an event that comes within about
// a millisecond of the last one it emitted to the same listener when either the event type or the file name repeats
// (`ChangeEvent.shouldEmit` in src/runtime/node/path_watcher.zig). Waiting on hooks-directory events for the rename
// that publishes `.reached` hung the executor case on Linux (as2-hosted run 41573373058): there inotify delivers the
// temporary file's create at once, and when the hold and release fit in that window the second-half write, the rename
// away and the rename onto `.reached` can all be dropped, so no event follows the publication. The runner hooks append
// `.marks` before the hold, which in practice leaves the rename onto `.reached` an event that differs in both type and
// name from the last one emitted; no wait here depends on that.
import { afterAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { closeSync, existsSync, type FSWatcher, mkdirSync, openSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./helpers";

const SCRIPTS = join(import.meta.dir, "..", "scripts");
const RUNNER = join(SCRIPTS, "test-runner.ts");
const EXEC = join(SCRIPTS, "test-exec.ts");

/**
 * The preload in the writer's process: it holds every hooks-directory writeFileSync half written until the test releases
 * it, and announces the writer's first look for a hooks-directory `.go` (the hook has published) in the wait directory.
 * Its own signal files (`held-N`, `waiting`) appear whole and in one event: written in the box directory, which nothing
 * watches, then renamed into the watched one. A plain write let hosted Linux read `waiting` empty between its create and
 * its write (run 41593591693); a temporary file beside it gave the watcher two events within a millisecond, which Bun
 * 1.3.14's fs.watch can collapse (sl-lf-marker-linux), and the next hosted Linux run's synchronous case hung (run 41595494185).
 */
const SEAM = `const fs = require("node:fs");
const { dirname, join } = require("node:path");
const { hooks, seam, wait } = JSON.parse(process.env.HOOK_MARKER_SEAM);
const plain = fs.writeFileSync;
const exists = fs.existsSync;
const signal = (path, text) => {
	const temp = join(dirname(dirname(path)), "." + process.pid + ".signal");
	plain(temp, text);
	fs.renameSync(temp, path);
};
let holds = 0;
let waiting = false;
fs.writeFileSync = (path, data, opts) => {
	if (typeof path !== "string" || dirname(path) !== hooks || typeof data !== "string") return plain(path, data, opts);
	const o = typeof opts === "object" && opts !== null ? opts : {};
	const bytes = Buffer.from(data);
	const half = bytes.length >> 1;
	const fd = fs.openSync(path, o.flag ?? "w", o.mode ?? 0o666);
	try {
		let at = 0;
		while (at < half) at += fs.writeSync(fd, bytes, at, half - at);
		signal(join(seam, "held-" + holds++), path);
		fs.closeSync(fs.openSync(join(seam, "release"), "r"));
		while (at < bytes.length) at += fs.writeSync(fd, bytes, at, bytes.length - at);
	} finally {
		fs.closeSync(fd);
	}
};
fs.existsSync = (path) => {
	if (!waiting && typeof path === "string" && dirname(path) === hooks && path.endsWith(".go")) {
		waiting = true;
		signal(join(wait, "waiting"), path);
	}
	return exists(path);
};
`;

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Box {
	dir: string;
	hooks: string;
	seam: string;
	/** Where the seam announces the writer's first look for `.go`: its own directory, so that create is its watcher's first event. */
	wait: string;
	preload: string;
}
async function box(tag: string): Promise<Box> {
	const dir = tmp(`hook-marker-${tag}`);
	dirs.push(dir);
	const hooks = join(dir, "hooks");
	const seam = join(dir, "seam");
	const wait = join(dir, "wait");
	for (const d of [hooks, seam, wait]) mkdirSync(d);
	// Async Bun.spawn, never Bun.spawnSync: under a parallel `bun test` on Linux a spawnSync can spin forever beside its
	// exited, unreaped child, mkfifo among those seen (oven-sh/bun#46488).
	const release = join(seam, "release");
	const fifo = Bun.spawn(["mkfifo", release], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
	const code = await fifo.exited;
	if (code !== 0) throw new Error(`mkfifo ${release} exited ${code}: ${await new Response(fifo.stderr).text()}`);
	const preload = join(dir, "seam.js");
	writeFileSync(preload, SEAM);
	return { dir, hooks, seam, wait, preload };
}

/** A directory's events as a count: `after(n)` settles once more than `n` have arrived, and rejects on a watcher error. */
interface DirEvents {
	readonly count: number;
	after(n: number): Promise<void>;
	close(): void;
}
function events(dir: string): DirEvents {
	let count = 0;
	let failure: Error | null = null;
	const waiters: PromiseWithResolvers<void>[] = [];
	const w: FSWatcher = watch(dir, () => {
		count++;
		for (const x of waiters.splice(0)) x.resolve();
	});
	w.on("error", (e: Error) => {
		failure = new Error(`watching ${dir}: ${e.message}`);
		for (const x of waiters.splice(0)) x.reject(failure);
	});
	return {
		get count() {
			return count;
		},
		after(n) {
			if (failure) return Promise.reject(failure);
			if (count > n) return Promise.resolve();
			const x = Promise.withResolvers<void>();
			waiters.push(x);
			return x.promise;
		},
		close: () => w.close(),
	};
}

/** `probe()`'s first defined answer, read again at every event of `ev`; the writer exiting first is an error naming its stderr. */
async function whenSeen<T>(what: string, ev: DirEvents, writer: Subprocess<"ignore", "pipe", "pipe">, probe: () => T | undefined): Promise<T> {
	for (;;) {
		const n = ev.count;
		const v = probe();
		if (v !== undefined) return v;
		const exited = await Promise.race([ev.after(n).then(() => false), writer.exited.then(() => true)]);
		if (exited) {
			const last = probe();
			if (last !== undefined) return last;
			throw new Error(`${what}: the writer (pid ${writer.pid}) exited ${writer.exitCode} first; stderr: ${await new Response(writer.stderr).text()}`);
		}
	}
}

/** `.reached` as the concurrent reader sees it: absent (null) or its bytes. */
function readReached(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

interface Case {
	/** The writer's argv after `bun --preload <seam>`. */
	argv: string[];
	env: Record<string, string>;
	/** `<hooks>/<id>.<point>`. */
	base: string;
	/** What the complete payload holds besides pid and at. */
	info: Record<string, unknown>;
	/** The hooks directory's entries once the writer has exited after `.go`. */
	after: string[];
}

/**
 * Arms `<base>.pause`, starts the writer under the seam, reads `.reached` while the writer is held mid-write, releases it,
 * reads `.reached` again once the writer first looks for `.go` (it has published), then lets it go with `.go` and checks
 * its exit and the directories.
 */
async function publishes(b: Box, c: Case): Promise<void> {
	writeFileSync(`${c.base}.pause`, "");
	const reached = `${c.base}.reached`;
	const held0 = join(b.seam, "held-0");
	const waiting = join(b.wait, "waiting");
	const seamEv = events(b.seam);
	const waitEv = events(b.wait);
	const writer = Bun.spawn([process.execPath, "--preload", b.preload, ...c.argv], {
		env: { ...process.env, ...c.env, HOOK_MARKER_SEAM: JSON.stringify({ hooks: b.hooks, seam: b.seam, wait: b.wait }) },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		await whenSeen("the seam's hold", seamEv, writer, () => (existsSync(held0) ? true : undefined));
		// The writer is blocked between the two halves of its one write: this read is the concurrent reader at its worst moment.
		const held = readReached(reached);
		closeSync(openSync(join(b.seam, "release"), "w"));
		await whenSeen("the writer's first look for .go", waitEv, writer, () => (existsSync(waiting) ? true : undefined));
		// A hook looks for `.go` only after it has published: `.reached` now holds the whole payload.
		const published = readReached(reached);
		if (published === null) throw new Error(`${reached} is missing once the writer (pid ${writer.pid}) looks for ${c.base}.go`);
		const complete = JSON.parse(published) as Record<string, unknown>;
		// A partial payload read during the hold throws here: the failure F4 names (`JSON Parse error: Unexpected EOF`).
		for (const text of [held, published]) if (text !== null) expect(JSON.parse(text)).toEqual(complete);
		expect(held).toBeNull();
		expect(complete).toEqual({ pid: writer.pid, at: expect.any(Number), ...c.info });
		// The write went through the seam exactly once, at a path beside `.reached`; the first `.go` looked for is this hook's.
		const heldPath = readFileSync(held0, "utf8");
		expect(heldPath.startsWith(`${b.hooks}/`)).toBe(true);
		expect(heldPath).not.toBe(reached);
		expect(readFileSync(waiting, "utf8")).toBe(`${c.base}.go`);
		writeFileSync(`${c.base}.go`, "");
		const exit = await writer.exited;
		expect({ exit, stderr: await new Response(writer.stderr).text() }).toEqual({ exit: 0, stderr: "" });
		expect(readdirSync(b.seam).sort()).toEqual(["held-0", "release"]);
		expect(readdirSync(b.wait)).toEqual(["waiting"]);
		expect(readdirSync(b.hooks).sort()).toEqual(c.after);
	} finally {
		seamEv.close();
		waitEv.close();
		if (writer.exitCode === null && writer.signalCode === null) {
			writer.kill("SIGKILL");
			await writer.exited;
		}
	}
}

/** A bun process that imports the runner's hooks and passes `point` once, with info. */
function runnerCase(b: Box, kind: "sync" | "async", point: string): Case {
	const child = join(b.dir, "runner-hook.ts");
	writeFileSync(
		child,
		`import { hook, hookSync } from ${JSON.stringify(RUNNER)};
const [kind, id, point] = process.argv.slice(2);
const info = { point, note: "the writer's info" };
if (kind === "sync") hookSync(id, point, info);
else await hook(id, point, info);
`,
	);
	const id = "tr-hookmark1";
	return {
		argv: [child, kind, id, point],
		env: { AGENT_SYSTEM_TEST_HOOKS: b.hooks },
		base: join(b.hooks, `${id}.${point}`),
		info: { point, note: "the writer's info" },
		after: [`${id}.${point}.marks`],
	};
}

describe("a hook publishes `.reached` atomically: a concurrent reader sees no file or the whole payload with the writer's pid", () => {
	test("the synchronous runner hook (hookSync)", async () => {
		const b = await box("sync");
		await publishes(b, runnerCase(b, "sync", "acquire-tx"));
	}, 30_000);

	test("the asynchronous runner hook (hook)", async () => {
		const b = await box("async");
		await publishes(b, runnerCase(b, "async", "sweep"));
	}, 30_000);

	test("the executor hook (test-exec.ts, at a groups sweep's sweep-read1)", async () => {
		const b = await box("exec");
		const root = join(b.dir, "root");
		for (const d of ["stage", "runs", "locks"]) mkdirSync(join(root, d), { recursive: true });
		writeFileSync(join(root, "locks", "sweep.db"), "", { mode: 0o600 });
		const runId = "tr-hookmark3";
		writeFileSync(join(root, "stage", "current"), `${runId}\n`);
		const config = {
			root, bun: process.execPath, sweep: "groups", hooks: b.hooks, killGraceMs: 0, sweepLockWaitMs: 60_000, captureMs: 0,
			resourcesPath: join(root, "resources.json"), ompRuntimePath: join(root, "installed-omp.json"),
			detectTickMs: 1, detectPersistMs: 0, signatureCaptureMs: 0, stopGraceMs: 0, detectTrace: false,
		};
		const base = join(b.hooks, `${runId}.sweep-read1`);
		await publishes(b, {
			argv: [EXEC, "sweep", runId],
			env: { AS2TEST_EXEC_CONFIG: JSON.stringify(config) },
			base,
			info: {},
			// The executor hook leaves its files to the test that armed it.
			after: [`${runId}.sweep-read1.go`, `${runId}.sweep-read1.pause`, `${runId}.sweep-read1.reached`],
		});
	}, 30_000);
});
