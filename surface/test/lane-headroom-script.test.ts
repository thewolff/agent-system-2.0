// The quota guard at the real RPC runner spawn: named and unnamed sources may retain a mature week-only
// overrun against the installed strong row's faster-burning counterfactual budget, without changing the model.
// Otherwise named models refuse before omp; unnamed models move only to base-in-quota strong-row entries,
// confirmed by get_state before the first prompt. These process tests run outside the fence.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTierTable } from "../../classifier/src/tier-table";
import { LANE_RUNNER_BY, Ledger } from "../../ledger/src/index";
import { recordRepo } from "../src/decision-log";
import { doneBody, laneDir, laneExit, laneModelBody, laneModelPreferenceBody, laneStarted } from "../src/launch";
import { TRAIN_FIX_MODEL_SOURCE } from "../src/merge-train";
import { MERGE_TRAIN_BY, SURFACE_BY } from "../src/types";
import type { FakeScript, FakeStep, LaneRoot } from "./helpers";
import { fakeRecords, LANE_SCRIPT, laneIdOf, laneRoot, laneSnapshot, setScript, settleDrains, sh, until } from "./helpers";

const A = "anthropic/claude-opus-5-5";
const SOL = "openai-codex/gpt-6.1-sol";
const K = "moonshot/kimi-k2.7-code";
const REASON = "anthropic 5h 0.85 used > 0.80";
const DONE: FakeStep[] = [{ tool: "lane_record_entry", args: { body: "done-because: the probe is done" } }];
const PROFILE_CONFIG = join(import.meta.dir, "..", "..", "profile", "config.yml");

const roots: LaneRoot[] = [];
afterAll(async () => {
	const settled = await Promise.allSettled(roots.map((r) => settleDrains(r)));
	for (const r of roots) rmSync(r.root, { recursive: true, force: true });
	for (const s of settled) if (s.status === "rejected") throw s.reason;
}, 120_000);

/** One fresh poll line in watch.py's shape (`t` epoch seconds, `resetsAt` epoch ms): each provider's 5h use as given,
 * 6 min into the window (under the projection warm-up), so only the 80 % rule speaks. */
function writePolls(r: LaneRoot, used: Record<string, number>): void {
	const now = Date.now();
	const limits = Object.entries(used).map(([provider, usedFraction]) => ({ provider, windowId: "5h", tier: null, resetsAt: now + 4.9 * 3_600_000, usedFraction }));
	const rows = Object.fromEntries(Object.entries(used).map(([provider, u]) => [`${provider}/5h`, u]));
	const path = join(r.root, "polls.jsonl");
	writeFileSync(path, `${JSON.stringify({ t: Math.floor(now / 1000), rows, limits })}\n`);
	r.env.AS2_HEADROOM_POLLS = path;
}

/** The root's installed profile carries the repo profile's tier table (the runner reads the strong row from there). */
function installTierTable(r: LaneRoot, strong?: readonly string[]): void {
	const config = Bun.YAML.parse(readFileSync(PROFILE_CONFIG, "utf8")) as { task?: { agentModelOverrides?: Record<string, unknown> } };
	const overrides = config.task?.agentModelOverrides;
	writeFileSync(join(r.home, ".omp", "profiles", "agent-system-2", "agent", "config.yml"), JSON.stringify({
		setupVersion: 2, task: { agentModelOverrides: strong === undefined ? overrides : { ...overrides, strong } },
	}));
}

const makeRoot = (used: Record<string, number>): LaneRoot => {
	const r = laneRoot();
	roots.push(r);
	writePolls(r, used);
	installTierTable(r);
	return r;
};

/** Mature OpenAI week overrun (projected 1.05), with one common 26-minute sample for both budgets.
 * Claude's 5h meter is 90 minutes old: .18 is base-in, .34 pace-out, .87 hard-out. */
