// T5: the real installer writes only an isolated HOME. An allowlisted PATH contains Bun and
// system utilities, never the developer's herdr/ctx. Clicks run the manifest action against a
// recording opener, so neither plugin registration nor an application launch can escape the test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dir, "../..");
const PLUGIN_ROOT = join(REPO, "install/herdr-file-links");
const SYSTEM_PATH = "/usr/bin:/bin";
let root: string;
let bin: string;

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(process.env.AS2_SCRATCH ?? tmpdir(), "as2-file-links-")));
	bin = join(root, "bin");
	mkdirSync(bin);
	symlinkSync(process.execPath, join(bin, "bun"));
	executable(join(bin, "omp"), "#!/bin/sh\nprintf 'omp/18.12.6\\n'\n");
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
	test("opens a safe document with the explicit text editor, preserving URL metacharacters in one argv", () => {
		const fixture = clickFixture("existing-file");
		const file = join(fixture.dir, "My Docs #100% ? (draft) ü.md");
		writeFileSync(file, "plan\n");
		const result = fixture.run(pathToFileURL(file).href);
		expect([result.exitCode, result.stderr.toString()]).toEqual([0, ""]);
		expect(fixture.calls()).toEqual([["-t", "--", file]]);
	});

	test("reveals only the immediate existing parent when the clicked file does not exist", () => {
		const fixture = clickFixture("parent-fallback");
		const parent = join(fixture.dir, "My Docs");
		mkdirSync(parent);
		const result = fixture.run(pathToFileURL(join(parent, "not written yet.md")).href);
		expect([result.exitCode, result.stderr.toString()]).toEqual([0, ""]);
		expect(fixture.calls()).toEqual([["-R", "--", parent]]);
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
		expect(fixture.calls()).toEqual([["-t", "--", file]]);
		expect(existsSync(marker)).toBe(false);
	});

	test("preserves the opener's failure status", () => {
		const fixture = clickFixture("opener-failure");
		const file = join(fixture.dir, "plan.md");
		writeFileSync(file, "plan\n");
		const result = fixture.run(pathToFileURL(file).href, { OPEN_EXIT: "9" });
		expect(result.exitCode).toBe(9);
		expect(fixture.calls()).toEqual([["-t", "--", file]]);
	});

	test("reveals existing directories rather than dispatching their default handler", () => {
		const fixture = clickFixture("directory");
		const directory = join(fixture.dir, "ordinary folder");
		mkdirSync(directory);
		const result = fixture.run(pathToFileURL(directory).href);
		expect([result.exitCode, result.stderr.toString()]).toEqual([0, ""]);
		expect(fixture.calls()).toEqual([["-R", "--", directory]]);
	});

	test("decodes percent escapes once and preserves newlines and option-looking filenames", () => {
		const fixture = clickFixture("decode-once");
		const file = join(fixture.dir, "-n %2F literal\nnotes.md");
		writeFileSync(file, "notes\n");
		const result = fixture.run(pathToFileURL(file).href);
		expect([result.exitCode, result.stderr.toString()]).toEqual([0, ""]);
		expect(fixture.calls()).toEqual([["-t", "--", file]]);
	});

	for (const [name, filename, content, mode] of [
		["executable-document", "plan.md", "plain text\n", 0o755],
		["non-executable-command", "run.command", "#!/bin/sh\nexit 0\n", 0o644],
		["terminal-profile", "session.terminal", "<plist/>", 0o644],
		["applescript", "run.scpt", "display dialog \"no\"\n", 0o644],
		["shell-script", "run.sh", "echo no\n", 0o644],
		["python-script", "run.py", "print(\"no\")\n", 0o644],
		["disguised-script", "notes.md", "#!/bin/sh\nexit 0\n", 0o644],
		["bom-disguised-script", "notes.txt", "\uFEFF#!/bin/sh\nexit 0\n", 0o644],
		["disguised-binary", "notes.md", "\u007FELF\0binary", 0o644],
		["extensionless-executable", "run", "\u007FELF\0binary", 0o755],
		["unknown-document-type", "download.pdf", "%PDF-1.7\n", 0o644],
	] as const) {
		test(`only reveals ${name}, never opening or executing it`, () => {
			const fixture = clickFixture(`abuse-${name}`);
			const file = join(fixture.dir, filename);
			writeFileSync(file, content);
			chmodSync(file, mode);
			const result = fixture.run(pathToFileURL(file).href);
			expect([result.exitCode, result.stderr.toString()]).toEqual([0, ""]);
			expect(fixture.calls()).toEqual([["-R", "--", file]]);
		});
	}

	test("reveals a document symlink instead of giving its referent to a text editor", () => {
		const fixture = clickFixture("document-symlink");
		const document = join(fixture.dir, "actual.md");
		const link = join(fixture.dir, "linked.md");
		writeFileSync(document, "notes\n");
		symlinkSync(document, link);
		const result = fixture.run(pathToFileURL(link).href);
		expect([result.exitCode, result.stderr.toString()]).toEqual([0, ""]);
		expect(fixture.calls()).toEqual([["-R", "--", link]]);
	});

	test("a symlinked ancestor cannot smuggle a document to the text editor", () => {
		const fixture = clickFixture("directory-symlink");
		const directory = join(fixture.dir, "actual");
		const link = join(fixture.dir, "linked");
		mkdirSync(directory);
		writeFileSync(join(directory, "notes.md"), "notes\n");
		symlinkSync(directory, link);
		const file = join(link, "notes.md");
		const result = fixture.run(pathToFileURL(file).href);
		expect([result.exitCode, result.stderr.toString()]).toEqual([0, ""]);
		expect(fixture.calls()).toEqual([["-R", "--", file]]);
	});

	for (const suffix of [".app", ".APP", ".bundle", ".framework", ".plugin", ".appex", ".xpc", ".prefPane", ".workflow", ".scptd"]) {
		test(`refuses ${suffix} targets, descendants and missing-file fallback inside the bundle`, () => {
			const fixture = clickFixture(`bundle-${suffix}`);
			const bundle = join(fixture.dir, `Unsafe${suffix}`);
			const contents = join(bundle, "Contents");
			mkdirSync(contents, { recursive: true });
			const document = join(contents, "notes.md");
			writeFileSync(document, "notes\n");
			for (const target of [bundle, contents, document, join(contents, "missing.md")]) {
				const result = fixture.run(pathToFileURL(target).href);
				expect(result.exitCode).toBe(1);
				expect(result.stderr.toString()).toContain("bundle");
			}
			expect(fixture.calls()).toEqual([]);
		});
	}

	test("recognizes a suffixless bundle by its Contents layout", () => {
		const fixture = clickFixture("suffixless-bundle");
		const bundle = join(fixture.dir, "Looks ordinary");
		const contents = join(bundle, "Contents");
		mkdirSync(contents, { recursive: true });
		writeFileSync(join(contents, "Info.plist"), "<plist/>");
		for (const target of [bundle, contents, join(contents, "missing.md")]) {
			const result = fixture.run(pathToFileURL(target).href);
			expect(result.exitCode).toBe(1);
		}
		expect(fixture.calls()).toEqual([]);
	});

	test("rejects file and directory symlinks hiding a bundle, including parent fallback", () => {
		const fixture = clickFixture("symlink-bundle");
		const bundle = join(fixture.dir, "Unsafe.app");
		mkdirSync(bundle);
		const document = join(bundle, "notes.md");
		writeFileSync(document, "notes\n");
		const directoryLink = join(fixture.dir, "ordinary");
		const fileLink = join(fixture.dir, "ordinary.md");
		symlinkSync(bundle, directoryLink);
		symlinkSync(document, fileLink);
		for (const target of [directoryLink, fileLink, join(directoryLink, "notes.md"), join(directoryLink, "missing.md")]) {
			const result = fixture.run(pathToFileURL(target).href);
			expect(result.exitCode).toBe(1);
			expect(result.stderr.toString()).toContain("bundle");
		}
		expect(fixture.calls()).toEqual([]);
	});

	test("refuses a dangling symlink rather than falling back to its safe parent", () => {
		const fixture = clickFixture("dangling-link");
		const link = join(fixture.dir, "notes.md");
		symlinkSync(join(fixture.dir, "missing.command"), link);
		expect(fixture.run(pathToFileURL(link).href).exitCode).toBe(1);
		expect(fixture.calls()).toEqual([]);
	});

	test("a bundle-named symlink cannot bypass the lexical ancestor guard", () => {
		const fixture = clickFixture("bundle-named-alias");
		const directory = join(fixture.dir, "ordinary");
		const alias = join(fixture.dir, "Misleading.app");
		mkdirSync(directory);
		writeFileSync(join(directory, "notes.md"), "notes\n");
		symlinkSync(directory, alias);
		for (const target of [alias, join(alias, "notes.md"), join(alias, "missing.md")]) {
			expect(fixture.run(pathToFileURL(target).href).exitCode).toBe(1);
		}
		expect(fixture.calls()).toEqual([]);
	});
});
