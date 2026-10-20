// The quota guard at the real RPC runner: eligible lanes wait for their own lab, while excluded
// lanes preserve comparative admission and base-in-quota moves. Returns home must be confirmed
// before the first prompt. These process tests run outside the fence.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTierTable } from "../../classifier/src/tier-table";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { laneClaimed } from "../scripts/lane";
import { recordRepo } from "../src/decision-log";
import { doneBody, laneDir, laneExit, laneModelBody, laneStarted, trainBoardBody, verdictOf, worktreeBody, worktreePath } from "../src/launch";
import { homeModel, readLabWaitContext, recordLabWait, reconcileLabWait, standingWait } from "../src/lab-wait";
import { MERGE_TRAIN_BY, SURFACE_BY } from "../src/types";
import type { FakeScript, FakeStep, LaneRoot } from "./helpers";
import { fakeRecords, LANE_SCRIPT, laneIdOf, laneRoot, laneSnapshot, setScript, settleDrains, sh, tempLedger, until } from "./helpers";

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
/** A workload with its done: line and one open slice; existing move/fail cases remain production. */
function openWorkload(r: LaneRoot, model: string | null, stakes: "normal" | "production" | "throwaway" = "production", mode: "autonomous" | "user-driven" = "autonomous"): string {
	const l = ledgerOf(r);
	try {
		const wl = l.openWorkload({ by: SURFACE_BY, brief: "headroom probe", stakes, mode });
		recordRepo(l, wl, r.repo);
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
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
/** Exercise the runner on a pre-existing reservation, without the autonomous starter's mode/lab gate. */
const runReserved = (r: LaneRoot, wl: string, script: FakeScript) => {
	setScript(r, script);
	const l = ledgerOf(r);
	let laneId: string;
	try {
		const reservation = l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 100, leaseMs: 60_000, requestedBy: "test", decide: () => ({ launch: true, cause: "first" }) });
		if (!reservation.ok) throw new Error(reservation.reason);
		laneId = reservation.laneId;
		l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: worktreeBody(worktreePath(r.repo, wl)) });
	} finally {
		l.close();
	}
	expect(sh(["bun", LANE_SCRIPT, "run", wl, laneId], r.repo, r.env).code).toBe(0);
	return laneId;
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

describe("readiness claim provenance", () => {
	test("a stakes update preserves a real claim, never a starter's reservation or a lane entry", () => {
		const { ledger: l } = tempLedger();
		try {
			const wl = l.openWorkload({ by: SURFACE_BY, brief: "claim probe", stakes: "normal", mode: "autonomous" });
			const lane = "lane-claim-probe";
			const claimed = () => laneClaimed(l.workload(wl), lane, l.provenance(wl));
			l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: lane, leaseMs: 60_000 });
			l.recordEntry({ by: lane, workloadId: wl, kind: "assumption", body: "not a workload claim" });
			l.setStakes(wl, { by: SURFACE_BY, stakes: "production" });
			expect(claimed()).toBe(false);
			l.setStakes(wl, { by: lane, stakes: "normal" });
			expect(claimed()).toBe(false);
			l.claimWorkload(wl, { by: lane, holder: lane, leaseMs: 60_000 });
			expect(claimed()).toBe(true);
			l.setStakes(wl, { by: SURFACE_BY, stakes: "normal" });
			expect(l.workload(wl)?.changed_by).toBe(SURFACE_BY);
			expect(claimed()).toBe(true);
			l.releaseWorkload(wl, { by: lane, holder: lane });
			expect(claimed()).toBe(false);
			l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: lane, leaseMs: 60_000 });
			l.setStakes(wl, { by: SURFACE_BY, stakes: "production" });
			expect(claimed()).toBe(false);
			l.claimWorkload(wl, { by: lane, holder: lane, leaseMs: 60_000 });
			l.setStakes(wl, { by: SURFACE_BY, stakes: "normal" });
			expect(claimed()).toBe(true);
			l.releaseWorkload(wl, { by: lane, holder: lane });
			l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: "lane-other", leaseMs: 60_000 });
			expect(claimed()).toBe(false);
		} finally {
			l.close();
		}
	});
});

