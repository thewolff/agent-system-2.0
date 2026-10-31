// The surface half of the per-workload scratch root (PLAN wl-mv5oikd5jtquww § 1.5): `laneEnv` exports
// AS2_SCRATCH, the lane script creates the root before omp starts and names it in the first prompt,
// the lane extension measures it at turn end against the advisory cap and tells the lane, errorLines
// renders an open over-cap (and the daily sweep's disk entry) under needs-you, and the close tool
// removes the root once the row has closed, refusing a root that is a symlink.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH_CAP_DEFAULT_MB, SCRATCH_ENTRY, scratchRootFor } from "../../gates/src/scratch";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
// Namespace imports for this slice's new exports: a missing one fails only the test that calls it, not the module load.
import * as laneRow from "../extensions/lane";
import * as laneScript from "../scripts/lane";
import { errorLines } from "../src/errors";
import { closeScratchRoot } from "../src/close-entry";
import { ensureStandingWorkload } from "../src/identity";
import { ensureScratchRoot } from "../src/scratch-root";
import * as launch from "../src/launch";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, tempLedger, tmp, workloadWithSlice } from "./helpers";

const MIB = 1024 * 1024;
/** PLAN § 1.5: the turn-end measure runs at most once every 5 minutes. */
const MEASURE_MS = 5 * 60_000;
/** The daily sweep's `created_by`, the only writer launch.ts WRITERS admits for the disk lines. */
const SWEEP_BY = launch.SCRATCH_SWEEP_BY;
const scratchLines = (ledger: Ledger) => errorLines(ledger).filter((l) => l.kind === "scratch");
/** What the fake pi's before_agent_start emit returns: every handler's message, collected (helpers.ts `fakePi`). */
type Started = { messages: { customType: string; content: string }[] };

afterEach(() => {
	setSystemTime();
});

