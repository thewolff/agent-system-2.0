// The real by-hand lane session (wl-mvb9mw00ycfjeo PLAN-2 D6, D7; R1, R5, R6, R12): `bin/as2 lane <wl>` as Jo runs it,
// the lane script's by-hand path and the installed OMP it spawns, against a scratch HOME whose profile install/install.sh
// renders from this checkout, a scratch ledger and a scratch repo. Every model request goes to the chaos run's local
// deterministic stub (surface/scripts/chaos-stub.ts: `startStub` and `writeStubProfile`, which routes every provider, role
// and tier row of the rendered profile to it and keeps every other key). Nothing else of the profile changes: OMP's own skill
// discovery runs on the rendered skills block, and surface, gates, classifier and plugins load from its `extensions:` list.
//
// A pipe stands in for Jo's terminal, so OMP runs the session headless: `@prompt.md` is its first message and it exits when
// the turn ends (pi-coding-agent src/main.ts autoPrint). That proves what the session receives and offers, not TUI pixels.
// The stub records each provider payload; the session file is OMP's own JSONL. The by-hand lane reads the three vendored
// skills, dispatches one hand through the classifier and waits for it, and ends its turn without an ask-graham verdict, so
// ask-graham's Stop check blocks once. An autonomous lane (`lane.ts launch`, rpc) and the orchestrator (`bin/as2`) run on
// the same profile for the role matrix.
//
// Skipped where no OMP is installed (HAS_OMP false: describe.skipIf and an `[skipped: no installed OMP at <path>]` title suffix,
// as plugins/test/loader.test.ts does); the install acceptance script, which requires OMP, is where a missing OMP fails. With OMP
// present, an omp on PATH that is not it, a failed install or a load error fails the file. Every
// process is bounded (SIGKILL past its deadline) and reaped before the scratch root goes, the detached runner, drain and
// ctx-index workers included. Inside the agent fence put surface/scripts/ps-shim first on PATH: lane.ts reads process start
// times with ps.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { type Stub, type StubRequest, type StubTurn, startStub, writeStubProfile } from "../../surface/scripts/chaos-stub";
import { recordRepo } from "../../surface/src/decision-log";
import { controlEntries, doneBody, holdersOf, laneDir, laneStarted } from "../../surface/src/launch";
import { SURFACE_BY } from "../../surface/src/types";
import { alive, type LaneRoot, settleDrains, until } from "../../surface/test/helpers";
import { NUDGE } from "../ask-graham/skills/ask-graham/scripts/intensity.mjs";
import { BLOCK_REASON } from "../ask-graham/skills/ask-graham/scripts/verdict.mjs";
import { HAS_OMP, OMP, OMP_SKIP, PAIR_TOOLS } from "./omp-host.ts";

const REPO = resolve(import.meta.dir, "..", "..");
const AS2 = join(REPO, "bin", "as2");
const LANE_SCRIPT = join(REPO, "surface", "scripts", "lane.ts");
/** Each process this file starts is SIGKILLed this long after it starts, whatever it is doing. */
const PROCESS_KILL_MS = 120_000;
const VENDORED = ["ask-graham", "i-have-audhd", "paired-coding"] as const;

const BRIEF = "Re-seat the header offset token\nsecond brief line: brief-mark-5521 keeps the 4px gap";
const DONE = "done-mark-5522: the header reads its offset from the token";
const SEEDED_TASK = "slice-mark-5523 move the header offset into a token";
const INSTRUCTION = "instruction-mark-5524 use the v3 token schema\nsecond instruction line: then drop v2";
const HAND_MARK = "hand-mark-5525";
const ORCH_MARK = "orchestrator-mark-5526";
const SL_HAND = "sl-by-hand-probe";
const VERDICT = "**Verdict:** later";

