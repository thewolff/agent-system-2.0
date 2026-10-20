// new guard: no fail-before
//
// sl-rank-tool of wl-mv8k039gvogt8g (PLAN rev 5 § 2 D4, D5; § 3 T7–T11): the `as2_rank` tool (surface/extensions/rank.ts),
// the open-time background ask (surface/extensions/workload.ts), the wake rank line (surface/src/render.ts) and the
// read-only `as2 rank` (surface/scripts/rank.ts). None exists before this slice, so this file fails on its imports until
// the build. Ledgers are real temp ledgers on the real clock (the surface opens its own handle, as in production); the
// judge is a fake that answers the rank questions from the brief's words, as OMP's judge answers on the wire (`noul`).
//
// wl-mv8wzytml878b4 (PLAN rev 5 § 2 D1, D3, D4; § 3 T7–T8 there): Jo's ruled list (`first: [A, B, C]`), the priority
// pause `as2_rank first` writes at cap, and the table's `ruled #k` / `priority-paused` / `priority-pausing` marks. Launch
// order is `order` by default now; the show-only wording is checked on an explicit `jevRank.mode: show` profile.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { ensureStandingWorkload } from "../src/identity";
import { laneExitBody, laneReadyBody } from "../src/launch";
import { rankLines, renderWake } from "../src/render";
import { readingBody } from "../src/orchestrator-question";
import { briefHash, goalsHash, livePins, parseShown, rankOpen, SEED_GOALS, type Shown } from "../src/rank";
import { readRankConfig } from "../src/rank-launch";
import { surfaceSession } from "../src/session";
import { RANK_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, sh, tempLedger, tmp } from "./helpers";

const REPO = join(import.meta.dir, "..", "..");

type Wire = { state: { goals?: string[]; item?: string } | string; questions: Record<string, { type: string; instructions?: string; criteria?: unknown }> };

/**
 * A rank-question answer set on the wire: `HIGH` unblocks Jo, `MID` fixes breakage, `ENFORCER` builds an enforcer and
 * delivers the seed goal, `GOAL` delivers every goal of Jo's, `BAD` throws.
 */
function wireAnswers(req: Wire) {
	const item = typeof req.state === "string" ? req.state : String(req.state.item ?? "");
	const answers: Record<string, unknown> = {};
	for (const [name, q] of Object.entries(req.questions)) {
		if (q.type === "noul") {
			const yes = (name === "unblocks_jo" && item.includes("HIGH")) || (name === "fixes_breakage" && item.includes("MID")) || (name === "builds_enforcer" && item.includes("ENFORCER"));
			answers[name] = { type: "noul", noul: yes ? 0.95 : 0.05 };
		} else if (q.type === "choice") {
			const labels = Object.keys(q.criteria as Record<string, string>);
			answers[name] = { type: "choice", choice: "none", confidence: 0.95, probabilities: Object.fromEntries(labels.map((l) => [l, l === "none" ? 0.95 : 0.05 / (labels.length - 1)])) };
		} else {
			const top = String(q.instructions).includes(SEED_GOALS[0]!) ? item.includes("ENFORCER") : item.includes("GOAL");
			answers[name] = { type: "score", score: top ? 3 : 0, confidence: 0.9, probabilities: top ? { 0: 0.02, 1: 0.03, 2: 0.05, 3: 0.9 } : { 0: 0.9, 1: 0.05, 2: 0.03, 3: 0.02 } };
		}
	}
	return { answers, model: "jev-1.13.0", provider: "typesafe", usage: { input: 900 } };
}

interface FakeJudge {
	asks: { item: string; goals: string[] }[];
	judge: () => Promise<never>;
	factories: () => number;
}

/** The fake judge: every rank ask it took (`item`, `goals`), answering from the brief; `BAD` items throw. */
function fakeJudge(o: { during?: () => void } = {}): FakeJudge {
	const asks: { item: string; goals: string[] }[] = [];
	let factory = 0;
	const judge = {
		judge: async (req: Wire) => {
			const s = typeof req.state === "string" ? { item: req.state } : req.state;
			asks.push({ item: String(s.item ?? ""), goals: [...(s.goals ?? [])] });
			o.during?.();
			if (String(s.item).includes("BAD")) throw new Error("jev offline");
			return wireAnswers(req);
		},
	};
	return { asks, judge: async () => (factory++, judge as never), factories: () => factory };
}

type Role = "orchestrator" | "lane" | "hand";

/** A HOME whose installed profile config (`installedConfigPath`) sets `jevRank.mode`. */
function profileHome(mode: "show" | "order"): string {
	const home = tmp("home");
	const dir = join(home, ".omp", "profiles", "agent-system-2", "agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.yml"), `setupVersion: 2\njevRank:\n  mode: ${mode}\n`);
	return home;
}

/**
 * One ledger and a session of `role` over it with `judge` wired; `call` runs as2_rank. With no `mode` the HOME has no
 * profile (the default launch order); `mode` writes an installed profile with that `jevRank.mode`; `cap` sets the lane cap.
 */
