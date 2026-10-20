/**
 * The cross-lab review rule (classifier/src/lab.ts; PLAN wl-mupu0sx2o046io D1–D6): the
 * provider → lab map, review detection and read-back, who built a workload from its ledger rows,
 * the routing decision, and how Jo's park answer is read. T1–T3 (PLAN wl-mv45jcsi4h3nr4): a hand
 * whose lane exited or was replaced before it settled counts only the models in its session file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BuilderLedgerView,
	builderLabs,
	isReviewDispatch,
	isReviewRouting,
	labOf,
	parkQuestionBody,
	reviewPlan,
	REVIEW_ROW_FROM,
	reviewRow,
	unspentGrant,
} from "../src/lab";
import { LANE_RUNNER_BY, LANE_STARTER_BY } from "../../ledger/src/index";
import { route } from "../src/route";
import { LANE_RUNNER_BY, LANE_STARTER_BY } from "../../ledger/src/index";
import { SURFACE_BY } from "../../surface/src/types";
import { dist } from "./helpers";

const STRONG = ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "moonshot/kimi-k2.7-code"];
const AT = "2026-10-11T10:00:00.000Z";
interface FixtureEntry {
	kind: "assumption";
	body: string;
	slice_id: string | null;
	created_by: string;
	created_at: string;
}
const entry = (body: string, slice_id: string | null = null, created_by = "lane-a", created_at = AT): FixtureEntry => ({ kind: "assumption", body, slice_id, created_by, created_at });
type Row = ReturnType<BuilderLedgerView["routings"]>[number];
const routing = (over: Partial<Row>): Row => ({
	kind: "change-large",
	pull_up_to: null,
	probabilities: JSON.stringify(dist({ "change-large": 0.9 })),
	outcome: "ran",
	models: JSON.stringify(STRONG),
	ran_models: JSON.stringify(["anthropic/claude-opus-5-5"]),
	session_root: "/s/lane",
	agent_id: null,
	...over,
});
const view = (entries: FixtureEntry[], routings: Row[] = []): BuilderLedgerView => ({ entries: () => entries, routings: () => routings });
const LANE = [entry('lane-started: lane-a {"pid":1}'), entry("builder-lab: anthropic lane lane-a model anthropic/claude-opus-5-5")];

describe("D1: provider → lab", () => {
	test("the map names three labs; a provider it does not name has no lab", () => {
		expect(labOf("anthropic/claude-opus-5-5")).toBe("anthropic");
		expect(labOf("openai/gpt-6")).toBe("openai");
		expect(labOf("openai-codex/gpt-6-sol:high")).toBe("openai");
		expect(labOf("kimi-code/k3")).toBe("kimi");
		expect(labOf("moonshot/kimi-k2.7-code")).toBe("kimi");
		expect(labOf("mystery/model-x")).toBeNull();
	});
});

describe("D2: which dispatches are reviews", () => {
	test("judge is a review; a low-confidence brief is one exactly when judge is in its top two, at 0.55 included", () => {
		expect(isReviewDispatch(route({ choice: "judge", confidence: 0.95, probabilities: dist({ judge: 0.95 }) }, "normal"))).toBe(true);
		const at = (confidence: number, second: string) =>
			isReviewDispatch(route({ choice: "understand", confidence, probabilities: dist({ understand: confidence, [second]: 0.4 }) }, "normal"));
		expect(at(0.55, "judge")).toBe(true);
		expect(at(0.56, "judge")).toBe(false);
		expect(at(0.55, "change-small")).toBe(false);
	});

	test("a settled row reads back the same way; unreadable probabilities never read as a review", () => {
		expect(isReviewRouting(routing({ kind: "judge" }))).toBe(true);
		const lowJudge = JSON.stringify(dist({ understand: 0.5, judge: 0.45 }));
		expect(isReviewRouting(routing({ kind: "understand", pull_up_to: "deep", probabilities: lowJudge }))).toBe(true);
		expect(isReviewRouting(routing({ kind: "understand", pull_up_to: null, probabilities: lowJudge }))).toBe(false);
		expect(isReviewRouting(routing({ kind: "understand", pull_up_to: "deep", probabilities: "{not json" }))).toBe(false);
	});
});

describe("D3: who built the work, from the ledger", () => {
	test("a lane's builder-lab entry; a lane that started with none makes the provenance unknown", () => {
		expect(builderLabs(view(LANE), "wl")).toEqual({ labs: ["anthropic"], unknown: [] });
		const unknown = builderLabs(view([...LANE, entry('lane-started: lane-b {"pid":2}')]), "wl");
		expect(unknown.unknown).toEqual(["lane lane-b has a lane-started: entry and no builder-lab: entry, so the lab it ran on is unknown"]);
	});

	test("non-review rows count what ran, or their whole row when it is unknown; review rows do not count", () => {
		const fellBack = routing({ ran_models: JSON.stringify(["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol"]) });
		expect(builderLabs(view(LANE, [fellBack]), "wl").labs).toEqual(["anthropic", "openai"]);
		const unknownModels = routing({ outcome: "refused-model-unknown", ran_models: null, models: JSON.stringify(STRONG.slice(0, 2)) });
		expect(builderLabs(view(LANE, [unknownModels]), "wl").labs).toEqual(["anthropic", "openai"]);
		const review = routing({ kind: "judge", ran_models: JSON.stringify(["kimi-code/kimi-for-coding"]) });
		expect(builderLabs(view(LANE, [review]), "wl").labs).toEqual(["anthropic"]);
	});

	test("an unsettled spawn token counts its whole row; a settled one, or a review in flight here, does not", () => {
		const spawn = (token: string, review: string, row: string[]) =>
			entry(`hand-spawn: ${token} session /s/lane spawn sl-x review ${review} group dg-1 row ${row.join(",")}`, "sl-x");
		const lost = spawn("dt-1", "no", STRONG.slice(1));
		expect(builderLabs(view([...LANE, lost]), "wl").labs).toEqual(["anthropic", "openai", "kimi"]);
		expect(builderLabs(view([...LANE, lost, entry("hand-settled: dt-1 routing rt-1")]), "wl").labs).toEqual(["anthropic"]);
		const reviewing = spawn("dt-2", "yes", ["kimi-code/kimi-for-coding"]);
		expect(builderLabs(view([...LANE, reviewing]), "wl", new Set(["dt-2"])).labs).toEqual(["anthropic"]);
		expect(builderLabs(view([...LANE, reviewing]), "wl").labs).toEqual(["anthropic", "kimi"]); // lost, not live (T2)
	});

	test("a review withheld for changing the work is a builder; a model on an unmapped provider is every lab", () => {
		expect(builderLabs(view([...LANE, entry("builder-lab: openai hand dt-9 model openai-codex/gpt-6-sol")]), "wl").labs).toEqual(["anthropic", "openai"]);
		const mystery = builderLabs(view(LANE, [routing({ ran_models: JSON.stringify(["mystery/model-x"]) })]), "wl");
		expect(mystery.unknown).toEqual(["a change-large hand ran on mystery/model-x: unknown lab for provider mystery; add it to classifier/src/lab.ts"]);
	});

	test("T15: a surface builder-lab-void drops that hand's marks; from a lane, for another hand, or against a lane mark it drops nothing", () => {
		const mark = entry("builder-lab: openai hand dt-1 model openai-codex/gpt-6-sol");
		const voided = (by: string, token = "dt-1") => entry(`builder-lab-void: hand ${token} by in-x`, "sl-x", by);
		expect(builderLabs(view([...LANE, mark]), "wl").labs).toEqual(["anthropic", "openai"]);
		expect(builderLabs(view([...LANE, mark, voided(SURFACE_BY)]), "wl")).toEqual({ labs: ["anthropic"], unknown: [] });
		expect(builderLabs(view([...LANE, voided(SURFACE_BY), mark, entry("builder-lab: kimi hand dt-1 model moonshot/kimi-k2.7-code")]), "wl").labs).toEqual(["anthropic"]);
		expect(builderLabs(view([...LANE, mark, voided("lane-a")]), "wl").labs).toEqual(["anthropic", "openai"]);
		expect(builderLabs(view([...LANE, mark, voided(SURFACE_BY, "dt-2")]), "wl").labs).toEqual(["anthropic", "openai"]);
		const laneB = [entry('lane-started: lane-b {"pid":2}'), entry("builder-lab: openai lane lane-b model openai-codex/gpt-6-sol")];
		expect(builderLabs(view([...LANE, ...laneB, voided(SURFACE_BY, "lane-b")]), "wl")).toEqual({ labs: ["anthropic", "openai"], unknown: [] });
	});

	test("T5a: a runner lane that ended before lane-ready: never got a prompt and is not unknown; anything less fails closed", () => {
		const started = [entry('lane-started: lane-b {"pid":2}', null, LANE_RUNNER_BY), entry('lane-started: lane-b {"pid":2,"session":"s"}', null, LANE_RUNNER_BY)];
		const failed = entry("launch-failed: lane-b model: named openai-codex/gpt-6-sol, omp started anthropic/claude-opus-5-5", null, LANE_RUNNER_BY);
		const exited = entry("lane-exit: lane-b code 0 signal - outcome stop", null, LANE_RUNNER_BY);
		const UNKNOWN = ["lane lane-b has a lane-started: entry and no builder-lab: entry, so the lab it ran on is unknown"];
		expect(builderLabs(view([...LANE, ...started, failed]), "wl")).toEqual({ labs: ["anthropic"], unknown: [] });
		expect(builderLabs(view([...LANE, ...started, exited]), "wl").unknown).toEqual([]);
		expect(builderLabs(view([...LANE, ...started, { ...failed, created_by: LANE_STARTER_BY }]), "wl").unknown).toEqual([]);
		// A lane-ready: from any writer means a prompt may have gone out.
		expect(builderLabs(view([...LANE, ...started, entry("lane-ready: lane-b at t", null, LANE_RUNNER_BY), exited]), "wl").unknown).toEqual(UNKNOWN);
		expect(builderLabs(view([...LANE, ...started, entry("lane-ready: lane-b at t", null, "lane-b"), exited]), "wl").unknown).toEqual(UNKNOWN);
		// Still running (no end), an end the lane wrote itself, or a lane-started: the runner did not write.
		expect(builderLabs(view([...LANE, ...started]), "wl").unknown).toEqual(UNKNOWN);
		expect(builderLabs(view([...LANE, ...started, { ...exited, created_by: "lane-b" }]), "wl").unknown).toEqual(UNKNOWN);
		expect(builderLabs(view([...LANE, started[0]!, entry('lane-started: lane-b {"pid":3}', null, LANE_STARTER_BY), exited]), "wl").unknown).toEqual(UNKNOWN);
		expect(builderLabs(view([...LANE, entry('lane-started: lane-b {"pid":2}'), failed]), "wl").unknown).toEqual(UNKNOWN);
	});
});

// ---- PLAN wl-mv45jcsi4h3nr4: dead hands ------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "as2-dead-hands-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let roots = 0;
const freshRoot = () => {
	const root = join(dir, `root-${++roots}`);
	mkdirSync(root);
	return root;
};
/** Minute `m` after 10:00Z on 2026-10-11, as the ledger and OMP stamp it (`toISOString`). */
const t = (m: number) => new Date(Date.UTC(2026, 9, 11, 10, 0, 0) + m * 60_000).toISOString();
const started = (lane: string, m: number, by = LANE_RUNNER_BY) => entry(`lane-started: ${lane} {"pid":1}`, null, by, t(m));
const exited = (lane: string, m: number, by = LANE_RUNNER_BY) => entry(`lane-exit: ${lane} code 1 signal - outcome died`, null, by, t(m));
const laneLab = (lane: string, m: number) => entry(`builder-lab: anthropic lane ${lane} model anthropic/claude-opus-5-5`, null, lane, t(m));
const spawned = (lane: string, token: string, o: { root: string; key: string; review?: boolean; row?: string[]; m: number }) =>
	entry(`hand-spawn: ${token} session ${o.root} spawn ${o.key} review ${o.review ? "yes" : "no"} group dg-${token} row ${(o.row ?? STRONG).join(",")}`, "sl-x", lane, t(o.m));
