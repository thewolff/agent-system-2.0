// The eight self-heal detectors (PLAN wl-mvbcjageg7o2yo § 2.3, R3–R10) on fixtures cut from the
// recorded failures (fixtures/selfheal/README.md says where each was cut from). Every case goes
// through the real readers: a temp ledger seeded with the cut rows (reopened read-only), a temp
// home holding the orchestrator sessions and the profile's OMP logs, a temp lanes dir holding the
// lane sessions, and a temp Jetsam directory; then `runDetectors` over a window.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { handLab, JETSAM_UNREADABLE, MCP_LOAD_UNREADABLE, runDetectors } from "../src/selfheal/detectors";
import { readDetectorInputs } from "../src/selfheal/read";
import type { DetectorId, Finding, Window } from "../src/selfheal/types";
import { clock, tempLedger, tmp } from "./helpers";

const FIXTURES = join(import.meta.dir, "fixtures", "selfheal");
const PROFILE = "agent-system-2";

interface Row {
	t: "entry" | "routing" | "question";
	id: string;
	workloadId: string;
	sliceId: string | null;
	at: string;
	by?: string;
	kind?: string;
	body?: string;
	spawnKey?: string;
	sessionRoot?: string;
	agentId?: string;
	outcome?: string;
	models?: string[];
	ranModels?: string[];
	options?: string[];
}

const cleanup: string[] = [];
afterAll(() => {
	for (const d of cleanup) {
		try {
			chmodSync(d, 0o755);
		} catch {
			// already gone
		}
		rmSync(d, { recursive: true, force: true });
	}
});