function world(role: Role = "orchestrator", judgeOf: FakeJudge = fakeJudge(), o: { mode?: "show" | "order"; cap?: number } = {}) {
	const { ledger, path } = tempLedger();
	ensureStandingWorkload(ledger);
	const env: Record<string, string> = { AGENT_SYSTEM_ROLE: role === "orchestrator" ? "orchestrator" : "lane", AGENT_SYSTEM_LEDGER_DB: path, HOME: o.mode ? profileHome(o.mode) : "/nonexistent-home" };
	if (o.cap !== undefined) env.AGENT_SYSTEM_MAX_LANES = String(o.cap);
	if (role === "lane") Object.assign(env, { AGENT_SYSTEM_LANE_ID: "lane-r-1" });
	const f = fakePi(undefined, { exec: false });
	orchestratorSurface(f.pi, env, { judge: judgeOf.judge, askTimeoutMs: 2_000 });
	const ctx = role === "hand" ? ctxOf({ hasUI: false, parent: "/sessions/parent.jsonl" }) : ctxOf();
	if (role === "hand") Object.assign(ctx.sessionManager, { getSessionFile: () => "/sessions/artifacts/StrongRankHand.jsonl" });
	const call = async (params: Record<string, unknown> = {}) => {
		const r = await f.tool("as2_rank").execute("1", params, undefined, undefined, ctx);
		return { text: r.content[0]!.text, details: r.details as { items: string[]; shown: string; dropped: string[]; paused: { laneId: string; workloadId: string; forWl: string } | null } | undefined };
	};
	const open = (brief: string) => ledger.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });
	/** An input row of Jo's words, as the surface writes it. */
	const input = (words = "this first") => {
		ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: words, author: "jo", channel: "surface" });
		return ledger.instructions(STANDING_WORKLOAD_ID).at(-1)!.id;
	};
	/** Every row of every kind the ledger holds, as one count per table. */
	const rows = () => ["entries", "instructions", "questions", "workloads", "slices", "messages"].map((t) => ledger.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${t}`).get()!.n);
	const shown = (): (Shown & { id: string })[] =>
		ledger.entries(STANDING_WORKLOAD_ID, "assumption").filter((e) => e.created_by === RANK_BY && e.body.startsWith("rank-shown: ")).map((e) => ({ id: e.id, ...parseShown(e.body)! }));
	const bodies = (wl: string, prefix: string) => ledger.entries(wl, "assumption").filter((e) => e.body.startsWith(prefix)).map((e) => e.body);
	return { ledger, path, env, f, ctx, call, open, input, rows, shown, bodies, judge: judgeOf };
}

const order = (ledger: Ledger) => rankOpen(ledger, new Date().toISOString()).map((i) => i.workloadId);

describe("T7 fill", () => {
	test("each item lacking a current signal gets one ask; a second call asks none; a new workload is asked alone; the returned order is rankOpen's", async () => {
		const w = world();
		const low = w.open("Tidy the README wording");
		const high = w.open("HIGH: stop Jo pasting lane ids by hand");
		const mid = w.open("MID: the wake render crashes on an empty ledger");
		const first = await w.call();
		expect(w.judge.asks).toHaveLength(3);
		expect(w.judge.asks.map((a) => a.item.split("\n")[0]).sort()).toEqual(["HIGH: stop Jo pasting lane ids by hand", "MID: the wake render crashes on an empty ledger", "Tidy the README wording"]);
		expect(first.details!.items).toEqual([high, mid, low]);
		expect(first.details!.items).toEqual(order(w.ledger));
		expect(w.bodies(high, "priority-signal: ")).toHaveLength(1);
		expect(w.bodies(high, "priority-signal: ")[0]).toContain(`brief ${briefHash(w.ledger.workload(high)!.brief)} goals ${goalsHash([])}`);
		// the table: the rows in that order, every term column, the goals line, the weights, the parallel read, and the
		// launch order: `order` with no profile (the default), so no show-only line
		const lines = first.text.split("\n");
		const rowsOf = lines.filter((l) => /^\d+ · wl-/.test(l));
		expect(rowsOf.map((l) => l.split(" · ")[1])).toEqual([high, mid, low]);
		expect(first.text).toContain("goals: none");
		expect(first.text).toContain("weights: goal_max 0.3 · unblocks_jo 0.2 · fixes_breakage 0.15 · urgency 0.2 · cuts_spend 0.15");
		expect(first.text).toContain("parallel read");
		expect(lines.at(-1)).toBe("launch order: order (as2 rank-mode)");
		expect(first.text).not.toContain("show-only");

		await w.call();
		expect(w.judge.asks).toHaveLength(3);
		const late = w.open("A later workload");
		await w.call();
		expect(w.judge.asks).toHaveLength(4);
		expect(w.judge.asks[3]!.item).toStartWith("A later workload");
		expect(order(w.ledger)).toEqual([high, mid, low, late]);
		// refresh re-asks every item
		await w.call({ refresh: "yes" });
		expect(w.judge.asks).toHaveLength(8);
	});

	test("on an explicit jevRank.mode: show profile the table's last line is the show-only line", async () => {
		const w = world("orchestrator", fakeJudge(), { mode: "show" });
		w.open("Tidy the README wording");
		const r = await w.call();
		expect(r.text.split("\n").at(-1)).toBe("show-only: launch order is unchanged (as2 rank-mode)");
	});

	test("the third failure on a (brief, goals) pair stops asks for it; the item is listed unscored as jev failed", async () => {
		const w = world();
		const bad = w.open("BAD brief the judge cannot answer");
		for (let i = 1; i <= 3; i++) {
			const r = await w.call();
			expect(r.text).toContain(`${bad} error: jev offline`);
		}
		expect(w.judge.asks).toHaveLength(3);
		expect(w.bodies(bad, "priority-signal-failed: ").map((b) => / attempt (\d) error /.exec(b)?.[1])).toEqual(["1", "2", "3"]);
		const fourth = await w.call();
		expect(w.judge.asks).toHaveLength(3);
		expect(fourth.text).toContain(`unscored: ${bad} (jev failed)`);
		expect(w.bodies(bad, "priority-signal-failed: ")).toHaveLength(3);
	});

	test("with goals, the asks see the proposed goals and the call's own rank-shown ranks with them", async () => {
		const w = world();
		const high = w.open("HIGH: stop Jo pasting lane ids by hand");
		const goal = w.open("GOAL: ship the ranking work");
		await w.call();
		expect(order(w.ledger)).toEqual([high, goal]); // no goals of Jo's: the seed goal term is 0 for both
		const asked = w.judge.asks.length;
		const goals = ["Ship the ranking work this week"];
		const r = await w.call({ goals, inputId: w.input("rank the ranking work first") });
		expect(w.judge.asks.slice(asked).map((a) => a.goals)).toEqual([[...SEED_GOALS, ...goals], [...SEED_GOALS, ...goals]]);
		const mine = w.shown().at(-1)!;
		expect(mine.by).toBe("orchestrator");
		expect(mine.goals).toBe(goalsHash(goals));
		expect(mine.items.map((i) => i.workloadId)).toEqual([goal, high]);
		expect(r.details!.items).toEqual([goal, high]);
		expect(order(w.ledger)).toEqual([goal, high]);
	});

	test("an item Jev says builds an enforcer ranks first over higher scores, its row flagged; the goals line shows the seed goal", async () => {
		const w = world();
		const high = w.open("HIGH MID: unblocks Jo and fixes the wake");
		const gate = w.open("ENFORCER: a review gate every plan passes");
		const low = w.open("Tidy the README wording");
		const r = await w.call();
		expect(w.judge.asks.map((a) => a.goals)).toEqual([[...SEED_GOALS], [...SEED_GOALS], [...SEED_GOALS]]);
		expect(r.details!.items).toEqual([gate, high, low]);
		const rowsOf = r.text.split("\n").filter((l) => /^\d+ · wl-/.test(l));
		expect(rowsOf[0]).toContain(`1 · ${gate} · autonomous/waiting · - · `);
		expect(rowsOf[0]).toContain(" · enforcer: ranks first · ENFORCER: a review gate every plan passes");
		expect(rowsOf[1]).toContain(` · - · HIGH MID: unblocks Jo and fixes the wake`);
		expect(r.text).toContain(`goals: none (only the seed goals weigh; seed goal, asked first and never stale: "${SEED_GOALS[0]}"`);
	});
});

describe("T8 Jo receipt", () => {
	test("goals, first or unpin with no input, a non-input, or a spent input: refused, no row of any kind written, no judge call", async () => {
		const w = world();
		const wl = w.open("HIGH: unscored so far");
		const spent = w.input("this first");
		const r = await w.f.tool("orchestrator_record_instruction").execute("1", { workloadId: wl, inputId: spent, reading: "do this first" }, undefined, undefined, w.ctx);
		expect(r.content[0]!.text).toStartWith("Recorded instruction");
		const before = w.rows();
		for (const params of [{ goals: ["Ship it"] }, { first: wl }, { first: wl, inputId: "in-nope" }, { goals: ["Ship it"], inputId: spent }, { first: wl, inputId: spent }, { inputId: w.input("x") }]) {
			const res = await w.call(params);
			expect(res.text).toStartWith("Refused: ");
			expect(res.text).toContain("Nothing was written and Jev was not asked.");
		}
		// the one input row the loop typed is the only new row
		expect(w.rows()).toEqual([before[0], before[1]! + 1, ...before.slice(2)]);
		expect(w.judge.asks).toEqual([]);
		expect(w.judge.factories()).toBe(0);
	});

	test("on a lane session and a hand session Jo's parameters are refused with nothing written and no judge call", async () => {
		for (const role of ["lane", "hand"] as const) {
			const w = world(role);
			const wl = w.open("HIGH: unscored so far");
			const inputId = w.input("goals: ship it");
			const before = w.rows();
			for (const params of [{ goals: ["Ship it"], inputId }, { first: wl, inputId }, { unpin: wl, inputId }]) {
				const res = await w.call(params);
				expect(res.text).toStartWith("Refused: goals, first and unpin are Jo's words, recorded only by the orchestrator");
			}
			expect(w.rows()).toEqual(before);
			expect(w.judge.asks).toEqual([]);
		}
	});

	test("a fresh input with goals and first: every row in one transaction, the input spent once, then refused by as2_rank and by orchestrator_record_instruction", async () => {
		const w = world();
		const a = w.open("HIGH: stop Jo pasting lane ids by hand");
		const b = w.open("Tidy the README wording");
		const inputId = w.input("ship the ranking; the README first");
		// count the surface handle's outermost write transactions, and which one each row landed in
		const handle = surfaceSession(w.ctx, w.env).ledger();
		const write = handle.write.bind(handle);
		const recordEntry = handle.recordEntry.bind(handle);
		let depth = 0;
		let outer = 0;
		const landed: number[] = [];
		Object.assign(handle, {
			write: <T>(fn: () => T): T => {
				if (depth++ === 0) outer++;
				try {
					return write(fn);
				} finally {
					depth--;
				}
			},
			recordEntry: (...args: Parameters<Ledger["recordEntry"]>) => (landed.push(depth > 0 ? outer : -1), recordEntry(...args)),
		});
		const r = await w.call({ goals: ["Ship the ranking work"], first: b, inputId });
		expect(r.text).toContain(`Jo's input ${inputId} spent`);
		// every row in one outer transaction (the priority-pause check after it opens its own and, below cap, writes nothing)
		expect(new Set(landed).size).toBe(1);
		expect(landed[0]).toBeGreaterThan(0);
		const control = w.ledger.entries(STANDING_WORKLOAD_ID, "assumption").map((e) => e.body.split(":")[0]);
		expect(control.slice(-5)).toEqual(["rank-goals", "rank-shown", "rank-override", "rank-shown", "reading"]);
		expect(w.bodies(a, "priority-signal: ")).toHaveLength(1);
		expect(w.bodies(b, "priority-signal: ")).toHaveLength(1);
		// 2 signals + goals + pick + override + shown + reading
		expect(landed).toHaveLength(7);
		const readings = w.bodies(STANDING_WORKLOAD_ID, "reading: ").filter((x) => x.includes(inputId));
		expect(readings).toEqual([readingBody(`as2_rank rank goals: "Ship the ranking work"; ${b} first (a pin)`, inputId, b)]);
		// spent: as2_rank and orchestrator_record_instruction both refuse it now
		const before = w.rows();
		expect((await w.call({ unpin: b, inputId })).text).toContain(`${inputId} already instructed ${b}`);
		const ri = await w.f.tool("orchestrator_record_instruction").execute("1", { workloadId: a, inputId, reading: "again" }, undefined, undefined, w.ctx);
		expect(ri.content[0]!.text).toContain(`${inputId} already instructed ${b}, and one input is recorded once`);
		expect(w.rows()).toEqual(before);
	});

	test("an input spent between the fill and the transaction aborts the transaction with nothing written", async () => {
		let spend: (() => void) | null = null;
		const judge = fakeJudge({ during: () => spend?.() });
		const w = world("orchestrator", judge);
		const a = w.open("HIGH: stop Jo pasting lane ids by hand");
		const inputId = w.input("a first");
		spend = () => {
			w.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: readingBody("elsewhere", inputId, a) });
			spend = null;
		};
		const before = w.rows();
		const r = await w.call({ first: a, inputId });
		expect(judge.asks).toHaveLength(1);
		expect(r.text).toStartWith(`Refused: ${inputId} was spent on ${a} while Jev was asked`);
		// only the racing reading entry landed: no signal, no pick, no pin, no rank-shown
		expect(w.rows()).toEqual([before[0]! + 1, ...before.slice(1)]);
		expect(livePins(w.ledger)).toEqual([]);
		expect(w.bodies(a, "priority-signal")).toEqual([]);
	});
});