function writeComparisonPolls(r: LaneRoot, claudeUsed: number, options: { claudeBefore?: number; sourceHard?: boolean; moonshotUsed?: number } = {}): void {
	const now = Math.floor(Date.now() / 1000) * 1000;
	const weekReset = now + (10080 - 2016) * 60_000;
	const shortReset = now + (300 - 90) * 60_000;
	const poll = (t: number, sourceUsed: number, claude: number, moonshot: number) => {
		const limits = [
			{ provider: "openai-codex", windowId: "7d", tier: null, resetsAt: weekReset, usedFraction: sourceUsed },
			{ provider: "anthropic", windowId: "5h", tier: null, resetsAt: shortReset, usedFraction: claude },
		];
		if (options.sourceHard) limits.push({ provider: "openai-codex", windowId: "5h", tier: null, resetsAt: shortReset, usedFraction: 0.87 });
		if (options.moonshotUsed !== undefined) limits.push({ provider: "moonshot", windowId: "5h", tier: null, resetsAt: shortReset, usedFraction: moonshot });
		return { t: t / 1000, rows: Object.fromEntries(limits.map((l) => [`${l.provider}/${l.windowId}`, l.usedFraction])), limits };
	};
	const path = join(r.root, "polls.jsonl");
	writeFileSync(path, [
		poll(now - 26 * 60_000, 0.20, options.claudeBefore ?? 0.04, 0.04),
		poll(now, 0.21, claudeUsed, options.moonshotUsed ?? 0),
	].map((p) => JSON.stringify(p)).join("\n") + "\n");
	r.env.AS2_HEADROOM_POLLS = path;
}

/** A syntactically valid installed profile with no readable tier table. */
function removeTierTable(r: LaneRoot): void {
	writeFileSync(join(r.home, ".omp", "profiles", "agent-system-2", "agent", "config.yml"), JSON.stringify({ setupVersion: 2 }));
}

const runnerLog = (r: LaneRoot, wl: string) => readFileSync(join(laneDir(wl, r.home), "runner.log"), "utf8");
const ledgerOf = (r: LaneRoot) => Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
/** An autonomous workload with its done: line and one open slice, Jo's `lane-model:` when `model` is given, and the train's
 * `lane-model-preference:` when `preferred` is. */
function openWorkload(r: LaneRoot, model: string | null, preferred: string | null = null): string {
	const l = ledgerOf(r);
	try {
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "headroom probe", stakes: "normal", mode: "autonomous" });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
		if (preferred !== null) l.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body: laneModelPreferenceBody(preferred, l.now(), TRAIN_FIX_MODEL_SOURCE) });
		if (model !== null) l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: laneModelBody(model, l.now()) });
		l.addSlice({ by: SURFACE_BY, workloadId: wl, task: "probe", doneCondition: "probed", inputs: "README.md" });
		return wl;
	} finally {
		l.close();
	}
}
const launch = (r: LaneRoot, wl: string, script: FakeScript) => {
	setScript(r, script);
	expect(sh(["bun", LANE_SCRIPT, "launch", wl, "--requested-by", "test"], r.repo, r.env).code).toBe(0);
};
/** The lane's end: its lane-exit:, or a launch-failed: (a runner refusal before any omp writes no lane-exit:). */
const endOf = (r: LaneRoot, wl: string, laneId: string) =>
	until(`the end of ${laneId}`, () => laneSnapshot(r, wl).control.find((c) => (c.prefix === "lane-exit" || c.prefix === "launch-failed") && c.laneId === laneId));
const spawns = (r: LaneRoot) => fakeRecords(r).filter((x) => x.argv !== undefined);
/** The rpc commands the n-th fake omp received, in order; `set_model` as `set_model <provider>/<modelId>`. */
const commandsOf = (r: LaneRoot, n: number) => {
	const pid = spawns(r)[n - 1]!.pid;
	return fakeRecords(r).filter((x) => x.pid === pid && x.command !== undefined).map((x) => (x.command === "set_model" ? `set_model ${x.provider}/${x.modelId}` : x.command!));
};
const deathSenders = (r: LaneRoot, wl: string) => {
	const l = ledgerOf(r);
	try {
		return l.db.query<{ sender: string }, [string]>("SELECT sender FROM messages WHERE workload_id = ? AND body LIKE 'lane-died:%' ORDER BY created_at, rowid").all(wl).map((m) => m.sender);
	} finally {
		l.close();
	}
};