describe("laneEnv and the launcher (§ 1.5 creation)", () => {
	test("laneEnv exports AS2_SCRATCH = scratchRootFor(HOME, workload id), over any value the starter carries; HOME falls back to this process's HOME (ledger/src/locality.ts homeDir)", () => {
		const base = { HOME: "/h", PATH: "/bin", AS2_SCRATCH: "/tmp/elsewhere" };
		const bound = launch.laneEnv(base, { workloadId: "wl-a1", laneId: "lane-a1-1" }, { ok: true, value: "off" });
		expect(bound.AS2_SCRATCH).toBe(scratchRootFor("/h", "wl-a1"));
		expect(bound.AS2_SCRATCH).toBe("/h/agent-scratch/agent-system-2.0/scratch/wl-a1");
		expect(bound).toMatchObject({ AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_WORKLOAD_ID: "wl-a1", AGENT_SYSTEM_LANE_ID: "lane-a1-1" });
		expect(launch.laneEnv({ PATH: "/bin" }, { workloadId: "wl-a1", laneId: "lane-a1-1" }, { ok: true, value: "off" }).AS2_SCRATCH).toBe(scratchRootFor(process.env.HOME!, "wl-a1"));
	});

	test("the drain's starter env drops AS2_SCRATCH with the rest of the binding", () => {
		const base = { HOME: "/h", PATH: "/bin" };
		expect(laneScript.starterEnv(launch.laneEnv(base, { workloadId: "wl-a1", laneId: "lane-a1-1" }, { ok: true, value: "off" }))).toEqual(base);
	});

	test("ensureScratchRoot makes the root 0700 and keeps what it holds across relaunches; a symlinked root fails", () => {
		const home = tmp("scratch-home");
		const root = ensureScratchRoot(home, "wl-r1");
		expect(root).toBe(scratchRootFor(home, "wl-r1"));
		expect(lstatSync(root).isDirectory()).toBe(true);
		expect(lstatSync(root).mode & 0o777).toBe(0o700);
		writeFileSync(join(root, "kept.txt"), "x");
		expect(ensureScratchRoot(home, "wl-r1")).toBe(root);
		expect(readFileSync(join(root, "kept.txt"), "utf8")).toBe("x");
		const outside = tmp("scratch-outside");
		symlinkSync(outside, scratchRootFor(home, "wl-r2"));
		expect(() => ensureScratchRoot(home, "wl-r2")).toThrow("is not a directory");
	});

	test("a lane's won claim re-creates its missing root (the sweep removed it while unheld), 0700; a claim lost to a live holder creates nothing", async () => {
		const home = tmp("scratch-home");
		const path = join(tmp("ledger"), "ledger.db");
		const ledger = Ledger.open(path, { create: true, backup: false, backupOnOpen: false });
		const wl = ledger.openWorkload({ by: "orch", brief: "Fix the feed header", stakes: "normal", mode: "autonomous" });
		const held = ledger.openWorkload({ by: "orch", brief: "Someone else's", stakes: "normal", mode: "autonomous" });
		expect(ledger.claimWorkload(held, { by: "lane-z", holder: "lane-z", leaseMs: 3_600_000 }).won).toBe(true);
		const env = (id: string) => ({ AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: id, AGENT_SYSTEM_LANE_ID: "lane-a", HOME: home });
		const root = scratchRootFor(home, wl);
		expect(existsSync(root)).toBe(false);
		const f = fakePi();
		orchestratorSurface(f.pi, env(wl));
		await f.emit("session_start", { type: "session_start" }, ctxOf());
		expect(ledger.workload(wl)!.holder).toBe("lane-a");
		expect(lstatSync(root).isDirectory()).toBe(true);
		expect(lstatSync(root).mode & 0o777).toBe(0o700);
		const g = fakePi();
		orchestratorSurface(g.pi, env(held));
		await g.emit("session_start", { type: "session_start" }, ctxOf());
		expect(ledger.workload(held)!.holder).toBe("lane-z");
		expect(existsSync(scratchRootFor(home, held))).toBe(false);
	});

	test("the first prompt names the root and its cap on the line after worktree:; the cap comes from AGENT_SYSTEM_SCRATCH_CAP_MB", () => {
		expect(launch.scratchCapMb({})).toBe(SCRATCH_CAP_DEFAULT_MB);
		expect(launch.scratchCapMb({ AGENT_SYSTEM_SCRATCH_CAP_MB: "512" })).toBe(512);
		expect(launch.scratchCapMb({ AGENT_SYSTEM_SCRATCH_CAP_MB: "nope" })).toBe(SCRATCH_CAP_DEFAULT_MB);
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		const root = scratchRootFor("/h", wl);
		const lines = launch.firstPrompt({
			workload: ledger.workload(wl)!, laneId: "lane-m-1", repo: "/r", worktree: `/r-lanes/${wl}`, branch: `wl/${wl}`, done: "it works", planFirst: null,
			decisionLog: "", facts: "", resolved: [], instructions: [], machinery: true, tools: ["lane_release"], scratch: { root, capMb: SCRATCH_CAP_DEFAULT_MB },
		}).split("\n");
		const at = lines.findIndex((l) => l.startsWith("worktree: "));
		expect(lines[at + 1]).toBe(`scratch: ${root} (cap ${SCRATCH_CAP_DEFAULT_MB} MiB)`);
	});
});