describe("T8b pins", () => {
	test("first on the item Jev ranks last puts it at #1 in the same reply and after; the pick snapshot is Jev's unpinned waiting order; unpin drops it in the same reply", async () => {
		const w = world();
		const high = w.open("HIGH: stop Jo pasting lane ids by hand");
		const mid = w.open("MID: the wake render crashes");
		const low = w.open("Tidy the README wording");
		await w.call();
		expect(order(w.ledger)).toEqual([high, mid, low]);
		const pinIn = w.input(`${low} first`);
		const r = await w.call({ first: low, inputId: pinIn });
		expect(r.details!.items).toEqual([low, high, mid]);
		expect(r.text.split("\n").find((l) => l.startsWith("1 · "))).toContain(`${low} · autonomous/waiting · ruled #1 (Jo, ${pinIn})`);
		expect(order(w.ledger)).toEqual([low, high, mid]);
		const [pick, mine] = w.shown().slice(-2);
		expect(pick!.by).toBe("pick");
		expect(pick!.items.map((i) => [i.workloadId, i.pinned])).toEqual([[high, false], [mid, false], [low, false]]);
		expect(mine!.items.map((i) => [i.workloadId, i.pinned])).toEqual([[low, true], [high, false], [mid, false]]);
		expect(w.bodies(STANDING_WORKLOAD_ID, "rank-override: ")).toEqual([`rank-override: ${low} input ${pinIn} shown ${pick!.id}`]);

		// two pins: newest first
		const second = w.input(`${mid} first`);
		expect((await w.call({ first: mid, inputId: second })).details!.items).toEqual([mid, low, high]);
		// unpin: the reply already shows it gone
		const unpinIn = w.input(`drop the pin on ${mid}`);
		const u = await w.call({ unpin: mid, inputId: unpinIn });
		expect(u.details!.items).toEqual([low, high, mid]);
		expect(w.bodies(STANDING_WORKLOAD_ID, "rank-unpin: ")).toEqual([`rank-unpin: ${mid} input ${unpinIn}`]);
		// a pin ends with its workload
		w.ledger.closeWorkload(low, { by: SURFACE_BY });
		expect(livePins(w.ledger)).toEqual([]);
		expect(order(w.ledger)).toEqual([high, mid]);
		// unpin with no live pin is refused
		expect((await w.call({ unpin: high, inputId: w.input("unpin it") })).text).toStartWith(`Refused: ${high} has no live pin to drop`);
	});
});

