// The quota watch (PLAN wl-mw0vs9uc3xqtka D7, R17): watch.py's active rules ported, polls.jsonl kept readable by
// classifier/src/headroom.ts, and nothing raised while Plumb's quota-watch plist is installed. Every pass runs on an
// injected clock (`at`, epoch ms) and an injected usage reader; no test reads the machine's clock or runs omp.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { headroom } from "../../classifier/src/headroom";
import {
	ACTIVE_S, MIN_POLL_GAP_S, parseUsage, POLL_FAILED_KEY, pollLine, type QuotaWatchDeps, quotaWatchDeps, quotaWatchPlistPath, runQuotaWatch,
} from "../src/quota-watch";
import { tmp } from "./helpers";

const T0 = Date.parse("2026-11-03T10:00:00.000Z");
const MIN = 60_000;
// Six days before its reset and 30 min into its 5 h window: too early in either window for headroom's pace projection,
// so the read-back test sees only the 5 h ceiling rule.
const RESET_7D = T0 + 6 * 24 * 60 * MIN;
const RESET_5H = T0 + 270 * MIN;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const newDir = (): string => {
	const d = tmp("quota-watch");
	dirs.push(d);
	return d;
};

/**
 * `omp usage --json` stdout for rows keyed like watch.py's (`provider/window[/meter]`), each with one reports limit. As in
 * omp's real output, a model meter (`fable`) is the limit's tier and the shared `chat` meter is not.
 */
function usage(rows: Record<string, number>): string {
	const capacity: Record<string, unknown[]> = {};
	const reports: Array<{ provider: string; limits: unknown[] }> = [];
	for (const [key, used] of Object.entries(rows)) {
		const [provider, window, meter] = key.split("/") as [string, string, string | undefined];
		(capacity[provider] ??= []).push({ window, ...(meter ? { meter } : {}), accounts: 1, usedAccounts: used, remainingAccounts: 1 - used });
		let rep = reports.find((r) => r.provider === provider);
		if (!rep) reports.push((rep = { provider, limits: [] }));
		rep.limits.push({
			id: `${provider}:${window}`,
			scope: { provider, windowId: window, ...(meter && meter !== "chat" ? { tier: meter } : {}), shared: true },
			window: { id: window, resetsAt: window === "5h" ? RESET_5H : RESET_7D },
			amount: { usedFraction: used, unit: "percent" },
		});
	}
	return JSON.stringify({ generatedAt: T0, reports, capacity });
}

/** A watch over `dir` whose reader returns each of `reads` in turn (an Error is thrown), counting its calls. */
function watch(dir: string, o: { installed?: boolean | Error } = {}) {
	const reads: Array<string | Error> = [];
	let calls = 0;
	const pass = (at: number, read?: string | Error) => {
		if (read !== undefined) reads.push(read);
		const deps: QuotaWatchDeps = {
			dir,
			now: at,
			readUsage: () => {
				calls++;
				const r = reads.shift();
				if (r === undefined) throw new Error("test: no usage queued for this read");
				if (r instanceof Error) throw r;
				return r;
			},
			plistInstalled: () => {
				if (o.installed instanceof Error) throw o.installed;
				return o.installed ?? false;
			},
		};
		return runQuotaWatch(deps);
	};
	return { pass, calls: () => calls };
}

const keys = (r: { subjects: Array<{ key: string }> }) => r.subjects.map((s) => s.key);
/** A polls.jsonl line as watch.py writes it (Python's json.dumps spacing), at `atMs`. */
const pyPoll = (atMs: number, rows: Record<string, number>) =>
	`{"t": ${atMs / 1000}, "rows": ${JSON.stringify(rows).replaceAll(":", ": ").replaceAll(",", ", ")}, "limits": []}\n`;

