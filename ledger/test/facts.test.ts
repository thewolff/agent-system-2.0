import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Ledger, LedgerSchemaVersionError } from "../src/index";
import { tmpDir } from "./tmp";

// Synthetic facts only, in the live row shape (MIGRATION.md row M8); no live ledger is opened.
const scratch = (label: string) => tmpDir(`ledger-${label}-`);
/** A settable clock, so created_at is known and can run against insertion order. */
function settable(start = "2026-10-01T10:00:00.000Z") {
	let t = start;
	return { now: () => t, at: (iso: string) => void (t = iso) };
}
const fresh = (label: string, opts: Parameters<typeof Ledger.open>[1] = {}) =>
	Ledger.open(join(scratch(label), "ledger.db"), { create: true, ...opts });

const SHIPYARD = "/fixture/shipyard";
const WEB = "/fixture/shipyard/repos/web";
const fact = (n: number | string, tag: string, repo: string, src: string, text: string) => `m8-fact #${n} [${tag}] repo=${repo} src=${src} :: ${text}`;

function seeded(label: string) {
	const c = settable();
	const l = fresh(label, { clock: c.now });
	const wl = l.openWorkload({ by: "orch", brief: "migrate memory", stakes: "normal", mode: "autonomous" });
	const add = (body: string, at?: string, workloadId = wl) => {
		if (at) c.at(at);
		return l.recordEntry({ by: "lane-m8", workloadId, kind: "assumption", body });
	};
	return { l, wl, c, add };
}