describe("T9 registration", () => {
	test("as2_rank registers on orchestrator, lane and hand sessions alike; each call writes its own rank-shown by", async () => {
		const byOf: Record<Role, string> = { orchestrator: "orchestrator", lane: "lane-r-1", hand: "hand:StrongRankHand" };
		for (const role of ["orchestrator", "lane", "hand"] as const) {
			const w = world(role);
			const wl = w.open("HIGH: stop Jo pasting lane ids by hand");
			expect(w.f.registered()).toContain("as2_rank");
			const r = await w.call();
			expect(r.details!.items).toEqual([wl]);
			expect(w.shown().map((s) => s.by)).toEqual([byOf[role]]);
			expect(w.bodies(wl, "priority-signal: ")).toHaveLength(1);
		}
	});
});

describe("T10 wake line and CLI", () => {
	test("the wake line and as2 rank show the tool's top 3 over one fixture ledger in the default order mode; neither asks a judge nor writes", async () => {
		const w = world();
		const wls = [w.open("Tidy the README wording"), w.open("HIGH: stop Jo pasting lane ids by hand"), w.open("MID: the wake render crashes"), w.open("HIGH MID: both at once")];
		const r = await w.call();
		const top3 = r.details!.items.slice(0, 3);
		expect(top3).toEqual([wls[3], wls[1], wls[2]]);
		const asked = w.judge.asks.length;
		const factories = w.judge.factories();
		const before = w.rows();
		const rankRows = () => w.ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM entries WHERE body LIKE 'priority-signal%' OR body LIKE 'rank-%'").get()!.n;
		const rankBefore = rankRows();

		const now = new Date().toISOString();
		// no profile: the launch order is `order`, so neither the wake line nor the CLI says show-only
		expect(readRankConfig(w.env).mode).toBe("order");
		const [line] = rankLines(w.ledger, now, readRankConfig(w.env).mode);
		expect(line).toStartWith("Rank (Jev, ");
		expect(line).not.toContain("show-only");
		expect([...line!.matchAll(/\b(\d) (wl-\S+)/g)].map((m) => m[2])).toEqual(top3);
		expect(line).toContain("; 0 unscored; goals none; as2_rank for the table");
		expect(renderWake(w.ledger, { holdHours: 24, now, rankMode: "order" }).text).toContain(line!);

		const cliIn = (home: string) => sh(["bun", join(REPO, "surface", "scripts", "rank.ts"), "--top", "3"], REPO, { PATH: process.env.PATH ?? "", HOME: home, AGENT_SYSTEM_LEDGER_DB: w.path });
		const cli = cliIn(tmp("home"));
		expect(cli.code).toBe(0);
		const cliRows = cli.out.split("\n").filter((l) => /^\d+ · wl-/.test(l)).map((l) => l.split(" · ")[1]);
		expect(cliRows).toEqual(top3);
		expect(cli.out).toContain("fill: none (read-only");
		expect(cli.out.split("\n").at(-1)).toBe("launch order: order (as2 rank-mode)");
		expect(cli.out).not.toContain("show-only");
		// an explicit jevRank.mode: show profile keeps the show-only wording, in the CLI and in the wake line
		expect(cliIn(profileHome("show")).out.split("\n").at(-1)).toBe("show-only: launch order is unchanged (as2 rank-mode)");
		expect(rankLines(w.ledger, now, "show")[0]).toStartWith("Rank (Jev, show-only): 1 ");
		expect(w.rows()).toEqual(before);

		// the orchestrator's own wake carries the same line
		await w.f.emit("session_start", { type: "session_start" }, w.ctx);
		const started = (await w.f.emit("before_agent_start", { prompt: "status", systemPrompt: ["base"] }, w.ctx)) as { messages: { content: string }[] };
		expect(started.messages[0]!.content).toContain(line!);

		expect(w.judge.asks).toHaveLength(asked);
		expect(w.judge.factories()).toBe(factories);
		// the wake writes its own surface bookkeeping, but no rank row: no signal, failure, goals, shown, pin or audit
		expect(rankRows()).toBe(rankBefore);
	});

	test("an unscored item: the wake line and the CLI list it unscored, with its reason in the CLI", () => {
		const w = world();
		const wl = w.open("Never asked");
		const now = new Date().toISOString();
		expect(rankLines(w.ledger, now, "show")).toEqual([`Rank (Jev, show-only): 1 ${wl} Never asked (unscored); 1 unscored; goals none; as2_rank for the table`]);
		const cli = sh(["bun", join(REPO, "surface", "scripts", "rank.ts")], REPO, { PATH: process.env.PATH ?? "", HOME: tmp("home"), AGENT_SYSTEM_LEDGER_DB: w.path });
		expect(cli.code).toBe(0);
		expect(cli.out).toContain(`unscored: ${wl} (no signal)`);
		expect(sh(["bun", join(REPO, "surface", "scripts", "rank.ts"), "--top", "x"], REPO, { PATH: process.env.PATH ?? "", HOME: tmp("home"), AGENT_SYSTEM_LEDGER_DB: w.path }).code).toBe(1);
	});
});

