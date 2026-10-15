// The scheduled row's authored work name (PLAN wl-mv7gidggnlkem8 § Source writer contracts):
// `orchestrator_schedule` requires a plain `name`, refuses a bad one before anything is written, and
// opens the `due:` row and writes its name in one new transaction, so a scheduled row never exists
// unnamed and a failed name write leaves no row behind. The open tool's name is in workload.test.ts.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import * as core from "../src/pending-details";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, tmp } from "./helpers";

/** The orchestrator surface on a fresh ledger, and the schedule tool. */
function surface() {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	const ledger = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false });
	const f = fakePi();
	orchestratorSurface(f.pi, e, {});
	const schedule = async (params: Record<string, unknown>) => {
		const r = await f.tool("orchestrator_schedule").execute("1", { due: "2026-11-01", text: "re-measure the routing threshold; method = routing_review", ...params }, undefined, undefined, ctxOf());
		return { text: r.content[0]!.text, details: r.details as { id?: string; due?: string; name?: string } | undefined };
	};
	/** Rows outside the standing workload: what a schedule writes. */
	const written = () => ({
		workloads: ledger.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM workloads WHERE id != ?").get(STANDING_WORKLOAD_ID)!.n,
		entries: ledger.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM entries WHERE workload_id != ?").get(STANDING_WORKLOAD_ID)!.n,
	});
	return { ledger, schedule, written };
}

describe("orchestrator_schedule: the work name", () => {
	test("a missing or invalid name is refused before anything is written; a bad due date is still refused first", async () => {
		const s = surface();
		for (const name of [undefined, "", "line\nbreak", "bidi\u202Eevil", "fenced ~~~ name", "a".repeat(81), "q-mv8g6i5lvq"]) {
			const r = await s.schedule(name === undefined ? {} : { name });
			expect({ name, text: r.text, id: r.details?.id ?? null }).toEqual({ name, text: expect.stringContaining("Nothing was opened."), id: null });
		}
		expect((await s.schedule({ due: "someday", name: "Routing threshold" })).text).toBe("A scheduled row needs a parseable due date and a text; nothing was opened.");
		expect(s.written()).toEqual({ workloads: 0, entries: 0 });
	});

	test("the due: row and its name are written together, by the surface; the reply and details carry the name", async () => {
		const s = surface();
		const r = await s.schedule({ name: "Routing threshold re-measure" });
		const id = r.details?.id ?? "";
		expect(r.text).toBe(`Scheduled ${id} (Routing threshold re-measure), due 2026-11-01: re-measure the routing threshold; method = routing_review`);
		expect(r.details).toEqual({ id, due: "2026-11-01", name: "Routing threshold re-measure" });
		const row = s.ledger.workload(id)!;
		expect(row).toMatchObject({ brief: "due:2026-11-01 re-measure the routing threshold; method = routing_review", stakes: "throwaway", mode: "autonomous", created_by: SURFACE_BY });
		const named = core.workName(s.ledger, id);
		expect(named).toEqual({ name: "Routing threshold re-measure", sourceHash: core.workSourceHash(row), entryId: expect.any(String) });
		expect(s.ledger.entries(id).find((e) => e.id === named?.entryId)).toMatchObject({ created_by: SURFACE_BY, kind: "assumption" });
	});

	test("a name write that fails rolls the scheduled row back too", async () => {
		const s = surface();
		s.ledger.db.exec("CREATE TRIGGER inject_name_failure BEFORE INSERT ON entries WHEN NEW.body LIKE 'work-name:%' BEGIN SELECT RAISE(ABORT, 'injected name failure'); END;");
		const failed = await s.schedule({ name: "Routing threshold re-measure" }).then((r) => r.text, (e: unknown) => (e instanceof Error ? e.message : String(e)));
		expect(failed).toContain("injected name failure");
		expect(s.written()).toEqual({ workloads: 0, entries: 0 });
	});
});
