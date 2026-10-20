// PLAN wl-mvbcjageg7o2yo § 2.5, R15: closing a workload moves its held orchestrator-bound messages
// to `delivered` in the close transaction and names them in the close result and the tick's entry
// line; a message to anyone else stays held, and a refused or failed close leaves every one held.
// The host has no exec and the profile serves no repo, so the close renders its decision-log entry
// untracked in a scratch checkout and touches no git (close-entry.test.ts (d)).
import { afterAll, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ledger } from "../../ledger/src/index";
import { closeWorkloadWithEntry } from "../extensions/workload";
import { TEST_RUNNER_CONFIG_ENV } from "../src/close-entry";
import { recordRepo } from "../src/decision-log";
import { ORCHESTRATOR_RECIPIENT, SURFACE_BY, type SurfaceAPI } from "../src/types";
import { clock, tempLedger, tmp } from "./helpers";

const roots: string[] = [];
const ledgers: Ledger[] = [];
afterAll(() => {
	for (const l of ledgers) {
		try {
			l.close();
		} catch {
			// already closed
		}
	}
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const pi = { appendEntry: () => {} } as unknown as SurfaceAPI;

interface Closable {
	ledger: Ledger;
	wl: string;
	work: string;
	env: Record<string, string>;
	/** The ledger's settable clock (helpers.ts `clock`): `at` moves it. */
	c: { now: () => string; at: (iso: string) => void };
}

/** A released workload ready to close (no done: line, no slices) on a scratch checkout no profile serves. */
function closable(): Closable {
	const root = realpathSync(tmp("close-held"));
	roots.push(root);
	writeFileSync(join(root, "config.yml"), "setupVersion: 2\n");
	const c = clock("2026-10-01T10:00:00.000Z");
	const { ledger, path } = tempLedger(c.now);
	ledgers.push(ledger);
	roots.push(dirname(path));
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Placeholder brief", stakes: "normal", mode: "autonomous" });
	recordRepo(ledger, wl, root);
	return { ledger, wl, work: root, env: { [TEST_RUNNER_CONFIG_ENV]: join(root, "config.yml") }, c };
}

const close = (x: Closable, now: string = x.c.now()) => closeWorkloadWithEntry(pi, x.ledger, x.env, x.wl, { now, cwd: x.work, receipt: null });

/** Enqueue `n` messages from lane-a to `recipient`, one second apart, bodies `placeholder <i>`. */
function enqueue(x: Closable, n: number, recipient: string = ORCHESTRATOR_RECIPIENT, start = 0): string[] {
	const ids: string[] = [];
	for (let i = start; i < start + n; i++) {
		x.c.at(new Date(Date.parse("2026-10-01T10:00:00.000Z") + (i + 1) * 1000).toISOString());
		ids.push(x.ledger.enqueue({ by: "lane-a", workloadId: x.wl, sender: "lane-a", recipient, body: `placeholder ${i}` }));
	}
	return ids;
}

const states = (x: Closable, ids: string[]) => ids.map((id) => x.ledger.message(id)!.state);
const heldLine = (s: string) => s.split("\n").find((l) => l.startsWith("held messages delivered at close"));

describe("close: held orchestrator-bound messages are delivered in the close transaction (R15)", () => {
	test("a close delivers the held orchestrator messages, stamped by the surface, and names them in the text and the entry", async () => {
		const x = closable();
		const ids = enqueue(x, 2);

		const r = await close(x);

		expect(r.closed).toBe(true);
		expect(x.ledger.workload(x.wl)!.status).toBe("closed");
		expect(states(x, ids)).toEqual(["delivered", "delivered"]);
		for (const id of ids) expect(x.ledger.message(id)!.changed_by).toBe(SURFACE_BY);
		const line = `held messages delivered at close (2): ${ids[0]} lane-a: placeholder 0; ${ids[1]} lane-a: placeholder 1`;
		expect(heldLine(r.text)).toBe(line);
		expect(heldLine(r.entry ?? "")).toBe(line);
	});

	test("a message to another recipient stays held and is not named; with none held to the orchestrator the close adds no line", async () => {
		const x = closable();
		const [toLane] = enqueue(x, 1, "lane-a");

		const r = await close(x);

		expect(r.closed).toBe(true);
		expect(states(x, [toLane!])).toEqual(["held"]);
		expect(r.text).not.toContain("held messages delivered at close");
		expect(r.entry ?? "").not.toContain("held messages delivered at close");
		expect(r.text).not.toContain(toLane!);
	});

	test("a mixed queue: only the orchestrator-bound held ones move; one already delivered is neither moved nor named", async () => {
		const x = closable();
		const [toOrch, earlier] = enqueue(x, 2);
		const [toLane] = enqueue(x, 1, "lane-a", 2);
		x.ledger.advanceMessage(earlier!, "delivered", { by: SURFACE_BY });

		const r = await close(x);

		expect(states(x, [toOrch!, earlier!, toLane!])).toEqual(["delivered", "delivered", "held"]);
		expect(heldLine(r.text)).toBe(`held messages delivered at close (1): ${toOrch} lane-a: placeholder 0`);
	});

	test("12 held messages: 10 listed in order, then `+2 more` by id", async () => {
		const x = closable();
		const ids = enqueue(x, 12);

		const r = await close(x);

		expect(states(x, ids).every((s) => s === "delivered")).toBe(true);
		const listed = ids.slice(0, 10).map((id, i) => `${id} lane-a: placeholder ${i}`).join("; ");
		const line = `held messages delivered at close (12): ${listed}; +2 more: ${ids[10]} ${ids[11]}`;
		expect(heldLine(r.text)).toBe(line);
		expect(heldLine(r.entry ?? "")).toBe(line);
	});

	test("a long or multi-line body is carried on one line, at most 200 characters", async () => {
		const x = closable();
		const id = x.ledger.enqueue({ by: "lane-a", workloadId: x.wl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: `first\nsecond ${"x".repeat(300)}` });

		const r = await close(x);

		const line = heldLine(r.text)!;
		const body = line.slice(`held messages delivered at close (1): ${id} lane-a: `.length);
		expect(body.startsWith("first second x")).toBe(true);
		expect(body.length).toBe(200);
		expect(line).not.toContain("\n");
	});

	test("a refused close (an open slice) leaves every message held and names none", async () => {
		const x = closable();
		x.ledger.addSlice({ by: "lane-a", workloadId: x.wl, task: "placeholder task", doneCondition: "placeholder", inputs: "placeholder" });
		const ids = [...enqueue(x, 3), ...enqueue(x, 1, "lane-a", 3)];

		const r = await close(x);

		expect(r.closed).toBe(false);
		expect(x.ledger.workload(x.wl)!.status).toBe("open");
		expect(states(x, ids)).toEqual(["held", "held", "held", "held"]);
		expect(r.text).not.toContain("held messages delivered at close");
	});

	test("a close that fails inside the transaction (the ledger's own live-lease check) rolls the deliveries back: every message stays held", async () => {
		const x = closable();
		const ids = enqueue(x, 2);
		// A lease to 11:00 on the ledger's clock; the caller's `now` is past it, so the pre-check lets the close through to the transaction, where the ledger refuses it.
		x.c.at("2026-10-01T10:00:00.000Z");
		expect(x.ledger.claimWorkload(x.wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 })).toEqual({ won: true });

		const r = await close(x, "2026-10-01T12:00:00.000Z");

		expect(r.closed).toBe(false);
		expect(r.text).toContain("stays open");
		expect(x.ledger.workload(x.wl)!.status).toBe("open");
		expect(states(x, ids)).toEqual(["held", "held"]);
		expect(r.text).not.toContain("held messages delivered at close");
	});
});