describe("the advisory cap (§ 1.5)", () => {
	test("scratchKib measures with du -sk, bounded; a missing root measures null", () => {
		expect(laneRow.SCRATCH_DU_MS).toBe(5_000);
		expect(laneRow.SCRATCH_MEASURE_MS).toBe(MEASURE_MS);
		const root = tmp("scratch-du");
		writeFileSync(join(root, "blob"), Buffer.alloc(2 * MIB, 120));
		expect(laneRow.scratchKib(root)!).toBeGreaterThanOrEqual(2048);
		expect(laneRow.scratchKib(join(root, "missing"))).toBeNull();
	});

	test("scratchCapCheck writes over-cap once per crossing and under-cap only after an open over-cap", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		const check = (kib: number) => laneRow.scratchCapCheck(ledger, { workloadId: wl, by: "lane-a", root: "/r", capMb: 1, kib });
		expect(check(512)).toBeNull();
		expect(check(1536)).toBe(`${SCRATCH_ENTRY.overCap} 1.5 MiB over the 1 MiB cap at /r`);
		expect(check(2048)).toBeNull();
		expect(check(1024)).toBe(`${SCRATCH_ENTRY.underCap} 1.0 MiB within the 1 MiB cap at /r`);
		expect(check(100)).toBeNull();
		expect(ledger.entries(wl, "assumption").map((e) => [e.created_by, e.body.split(" ")[0]])).toEqual([["lane-a", SCRATCH_ENTRY.overCap], ["lane-a", SCRATCH_ENTRY.underCap]]);
	});

	test("through the lane row: a turn end over the cap writes one scratch-over-cap:, needs-you shows it, the next turn tells the lane once; within 5 minutes nothing is measured; later under the cap clears it", async () => {
		const home = tmp("scratch-home");
		const path = join(tmp("ledger"), "ledger.db");
		const ledger = Ledger.open(path, { create: true, backup: false, backupOnOpen: false });
		const wl = ledger.openWorkload({ by: "orch", brief: "Fix the feed header", stakes: "normal", mode: "autonomous" });
		ledger.addSlice({ by: "orch", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		const env = { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-a", HOME: home, AGENT_SYSTEM_SCRATCH_CAP_MB: "1" };
		const root = scratchRootFor(home, wl);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "blob"), Buffer.alloc(2 * MIB, 120));
		const f = fakePi();
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf();
		const start = Date.now();
		setSystemTime(new Date(start));
		await f.emit("session_start", { type: "session_start" }, ctx);
		const scratchMessages = async () => {
			const started = (await f.emit("before_agent_start", { prompt: "go on", systemPrompt: [] }, ctx)) as Started;
			return started.messages.filter((m) => m.customType === "lane-scratch");
		};

		// a turn that will continue is not a turn end
		await f.emit("agent_end", { willContinue: true }, ctx);
		expect(scratchLines(ledger)).toEqual([]);
		await f.emit("agent_end", { willContinue: false }, ctx);
		const over = ledger.entries(wl, "assumption").filter((e) => e.body.startsWith(SCRATCH_ENTRY.overCap));
		expect(over).toHaveLength(1);
		expect(over[0]!.created_by).toBe("lane-a");
		expect(over[0]!.body).toMatch(new RegExp(`^scratch-over-cap: \\d+\\.\\d MiB over the 1 MiB cap at ${root}$`));
		const lines = scratchLines(ledger);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ kind: "scratch", workloadId: wl, rowId: over[0]!.id });
		expect(lines[0]!.line).toContain(`scratch of ${wl} over its cap: `);
		expect(lines[0]!.line).toContain(root);
		expect(lines[0]!.n).toBeUndefined();
		// nothing is refused: the workload and slice are untouched, only the entry and the line exist
		expect(ledger.workload(wl)!.holder).toBe("lane-a");

		// the lane is told at the start of its next turn, once
		const told = await scratchMessages();
		expect(told).toHaveLength(1);
		expect(told[0]!.content).toContain("over its cap");
		expect(told[0]!.content).toContain(root);
		expect(await scratchMessages()).toEqual([]);

		// emptied, but measured again only after SCRATCH_MEASURE_MS
		rmSync(join(root, "blob"));
		setSystemTime(new Date(start + MEASURE_MS - 1_000));
		await f.emit("agent_end", { willContinue: false }, ctx);
		expect(ledger.entries(wl, "assumption").filter((e) => e.body.startsWith(SCRATCH_ENTRY.underCap))).toEqual([]);
		expect(scratchLines(ledger)).toHaveLength(1);
		setSystemTime(new Date(start + MEASURE_MS + 1_000));
		await f.emit("agent_end", { willContinue: false }, ctx);
		expect(ledger.entries(wl, "assumption").filter((e) => e.body.startsWith(SCRATCH_ENTRY.underCap)).map((e) => e.created_by)).toEqual(["lane-a"]);
		expect(scratchLines(ledger)).toEqual([]);
		expect(await scratchMessages()).toEqual([]);
		ledger.close();
	});
});

