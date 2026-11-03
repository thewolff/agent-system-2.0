// Ilex → sender (PLAN wl-mv8vx7wdj5nx1c rev 6, D4; § Tests T10, T11): `orchestrator_reply` writes a seat-mailbox
// envelope from Ilex into a configured sender's inbox in the registry's own writer format, records `channel-out:`, and
// walks each `re` message to acted-on through every legal state; `orchestrator_channel_done` walks without a reply.
// Any `re` id that is not a configured sender's channel row on the standing workload (for a reply: not `to`'s own),
// and any unconfigured `to`, refuses the whole call with nothing written or sent. Driven through the real surface
// (surface/index.ts) on the fake extension API, a temp ledger, a temp profile config and a temp mailbox root. Every
// module this file imports exists on origin/main; a tree without the tools fails on the `registered` assertion.
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import orchestratorSurface from "../index";
import { ensureStandingWorkload } from "../src/identity";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, tempLedger, tmp } from "./helpers";

const CONFIG =
	"setupVersion: 2\nchannel:\n  senders:\n    - { id: plumb, transport: omp-mailbox, authority: notes }\n    - { id: juno, transport: omp-mailbox, authority: notes }\n";
const REPLY = "orchestrator_reply";
const DONE = "orchestrator_channel_done";
/** The registry's writer id grammar (persistent-seat-registry.ts PERSISTENT_SEAT_MESSAGE_ID_PATTERN). */
const ENVELOPE_ID = /^[0-9]+-[0-9a-f-]+$/i;
const newId = () => `${Date.now()}-${randomUUID()}`;

type Row = { id: string; state: string; rev: number; changed_by: string };

/** Every file under `root`, as a sorted list of relative paths. */
function tree(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else out.push(relative(root, p));
		}
	};
	walk(root);
	return out.sort();
}

