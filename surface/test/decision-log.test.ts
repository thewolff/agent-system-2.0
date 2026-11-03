// The decision log read as context at workload open (entries newer than the last 2.0 workload on
// the repo; superseded ones dropped) and rendered at close (filename scheme, frontmatter scalars,
// the four headings, content from the ledger).
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DECISION_LOG_ENTRY_BYTES, DECISION_LOG_MAX_BYTES, decisionLogContext, lastWorkloadOn, localOffset, NOT_RENDERED, parseFrontmatter, readLog, recordRepo, renderClose, renderLogContext, repoOf, section, stamp } from "../src/decision-log";
import { recordIdentity } from "../src/identity";
import { clock, tempLedger, tmp, workloadWithSlice } from "./helpers";

const entry = (dir: string, name: string, fm: Record<string, string>, body: string) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}`);
};

describe("read at open", () => {
	test("frontmatter is read the plugin parser's way: lower-cased keys, quotes and # comments stripped", () => {
		const { frontmatter, body } = parseFrontmatter('---\nStatus: "resolved" # done\ndurable: true\n---\n\n# T\n\nbody');
		expect(frontmatter).toEqual({ status: "resolved", durable: "true" });
		expect(body.trim()).toBe("# T\n\nbody");
		expect(parseFrontmatter("no frontmatter").frontmatter).toEqual({});
	});

	test("entries newer than the last 2.0 workload on the repo are rendered; superseded ones dropped; sections extracted", () => {
		const c = clock("2026-10-05T12:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const repo = tmp("repo");
		const dir = join(repo, ".ai", "decision-log");
		entry(dir, "2026-10-01--0900--plumb--old-one.md", { status: "resolved", durable: "false", date: "2026-10-01T09:00:00Z" }, "## Decisions made (and why)\n\n- old decision\n");
		entry(dir, "2026-10-03--0900--plumb--superseded-one.md", { status: "resolved", date: "2026-10-03T09:00:00Z" }, "## Decisions made (and why)\n\n- superseded decision\n");
		entry(dir, "2026-10-04--0900--plumb--new-one.md", { status: "open", durable: "true", supersedes: "2026-10-03--0900--plumb--superseded-one.md", date: "2026-10-04T09:00:00Z" }, "# New\n\n## What changed\n\n- x\n\n## Decisions made (and why)\n\n- new decision\n\n## Heads-up for whoever touches this next\n\n- watch out\n");
		expect(readLog(dir).map((e) => basename(e.path))).toEqual(["2026-10-01--0900--plumb--old-one.md", "2026-10-03--0900--plumb--superseded-one.md", "2026-10-04--0900--plumb--new-one.md"]);
		// a prior 2.0 workload on this repo closed on 2026-10-02
		c.at("2026-10-02T00:00:00.000Z");
		const prior = ledger.openWorkload({ by: "surface", brief: "earlier", stakes: "normal", mode: "autonomous" });
		recordRepo(ledger, prior, repo);
		ledger.closeWorkload(prior, { by: "surface" });
		expect(lastWorkloadOn(ledger, repo)).toBe("2026-10-02T00:00:00.000Z");
		expect(repoOf(ledger, prior)).toBe(repo);
		expect(lastWorkloadOn(ledger, "/elsewhere")).toBeNull();
		const text = decisionLogContext(dir, { since: lastWorkloadOn(ledger, repo), now: "2026-10-05T12:00:00.000Z" });
		expect(text).toContain("since the last 2.0 workload closed 2026-10-02T00:00:00.000Z");
		expect(text).toContain("new decision");
		expect(text).toContain("watch out");
		expect(text).not.toContain("old decision");
		expect(text).not.toContain("superseded decision");
		// no prior workload: the last 14 days, capped
		const all = decisionLogContext(dir, { since: null, now: "2026-10-05T12:00:00.000Z" });
		expect(all).toContain("old decision");
		expect(all).not.toContain("superseded decision");
		expect(decisionLogContext(join(repo, "nope"))).toBe("");
		expect(section("## A\n\nx\n\n## B\n\ny", "B")).toBe("y");
	});
});

describe("byte budget at open", () => {
	const now = "2026-10-12T12:00:00.000Z";
	const bigDecisions = (tag: string, kb: number) => Array.from({ length: kb * 10 }, (_, i) => `- ${tag} decision ${i} ${"x".repeat(80)}`).join("\n");

	test("a 100 KB entry renders within its share, cut at a line boundary, with a truncation line naming the file", () => {
		const dir = join(tmp("repo"), ".ai", "decision-log");
		const name = "2026-10-10--0900--ilex--huge.md";
		entry(dir, name, { status: "resolved", date: "2026-10-10T09:00:00Z" }, `## Decisions made (and why)\n\n${bigDecisions("huge", 100)}\n\n## Heads-up\n\n- watch out\n`);
		expect(readFileSync(join(dir, name), "utf8").length).toBeGreaterThan(100_000);
		const text = decisionLogContext(dir, { now });
		const header = "# Decision log for this repository (1 entry from the last 14 days)\n\n";
		expect(text.startsWith(header)).toBe(true);
		expect(Buffer.byteLength(text.slice(header.length), "utf8")).toBeLessThanOrEqual(DECISION_LOG_ENTRY_BYTES);
		const lines = text.split("\n");
		expect(lines.at(-1)).toMatch(new RegExp(`^… \\(truncated: \\d+ more lines; read ${name.replace(/\./g, "\\.")} for the rest\\)$`));
		// every kept line is a whole source line
		const kept = lines.filter((l) => l.startsWith("- huge decision"));
		expect(kept.length).toBeGreaterThan(0);
		for (const l of kept) expect(l).toMatch(/^- huge decision \d+ x{80}$/);
		const more = Number(/truncated: (\d+) more/.exec(lines.at(-1)!)![1]);
		// the section heading is kept too; the dropped count covers the rest of the decisions plus the Heads-up heading and its line
		expect(1 + kept.length + more).toBe(1 + 1000 + 1 + 1);
	});

	test("once the budget is spent the older entries are listed by name only, and the whole rendering fits", () => {
		const dir = join(tmp("repo"), ".ai", "decision-log");
		const names = Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}--0900--ilex--big-${i}.md`);
		names.forEach((n, i) => entry(dir, n, { status: "resolved" }, `## Decisions made (and why)\n\n${bigDecisions(`e${i}`, 40)}\n`));
		const text = decisionLogContext(dir, { now });
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DECISION_LOG_MAX_BYTES);
		expect(text).toContain("(10 entries from the last 14 days)");
		const [rendered, listed] = text.split(`\n${NOT_RENDERED}\n`) as [string, string];
		expect(listed).toBeDefined();
		const listedNames = listed.split("\n").map((l) => l.replace(/^- /, ""));
		const renderedNames = names.filter((n) => rendered.includes(`## ${n} (`));
		// newest rendered, oldest listed, nothing lost, nothing twice
		expect(renderedNames.length).toBeGreaterThan(0);
		expect([...listedNames, ...renderedNames].sort()).toEqual([...names].sort());
		expect(readLog(dir).map((e) => basename(e.path)).slice(-renderedNames.length)).toEqual(renderedNames);
		// a tighter budget on the same log: fewer rendered, still within it
		const tight = decisionLogContext(dir, { now, maxBytes: 4096, entryBytes: 2048 });
		expect(Buffer.byteLength(tight, "utf8")).toBeLessThanOrEqual(4096);
		expect(tight).toContain(NOT_RENDERED);
	});

	test("small entries render exactly as before", () => {
		const dir = join(tmp("repo"), ".ai", "decision-log");
		entry(dir, "2026-10-10--0900--plumb--a.md", { status: "resolved", durable: "true", date: "2026-10-10T09:00:00Z" }, "## Decisions made (and why)\n\n- one\n- two\n\n## Dead ends\n\n- tried x\n\n## Heads-up for whoever touches this next\n\n- careful\n");
		entry(dir, "2026-10-11--0900--plumb--b.md", { status: "open", date: "2026-10-11T09:00:00Z" }, "# B\n\nno headings here\n");
		expect(decisionLogContext(dir, { now })).toBe(
			[
				"# Decision log for this repository (2 entries from the last 14 days)",
				"",
				"## 2026-10-10--0900--plumb--a.md (plumb, resolved, durable: true)",
				"### Decisions made (and why)",
				"- one\n- two",
				"### Dead ends",
				"- tried x",
				"### Heads-up",
				"- careful",
				"",
				"## 2026-10-11--0900--plumb--b.md (plumb, open)",
				"# B\n\nno headings here",
			].join("\n"),
		);
	});

	const since = "2026-10-01T00:00:00.000Z";
	const body = (b: string) => `## Decisions made (and why)\n\n${b}\n\n## Heads-up\n\n- watch out\n`;
	const shape = (n: number, b: string, longName = false) => {
		const dir = join(tmp("repo"), ".ai", "decision-log");
		for (let i = 0; i < n; i++) entry(dir, `2026-10-10--1200--reviewer--${String(i).padStart(4, "0")}${longName ? `-${"界".repeat(65)}` : ""}.md`, { status: "active", date: "2026-10-10T12:00:00Z" }, body(b));
		return dir;
	};
	// seeded, so a failure reproduces
	let seed = 0x5eed;
	const rand = (max: number) => {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		return seed % (max + 1);
	};
	const budgets = (dense: number, sparse: number[], random: number) => [...Array.from({ length: dense + 1 }, (_, i) => i), ...sparse, ...Array.from({ length: random }, () => rand(40_000))];
	const shapes = {
		since: { label: "1,000 since-entries", dir: "", maxBytes: budgets(80, [127, 128, 129, 200, 500, 4096, 8192, DECISION_LOG_MAX_BYTES], 12) },
		names: { label: "50 long multibyte filenames", dir: "", maxBytes: budgets(300, [4096], 40) },
		small: { label: "one small entry", dir: "", maxBytes: budgets(300, [], 40) },
		bodies: { label: "multibyte bodies", dir: "", maxBytes: budgets(400, [4096, DECISION_LOG_MAX_BYTES], 40) },
	};
	beforeAll(() => {
		shapes.since.dir = shape(1000, "- small decision");
		shapes.names.dir = shape(50, "x".repeat(100), true);
		shapes.small.dir = shape(1, "- small decision");
		shapes.bodies.dir = shape(10, `${"- 決定 é ✓ 🙂 ".repeat(20)}\n`.repeat(400));
	});
	for (const s of Object.values(shapes)) {
		describe(s.label, () => {
			for (let start = 0; start < s.maxBytes.length; start += 16) {
				const batch = s.maxBytes.slice(start, start + 16);
				test(`maxBytes cases ${start + 1}-${start + batch.length} stay within their UTF-8 byte bound without broken code points`, () => {
					const entries = readLog(s.dir);
					for (const maxBytes of batch) {
						const out = renderLogContext(entries, s.dir, { now, since, maxBytes });
						expect({ shape: s.label, maxBytes, bytes: Buffer.byteLength(out, "utf8") <= maxBytes ? "within" : Buffer.byteLength(out, "utf8") }).toEqual({ shape: s.label, maxBytes, bytes: "within" });
						// never a broken code point
						expect(out.includes("\uFFFD")).toBe(false);
					}
				});
			}
		});
	}
	test("1,000 since-entries are accounted for, the newest unrendered name is listed, and clipped/zero budgets hold", () => {
		// the reviewer's 1,000-entry shape at the default cap: since is not capped, the list is bounded, and every entry is accounted for
		const dir = shapes.since.dir;
		const text = decisionLogContext(dir, { now, since });
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DECISION_LOG_MAX_BYTES);
		expect(text).toContain("(1000 entries since the last 2.0 workload closed");
		const more = new RegExp(`^… and (\\d+) more not rendered; read ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} for the rest$`).exec(text.split("\n").at(-1)!);
		expect(more).not.toBeNull();
		const rendered = (text.match(/^## /gm) ?? []).length;
		const listed = (text.match(/^- 2026-/gm) ?? []).length;
		expect(rendered + listed + Number(more![1])).toBe(1000);
		// the listed names are the newest of the unrendered ones
		expect(text.split(`${NOT_RENDERED}\n`)[1]!.split("\n")[0]).toBe(`- 2026-10-10--1200--reviewer--${String(1000 - rendered - listed).padStart(4, "0")}.md`);
		// below the header line, the header clipped to fit; zero bytes, nothing
		expect(decisionLogContext(shapes.small.dir, { now, since, maxBytes: 20 })).toBe("# Decision log fo…"); // 17 bytes and a 3-byte ellipsis
		expect(decisionLogContext(shapes.small.dir, { now, since, maxBytes: 0 })).toBe("");
	});
});

