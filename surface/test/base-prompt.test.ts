// The voice and the output-types contract in the orchestrator's base prompt (migration/items/
// base-prompt-voice-contract.md). OMP runs `before_agent_start` only on a turn Jo types, so when the
// two sections were appended there, an aside-started turn after a restart ran on the bare prompt and
// the first turn Jo typed changed the system prompt, re-billing the whole conversation as a cache
// write. bin/as2 now renders both into an `--append-system-prompt` file; these tests pin that the
// file holds the exact strings the extensions would append, that a turn finding them in the base
// prompt leaves the prompt byte-identical, that a push after such a launch inlines neither, and that
// as2 refuses to launch when a source file is missing.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import contractRow from "../../gates/extensions/r02-contract";
import { CONTRACT_MARKER } from "../../gates/src/rows/r02-contract";
import type { GatesAPI } from "../../gates/src/session";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { orchestratorPrompt } from "../scripts/orchestrator-prompt";
import { surfaceSession } from "../src/session";
import { ctxOf, fakePi, timeouts, timers, tmp } from "./helpers";

const AS2 = join(import.meta.dir, "..", "..", "bin", "as2");

function env(over: Record<string, string> = {}): Record<string, string> {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY\n");
	const contract = join(tmp("contract"), "output-types.md");
	writeFileSync(contract, "CONTRACT DOC BODY\n");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, AGENT_SYSTEM_CONTRACT: contract, HOME: "/nonexistent-home", ...over };
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close();
	return e;
}

function rendered(e: Record<string, string>): string {
	const r = orchestratorPrompt(e);
	if (!("text" in r)) throw new Error(`not rendered: ${r.missing.join("; ")}`);
	return r.text;
}

/** The surface and the contract row on one fake host, in the profile's load order (surface first). */
function host(e: Record<string, string>, systemPrompt: string[]) {
	timers.length = 0;
	timeouts.length = 0;
	const f = fakePi(undefined, { exec: true });
	orchestratorSurface(f.pi, e, {});
	contractRow(f.pi as unknown as GatesAPI, e);
	const ctx = ctxOf({ systemPrompt });
	return {
		f,
		ctx,
		start: () => f.emit("session_start", { type: "session_start" }, ctx),
		jo: async () => (await f.emit("before_agent_start", { prompt: "hi", systemPrompt }, ctx)) as { systemPrompt: string[] },
		wakes: () => f.sent.filter((x) => x.message.customType === "surface-wake").map((x) => x.message.content),
		fire: () => {
			for (const t of timeouts.splice(0)) t.fn();
		},
	};
}

describe("the rendered file is the voice section and the contract block, the exact strings a turn appends", () => {
	test("voice section, blank line, contract marker and body", () => {
		const e = env();
		expect(rendered(e)).toBe(`# Voice document (${e.AGENT_SYSTEM_VOICE})\n\nVOICE DOC BODY\n\n\n${CONTRACT_MARKER}\nCONTRACT DOC BODY\n`);
	});

	test("a missing source is named with its env override, never rendered as a missing-file line", () => {
		const e = env({ AGENT_SYSTEM_VOICE: "/nonexistent/VOICE.md", AGENT_SYSTEM_CONTRACT: "/nonexistent/output-types.md" });
		expect(orchestratorPrompt(e)).toEqual({
			missing: [
				"the voice document is missing at /nonexistent/VOICE.md (set AGENT_SYSTEM_VOICE)",
				"the output-types contract is missing at /nonexistent/output-types.md (set AGENT_SYSTEM_CONTRACT)",
			],
		});
	});
});

describe("a base prompt carrying the file: every turn sends the same system prompt", () => {
	test("Jo's turn returns the base prompt unchanged: no second voice, no second contract", async () => {
		const e = env();
		// The appended text lands inside OMP's project prompt block, after other text (prompts/system/project-prompt.md).
		const base = ["HEAD", `<project-context>…</project-context>\n\n${rendered(e)}`];
		const h = host(e, base);
		await h.start();
		const turn = await h.jo();
		expect(turn.systemPrompt).toEqual(base);
		expect(turn.systemPrompt.join("\n")).toBe(base.join("\n"));
		const s = surfaceSession(h.ctx, e);
		expect(s.voiceInjected).toBe(true);
		expect(s.promptPrimed).toBe(true);
	});

	test("after such a launch the first push carries the render only: the voice and contract are already in the prompt", async () => {
		const e = env();
		const h = host(e, ["HEAD", rendered(e)]);
		await h.start();
		expect(surfaceSession(h.ctx, e).promptPrimed).toBe(true);
		h.fire();
		const wakes = h.wakes();
		expect(wakes).toHaveLength(1);
		expect(wakes[0]).toContain("(wake: session-start)");
		expect(wakes[0]).not.toContain("VOICE DOC BODY");
		expect(wakes[0]).not.toContain("CONTRACT DOC BODY");
	});

	test("a base prompt with the voice but not the contract is not primed: the push still inlines both", async () => {
		const e = env();
		const h = host(e, ["HEAD", `# Voice document (${e.AGENT_SYSTEM_VOICE})\n\nVOICE DOC BODY\n`]);
		await h.start();
		expect(surfaceSession(h.ctx, e).promptPrimed).toBe(false);
		h.fire();
		expect(h.wakes()[0]).toContain("CONTRACT DOC BODY");
	});

	test("a launch without the file (bare base prompt) keeps today's behavior: Jo's turn appends the voice and the contract", async () => {
		const e = env();
		const h = host(e, ["HEAD"]);
		await h.start();
		const turn = await h.jo();
		expect(turn.systemPrompt).toEqual(["HEAD", `# Voice document (${e.AGENT_SYSTEM_VOICE})\n\nVOICE DOC BODY\n`, `${CONTRACT_MARKER}\nCONTRACT DOC BODY\n`]);
	});
});