describe("PLAN wl-mv71x5rwdu7eo0 § 4: the quota guard at the runner's spawn", () => {
	test("a named anthropic model with anthropic 5h at 0.85: no omp spawned; one launch-failed: at headroom and one lane-died:, both by lane-runner; released", async () => {
		const r = makeRoot({ anthropic: 0.85 });
		const wl = openWorkload(r, A);
		launch(r, wl, { steps: DONE });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		expect(spawns(r)).toEqual([]);
		const snap = laneSnapshot(r, wl);
		const failed = snap.control.filter((c) => c.prefix === "launch-failed");
		expect(failed.map((c) => [c.laneId, c.createdBy, c.rest])).toEqual([[lane1, LANE_RUNNER_BY, `headroom: named ${A}, ${REASON}`]]);
		expect(snap.deaths).toEqual([`lane-died: ${lane1}: launch failed at headroom: named ${A}, ${REASON}`]);
		expect(deathSenders(r, wl)).toEqual([LANE_RUNNER_BY]);
		expect(snap.control.filter((c) => c.prefix === "lane-started" || c.prefix === "lane-ready" || c.prefix === "lane-headroom")).toEqual([]);
		expect(snap.workload!.holder).toBeNull();
	}, 60_000);

	test("an unnamed lane whose omp starts on anthropic, anthropic 5h at 0.85: set_model to the strong row's next entry, confirmed by get_state, before the first prompt; lane-headroom: by lane-runner", async () => {
		const r = makeRoot({ anthropic: 0.85 });
		// The target is the profile's strong row's first entry on another lab (profile/config.yml).
		expect(loadTierTable(PROFILE_CONFIG).strong.find((s) => !s.startsWith("anthropic/"))).toBe(SOL);
		const wl = openWorkload(r, null);
		launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" } });
		const lane1 = laneIdOf(wl, 1);
		expect(await endOf(r, wl, lane1)).toMatchObject({ prefix: "lane-exit" });
		expect(laneExit(laneSnapshot(r, wl).control, lane1)).toMatchObject({ outcome: "completed" });
		expect(spawns(r)[0]!.argv).not.toContain("--model");
		expect(commandsOf(r, 1).slice(0, 4)).toEqual(["get_state", `set_model ${SOL}`, "get_state", "prompt"]);
		const snap = laneSnapshot(r, wl);
		const moved = snap.control.filter((c) => c.prefix === "lane-headroom");
		expect(moved.map((c) => [c.laneId, c.createdBy, c.rest])).toEqual([[lane1, LANE_RUNNER_BY, `${A} -> ${SOL} (${REASON})`]]);
		const order = snap.control.filter((c) => c.laneId === lane1).map((c) => c.prefix);
		expect(order.indexOf("lane-headroom")).toBeLessThan(order.indexOf("lane-ready"));
		// Jo's word is untouched: no lane-model: was written; the start record names no model and OMP's confirmed one.
		expect(snap.control.some((c) => c.prefix === "lane-model")).toBe(false);
		expect(laneStarted(snap.control, lane1)).toMatchObject({ model: null, ranModel: SOL });
		expect(snap.deaths).toEqual([]);
	}, 60_000);

	test("an unnamed lane when every strong-row lab is out: never ready at headroom, no prompt, one launch-failed: and one lane-died:", async () => {
		const r = makeRoot({ anthropic: 0.85, "openai-codex": 0.9, moonshot: 0.95 });
		const wl = openWorkload(r, null);
		launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" } });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		const snap = laneSnapshot(r, wl);
		expect(laneExit(snap.control, lane1)).toMatchObject({ outcome: "never-ready" });
		expect(commandsOf(r, 1)).not.toContain("prompt");
		expect(commandsOf(r, 1).some((c) => c.startsWith("set_model"))).toBe(false);
		const failed = snap.control.filter((c) => c.prefix === "launch-failed");
		expect(failed.map((c) => [c.laneId, c.createdBy])).toEqual([[lane1, LANE_RUNNER_BY]]);
		expect(failed[0]!.rest).toStartWith(`headroom: ${A} is out (${REASON}); every strong-row entry is out: `);
		expect(snap.deaths.length).toBe(1);
		expect(snap.deaths[0]).toStartWith(`lane-died: ${lane1}: launch failed at headroom: ${A} is out`);
		expect(snap.workload!.holder).toBeNull();
	}, 60_000);

	test("an unnamed lane when the polls show room: no set_model, the first prompt follows the first get_state as before", async () => {
		const r = makeRoot({ anthropic: 0.1 });
		const wl = openWorkload(r, null);
		launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" } });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		expect(laneExit(laneSnapshot(r, wl).control, lane1)).toMatchObject({ outcome: "completed" });
		expect(commandsOf(r, 1).slice(0, 2)).toEqual(["get_state", "prompt"]);
		expect(commandsOf(r, 1).some((c) => c.startsWith("set_model"))).toBe(false);
		const snap = laneSnapshot(r, wl);
		expect(snap.control.some((c) => c.prefix === "lane-headroom")).toBe(false);
		expect(laneStarted(snap.control, lane1)).toMatchObject({ model: null, ranModel: A });
	}, 60_000);

	test("the train's preferred model in quota starts the lane on it: --model in the argv, checked by get_state, no move", async () => {
		const r = makeRoot({ anthropic: 0.1, "openai-codex": 0.1 });
		const wl = openWorkload(r, null, SOL);
		launch(r, wl, { steps: DONE, stateModel: { provider: "openai-codex", id: "gpt-6.1-sol" } });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		const snap = laneSnapshot(r, wl);
		expect(laneExit(snap.control, lane1)).toMatchObject({ outcome: "completed" });
		const argv = spawns(r)[0]!.argv!;
		expect(argv[argv.indexOf("--model") + 1]).toBe(SOL);
		expect(laneStarted(snap.control, lane1)).toMatchObject({ model: SOL, ranModel: SOL });
		expect(snap.control.some((c) => c.prefix === "lane-headroom" || c.prefix === "launch-failed")).toBe(false);
	}, 60_000);

	test("the train's preferred model refused by the quota guard falls back to ordinary routing: omp spawns with no --model, the lane completes, no launch-failed:", async () => {
		const r = makeRoot({ anthropic: 0.1, "openai-codex": 0.85 });
		const wl = openWorkload(r, null, SOL);
		launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" } });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		const snap = laneSnapshot(r, wl);
		expect(laneExit(snap.control, lane1)).toMatchObject({ outcome: "completed" });
		expect(spawns(r)[0]!.argv).not.toContain("--model");
		expect(commandsOf(r, 1).slice(0, 2)).toEqual(["get_state", "prompt"]);
		expect(laneStarted(snap.control, lane1)).toMatchObject({ model: null, ranModel: A });
		expect(snap.control.some((c) => c.prefix === "launch-failed" || c.prefix === "lane-model")).toBe(false);
		expect(snap.deaths).toEqual([]);
		expect(runnerLog(r, wl)).toContain(`preferred ${SOL} refused (openai-codex 5h 0.85 used > 0.80); falling back to ordinary routing`);
	}, 60_000);

	test("Jo's lane-model: over a preference keeps today's refusal: named and out fails at headroom before any omp", async () => {
		const r = makeRoot({ anthropic: 0.1, "openai-codex": 0.85 });
		const wl = openWorkload(r, SOL, A);
		launch(r, wl, { steps: DONE });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		expect(spawns(r)).toEqual([]);
		const snap = laneSnapshot(r, wl);
		expect(snap.control.filter((c) => c.prefix === "launch-failed").map((c) => c.rest)).toEqual([`headroom: named ${SOL}, openai-codex 5h 0.85 used > 0.80`]);
		expect(snap.deaths).toHaveLength(1);
	}, 60_000);
});

