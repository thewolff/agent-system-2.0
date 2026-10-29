// Issue #334 item 2 (Jo, 2026-10-28) at the orchestrator's entry point: the open tool refuses a brief with no "How it fails"
// section back to the orchestrator, opening nothing, and records a pass on the `How it fails: n/a, <reason>` line on the workload.
// The plan question's check is tested in launch.test.ts and lane-tools.test.ts; the dispatch brief and the paired card in gates/test.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { ctxOf, fakePi, HOW_IT_FAILS, tmp } from "./helpers";

function surface() {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close();
	const f = fakePi();
	orchestratorSurface(f.pi, e, {});
	const open = async (brief: string) => {
		const r = await f.tool("orchestrator_open_workload").execute("1", { brief, done: "it is done", stakes: "throwaway", mode: "user-driven" }, undefined, undefined, ctxOf());
		return { text: r.content[0]!.text, id: (r.details as { id?: string } | undefined)?.id ?? null };
	};
	const ledger = () => Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { backup: false, backupOnOpen: false });
	return { open, ledger, description: () => f.tool("orchestrator_open_workload").description };
}

describe("the open tool's How it fails gate", () => {
	test("a brief with no section is refused naming the section, the heading and the n/a line, and nothing is opened", async () => {
		const s = surface();
		const r = await s.open("rename the header offset constant");
		expect(r.id).toBeNull();
		expect(r.text).toStartWith('Refused: the brief has no "How it fails" section.');
		expect(r.text).toContain("`## How it fails`");
		expect(r.text).toContain("`How it fails: n/a, <reason>`");
		expect(r.text).toContain("Nothing was opened.");
		const l = s.ledger();
		expect(l.inFlight().length).toBe(0);
		l.close();
	});

	test("an empty section is refused too; the same brief resubmitted with a section opens, and records no n/a note", async () => {
		const s = surface();
		expect((await s.open("rename it\n## How it fails\n\n## Done")).id).toBeNull();
		const r = await s.open(`rename it${HOW_IT_FAILS}`);
		expect(r.id).not.toBeNull();
		const l = s.ledger();
		expect(l.entries(r.id!).some((e) => e.body.startsWith("how-it-fails:"))).toBe(false);
		l.close();
	});

	test("a brief on the n/a line opens and the gate records that it was used, with its reason", async () => {
		const s = surface();
		const r = await s.open("fix the README typo\nHow it fails: n/a, one-word docs fix");
		expect(r.id).not.toBeNull();
		const l = s.ledger();
		expect(l.entries(r.id!, "assumption").filter((e) => e.body.startsWith("how-it-fails:")).map((e) => e.body)).toEqual(["how-it-fails: n/a, one-word docs fix (brief at open)"]);
		l.close();
	});

	test("the tool's description tells the orchestrator it will be refused", () => {
		expect(surface().description()).toContain("a brief with neither is refused and nothing is opened");
	});
});