/** A world: a ledger seeded with `ledgerFixtures`' rows, sessions copied under a temp home and lanes dir, a Jetsam dir. */
function world(o: { ledgerFixtures?: string[]; orchestrator?: string[]; lanes?: { fixture: string; path: string }[]; jetsam?: string[]; ompLogs?: Record<string, string[]> } = {}) {
	const c = clock("2026-10-01T00:00:00.000Z");
	const { ledger, path } = tempLedger(c.now);
	cleanup.push(dirname(path));
	const rows = (o.ledgerFixtures ?? [])
		.flatMap((f) => (JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as { rows: Row[] }).rows)
		.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	const workloads = new Set<string>();
	const slices = new Set<string>();
	for (const r of rows) {
		if (!workloads.has(r.workloadId)) {
			ledger.openWorkload({ by: "lane-a", id: r.workloadId, brief: "<brief>", stakes: "normal", mode: "autonomous" });
			workloads.add(r.workloadId);
		}
		if (r.sliceId !== null && !slices.has(r.sliceId)) {
			ledger.addSlice({ by: "lane-a", id: r.sliceId, workloadId: r.workloadId, task: "<task>", doneCondition: "<done>", inputs: "<inputs>" });
			slices.add(r.sliceId);
		}
	}
	for (const r of rows) {
		c.at(r.at);
		if (r.t === "entry") {
			ledger.recordEntry({ by: r.by!, workloadId: r.workloadId, sliceId: r.sliceId, kind: r.kind as "assumption", body: r.body! });
		} else if (r.t === "question") {
			ledger.raiseQuestion({ by: r.by!, id: r.id, workloadId: r.workloadId, sliceId: r.sliceId!, body: r.body!, options: r.options! });
		} else {
			ledger.recordRouting({
				by: "lane-a", workloadId: r.workloadId, sliceId: r.sliceId!, spawnKey: r.spawnKey!, sessionRoot: r.sessionRoot!, agentId: r.agentId!,
				kind: r.kind as "change-large", confidence: 0.9, probabilities: { [r.kind!]: 0.9 }, classifiedTier: "strong", tier: "strong",
				models: r.models!, judgeModel: "typesafe/jev-1.13.0", outcome: r.outcome as "ran", ranModels: r.ranModels!,
			});
		}
	}
	ledger.close();
	const root = tmp("selfheal");
	cleanup.push(root);
	const home = join(root, "home");
	const lanesDir = join(home, ".agent-system-2", "lanes");
	const sessions = join(home, ".omp", "profiles", PROFILE, "agent", "sessions", "-code-agent-system-2.0");
	mkdirSync(lanesDir, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	for (const f of o.orchestrator ?? []) copyFileSync(join(FIXTURES, f), join(sessions, f));
	for (const l of o.lanes ?? []) {
		const dest = join(lanesDir, l.path);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(join(FIXTURES, l.fixture), dest);
	}
	const jetsamDir = join(root, "DiagnosticReports");
	mkdirSync(jetsamDir);
	for (const f of o.jetsam ?? []) copyFileSync(join(FIXTURES, "jetsam", f), join(jetsamDir, f));
	const logsDir = join(home, ".omp", "profiles", PROFILE, "logs");
	for (const [name, lines] of Object.entries(o.ompLogs ?? {})) {
		mkdirSync(logsDir, { recursive: true });
		writeFileSync(join(logsDir, name), `${lines.join("\n")}\n`);
	}
	return {
		root, home, lanesDir, sessions, jetsamDir,
		async run(window: Window, over: { jetsamDir?: string } = {}): Promise<Finding[]> {
			const ro = Ledger.open(path, { readonly: true });
			try {
				const inputs = await readDetectorInputs({ ledger: ro, home, profile: PROFILE, window, jetsamDir: over.jetsamDir ?? jetsamDir, lanesDir });
				return runDetectors(inputs, window);
			} finally {
				ro.close();
			}
		},
	};
}

const w = (from: string, to: string): Window => ({ from, to });
const of = (fs: Finding[], d: DetectorId): Finding[] => fs.filter((f) => f.detector === d);
/** The Jetsam dir is empty in every world that is not about Jetsam, so only the detector under test can speak. */
const others = (fs: Finding[], d: DetectorId): Finding[] => fs.filter((f) => f.detector !== d);

// ---- R3 compaction-loop --------------------------------------------------------------------------

describe("compaction-loop (R3)", () => {
	const LOOP = "wl-mv457r7iqmq29s/sessions/2026-10-12T00-00-26-467Z_01a12d69-1f63-7000-9273-bcafc8e39649.jsonl";
	const JP = "wl-mv8r90k9nci4qo/sessions/2026-10-14T23-42-45-344Z_01a13ccc-0260-7000-8051-ba7b5162fdd4/sl-jp-build.jsonl";
	const CLEAN = "wl-mv0n5r9cbafe9s/sessions/2026-10-12T03-29-19-429Z_01a12e28-5c45-7000-a0fe-bb08a05c4e6d.jsonl";

	test("fires once on the recorded 589-compaction loop, at the 20th compaction of the first span", async () => {
		const x = world({ lanes: [{ fixture: "compaction-loop.jsonl", path: LOOP }] });
		const fs = await x.run(w("2026-10-12T00:00:00.000Z", "2026-10-12T06:00:00.000Z"));
		expect(others(fs, "compaction-loop")).toEqual([]);
		const [f, ...rest] = of(fs, "compaction-loop");
		expect(rest).toEqual([]);
		expect(f!.workloadId).toBe("wl-mv457r7iqmq29s");
		expect(f!.at).toBe("2026-10-12T00:07:54.157Z");
		expect(f!.summary).toStartWith("compaction loop: 589 compactions in the window");
		expect(f!.summary).not.toContain("continuing");
	});

	test("fires on the wl-mv8r90k9nci4qo sl-jp-build burst, a hand session nested under its lane session", async () => {
		const x = world({ lanes: [{ fixture: "compaction-loop-jp-build.jsonl", path: JP }] });
		const fs = of(await x.run(w("2026-10-14T23:00:00.000Z", "2026-10-15T01:00:00.000Z")), "compaction-loop");
		expect(fs.map((f) => [f.workloadId, f.at])).toEqual([["wl-mv8r90k9nci4qo", "2026-10-15T00:02:47.088Z"]]);
		expect(fs[0]!.summary).toStartWith("compaction loop: 39 compactions in the window");
	});

	test("a window opening mid-burst reports it once, marked continuing, counting only its own compactions", async () => {
		const x = world({ lanes: [{ fixture: "compaction-loop.jsonl", path: LOOP }] });
		const fs = of(await x.run(w("2026-10-12T02:00:00.000Z", "2026-10-12T03:00:00.000Z")), "compaction-loop");
		expect(fs).toHaveLength(1);
		expect(fs[0]!.summary).toContain("(continuing)");
		expect(Date.parse(fs[0]!.at)).toBeGreaterThanOrEqual(Date.parse("2026-10-12T02:00:00.000Z"));
	});

	test("quiet on a clean session with eleven compactions over three days", async () => {
		const x = world({ lanes: [{ fixture: "compaction-loop-clean.jsonl", path: CLEAN }] });
		expect(await x.run(w("2026-10-09T00:00:00.000Z", "2026-10-13T00:00:00.000Z"))).toEqual([]);
	});

	test("quiet when the window lies after the loop, though its last compactions fall in the hour of feed before it", async () => {
		const x = world({ lanes: [{ fixture: "compaction-loop.jsonl", path: LOOP }] });
		expect(await x.run(w("2026-10-12T06:00:00.000Z", "2026-10-12T07:00:00.000Z"))).toEqual([]);
	});

	test("a session file last changed before the feed start is not opened", async () => {
		const x = world({ lanes: [{ fixture: "compaction-loop.jsonl", path: LOOP }] });
		const old = new Date("2026-10-11T22:00:00.000Z");
		utimesSync(join(x.lanesDir, LOOP), old, old);
		expect(await x.run(w("2026-10-12T00:00:00.000Z", "2026-10-12T06:00:00.000Z"))).toEqual([]);
	});
});

// ---- R4 hand-lab ---------------------------------------------------------------------------------

describe("hand-lab (R4)", () => {
	test("fires on the four openai lanes that ran Anthropic build hands, timed at each routing row", async () => {
		const x = world({ ledgerFixtures: ["hand-lab.json"] });
		const fs = await x.run(w("2026-10-14T00:00:00.000Z", "2026-10-15T00:00:00.000Z"));
		expect(others(fs, "hand-lab")).toEqual([]);
		expect(of(fs, "hand-lab").map((f) => [f.laneId, f.at])).toEqual([
			["lane-mv66q5b148uznk-3", "2026-10-14T01:59:44.579Z"],
			["lane-mv65nllu5g181s-5", "2026-10-14T02:03:50.805Z"],
			["lane-mv6uqrx6d1tjb4-4", "2026-10-14T02:17:51.229Z"],
			["lane-mv66ylg1op3wg0-3", "2026-10-14T02:50:25.103Z"],
		]);
		expect(fs[0]!.summary).toContain("anthropic/claude-opus-5-5, off the lane's builder-lab openai");
	});

	test("quiet on the sl-pd-* hands: builders on the lane's lab, and an openai review hand on an anthropic lane", async () => {
		const x = world({ ledgerFixtures: ["hand-lab-clean.json"] });
		expect(await x.run(w("2026-10-14T00:00:00.000Z", "2026-10-15T00:00:00.000Z"))).toEqual([]);
	});

	test("quiet when the window ends before the routing rows, though the spawns fall inside it", async () => {
		const x = world({ ledgerFixtures: ["hand-lab.json"] });
		expect(await x.run(w("2026-10-14T01:50:00.000Z", "2026-10-14T01:59:00.000Z"))).toEqual([]);
	});

	test("compares a hand with its own lane's builder-lab, never a newer one written by another lane on the workload", () => {
		const spawn = (laneId: string, key: string) => ({ entryId: `en-${key}`, workloadId: "wl-x", laneId, at: "2026-10-14T01:10:00.000Z", sessionRoot: "root", spawnKey: key, review: false });
		const route = (key: string, model: string) => ({ id: `rt-${key}`, workloadId: "wl-x", sessionRoot: "root", spawnKey: key, ranModels: [model], at: "2026-10-14T01:20:00.000Z" });
		const labs = [
			{ entryId: "en-lab-a", workloadId: "wl-x", laneId: "lane-x-1", at: "2026-10-14T01:00:00.000Z", lab: "openai" },
			{ entryId: "en-lab-b", workloadId: "wl-x", laneId: "lane-x-2", at: "2026-10-14T01:05:00.000Z", lab: "anthropic" },
		];
		const same = handLab([spawn("lane-x-1", "sl-same")], labs, [route("sl-same", "openai-codex/gpt-6.1-sol")]);
		expect(same).toEqual([]);
		const off = handLab([spawn("lane-x-1", "sl-off")], labs, [route("sl-off", "anthropic/claude-opus-5-5")]);
		expect(off.map((f) => [f.laneId, f.evidence])).toEqual([["lane-x-1", "routing rt-sl-off, hand-spawn en-sl-off, builder-lab en-lab-a"]]);
	});
});

// ---- R5 paste-drop -------------------------------------------------------------------------------

describe("paste-drop (R5)", () => {
	/** The six unechoed user messages, by their id in the source session (source lines 795, 801, 863, 913, 3549, 3557). */
	const DROPPED = ["c803b7f7", "2de87fdc", "9fca9e5c", "20eabc0a", "64cb9012", "4484f0c6"];

	test("fires on each of the six user messages with no surface input before them", async () => {
		const x = world({ orchestrator: ["paste-drop.jsonl"] });
		const fs = await x.run(w("2026-10-12T00:00:00.000Z", "2026-10-15T00:00:00.000Z"));
		expect(others(fs, "paste-drop")).toEqual([]);
		expect(fs.map((f) => /\(id (\w+)\)$/.exec(f.evidence)?.[1])).toEqual(DROPPED);
	});

	test("quiet on the fully echoed 2026-10-12T05-22 session and the 2026-10-15 smoke session with no input entries", async () => {
		const x = world({ orchestrator: ["paste-drop-clean.jsonl", "paste-drop-smoke.jsonl"] });
		expect(await x.run(w("2026-10-12T00:00:00.000Z", "2026-10-16T00:00:00.000Z"))).toEqual([]);
	});

	test("quiet when the window holds only the echoed messages after the last drop", async () => {
		const x = world({ orchestrator: ["paste-drop.jsonl"] });
		expect(await x.run(w("2026-10-14T03:00:00.000Z", "2026-10-20T00:00:00.000Z"))).toEqual([]);
	});
});

// ---- R6 ceiling-wall -----------------------------------------------------------------------------

describe("ceiling-wall (R6)", () => {
	test("fires on the wall-led ceiling questions of 2026-10-13 16:30Z", async () => {
		const x = world({ ledgerFixtures: ["ceiling-wall.json"] });
		const fs = await x.run(w("2026-10-13T16:00:00.000Z", "2026-10-13T17:00:00.000Z"));
		expect(others(fs, "ceiling-wall")).toEqual([]);
		expect(fs.map((f) => f.workloadId)).toEqual(["wl-mv60mkkt1ohg5c", "wl-mv65nllu5g181s", "wl-mv66q5b148uznk"]);
		expect(fs[2]!.summary).toStartWith("ceiling-wall: 718 of 60 minutes (1197 %) against $24.38 of $150 (16 %)");
	});

	test("quiet on wl-mv8fb0xnlc0b28, past both its dollars (253 %) and its minutes (441 %)", async () => {
		const x = world({ ledgerFixtures: ["ceiling-wall-clean.json"] });
		expect(await x.run(w("2026-10-14T00:00:00.000Z", "2026-10-15T00:00:00.000Z"))).toEqual([]);
	});

	test("quiet when the window excludes the questions", async () => {
		const x = world({ ledgerFixtures: ["ceiling-wall.json"] });
		expect(await x.run(w("2026-10-13T17:00:00.000Z", "2026-10-13T18:00:00.000Z"))).toEqual([]);
	});
});

// ---- R7 flaky-test -------------------------------------------------------------------------------

describe("flaky-test (R7)", () => {
	test("fires once per sha on e27bbc0 (PR #136), db80ef2 and 49443be (PR #101), at the run completing the pair", async () => {
		const x = world({ ledgerFixtures: ["flaky-test.json"] });
		const fs = await x.run(w("2026-10-14T00:00:00.000Z", "2026-10-15T00:00:00.000Z"));
		expect(others(fs, "flaky-test")).toEqual([]);
		expect(fs.map((f) => [f.summary.split(" ")[2], f.at])).toEqual([
			["e27bbc0", "2026-10-14T02:51:08.744Z"],
			["db80ef2", "2026-10-14T04:54:08.940Z"],
			["49443be", "2026-10-14T17:44:11.887Z"],
		]);
		expect(fs[0]!.summary).toBe("flaky-test: sha e27bbc0 (PR #136) ran red then green");
	});

	test("quiet on a sha that ran error then green, never red", async () => {
		const x = world({ ledgerFixtures: ["flaky-test-clean.json"] });
		expect(await x.run(w("2026-10-15T00:00:00.000Z", "2026-10-16T00:00:00.000Z"))).toEqual([]);
	});

	test("quiet when the window ends before any pair completes", async () => {
		const x = world({ ledgerFixtures: ["flaky-test.json"] });
		expect(await x.run(w("2026-10-14T00:00:00.000Z", "2026-10-14T02:40:00.000Z"))).toEqual([]);
	});
});

// ---- R8 jetsam -----------------------------------------------------------------------------------

describe("jetsam (R8)", () => {
	const REPORTS = ["JetsamEvent-2026-10-13-124141.ips", "JetsamEvent-2026-10-14-053054.ips", "JetsamEvent-2026-10-16-053539.ips"];

	test("fires on the 2026-10-14 05:30:54 -0700 report with its largest process in MB", async () => {
		const x = world({ jetsam: REPORTS });
		const fs = await x.run(w("2026-10-14T12:00:00.000Z", "2026-10-14T13:00:00.000Z"));
		expect(fs.map((f) => [f.detector, f.at, f.summary])).toEqual([
			["jetsam", "2026-10-14T12:30:54.000Z", "jetsam: largest process bun 13299 MB (851139 pages × 16384 B)"],
		]);
	});

	test("one finding per report across its siblings", async () => {
		const x = world({ jetsam: REPORTS });
		const fs = await x.run(w("2026-10-11T00:00:00.000Z", "2026-10-17T00:00:00.000Z"));
		expect(fs.map((f) => f.evidence.split("/").pop())).toEqual(REPORTS);
	});

	test("quiet on a directory with no Jetsam report", async () => {
		const x = world();
		expect(await x.run(w("2026-10-14T00:00:00.000Z", "2026-10-15T00:00:00.000Z"))).toEqual([]);
	});

	test("quiet when the window excludes the report", async () => {
		const x = world({ jetsam: REPORTS });
		expect(await x.run(w("2026-10-14T13:00:00.000Z", "2026-10-15T00:00:00.000Z"))).toEqual([]);
	});

	test("an unreadable directory gives one `jetsam: unreadable`, never zero events", async () => {
		const x = world();
		const fs = await x.run(w("2026-10-14T00:00:00.000Z", "2026-10-15T00:00:00.000Z"), { jetsamDir: join(x.root, "missing") });
		expect(fs.map((f) => [f.detector, f.summary])).toEqual([["jetsam", JETSAM_UNREADABLE]]);
	});

	test("an unreadable report gives one `jetsam: unreadable` beside the readable ones", async () => {
		const x = world({ jetsam: REPORTS });
		chmodSync(join(x.jetsamDir, REPORTS[0]!), 0o000);
		const fs = await x.run(w("2026-10-11T00:00:00.000Z", "2026-10-17T00:00:00.000Z"));
		expect(fs.map((f) => f.summary.split(" ").slice(0, 2).join(" ")).sort()).toEqual(["jetsam: largest", "jetsam: largest", JETSAM_UNREADABLE]);
		expect(fs.find((f) => f.summary === JETSAM_UNREADABLE)!.evidence).toEndWith(REPORTS[0]!);
	});
});

// ---- R9 model-start ------------------------------------------------------------------------------

describe("model-start (R9)", () => {
	test("fires on wl-mv8cvw0lq3rlds lane-1: started on claude-opus-5-5, lane-model gpt-6.1-sol 3 min later", async () => {
		const x = world({ ledgerFixtures: ["model-start.json"] });
		const fs = await x.run(w("2026-10-14T17:00:00.000Z", "2026-10-14T18:00:00.000Z"));
		expect(fs.map((f) => [f.detector, f.workloadId, f.laneId, f.at])).toEqual([
			["model-start", "wl-mv8cvw0lq3rlds", "lane-mv8cvw0lq3rlds-1", "2026-10-14T17:04:48.166Z"],
		]);
		expect(fs[0]!.summary).toBe("model-start: lane-mv8cvw0lq3rlds-1 started on anthropic/claude-opus-5-5, then lane-model openai-codex/gpt-6.1-sol 190 s later (≤ 10 min)");
	});

	test("quiet on lane-2, started on the recorded lane-model", async () => {
		const x = world({ ledgerFixtures: ["model-start-clean.json"] });
		expect(await x.run(w("2026-10-14T17:00:00.000Z", "2026-10-14T18:00:00.000Z"))).toEqual([]);
	});

	test("quiet when the window excludes the lane-model entry", async () => {
		const x = world({ ledgerFixtures: ["model-start.json"] });
		expect(await x.run(w("2026-10-14T17:05:00.000Z", "2026-10-14T18:00:00.000Z"))).toEqual([]);
	});
});

// ---- R10 window boundary -------------------------------------------------------------------------

describe("window boundary (R10)", () => {
	test("a pair straddling `from` is reported once, in the window holding its completing event", async () => {
		const x = world({ ledgerFixtures: ["flaky-test.json", "model-start.json"] });
		// e27bbc0: red 02:37:47, green 02:51:08; lane-1: started 17:01:37, lane-model 17:04:48.
		const cuts = ["2026-10-14T00:00:00.000Z", "2026-10-14T02:45:00.000Z", "2026-10-14T17:03:00.000Z", "2026-10-15T00:00:00.000Z"];
		const windows = await Promise.all(cuts.slice(0, -1).map((from, i) => x.run(w(from, cuts[i + 1]!))));
		expect(windows.map((fs) => fs.map((f) => f.detector))).toEqual([[], ["flaky-test", "flaky-test"], ["model-start", "flaky-test"]]);
		expect(windows[1]![0]!.summary).toContain("e27bbc0");
	});
});

// ---- mcp-load ------------------------------------------------------------------------------------

// Lines cut from ~/.omp/profiles/agent-system-2/logs on 2026-10-26 and 2026-10-28 (OMP redacts the bearer itself);
// the ctx line is from 2026-10-27. Timestamps carry the -07:00 offset OMP writes.
const LINEAR_401 = (ts: string, pid: number) =>
	JSON.stringify({ timestamp: ts, level: "error", pid, message: "MCP tool load failed", path: "mcp:linear", error: "HTTP 401:  [WWW-Authenticate: Bearer [redacted], resource_metadata=\"https://mcp.linear.app/.well-known/oauth-protected-resource/mcp\", scope=\"read write\"]" });
const POSTHOG_401 = JSON.stringify({ timestamp: "2026-10-28T16:39:20.297-07:00", level: "error", pid: 38384, message: "MCP tool load failed", path: "mcp:posthog", error: "HTTP 401: No token provided, please provide a valid API token." });
const CTX_MISSING = JSON.stringify({ timestamp: "2026-10-27T09:12:03.004-07:00", level: "error", pid: 63928, message: "MCP tool load failed", path: "mcp:ctx", error: "Executable not found in $PATH: \"ctx\"" });
const NOISE = JSON.stringify({ timestamp: "2026-10-26T12:36:01.000-07:00", level: "info", pid: 28363, message: "agent_end maintenance routing" });

describe("mcp-load", () => {
	// 38384's log is split the way OMP's size rotation splits it: the older half in `.log.1`.
	const logs = {
		"omp.2026-10-26.28363.log": [LINEAR_401("2026-10-26T12:36:00.611-07:00", 28363), NOISE],
		"omp.2026-10-26.70041.log": [LINEAR_401("2026-10-26T16:31:00.358-07:00", 70041)],
		"omp.2026-10-27.63928.log": [CTX_MISSING, "not json MCP tool load failed"],
		"omp.2026-10-28.38384.log.1": [LINEAR_401("2026-10-28T16:39:20.269-07:00", 38384)],
		"omp.2026-10-28.38384.log": [POSTHOG_401],
		"other.log": [LINEAR_401("2026-10-28T16:40:00.000-07:00", 1)], // not an OMP process log
	};
	const logsOf = (home: string, name: string) => join(home, ".omp", "profiles", PROFILE, "logs", name);
	const HEALTH = (server: string) => `HTTP 401; current login health unknown until a live load: start \`OMP_PROFILE=agent-system-2 omp\` and see whether ${server} loads`;
	const LINEAR = (n: number) => `mcp-load: linear failed to load ${n} time(s) in the window in profile agent-system-2: ${HEALTH("linear")}`;
	const ALL = w("2026-10-26T00:00:00.000Z", "2026-10-29T00:00:00.000Z");

	test("one finding per server and failure, at its last failure, counting the window's failures, rotated logs included; a 401 leaves the login's current health open", async () => {
		const x = world({ ompLogs: logs });
		const fs = of(await x.run(ALL), "mcp-load");
		expect(fs.map((f) => [f.at, f.summary])).toEqual([
			["2026-10-27T16:12:03.004Z", "mcp-load: ctx failed to load 1 time(s) in the window in profile agent-system-2: Executable not found in $PATH: \"ctx\""],
			["2026-10-28T23:39:20.269Z", LINEAR(3)],
			["2026-10-28T23:39:20.297Z", `mcp-load: posthog failed to load 1 time(s) in the window in profile agent-system-2: ${HEALTH("posthog")}`],
		]);
		expect(fs.find((f) => f.summary.includes("linear"))!.evidence).toBe(`${logsOf(x.home, "omp.2026-10-26.28363.log")}:1 .. ${logsOf(x.home, "omp.2026-10-28.38384.log.1")}:1`);
	});

	test("every rotation suffix is read", async () => {
		const x = world({ ompLogs: { "omp.2026-10-28.38384.log.4": [LINEAR_401("2026-10-28T16:39:20.269-07:00", 38384)], "omp.2026-10-28.38384.log.12": [POSTHOG_401] } });
		expect((await x.run(ALL)).map((f) => f.summary.split(" ")[1])).toEqual(["linear", "posthog"]);
	});

	test("only the window's failures count", async () => {
		const x = world({ ompLogs: logs });
		const fs = await x.run(w("2026-10-26T20:00:00.000Z", "2026-10-27T00:00:00.000Z"));
		expect(fs.map((f) => f.summary)).toEqual([LINEAR(1)]);
	});

	test("quiet when the profile has no logs directory, and when no line in the window failed", async () => {
		expect(await world().run(ALL)).toEqual([]);
		expect(await world({ ompLogs: { "omp.2026-10-26.28363.log": [NOISE] } }).run(ALL)).toEqual([]);
	});

	test("an unreadable log gives one `mcp-load: OMP logs unreadable` beside the readable logs' findings", async () => {
		const x = world({ ompLogs: logs });
		const bad = logsOf(x.home, "omp.2026-10-28.38384.log.1");
		chmodSync(bad, 0o000);
		const fs = await x.run(ALL);
		chmodSync(bad, 0o644);
		expect(fs.map((f) => [f.at, f.summary])).toEqual([
			["2026-10-26T00:00:00.000Z", MCP_LOAD_UNREADABLE],
			["2026-10-26T23:31:00.358Z", LINEAR(2)],
			["2026-10-27T16:12:03.004Z", "mcp-load: ctx failed to load 1 time(s) in the window in profile agent-system-2: Executable not found in $PATH: \"ctx\""],
			["2026-10-28T23:39:20.297Z", `mcp-load: posthog failed to load 1 time(s) in the window in profile agent-system-2: ${HEALTH("posthog")}`],
		]);
		expect(fs[0]!.evidence).toBe(bad);
	});

	test("an unreadable logs directory gives one `mcp-load: OMP logs unreadable`, never zero failures", async () => {
		const x = world({ ompLogs: logs });
		const dir = join(x.home, ".omp", "profiles", PROFILE, "logs");
		chmodSync(dir, 0o000);
		const fs = await x.run(ALL);
		chmodSync(dir, 0o755);
		expect(fs.map((f) => [f.detector, f.summary, f.evidence])).toEqual([["mcp-load", MCP_LOAD_UNREADABLE, dir]]);
	});
});