describe("Ledger.facts: the M8 reader contract", () => {
	test("reads facts on any workload, a closed one included, and parses every field", () => {
		const { l, add } = seeded("any-workload");
		const closed = l.openWorkload({ by: "orch", brief: "older batch", stakes: "normal", mode: "autonomous" });
		const a = add(fact(12, "m8-verge-wl1", SHIPYARD, "/fixture/shipyard/notes/a.md:18-33", "the deploy box is arm64"), "2026-10-01T10:00:01.000Z");
		const b = add(fact(13, "m8-verge-wl0", SHIPYARD, "/fixture/shipyard/b.md:1-4,/fixture/c.md:7-9", "two sources"), "2026-10-01T10:00:02.000Z", closed);
		l.closeWorkload(closed, { by: "orch" });
		expect(l.workload(closed)?.status).toBe("closed");

		expect(l.facts(SHIPYARD)).toEqual([
			{ id: a, n: 12, tag: "m8-verge-wl1", repo: SHIPYARD, src: "/fixture/shipyard/notes/a.md:18-33", text: "the deploy box is arm64", created_at: "2026-10-01T10:00:01.000Z" },
			{ id: b, n: 13, tag: "m8-verge-wl0", repo: SHIPYARD, src: "/fixture/shipyard/b.md:1-4,/fixture/c.md:7-9", text: "two sources", created_at: "2026-10-01T10:00:02.000Z" },
		]);
	});

	test("a repo key is never matched by a longer key it prefixes, nor the longer by the shorter", () => {
		const { l, add } = seeded("prefix");
		add(fact(1, "m8-verge-wl1", SHIPYARD, "/fixture/shipyard/a.md:1-2", "outer"));
		add(fact(1, "m8-wren-wl1", WEB, "/fixture/shipyard/repos/web/b.md:1-2", "inner"));
		expect(l.facts(SHIPYARD).map((f) => f.text)).toEqual(["outer"]);
		expect(l.facts(WEB).map((f) => f.text)).toEqual(["inner"]);
		expect(l.facts("/fixture/ship")).toEqual([]);
	});

	test("a repo key is a literal: `_` and `%` match only themselves, and case counts", () => {
		const { l, add } = seeded("literal");
		add(fact(1, "m8-a-wl1", "/fixture/axb", "/fixture/axb/a.md:1-2", "x not underscore"));
		add(fact(2, "m8-a-wl1", "/fixture/a_b", "/fixture/a_b/a.md:1-2", "real underscore"));
		add(fact(3, "m8-a-wl1", "/fixture/100%-done", "/fixture/f.md:1-2", "percent suffix"));
		add(fact(4, "m8-a-wl1", "/fixture/Shipyard", "/fixture/Shipyard/a.md:1-2", "other case"));
		expect(l.facts("/fixture/a_b").map((f) => f.text)).toEqual(["real underscore"]);
		expect(l.facts("/fixture/100%")).toEqual([]);
		expect(l.facts("/fixture/100%-done").map((f) => f.text)).toEqual(["percent suffix"]);
		expect(l.facts(SHIPYARD)).toEqual([]);
		expect(l.facts("/fixture/Shipyard").map((f) => f.text)).toEqual(["other case"]);
	});

	test("repo and src paths with spaces match and parse; src ends at the first ` :: `", () => {
		const { l, add } = seeded("spaces");
		add(fact(1, "m8-galley-wl1", "/fixture/My Repo", "/fixture/My Repo/a b.md:1-2", "spaces work"));
		add(fact(2, "m8-galley-wl1", "/fixture/My Repo", "/fixture/My Repo/c.md:3-4", "a text :: with its own separator"));
		expect(l.facts("/fixture/My Repo").map(({ src, text }) => ({ src, text }))).toEqual([
			{ src: "/fixture/My Repo/a b.md:1-2", text: "spaces work" },
			{ src: "/fixture/My Repo/c.md:3-4", text: "a text :: with its own separator" },
		]);
		expect(l.facts("/fixture/My")).toEqual([]);
	});

	test("a rolled-back batch is dropped, from any workload's rollback entry; a sibling batch on the same repo stays", () => {
		const { l, add } = seeded("rollback");
		add(fact(1, "m8-tinker-wl1", SHIPYARD, "/fixture/a.md:1-2", "bad one"));
		add(fact(2, "m8-tinker-wl1", SHIPYARD, "/fixture/a.md:3-4", "bad two"));
		add(fact(3, "m8-tinker-wl2", SHIPYARD, "/fixture/b.md:1-2", "good sibling"));
		expect(l.facts(SHIPYARD).map((f) => f.text)).toEqual(["bad one", "bad two", "good sibling"]);
		const other = l.openWorkload({ by: "orch", brief: "roll back", stakes: "normal", mode: "autonomous" });
		add("m8-rollback [m8-tinker-wl1] wrong repo key", undefined, other);
		expect(l.facts(SHIPYARD).map((f) => [f.tag, f.text])).toEqual([["m8-tinker-wl2", "good sibling"]]);
	});

	test("ordered by numeric n (#9 < #10 < #100), then created_at, then id; not by insertion", () => {
		const { l, add } = seeded("order");
		add(fact(100, "m8-a-wl1", SHIPYARD, "/fixture/a.md:1-2", "hundred"), "2026-10-01T10:00:01.000Z");
		add(fact(10, "m8-a-wl1", SHIPYARD, "/fixture/a.md:1-2", "ten"), "2026-10-01T10:00:02.000Z");
		add(fact(9, "m8-a-wl1", SHIPYARD, "/fixture/a.md:1-2", "nine"), "2026-10-01T10:00:03.000Z");
		add(fact(50, "m8-b-wl2", SHIPYARD, "/fixture/b.md:1-2", "fifty later"), "2026-10-01T10:00:09.000Z");
		add(fact(50, "m8-c-wl3", SHIPYARD, "/fixture/c.md:1-2", "fifty earlier"), "2026-10-01T10:00:05.000Z");
		expect(l.facts(SHIPYARD).map((f) => f.text)).toEqual(["nine", "ten", "fifty earlier", "fifty later", "hundred"]);

		const same = [
			add(fact(7, "m8-d-wl4", WEB, "/fixture/d.md:1-2", "tie"), "2026-10-01T11:00:00.000Z"),
			add(fact(7, "m8-e-wl5", WEB, "/fixture/e.md:1-2", "tie")),
			add(fact(7, "m8-f-wl6", WEB, "/fixture/f.md:1-2", "tie")),
		];
		expect(l.facts(WEB).map((f) => f.id)).toEqual([...same].sort());
	});

	test("a contract row with no ` :: ` is kept: src empty, text the trimmed rest", () => {
		const { l, add } = seeded("no-separator");
		const id = add(`m8-fact #4 [m8-sedge-wl1] repo=${SHIPYARD} src=/fixture/a.md:1-2 lost its separator  `);
		expect(l.facts(SHIPYARD)).toEqual([expect.objectContaining({ id, n: 4, src: "", text: "/fixture/a.md:1-2 lost its separator" })]);
	});

	test("bodies outside the contract are ignored", () => {
		const { l, wl, add } = seeded("non-contract");
		add(`m8-fact #1 repo=${SHIPYARD} src=/fixture/a.md:1-2 :: no tag`);
		add(`m8-fact #x [m8-a-wl1] repo=${SHIPYARD} src=/fixture/a.md:1-2 :: not a number`);
		add(`m8-fact # [m8-a-wl1] repo=${SHIPYARD} src=/fixture/a.md:1-2 :: no number`);
		add(`m8-fact #2 [other-a-wl1] repo=${SHIPYARD} src=/fixture/a.md:1-2 :: tag not m8-`);
		add(`M8-FACT #3 [m8-a-wl1] repo=${SHIPYARD} src=/fixture/a.md:1-2 :: upper-case prefix`);
		add(`note: m8-fact #4 [m8-a-wl1] repo=${SHIPYARD} src=/fixture/a.md:1-2 :: not at the start`);
		add(`m8-fact #5 [m8-a-wl1] repo=${SHIPYARD} :: no src`);
		add(`repo: ${SHIPYARD}`);
		l.recordEntry({ by: "lane-m8", workloadId: wl, kind: "wake-read", body: `wake-read: resumes ${SHIPYARD}` });
		l.addSlice({ by: "lane-m8", workloadId: wl, task: fact(6, "m8-a-wl1", SHIPYARD, "/fixture/a.md:1-2", "a slice, not an entry"), doneCondition: "x", inputs: "y" });
		const kept = add(fact(7, "m8-a-wl1", SHIPYARD, "/fixture/a.md:1-2", "the one fact"));
		expect(l.facts(SHIPYARD).map((f) => f.id)).toEqual([kept]);
	});
});