/** A started orchestrator surface with plumb and juno configured, over a fresh ledger and mailbox root. */
async function surface() {
	const { ledger, path } = tempLedger();
	const home = tmp("channel-reply-home");
	const dir = join(home, ".omp", "profiles", "agent-system-2", "agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.yml"), CONFIG);
	const root = tmp("channel-reply-mailbox");
	const voice = join(tmp("channel-reply-voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_VOICE: voice, HOME: home, OMP_PERSISTENT_SEAT_MAILBOX_ROOT: root };
	const f = fakePi();
	orchestratorSurface(f.pi, env);
	const ctx = ctxOf();
	ensureStandingWorkload(ledger);
	await f.emit("session_start", { type: "session_start" }, ctx);
	/** A tool call; the tool must be registered (on a tree without it this fails here, by assertion). */
	const call = async (name: string, params: Record<string, unknown>): Promise<{ text: string; details: unknown }> => {
		expect(f.registered()).toContain(name);
		const r = await f.tool(name).execute("1", params, undefined, undefined, ctx);
		return { text: r.content[0]!.text, details: r.details };
	};
	/** A channel row as the drain records one (`msg-ch-<id>`, created_by `channel:<sender>`), advanced to `state`. */
	const channelRow = (sender: string, state: "held" | "delivered" | "consumed" | "acted-on" = "held", over: { workloadId?: string; by?: string } = {}): string => {
		const id = `msg-ch-${newId()}`;
		const by = over.by ?? `channel:${sender}`;
		ledger.enqueue({ by, id, workloadId: over.workloadId ?? STANDING_WORKLOAD_ID, sender, recipient: "orchestrator", body: `channel-note from ${sender}:\nhello` });
		for (const s of ["delivered", "consumed", "acted-on"] as const) {
			if (ledger.message(id)!.state === state) break;
			ledger.advanceMessage(id, s, { by });
		}
		return id;
	};
	const row = (id: string): Row => ledger.db.query<Row, [string]>("SELECT id, state, rev, changed_by FROM messages WHERE id = ?").get(id)!;
	/** Everything a refused call must leave as it is: every row of every table that the tools could touch, and the mailbox. */
	const snapshot = () => ({
		messages: ledger.db.query("SELECT * FROM messages ORDER BY rowid").all(),
		entries: ledger.db.query("SELECT * FROM entries ORDER BY rowid").all(),
		instructions: ledger.db.query("SELECT * FROM instructions ORDER BY rowid").all(),
		mailbox: tree(root),
	});
	const outEntries = () => ledger.entries(STANDING_WORKLOAD_ID, "assumption").filter((e) => e.body.startsWith("channel-out:"));
	/**
	 * Plumb's drain, as the registry runs it beside the reply: ack every published envelope in `inbox/<slug>/`. A real
	 * interval on purpose: the tool polls for the ack against the wall clock (the registry's `waitForFile`), so the ack
	 * has to land while that loop runs, as another process's would.
	 */
	const acker = (slug: string) => {
		const inbox = join(root, "inbox", slug);
		const timer = setInterval(() => {
			if (!existsSync(inbox)) return;
			for (const name of readdirSync(inbox)) {
				if (!name.endsWith(".json")) continue;
				const e = JSON.parse(readFileSync(join(inbox, name), "utf8"));
				mkdirSync(join(root, "acks"), { recursive: true });
				const ack = join(root, "acks", `${e.id}.json`);
				if (!existsSync(ack)) writeFileSync(ack, `${JSON.stringify({ id: e.id, from: e.from, to: e.to, deliveredAt: new Date().toISOString() })}\n`);
			}
		}, 20);
		return () => clearInterval(timer);
	};
	return { ledger, root, env, f, ctx, call, channelRow, row, snapshot, outEntries, acker };
}

/** The registry's own envelope checks (`isPersistentSeatMessageEnvelope`, `validateInboundEnvelope`) on a published file. */
function expectRegistryEnvelope(dir: string, name: string): { id: string; from: string; to: string; message: string; createdAt: string } {
	const bytes = readFileSync(join(dir, name), "utf8");
	const e = JSON.parse(bytes);
	expect(Object.keys(e).sort()).toEqual(["createdAt", "from", "id", "message", "to"]);
	for (const k of ["id", "from", "to", "message", "createdAt"]) expect(typeof e[k]).toBe("string");
	expect(ENVELOPE_ID.test(e.id)).toBe(true);
	expect(name).toBe(`${e.id}.json`);
	expect(e.message.trim().length).toBeGreaterThan(0);
	expect("schemaVersion" in e).toBe(false);
	expect(Number.isNaN(Date.parse(e.createdAt))).toBe(false);
	// writeJsonAtomically's bytes: one JSON line.
	expect(bytes).toBe(`${JSON.stringify(e)}\n`);
	return e;
}

describe("agent channel replies (PLAN wl-mv8vx7wdj5nx1c D4)", () => {
	test("T10 orchestrator_reply: an envelope from Ilex in inbox/plumb/ in the registry's shape, one channel-out, and re walked to acted-on from held, delivered and consumed; delivered when Plumb's drain acks", async () => {
		const t = await surface();
		const held = t.channelRow("plumb", "held");
		const delivered = t.channelRow("plumb", "delivered");
		const consumed = t.channelRow("plumb", "consumed");
		const revs = [t.row(held).rev, t.row(delivered).rev, t.row(consumed).rev];
		const stop = t.acker("plumb");
		let r: { text: string; details: unknown };
		try {
			r = await t.call(REPLY, { to: "plumb", body: "  Thanks — the header fix is merged.\nNothing else needed.  ", re: [held, delivered, consumed, held] });
		} finally {
			stop();
		}
		const inbox = join(t.root, "inbox", "plumb");
		const names = readdirSync(inbox);
		expect(names).toHaveLength(1);
		const e = expectRegistryEnvelope(inbox, names[0]!);
		expect(e).toMatchObject({ from: "Ilex", to: "Plumb", message: "Thanks — the header fix is merged.\nNothing else needed." });
		// The registry resolves `to` trimmed and lowercased to the inbox it was written in.
		expect(e.to.trim().toLowerCase()).toBe("plumb");
		expect(r.text).toContain("delivered");
		expect(r.text).toContain(e.id);
		expect(r.details).toMatchObject({ id: e.id, to: "plumb", status: "delivered" });
		const outs = t.outEntries();
		expect(outs.map((x) => x.body)).toEqual([`channel-out: ${e.id} to plumb re ${held},${delivered},${consumed}`]);
		expect(outs[0]!.created_by).not.toBe(SURFACE_BY);
		expect(outs[0]!.created_by).not.toBe("jo");
		// Every legal step, one at a time (schema.sql messages_state_order allows one per update): 3, 2 and 1 updates.
		for (const [i, [id, steps]] of ([[held, 3], [delivered, 2], [consumed, 1]] as const).entries()) {
			const now = t.row(id);
			expect(now.state).toBe("acted-on");
			expect(now.rev - revs[i]!).toBe(steps);
			expect([SURFACE_BY, "jo"]).not.toContain(now.changed_by);
		}
		expect(t.ledger.db.query("SELECT count(*) AS n FROM instructions").get()).toEqual({ n: 0 });
		// A reply with no `re`: a channel-out naming none, and no message moves.
		const other = t.channelRow("plumb", "delivered");
		const stop2 = t.acker("plumb");
		try {
			await t.call(REPLY, { to: "Plumb", body: "Unprompted note." });
		} finally {
			stop2();
		}
		expect(t.outEntries()).toHaveLength(2);
		expect(t.outEntries()[1]!.body).toMatch(/^channel-out: [0-9]+-[0-9a-f-]+ to plumb re none$/);
		expect(t.row(other).state).toBe("delivered");
		expect(readdirSync(inbox).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	test("T10 orchestrator_reply: queued when no drain acks within 3 s", async () => {
		const t = await surface();
		const m = t.channelRow("plumb", "delivered");
		const started = Date.now();
		const r = await t.call(REPLY, { to: "plumb", body: "Are you there?", re: [m] });
		expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
		expect(r.details).toMatchObject({ to: "plumb", status: "queued" });
		expect(r.text).toContain("queued");
		const inbox = join(t.root, "inbox", "plumb");
		expect(readdirSync(inbox)).toHaveLength(1);
		expectRegistryEnvelope(inbox, readdirSync(inbox)[0]!);
		expect(t.row(m).state).toBe("acted-on");
	}, 10_000);

	test("T10 orchestrator_reply refuses an unconfigured to, a lane message, a non-channel row, another sender's channel row, and nothing is written or sent", async () => {
		const t = await surface();
		const mine = t.channelRow("plumb", "delivered");
		const wl = t.ledger.openWorkload({ by: "lane-a", brief: "Fix the feed header offset", stakes: "normal", mode: "autonomous" });
		const laneMsg = t.ledger.enqueue({ by: "lane-a", workloadId: wl, sender: "lane-a", recipient: "orchestrator", body: "lane-died: lane-a" });
		const surfaceRow = t.channelRow("plumb", "delivered", { by: SURFACE_BY });
		const elsewhere = t.channelRow("plumb", "delivered", { workloadId: wl });
		const juno = t.channelRow("juno", "delivered");
		const unconfigured = t.channelRow("kite", "delivered");
		const entry = t.ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: "x" });
		const before = t.snapshot();
		const refusedCalls: Record<string, unknown>[] = [
			{ to: "kite", body: "hi", re: [mine] },
			{ to: "ilex", body: "hi" },
			{ to: "jo", body: "hi" },
			{ to: "", body: "hi" },
			{ to: "plumb", body: "hi", re: [mine, laneMsg] },
			{ to: "plumb", body: "hi", re: [surfaceRow] },
			{ to: "plumb", body: "hi", re: [elsewhere] },
			{ to: "plumb", body: "hi", re: [mine, juno] },
			{ to: "plumb", body: "hi", re: [unconfigured] },
			{ to: "plumb", body: "hi", re: [entry] },
			{ to: "plumb", body: "hi", re: ["msg-ch-0-nope"] },
			{ to: "plumb", body: "hi", re: mine },
			{ to: "plumb", body: "   " },
		];
		for (const params of refusedCalls) {
			const r = await t.call(REPLY, params);
			expect(r.text).toStartWith("Refused:");
			expect(r.text).toContain("nothing was written or sent");
			expect(t.snapshot()).toEqual(before);
		}
		expect(existsSync(join(t.root, "inbox"))).toBe(false);
		expect(t.row(mine).state).toBe("delivered");
	});

	test("T11 orchestrator_channel_done walks re to acted-on from held, delivered and consumed for any configured sender, with no envelope, and refuses non-channel ids the same way", async () => {
		const t = await surface();
		const held = t.channelRow("plumb", "held");
		const delivered = t.channelRow("juno", "delivered");
		const consumed = t.channelRow("plumb", "consumed");
		const revs = [t.row(held).rev, t.row(delivered).rev, t.row(consumed).rev];
		const entriesBefore = t.ledger.db.query("SELECT count(*) AS n FROM entries").get();
		const r = await t.call(DONE, { re: [held, delivered, consumed] });
		expect(r.details).toMatchObject({ moved: [held, delivered, consumed] });
		for (const [i, [id, steps]] of ([[held, 3], [delivered, 2], [consumed, 1]] as const).entries()) {
			const now = t.row(id);
			expect(now.state).toBe("acted-on");
			expect(now.rev - revs[i]!).toBe(steps);
			expect([SURFACE_BY, "jo"]).not.toContain(now.changed_by);
		}
		// No reply: no envelope, no channel-out, no other entry.
		expect(tree(t.root)).toEqual([]);
		expect(t.outEntries()).toEqual([]);
		expect(t.ledger.db.query("SELECT count(*) AS n FROM entries").get()).toEqual(entriesBefore);
		// Already acted-on: nothing moves.
		const again = await t.call(DONE, { re: [held] });
		expect(again.details).toMatchObject({ moved: [] });
		expect(t.row(held).rev - revs[0]!).toBe(3);

		const mine = t.channelRow("plumb", "delivered");
		const wl = t.ledger.openWorkload({ by: "lane-a", brief: "Fix the feed header offset", stakes: "normal", mode: "autonomous" });
		const laneMsg = t.ledger.enqueue({ by: "lane-a", workloadId: wl, sender: "lane-a", recipient: "orchestrator", body: "prompt-wait: x" });
		const surfaceRow = t.channelRow("plumb", "delivered", { by: SURFACE_BY });
		const elsewhere = t.channelRow("plumb", "delivered", { workloadId: wl });
		const unconfigured = t.channelRow("kite", "delivered");
		const entry = t.ledger.recordEntry({ by: "lane-a", workloadId: wl, kind: "assumption", body: "x" });
		const before = t.snapshot();
		for (const re of [[mine, laneMsg], [surfaceRow], [elsewhere], [unconfigured], [mine, entry], ["msg-ch-0-nope"], [], undefined, mine]) {
			const out = await t.call(DONE, re === undefined ? {} : { re });
			expect(out.text).toStartWith("Refused:");
			expect(t.snapshot()).toEqual(before);
		}
		expect(t.row(mine).state).toBe("delivered");
	});
});