describe("needs-you kind `scratch` (§ 1.5, § 1.6)", () => {
	test("an open scratch-over-cap: from the lane holding the workload renders one line until its scratch-under-cap:; a non-holder's lines count for nothing", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		expect(ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 60_000 }).won).toBe(true);
		expect(scratchLines(ledger)).toEqual([]);
		ledger.recordEntry({ by: "lane-x", workloadId: wl, kind: "assumption", body: `${SCRATCH_ENTRY.overCap} 9999.0 MiB over the 2048 MiB cap at /h/s/${wl}` });
		expect(scratchLines(ledger)).toEqual([]);
		const en = ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: `${SCRATCH_ENTRY.overCap} 3000.0 MiB over the 2048 MiB cap at /h/s/${wl}` });
		const line = { kind: "scratch", workloadId: wl, rowId: en, next: "advisory: nothing is refused", line: `scratch of ${wl} over its cap: 3000.0 MiB over the 2048 MiB cap at /h/s/${wl} (advisory: nothing is refused; lane-a was told)` };
		expect(scratchLines(ledger)).toEqual([line]);
		// a forged clear from anyone but a holder (here the surface) does not hide it
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: `${SCRATCH_ENTRY.underCap} 1.0 MiB within the 2048 MiB cap at /h/s/${wl}` });
		expect(scratchLines(ledger)).toEqual([line]);
		ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: `${SCRATCH_ENTRY.underCap} 10.0 MiB within the 2048 MiB cap at /h/s/${wl}` });
		expect(scratchLines(ledger)).toEqual([]);
	});

	test("the sweep's scratch-disk: on the standing workload renders one line until its scratch-disk-ok:; another writer's is not the sweep's", () => {
		const { ledger } = tempLedger();
		ensureStandingWorkload(ledger);
		const disk = (by: string, body: string) => ledger.recordEntry({ by, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
		disk("lane-x", `${SCRATCH_ENTRY.disk} 99999.0 MiB under /h passes 10240 MiB (AGENT_SYSTEM_SCRATCH_TOTAL_MB); report /r.md`);
		expect(scratchLines(ledger)).toEqual([]);
		const en = disk(SWEEP_BY, `${SCRATCH_ENTRY.disk} 12000.5 MiB under /h passes 10240 MiB (AGENT_SYSTEM_SCRATCH_TOTAL_MB); report /r.md`);
		expect(scratchLines(ledger)).toEqual([
			{
				kind: "scratch", workloadId: STANDING_WORKLOAD_ID, rowId: en, next: "the daily sweep clears this line once the total is back under",
				line: "scratch disk: 12000.5 MiB under /h passes 10240 MiB (AGENT_SYSTEM_SCRATCH_TOTAL_MB); report /r.md — the daily sweep clears this line once the total is back under",
			},
		]);
		disk("lane-x", `${SCRATCH_ENTRY.diskOk} 1.0 MiB under /h, at or under 10240 MiB; report /forged.md`);
		expect(scratchLines(ledger)).toHaveLength(1);
		disk(SWEEP_BY, `${SCRATCH_ENTRY.diskOk} 900.0 MiB under /h, at or under 10240 MiB; report /r2.md`);
		expect(scratchLines(ledger)).toEqual([]);
	});
});