/** The i-have-audhd core: its SKILL.md between the inject markers, which the session-start hook sends verbatim. */
const AUDHD_CORE = (() => {
	const skill = readFileSync(join(REPO, "plugins", "i-have-audhd", "skills", "i-have-audhd", "SKILL.md"), "utf8");
	const start = "\n<!-- inject:start -->\n";
	const from = skill.indexOf(start);
	const to = skill.indexOf("\n<!-- inject:end -->");
	if (from < 0 || to < from) throw new Error("plugins/i-have-audhd/skills/i-have-audhd/SKILL.md has no inject markers");
	return skill.slice(from + start.length, to).trim();
})();

/** The manifest's skill names (install/manifest.tsv `skill` rows), sorted. */
const MANIFEST_SKILLS = readFileSync(join(REPO, "install", "manifest.tsv"), "utf8")
	.split("\n")
	.filter((l) => l.split("\t")[1] === "skill")
	.map((l) => l.split("\t")[0]!.replace(/\/SKILL\.md$/, "").replace(/^.*\//, ""))
	.sort();

type Kind = "by-hand" | "hand" | "autonomous" | "orchestrator";

interface World {
	root: string;
	home: string;
	repo: string;
	ledgerPath: string;
	env: Record<string, string>;
	stub: Stub;
	byHandWl: string;
	autoWl: string;
	/** Every tool-offering request the stub served, by session kind, in arrival order. */
	requests: Record<Kind, StubRequest[]>;
	/** What each process this file started printed, and how it ended. */
	runs: { label: string; code: number | null; killed: boolean; out: string; err: string }[];
}

let w: World | null = null;
const world = (): World => {
	if (!w) throw new Error("the session setup did not finish");
	return w;
};

/** A request's text: every message's text blocks and tool results. */
const allText = (r: StubRequest): string => JSON.stringify(r.body.messages);
const pairNames = (names: readonly string[]): string[] => names.filter((n) => n.startsWith("pair_"));

/** Runs `cmd` to its end, SIGKILLed after PROCESS_KILL_MS; `input` is written to its stdin, which is then closed. */
async function run(label: string, cmd: string[], cwd: string, env: Record<string, string>, input: string): Promise<World["runs"][number]> {
	const p = Bun.spawn(cmd, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: PROCESS_KILL_MS, killSignal: "SIGKILL" });
	p.stdin.write(input);
	await p.stdin.end();
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	const r = { label, code, killed: p.signalCode === "SIGKILL", out, err };
	world().runs.push(r);
	return r;
}

function git(repo: string, args: string[], env: Record<string, string>): void {
	const r = Bun.spawnSync(["git", "-C", repo, ...args], { env, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${r.exitCode}: ${r.stderr.toString()}`);
}

/** The workload's control rows, through a fresh handle (the processes write through their own). */
function control(ledgerPath: string, wl: string) {
	const l = Ledger.open(ledgerPath, { backup: false, backupOnOpen: false });
	try {
		const entries = l.entries(wl);
		return { entries, control: controlEntries(entries, holdersOf(entries, l.workload(wl)?.holder ?? null)) };
	} finally {
		l.close();
	}
}

/** The by-hand lane's session file: the one top-level JSONL OMP wrote under the lane dir's sessions. */
function byHandSession(): string {
	const dir = join(laneDir(world().byHandWl, world().home), "sessions");
	const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("."));
	if (files.length !== 1) throw new Error(`expected one session file in ${dir}, found ${files.join(", ") || "none"}`);
	return join(dir, files[0]!);
}

type SessionLine = { type: string; customType?: string; content?: unknown; display?: boolean; message?: { role: string; content: unknown } };
const sessionLines = (): SessionLine[] =>
	readFileSync(byHandSession(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as SessionLine);
const textOf = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? "").join("\n") : "";

/**
 * Ends every process the sessions left: the runner and the drain (settleDrains), every omp a lane-started: row names and
 * every ctx-index worker once it recorded its outcome. A process still alive past the wait is SIGKILLed.
 */
async function reap(x: World): Promise<void> {
	const failures: unknown[] = [];
	const asRoot = { root: x.root, home: x.home, repo: x.repo, remote: "", ledgerPath: x.ledgerPath, record: "", script: "", env: x.env } satisfies LaneRoot;
	try {
		await settleDrains(asRoot);
	} catch (err) {
		failures.push(err);
	}
	const pids = new Set<number>();
	for (const wl of [x.byHandWl, x.autoWl]) {
		const { control: c } = control(x.ledgerPath, wl);
		const lanes = new Set(c.filter((e) => e.prefix === "lane-started").map((e) => e.laneId!));
		for (const laneId of lanes) {
			const started = laneStarted(c, laneId);
			if (started?.pid) pids.add(started.pid);
			// The ctx-index worker the exit spawned: its claim names its pid, and its outcome follows.
			try {
				await until(`the ctx-index outcome of ${laneId}`, () =>
					control(x.ledgerPath, wl).entries.some((e) => e.body.startsWith(`ctx-index: ${laneId} `) && !e.body.startsWith(`ctx-index: ${laneId} claimed `)), 30_000);
			} catch (err) {
				failures.push(err);
			}
		}
		for (const e of control(x.ledgerPath, wl).entries) {
			const m = /^ctx-index: \S+ claimed (\d+)$/.exec(e.body);
			if (m) pids.add(Number(m[1]));
		}
	}
	for (const pid of pids) {
		try {
			await until(`pid ${pid} gone`, () => !alive(pid), 15_000);
		} catch (err) {
			failures.push(err);
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Gone between the check and the signal.
			}
			await until(`pid ${pid} gone after SIGKILL`, () => !alive(pid), 10_000);
		}
	}
	if (failures.length > 0) throw new Error(failures.map(String).join("\n"));
}

beforeAll(async () => {
	if (!HAS_OMP) return;
	const onPath = Bun.which("omp");
	if (!onPath || !realpathSync(onPath).startsWith(`${OMP}/`)) throw new Error(`the omp on PATH (${onPath ?? "none"}) is not the installed OMP at ${OMP}`);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "as2-by-hand-session-")));
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const requests: World["requests"] = { "by-hand": [], hand: [], autonomous: [], orchestrator: [] };
	let byHandWl = "";
	let autoWl = "";
	const brief = (): string =>
		`slice: ${SL_HAND}\nworkload: ${byHandWl}\ntask: report the first line of README.md (${HAND_MARK})\ndone-condition: the line is reported\ninputs: README.md in the lane worktree\nstakes: normal\nceiling-share: 1`;
	const tool = (name: string, input: Record<string, unknown>): StubTurn => ({ text: name, tool: { name, input } });
	/** The by-hand lane's turns, by the number of tool results so far: wake read, the three skills, a slice, its hand, the wait. */
	const byHandSteps = (): StubTurn[] => [
		tool("ledger_wake_read", { body: "by-hand session test: seeded workload, nothing done yet; next: read the vendored skills.", i: "Recording the wake read" }),
		...VENDORED.map((s) => tool("read", { path: `skill://${s}`, i: `Reading the ${s} skill` })),
		tool("lane_add_slice", { id: SL_HAND, kind: "locate", task: "report the first line of README.md", doneCondition: "the line is reported", inputs: "README.md", i: "Adding the hand's slice" }),
		tool("task", { i: "Dispatching the hand", context: "# Goal\nby-hand session test", tasks: [{ name: SL_HAND, agent: "fast", solutionSpace: "one read, given", task: brief() }] }),
		tool("wait", { i: "Waiting for the hand" }),
	];
	const stub = startStub({
		nonce: "by-hand-session",
		scripts: [
			{
				kind: "hand",
				match: (r) => r.tools.length > 0 && r.firstUser.includes(HAND_MARK),
				steps: [],
				after: ({ request }) => {
					requests.hand.push(request);
					const y = ["yield", "submit_result"].find((n) => request.tools.includes(n));
					if (!y || request.results.some((x) => x.name === y)) return { text: "done" };
					return tool(y, { data: { report: "**CLAIM**\nREADME.md line 1 is `by-hand session repo`." } });
				},
			},
			{
				kind: "by-hand",
				match: (r) => r.tools.length > 0 && byHandWl !== "" && r.firstUser.includes(byHandWl),
				steps: [],
				after: ({ request }) => {
					requests["by-hand"].push(request);
					const step = byHandSteps()[request.results.length];
					if (step) return step;
					return allText(request).includes(BLOCK_REASON) ? { text: `${VERDICT}` } : { text: "The hand reported the line." };
				},
			},
			{
				kind: "autonomous",
				match: (r) => r.tools.length > 0 && autoWl !== "" && r.firstUser.includes(autoWl),
				steps: [],
				after: ({ request }) => {
					requests.autonomous.push(request);
					if (request.results.length === 0) return tool("ledger_wake_read", { body: "by-hand session test: autonomous control lane; next: release.", i: "Recording the wake read" });
					if (request.results.length === 1) return tool("lane_release", { i: "Releasing the workload" });
					return { text: "released." };
				},
			},
			{
				kind: "orchestrator",
				match: (r) => r.tools.length > 0 && r.firstUser.includes(ORCH_MARK),
				steps: [],
				after: ({ request }) => {
					requests.orchestrator.push(request);
					if (request.results.length === 0) return tool("orchestrator_wake_read", { body: "by-hand session test: scratch orchestrator; nothing open to resume; next: none.", i: "Recording the wake read" });
					return { text: "Nothing to do." };
				},
			},
			// Title, skill-hint and other tool-less requests OMP makes out of band.
			{ kind: "other", match: () => true, steps: [], after: { text: "ok" } },
		],
	});
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		TMPDIR: process.env.TMPDIR ?? tmpdir(),
		// The quota guard reads the real home's polls otherwise (classifier/src/headroom.ts; os.homedir ignores HOME).
		AS2_HEADROOM_POLLS: join(root, "no-headroom-polls.jsonl"),
	};
	w = { root, home, repo: join(root, "repo"), ledgerPath: join(home, ".agent-system-2", "ledger.db"), env, stub, byHandWl, autoWl, requests, runs: [] };

	// The profile, as a fresh machine gets it (install/fresh-machine-test.sh run_install), then the stub's routes over it.
	// The installer never gets the developer PATH (only Bun and system utilities, as ledger/test/install.test.ts does), so it
	// cannot reach a real herdr or ctx: a real herdr would register its plugin under this scratch HOME, and its socket path
	// there can exceed sun_path. The session below keeps env.PATH, since it needs the installed OMP.
	const installBin = join(root, "install-bin");
	mkdirSync(installBin);
	symlinkSync(process.execPath, join(installBin, "bun"));
	const installPath = `${installBin}:/usr/bin:/bin`;
	for (const bin of ["herdr", "ctx"]) if (Bun.which(bin, { PATH: installPath })) throw new Error(`${bin} is on the installer PATH ${installPath}`);
	const install = await run("install.sh", ["bash", join(REPO, "install", "install.sh")], REPO, { PATH: installPath, HOME: home }, "");
	if (install.code !== 0) throw new Error(`install.sh exited ${install.code}: ${install.err.slice(-2000)}`);
	writeStubProfile(join(home, ".omp", "profiles", "agent-system-2", "agent"), stub.port);
	// Jo's ask-graham setting (plugins/VENDOR.md): every idea gets the nudge.
	mkdirSync(join(home, ".config", "ask-graham"), { recursive: true });
	writeFileSync(join(home, ".config", "ask-graham", "config"), "intensity=every-idea\n");

	const repo = world().repo;
	mkdirSync(repo);
	writeFileSync(join(repo, "README.md"), "by-hand session repo\n");
	for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) git(repo, args, env);

	const l = Ledger.open(world().ledgerPath, { backup: false, backupOnOpen: false });
	try {
		byHandWl = l.openWorkload({ by: SURFACE_BY, brief: BRIEF, stakes: "normal", mode: "user-driven" });
		recordRepo(l, byHandWl, repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: byHandWl, kind: "assumption", body: doneBody(DONE) });
		l.addSlice({ by: SURFACE_BY, workloadId: byHandWl, task: SEEDED_TASK, doneCondition: "bun test header passes", inputs: "src/header.css" });
		l.recordInstruction({ by: SURFACE_BY, workloadId: byHandWl, body: INSTRUCTION, author: "jo", channel: "surface" });
		autoWl = l.openWorkload({ by: SURFACE_BY, brief: "autonomous control lane for the by-hand session test", stakes: "normal", mode: "autonomous" });
		recordRepo(l, autoWl, repo);
	} finally {
		l.close();
	}
	world().byHandWl = byHandWl;
	world().autoWl = autoWl;

	// Jo's `as2 lane <wl>`, a pipe for the terminal.
	await run("as2 lane", ["bash", AS2, "lane", byHandWl], repo, env, "");
	// An autonomous lane, as orchestrator_launch_lane starts it; its runner is detached, so the wait is on its lane-exit:.
	const launched = await run("lane.ts launch", ["bun", LANE_SCRIPT, "launch", autoWl, "--requested-by", "jo"], repo, env, "");
	if (launched.code === 0) {
		await until(`the autonomous lane's lane-exit:`, () => control(world().ledgerPath, autoWl).control.some((c) => c.prefix === "lane-exit"), PROCESS_KILL_MS);
	}
	// The orchestrator, `as2` with its first message piped in.
	await run("as2", ["bash", AS2], repo, env, `${ORCH_MARK}: what is open?`);
}, 6 * PROCESS_KILL_MS);

