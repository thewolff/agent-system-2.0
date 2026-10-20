// Stale OMP docs (PLAN wl-mv8k0fby51uakg D8, R6): the snapshot-line parser, the version comparison, the
// OMP-doc path rule, and the stale-docs extension driven through OMP's own ExtensionRunner: its factory
// is bound by OMP's loader (so a `pi.on` inside session_start is the real late registration), the
// session starts through `runner.emit`, and every request's messages go through `runner.emitContext`,
// the call OMP's main Agent makes before each provider request (pi-coding-agent@18.8.6 src/sdk.ts
// transformContext). A compaction or an in-place reset emits no extension event and only changes the
// messages the next request hands to emitContext, so those cases replace the messages and call it again.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import ompDocsStaleRow, { findStaleDocs, PROFILE_OMP_DOCS, STALE_NOTICE_TYPE, type StaleDocsHost } from "../extensions/omp-docs-stale";
import { isOmpDoc, ompDocs, parseSnapshotLine, staleDocs, staleNotice, VENDORED_OMP_DOCS } from "../src/omp-docs";
import type { GatesAPI } from "../src/session";
import { tmp } from "./helpers";

// The installed OMP's source, found from the `omp` on PATH (as gates/test/fence.test.ts and open-links.test.ts
// find it): its realpath lies inside @oh-my-pi/pi-coding-agent. A machine with no OMP installed skips the runner tests.
const OMP = ((): string | null => {
	const bin = Bun.which("omp");
	if (!bin) return null;
	let dir = dirname(realpathSync(bin));
	while (!(basename(dir) === "pi-coding-agent" && basename(dirname(dir)) === "@oh-my-pi")) {
		if (dirname(dir) === dir) return null;
		dir = dirname(dir);
	}
	return join(dir, "src");
})();
const HAS_OMP = OMP !== null && existsSync(`${OMP}/extensibility/extensions/runner.ts`);

const line = (version: string, date = "2026-10-20") => `snapshot of OMP ${version}, ${date}; drift will occur`;
const NOTICE_TAIL = "Verify any OMP claim against OMP source or omp:// docs before relying on it.";

describe("the snapshot line parser", () => {
	test("accepts the line and returns its version and date", () => {
		expect(parseSnapshotLine(line("18.8.6"))).toEqual({ version: "18.8.6", date: "2026-10-20" });
		expect(parseSnapshotLine(`${line("19.0.12", "2027-01-02")}\r`)).toEqual({ version: "19.0.12", date: "2027-01-02" });
	});

	test("rejects anything else", () => {
		for (const bad of [
			"",
			"# OMP harness guide",
			"snapshot of OMP 18.8, 2026-10-20; drift will occur",
			"snapshot of OMP v18.8.6, 2026-10-20; drift will occur",
			"snapshot of OMP 18.8.6, 2026-10; drift will occur",
			"snapshot of OMP 18.8.6, 2026-10-20",
			` ${line("18.8.6")}`,
			`${line("18.8.6")} `,
			"verified-omp: 18.8.6",
		]) {
			expect(parseSnapshotLine(bad)).toBeNull();
		}
	});
});

describe("staleDocs compares the whole version, patch included", () => {
	const doc = { name: "/p/OMP-HARNESS.md", version: "18.8.6" };
	test("a patch difference is stale", () => {
		expect(staleDocs("18.8.7", [doc])).toEqual([doc]);
	});
	test("a minor difference is stale", () => {
		expect(staleDocs("18.9.6", [doc])).toEqual([doc]);
	});
	test("an equal version is not", () => {
		expect(staleDocs("18.8.6", [doc])).toEqual([]);
	});
	test("the notice has one line per stale doc, naming both versions", () => {
		expect(staleNotice("18.9.0", [doc, { name: "/r/AGENTS.md", version: "18.8.5" }]).split("\n")).toEqual([
			`OMP docs are stale: /p/OMP-HARNESS.md is a snapshot of OMP 18.8.6, running OMP is 18.9.0. ${NOTICE_TAIL}`,
			`OMP docs are stale: /r/AGENTS.md is a snapshot of OMP 18.8.5, running OMP is 18.9.0. ${NOTICE_TAIL}`,
		]);
	});
});