describe("PLAN wl-mv71x5rwdu7eo0 § 4: the quota guard at the runner's spawn", () => {
	test("a named anthropic model with anthropic 5h at 0.85: no omp spawned; one launch-failed: at headroom and one lane-died:, both by lane-runner; released", async () => {
		const r = makeRoot({ anthropic: 0.85 });
		const wl = openWorkload(r, A, "normal");
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
		expect(laneStarted(snap.control, lane1)).toMatchObject({ model: null, ranModel: SOL, startModel: A, homeModel: SOL });
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

describe("normal autonomous lanes wait and return to their own lab (PLAN wl-mvh249u2w238jk)", () => {
	for (const late of ["none", "shutdown", "exit"] as const) {
		test(`T2/T2b: post-spawn wait before EOF, late claim ${late}: no prompt, model move or death, intended and released`, async () => {
			const r = makeRoot({ anthropic: 0.85 });
			const wl = openWorkload(r, null, "normal");
			launch(r, wl, {
				stateModel: { provider: "anthropic", id: "claude-opus-5-5" }, steps: DONE, inspectEofIntent: true,
				...(late === "none" ? {} : { claimOnEof: true, shutdownOnEof: late === "shutdown" }),
			});
			const lane1 = laneIdOf(wl, 1);
			await endOf(r, wl, lane1);
			const snap = laneSnapshot(r, wl);
			expect(laneExit(snap.control, lane1)?.outcome).toBe("waiting");
			expect(commandsOf(r, 1)).toEqual(["get_state"]);
			expect(snap.control.filter(c => c.prefix === "lane-ready" || c.prefix === "launch-failed" || c.prefix === "lane-headroom")).toEqual([]);
			expect(snap.control.filter(c => c.prefix === "lane-decided").map(c => [c.createdBy, c.rest])).toEqual([[LANE_RUNNER_BY, "waiting"]]);
			expect(snap.control.filter(c => c.prefix === "lab-wait").map(c => [c.createdBy, c.rest])).toEqual([[LANE_RUNNER_BY, `${A} (${REASON})`]]);
			expect(laneStarted(snap.control, lane1)).toMatchObject({ model: null, ranModel: A, startModel: A, homeModel: A });
			expect(snap.deaths).toEqual([]);
			expect(deathSenders(r, wl)).toEqual([]);
			expect(snap.workload!.holder).toBeNull();
			const pid = spawns(r)[0]!.pid;
			expect(fakeRecords(r).filter(x => x.pid === pid && x.event === "eof")).toHaveLength(1);
			expect(fakeRecords(r).find(x => x.pid === pid && (x.event === "shutdown-intent" || x.event === "late-claim"))?.intended).toBe(true);
			const session = spawns(r)[0]!.session!;
			if (late !== "exit") expect(readFileSync(session, "utf8")).toContain('"type":"session_shutdown"');
			if (late !== "none") {
				const claimed = fakeRecords(r).find(x => x.pid === pid && x.event === "late-claim");
				expect(claimed?.intended).toBe(true);
				expect(claimed?.holder).toBe(lane1);
			}
			const l = ledgerOf(r);
			try {
				expect(standingWait(snap.control)?.model).toBe(A);
				const wait = readLabWaitContext(l, r.env);
				const out = verdictOf(l.launchRows(wl, 3)!, wait);
				expect(out.launch).toBe(false);
				if (!out.launch) expect(out.reason).toStartWith(`lab-out: ${A} (`);
			} finally {
				l.close();
			}
		}, 60_000);
	}

	test("T5b: a real post-spawn wait relaunches with waited cause when its lab returns, without a model change", async () => {
		const r = makeRoot({ anthropic: 0.85 });
		const wl = openWorkload(r, null, "normal");
		launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" } });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		await settleDrains(r);
		writePolls(r, { anthropic: 0.1 });
		const l = ledgerOf(r);
		try {
			expect(verdictOf(l.launchRows(wl, 3)!, readLabWaitContext(l, r.env))).toEqual({ launch: true, cause: { kind: "waited", laneId: lane1 } });
		} finally {
			l.close();
		}
		launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" } });
		const lane2 = laneIdOf(wl, 2);
		await endOf(r, wl, lane2);
		const snap = laneSnapshot(r, wl);
		expect(snap.control.find(c => c.prefix === "launch" && c.laneId === lane2)?.rest).toBe(`cause waited ${lane1} requested-by test`);
		expect(commandsOf(r, 2).slice(0, 2)).toEqual(["get_state", "prompt"]);
		expect(commandsOf(r, 2).some(c => c.startsWith("set_model"))).toBe(false);
		expect(laneStarted(snap.control, lane2)).toMatchObject({ startModel: A, homeModel: A, ranModel: A });
		expect(laneExit(snap.control, lane2)?.outcome).toBe("completed");
		expect(snap.deaths).toEqual([]);
	}, 60_000);

	test("recorded out home is checked instead of an admitted reported model on a reservation already made", async () => {
		const r = makeRoot({ anthropic: 0.85 });
		const wl = openWorkload(r, null, "normal");
		launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" } });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		await settleDrains(r);
		const lane2 = runReserved(r, wl, { steps: DONE, stateModel: { provider: "openai-codex", id: "gpt-6.1-sol" } });
		const snap = laneSnapshot(r, wl);
		expect(laneExit(snap.control, lane2)?.outcome).toBe("waiting");
		expect(commandsOf(r, 2)).toEqual(["get_state"]);
		expect(laneStarted(snap.control, lane2)).toMatchObject({ startModel: SOL, homeModel: A, ranModel: SOL });
		expect(snap.control.filter(c => c.prefix === "lab-wait")).toHaveLength(2);
		expect(snap.deaths).toEqual([]);
		expect(snap.workload!.holder).toBeNull();
	}, 60_000);

	for (const result of ["confirmed", "refused", "unconfirmed"] as const) {
		test(`T5c: resumed lane reports another lab but recorded home wins; return ${result}`, async () => {
			const r = makeRoot({ anthropic: 0.85 });
			const wl = openWorkload(r, null, "normal");
			launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" } });
			const lane1 = laneIdOf(wl, 1);
			await endOf(r, wl, lane1);
			await settleDrains(r);
			writePolls(r, { anthropic: 0.1, "openai-codex": 0.9 });
			launch(r, wl, {
				steps: DONE, stateModel: { provider: "openai-codex", id: "gpt-6.1-sol" },
				setModelFail: result === "refused", setModelUnconfirmed: result === "unconfirmed",
			});
			const lane2 = laneIdOf(wl, 2);
			await endOf(r, wl, lane2);
			const snap = laneSnapshot(r, wl);
			const started = laneStarted(snap.control, lane2)!;
			expect(started.argv).toContain("--resume");
			expect(started.startModel).toBe(SOL);
			expect(started.homeModel).toBe(A);
			expect(homeModel(snap.control)).toBe(A);
			const cmds = commandsOf(r, 2);
			expect(cmds.slice(0, 2)).toEqual(["get_state", `set_model ${A}`]);
			if (result === "confirmed") {
				expect(cmds.slice(0, 4)).toEqual(["get_state", `set_model ${A}`, "get_state", "prompt"]);
				expect(started.ranModel).toBe(A);
				expect(snap.control.find(c => c.prefix === "lane-headroom" && c.laneId === lane2)?.rest).toBe(`${SOL} -> ${A} (own lab)`);
				expect(laneExit(snap.control, lane2)?.outcome).toBe("completed");
				expect(snap.deaths).toEqual([]);
			} else {
				expect(cmds).not.toContain("prompt");
				expect(laneExit(snap.control, lane2)?.outcome).toBe("never-ready");
				expect(snap.control.find(c => c.prefix === "launch-failed" && c.laneId === lane2)?.rest).toStartWith(`headroom: set_model ${A}`);
				expect(snap.deaths).toHaveLength(1);
			}
			expect(snap.workload!.holder).toBeNull();
		}, 60_000);
	}

	test("an unreadable strong row uses the eligible source's base decision and waits instead of moveOff failure", async () => {
		const r = makeRoot({});
		writeComparisonPolls(r, 0.34);
		removeTierTable(r);
		const wl = openWorkload(r, null, "normal");
		launch(r, wl, { steps: DONE, stateModel: { provider: "openai-codex", id: "gpt-6.1-sol" } });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		const snap = laneSnapshot(r, wl);
		expect(laneExit(snap.control, lane1)?.outcome).toBe("waiting");
		expect(commandsOf(r, 1)).toEqual(["get_state"]);
		expect(standingWait(snap.control)?.model).toBe(SOL);
		expect(standingWait(snap.control)?.reason).toStartWith("openai-codex 7d");
		expect(snap.control.filter(c => c.prefix === "launch-failed")).toEqual([]);
		expect(snap.deaths).toEqual([]);
		expect(snap.workload!.holder).toBeNull();
	}, 60_000);

	test("eligible comparative retention still admits the source without waiting or moving", async () => {
		const r = makeRoot({});
		writeComparisonPolls(r, 0.34);
		const wl = openWorkload(r, null, "normal");
		launch(r, wl, { steps: DONE, stateModel: { provider: "openai-codex", id: "gpt-6.1-sol" } });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		const snap = laneSnapshot(r, wl);
		expect(laneExit(snap.control, lane1)?.outcome).toBe("completed");
		expect(commandsOf(r, 1).slice(0, 2)).toEqual(["get_state", "prompt"]);
		expect(standingWait(snap.control)).toBeNull();
		expect(laneStarted(snap.control, lane1)).toMatchObject({ startModel: SOL, homeModel: SOL, ranModel: SOL });
		expect(runnerLog(r, wl)).toContain(`retained ${SOL}: openai-codex 7d`);
	}, 60_000);

	for (const kind of ["user-driven", "train", "train-fix", "throwaway"] as const) {
		test(`T4/T7/T9: ${kind} unnamed lane preserves the excluded move path`, async () => {
			const r = makeRoot({ anthropic: 0.85 });
			const wl = openWorkload(r, null, kind === "throwaway" ? "throwaway" : "normal", kind === "user-driven" ? "user-driven" : "autonomous");
			const l = ledgerOf(r);
			try {
				if (kind === "train") l.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body: trainBoardBody({ pr: 7, workload: wl, head: "a".repeat(40), run: null, review: null }) });
				if (kind === "train-fix") l.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body: "train-fix: repo example/repo pr 7 train wl-train train-entry en-train" });
			} finally {
				l.close();
			}
			const script: FakeScript = { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" } };
			if (kind === "user-driven") runReserved(r, wl, script);
			else launch(r, wl, script);
			const lane1 = laneIdOf(wl, 1);
			await endOf(r, wl, lane1);
			const snap = laneSnapshot(r, wl);
			expect(commandsOf(r, 1).slice(0, 4)).toEqual(["get_state", `set_model ${SOL}`, "get_state", "prompt"]);
			expect(laneStarted(snap.control, lane1)).toMatchObject({ startModel: A, homeModel: SOL, ranModel: SOL });
			expect(laneExit(snap.control, lane1)?.outcome).toBe("completed");
			expect(standingWait(snap.control)).toBeNull();
			expect(snap.deaths).toEqual([]);
			if (kind === "train") expect(snap.control.some(c => c.prefix === "train-fix")).toBe(false);
		}, 60_000);
	}

	test("T6: normal named OpenAI on an out Anthropic lab stays named and never returns to a prior home", async () => {
		const r = makeRoot({ anthropic: 0.85 });
		const wl = openWorkload(r, null, "normal");
		launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" } });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		await settleDrains(r);
		const l = ledgerOf(r);
		try {
			l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: laneModelBody(SOL, l.now()) });
		} finally {
			l.close();
		}
		launch(r, wl, { steps: DONE });
		const lane2 = laneIdOf(wl, 2);
		await endOf(r, wl, lane2);
		const snap = laneSnapshot(r, wl);
		expect(commandsOf(r, 2).slice(0, 2)).toEqual(["get_state", "prompt"]);
		expect(laneStarted(snap.control, lane2)).toMatchObject({ model: SOL, startModel: SOL, homeModel: SOL, ranModel: SOL });
		expect(laneExit(snap.control, lane2)?.outcome).toBe("completed");
		expect(snap.deaths).toEqual([]);
	}, 60_000);

	for (const polls of ["missing", "stale"] as const) {
		test(`T9: ${polls} polls fail open for a normal lane without a model change or wait`, async () => {
			const r = makeRoot({ anthropic: 0.85 });
			if (polls === "missing") rmSync(r.env.AS2_HEADROOM_POLLS!);
			else writeFileSync(r.env.AS2_HEADROOM_POLLS!, `${JSON.stringify({ t: 1, rows: { "anthropic/5h": 0.99 } })}\n`);
			const wl = openWorkload(r, null, "normal");
			launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" } });
			const lane1 = laneIdOf(wl, 1);
			await endOf(r, wl, lane1);
			const snap = laneSnapshot(r, wl);
			expect(commandsOf(r, 1).slice(0, 2)).toEqual(["get_state", "prompt"]);
			expect(standingWait(snap.control)).toBeNull();
			expect(laneExit(snap.control, lane1)?.outcome).toBe("completed");
			expect(snap.deaths).toEqual([]);
		}, 60_000);
	}

	for (const to of ["production", "normal"] as const) {
		test(`first get_state reads fresh eligibility after stakes change to ${to}`, async () => {
			const r = makeRoot({ anthropic: 0.85 });
			const wl = openWorkload(r, null, to === "production" ? "normal" : "production");
			const gate = join(r.root, "state-release");
			launch(r, wl, { steps: DONE, stateModel: { provider: "anthropic", id: "claude-opus-5-5" }, stateWaitUntil: gate });
			await until("get_state before the eligibility flip", () => fakeRecords(r).some(x => x.command === "get_state"));
			const l = ledgerOf(r);
			try {
				l.setStakes(wl, { by: SURFACE_BY, stakes: to });
			} finally {
				l.close();
			}
			writeFileSync(gate, "release state\n");
			const lane1 = laneIdOf(wl, 1);
			await endOf(r, wl, lane1);
			const snap = laneSnapshot(r, wl);
			const diagnostics = `${JSON.stringify(snap.control)}\n${runnerLog(r, wl)}`;
			if (to === "production") {
				expect(commandsOf(r, 1).slice(0, 4), diagnostics).toEqual(["get_state", `set_model ${SOL}`, "get_state", "prompt"]);
				expect(laneStarted(snap.control, lane1), diagnostics).toMatchObject({ startModel: A, homeModel: SOL, ranModel: SOL });
				expect(snap.control.filter(c => c.prefix === "lane-headroom").map(c => c.rest), diagnostics).toEqual([`${A} -> ${SOL} (${REASON})`]);
				expect(snap.control.some(c => c.prefix === "lane-ready" && c.laneId === lane1), diagnostics).toBe(true);
				expect(laneExit(snap.control, lane1)?.outcome, diagnostics).toBe("completed");
			} else {
				expect(commandsOf(r, 1)).toEqual(["get_state"]);
				expect(laneExit(snap.control, lane1)?.outcome).toBe("waiting");
			}
			expect(snap.deaths, diagnostics).toEqual([]);
		}, 60_000);
	}

	test("T11: a pre-spawn wait followed by clear holds the first lane to the waited home, not OMP's default", async () => {
		const r = makeRoot({ anthropic: 0.1 });
		const wl = openWorkload(r, null, "normal");
		const l = ledgerOf(r);
		try {
			recordLabWait(l, wl, A, REASON);
			expect(reconcileLabWait(l, wl, readLabWaitContext(l, r.env))).toBeNull();
		} finally {
			l.close();
		}
		launch(r, wl, { steps: DONE, stateModel: { provider: "openai-codex", id: "gpt-6.1-sol" } });
		const lane1 = laneIdOf(wl, 1);
		await endOf(r, wl, lane1);
		const snap = laneSnapshot(r, wl);
		expect(commandsOf(r, 1).slice(0, 4)).toEqual(["get_state", `set_model ${A}`, "get_state", "prompt"]);
		expect(laneStarted(snap.control, lane1)).toMatchObject({ startModel: SOL, homeModel: A, ranModel: A });
		expect(spawns(r)[0]!.argv).not.toContain("--resume");
		expect(snap.control.find(c => c.prefix === "lane-headroom")?.rest).toBe(`${SOL} -> ${A} (own lab)`);
		expect(laneExit(snap.control, lane1)?.outcome).toBe("completed");
		expect(snap.deaths).toEqual([]);
	}, 60_000);
});
