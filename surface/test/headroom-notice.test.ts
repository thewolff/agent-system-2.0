import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { headroom, type Headroom } from "../../classifier/src/headroom";
import { Ledger, type MessageRow } from "../../ledger/src/index";
import { consumeLines } from "../src/delivery";
import { errorLines } from "../src/errors";
import { notifyAnthropicWeek } from "../src/headroom-notice";
import { ensureStandingWorkload } from "../src/identity";
import { ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tempLedger, tmp } from "./helpers";

const NOW = Date.parse("2026-10-27T10:00:00.000Z");
const RESET = Date.parse("2026-10-30T10:00:59.900Z");
const WEEK = 7 * 86_400_000;
const snapshot = (used = 0.70, resetsAt = RESET): Pick<Headroom, "anthropicWeek"> => ({ anthropicWeek: { used, resetsAt } });
const messages = (ledger: Ledger): MessageRow[] => ledger.db.query<MessageRow, []>("SELECT * FROM messages ORDER BY created_at, id").all();
const body = (reset = RESET) => `notice: Anthropic 7-day meter 70% used (30% left), resets ${new Date(reset).toISOString()}; weekly pace does not block dispatch; Jo decides whether to change usage.`;

describe("shared Anthropic weekly advisory notice", () => {
	test("no signal or usage below 70% writes nothing, including no standing workload", () => {
		const { ledger } = tempLedger();
		try {
			for (const signal of [{ anthropicWeek: null }, snapshot(0), snapshot(0.6999)]) {
				expect(notifyAnthropicWeek(ledger, { now: NOW, snapshot: signal })).toBeNull();
			}
			expect(ledger.workload(STANDING_WORKLOAD_ID)).toBeNull();
			expect(messages(ledger)).toEqual([]);
			expect(ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM questions").get()!.n).toBe(0);
		} finally { ledger.close(); }
	});

	test("70% queues one unnumbered notice, not a question, and a jump renders observed usage", () => {
		for (const used of [0.70, 0.84]) {
			const { ledger } = tempLedger();
			try {
				const id = notifyAnthropicWeek(ledger, { now: NOW, snapshot: snapshot(used) });
				expect(id).not.toBeNull();
				expect(ledger.message(id!)).toMatchObject({ workload_id: STANDING_WORKLOAD_ID, created_by: SURFACE_BY, sender: SURFACE_BY, recipient: ORCHESTRATOR_RECIPIENT, state: "held" });
				const lines = errorLines(ledger, ledger.inFlight(), { now: new Date(NOW).toISOString() });
				expect(lines).toHaveLength(1);
				expect(lines[0]).toMatchObject({ kind: "notice", rowId: id });
				expect(lines[0]!.n).toBeUndefined();
				expect(lines[0]!.line).toContain(used === 0.70 ? "70% used (30% left)" : "84% used (16% left)");
				expect(lines[0]!.line).toContain("Jo decides whether to change usage.");
				expect(ledger.message(id!)!.body).not.toContain("\n");
				expect(ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM questions").get()!.n).toBe(0);
			} finally { ledger.close(); }
		}
	});

	test("repeated polls, rising usage, dips and actual delivery keep the original durable marker", () => {
		const { ledger } = tempLedger();
		try {
			const id = notifyAnthropicWeek(ledger, { now: NOW, snapshot: snapshot() })!;
			for (const used of [0.70, 0.89, 0.20, 0.75]) expect(notifyAnthropicWeek(ledger, { now: NOW, snapshot: snapshot(used) })).toBeNull();
			expect(consumeLines(ledger, errorLines(ledger))).toBe(1);
			expect(ledger.message(id)!.state).toBe("delivered");
			expect(notifyAnthropicWeek(ledger, { now: NOW, snapshot: snapshot(0.99) })).toBeNull();
			expect(errorLines(ledger)).toEqual([]);
			expect(messages(ledger).map(m => m.id)).toEqual([id]);
		} finally { ledger.close(); }
	});

	test("dedup covers every message delivery state after ledger reopen and a second connection", () => {
		for (const state of ["held", "delivered", "consumed", "acted-on"] as const) {
			const c = clock(new Date(NOW).toISOString());
			const opened = tempLedger(c.now);
			const id = notifyAnthropicWeek(opened.ledger, { now: NOW, snapshot: snapshot() })!;
			for (const step of ["delivered", "consumed", "acted-on"] as const) {
				if (state === "held") break;
				opened.ledger.advanceMessage(id, step, { by: SURFACE_BY });
				if (step === state) break;
			}
			opened.ledger.close();
			const ledger = Ledger.open(opened.path, { backup: false, backupOnOpen: false, clock: c.now });
			const other = Ledger.open(opened.path, { backup: false, backupOnOpen: false, clock: c.now });
			try {
				expect(notifyAnthropicWeek(ledger, { now: NOW, snapshot: snapshot() })).toBeNull();
				expect(notifyAnthropicWeek(other, { now: NOW, snapshot: snapshot(0.90) })).toBeNull();
				expect(messages(ledger)).toHaveLength(1);
				expect(ledger.message(id)!.state).toBe(state);
			} finally { other.close(); ledger.close(); }
		}
	});

	test("reset jitter across a minute boundary and inclusive 60s tolerance dedup; next week notifies again", () => {
		const { ledger } = tempLedger();
		try {
			notifyAnthropicWeek(ledger, { now: NOW, snapshot: snapshot() });
			for (const jitter of [-60_000, -500, 500, 60_000]) expect(notifyAnthropicWeek(ledger, { now: NOW, snapshot: snapshot(0.80, RESET + jitter) })).toBeNull();
			expect(notifyAnthropicWeek(ledger, { now: NOW + WEEK, snapshot: snapshot(0.71, RESET + WEEK) })).not.toBeNull();
			expect(messages(ledger)).toHaveLength(2);
		} finally { ledger.close(); }
	});

	test("only parseable, trusted surface notices on the standing workload can suppress a notice", () => {
		const { ledger } = tempLedger();
		try {
			ensureStandingWorkload(ledger);
			const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "unrelated workload", stakes: "throwaway", mode: "user-driven" });
			const base = { by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sender: SURFACE_BY, recipient: ORCHESTRATOR_RECIPIENT, body: body() };
			for (const over of [
				{ by: "lane-a" }, { sender: "lane-a" }, { recipient: "lane-a" }, { workloadId: wl },
				{ body: body().replace(new Date(RESET).toISOString(), "not-a-date") },
				{ body: `some other notice ${body()}` },
			]) ledger.enqueue({ ...base, ...over });
			const id = notifyAnthropicWeek(ledger, { now: NOW, snapshot: snapshot() });
			expect(id).not.toBeNull();
			expect(ledger.message(id!)!.body).toBe(body());
			expect(notifyAnthropicWeek(ledger, { now: NOW, snapshot: snapshot() })).toBeNull();
		} finally { ledger.close(); }
	});

	test("enqueue failure propagates, rolls back standing rows, and permits a safe retry", () => {
		const { ledger } = tempLedger();
		const enqueue = ledger.enqueue;
		try {
			ledger.enqueue = () => { throw new Error("fixture enqueue failed"); };
			expect(() => notifyAnthropicWeek(ledger, { now: NOW, snapshot: snapshot() })).toThrow("fixture enqueue failed");
			expect(ledger.workload(STANDING_WORKLOAD_ID)).toBeNull();
			expect(messages(ledger)).toEqual([]);
			ledger.enqueue = enqueue;
			expect(notifyAnthropicWeek(ledger, { now: NOW, snapshot: snapshot() })).not.toBeNull();
		} finally { ledger.enqueue = enqueue; ledger.close(); }
	});

	test("real reader excludes missing, stale, future, expired, old-format and non-shared sources", () => {
		const { ledger } = tempLedger();
		const path = join(tmp("headroom-polls"), "polls.jsonl");
		const limit = { provider: "anthropic", windowId: "7d", tier: null, usedFraction: 0.90, resetsAt: RESET };
		const row = { t: NOW / 1000, limits: [limit] };
		try {
			expect(notifyAnthropicWeek(ledger, { now: NOW, path })).toBeNull();
			for (const poll of [
				{ ...row, t: (NOW - 16 * 60_000) / 1000 }, { ...row, t: (NOW + 1_000) / 1000 },
				{ ...row, limits: [{ ...limit, resetsAt: NOW }] }, { ...row, limits: [{ ...limit, resetsAt: null }] },
				{ ...row, limits: [{ ...limit, tier: "fable" }] }, { ...row, limits: [{ ...limit, provider: "openai-codex" }] },
				{ ...row, limits: [{ ...limit, windowId: "5h" }] }, { ...row, limits: [{ ...limit, usedFraction: -1 }] },
				{ t: row.t, rows: { "anthropic/7d": 0.90 } },
			]) {
				writeFileSync(path, JSON.stringify(poll) + "\n");
				expect(headroom({ now: NOW, path }).anthropicWeek).toBeNull();
				expect(notifyAnthropicWeek(ledger, { now: NOW, path })).toBeNull();
			}
			expect(ledger.workload(STANDING_WORKLOAD_ID)).toBeNull();
			expect(messages(ledger)).toEqual([]);
			writeFileSync(path, JSON.stringify(row) + "\n");
			expect(notifyAnthropicWeek(ledger, { now: NOW, path })).not.toBeNull();
		} finally { ledger.close(); }
	});
});