describe("level rule (watch.py LEVELS 0.70 / 0.85 / 0.95)", () => {
	for (const level of [70, 85, 95]) {
		test(`${level}% fires at ${level}% and not at ${level - 0.01}%`, () => {
			const below = watch(newDir());
			const r0 = below.pass(T0, usage({ "anthropic/7d": (level - 0.01) / 100 }));
			expect(r0.error).toBeNull();
			expect(keys(r0)).not.toContain(`quota:anthropic/7d:level-${level}`);

			const at = watch(newDir());
			const r1 = at.pass(T0, usage({ "anthropic/7d": level / 100 }));
			expect(r1.error).toBeNull();
			const s = r1.subjects.find((x) => x.key === `quota:anthropic/7d:level-${level}`);
			expect(s).toEqual({
				key: `quota:anthropic/7d:level-${level}`,
				kind: "quota",
				workloadId: null,
				startLevel: 2,
				title: `Quota: anthropic/7d crossed ${level}%`,
				text: `anthropic/7d is ${level}% used (crossed ${level}%).`,
				next: expect.stringContaining(`ack quota:anthropic/7d:level-${level}`),
			});
		});
	}

	test("a jump past several levels is one subject for the highest; a level fires once until use falls more than 0.20 below it", () => {
		const dir = newDir();
		const w = watch(dir);
		expect(keys(w.pass(T0, usage({ "openai-codex/7d/chat": 0.9 })))).toEqual(["quota:openai-codex/7d/chat:level-85"]);
		// Still above 0.85: nothing new fires (the log names every firing).
		const again = w.pass(T0 + 5 * MIN, usage({ "openai-codex/7d/chat": 0.9 }));
		expect(again.log.filter((l) => l.includes(" fired: "))).toEqual([]);
		// 0.65 is exactly 0.20 below 0.85: no reset, so 0.70 does not fire again.
		const exact = w.pass(T0 + 10 * MIN, usage({ "openai-codex/7d/chat": 0.65 }));
		expect(exact.log.filter((l) => l.includes(" fired: "))).toEqual([]);
		expect(w.pass(T0 + 15 * MIN, usage({ "openai-codex/7d/chat": 0.7 })).log.filter((l) => l.includes(" fired: "))).toEqual([]);
		// 0.6499 is more than 0.20 below: the window reset, and 0.70 fires again.
		w.pass(T0 + 20 * MIN, usage({ "openai-codex/7d/chat": 0.6499 }));
		const refired = w.pass(T0 + 25 * MIN, usage({ "openai-codex/7d/chat": 0.7 }));
		expect(refired.log.filter((l) => l.includes(" fired: "))).toEqual(["quota watch: quota:openai-codex/7d/chat:level-70 fired: openai-codex/7d/chat is 70% used (crossed 70%)."]);
		expect(keys(refired)).toEqual(["quota:openai-codex/7d/chat:level-70", "quota:openai-codex/7d/chat:level-85"]);
	});

	test("watch.py's state.json carries over: a level it already alerted on does not fire again", () => {
		const dir = newDir();
		writeFileSync(join(dir, "state.json"), JSON.stringify({ "anthropic/7d": 0.85, "burn-alerted:anthropic/7d": T0 / 1000 - 600, "kimi-remind": "2026-11-03" }, null, 1));
		const r = watch(dir).pass(T0, usage({ "anthropic/7d": 0.9 }));
		expect(r).toMatchObject({ subjects: [], error: null });
		const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
		expect(state).toMatchObject({ "anthropic/7d": 0.85, "burn-alerted:anthropic/7d": T0 / 1000 - 600, "kimi-remind": "2026-11-03" });
	});
});