const settledBy = (lane: string, token: string, routingId: string, m: number) => entry(`hand-settled: ${token} routing ${routingId}`, "sl-x", lane, t(m));

/** One session file line per argument: OMP's header, an assistant turn, a user turn, or a raw line. */
const header = (ts: string) => JSON.stringify({ type: "session", version: 3, id: "s-1", timestamp: ts, cwd: "/w" });
const turn = (selector: string, ts: string, stopReason = "stop") => {
	const [provider, ...model] = selector.split("/");
	return JSON.stringify({ type: "message", id: "m-1", parentId: null, timestamp: ts, message: { role: "assistant", provider, model: model.join("/"), stopReason, content: [] } });
};
const userTurn = (ts: string) => JSON.stringify({ type: "message", id: "m-0", parentId: null, timestamp: ts, message: { role: "user", content: "go" } });
const session = (root: string, agentId: string, lines: string[]) => writeFileSync(join(root, `${agentId}.jsonl`), `${lines.join("\n")}\n`);

const OPENAI = "openai-codex/gpt-6-sol";
const KIMI = "moonshot/kimi-k2.7-code";
const L = "lane-wt-1";
const M = "lane-wt-2";

describe("T1: wl-mv0n866rd9jlds, a lane that died with two change hands in flight", () => {
	test("lane 2's unsettled hands, replaced by lane 3, count no lab: the builders are anthropic alone", () => {
		const missing = join(dir, "no-such-session-root");
		const [lane1, lane2, lane3] = ["lane-wt-1", "lane-wt-2", "lane-wt-3"];
		const entries = [
			started(lane1, 0), laneLab(lane1, 1),
			spawned(lane1, "dt-r1", { root: missing, key: "sl-plan-r1", review: true, row: [OPENAI, KIMI], m: 2 }),
			settledBy(lane1, "dt-r1", "rt-r1", 3),
			exited(lane1, 4),
			started(lane2, 10), started(lane2, 10), laneLab(lane2, 11),
			spawned(lane2, "dt-c1", { root: missing, key: "sl-fix-70", m: 12 }),
			settledBy(lane2, "dt-c1", "rt-c1", 13),
			spawned(lane2, "dt-71", { root: missing, key: "sl-fix-71-r1", m: 14 }),
			spawned(lane2, "dt-72", { root: missing, key: "sl-fix-72-r1", m: 14 }),
			started(lane3, 30), laneLab(lane3, 31),
			spawned(lane3, "dt-71b", { root: missing, key: "sl-fix-71-r1", m: 32 }),
			settledBy(lane3, "dt-71b", "rt-71b", 33),
			spawned(lane3, "dt-72b", { root: missing, key: "sl-fix-72-r1", m: 34 }),
			settledBy(lane3, "dt-72b", "rt-72b", 35),
		];
		const routings = [
			routing({ kind: "judge", ran_models: JSON.stringify([OPENAI]), session_root: missing, agent_id: "sl-plan-r1" }),
			routing({ session_root: missing, agent_id: "sl-fix-70" }),
			routing({ session_root: missing, agent_id: "sl-fix-71-r1-2" }),
			routing({ session_root: missing, agent_id: "sl-fix-72-r1-2" }),
		];
		expect(builderLabs(view(entries, routings), "wl")).toEqual({ labs: ["anthropic"], unknown: [] });
	});
});

