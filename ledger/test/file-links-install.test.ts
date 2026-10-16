// T5: the real installer writes only an isolated HOME. An allowlisted PATH contains Bun and
// system utilities, never the developer's herdr/ctx. Clicks run the manifest action against a
// recording opener, so neither plugin registration nor an application launch can escape the test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dir, "../..");
const PLUGIN_ROOT = join(REPO, "install/herdr-file-links");
const SYSTEM_PATH = "/usr/bin:/bin";
let root: string;
let bin: string;

beforeAll(() => {
	root = mkdtempSync(join(process.env.AS2_SCRATCH ?? tmpdir(), "as2-file-links-"));
	bin = join(root, "bin");
	mkdirSync(bin);
	symlinkSync(process.execPath, join(bin, "bun"));
	// Fail before any installer call if the supposedly isolated PATH could find a real plugin host.
	expect(Bun.which("herdr", { PATH: `${bin}:${SYSTEM_PATH}` })).toBeNull();
	expect(Bun.which("ctx", { PATH: `${bin}:${SYSTEM_PATH}` })).toBeNull();
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function executable(path: string, content: string): string {
	writeFileSync(path, content);
	chmodSync(path, 0o755);
	return path;
}

function recordedCalls(file: string): string[][] {
	return existsSync(file) ? readFileSync(file, "utf8").split("\0\0").filter(Boolean).map((call) => call.split("\0")) : [];
}

function install(name: string, withHerdr: boolean) {
	const home = join(root, `${name} home`);
	const tools = join(root, `${name} tools`);
	const calls = join(root, `${name}-herdr.argv`);
	mkdirSync(home, { recursive: true });
	mkdirSync(tools, { recursive: true });
	if (withHerdr) executable(join(tools, "herdr"), `#!/bin/sh\nprintf '%s\\0' "$@" >>"$HERDR_CALLS"\nprintf '\\0' >>"$HERDR_CALLS"\nexit "\${HERDR_EXIT:-0}"\n`);
	const run = (extra: Record<string, string> = {}) => Bun.spawnSync(["/bin/bash", join(REPO, "install/install.sh")], {
		cwd: REPO,
		env: { HOME: home, PATH: `${tools}:${bin}:${SYSTEM_PATH}`, HERDR_CALLS: calls, ...extra },
		stdout: "pipe", stderr: "pipe",
	});
	return { home, run, calls: () => recordedCalls(calls) };
}

describe("install: openable links in the default OMP profile", () => {
	test("fake herdr receives the checkout plugin root and the default-profile extension is linked on install and reinstall", () => {
		const fixture = install("with-herdr", true);
		const extensions = join(fixture.home, ".omp/agent/extensions");
		mkdirSync(extensions, { recursive: true });
		const unrelated = join(extensions, "other.ts");
		writeFileSync(unrelated, "export {};\n");
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = fixture.run();
			expect(result.exitCode).toBe(0);
			expect(existsSync(join(extensions, "as2-open-links.ts"))).toBe(true);
			expect(readlinkSync(join(extensions, "as2-open-links.ts"))).toBe(join(REPO, "gates/extensions/open-links.ts"));
			expect(readFileSync(unrelated, "utf8")).toBe("export {};\n");
		}
		expect(fixture.calls()).toEqual(Array.from({ length: 2 }, () => ["plugin", "link", PLUGIN_ROOT]));
	}, 30_000);

	test("without herdr the installer succeeds, emits exactly one skip line, and still links the extension", () => {
		const fixture = install("without-herdr", false);
		const result = fixture.run();
		expect(result.exitCode).toBe(0);
		const notices = result.stdout.toString().split("\n").filter((line) => line.startsWith("==> note: herdr"));
		expect(notices).toEqual(["==> note: herdr is not on PATH; file-link handler not registered (install herdr, then re-run this script)"]);
		expect(fixture.calls()).toEqual([]);
		expect(readlinkSync(join(fixture.home, ".omp/agent/extensions/as2-open-links.ts"))).toBe(join(REPO, "gates/extensions/open-links.ts"));
	}, 30_000);

	test("a failed herdr registration is reported as an install failure", () => {
		const fixture = install("failed-herdr", true);
		const result = fixture.run({ HERDR_EXIT: "7" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("herdr plugin link exited 7");
		expect(result.stdout.toString()).not.toContain("install complete");
		expect(fixture.calls()).toEqual([["plugin", "link", PLUGIN_ROOT]]);
	}, 30_000);
});

function clickFixture(name: string) {
	const dir = join(root, name);
	const home = join(dir, "home");
	const log = join(dir, "opened.argv");
	mkdirSync(home, { recursive: true });
	const opener = executable(join(dir, "record opener"), `#!/bin/sh\nprintf '%s\\0' "$@" >>"$OPEN_CALLS"\nprintf '\\0' >>"$OPEN_CALLS"\nexit "\${OPEN_EXIT:-0}"\n`);
	const plugin = Bun.TOML.parse(readFileSync(join(PLUGIN_ROOT, "herdr-plugin.toml"), "utf8")) as {
		id: string; actions: { id: string; command: string[] }[]; link_handlers: { pattern: string; action: string }[];
	};
	expect(plugin.id).toBe("as2.file-links");
	expect(plugin.actions).toHaveLength(1);
	expect(plugin.link_handlers).toHaveLength(1);
	const handler = plugin.link_handlers[0]!;
	expect(new RegExp(handler.pattern).test("file:///a")).toBe(true);
	expect(new RegExp(handler.pattern).test("https://example.com")).toBe(false);
	const action = plugin.actions.find((item) => item.id === handler.action)!;
	expect(action.id).toBe("open-file");
	// Herdr's documented runtime cwd is the plugin root. Launch the actual declared argv, not a
	// separately reconstructed command, to exercise the installed entrypoint and URL env contract.
	const run = (url?: string, extra: Record<string, string> = {}) => Bun.spawnSync(action.command, {
		cwd: PLUGIN_ROOT,
		env: { HOME: home, PATH: `${bin}:${SYSTEM_PATH}`, AS2_OPEN_BIN: opener, OPEN_CALLS: log, ...(url === undefined ? {} : { HERDR_PLUGIN_CLICKED_URL: url }), ...extra },
		stdout: "pipe", stderr: "pipe",
	});
	return { dir, run, calls: () => recordedCalls(log) };
}

describe("herdr file-link action: decoded local paths, never shell commands", () => {
	test("opens an existing file with spaces and URL metacharacters as exactly one argv after --", () => {
		const fixture = clickFixture("existing-file");
		const file = join(fixture.dir, "My Docs #100% ? (draft) ü.md");
		writeFileSync(file, "plan\n");
		const result = fixture.run(pathToFileURL(file).href);
		expect([result.exitCode, result.stderr.toString()]).toEqual([0, ""]);
		expect(fixture.calls()).toEqual([["--", file]]);
	});

	test("opens only the immediate existing parent when the clicked file does not exist", () => {
		const fixture = clickFixture("parent-fallback");
		const parent = join(fixture.dir, "My Docs");
		mkdirSync(parent);
		const result = fixture.run(pathToFileURL(join(parent, "not written yet.md")).href);
		expect([result.exitCode, result.stderr.toString()]).toEqual([0, ""]);
		expect(fixture.calls()).toEqual([["--", parent]]);
	});

	test("does not walk to an ancestor when the immediate parent does not exist", () => {
		const fixture = clickFixture("no-parent");
		const result = fixture.run(pathToFileURL(join(fixture.dir, "missing", "plan.md")).href);
		expect(result.exitCode).toBe(1);
		expect(fixture.calls()).toEqual([]);
	});

	for (const [name, url] of [["https", "https://example.com/a"], ["missing-url", undefined], ["remote-host", "file://example.com/etc/passwd"], ["malformed-escape", "file:///a%ZZ"], ["encoded-nul", "file:///a%00"]] as const) {
		test(`refuses ${name} without invoking the opener`, () => {
			const fixture = clickFixture(`refuse-${name}`);
			const result = fixture.run(url);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr.toString()).toContain("file-links:");
			expect(fixture.calls()).toEqual([]);
		});
	}

	test("shell-looking filenames are passed literally and cannot execute a command", () => {
		const fixture = clickFixture("literal-filename");
		const file = join(fixture.dir, "$(touch \"$INJECTED\"); 'quoted'.md");
		writeFileSync(file, "safe\n");
		const marker = join(fixture.dir, "INJECTED");
		const result = fixture.run(pathToFileURL(file).href, { INJECTED: marker });
		expect([result.exitCode, result.stderr.toString()]).toEqual([0, ""]);
		expect(fixture.calls()).toEqual([["--", file]]);
		expect(existsSync(marker)).toBe(false);
	});

	test("preserves the opener's failure status", () => {
		const fixture = clickFixture("opener-failure");
		const file = join(fixture.dir, "plan.md");
		writeFileSync(file, "plan\n");
		const result = fixture.run(pathToFileURL(file).href, { OPEN_EXIT: "9" });
		expect(result.exitCode).toBe(9);
		expect(fixture.calls()).toEqual([["--", file]]);
	});
});