afterAll(async () => {
	if (!w) return;
	const x = w;
	try {
		await reap(x);
	} finally {
		x.stub.stop();
		rmSync(x.root, { recursive: true, force: true });
	}
}, 120_000);

/** The first tool-offering payload of `kind`; fails naming every process's output when there is none. */
function firstPayload(kind: Kind): StubRequest {
	const r = world().requests[kind][0];
	if (!r) throw new Error(`no ${kind} request reached the stub; runs: ${JSON.stringify(world().runs.map((x) => ({ ...x, out: x.out.slice(-1500), err: x.err.slice(-1500) })))}`);
	return r;
}

describe.skipIf(!HAS_OMP)(`a by-hand lane started by \`as2 lane <wl>\` under the rendered profile${OMP_SKIP}`, () => {
	test("every process this file started exited on its own, the by-hand lane with 0", () => {
		expect(world().runs.map((r) => ({ label: r.label, killed: r.killed }))).toEqual(
			["install.sh", "as2 lane", "lane.ts launch", "as2"].map((label) => ({ label, killed: false })),
		);
		expect(world().runs.find((r) => r.label === "as2 lane")?.code).toBe(0);
	});

	test("prompt.md, with the workload state, is the session's first user message and reaches the model", () => {
		const promptPath = join(laneDir(world().byHandWl, world().home), "prompt.md");
		const prompt = readFileSync(promptPath, "utf8");
		for (const mark of [BRIEF, DONE, SEEDED_TASK, INSTRUCTION, "## Workload state now"]) expect(prompt).toContain(mark);
		// OMP's `@file` text (src/cli/file-processor.ts): the file wrapped in its absolute path.
		const supplied = `<file name="${promptPath}">\n${prompt}\n</file>`;
		expect(firstPayload("by-hand").firstUser).toContain(supplied);
		const users = sessionLines().filter((l) => l.type === "message" && l.message?.role === "user");
		expect(textOf(users[0]?.message?.content)).toContain(supplied);
	});

	test("the skill listing is the manifest's skill rows, and paired-coding, i-have-audhd and ask-graham load from their vendored paths", () => {
		const system = firstPayload("by-hand").system;
		const listing = system.slice(system.indexOf("<skills>"), system.indexOf("</skills>"));
		expect([...listing.matchAll(/^- ([a-z0-9-]+): /gm)].map((m) => m[1]).sort()).toEqual(MANIFEST_SKILLS);
		const reads = new Map(world().requests["by-hand"].at(-1)!.results.filter((r) => r.name === "read").map((r) => [r.text.split("\n")[0], r.isError]));
		for (const s of VENDORED) expect(reads.get(`[Skill file: ${join(REPO, "plugins", s, "skills", s, "SKILL.md")}]`)).toBe(false);
	});

	test("pair_start and the other seven pair tools are offered once each, as tools and nowhere else", () => {
		const first = firstPayload("by-hand");
		expect(pairNames(first.tools).sort()).toEqual([...PAIR_TOOLS].sort());
		expect(new Set(first.tools).size).toBe(first.tools.length);
		// Not also as an xd:// device or a second registration in the prompt's device list.
		expect(first.system).not.toContain("xd://pair_");
		for (const r of world().requests["by-hand"]) expect(pairNames(r.tools).sort()).toEqual([...PAIR_TOOLS].sort());
	});

	test("the lane gets i-have-audhd's core and ask-graham's nudge, both hidden, in its first request", () => {
		const first = allText(firstPayload("by-hand"));
		expect(first).toContain(JSON.stringify(AUDHD_CORE).slice(1, -1));
		expect(first).toContain(JSON.stringify(NUDGE).slice(1, -1));
		const custom = sessionLines().filter((l) => l.type === "custom_message");
		const audhd = custom.find((l) => l.customType === "i-have-audhd-session-start");
		expect(audhd?.display).toBe(false);
		expect(textOf(audhd?.content)).toContain(AUDHD_CORE);
		expect(custom.find((l) => l.customType === "ask-graham")).toMatchObject({ content: NUDGE, display: false });
	});

	test("a turn that read the ask-graham skill and ended without a verdict is sent back once, and ends on the verdict", () => {
		const lane = world().requests["by-hand"];
		const blocked = lane.filter((r) => allText(r).includes(BLOCK_REASON));
		expect(blocked.length).toBe(1);
		expect(lane.at(-1)).toBe(blocked[0]);
		const assistants = sessionLines().filter((l) => l.type === "message" && l.message?.role === "assistant");
		expect(textOf(assistants.at(-1)?.message?.content)).toContain(VERDICT);
	});
});