describe("T2: a dead hand counts the models that answered in its session file", () => {
	/** Lane L spawns `dt-dead` (key sl-k) at minute 2; `after` sits between the spawn and the runner's `lane-exit:` of L at minute 50. */
	const killedByExit = (root: string, after: FixtureEntry[] = []) => [
		started(L, 0), laneLab(L, 1), spawned(L, "dt-dead", { root, key: "sl-k", m: 2 }), ...after, exited(L, 50),
	];
	/** Lane L spawns `dt-dead` at minute 2; lane M starts at minute 10 (the death), its builder mark at 11, then `after`. */
	const killedByStart = (root: string, after: FixtureEntry[] = []) => [
		started(L, 0), laneLab(L, 1), spawned(L, "dt-dead", { root, key: "sl-k", m: 2 }), started(M, 10), laneLab(M, 11), ...after,
	];
	const review = (root: string, m: number) => spawned(M, "dt-rev", { root, key: "sl-k", review: true, row: [KIMI], m });
	const live = new Set(["dt-rev"]);

	test("(a) an answering turn counts; an error turn, a malformed line and a user line do not", () => {
		const root = freshRoot();
		session(root, "sl-k", [header(t(3)), userTurn(t(3)), turn(OPENAI, t(4)), turn(KIMI, t(5), "error"), "{not json", ""]);
		expect(builderLabs(view(killedByExit(root)), "wl")).toEqual({ labs: ["anthropic", "openai"], unknown: [] });
	});

	test("(b) a collision: the file a routings row claims is another hand's; the unclaimed -2 file is this one's", () => {
		const root = freshRoot();
		session(root, "sl-k", [header(t(3)), turn(KIMI, t(4))]);
		session(root, "sl-k-2", [header(t(3)), turn(OPENAI, t(4))]);
		const older = routing({ kind: "judge", ran_models: JSON.stringify([KIMI]), session_root: root, agent_id: "sl-k" });
		expect(builderLabs(view(killedByExit(root), [older]), "wl")).toEqual({ labs: ["anthropic", "openai"], unknown: [] });
		const elsewhere = routing({ kind: "judge", ran_models: JSON.stringify([KIMI]), session_root: join(root, "other"), agent_id: "sl-k" });
		expect(builderLabs(view(killedByExit(root), [elsewhere]), "wl").labs).toEqual(["anthropic", "openai", "kimi"]);
	});

	test("(c) only <key>-2.jsonl present: its model counts", () => {
		const root = freshRoot();
		session(root, "sl-k-2", [header(t(3)), turn(KIMI, t(4))]);
		expect(builderLabs(view(killedByExit(root)), "wl")).toEqual({ labs: ["anthropic", "kimi"], unknown: [] });
	});

	test("(d) the window: a successor's review file opened after its spawn, and a file opened before the dead spawn, are not read", () => {
		const root = freshRoot();
		session(root, "sl-k", [header(t(3)), userTurn(t(3)), turn(OPENAI, t(4), "error")]);
		session(root, "sl-k-2", [header(t(13)), turn(KIMI, t(14))]);
		expect(builderLabs(view(killedByStart(root, [review(root, 12)])), "wl", live)).toEqual({ labs: ["anthropic"], unknown: [] });
		const before = freshRoot();
		session(before, "sl-k", [header(t(1)), turn(OPENAI, t(1))]);
		expect(builderLabs(view(killedByStart(before)), "wl")).toEqual({ labs: ["anthropic"], unknown: [] });
	});

	test("(e) a survivor: a file opened before the retirement counts a turn written after the successor's first spawn", () => {
		const root = freshRoot();
		session(root, "sl-k", [header(t(3)), turn(OPENAI, t(20))]);
		expect(builderLabs(view(killedByStart(root, [review(freshRoot(), 12)])), "wl", live)).toEqual({ labs: ["anthropic", "openai"], unknown: [] });
	});

	test("(f) a delayed open: after the successor started but before its first spawn, or with no successor spawn at all, counts", () => {
		const root = freshRoot();
		session(root, "sl-k", [header(t(10.5)), turn(OPENAI, t(10.6))]);
		expect(builderLabs(view(killedByStart(root, [review(freshRoot(), 12)])), "wl", live)).toEqual({ labs: ["anthropic", "openai"], unknown: [] });
		expect(builderLabs(view(killedByStart(root)), "wl")).toEqual({ labs: ["anthropic", "openai"], unknown: [] });
	});

	test("(g) a spawn by the dead hand's own lane after its death entry does not bound the window", () => {
		const root = freshRoot();
		session(root, "sl-k", [header(t(60)), turn(OPENAI, t(61))]);
		const late = [spawned(L, "dt-late", { root: freshRoot(), key: "sl-late", row: ["anthropic/claude-opus-5-5"], m: 55 })];
		expect(builderLabs(view([...killedByExit(root), ...late]), "wl")).toEqual({ labs: ["anthropic", "openai"], unknown: [] });
	});

	test("(h) a late spawn of the old lane after its successor's live review: the review's file is not read through it", () => {
		const root = freshRoot();
		session(root, "sl-k-2", [header(t(14)), turn(KIMI, t(15))]);
		const entries = [
			started(L, 0), laneLab(L, 1), started(M, 10), laneLab(M, 11), review(root, 12),
			spawned(L, "dt-late", { root, key: "sl-k", m: 13 }), exited(L, 20),
		];
		expect(builderLabs(view(entries), "wl", live)).toEqual({ labs: ["anthropic"], unknown: [] });
	});

	test("a file with turns and no session header is not read", () => {
		const root = freshRoot();
		session(root, "sl-k", [turn(OPENAI, t(4))]);
		expect(builderLabs(view(killedByExit(root)), "wl")).toEqual({ labs: ["anthropic"], unknown: [] });
	});
});

