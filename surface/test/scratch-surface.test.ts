// The surface half of the per-workload scratch root (PLAN wl-mv5oikd5jtquww § 1.5): `laneEnv` exports
// AS2_SCRATCH, the lane script creates the root before omp starts and names it in the first prompt,
// the lane extension measures it at turn end against the advisory cap and tells the lane, errorLines
// renders an open over-cap (and the daily sweep's disk entry) under needs-you, and the close tool
// archives the root once the row has closed and only then removes it, keeping a root whose archive
// fails and refusing a root that is a symlink.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH_CAP_DEFAULT_MB, SCRATCH_ENTRY, scratchRootFor } from "../../gates/src/scratch";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
// Namespace imports for this slice's new exports: a missing one fails only the test that calls it, not the module load.
import * as laneRow from "../extensions/lane";
import * as laneScript from "../scripts/lane";
import { errorLines } from "../src/errors";
import { closeScratchRoot } from "../src/close-entry";
import { archiveDetached, archivePathFor, purgeArchived, scratchArchiveBase } from "../src/scratch-archive";
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
		const line = { kind: "scratch", workloadId: wl, rowId: en, line: `scratch of ${wl} over its cap: 3000.0 MiB over the 2048 MiB cap at /h/s/${wl} (advisory: nothing is refused; lane-a was told)` };
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
				kind: "scratch", workloadId: STANDING_WORKLOAD_ID, rowId: en,
				line: "scratch disk: 12000.5 MiB under /h passes 10240 MiB (AGENT_SYSTEM_SCRATCH_TOTAL_MB); report /r.md — the daily sweep clears this line once the total is back under and the free space back over",
			},
		]);
		disk("lane-x", `${SCRATCH_ENTRY.diskOk} 1.0 MiB under /h, at or under 10240 MiB; report /forged.md`);
		expect(scratchLines(ledger)).toHaveLength(1);
		disk(SWEEP_BY, `${SCRATCH_ENTRY.diskOk} 900.0 MiB under /h, at or under 10240 MiB; report /r2.md`);
		expect(scratchLines(ledger)).toEqual([]);
	});
});

/** The members `tar -tzf` lists in `archive`, as paths relative to the root ("" for the root itself), sorted. */
function members(archive: string): string[] {
	const r = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
	expect(r.exitCode).toBe(0);
	return r.stdout.toString().split("\n").filter((l) => l !== "").map((l) => l.replace(/^\.\/?/, "").replace(/\/$/, "")).sort();
}

/** The one archive under the archive base, or null when there is none (asserts there is at most one). */
function onlyArchive(home: string): string | null {
	const base = scratchArchiveBase(home);
	if (!existsSync(base)) return null;
	const found = readdirSync(base).flatMap((day) => readdirSync(join(base, day)).map((n) => join(base, day, n)));
	expect(found.length).toBeLessThanOrEqual(1);
	return found[0] ?? null;
}

