// The open tool's authored work name (PLAN wl-mv7gidggnlkem8 § Source writer contracts):
// `orchestrator_open_workload` requires a plain `name`, refuses a bad one before anything is written,
// and writes it by the surface in the transaction that opens the workload, so a workload never exists
// without its name and a failed name write leaves no workload behind. The scheduled row's name is in
// schedule-script.test.ts; the value rules themselves are in pending-details.test.ts.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import * as core from "../src/pending-details";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, tmp } from "./helpers";

/** The orchestrator surface on a fresh ledger, with no judge and no exec (the launcher never runs). */
function surface() {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	const ledger = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false });
	const f = fakePi();
	orchestratorSurface(f.pi, e, {});
	const open = async (params: Record<string, unknown>) => {
		const r = await f.tool("orchestrator_open_workload").execute("1", { brief: "Move the header offset into a token, no plan", done: "the header offset lives in one token", stakes: "normal", ...params }, undefined, undefined, ctxOf());
		return { text: r.content[0]!.text, id: (r.details as { id?: string } | undefined)?.id ?? null };
	};
	/** Rows outside the standing workload: what an open writes. */
	const written = () => ({
		workloads: ledger.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM workloads WHERE id != ?").get(STANDING_WORKLOAD_ID)!.n,
		entries: ledger.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM entries WHERE workload_id != ?").get(STANDING_WORKLOAD_ID)!.n,
	});
	return { ledger, open, written };
}

describe("orchestrator_open_workload: the work name", () => {
	test("a missing or invalid name is refused before anything is written: no workload, no entry", async () => {
		const s = surface();
		const bad: unknown[] = [undefined, "", "   ", "line\nbreak", "zero\u200Bwidth", "fenced ``` name", "a".repeat(81), "wl-mv7gidggnlkem8", 42];
		for (const name of bad) {
			const r = await s.open(name === undefined ? {} : { name });
			expect({ name, text: r.text, id: r.id }).toEqual({ name, text: expect.stringContaining("Nothing was opened."), id: null });
		}
		expect(s.written()).toEqual({ workloads: 0, entries: 0 });
	});

	test("the name is written by the surface with the workload it names, read back as that workload's name, and shown in the reply", async () => {
		const s = surface();
		const r = await s.open({ name: "  Header offset token  " });
		expect(r.id).not.toBeNull();
		const id = r.id!;
		expect(r.text).toContain(`Opened ${id} on `);
		expect(r.text).toContain("name: Header offset token");
		const named = core.workName(s.ledger, id);
		expect(named).toEqual({ name: "Header offset token", sourceHash: core.workSourceHash(s.ledger.workload(id)!), entryId: expect.any(String) });
		const entry = s.ledger.entries(id).find((e) => e.id === named?.entryId);
		expect(entry).toMatchObject({ created_by: SURFACE_BY, kind: "assumption", workload_id: id });
	});

	test("a name write that fails rolls the whole open back: no workload is left unnamed", async () => {
		const s = surface();
		s.ledger.db.exec("CREATE TRIGGER inject_name_failure BEFORE INSERT ON entries WHEN NEW.body LIKE 'work-name:%' BEGIN SELECT RAISE(ABORT, 'injected name failure'); END;");
		const failed = await s.open({ name: "Header offset token" }).then((r) => r.text, (e: unknown) => (e instanceof Error ? e.message : String(e)));
		expect(failed).toContain("injected name failure");
		expect(s.written()).toEqual({ workloads: 0, entries: 0 });
	});
});