describe("T3: which entries kill a hand", () => {
	const hand = entry("hand-spawn: dt-1 session /s/lane spawn sl-x review no group dg-1 row " + STRONG.join(","), "sl-x");
	const labsOf = (entries: FixtureEntry[]) => builderLabs(view(entries), "wl", new Set(), () => []).labs;
	const exit = (lane: string, by: string) => entry(`lane-exit: ${lane} code 0 signal - outcome parked`, null, by);

	test("still live: no exit of its lane and no other lane's start after it, so the whole row counts", () => {
		expect(labsOf([...LANE, hand])).toEqual(["anthropic", "openai", "kimi"]);
		expect(labsOf([...LANE, exit("lane-a", LANE_RUNNER_BY), hand])).toEqual(["anthropic", "openai", "kimi"]); // an exit before the spawn
		expect(labsOf([...LANE, hand, exit("lane-b", LANE_RUNNER_BY)])).toEqual(["anthropic", "openai", "kimi"]); // another lane's exit
		expect(labsOf([...LANE, hand, exit("lane-a", "lane-a")])).toEqual(["anthropic", "openai", "kimi"]); // a lane's forgery
		const forgedStart = [entry('lane-started: lane-b {"pid":2}', null, "lane-b"), entry("builder-lab: anthropic lane lane-b model anthropic/claude-opus-5-5", null, "lane-b")];
		expect(labsOf([...LANE, hand, ...forgedStart])).toEqual(["anthropic", "openai", "kimi"]);
		expect(labsOf([...LANE, hand, entry('lane-started: lane-a {"pid":3}', null, LANE_RUNNER_BY)])).toEqual(["anthropic", "openai", "kimi"]); // its own lane's second start
	});

	test("killed by its lane's exit from the runner or the starter, by position even at the same millisecond", () => {
		expect(labsOf([...LANE, hand, exit("lane-a", LANE_RUNNER_BY)])).toEqual(["anthropic"]);
		expect(labsOf([...LANE, hand, exit("lane-a", LANE_STARTER_BY)])).toEqual(["anthropic"]);
		expect(hand.created_at).toBe(exit("lane-a", LANE_RUNNER_BY).created_at);
		const laneB = [entry('lane-started: lane-b {"pid":2}', null, LANE_RUNNER_BY), entry("builder-lab: anthropic lane lane-b model anthropic/claude-opus-5-5", null, "lane-b")];
		expect(labsOf([...LANE, hand, ...laneB])).toEqual(["anthropic"]);
	});

	test("the reader gets the spawn's root, key, the ids routings claim under that root, and the window", () => {
		const asked: unknown[] = [];
		const reader = (q: unknown) => (asked.push(q), ["mystery/model-x"]);
		const claims = [routing({ kind: "judge", session_root: "/s/lane", agent_id: "sl-x-2" }), routing({ kind: "judge", session_root: "/s/other", agent_id: "sl-x" })];
		const killed = builderLabs(view([...LANE, hand, exit("lane-a", LANE_RUNNER_BY)], claims), "wl", new Set(), reader);
		expect(asked).toEqual([{ root: "/s/lane", key: "sl-x", claimed: new Set(["sl-x-2"]), from: AT, until: null }]);
		expect(killed.unknown).toEqual(["dead hand dt-1 ran on mystery/model-x: unknown lab for provider mystery; add it to classifier/src/lab.ts"]);
		asked.length = 0;
		const successor = [started("lane-b", 5), entry("builder-lab: anthropic lane lane-b model anthropic/claude-opus-5-5", null, "lane-b", t(6)), spawned("lane-b", "dt-2", { root: "/s/lane", key: "sl-y", m: 7 }), settledBy("lane-b", "dt-2", "rt-2", 8)];
		builderLabs(view([...LANE, hand, ...successor]), "wl", new Set(), reader);
		expect(asked).toEqual([{ root: "/s/lane", key: "sl-x", claimed: new Set(), from: AT, until: t(7) }]);
	});
});