describe("bin/as2 renders the file before omp and refuses to launch without a source", () => {
	/** The installed omp, whose `src` the fake omp's package borrows; null on the outside-the-fence runner. */
	const OMP_ON_PATH = Bun.which("omp");
	/** With no real parser, as2 names that once on stderr and launches Jo's args as given (orchestrator-session.ts). */
	const NO_PARSER = /^as2: cannot read your arguments with omp's own parser \(.*\); launching them as given, without resuming Ilex's conversation\n$/;
	/**
	 * as2 under sh with a scratch HOME and ledger, and first on PATH a fake omp that records its argv and a pgrep that
	 * finds no Ilex. With omp installed, the fake sits in a package whose `src` is the installed OMP's, so as2 reads
	 * Jo's args with the real parser; without it, the fake stands alone and as2 takes its no-parser route.
	 */
	function as2(args: string[], over: Record<string, string> = {}) {
		const e = env(over);
		const home = tmp("home");
		const bin = tmp("bin");
		const argvFile = join(home, "omp-argv");
		const fake = `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n`;
		if (OMP_ON_PATH) {
			const pkg = tmp("pkg");
			mkdirSync(join(pkg, "dist"));
			writeFileSync(join(pkg, "dist", "cli.js"), fake);
			chmodSync(join(pkg, "dist", "cli.js"), 0o755);
			symlinkSync(join(dirname(dirname(realpathSync(OMP_ON_PATH))), "src"), join(pkg, "src"));
			symlinkSync(join(pkg, "dist", "cli.js"), join(bin, "omp"));
		} else {
			writeFileSync(join(bin, "omp"), fake);
			chmodSync(join(bin, "omp"), 0o755);
		}
		writeFileSync(join(bin, "pgrep"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(bin, "pgrep"), 0o755);
		const r = Bun.spawnSync(["sh", AS2, ...args], {
			env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, AGENT_SYSTEM_LEDGER_DB: e.AGENT_SYSTEM_LEDGER_DB!, AGENT_SYSTEM_VOICE: e.AGENT_SYSTEM_VOICE!, AGENT_SYSTEM_CONTRACT: e.AGENT_SYSTEM_CONTRACT! },
		});
		const prompt = join(home, ".agent-system-2", "orchestrator", "system.md");
		return {
			e,
			code: r.exitCode,
			stdout: r.stdout.toString(),
			stderr: r.stderr.toString(),
			prompt,
			ompArgv: () => (existsSync(argvFile) ? readFileSync(argvFile, "utf8").trimEnd().split("\n") : null),
		};
	}

	test("launch: the file is written, then omp gets --append-system-prompt <file> before Jo's args", () => {
		const r = as2(["--resume", "x"]);
		if (OMP_ON_PATH) expect(r.stderr).toBe("");
		else expect(r.stderr).toMatch(NO_PARSER);
		expect(r.code).toBe(0);
		expect(readFileSync(r.prompt, "utf8")).toBe(rendered(r.e));
		const argv = r.ompArgv()!;
		expect(argv.slice(0, 2)).toEqual(["--cwd", join(import.meta.dir, "..", "..")]);
		expect(argv.slice(2)).toEqual(["--append-system-prompt", r.prompt, "--resume", "x"]);
	});

	test("--print renders the file and names it in the printed command", () => {
		const r = as2(["--print"]);
		expect(r.code).toBe(0);
		expect(r.stdout.trimEnd()).toEndWith(`--append-system-prompt ${r.prompt}`);
		expect(readFileSync(r.prompt, "utf8")).toBe(rendered(r.e));
		expect(r.ompArgv()).toBeNull();
	});

	test("a missing voice document stops the launch, naming it; omp never runs and no file is written", () => {
		const r = as2([], { AGENT_SYSTEM_VOICE: "/nonexistent/VOICE.md" });
		expect(r.code).toBe(1);
		expect(r.stderr).toBe("as2: refusing to launch: the voice document is missing at /nonexistent/VOICE.md (set AGENT_SYSTEM_VOICE)\n");
		expect(r.ompArgv()).toBeNull();
		expect(existsSync(r.prompt)).toBe(false);
	});

	test("a missing contract stops the launch the same way", () => {
		const r = as2([], { AGENT_SYSTEM_CONTRACT: "/nonexistent/output-types.md" });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("as2: refusing to launch: the output-types contract is missing at /nonexistent/output-types.md");
		expect(r.ompArgv()).toBeNull();
	});
});