describe("orchestrator_close_workload removes the root after the close (§ 1.5)", () => {
	function closing() {
		const voice = join(tmp("voice"), "VOICE.md");
		writeFileSync(voice, "VOICE DOC BODY");
		const home = tmp("scratch-home");
		const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: home };
		const ledger = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false });
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "tidy the feed header", stakes: "normal", mode: "autonomous" });
		const f = fakePi();
		orchestratorSurface(f.pi, e);
		const repo = tmp("repo");
		mkdirSync(join(repo, ".ai", "decision-log"), { recursive: true });
		const ctx = ctxOf({ cwd: repo });
		const close = async () => (await f.tool("orchestrator_close_workload").execute("1", { workloadId: wl }, undefined, undefined, ctx)).content[0]!.text;
		const scratchEntries = () => (ledger.workload(STANDING_WORKLOAD_ID) ? ledger.entries(STANDING_WORKLOAD_ID, "assumption") : []).filter((x) => x.body.startsWith("scratch-"));
		return { home, ledger, wl, close, scratchEntries };
	}

	test("the root goes, a symlink inside it is removed as a link (its target stays), and scratch-removed: is recorded on the standing workload", async () => {
		const { home, ledger, wl, close, scratchEntries } = closing();
		const root = scratchRootFor(home, wl);
		mkdirSync(root, { recursive: true });
		mkdirSync(join(root, "clone", "deep"), { recursive: true });
		writeFileSync(join(root, "clone", "deep", "f.txt"), "x");
		const outside = tmp("scratch-outside");
		writeFileSync(join(outside, "keep.txt"), "keep");
		symlinkSync(outside, join(root, "link"));
		const text = await close();
		expect(text).toStartWith(`Closed ${wl}. Scratch root ${root} removed (entry en-`);
		expect(ledger.workload(wl)!.status).toBe("closed");
		expect(existsSync(root)).toBe(false);
		expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
		expect(scratchEntries().map((x) => [x.created_by, x.body])).toEqual([[SURFACE_BY, `${SCRATCH_ENTRY.removed} ${wl} ${root}`]]);
		ledger.close();
	});

	test("a root that is a symlink is refused: the close still goes through, the target is untouched, scratch-remove-failed: is recorded", async () => {
		const { home, ledger, wl, close, scratchEntries } = closing();
		const outside = tmp("scratch-outside");
		writeFileSync(join(outside, "keep.txt"), "keep");
		const root = scratchRootFor(home, wl);
		mkdirSync(join(root, ".."), { recursive: true });
		symlinkSync(outside, root);
		const text = await close();
		expect(text).toStartWith(`Closed ${wl}. Scratch root ${root} not removed: the root is a symlink (entry en-`);
		expect(ledger.workload(wl)!.status).toBe("closed");
		expect(lstatSync(root).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
		expect(scratchEntries().map((x) => [x.created_by, x.body])).toEqual([[SURFACE_BY, `${SCRATCH_ENTRY.removeFailed} ${wl} ${root}: the root is a symlink`]]);
		ledger.close();
	});

	test("a base reached through a symlink still removes exactly <realpath(base)>/<id>; a missing root is a no-op with no entry", async () => {
		const a = closing();
		const real = tmp("scratch-real-base");
		mkdirSync(join(a.home, "agent-scratch", "agent-system-2.0"), { recursive: true });
		symlinkSync(real, join(a.home, "agent-scratch", "agent-system-2.0", "scratch"));
		mkdirSync(join(real, a.wl));
		writeFileSync(join(real, a.wl, "f.txt"), "x");
		const sibling = join(real, "wl-other");
		mkdirSync(sibling);
		expect(await a.close()).toContain(`Scratch root ${scratchRootFor(a.home, a.wl)} removed`);
		expect(existsSync(join(real, a.wl))).toBe(false);
		expect(existsSync(sibling)).toBe(true);
		expect(realpathSync(real)).toBe(realpathSync(join(a.home, "agent-scratch", "agent-system-2.0", "scratch")));
		a.ledger.close();

		const b = closing();
		const text = await b.close();
		expect(text).toStartWith(`Closed ${b.wl}.`);
		expect(text).not.toContain("Scratch root");
		expect(b.ledger.workload(b.wl)!.status).toBe("closed");
		expect(b.scratchEntries()).toEqual([]);
		b.ledger.close();
	});

	test("with no HOME anywhere the close's scratch step does not throw: nothing is removed or recorded, and the sentence says why", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		const saved = process.env.HOME;
		delete process.env.HOME;
		try {
			expect(closeScratchRoot(ledger, {}, wl)).toBe(`Scratch root of ${wl} not removed: HOME is not set: set HOME or AGENT_SYSTEM_LEDGER_DB.`);
		} finally {
			process.env.HOME = saved;
		}
		expect(ledger.workload(STANDING_WORKLOAD_ID)).toBeFalsy();
		ledger.close();
	});
});