describe("D4–D6: reviewPlan", () => {
	const anthropic = { labs: ["anthropic" as const], unknown: [] };

	test("normal stakes: one hand on the labs outside the builders, the allowlist filtered the same way", () => {
		expect(reviewPlan({ row: STRONG, usable: STRONG, builders: anthropic, stakes: "normal", grant: false })).toEqual({
			kind: "single",
			models: STRONG.slice(1),
			allow: STRONG.slice(1),
			excluded: ["anthropic"],
			sameLab: false,
			short: null,
		});
		const two = reviewPlan({ row: STRONG, usable: STRONG, builders: { labs: ["anthropic", "openai"], unknown: [] }, stakes: "normal", grant: false });
		expect(two).toMatchObject({ kind: "single", models: ["moonshot/kimi-k2.7-code"] });
	});

	test("T16: builders that include kimi keep a review off every moonshot model", () => {
		const plan = reviewPlan({ row: STRONG, usable: STRONG, builders: { labs: ["anthropic", "kimi"], unknown: [] }, stakes: "normal", grant: false });
		expect(plan).toEqual({ kind: "single", models: ["openai-codex/gpt-6-sol"], allow: ["openai-codex/gpt-6-sol"], excluded: ["anthropic", "kimi"], sameLab: false, short: null });
	});

	test("filters per lab, not per entry: a row with two entries of one lab keeps both", () => {
		const row = ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "openai/gpt-6", "kimi-code/k3"];
		const plan = reviewPlan({ row, usable: row, builders: { labs: ["anthropic", "kimi"], unknown: [] }, stakes: "normal", grant: false });
		expect(plan).toMatchObject({ kind: "single", models: ["openai-codex/gpt-6-sol", "openai/gpt-6"] });
	});

	test("production: one pinned member per available other lab; one lab left is one hand with a short-fan-out note", () => {
		const plan = reviewPlan({ row: STRONG, usable: STRONG, builders: anthropic, stakes: "production", grant: false });
		expect(plan).toEqual({
			kind: "fanout",
			excluded: ["anthropic"],
			members: [
				{ lab: "openai", models: ["openai-codex/gpt-6-sol"], allow: ["openai-codex/gpt-6-sol"] },
				{ lab: "kimi", models: ["moonshot/kimi-k2.7-code"], allow: ["moonshot/kimi-k2.7-code"] },
			],
		});
		const short = reviewPlan({ row: STRONG, usable: STRONG.slice(0, 2), builders: anthropic, stakes: "production", grant: false, skipped: { [STRONG[2]!]: "no credentials" } });
		expect(short).toMatchObject({ kind: "single", models: ["openai-codex/gpt-6-sol"], short: "production review fans out to openai only (moonshot/kimi-k2.7-code (no credentials))" });
	});

	test("no other lab usable → park, with each entry's reason; unknown provenance and unmapped providers park too", () => {
		const parked = reviewPlan({
			row: STRONG,
			usable: STRONG.slice(0, 1),
			builders: anthropic,
			stakes: "normal",
			grant: false,
			skipped: { [STRONG[1]!]: "no credentials", [STRONG[2]!]: "provider disabled" },
		});
		expect(parked).toEqual({
			kind: "park",
			excluded: ["anthropic"],
			reasons: ["anthropic/claude-opus-5-5 (builder lab anthropic)", "openai-codex/gpt-6-sol (no credentials)", "moonshot/kimi-k2.7-code (provider disabled)"],
		});
		expect(reviewPlan({ row: STRONG, usable: STRONG, builders: { labs: [], unknown: ["x"] }, stakes: "normal", grant: false }).kind).toBe("park");
		const mystery = ["anthropic/claude-opus-5-5", "mystery/model-x"];
		expect(reviewPlan({ row: mystery, usable: mystery, builders: anthropic, stakes: "normal", grant: false })).toMatchObject({
			kind: "park",
			reasons: ["anthropic/claude-opus-5-5 (builder lab anthropic)", "mystery/model-x (unknown lab for provider mystery; add it to classifier/src/lab.ts)"],
		});
	});

	test("REVIEW-r1 #6: a row mixing a usable other lab with an unknown provider parks naming it, at normal and production stakes", () => {
		const row = ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "mystery/model-x"];
		for (const stakes of ["normal", "production"] as const) {
			const plan = reviewPlan({ row, usable: row, builders: anthropic, stakes, grant: false });
			expect({ stakes, plan }).toMatchObject({ stakes, plan: { kind: "park", reasons: expect.arrayContaining(["mystery/model-x (unknown lab for provider mystery; add it to classifier/src/lab.ts)"]) } });
		}
	});

	test("a grant is one hand: the other labs first, then the builder's; with no other lab it is the builder's alone", () => {
		expect(reviewPlan({ row: STRONG, usable: STRONG.slice(0, 2), builders: anthropic, stakes: "production", grant: true })).toMatchObject({
			kind: "single",
			models: ["openai-codex/gpt-6-sol", "anthropic/claude-opus-5-5"],
			allow: ["openai-codex/gpt-6-sol", "moonshot/kimi-k2.7-code", "anthropic/claude-opus-5-5"],
			sameLab: true,
		});
		expect(reviewPlan({ row: STRONG, usable: STRONG.slice(0, 1), builders: anthropic, stakes: "production", grant: true })).toMatchObject({
			kind: "single",
			models: ["anthropic/claude-opus-5-5"],
		});
	});

	test("a pinned member keeps only its lab, and is refused when its lab is gone or became a builder", () => {
		expect(reviewPlan({ row: STRONG, usable: STRONG, builders: anthropic, stakes: null, grant: false, pin: "kimi" })).toMatchObject({ kind: "single", models: ["moonshot/kimi-k2.7-code"] });
		expect(reviewPlan({ row: STRONG, usable: STRONG.slice(0, 2), builders: anthropic, stakes: null, grant: false, pin: "kimi" }).kind).toBe("park");
		expect(reviewPlan({ row: STRONG, usable: STRONG, builders: { labs: ["anthropic", "kimi"], unknown: [] }, stakes: null, grant: false, pin: "kimi" }).kind).toBe("park");
	});
});