/** The cells of the table row (tool or CLI) for `wl`: `[n, wl, mode/state, ruled, score, …]`. */
const rowOf = (table: string, wl: string): string[] => table.split("\n").find((l) => /^\d+ · wl-/.test(l) && l.split(" · ")[1] === wl)!.split(" · ");

describe("wl-mv8wzytml878b4 T7 ruled list (D1)", () => {
	test("first: [A, B, C] with one input puts A, B, C at #1–#3 above Jev's order, one override per item with its pos; the input is spent once", async () => {
		const w = world();
		const high = w.open("HIGH: stop Jo pasting lane ids by hand");
		const mid = w.open("MID: the wake render crashes");
		const low = w.open("Tidy the README wording");
		const both = w.open("HIGH MID: both at once");
		await w.call();
		expect(order(w.ledger)).toEqual([both, high, mid, low]);
		const inputId = w.input(`${low}, then ${mid}, then ${high}`);
		const r = await w.call({ first: [low, mid, high], inputId });
		expect(r.details!.items).toEqual([low, mid, high, both]);
		expect(order(w.ledger)).toEqual([low, mid, high, both]);
		expect([low, mid, high, both].map((wl) => rowOf(r.text, wl).slice(0, 4))).toEqual([
			["1", low, "autonomous/waiting", `ruled #1 (Jo, ${inputId})`],
			["2", mid, "autonomous/waiting", `ruled #2 (Jo, ${inputId})`],
			["3", high, "autonomous/waiting", `ruled #3 (Jo, ${inputId})`],
			["4", both, "autonomous/waiting", "-"],
		]);
		const pick = w.shown().at(-2)!;
		expect(pick.by).toBe("pick");
		expect(w.bodies(STANDING_WORKLOAD_ID, "rank-override: ")).toEqual([low, mid, high].map((wl, k) => `rank-override: ${wl} input ${inputId} shown ${pick.id} pos ${k + 1}`));
		expect(w.bodies(STANDING_WORKLOAD_ID, "rank-unpin: ")).toEqual([]);
		expect(w.bodies(STANDING_WORKLOAD_ID, "reading: ").filter((x) => x.includes(inputId))).toEqual([readingBody(`as2_rank ruled order ${low} > ${mid} > ${high} (pins #1-#3)`, inputId, low)]);
		// spent: a second ruling on the same input is refused with nothing written
		const before = w.rows();
		expect((await w.call({ first: [high, low], inputId })).text).toContain(`${inputId} already instructed ${low}`);
		expect(w.rows()).toEqual(before);
		expect(order(w.ledger)).toEqual([low, mid, high, both]);
	});

	test("a later list replaces the ruling (the dropped are unpinned in the same call); a single first without pos sits above it", async () => {
		const w = world();
		for (const t of ["A work", "B work", "C work", "D work"]) w.open(t);
		await w.call();
		// equal scores: Jev's order is age, then id, and the opens may share a millisecond, so name them by that order
		const [a, b, c, d] = order(w.ledger) as [string, string, string, string];
		await w.call({ first: [c, b, a], inputId: w.input("c, b, a") });
		expect(order(w.ledger)).toEqual([c, b, a, d]);
		const second = w.input("d then c");
		const r = await w.call({ first: [d, c], inputId: second });
		expect(r.details!.items).toEqual([d, c, a, b]);
		expect(r.details!.dropped).toEqual([b, a]);
		expect(w.bodies(STANDING_WORKLOAD_ID, "rank-unpin: ")).toEqual([`rank-unpin: ${b} input ${second}`, `rank-unpin: ${a} input ${second}`]);
		expect(livePins(w.ledger).map((p) => [p.workloadId, p.pos])).toEqual([[d, 1], [c, 2]]);
		expect(w.bodies(STANDING_WORKLOAD_ID, "reading: ").filter((x) => x.includes(second))).toEqual([readingBody(`as2_rank ruled order ${d} > ${c} (pins #1-#2; dropped the pins on ${b}, ${a})`, second, d)]);
		// a single first: no pos, no unpin, above the standing list
		const single = w.input("b first");
		const s = await w.call({ first: b, inputId: single });
		expect(s.details!.items).toEqual([b, d, c, a]);
		expect(w.bodies(STANDING_WORKLOAD_ID, "rank-override: ").at(-1)).toMatch(new RegExp(`^rank-override: ${b} input ${single} shown en-\\S+$`));
		expect(w.bodies(STANDING_WORKLOAD_ID, "rank-unpin: ")).toHaveLength(2);
		expect([b, d, c, a].map((wl) => rowOf(s.text, wl)[3])).toEqual([`ruled #1 (Jo, ${single})`, `ruled #2 (Jo, ${second})`, `ruled #3 (Jo, ${second})`, "-"]);
	});

	test("an empty list, a repeated item, a blank item, a closed workload, or a list with unpin: refused, nothing written, no judge call", async () => {
		const w = world();
		const a = w.open("A work");
		const b = w.open("B work");
		const closed = w.open("Closed work");
		w.ledger.closeWorkload(closed, { by: SURFACE_BY });
		const inputId = w.input("the order");
		const before = w.rows();
		const cases: [Record<string, unknown>, string][] = [
			[{ first: [], inputId }, "Refused: first is an empty list"],
			[{ first: [a, b, a], inputId }, `Refused: ${a} is listed twice in first`],
			[{ first: [a, " "], inputId }, "Refused: first's item 2 is not a workload id"],
			[{ first: [a, closed], inputId }, `Refused: ${closed} is closed`],
			[{ first: [a, b], unpin: a, inputId }, "Refused: one call pins or unpins, not both"],
		];
		for (const [params, why] of cases) expect((await w.call(params)).text).toStartWith(why);
		expect(w.rows()).toEqual(before);
		expect(w.judge.asks).toEqual([]);
	});
});