describe("burning-fast rule (5 points / 60 min for /7d, 15 points / 30 min otherwise)", () => {
	const cases = [
		{ key: "anthropic/7d", span: 60, from: 0.1, at: 0.15, below: 0.1499, points: 5 },
		{ key: "anthropic/7d/fable", span: 60, from: 0.2, at: 0.25, below: 0.2499, points: 5 },
		{ key: "anthropic/5h", span: 30, from: 0.1, at: 0.25, below: 0.2499, points: 15 },
	];
	for (const c of cases) {
		test(`${c.key}: +${c.points} points over ${c.span} min fires, +${c.points - 0.01} does not, nor +${c.points} over ${c.span - 1} min`, () => {
			const run = (oldAgeMin: number, now: number) => {
				const dir = newDir();
				writeFileSync(join(dir, "polls.jsonl"), pyPoll(T0 - oldAgeMin * MIN, { [c.key]: c.from }));
				return watch(dir).pass(T0, usage({ [c.key]: now }));
			};
			const fired = run(c.span, c.at);
			expect(fired.error).toBeNull();
			expect(fired.subjects.find((s) => s.key === `quota:${c.key}:burn`)).toMatchObject({
				kind: "quota",
				startLevel: 2,
				workloadId: null,
				text: `${c.key} burning fast: +${c.points} points in ${c.span} min (now ${Math.round(c.at * 100)}%)`,
			});
			expect(keys(run(c.span, c.below))).not.toContain(`quota:${c.key}:burn`);
			expect(keys(run(c.span - 1, c.at))).not.toContain(`quota:${c.key}:burn`);
		});
	}

	test("a burn fires at most once per key per span, then again once the span has passed", () => {
		const dir = newDir();
		writeFileSync(join(dir, "polls.jsonl"), pyPoll(T0 - 60 * MIN, { "anthropic/7d": 0.1 }) + pyPoll(T0 - 59 * MIN, { "anthropic/7d": 0.1 }));
		const w = watch(dir);
		const fired = (r: { log: string[] }) => r.log.filter((l) => l.includes(":burn fired"));
		expect(fired(w.pass(T0, usage({ "anthropic/7d": 0.2 })))).toHaveLength(1);
		// One minute later the poll 60 min back still shows +10, but the last burn alert is under 60 min old.
		expect(fired(w.pass(T0 + MIN, usage({ "anthropic/7d": 0.2 })))).toEqual([]);
		// 60 min after the first alert, against the pass's own poll at T0 (0.20), +5 fires again.
		expect(fired(w.pass(T0 + 60 * MIN, usage({ "anthropic/7d": 0.25 })))).toHaveLength(1);
	});

	test("watch.py's burn-alerted time (epoch seconds) in state.json holds the next burn back", () => {
		const dir = newDir();
		writeFileSync(join(dir, "polls.jsonl"), pyPoll(T0 - 60 * MIN, { "anthropic/5h": 0.1 }));
		writeFileSync(join(dir, "state.json"), JSON.stringify({ "burn-alerted:anthropic/5h": T0 / 1000 - 29 * 60 }));
		expect(keys(watch(dir).pass(T0, usage({ "anthropic/5h": 0.5 })))).not.toContain("quota:anthropic/5h:burn");
	});
});