describe("reviewRow: Jo's OpenAI-reviewer rule (in-mv5qdfvskukmbk, in-mv5qfm8910ycjk)", () => {
	const TABLE = {
		fast: ["anthropic/claude-haiku-4-5", "openai-codex/gpt-5.6-luna", "moonshot/kimi-k2.7-code-highspeed"],
		standard: ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6-luna", "moonshot/kimi-k2.5"],
		strong: STRONG,
		deep: ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra", "moonshot/kimi-k3"],
	};

	test("the rule names openai, from the strong row", () => {
		expect(REVIEW_ROW_FROM).toEqual({ openai: "strong" });
	});

	test("deep: the openai entry comes from the strong row at its own position; anthropic and kimi stay", () => {
		expect(reviewRow(TABLE, "deep")).toEqual(["anthropic/claude-fable-5-1", "openai-codex/gpt-6-sol", "moonshot/kimi-k3"]);
	});

	test("deep: every openai entry is replaced once, at the first one's position, by the strong row's openai entries, identities de-duplicated", () => {
		const table = {
			...TABLE,
			strong: ["openai-codex/gpt-6-sol", "anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol:high", "openai/gpt-6"],
			deep: ["moonshot/kimi-k3", "openai-codex/gpt-6-astra", "anthropic/claude-fable-5-1", "openai/gpt-6-astra"],
		};
		expect(reviewRow(table, "deep")).toEqual(["moonshot/kimi-k3", "openai-codex/gpt-6-sol", "openai/gpt-6", "anthropic/claude-fable-5-1"]);
	});

	test("deep with no strong openai entry: openai is dropped, never left on astra", () => {
		const table = { ...TABLE, strong: ["anthropic/claude-opus-5-5", "moonshot/kimi-k2.7-code"] };
		expect(reviewRow(table, "deep")).toEqual(["anthropic/claude-fable-5-1", "moonshot/kimi-k3"]);
	});

	test("deep with no openai entry: the row is unchanged", () => {
		const table = { ...TABLE, deep: ["anthropic/claude-fable-5-1", "moonshot/kimi-k3"] };
		expect(reviewRow(table, "deep")).toEqual(["anthropic/claude-fable-5-1", "moonshot/kimi-k3"]);
	});

	test("every other tier returns its row unchanged", () => {
		for (const tier of ["fast", "standard", "strong"] as const) expect(reviewRow(TABLE, tier)).toEqual(TABLE[tier]);
	});
});