describe("wl-mv8wzytml878b4 T8 priority pause from as2_rank, and the table marks (D3, D4)", () => {
	/** `lane` runs `wl`: its `launch:`, a live claim, and the runner's `lane-ready:`. */
	const runLane = (ledger: Ledger, wl: string, lane: string) => {
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: `launch: ${lane} cause first requested-by test` });
		expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: lane, leaseMs: 600_000 }).won).toBe(true);
		ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneReadyBody(lane, ledger.now()) });
	};
	/** `as2 rank` over the world's ledger, with its HOME (and so its installed profile). */
	const cli = (w: { env: Record<string, string>; path: string }) => sh(["bun", join(REPO, "surface", "scripts", "rank.ts")], REPO, { PATH: process.env.PATH ?? "", HOME: w.env.HOME!, AGENT_SYSTEM_LEDGER_DB: w.path });

	test("order mode, cap 1: first on a workload refused only by cap writes the priority stop in the same call; the table and as2 rank show priority-pausing, then priority-paused", async () => {
		const w = world("orchestrator", fakeJudge(), { mode: "order", cap: 1 });
		const low = w.open("Tidy the README wording");
		const lane = "lane-low-1";
		runLane(w.ledger, low, lane);
		const x = w.open("MID: the wake render crashes");
		const inputId = w.input(`${x} first`);
		const r = await w.call({ first: x, inputId });
		const stop = `lane-stop: ${lane} requested priority-for-${x} by rank`;
		expect(w.bodies(low, "lane-stop: ")).toEqual([stop]);
		expect(r.details!.paused).toEqual({ laneId: lane, workloadId: low, forWl: x });
		expect(r.text.split("\n").at(-1)).toBe(`priority-pausing ${lane} on ${low} for ${x}`);
		expect(rowOf(r.text, x).slice(0, 4)).toEqual(["1", x, "autonomous/waiting", `ruled #1 (Jo, ${inputId})`]);
		expect(rowOf(r.text, low).slice(2, 4)).toEqual([`autonomous/running; priority-pausing for ${x}`, "-"]);
		expect(rowOf(cli(w).out, low)[2]).toBe(`autonomous/running; priority-pausing for ${x}`);

		// the runner accepts the stop and exits with its reason, then releases: priority-paused, in the tool and in as2 rank
		const request = w.ledger.entries(low, "assumption").find((e) => e.body === stop)!;
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: low, kind: "assumption", body: `lane-stop: ${lane} accepted ${request.id}` });
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: low, kind: "assumption", body: laneExitBody(lane, { code: 0, signal: null, outcome: "stop", reason: `priority-for-${x}` }) });
		w.ledger.releaseWorkload(low, { by: LANE_RUNNER_BY, holder: lane });
		const after = await w.call();
		expect(after.details!.paused).toBeNull();
		expect(rowOf(after.text, low).slice(2, 4)).toEqual([`autonomous/waiting; priority-paused for ${x}`, "-"]);
		const out = cli(w).out;
		expect(rowOf(out, low)[2]).toBe(`autonomous/waiting; priority-paused for ${x}`);
		expect(rowOf(out, x)[3]).toBe(`ruled #1 (Jo, ${inputId})`);
	});

	test("below cap, or on an explicit jevRank.mode: show profile at cap, the same first writes no stop and the reply names no pause", async () => {
		for (const o of [{ mode: "order" as const, cap: 2 }, { mode: "show" as const, cap: 1 }]) {
			const w = world("orchestrator", fakeJudge(), o);
			const low = w.open("Tidy the README wording");
			runLane(w.ledger, low, "lane-low-1");
			const x = w.open("MID: the wake render crashes");
			const r = await w.call({ first: x, inputId: w.input(`${x} first`) });
			expect({ o, stops: w.bodies(low, "lane-stop: "), paused: r.details!.paused }).toEqual({ o, stops: [], paused: null });
			expect(r.text).not.toContain("priority-paus");
		}
	});
});