describe("Ledger.open { readonly: true }", () => {
	/** A ledger with one fact, closed, in rollback-journal mode so a WAL switch would show. */
	function onDisk(label: string): string {
		const l = fresh(label, { backup: false });
		const wl = l.openWorkload({ by: "orch", brief: "x", stakes: "normal", mode: "autonomous" });
		l.recordEntry({ by: "lane-m8", workloadId: wl, kind: "assumption", body: fact(1, "m8-a-wl1", SHIPYARD, "/fixture/a.md:1-2", "read me") });
		const path = l.path;
		l.close();
		const raw = new Database(path);
		raw.exec("PRAGMA journal_mode = DELETE");
		raw.close();
		return path;
	}

	test("reads facts, refuses writes, leaves journal_mode and the file's bytes alone, takes no backup", () => {
		const path = onDisk("readonly");
		const before = readFileSync(path);
		const backups = join(dirname(path), "backups");
		expect(existsSync(backups)).toBe(false);

		const r = Ledger.open(path, { readonly: true });
		expect(r.facts(SHIPYARD).map((f) => f.text)).toEqual(["read me"]);
		const wl = r.db.query<{ id: string }, []>("SELECT id FROM workloads").get()!.id;
		expect(() => r.recordEntry({ by: "lane-m8", workloadId: wl, kind: "assumption", body: "a write" })).toThrow(/readonly/i);
		expect(r.backupIfDue(true)).toBeNull();
		expect(r.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode).toBe("delete");
		r.close();

		expect(readFileSync(path).equals(before)).toBe(true);
		expect(existsSync(backups)).toBe(false);
		expect(existsSync(`${path}-wal`)).toBe(false);
		const raw = new Database(path, { readonly: true });
		expect(raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode).toBe("delete");
		expect(raw.query<{ n: number }, []>("SELECT count(*) AS n FROM entries").get()!.n).toBe(1);
		raw.close();

		// Control: the same open without `readonly` does switch to WAL and take the due copy.
		Ledger.open(path).close();
		expect(existsSync(backups)).toBe(true);
	});

	test("reads a WAL ledger while a writer holds it open", () => {
		const w = fresh("readonly-wal", { backup: false });
		const wl = w.openWorkload({ by: "orch", brief: "x", stakes: "normal", mode: "autonomous" });
		w.recordEntry({ by: "lane-m8", workloadId: wl, kind: "assumption", body: fact(2, "m8-a-wl1", WEB, "/fixture/b.md:1-2", "live writer") });
		const r = Ledger.open(w.path, { readonly: true });
		expect(r.facts(WEB).map((f) => f.text)).toEqual(["live writer"]);
		w.recordEntry({ by: "lane-m8", workloadId: wl, kind: "assumption", body: fact(3, "m8-a-wl1", WEB, "/fixture/b.md:3-4", "written after") });
		expect(r.facts(WEB).map((f) => f.text)).toEqual(["live writer", "written after"]);
		expect(() => r.recordEntry({ by: "lane-m8", workloadId: wl, kind: "assumption", body: "a write" })).toThrow(/readonly/i);
		r.close();
		w.close();
	});

	test("refused together with create, and nothing is created", () => {
		const path = join(scratch("readonly-create"), "ledger.db");
		expect(() => Ledger.open(path, { readonly: true, create: true })).toThrow(/readonly/);
		expect(existsSync(path)).toBe(false);
	});

	test("a missing file is refused, and an unsupported schema version is refused unchanged", () => {
		expect(() => Ledger.open(join(scratch("readonly-missing"), "ledger.db"), { readonly: true })).toThrow(/no ledger at/);
		const path = onDisk("readonly-version");
		const raw = new Database(path);
		raw.exec("PRAGMA user_version = 4");
		raw.close();
		const before = readFileSync(path);
		expect(() => Ledger.open(path, { readonly: true })).toThrow(LedgerSchemaVersionError);
		expect(readFileSync(path).equals(before)).toBe(true);
	});
});