describe("render at close", () => {
	test("one entry in the filename scheme with the frontmatter scalars and four headings, from the ledger, authored by the orchestrator's name", () => {
		const c = clock("2026-10-06T15:04:00.000Z");
		const { ledger } = tempLedger(c.now);
		recordIdentity(ledger, "Sable Quill", "they/them");
		const { wl, sl } = workloadWithSlice(ledger, { brief: "Fix the feed header offset" });
		const sl2 = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "Try a media query first", doneCondition: "x", inputs: "a.css" });
		ledger.cancelSlice(sl2, { by: "lane-a" });
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Token name?", options: ["header-offset", "nav-offset"] });
		ledger.answerQuestion(q, { by: "surface", answer: "header-offset", author: "jo", channel: "surface" });
		ledger.recordInstruction({ by: "surface", workloadId: wl, body: "keep the old class name too", author: "jo", channel: "surface" });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "assumption", body: "the token lives in tokens.css" });
		ledger.completeSlice(sl, { by: "lane-a", artifact: "bun test exit 0" });
		const dir = join(tmp("log"), "decision-log");
		const r = renderClose(ledger, wl, dir, { name: "Sable Quill", pronouns: "they/them", entryId: "en-x" }, { now: c.now(), session: "sess-1" });
		const { day, hhmm } = stamp(c.now());
		expect(basename(r.path)).toBe(`${day}--${hhmm}--sable-quill--fix-the-feed-header-offset.md`);
		expect(existsSync(r.path)).toBe(true);
		const text = readFileSync(r.path, "utf8");
		const { frontmatter } = parseFrontmatter(text);
		expect(frontmatter).toMatchObject({ status: "resolved", durable: "false", supersedes: "", session: "sess-1", date: localOffset(c.now()), engineer: "Sable Quill" });
		expect(Date.parse(frontmatter.date!)).toBe(Date.parse(c.now()));
		expect(section(text, "What changed")).toContain(`${sl}: Move the header offset into a token — artifact: bun test exit 0`);
		expect(section(text, "Decisions made")).toContain('jo answered "header-offset"');
		expect(section(text, "Decisions made")).toContain("keep the old class name too");
		expect(section(text, "Decisions made")).toContain("the token lives in tokens.css");
		expect(section(text, "Dead ends")).toContain(`${sl2} cancelled: Try a media query first`);
		expect(section(text, "Heads-up")).toBe("- none");
		expect(text).toContain("Rendered from the ledger by Sable Quill (they/them)");
	});

	test("write: false renders without touching disk; a missing workload throws", () => {
		const { ledger } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		const dir = join(tmp("log"), "decision-log");
		const r = renderClose(ledger, wl, dir, null, { write: false });
		expect(existsSync(r.path)).toBe(false);
		expect(basename(r.path)).toMatch(/--orchestrator--/);
		expect(section(r.text, "Heads-up")).toContain("still open");
		expect(() => renderClose(ledger, "wl-none", dir, null)).toThrow(/no workload/);
	});

	test("each reserved request in Heads-up says why it closed; a withdrawal is not repeated as a decision (MIGRATION.md item 31)", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		expect(ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 }).won).toBe(true);
		const request = (body: string, by = "lane-a") => ledger.recordEntry({ by, workloadId: wl, sliceId: sl, kind: "reserved-request", body });
		const decide = (word: string, en: string) => ledger.recordInstruction({ by: "surface", workloadId: wl, body: `${word} ${en}`, author: "jo", channel: "surface" });
		const approved = request("push: git push origin main (P-11 row 6 refused tool call c1)");
		decide("approve", approved);
		const denied = request("deploy: fly deploy (P-11 row 6 refused tool call c2)");
		decide("deny", denied);
		const stopped = request("kubectl: kubectl delete ns x (P-11 row 6 refused tool call c5)");
		ledger.releaseWorkload(wl, { by: "lane-a", holder: "lane-a" });
		// relaunched as lane-b, which still holds the workload when the log renders
		expect(ledger.claimWorkload(wl, { by: "lane-starter", holder: "lane-b", leaseMs: 3_600_000 }).won).toBe(true);
		const older = request("rm: rm -rf build (P-11 row 6 refused tool call c3)", "lane-b");
		const newer = request("rm: rm -rf build (P-11 row 6 refused tool call c4)", "lane-b");
		ledger.recordEntry({ by: "lane-b", workloadId: wl, kind: "assumption", body: `reserved-withdrawn: ${newer} built elsewhere` });
		const never = request("scp: scp a b (P-11 row 6 refused tool call c6)", "lane-9999");
		const r = renderClose(ledger, wl, join(tmp("log"), "decision-log"), null, { write: false });
		const heads = section(r.text, "Heads-up");
		expect(heads).toContain(`- reserved request ${approved}: push: git push origin main (P-11 row 6 refused tool call c1) — approved`);
		expect(heads).toContain(`- reserved request ${denied}: deploy: fly deploy (P-11 row 6 refused tool call c2) — denied`);
		expect(heads).toContain(`- reserved request ${older}: rm: rm -rf build (P-11 row 6 refused tool call c3) — superseded by ${newer}`);
		expect(heads).toContain(`- reserved request ${newer}: rm: rm -rf build (P-11 row 6 refused tool call c4) — withdrawn by lane-b: built elsewhere`);
		expect(heads).toContain(`- reserved request ${stopped}: kubectl: kubectl delete ns x (P-11 row 6 refused tool call c5) — closed: lane-a stopped holding the workload`);
		expect(heads.split("\n")).toContain(`- reserved request ${never}: scp: scp a b (P-11 row 6 refused tool call c6)`);
		expect(section(r.text, "Decisions made")).not.toContain("reserved-withdrawn");
	});
});