describe("T11 open", () => {
	const OPEN = { brief: "HIGH: stop Jo pasting lane ids by hand", stakes: "normal", done: "it is done" };
	const KINDS = ["locate", "understand", "change-small", "change-large", "judge"];
	const SIZED = { answers: { kind: { choice: "change-large", confidence: 0.9, probabilities: Object.fromEntries(KINDS.map((k) => [k, k === "change-large" ? 0.9 : 0.025])) } }, provider: "typesafe", model: "jev" };

	/** A surface whose judge answers the sizing ask at once and each rank ask with `rank`; `written` resolves with the first rank row the surface writes. */
	function opener(rank: (req: Wire) => Promise<unknown>) {
		const { ledger, path } = tempLedger();
		const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, HOME: "/nonexistent-home" };
		const rankAsks: Wire[] = [];
		const judge = {
			judge: (req: Wire) => {
				if ("kind" in req.questions) return Promise.resolve(SIZED);
				rankAsks.push(req);
				return rank(req);
			},
		};
		const f = fakePi(undefined, { exec: false });
		orchestratorSurface(f.pi, env, { judge: async () => judge as never });
		const ctx = ctxOf();
		const handle = surfaceSession(ctx, env).ledger();
		const recordEntry = handle.recordEntry.bind(handle);
		const written = Promise.withResolvers<string>();
		Object.assign(handle, {
			recordEntry: (...args: Parameters<Ledger["recordEntry"]>) => {
				const id = recordEntry(...args);
				if (args[0].body.startsWith("priority-signal")) written.resolve(args[0].body);
				return id;
			},
		});
		const open = async () => {
			const r = await f.tool("orchestrator_open_workload").execute("1", OPEN, undefined, undefined, ctx);
			return { id: (r.details as { id: string }).id, text: r.content[0]!.text };
		};
		return { ledger, rankAsks, open, written: written.promise };
	}

	test("opening a workload starts one background ask and its signal is written on its own", async () => {
		const o = opener(async (req) => wireAnswers(req));
		const r = await o.open();
		expect(r.text).toStartWith(`Opened ${r.id}`);
		expect(await o.written).toStartWith("priority-signal: ");
		expect(o.rankAsks).toHaveLength(1);
		const signals = o.ledger.entries(r.id, "assumption").filter((e) => e.body.startsWith("priority-signal: "));
		expect(signals.map((e) => e.created_by)).toEqual([RANK_BY]);
		expect(rankOpen(o.ledger, new Date().toISOString())[0]).toMatchObject({ workloadId: r.id, score: expect.any(Number) });
	});

	test("a judge that throws does not fail the open; its failure is a failure row", async () => {
		const o = opener(async () => {
			throw new Error("jev offline");
		});
		const r = await o.open();
		expect(r.text).toStartWith(`Opened ${r.id}`);
		expect(await o.written).toMatch(/^priority-signal-failed: .* attempt 1 error /);
		expect(o.rankAsks).toHaveLength(1);
	});

	test("a judge that hangs does not delay the open: it returns with the ask still pending, and the ask's end is written later", async () => {
		const hang = Promise.withResolvers<never>();
		const o = opener(() => hang.promise);
		const r = await o.open();
		expect(r.text).toStartWith(`Opened ${r.id}`);
		expect(o.rankAsks).toHaveLength(1);
		expect(o.ledger.entries(r.id, "assumption").filter((e) => e.body.startsWith("priority-signal"))).toEqual([]);
		hang.reject(new Error("released"));
		expect(await o.written).toMatch(/^priority-signal-failed: .* attempt 1 error /);
	});
});