describe("failed usage reads", () => {
	test("every failed read is the pass's error; the third in a row is a quota subject, and a good read resets the count", () => {
		const dir = newDir();
		const w = watch(dir);
		const fail = (i: number) => new Error(`omp usage --json exited 1: boom ${i}`);
		const r1 = w.pass(T0, fail(1));
		expect(r1.error).toBe("quota watch: omp usage read failed (1 in a row): omp usage --json exited 1: boom 1");
		expect(r1.subjects).toEqual([]);
		expect(w.pass(T0 + 5 * MIN, fail(2)).subjects).toEqual([]);
		const r3 = w.pass(T0 + 10 * MIN, fail(3));
		expect(r3.error).toBe("quota watch: omp usage read failed (3 in a row): omp usage --json exited 1: boom 3");
		expect(r3.subjects).toEqual([
			{
				key: POLL_FAILED_KEY,
				kind: "quota",
				workloadId: null,
				startLevel: 2,
				title: "Quota watch cannot read omp usage (3 polls in a row)",
				text: "Quota watcher cannot read omp usage (3 polls in a row): omp usage --json exited 1: boom 3",
				next: expect.stringContaining(`ack ${POLL_FAILED_KEY}`),
			},
		]);
		expect(existsSync(join(dir, "polls.jsonl"))).toBe(false);

		const fresh = watch(newDir());
		fresh.pass(T0, fail(1));
		fresh.pass(T0 + 5 * MIN, fail(2));
		expect(fresh.pass(T0 + 10 * MIN, usage({ "anthropic/7d": 0.1 })).error).toBeNull();
		const after = fresh.pass(T0 + 15 * MIN, fail(4));
		expect(after.error).toContain("(1 in a row)");
		expect(after.subjects).toEqual([]);
	});

	test("output that is not omp's usage JSON is a failed read, named", () => {
		const r = watch(newDir()).pass(T0, "Error: not logged in\n");
		expect(r.error).toStartWith("quota watch: omp usage read failed (1 in a row): omp usage --json printed no JSON");
		expect(r.error).toContain("not logged in");
		expect(() => parseUsage(JSON.stringify({ capacity: { anthropic: [{ window: "7d", accounts: 1 }] } }))).toThrow("capacity.anthropic/7d usedAccounts is undefined");
	});

	test("an unreadable state.json is the error, left untouched, and nothing is polled", () => {
		const dir = newDir();
		writeFileSync(join(dir, "state.json"), "{ half");
		const w = watch(dir);
		const r = w.pass(T0, usage({ "anthropic/7d": 0.99 }));
		expect(r.error).toStartWith(`quota watch: ${join(dir, "state.json")} is not JSON`);
		expect(r.subjects).toEqual([]);
		expect(w.calls()).toBe(0);
		expect(readFileSync(join(dir, "state.json"), "utf8")).toBe("{ half");
	});
});

describe("polls.jsonl stays readable by classifier/src/headroom.ts", () => {
	test("the line a pass appends is read back by headroom's reader: limits, reset times and the 5h ceiling", () => {
		const dir = newDir();
		const r = watch(dir).pass(T0, usage({ "anthropic/7d": 0.42, "anthropic/7d/fable": 0.06, "anthropic/5h": 0.81, "openai-codex/7d/chat": 0.57 }));
		expect(r.error).toBeNull();
		const lines = readFileSync(join(dir, "polls.jsonl"), "utf8").split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toEqual({
			t: T0 / 1000,
			rows: { "anthropic/7d": 0.42, "anthropic/7d/fable": 0.06, "anthropic/5h": 0.81, "openai-codex/7d/chat": 0.57 },
			limits: [
				{ provider: "anthropic", windowId: "7d", tier: null, resetsAt: RESET_7D, usedFraction: 0.42 },
				{ provider: "anthropic", windowId: "7d", tier: "fable", resetsAt: RESET_7D, usedFraction: 0.06 },
				{ provider: "anthropic", windowId: "5h", tier: null, resetsAt: RESET_5H, usedFraction: 0.81 },
				{ provider: "openai-codex", windowId: "7d", tier: null, resetsAt: RESET_7D, usedFraction: 0.57 },
			],
		});
		const h = headroom({ path: join(dir, "polls.jsonl"), now: T0 + MIN });
		expect(h.note).toBeNull();
		expect(h.anthropicWeek).toEqual({ used: 0.42, resetsAt: RESET_7D });
		expect(h.decisionFor("anthropic/claude-opus-5").out).toBe("anthropic 5h 0.81 used > 0.80");
		expect(h.decisionFor("openai-codex/gpt-6").out).toBeNull();
	});

	test("a limit omp reports without scope fields is written with nulls, as watch.py writes it, and headroom skips it", () => {
		const snap = parseUsage(JSON.stringify({ capacity: {}, reports: [{ limits: [{ id: "x" }] }] }));
		expect(snap.limits).toEqual([{ provider: null, windowId: null, tier: null, resetsAt: null, usedFraction: null }]);
		const h = headroom({ lines: [pollLine(T0, snap)], now: T0 });
		expect(h.note).toBeNull();
		expect(h.anthropicWeek).toBeNull();
	});
});

