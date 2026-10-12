// ledger/src/offdisk.ts (audit finding A1-3): the successful mirror, run against real files in
// temporary directories. The runner has one disk, so `deviceOf` stands in a second device id for the
// destination root; every copy, link, removal and listing is real. The real same-device refusal
// stays in ledger.test.ts ("off-disk (A1-3)").
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BACKUP_SOURCE_FILE, copyProblem, Ledger } from "../src/index";
import { offDiskNamespace, syncOffDisk } from "../src/offdisk";

const scratch = (label: string) => mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), `ledger-offdisk-${label}-`));

/** A ledger with a clock the test moves, and an existing destination root standing in for a second disk. */
function setup(label: string) {
	const dir = scratch(label);
	const root = join(dir, "drive");
	mkdirSync(root);
	let now = "2026-10-12T01:00:00.000Z";
	const ledger = Ledger.open(join(dir, "ledger.db"), { create: true, clock: () => now });
	const at = (iso: string) => (now = iso);
	const deviceOf = (p: string) => (p === root ? -1 : statSync(p).dev);
	const ns = offDiskNamespace(root, ledger.path);
	const listing = () => readdirSync(ns).sort();
	return { ledger, root, at, deviceOf, ns, listing };
}

describe("off-disk mirror: success, idempotence, retention, refusals, temporary files", () => {
	test("mirrors the newest complete local copy under its own name, with SOURCE, and leaves no temporary file", () => {
		const { ledger, root, deviceOf, ns, listing } = setup("success");
		const w = ledger.openWorkload({ brief: "mirrored", stakes: "normal", mode: "autonomous", by: "orch-1" });
		const local = ledger.backupIfDue(true)!;
		const r = syncOffDisk(ledger, root, 48, deviceOf);
		expect(r).toEqual({ copied: join(ns, basename(local)), newest: join(ns, basename(local)) });
		expect(listing()).toEqual([BACKUP_SOURCE_FILE, basename(local)]);
		expect(readFileSync(join(ns, BACKUP_SOURCE_FILE), "utf8")).toBe(`${ledger.path}\n`);
		expect(copyProblem(r.copied!)).toBeNull();
		const mirror = Ledger.open(r.copied!, { backupOnOpen: false });
		expect(mirror.workload(w)?.brief).toBe("mirrored");
		mirror.close();
		ledger.close();
	});

	test("a second run with nothing new copies nothing and changes nothing", () => {
		const { ledger, root, deviceOf, ns, listing } = setup("idempotent");
		const local = ledger.backupIfDue(true)!;
		syncOffDisk(ledger, root, 48, deviceOf);
		const before = listing();
		const mtime = statSync(join(ns, basename(local))).mtimeMs;
		expect(syncOffDisk(ledger, root, 48, deviceOf)).toEqual({ copied: null, newest: join(ns, basename(local)) });
		expect(listing()).toEqual(before);
		expect(statSync(join(ns, basename(local))).mtimeMs).toBe(mtime);
		ledger.close();
	});

	test("keeps the newest `keep` copies there, oldest removed first", () => {
		const { ledger, root, at, deviceOf, listing } = setup("retention");
		for (const hour of ["01", "02", "03"]) {
			at(`2026-10-12T${hour}:00:00.000Z`);
			ledger.backupIfDue(true);
			syncOffDisk(ledger, root, 2, deviceOf);
		}
		expect(listing()).toEqual([BACKUP_SOURCE_FILE, "ledger-2026-10-12T02-00-00.000Z.db", "ledger-2026-10-12T03-00-00.000Z.db"]);
		ledger.close();
	});

	test("refuses a namespace whose SOURCE names another ledger, writing nothing there", () => {
		const { ledger, root, deviceOf, ns, listing } = setup("owner");
		ledger.backupIfDue(true);
		mkdirSync(ns, { recursive: true });
		writeFileSync(join(ns, BACKUP_SOURCE_FILE), "/elsewhere/ledger.db\n");
		expect(() => syncOffDisk(ledger, root, 48, deviceOf)).toThrow(`off-disk directory ${ns} holds copies of /elsewhere/ledger.db, not of ${ledger.path}`);
		expect(listing()).toEqual([BACKUP_SOURCE_FILE]);
		ledger.close();
	});

	test("refuses when the copy's name there holds an incomplete file, and leaves that file alone", () => {
		const { ledger, root, deviceOf, ns, listing } = setup("incomplete");
		const local = ledger.backupIfDue(true)!;
		mkdirSync(ns, { recursive: true });
		const dest = join(ns, basename(local));
		writeFileSync(dest, "half a copy");
		expect(() => syncOffDisk(ledger, root, 48, deviceOf)).toThrow(`off-disk ${dest} exists and is not a complete copy`);
		expect(readFileSync(dest, "utf8")).toBe("half a copy");
		expect(listing().filter((n) => n.startsWith("."))).toEqual([]);
		ledger.close();
	});

	test("removes a temporary file whose writer is gone, keeps a live writer's", () => {
		const { ledger, root, deviceOf, ns, listing } = setup("temp-cleanup");
		const local = basename(ledger.backupIfDue(true)!);
		mkdirSync(ns, { recursive: true });
		const exited = Bun.spawnSync(["true"]).pid; // a pid whose process has exited
		const dead = `.${local}.${exited}-abc.tmp`;
		const live = `.${local}.${process.pid}-def.tmp`;
		writeFileSync(join(ns, dead), "");
		writeFileSync(join(ns, live), "");
		syncOffDisk(ledger, root, 48, deviceOf);
		expect(existsSync(join(ns, dead))).toBe(false);
		expect(listing()).toEqual([live, BACKUP_SOURCE_FILE, local].sort());
		ledger.close();
	});
});