describe("mature week-only runner admission against configured budget alternatives", () => {
	for (const named of [true, false]) {
		for (const claudeUsed of [0.18, 0.34, 0.87]) {
			test(`${named ? "named" : "unnamed"} OpenAI stays on its mature .21 week meter against faster Claude at ${claudeUsed}, with a stderr explanation and no model change`, async () => {
				const r = makeRoot({});
				writeComparisonPolls(r, claudeUsed);
				const wl = openWorkload(r, named ? SOL : null);
				launch(r, wl, { steps: DONE, stateModel: { provider: "openai-codex", id: "gpt-6.1-sol" } });
				const lane1 = laneIdOf(wl, 1);
				await endOf(r, wl, lane1);
				const snap = laneSnapshot(r, wl);
				expect(laneExit(snap.control, lane1)).toMatchObject({ outcome: "completed" });
				expect(laneStarted(snap.control, lane1)).toMatchObject({ model: named ? SOL : null, ranModel: SOL });
				expect(commandsOf(r, 1).slice(0, 2)).toEqual(["get_state", "prompt"]);
				expect(commandsOf(r, 1).some((c) => c.startsWith("set_model"))).toBe(false);
				const argv = spawns(r)[0]!.argv!;
				if (named) expect(argv[argv.indexOf("--model") + 1]).toBe(SOL);
				else expect(argv).not.toContain("--model");
				expect(snap.control.filter((c) => c.prefix === "lane-model").length).toBe(named ? 1 : 0);
				expect(snap.control.filter((c) => c.prefix === "lane-headroom" || c.prefix === "launch-failed")).toEqual([]);
				expect(snap.deaths).toEqual([]);
				const log = runnerLog(r, wl);
				expect(log).toContain(`retained ${SOL}: openai-codex 7d`);
				expect(log).toContain(`${A} recent pressure ${((claudeUsed - 0.04) * 100 * 60 / 26).toFixed(2)} pts/h`);
				expect(log).toContain("> source 2.31 pts/h over 26 min");
			}, 60_000);
		}

		test(`${named ? "named" : "unnamed"} mature OpenAI is refused or actually moved when the first alternative burns more slowly`, async () => {
			const r = makeRoot({});
			writeComparisonPolls(r, 0.18, { claudeBefore: 0.18 });
			const wl = openWorkload(r, named ? SOL : null);
			launch(r, wl, { steps: DONE, stateModel: { provider: "openai-codex", id: "gpt-6.1-sol" } });
			const lane1 = laneIdOf(wl, 1);
			await endOf(r, wl, lane1);
			const snap = laneSnapshot(r, wl);
			if (named) {
				expect(spawns(r)).toEqual([]);
				expect(snap.control.find((c) => c.prefix === "launch-failed")?.rest).toStartWith(`headroom: named ${SOL}, openai-codex 7d`);
				expect(snap.control.some((c) => c.prefix === "lane-ready")).toBe(false);
				expect(snap.deaths).toHaveLength(1);
			} else {
				expect(laneExit(snap.control, lane1)).toMatchObject({ outcome: "completed" });
				expect(commandsOf(r, 1).slice(0, 4)).toEqual(["get_state", `set_model ${A}`, "get_state", "prompt"]);
				expect(laneStarted(snap.control, lane1)).toMatchObject({ model: null, ranModel: A });
				expect(snap.control.find((c) => c.prefix === "lane-headroom")?.rest).toStartWith(`${SOL} -> ${A} (openai-codex 7d`);
				expect(snap.deaths).toEqual([]);
			}
		}, 60_000);

		test(`${named ? "named" : "unnamed"} source 5h hard ceiling cannot be waived by a faster budget alternative`, async () => {
			const r = makeRoot({});
			installTierTable(r, [A, SOL, K]);
			writeComparisonPolls(r, 0.34, { sourceHard: true });
			const wl = openWorkload(r, named ? SOL : null);
			launch(r, wl, { steps: DONE, stateModel: { provider: "openai-codex", id: "gpt-6.1-sol" } });
			const lane1 = laneIdOf(wl, 1);
			await endOf(r, wl, lane1);
			const snap = laneSnapshot(r, wl);
			if (named) {
				expect(spawns(r)).toEqual([]);
				expect(snap.control.find((c) => c.prefix === "launch-failed")?.rest).toStartWith(`headroom: named ${SOL}, `);
				expect(snap.control.some((c) => c.prefix === "lane-ready")).toBe(false);
			} else {
				// Claude is itself pace-out at .34; the actual move skips it and the hard-out source.
				expect(laneExit(snap.control, lane1)).toMatchObject({ outcome: "completed" });
				expect(commandsOf(r, 1).slice(0, 4)).toEqual(["get_state", `set_model ${K}`, "get_state", "prompt"]);
				expect(laneStarted(snap.control, lane1)).toMatchObject({ model: null, ranModel: K });
			}
		}, 60_000);

		test(`${named ? "named" : "unnamed"} out source gets no comparative exception when the installed strong row is unreadable`, async () => {
			const r = makeRoot({});
			writeComparisonPolls(r, 0.34);
			removeTierTable(r);
			const wl = openWorkload(r, named ? SOL : null);
			launch(r, wl, { steps: DONE, stateModel: { provider: "openai-codex", id: "gpt-6.1-sol" } });
			const lane1 = laneIdOf(wl, 1);
			await endOf(r, wl, lane1);
			const snap = laneSnapshot(r, wl);
			const failure = snap.control.find((c) => c.prefix === "launch-failed");
			expect(failure?.rest).toStartWith(`headroom: ${named ? `named ${SOL},` : `${SOL} is out`}`);
			expect(snap.control.some((c) => c.prefix === "lane-ready" || c.prefix === "lane-headroom")).toBe(false);
			expect(snap.deaths).toHaveLength(1);
			expect(snap.workload!.holder).toBeNull();
			if (named) expect(runnerLog(r, wl)).toContain("quota guard comparison unavailable: the strong row could not be read:");
			if (named) expect(spawns(r)).toEqual([]);
			else {
				expect(failure?.rest).toContain("the strong row could not be read");
				expect(commandsOf(r, 1).some((c) => c.startsWith("set_model") || c === "prompt")).toBe(false);
				expect(laneExit(snap.control, lane1)).toMatchObject({ outcome: "never-ready" });
			}
		}, 60_000);
	}

	test("an unreadable strong row still admits a named source that is ordinarily in quota", async () => {
		const r = makeRoot({ anthropic: 0.1 });
		removeTierTable(r);
		const wl = openWorkload(r, A);
		launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" } });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		const snap = laneSnapshot(r, wl);
		expect(laneExit(snap.control, lane1)).toMatchObject({ outcome: "completed" });
		expect(laneStarted(snap.control, lane1)).toMatchObject({ model: A, ranModel: A });
		expect(commandsOf(r, 1).slice(0, 2)).toEqual(["get_state", "prompt"]);
		expect(commandsOf(r, 1).some((c) => c.startsWith("set_model"))).toBe(false);
		expect(snap.control.some((c) => c.prefix === "lane-headroom")).toBe(false);
		expect(runnerLog(r, wl)).toContain("quota guard comparison unavailable: the strong row could not be read:");
		expect(snap.deaths).toEqual([]);
	}, 60_000);

	test("the installed strong row's first other-lab budget controls retention, not a faster later alternative", async () => {
		const r = makeRoot({});
		installTierTable(r, [`${K}:high`, A, SOL]);
		writeComparisonPolls(r, 0.34, { moonshotUsed: 0.04 });
		const wl = openWorkload(r, SOL);
		launch(r, wl, { steps: DONE });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		expect(spawns(r)).toEqual([]);
		const snap = laneSnapshot(r, wl);
		expect(snap.control.find((c) => c.prefix === "launch-failed")?.rest).toStartWith(`headroom: named ${SOL}, openai-codex 7d`);
		expect(snap.control.some((c) => c.prefix === "lane-ready")).toBe(false);
	}, 60_000);

	test("actual move destinations use base quota: skip a week-out candidate even when a later hotter budget could retain it", async () => {
		const r = makeRoot({});
		installTierTable(r, [`${SOL}:high`, K, A]);
		writeComparisonPolls(r, 0.87, { moonshotUsed: 0.18 });
		const wl = openWorkload(r, null);
		launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" } });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		const snap = laneSnapshot(r, wl);
		expect(laneExit(snap.control, lane1)).toMatchObject({ outcome: "completed" });
		expect(commandsOf(r, 1).slice(0, 4)).toEqual(["get_state", `set_model ${K}`, "get_state", "prompt"]);
		expect(laneStarted(snap.control, lane1)).toMatchObject({ model: null, ranModel: K });
		const order = snap.control.filter((c) => c.laneId === lane1).map((c) => c.prefix);
		expect(order.indexOf("lane-headroom")).toBeLessThan(order.indexOf("lane-ready"));
		expect(snap.control.some((c) => c.prefix === "lane-model")).toBe(false);
		expect(snap.deaths).toEqual([]);
	}, 60_000);
});