describe("orchestrator_close_workload archives the root, then removes it, after the close (§ 1.5 as amended 2026-10-28)", () => {
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

	test("the root is archived (listed back, hashed) and only then removed; a symlink inside is archived and removed as a link (its target stays); scratch-archived: then scratch-removed: are recorded", async () => {
		const { home, ledger, wl, close, scratchEntries } = closing();
		const root = scratchRootFor(home, wl);
		mkdirSync(root, { recursive: true });
		mkdirSync(join(root, "clone", "deep"), { recursive: true });
		writeFileSync(join(root, "clone", "deep", "f.txt"), "x");
		writeFileSync(join(root, "REPORT.md"), "the deliverable");
		const outside = tmp("scratch-outside");
		writeFileSync(join(outside, "keep.txt"), "keep");
		symlinkSync(outside, join(root, "link"));
		const text = await close();
		const archive = onlyArchive(home);
		expect(archive).not.toBeNull();
		expect(archive!.startsWith(`${scratchArchiveBase(home)}/`)).toBe(true);
		expect(archive!).toEndWith(`/${wl}.tar.gz`);
		const bytes = lstatSync(archive!).size;
		const sha = new Bun.CryptoHasher("sha256").update(readFileSync(archive!)).digest("hex");
		expect(text).toStartWith(`Closed ${wl}. Scratch root ${root} archived to ${archive} (${bytes} bytes, sha256 ${sha}) and removed (entries en-`);
		expect(ledger.workload(wl)!.status).toBe("closed");
		expect(existsSync(root)).toBe(false);
		expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
		expect(members(archive!)).toEqual(["", "REPORT.md", "clone", "clone/deep", "clone/deep/f.txt", "link"].sort());
		// The archive holds the files themselves: unpacked, the deliverable reads back and the link is still a link.
		const out = tmp("scratch-unpack");
		expect(Bun.spawnSync(["tar", "-xzf", archive!, "-C", out]).exitCode).toBe(0);
		expect(readFileSync(join(out, "REPORT.md"), "utf8")).toBe("the deliverable");
		expect(lstatSync(join(out, "link")).isSymbolicLink()).toBe(true);
		expect(scratchEntries().map((x) => [x.created_by, x.body])).toEqual([
			[SURFACE_BY, `${SCRATCH_ENTRY.archived} ${wl} ${archive} ${bytes} ${sha}`],
			[SURFACE_BY, `${SCRATCH_ENTRY.removed} ${wl} ${root}`],
		]);
		ledger.close();
	});

	test("an archive that cannot be written keeps the root, whole: the close still goes through and scratch-remove-failed: says it was not archived", async () => {
		const { home, ledger, wl, close, scratchEntries } = closing();
		const root = scratchRootFor(home, wl);
		mkdirSync(join(root, "evidence"), { recursive: true });
		writeFileSync(join(root, "REPORT.md"), "the deliverable");
		writeFileSync(join(root, "evidence", "run.log"), "log");
		// The archive base is a plain file, so no archive directory can be made under it.
		mkdirSync(join(scratchArchiveBase(home), ".."), { recursive: true });
		writeFileSync(scratchArchiveBase(home), "not a directory");
		const text = await close();
		expect(text).toStartWith(`Closed ${wl}. Scratch root ${root} kept: not archived: `);
		expect(ledger.workload(wl)!.status).toBe("closed");
		expect(readFileSync(join(root, "REPORT.md"), "utf8")).toBe("the deliverable");
		expect(readFileSync(join(root, "evidence", "run.log"), "utf8")).toBe("log");
		expect(readdirSync(join(root, "..")).filter((n) => n.startsWith(".removing-"))).toEqual([]);
		const entries = scratchEntries().map((x) => [x.created_by, x.body]);
		expect(entries).toHaveLength(1);
		expect(entries[0]![0]).toBe(SURFACE_BY);
		expect(entries[0]![1]).toStartWith(`${SCRATCH_ENTRY.removeFailed} ${wl} ${root}: not archived (`);
		expect(entries[0]![1]).toEndWith("); the root is kept");
		ledger.close();
	});

	test("a done-because naming a path inside the root: the close result names the archive that holds it", async () => {
		const { home, ledger, wl, close } = closing();
		const root = scratchRootFor(home, wl);
		mkdirSync(join(root, "replay"), { recursive: true });
		writeFileSync(join(root, "replay", "REPORT.md"), "the deliverable");
		// The holder's receipt (decision 16): launched on the workload, holds it, records done-because, releases.
		ledger.recordEntry({ by: "lane-starter", workloadId: wl, kind: "assumption", body: "launch: lane-a cause first requested-by test" });
		expect(ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 60_000 }).won).toBe(true);
		ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: `done-because: the replay's verdict is in ${root}/replay/REPORT.md.` });
		ledger.releaseWorkload(wl, { by: "lane-a", holder: "lane-a" });
		const text = await close();
		const archive = onlyArchive(home);
		expect(archive).not.toBeNull();
		expect(text).toContain(`The done-because names ${root}/replay/REPORT.md, inside the scratch root: in the archive ${archive} as ./replay/REPORT.md.`);
		expect(existsSync(root)).toBe(false);
		expect(members(archive!)).toContain("replay/REPORT.md");
		ledger.close();
	});

	test("closeScratchRoot: done-because paths are checked against the archive's members: through $AS2_SCRATCH or ~, missing, `..`, through a link, a link itself; one inside a kept root says it is kept", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		const home = tmp("scratch-home");
		const root = scratchRootFor(home, wl);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "notes.md"), "n");
		const outside = tmp("scratch-outside");
		writeFileSync(join(outside, "REPORT.md"), "outside");
		symlinkSync(outside, join(root, "out"));
		const now = new Date("2026-10-28T22:17:00.000Z");
		const archive = archivePathFor(home, wl, now);
		const said = closeScratchRoot(ledger, { HOME: home }, wl, {
			doneBecause: `see $AS2_SCRATCH/notes.md and ~/agent-scratch/agent-system-2.0/scratch/${wl}/notes.md; also $AS2_SCRATCH/missing.md, $AS2_SCRATCH/../outside/REPORT.md, $AS2_SCRATCH/out/REPORT.md and $AS2_SCRATCH/out.`,
			now,
		});
		expect(said).toContain(`archived to ${archive} (`);
		expect(said).toContain(`The done-because names $AS2_SCRATCH/notes.md, inside the scratch root: in the archive ${archive} as ./notes.md.`);
		expect(said).toContain(`The done-because names ~/agent-scratch/agent-system-2.0/scratch/${wl}/notes.md, inside the scratch root: in the archive ${archive} as ./notes.md.`);
		expect(said).toContain(`The done-because names $AS2_SCRATCH/missing.md, inside the scratch root: not in the archive ${archive}: the root had no ./missing.md at close.`);
		expect(said).toContain("The done-because names $AS2_SCRATCH/../outside/REPORT.md, inside the scratch root: a path with a `..` component: not checked against the archive, and not known to be in it.");
		expect(said).toContain(`The done-because names $AS2_SCRATCH/out/REPORT.md, inside the scratch root: reached through the symlink ./out (→ ${outside}): the archive ${archive} holds that link, not what it points to.`);
		expect(said).toContain(`The done-because names $AS2_SCRATCH/out, inside the scratch root: a symlink (→ ${outside}): the archive ${archive} holds the link as ./out, not its target.`);
		expect(readFileSync(join(outside, "REPORT.md"), "utf8")).toBe("outside");

		const { wl: wl2 } = workloadWithSlice(ledger);
		const root2 = scratchRootFor(home, wl2);
		mkdirSync(root2, { recursive: true });
		writeFileSync(join(root2, "REPORT.md"), "r");
		rmSync(scratchArchiveBase(home), { recursive: true });
		writeFileSync(scratchArchiveBase(home), "not a directory");
		const kept = closeScratchRoot(ledger, { HOME: home }, wl2, { doneBecause: `report at ${root2}/REPORT.md`, now });
		expect(kept).toContain(`Scratch root ${root2} kept: not archived: `);
		expect(kept).toContain(`The done-because names ${root2}/REPORT.md, inside the scratch root, which is kept at ${root2}.`);
		expect(existsSync(join(root2, "REPORT.md"))).toBe(true);
		// A path that only shares the root's prefix (another workload's id) is not inside it.
		const { wl: wl3 } = workloadWithSlice(ledger);
		expect(closeScratchRoot(ledger, { HOME: home }, wl3, { doneBecause: `${root2}x/REPORT.md`, now })).toBe("");
		ledger.close();
	});

	describe("archive verification keeps the root on any doubt (closeScratchRoot seams)", () => {
		const now = new Date("2026-10-28T22:17:00.000Z");
		/** A root with a deliverable, a newer file that would mask an mtime-only check, and a link; and the detached path finder. */
		function setUp() {
			const { ledger } = tempLedger();
			const { wl } = workloadWithSlice(ledger);
			const home = tmp("scratch-home");
			const root = scratchRootFor(home, wl);
			mkdirSync(root, { recursive: true });
			writeFileSync(join(root, "REPORT.md"), "aaaa");
			writeFileSync(join(root, "newer.txt"), "n");
			const future = new Date(now.getTime() + 365 * 24 * 3600 * 1000);
			utimesSync(join(root, "newer.txt"), future, future);
			symlinkSync("REPORT.md", join(root, "link"));
			const detached = (): string => {
				const base = join(root, "..");
				const d = readdirSync(base).filter((n) => n.startsWith(".removing-"));
				expect(d).toHaveLength(1);
				return join(base, d[0]!);
			};
			const dayDir = join(scratchArchiveBase(home), "2026-10-28");
			const leftovers = () => (existsSync(dayDir) ? readdirSync(dayDir) : []);
			return { ledger, wl, home, root, detached, leftovers };
		}

		test("the root is renamed aside before tar runs: a write by the root's path during archiving never reaches the archived tree", () => {
			const { ledger, wl, home, root, detached } = setUp();
			let seenAside = false;
			const said = closeScratchRoot(ledger, { HOME: home }, wl, {
				now,
				seams: {
					afterTar: () => {
						seenAside = !existsSync(root) && existsSync(join(detached(), "REPORT.md"));
					},
				},
			});
			expect(seenAside).toBe(true);
			expect(said).toContain(") and removed (");
			expect(existsSync(root)).toBe(false);
			ledger.close();
		});

		test("a same-size rewrite during archiving, masked by a newer file, fails the final check: archive dropped, root renamed back whole", () => {
			const { ledger, wl, home, root, detached, leftovers } = setUp();
			const said = closeScratchRoot(ledger, { HOME: home }, wl, {
				now,
				seams: {
					beforeFinalCheck: () => {
						const p = join(detached(), "REPORT.md");
						const st = lstatSync(p);
						writeFileSync(p, "bbbb");
						utimesSync(p, st.atime, st.mtime);
					},
				},
			});
			expect(said).toContain(`Scratch root ${root} kept: not archived: `);
			expect(said).toContain("./REPORT.md was written or changed (its mtime or ctime moved)");
			expect(said).toContain("was dropped");
			expect(readFileSync(join(root, "REPORT.md"), "utf8")).toBe("bbbb");
			expect(existsSync(join(root, "newer.txt"))).toBe(true);
			expect(leftovers()).toEqual([]);
			ledger.close();
		});

		test("a changed link target during archiving fails the final check and keeps the root", () => {
			const { ledger, wl, home, root, detached } = setUp();
			const said = closeScratchRoot(ledger, { HOME: home }, wl, {
				now,
				seams: {
					beforeFinalCheck: () => {
						const p = join(detached(), "link");
						rmSync(p);
						symlinkSync("newer.txt", p);
					},
				},
			});
			expect(said).toContain(`Scratch root ${root} kept: not archived: `);
			expect(readlinkSync(join(root, "link"))).toBe("newer.txt");
			ledger.close();
		});

		test("an archive that does not hold the tree (its contents differ once extracted) fails verification and keeps the root", () => {
			const { ledger, wl, home, root, leftovers } = setUp();
			const other = tmp("scratch-other");
			writeFileSync(join(other, "REPORT.md"), "zzzz");
			const said = closeScratchRoot(ledger, { HOME: home }, wl, {
				now,
				seams: {
					afterTar: () => {
						const partial = leftovers().find((n) => n.includes(".partial-"))!;
						const at = join(scratchArchiveBase(home), "2026-10-28", partial);
						expect(Bun.spawnSync(["tar", "-czf", at, "-C", other, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).exitCode).toBe(0);
					},
				},
			});
			expect(said).toContain(`Scratch root ${root} kept: not archived: the archive does not hold the tree: `);
			expect(readFileSync(join(root, "REPORT.md"), "utf8")).toBe("aaaa");
			expect(leftovers()).toEqual([]);
			ledger.close();
		});

		test("too little free space on the archive volume refuses before tar runs and keeps the root", () => {
			const { ledger, wl, home, root, leftovers } = setUp();
			let tarRan = false;
			const said = closeScratchRoot(ledger, { HOME: home }, wl, { now, seams: { freeBytes: () => 1024, afterTar: () => (tarRan = true) } });
			expect(tarRan).toBe(false);
			expect(said).toContain(`Scratch root ${root} kept: not archived: 0.0 GiB free on `);
			expect(said).toContain("so the archive was not started");
			expect(readFileSync(join(root, "REPORT.md"), "utf8")).toBe("aaaa");
			expect(leftovers()).toEqual([]);
			ledger.close();
		});

		test("a descriptor held open across the archive and its verification keeps the root: the archive is dropped, the root renamed back, and a write through it after the close lands in the kept root", () => {
			const { ledger, wl, home, root, leftovers } = setUp();
			// Opened before the close, as a lane's still-running child would have it: the rename aside does not reach it.
			const fd = openSync(join(root, "REPORT.md"), "r+");
			let said: string;
			try {
				said = closeScratchRoot(ledger, { HOME: home }, wl, { now });
				writeSync(fd, "bbbb", 0);
			} finally {
				closeSync(fd);
			}
			expect(said).toContain(`Scratch root ${root} kept: not archived: `);
			expect(said).toContain(`is not proven quiet: a process still has files open in it (pid ${process.pid} has `);
			expect(said).toContain("/REPORT.md open), so it could still be written; the archive ");
			expect(said).toContain("was dropped");
			expect(readFileSync(join(root, "REPORT.md"), "utf8")).toBe("bbbb");
			expect(leftovers()).toEqual([]);
			ledger.close();
		});

		test("when lsof cannot say whether anything is open (missing, failing, timed out), the root is kept with every mode it had", () => {
			const { ledger, wl, home, root, leftovers } = setUp();
			const modes = (): number[] => [root, join(root, "REPORT.md"), join(root, "newer.txt")].map((p) => lstatSync(p).mode & 0o7777);
			const had = modes();
			const said = closeScratchRoot(ledger, { HOME: home }, wl, { now, seams: { openFiles: () => ({ kind: "unknown", reason: "lsof could not be run (ENOENT)" }) } });
			expect(said).toContain(`Scratch root ${root} kept: not archived: `);
			expect(said).toContain("is not proven quiet: no writer could be ruled out: lsof could not be run (ENOENT); the archive ");
			expect(readFileSync(join(root, "REPORT.md"), "utf8")).toBe("aaaa");
			expect(modes()).toEqual(had);
			expect(leftovers()).toEqual([]);
			ledger.close();
		});

		test("after the freeze a writer can neither rewrite a file by the detached path nor add one: both opens are refused, and the root goes with exactly what was archived", () => {
			const { ledger, wl, home, root } = setUp();
			const refused: string[] = [];
			const attempt = (f: () => void): void => {
				try {
					f();
					refused.push("written");
				} catch (e) {
					refused.push((e as NodeJS.ErrnoException).code ?? String(e));
				}
			};
			const said = closeScratchRoot(ledger, { HOME: home }, wl, {
				now,
				seams: {
					afterFreeze: (dir) => {
						attempt(() => writeFileSync(join(dir, "REPORT.md"), "bbbb"));
						attempt(() => writeFileSync(join(dir, "late.md"), "late"));
					},
				},
			});
			expect(refused).toEqual(["EACCES", "EACCES"]);
			expect(said).toContain(") and removed (");
			expect(existsSync(root)).toBe(false);
			const archive = archivePathFor(home, wl, now);
			expect(Bun.spawnSync(["tar", "-xzOf", archive, "./REPORT.md"], { stdout: "pipe" }).stdout.toString()).toBe("aaaa");
			ledger.close();
		});

		test("a writable file with a hard link outside the root refuses the freeze (a write by that path cannot be excluded): the root is kept with its modes", () => {
			const { ledger, wl, home, root, leftovers } = setUp();
			linkSync(join(root, "REPORT.md"), join(home, "alias.md"));
			const had = [root, join(root, "REPORT.md")].map((p) => lstatSync(p).mode & 0o7777);
			const said = closeScratchRoot(ledger, { HOME: home }, wl, { now });
			expect(said).toContain(`Scratch root ${root} kept: not archived: `);
			expect(said).toContain("could not be frozen: ./REPORT.md has 2 hard links and is writable, so a write by its other path cannot be excluded; the archive ");
			expect([root, join(root, "REPORT.md")].map((p) => lstatSync(p).mode & 0o7777)).toEqual(had);
			expect(leftovers()).toEqual([]);
			ledger.close();
		});

		test("a read-only file with a hard link outside the root (a git object) is archived and removed; its other link keeps its bytes and mode", () => {
			const { ledger, wl, home, root } = setUp();
			writeFileSync(join(root, "obj"), "object", { mode: 0o444 });
			linkSync(join(root, "obj"), join(home, "obj-alias"));
			const said = closeScratchRoot(ledger, { HOME: home }, wl, { now });
			expect(said).toContain(") and removed (");
			expect(existsSync(root)).toBe(false);
			expect(readFileSync(join(home, "obj-alias"), "utf8")).toBe("object");
			expect(lstatSync(join(home, "obj-alias")).mode & 0o7777).toBe(0o444);
			ledger.close();
		});

		test("a same-size write in the freeze's own stat-to-chmod step that keeps the mtime is caught by the frozen files' hashes: the archive is dropped and the root kept with the new contents and its modes", () => {
			const { ledger, wl, home, root, leftovers } = setUp();
			const report = join(root, "REPORT.md");
			const fixed = new Date("2026-10-28T04:00:00.000Z");
			utimesSync(report, fixed, fixed);
			const had = [root, report].map((p) => lstatSync(p).mode & 0o7777);
			const said = closeScratchRoot(ledger, { HOME: home }, wl, {
				now,
				seams: {
					beforeChmod: (path) => {
						if (!path.endsWith("/REPORT.md")) return;
						writeFileSync(path, "bbbb");
						utimesSync(path, fixed, fixed);
					},
				},
			});
			expect(said).toContain(`Scratch root ${root} kept: not archived: `);
			expect(said).toContain("changed while it was archived: ./REPORT.md has other contents than the archive");
			expect(readFileSync(report, "utf8")).toBe("bbbb");
			expect([root, report].map((p) => lstatSync(p).mode & 0o7777)).toEqual(had);
			expect(leftovers()).toEqual([]);
			ledger.close();
		});

		test("a file replaced during the purge (unlinked and written again by its path) is never removed: the purge stops, puts it back, gives every mode back and renames the root back", () => {
			const { ledger, wl, home, root, leftovers } = setUp();
			const rootMode = lstatSync(root).mode & 0o7777;
			const said = closeScratchRoot(ledger, { HOME: home }, wl, {
				now,
				seams: {
					beforeStage: (path) => {
						if (!path.endsWith("/REPORT.md")) return;
						unlinkSync(path);
						writeFileSync(path, "bbbb");
					},
				},
			});
			expect(said).toContain(" but not removed: ");
			expect(said).toContain("./REPORT.md was replaced (another inode); kept, put back; nothing more was removed; every archived entry left has its mode back; renamed back to ");
			expect(said).toContain(`what is left is at ${realpathSync(root)}`);
			expect(readFileSync(join(root, "REPORT.md"), "utf8")).toBe("bbbb");
			expect(readdirSync(root).filter((n) => n.startsWith(".as2-purge-"))).toEqual([]);
			expect(lstatSync(root).mode & 0o7777).toBe(rootMode);
			expect(Bun.spawnSync(["tar", "-xzOf", archivePathFor(home, wl, now), "./REPORT.md"], { stdout: "pipe" }).stdout.toString()).toBe("aaaa");
			expect(leftovers()).toEqual([`${wl}.tar.gz`]);
			ledger.close();
		});

		test("a purge that fails part way (an error, not a writer) gives every archived entry left its mode back and renames the root back", () => {
			const { ledger, wl, home, root, leftovers } = setUp();
			const had = [root, join(root, "REPORT.md")].map((p) => lstatSync(p).mode & 0o7777);
			const said = closeScratchRoot(ledger, { HOME: home }, wl, {
				now,
				seams: {
					beforeStage: (path) => {
						if (path.endsWith("/REPORT.md")) throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
					},
				},
			});
			expect(said).toContain(" but not removed: ");
			expect(said).toContain("EIO: i/o error, rename; every archived entry left has its mode back; renamed back to ");
			expect(readFileSync(join(root, "REPORT.md"), "utf8")).toBe("aaaa");
			expect([root, join(root, "REPORT.md")].map((p) => lstatSync(p).mode & 0o7777)).toEqual(had);
			expect(leftovers()).toEqual([`${wl}.tar.gz`]);
			ledger.close();
		});

		test("purgeArchived never removes an entry the archive does not hold: one made after the freeze (by a writer that gave the directory its write bit back) stops the purge and is kept", () => {
			const dir = join(tmp("purge"), ".removing-wl-x-0123456789abcdef");
			mkdirSync(join(dir, "sub"), { recursive: true, mode: 0o700 });
			writeFileSync(join(dir, "REPORT.md"), "aaaa");
			writeFileSync(join(dir, "sub", "f"), "f");
			const a = archiveDetached(dir, join(tmp("purge-archive"), "wl-x.tar.gz"), { openFiles: () => ({ kind: "none" }) });
			expect(a.kind).toBe("archived");
			if (a.kind !== "archived") return;
			chmodSync(join(dir, "sub"), 0o700);
			writeFileSync(join(dir, "sub", "late.md"), "late");
			const r = purgeArchived({ kind: "detached", path: dir, doomed: dir }, a);
			expect(r.kind).toBe("failed");
			expect(r.kind === "failed" && r.error).toBe(`removing ${dir}: ./sub/late.md is not in the archive; nothing more was removed; every archived entry left has its mode back`);
			expect(readFileSync(join(dir, "sub", "late.md"), "utf8")).toBe("late");
			expect(lstatSync(join(dir, "sub")).mode & 0o7777).toBe(0o700);
			expect(readdirSync(dir).filter((n) => n.startsWith(".as2-purge-"))).toEqual([]);
		});
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

	test("a base reached through a symlink still archives and removes exactly <realpath(base)>/<id>, and the archive lands beside the HOME-form base; a missing root is a no-op with no entry", async () => {
		const a = closing();
		const real = tmp("scratch-real-base");
		mkdirSync(join(a.home, "agent-scratch", "agent-system-2.0"), { recursive: true });
		symlinkSync(real, join(a.home, "agent-scratch", "agent-system-2.0", "scratch"));
		mkdirSync(join(real, a.wl));
		writeFileSync(join(real, a.wl, "f.txt"), "x");
		const sibling = join(real, "wl-other");
		mkdirSync(sibling);
		const said = await a.close();
		expect(said).toContain(`Scratch root ${scratchRootFor(a.home, a.wl)} archived to ${scratchArchiveBase(a.home)}/`);
		expect(said).toContain(") and removed (entries ");
		expect(members(onlyArchive(a.home)!)).toEqual(["", "f.txt"]);
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
