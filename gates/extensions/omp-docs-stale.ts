// Stale OMP docs (PLAN wl-mv8k0fby51uakg D8). Every OMP doc opens with a snapshot line naming the OMP
// it was verified on (src/omp-docs.ts). At session start this compares the running OMP's VERSION,
// patch included, with the line of each OMP doc in the installed profile (`<agent dir>/OMP-HARNESS.md`,
// `OMP-RUNTIME.md`, `AGENTS.md`) and in this checkout (the path rule over `git ls-files`). When one is
// stale, a `context` handler appends a notice naming each stale doc to the messages of every main
// conversation request: OMP's main Agent prepares every request through `emitContext`
// (pi-coding-agent@18.8.6 src/sdk.ts transformContext), so prompted turns, aside and wake turns, turns
// after a compaction and turns after an in-place `/clear` (which emits no extension event) all carry
// it. OMP's private auto-learn agent bypasses `emitContext` and is not covered; it writes no answer.
//
// The handler is registered from session_start, and only when something is stale: `emitContext`
// clones the messages whenever any `context` handler exists (runner.ts emitContext), and a `pi.on`
// made inside session_start is seen by its next `hasHandlers` (loader.ts ConcreteExtensionAPI.on
// appends to the extension's live handler map; PLAN-REVIEW-r10). It is registered once per extension
// instance and reads the latest session_start's result, so a second session_start never adds a
// second notice. A UI session is also told once, as an error notice.
//
// Fails open: an unreadable version, agent dir, checkout or doc counts as not stale and nothing throws.
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ompDocs, parseSnapshotLine, staleDocs, staleNotice, VENDORED_OMP_DOCS, type VersionedDoc } from "../src/omp-docs";
import type { ContextMessage, GatesAPI } from "../src/session";

/** The installed profile's OMP docs, by file name under the agent dir (install/install.sh renders or links them there). */
export const PROFILE_OMP_DOCS = ["OMP-HARNESS.md", "OMP-RUNTIME.md", "AGENTS.md"] as const;

/** The custom message type of the notice. */
export const STALE_NOTICE_TYPE = "p11-omp-docs-stale";

/** What the check reads from the host; tests hand in their own. */
export interface StaleDocsHost {
	/** `@oh-my-pi/pi-utils/dirs` VERSION: the running OMP's version. */
	version(): Promise<unknown>;
	/** `@oh-my-pi/pi-utils` getAgentDir(): the running profile's agent dir. */
	agentDir(): Promise<string>;
	/** The as2 checkout these gates run from, or null when there is none to read. */
	repoRoot: string | null;
	/** The checkout's tracked files, repo-relative. */
	trackedFiles(root: string): string[];
}

/**
 * The gates run in place from the checkout (install/manifest.tsv destination `-`), so its root is two
 * levels up. The OMP modules are imported dynamically for the reason gates/index.ts hostModules gives:
 * the checkout carries no OMP install, so a static import fails loading this file under `bun test`.
 */
const hostStaleDocs: StaleDocsHost = {
	version: async () => (await import("@oh-my-pi/pi-utils/dirs")).VERSION,
	agentDir: async () => (await import("@oh-my-pi/pi-utils")).getAgentDir(),
	repoRoot: join(import.meta.dir, "..", ".."),
	trackedFiles(root) {
		const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
		return r.status === 0 ? r.stdout.split("\0").filter(Boolean) : [];
	},
};

/** Line 1 of `path` (the snapshot line is short; a longer first line is not one), or null when it cannot be read. */
function firstLine(path: string): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buf = Buffer.alloc(256);
		const text = buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
		const nl = text.indexOf("\n");
		return nl === -1 ? text : text.slice(0, nl);
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * The OMP docs whose snapshot line names another OMP than `running`, each named by its absolute path.
 * A doc reached twice (the profile links the checkout's guides) is named once; a doc with no snapshot
 * line, or one that cannot be read, is skipped.
 */
export async function findStaleDocs(host: StaleDocsHost, running: string): Promise<VersionedDoc[]> {
	const paths: string[] = [];
	try {
		const dir = await host.agentDir();
		paths.push(...PROFILE_OMP_DOCS.map((f) => join(dir, f)));
	} catch {
		// No agent dir: the profile part is skipped.
	}
	if (host.repoRoot) {
		try {
			paths.push(...ompDocs(host.repoRoot, host.trackedFiles(host.repoRoot)).filter((d) => !VENDORED_OMP_DOCS.includes(d.rel)).map((d) => d.path));
		} catch {
			// No readable checkout: the checkout part is skipped.
		}
	}
	const seen = new Set<string>();
	const docs: VersionedDoc[] = [];
	for (const path of paths) {
		const line = firstLine(path);
		const header = line === null ? null : parseSnapshotLine(line);
		if (!header) continue;
		let real = path;
		try {
			real = realpathSync(path);
		} catch {
			// Read a moment ago; keep the path as named.
		}
		if (seen.has(real)) continue;
		seen.add(real);
		docs.push({ name: path, version: header.version });
	}
	return staleDocs(running, docs);
}

export default function ompDocsStaleRow(pi: GatesAPI, host: StaleDocsHost = hostStaleDocs): void {
	let notice: string | null = null;
	let registered = false;
	let told = false;
	pi.on("session_start", async (_event, ctx) => {
		try {
			const version = await host.version();
			const stale = typeof version === "string" ? await findStaleDocs(host, version) : [];
			notice = stale.length > 0 ? staleNotice(version as string, stale) : null;
		} catch {
			notice = null;
		}
		if (notice === null) return;
		if (!registered) {
			registered = true;
			pi.on("context", (event) => {
				if (notice === null) return undefined;
				const message: ContextMessage = { role: "custom", customType: STALE_NOTICE_TYPE, content: notice, display: false, attribution: "agent", timestamp: Date.now() };
				return { messages: [...event.messages, message] };
			});
		}
		if (ctx.hasUI && !told) {
			told = true;
			try {
				ctx.ui.notify(notice, "error");
			} catch {
				// A notice that cannot be shown changes nothing the model sees.
			}
		}
	});
}