describe.skipIf(!HAS_OMP)(`the sessions that get no pair tool${OMP_SKIP}`, () => {
	test("a hand of the by-hand lane, with the lane's AGENT_SYSTEM_BY_HAND=1 still set, has no pair tool, no AuDHD core and no nudge", () => {
		const hand = firstPayload("hand");
		const started = laneStarted(control(world().ledgerPath, world().byHandWl).control);
		expect(started?.argv?.at(-1)).toBe(`@${join(laneDir(world().byHandWl, world().home), "prompt.md")}`);
		expect(hand.tools.length).toBeGreaterThan(0);
		expect(pairNames(hand.tools)).toEqual([]);
		expect(allText(hand)).not.toContain(JSON.stringify(NUDGE).slice(1, -1));
		expect(allText(hand)).not.toContain(JSON.stringify(AUDHD_CORE).slice(1, -1));
		expect(hand.system).not.toContain(AUDHD_CORE);
	});

	test("an autonomous lane has the lane tools, i-have-audhd's core and ask-graham's nudge, and no pair tool", () => {
		const auto = firstPayload("autonomous");
		expect(auto.tools).toContain("lane_add_slice");
		expect(pairNames(auto.tools)).toEqual([]);
		expect(allText(auto)).toContain(JSON.stringify(AUDHD_CORE).slice(1, -1));
		expect(allText(auto)).toContain(JSON.stringify(NUDGE).slice(1, -1));
	});

	test("the orchestrator has i-have-audhd's core and ask-graham's nudge, and no pair tool", () => {
		const orch = firstPayload("orchestrator");
		expect(orch.tools).toContain("orchestrator_wake_read");
		expect(pairNames(orch.tools)).toEqual([]);
		expect(allText(orch)).toContain(JSON.stringify(AUDHD_CORE).slice(1, -1));
		expect(allText(orch)).toContain(JSON.stringify(NUDGE).slice(1, -1));
	});
});