describe("the OMP-doc path rule", () => {
	const files = [
		"profile/OMP-HARNESS.md",
		"profile/OMP-NEW.md",
		"profile/AGENTS.md",
		"profile/agents.md",
		"profile/config.yml",
		"profile/OMP-HARNESS.txt",
		"profile/sub/OMP-X.md",
		"docs/omp-flags.md",
		"docs/omp-flags.txt",
		"docs/sub/omp-x.md",
		"docs/configuration.md",
		"plugins/i-have-audhd/omp/REGISTRATION.md",
		"plugins/i-have-audhd/omp/adapter.ts",
		"omp/README.md",
		"a/omp/b/c.md",
		"a/omp.md",
		".omp/agents/builder.md",
		"README.md",
	];
	const matched = [
		"profile/OMP-HARNESS.md",
		"profile/OMP-NEW.md",
		"profile/AGENTS.md",
		"docs/omp-flags.md",
		"plugins/i-have-audhd/omp/REGISTRATION.md",
		"omp/README.md",
		"a/omp/b/c.md",
	];

	test("matches profile/OMP-*.md, the card, .md under an omp directory and docs/omp-*.md, nothing else", () => {
		expect(files.filter(isOmpDoc)).toEqual(matched);
	});

	test("ompDocs returns each match with its path under the root", () => {
		expect(ompDocs("/repo/", files)).toEqual(matched.map((rel) => ({ rel, path: `/repo/${rel}` })));
	});

	test("the vendored exceptions are OMP docs under plugins/", () => {
		expect(VENDORED_OMP_DOCS.length).toBeGreaterThan(0);
		for (const p of VENDORED_OMP_DOCS) {
			expect(p.startsWith("plugins/")).toBe(true);
			expect(isOmpDoc(p)).toBe(true);
		}
	});
});

/** An agent dir holding the three profile docs, each at `version` (or an unparseable first line for null). */
function agentDir(versions: Partial<Record<(typeof PROFILE_OMP_DOCS)[number], string | null>>): string {
	const dir = tmp("omp-docs-agent");
	for (const [name, version] of Object.entries(versions)) {
		writeFileSync(join(dir, name), `${version === null ? "# no snapshot line" : line(version)}\n# body\n`);
	}
	return dir;
}

const hostOf = (dir: string, version: unknown = "18.8.6", over: Partial<StaleDocsHost> = {}): StaleDocsHost => ({
	version: async () => version,
	agentDir: async () => dir,
	repoRoot: null,
	trackedFiles: () => [],
	...over,
});

describe("findStaleDocs reads the profile and the checkout", () => {
	test("a checkout doc is read through the rule; a vendored copy and a doc with no line are skipped; a linked doc is named once", async () => {
		const repo = tmp("omp-docs-repo");
		mkdirSync(join(repo, "profile"));
		mkdirSync(join(repo, "docs"));
		mkdirSync(join(repo, "plugins", "x", "omp"), { recursive: true });
		writeFileSync(join(repo, "profile", "OMP-HARNESS.md"), `${line("18.8.5")}\n`);
		writeFileSync(join(repo, "docs", "omp-flags.md"), `${line("18.8.5")}\n`);
		writeFileSync(join(repo, "docs", "omp-same.md"), `${line("18.8.6")}\n`);
		writeFileSync(join(repo, "plugins", "x", "omp", "REG.md"), "# vendored, no line\n");
		const vendored = join(repo, ...VENDORED_OMP_DOCS[0]!.split("/"));
		mkdirSync(join(vendored, ".."), { recursive: true });
		writeFileSync(vendored, `${line("1.0.0")}\n`);
		const dir = agentDir({ "AGENTS.md": "18.8.6" });
		symlinkSync(join(repo, "profile", "OMP-HARNESS.md"), join(dir, "OMP-HARNESS.md"));
		const tracked = ["profile/OMP-HARNESS.md", "docs/omp-flags.md", "docs/omp-same.md", "plugins/x/omp/REG.md", VENDORED_OMP_DOCS[0]!];
		const stale = await findStaleDocs(hostOf(dir, "18.8.6", { repoRoot: repo, trackedFiles: () => tracked }), "18.8.6");
		expect(stale).toEqual([
			{ name: join(dir, "OMP-HARNESS.md"), version: "18.8.5" },
			{ name: join(repo, "docs", "omp-flags.md"), version: "18.8.5" },
		]);
	});
});

