// The ledger audit's probe shapes (A3-1, A2-3, A2-4, A5-1), runnable against any version of the
// ledger module: `bun run final-state-probes.ts <module index.ts> <scratch dir>` prints one JSON object,
// probe name -> "accepted" or "refused: <message>". freeze.test.ts runs it against the module at the
// last version-5 commit (every probe accepted) and against this checkout's (every probe refused).
// Each probe uses only API that both versions export, on its own new ledger in <scratch dir>.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Ledger as HeadLedger } from "../src/index";

const [modulePath, dir] = process.argv.slice(2);
if (!modulePath || !dir) throw new Error("usage: final-state-probes.ts <module index.ts> <scratch dir>");
// Runtime-selected: the module under test is an older version's copy or this checkout's, named on the command line.
const { Ledger } = (await import(modulePath)) as { Ledger: typeof HeadLedger };

const open = (name: string) => Ledger.open(join(dir, `${name}.db`), { create: true, backup: false, skipLocalityCheck: true });

const probes: Record<string, () => void> = {
	// A3-1: a second completion rewrites a done slice's artifact (its completion receipt).
	"complete a done slice again": () => {
		const l = open("slice");
		const wl = l.openWorkload({ by: "audit", brief: "probe", stakes: "throwaway", mode: "autonomous" });
		const sl = l.addSlice({ by: "lane-x", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		l.completeSlice(sl, { by: "lane-x", artifact: "bun test exit 0 (real run)" });
		l.completeSlice(sl, { by: "lane-y", artifact: "forged: tests passed" });
	},
	// A3-1: a cancelled slice re-cancelled by another writer.
	"cancel a cancelled slice again": () => {
		const l = open("cancelled");
		const wl = l.openWorkload({ by: "audit", brief: "probe", stakes: "throwaway", mode: "autonomous" });
		const sl = l.addSlice({ by: "lane-x", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
		l.cancelSlice(sl, { by: "lane-x" });
		l.cancelSlice(sl, { by: "lane-y" });
	},
	// A3-1: an acted-on message re-advanced to acted-on by another writer.
	"re-advance an acted-on message": () => {
		const l = open("message");
		const wl = l.openWorkload({ by: "audit", brief: "probe", stakes: "throwaway", mode: "autonomous" });
		const m = l.enqueue({ by: "lane-x", workloadId: wl, sender: "lane-x", recipient: "orchestrator", body: "hi" });
		for (const s of ["delivered", "consumed", "acted-on"] as const) l.advanceMessage(m, s, { by: "surface" });
		l.advanceMessage(m, "acted-on", { by: "lane-z" });
	},
	// A3-1: stakes changed on a closed workload.
	"set stakes on a closed workload": () => {
		const l = open("closed");
		const wl = l.openWorkload({ by: "audit", brief: "probe", stakes: "normal", mode: "autonomous" });
		l.closeWorkload(wl, { by: "audit" });
		l.setStakes(wl, { by: "lane-z", stakes: "throwaway" });
	},
	// A2-3: stakes changed with no `stakes:` instruction.
	"set stakes with no instruction": () => {
		const l = open("stakes");
		const wl = l.openWorkload({ by: "audit", brief: "probe", stakes: "throwaway", mode: "autonomous" });
		l.setStakes(wl, { by: "lane-x", stakes: "production" });
	},
	// A2-4: the standing workload closed.
	"close the standing workload": () => {
		const l = open("standing");
		l.openWorkload({ by: "orchestrator-surface", id: "wl-orchestrator", brief: "standing", stakes: "throwaway", mode: "autonomous" });
		l.closeWorkload("wl-orchestrator", { by: "lane-z" });
	},
	// A5-1: a file with two triggers dropped opens, and the module goes on writing to it.
	"open a ledger with dropped triggers": () => {
		const path = join(dir, "drift.db");
		Ledger.open(path, { create: true, backup: false, skipLocalityCheck: true }).close();
		const raw = new Database(path);
		raw.exec("DROP TRIGGER entries_no_delete; DROP TRIGGER instructions_no_update;");
		raw.close();
		Ledger.open(path, { backup: false, backupOnOpen: false, skipLocalityCheck: true }).close();
	},
	// A1-1: a connection commits at synchronous NORMAL (1), so a commit can roll back on power loss.
	"commit at synchronous below FULL": () => {
		const l = open("pragmas");
		const level = l.db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()!.synchronous;
		if (level >= 2) throw new Error(`synchronous = ${level} (FULL)`);
	},
};

const out: Record<string, string> = {};
for (const [name, probe] of Object.entries(probes)) {
	try {
		probe();
		out[name] = "accepted";
	} catch (e) {
		out[name] = `refused: ${e instanceof Error ? e.message : String(e)}`;
	}
}
console.log(JSON.stringify(out));