describe("D6: reading Jo's answer", () => {
	const parks = [entry("review-park: q-1 slice sl-x", "sl-x")];
	const answer = (over: Partial<{ id: string; kind: "answer" | "withdrawal" | "instruction"; author: string; created_by: string; question_id: string | null; body: string }>) => ({
		id: "in-1",
		kind: "answer" as const,
		author: "jo",
		created_by: SURFACE_BY,
		question_id: "q-1",
		body: "same-lab",
		...over,
	});

	test("only Jo's exact same-lab answer to this slice's park question grants, once", () => {
		expect(unspentGrant(parks, [answer({})], "sl-x")).toBe("in-1");
		expect(unspentGrant(parks, [answer({})], "sl-y")).toBeNull();
		expect(unspentGrant(parks, [answer({ body: "wait" })], "sl-x")).toBeNull();
		expect(unspentGrant(parks, [answer({ kind: "withdrawal" })], "sl-x")).toBeNull();
		expect(unspentGrant(parks, [answer({ author: "lane-a" })], "sl-x")).toBeNull();
		expect(unspentGrant(parks, [answer({ created_by: "lane-mv0-1" })], "sl-x")).toBeNull();
		expect(unspentGrant(parks, [answer({ question_id: "q-other" })], "sl-x")).toBeNull();
		expect(unspentGrant([...parks, entry("review-same-lab: in-1 token dt-1", "sl-x")], [answer({})], "sl-x")).toBeNull();
	});

	test("the park question names the builder's lab, the reasons, and both answers", () => {
		const body = parkQuestionBody("sl-x", { labs: ["anthropic"], unknown: [] }, ["openai-codex/gpt-6-sol (no credentials)", "kimi-code/kimi-for-coding (provider disabled)"]);
		expect(body).toBe(
			"No lab other than the builder's (anthropic) can review sl-x: openai-codex/gpt-6-sol (no credentials), kimi-code/kimi-for-coding (provider disabled). " +
				"**same-lab**: run this one review on anthropic, the builder's lab. " +
				"**wait**: hold the review until another lab is back; the lane retries later and asks again if it is still down.",
		);
	});
});