const USER = (text: string, timestamp: number) => ({ role: "user", content: [{ type: "text", text }], timestamp });

describe.skipIf(!HAS_OMP)("the extension through OMP's ExtensionRunner.emitContext", () => {
	/** The row bound by OMP's loader into a real runner, with a UI whose notices are recorded when `ui` is set. */
	async function session(host: StaleDocsHost, ui = false) {
		const [{ ExtensionRunner }, { loadExtensionFromFactory, ExtensionRuntime }, { EventBus }] = await Promise.all([
			import(`${OMP}/extensibility/extensions/runner.ts`),
			import(`${OMP}/extensibility/extensions/loader.ts`),
			import(`${OMP}/utils/event-bus.ts`),
		]);
		const runtime = new ExtensionRuntime();
		const ext = await loadExtensionFromFactory((pi: unknown) => ompDocsStaleRow(pi as GatesAPI, host), "/tmp", new EventBus(), runtime, "omp-docs-stale");
		const sessionManager = { getCwd: () => "/tmp", getSessionFile: () => undefined, getSessionId: () => "s-omp-docs", getHeader: () => null, getEntries: () => [] };
		const runner = new ExtensionRunner([ext], runtime, "/tmp", sessionManager, {});
		const errors: unknown[] = [];
		runner.onError((e: unknown) => errors.push(e));
		const notices: [string, string | undefined][] = [];
		if (ui) runner.initialize({}, {}, undefined, { notify: (m: string, t?: string) => notices.push([m, t]) }, "interactive");
		return {
			runner,
			errors,
			notices,
			start: () => runner.emit({ type: "session_start" }),
			context: (messages: unknown[]) => runner.emitContext(messages) as Promise<Record<string, unknown>[]>,
		};
	}

	const notices = (messages: Record<string, unknown>[]) => messages.filter((m) => m.customType === STALE_NOTICE_TYPE);

	test("(a) a stale profile doc: the outbound messages of a prompted turn end with the notice", async () => {
		const dir = agentDir({ "OMP-HARNESS.md": "18.8.5", "OMP-RUNTIME.md": "18.8.6", "AGENTS.md": "18.8.6" });
		const s = await session(hostOf(dir));
		expect(s.runner.hasHandlers("context")).toBe(false);
		await s.start();
		expect(s.runner.hasHandlers("context")).toBe(true);
		const sent = [USER("what does /clear do?", 1)];
		const out = await s.context(sent);
		expect(out.slice(0, -1)).toEqual(sent);
		expect(out.at(-1)).toMatchObject({
			role: "custom",
			customType: STALE_NOTICE_TYPE,
			display: false,
			content: `OMP docs are stale: ${join(dir, "OMP-HARNESS.md")} is a snapshot of OMP 18.8.5, running OMP is 18.8.6. ${NOTICE_TAIL}`,
		});
		expect(sent).toHaveLength(1);
		expect(s.errors).toEqual([]);
	});

	test("(b) the notice is in the request after the messages are replaced by a compaction, and after a reset", async () => {
		const dir = agentDir({ "OMP-HARNESS.md": "18.8.6", "OMP-RUNTIME.md": "18.7.0", "AGENTS.md": "18.8.5" });
		const s = await session(hostOf(dir));
		await s.start();
		const first = await s.context([USER("one", 1)]);
		expect(notices(first)).toHaveLength(1);
		const text = String(notices(first)[0]!.content);
		expect(text.split("\n")).toEqual([
			`OMP docs are stale: ${join(dir, "OMP-RUNTIME.md")} is a snapshot of OMP 18.7.0, running OMP is 18.8.6. ${NOTICE_TAIL}`,
			`OMP docs are stale: ${join(dir, "AGENTS.md")} is a snapshot of OMP 18.8.5, running OMP is 18.8.6. ${NOTICE_TAIL}`,
		]);
		// Compaction: the history is replaced by its summary; no extension event reaches the row.
		const compacted = [{ role: "compactionSummary", summary: "earlier work", tokensBefore: 90_000, timestamp: 2 }, USER("an aside after compaction", 3)];
		const afterCompaction = await s.context(compacted);
		expect(afterCompaction.slice(0, -1)).toEqual(compacted);
		expect(afterCompaction.at(-1)).toMatchObject({ customType: STALE_NOTICE_TYPE, content: text });
		// An in-place reset (resetSessionContext): the history is emptied, then the next prompt runs.
		expect(notices(await s.context([]))).toHaveLength(1);
		const afterReset = await s.context([USER("after /clear", 4)]);
		expect(afterReset).toHaveLength(2);
		expect(afterReset.at(-1)).toMatchObject({ customType: STALE_NOTICE_TYPE, content: text });
		// A second session_start (a new session on the same runner) adds no second notice.
		await s.start();
		expect(notices(await s.context([USER("new session", 5)]))).toHaveLength(1);
		expect(s.errors).toEqual([]);
	});

	test("(c) no stale doc: no context handler is registered and the messages go out unchanged", async () => {
		const dir = agentDir({ "OMP-HARNESS.md": "18.8.6", "OMP-RUNTIME.md": "18.8.6", "AGENTS.md": null });
		const s = await session(hostOf(dir), true);
		await s.start();
		expect(s.runner.hasHandlers("context")).toBe(false);
		const sent = [USER("hi", 1)];
		expect(await s.context(sent)).toBe(sent);
		expect(s.notices).toEqual([]);
		expect(s.errors).toEqual([]);
	});

	test("(d) an unreadable doc, version, agent dir or checkout: no throw, no notice", async () => {
		const dir = agentDir({ "OMP-RUNTIME.md": "18.8.6" });
		mkdirSync(join(dir, "OMP-HARNESS.md"));
		writeFileSync(join(dir, "AGENTS.md"), Buffer.from([0xff, 0xfe, 0x00, 0x0a]));
		const hosts = [
			hostOf(dir),
			{ ...hostOf(dir, "18.9.0"), version: async () => undefined },
			hostOf(dir, "18.9.0", { agentDir: async () => Promise.reject(new Error("no agent dir")) }),
			hostOf(join(dir, "missing"), "18.9.0", {
				repoRoot: dir,
				trackedFiles: () => {
					throw new Error("git ls-files failed");
				},
			}),
			{ ...hostOf(dir), version: async () => Promise.reject(new Error("no VERSION")) },
		];
		for (const host of hosts) {
			const s = await session(host, true);
			await s.start();
			expect(s.runner.hasHandlers("context")).toBe(false);
			const sent = [USER("hi", 1)];
			expect(await s.context(sent)).toBe(sent);
			expect(s.notices).toEqual([]);
			expect(s.errors).toEqual([]);
		}
	});

	test("a UI session is told once, as an error", async () => {
		const dir = agentDir({ "OMP-HARNESS.md": "18.8.5" });
		const s = await session(hostOf(dir), true);
		await s.start();
		await s.start();
		expect(s.notices).toEqual([[`OMP docs are stale: ${join(dir, "OMP-HARNESS.md")} is a snapshot of OMP 18.8.5, running OMP is 18.8.6. ${NOTICE_TAIL}`, "error"]]);
	});
});