describe("Plumb's watcher installed", () => {
	test("while its plist exists the step only logs: no read, no poll line, no subject, even at 99%", () => {
		const dir = newDir();
		const w = watch(dir, { installed: true });
		const r = w.pass(T0, usage({ "anthropic/7d": 0.99 }));
		expect(r).toEqual({ subjects: [], error: null, log: [expect.stringContaining("com.agent-system-2.quota-watch.plist")] });
		expect(w.calls()).toBe(0);
		expect(existsSync(join(dir, "polls.jsonl"))).toBe(false);
		expect(existsSync(join(dir, "state.json"))).toBe(false);
	});

	test("subjects already fired are not raised while the plist is back", () => {
		const dir = newDir();
		expect(keys(watch(dir).pass(T0, usage({ "anthropic/7d": 0.99 })))).toEqual(["quota:anthropic/7d:level-95"]);
		expect(watch(dir, { installed: true }).pass(T0 + 5 * MIN).subjects).toEqual([]);
	});

	test("a plist that cannot be checked is the error, and nothing is polled", () => {
		const w = watch(newDir(), { installed: new Error("EACCES: permission denied") });
		const r = w.pass(T0, usage({ "anthropic/7d": 0.99 }));
		expect(r.subjects).toEqual([]);
		expect(r.error).toContain("EACCES: permission denied");
		expect(w.calls()).toBe(0);
	});

	test("the real seams: AS2_QUOTA_DIR names the directory, and the plist is read under HOME's LaunchAgents", () => {
		const home = newDir();
		const deps = quotaWatchDeps({ HOME: home, AS2_QUOTA_DIR: join(home, "q") }, T0);
		expect(deps.dir).toBe(join(home, "q"));
		expect(deps.plistInstalled()).toBe(false);
		mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
		writeFileSync(quotaWatchPlistPath(home), "<plist/>\n");
		expect(deps.plistInstalled()).toBe(true);
	});
});

describe("subject lifetime and poll cadence", () => {
	test("a fired subject stays active for 24 h after it fired, then drops", () => {
		const dir = newDir();
		const w = watch(dir);
		const steady = usage({ "anthropic/7d": 0.72 });
		expect(keys(w.pass(T0, steady))).toEqual(["quota:anthropic/7d:level-70"]);
		expect(keys(w.pass(T0 + (ACTIVE_S - 1) * 1000, steady))).toEqual(["quota:anthropic/7d:level-70"]);
		expect(keys(w.pass(T0 + ACTIVE_S * 1000, steady))).toEqual([]);
	});

	test(`a pass under ${MIN_POLL_GAP_S} s after the last attempt does not poll, keeps the subjects and repeats the last read's error`, () => {
		const dir = newDir();
		const w = watch(dir);
		expect(keys(w.pass(T0, usage({ "anthropic/7d": 0.9 })))).toEqual(["quota:anthropic/7d:level-85"]);
		const soon = w.pass(T0 + (MIN_POLL_GAP_S - 1) * 1000);
		expect(w.calls()).toBe(1);
		expect(keys(soon)).toEqual(["quota:anthropic/7d:level-85"]);
		expect(soon.error).toBeNull();
		expect(readFileSync(join(dir, "polls.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);

		w.pass(T0 + MIN_POLL_GAP_S * 1000, new Error("omp usage --json timed out after 120 s and was killed"));
		expect(w.calls()).toBe(2);
		const held = w.pass(T0 + (MIN_POLL_GAP_S + 30) * 1000);
		expect(w.calls()).toBe(2);
		expect(held.error).toBe("quota watch: omp usage read failed (1 in a row): omp usage --json timed out after 120 s and was killed (the attempt 30 s ago)");
	});
});
