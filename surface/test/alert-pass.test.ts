// The alert pass (PLAN wl-mw0vs9uc3xqtka D3; R1, R8-R24): one pass over a temp ledger with recording fakes for gh, the popup
// spawn, ps and kill. No real gh, popup or signal is ever used.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_STARTER_BY } from "../../ledger/src/index";
import { alertMarker, alertRecords, openEpisode } from "../src/alert-path";
import { nightlyFault } from "../src/chaos";
import { errorLines } from "../src/errors";
import { apply, interpret } from "../src/input";
import { ALERT_BY, alertPopupBody, controlEntries } from "../src/launch";
import { laneDiedShutdownBody } from "../src/signals";
import { ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { alertPass, lockedAlertPass } from "../scripts/alert-tick";
import { popupRegistryPath, registryLine } from "../scripts/alert-popup";
import { runQuotaWatch } from "../src/quota-watch";
import { takeRunnerLock } from "../src/runner-probe";
import { type AlertWorld, ceilingStopped, ISSUE, world } from "./alert-world";
import { tmp } from "./helpers";

describe("one pass over a ceiling-stopped workload (D3, R8)", () => {
	test("an urgent workload: the raised row, the issue with its create marker, the level-2 comment and label, and the popup kick", () => {
		const w = world();
		const wl = ceilingStopped(w.ledger, 'Jo said "fix it ASAP": move the header offset into a token');
		expect(alertPass(w.deps).problems).toEqual([]);
		const key = `ceiling:${wl}`;
		const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(key))!;
		expect(ep).toMatchObject({ opened: "raised", kind: "ceiling", start: 2, url: ISSUE });
		expect(w.rows().filter((r) => r.startsWith(`alert: ${key} raised ceiling start 2 `))).toHaveLength(1);
		expect([...ep.sent.keys()]).toEqual([1, 2]);
		const [issue] = w.g.issues;
		expect(w.g.issues).toHaveLength(1);
		expect(issue!.body).toContain(alertMarker(key, ep.id, "create"));
		expect(issue!.labels).toEqual(["as2-train", "loud"]);
		expect(issue!.comments).toHaveLength(1);
		expect(issue!.comments[0]).toContain(alertMarker(key, ep.id, "level 2"));
		expect(issue!.comments[0]).toContain("@thewolff");
		expect(w.spawns).toHaveLength(1);
		expect(w.spawns[0]!.argv.slice(-4)).toEqual([key, ep.id, "2", "1"]);
		expect(w.spawns[0]!.env).toEqual({ PATH: "/usr/bin:/bin", AS2_ALERT_POPUP_DIR: w.deps.popup.dir });
		expect(w.rows()).toContain(alertPopupBody(key, ep.id, 2, "spawning", "attempt=1"));
		// A second pass changes nothing: no second issue, comment or popup.
		const before = w.g.calls.filter((a) => a[1] === "create" || a[1] === "comment").length;
		alertPass(w.deps);
		expect(w.g.calls.filter((a) => a[1] === "create" || a[1] === "comment").length).toBe(before);
		expect(w.spawns).toHaveLength(1);
	});

	test("a workload that is not urgent starts at level 1: the issue, no comment, no popup", () => {
		const w = world();
		const wl = ceilingStopped(w.ledger, "Move the header offset into a token");
		alertPass(w.deps);
		const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(`ceiling:${wl}`))!;
		expect(ep.start).toBe(1);
		expect([...ep.sent.keys()]).toEqual([1]);
		expect(w.g.issues[0]!.comments).toEqual([]);
		expect(w.spawns).toEqual([]);
	});

	test("Jo's extend clears the subject: the issue is closed with a comment naming why, and `closed` is written", () => {
		const w = world();
		const wl = ceilingStopped(w.ledger, "Move the header offset into a token");
		alertPass(w.deps);
		const cmd = interpret(w.ledger, `ceiling 100 ${wl}`);
		if (cmd === null) throw new Error(`interpret refused "ceiling 100 ${wl}"`);
		apply(w.ledger, cmd);
		alertPass(w.deps);
		expect(w.g.issues[0]!.state).toBe("CLOSED");
		expect(w.rows().some((r) => r.startsWith(`alert: ceiling:${wl} closed `))).toBe(true);
	});
});

describe("the close comment names what cleared the alert (D8)", () => {
	/** The `--comment` of the pass's `gh issue close`, or null when it closed nothing. */
	const closeComment = (w: AlertWorld): string | null => {
		const a = w.g.calls.find((c) => c[0] === "issue" && c[1] === "close");
		return a === undefined ? null : a[a.indexOf("--comment") + 1]!;
	};
	const jo = (w: AlertWorld, text: string): void => {
		const cmd = interpret(w.ledger, text);
		if (cmd === null) throw new Error(`interpret refused "${text}"`);
		apply(w.ledger, cmd);
	};
	/** Jo's newest instruction on `wl` whose body is `body`: its id, which the close comment must cite. */
	const instructionId = (w: AlertWorld, wl: string, body: string): string => {
		const i = w.ledger.instructions(wl).filter((x) => x.author === "jo" && x.body.trim() === body).at(-1);
		if (i === undefined) throw new Error(`no Jo instruction "${body}" on ${wl}: ${JSON.stringify(w.ledger.instructions(wl).map((x) => x.body))}`);
		return i.id;
	};

	// Jo types the word; the ledger records `extend` and `ceiling` as the instruction `ceiling: <usd> <hours>` (input.ts),
	// so the comment is checked against the word Jo typed and the id of the instruction that word recorded.
	for (const [typed, said, recorded] of [["extend", "extend", "ceiling: 100 12"], ["ceiling 100", "ceiling 100 6", "ceiling: 100 6"], ["halt", "halt", "halt"]] as const) {
		test(`a ceiling cleared by Jo's \`${typed}\`: the close comment says Jo answered it, with its input id`, () => {
			const w = world();
			const wl = ceilingStopped(w.ledger, "Move the header offset into a token");
			alertPass(w.deps);
			w.c.plusHours(0.01);
			jo(w, `${typed} ${wl}`);
			alertPass(w.deps);
			const body = recorded === "halt" ? `halt ${wl}` : recorded;
			expect(closeComment(w)).toBe(`Jo answered ${said} ${wl} (${instructionId(w, wl, body)}) (as2).`);
		});
	}

	test("a died alert cleared by a relaunch names the relaunched lane and its launch row", () => {
		const w = world();
		const wl = w.ledger.openWorkload({ by: "lane-a", brief: "Fix the feed header offset", stakes: "normal", mode: "autonomous" });
		w.ledger.addSlice({ by: "lane-a", workloadId: wl, task: "Move the header offset", doneCondition: "bun test passes", inputs: "src/header.css" });
		w.ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 60_000 });
		w.ledger.releaseWorkload(wl, { by: "lane-a", holder: "lane-a" });
		w.ledger.enqueue({ by: "lane-a", workloadId: wl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedShutdownBody("lane-a", w.ledger.now(), 1) });
		alertPass(w.deps);
		expect(w.g.issues).toHaveLength(1);
		w.c.plusHours(0.01);
		const launch = w.ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-b cause relaunch requested-by test" });
		alertPass(w.deps);
		expect(closeComment(w)).toBe(`lane-b was relaunched on ${wl} (${launch}, ${w.c.now()}) (as2).`);
	});

	test("a parked alert cleared by Jo's answer names the answer, its input id and the question", () => {
		const w = world();
		const wl = w.ledger.openWorkload({ by: "lane-a", brief: "Fix the header", stakes: "normal", mode: "autonomous" });
		const sl = w.ledger.addSlice({ by: "lane-a", workloadId: wl, task: "Move it", doneCondition: "d", inputs: "i" });
		w.ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 });
		const q = w.ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which token name?", options: ["short", "long"] });
		alertPass(w.deps);
		expect(w.g.issues).toHaveLength(1);
		w.c.plusHours(0.01);
		w.ledger.answerQuestion(q, { by: SURFACE_BY, answer: "short", author: "jo", channel: "surface" });
		alertPass(w.deps);
		expect(closeComment(w)).toBe(`Jo answered short (${instructionId(w, wl, "short")}) to ${q} (as2).`);
	});
});

describe("urgency is visible where Jo reads the alert (D5)", () => {
	test("a brief citing Jo's urgent input: the issue body and the needs-you line both say `urgent (from <input id>)`", () => {
		const w = world();
		const inputId = w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: "fix the header offset, urgent", author: "jo", channel: "surface" });
		const wl = ceilingStopped(w.ledger, `input ${inputId}: move the header offset into a token`);
		alertPass(w.deps);
		const key = `ceiling:${wl}`;
		const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(key))!;
		expect(ep.start).toBe(2);
		expect(w.g.issues[0]!.body).toContain(`urgent (from ${inputId})`);
		expect(ep.words?.line).toEndWith(` — urgent (from ${inputId})`);
		// Applied once: the issue says it on one line only.
		expect(w.g.issues[0]!.body.split(`urgent (from ${inputId})`)).toHaveLength(2);
	});

	test("a workload that is not urgent: neither the issue nor the line says urgent", () => {
		const w = world();
		const wl = ceilingStopped(w.ledger, "Move the header offset into a token");
		alertPass(w.deps);
		const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(`ceiling:${wl}`))!;
		expect(w.g.issues[0]!.body).not.toContain("urgent (from");
		expect(ep.words?.line).not.toContain("urgent");
	});
});

describe("gh failures (D3: one attempt per pass, the error on the subject)", () => {
	test("a failed issue create writes `error gh`, is not retried inside the pass, and the next pass files it", () => {
		let down = true;
		const w = world({ fail: (a) => down && a[0] === "issue" && a[1] === "create" });
		const wl = ceilingStopped(w.ledger, "Move the header offset into a token");
		alertPass(w.deps);
		const key = `ceiling:${wl}`;
		expect(w.g.calls.filter((a) => a[1] === "create")).toHaveLength(1);
		expect(w.rows().filter((r) => r.startsWith(`alert: ${key} error gh `))).toHaveLength(1);
		expect(w.rows().find((r) => r.startsWith(`alert: ${key} error gh `))).toContain("HTTP 502");
		// The same failure again writes no second error row.
		alertPass(w.deps);
		expect(w.rows().filter((r) => r.startsWith(`alert: ${key} error gh `))).toHaveLength(1);
		down = false;
		alertPass(w.deps);
		expect(w.g.issues).toHaveLength(1);
		expect(w.rows().some((r) => r === `alert: ${key} level 1 sent ${ISSUE}`)).toBe(true);
	});

	test("Jo closing the issue acks the alert: `acked`, and no level is sent after it", () => {
		const w = world();
		const wl = ceilingStopped(w.ledger, "Move the header offset into a token");
		alertPass(w.deps);
		w.g.issues[0]!.state = "CLOSED";
		alertPass(w.deps);
		w.c.plusHours(9);
		alertPass(w.deps);
		expect(w.rows().filter((r) => r.startsWith(`alert: ceiling:${wl} acked `))).toHaveLength(1);
		expect(w.g.issues[0]!.comments).toEqual([]);
	});
});

describe("the pass lock (D3)", () => {
	test("a pass that finds the lock held runs nothing and says so in one line", () => {
		const w = world();
		ceilingStopped(w.ledger, "Move the header offset into a token");
		const r = lockedAlertPass(w.deps, () => ({ owner: { pid: 9, start: "Tue Nov  3 10:00:00 2026" }, state: "same" }));
		expect(r).toBeNull();
		expect(w.g.calls).toEqual([]);
		expect(w.log).toEqual([expect.stringContaining("another pass holds the lock")]);
	});

	test("the lock is released after the pass", () => {
		const w = world();
		let released = 0;
		expect(lockedAlertPass(w.deps, () => ({ release: () => void released++ }))).toEqual({ problems: [] });
		expect(released).toBe(1);
	});

	test("a lock that cannot be read at its release is the pass's problem and its log line (review r2 N3)", () => {
		const w = world();
		const dir = tmp("alert-lock");
		const path = join(dir, "alert-pass.lock");
		const self = { pid: 4100, start: "Tue Nov  3 09:00:00 2026" };
		const lock = () => {
			const held = takeRunnerLock({ write: (fn) => fn() }, path, self, () => "gone");
			if (!("release" in held)) throw new Error(`refused: ${held.state}`);
			// The lock file is replaced by a directory during the pass.
			rmSync(path);
			mkdirSync(path);
			return held;
		};
		const r = lockedAlertPass(w.deps, lock);
		const line = `alert pass: releasing the lock failed: run lock ${path}: its owner could not be read: `;
		expect(r!.problems).toEqual([expect.stringContaining(line)]);
		expect(w.log).toContainEqual(expect.stringContaining(line));
	});

	test("a pass that throws and a release that fails are both thrown, the pass's error first (review r2 N3)", () => {
		const w = world();
		w.deps.quota = () => {
			throw new Error("quota boom");
		};
		let caught: unknown;
		try {
			lockedAlertPass(w.deps, () => ({ release: () => { throw new Error("release boom"); } }));
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(AggregateError);
		expect((caught as AggregateError).errors.map((e: Error) => e.message)).toEqual(["quota boom", "release boom"]);
		expect(w.log).toContainEqual("alert pass: releasing the lock failed: release boom");
	});
});

describe("an ack in a crash window and an unreadable source (R13, D2)", () => {
	test("ack in the sending/sent crash window: the issue found by its create marker is closed before `acked` is written (R13, review r1 #3)", () => {
		const w = world();
		const wl = ceilingStopped(w.ledger, "Move the header offset into a token");
		// The create goes through on GitHub but its reply is lost: the pass records `level 1 sending` and an error, no url.
		let lose = true;
		w.deps.gh = (args) => {
			const r = w.g.gh(args);
			return lose && args[0] === "issue" && args[1] === "create" ? { code: 1, stdout: "", stderr: "connection reset after the request was sent" } : r;
		};
		alertPass(w.deps);
		lose = false;
		const key = `ceiling:${wl}`;
		const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(key))!;
		expect(ep.url).toBeNull();
		expect([...ep.sending.keys()]).toEqual([1]);
		expect(w.g.issues).toHaveLength(1);
		w.c.plusHours(0.01);
		const cmd = interpret(w.ledger, `ack ${wl}`);
		if (cmd === null) throw new Error(`interpret refused "ack ${wl}"`);
		apply(w.ledger, cmd);
		alertPass(w.deps);
		expect(w.g.issues).toHaveLength(1);
		expect(w.g.issues[0]!.state).toBe("CLOSED");
		expect(w.rows().filter((r) => r.startsWith(`alert: ${key} acked `))).toHaveLength(1);
	});

	test("a source that cannot be read holds its alerts unchanged and says so on the needs-you surface; once it reads again nothing is filed twice (review r1 #4)", () => {
		const w = world();
		const date = "2026-11-03";
		const name = `${date}-${nightlyFault(date)}.md`;
		let denied = false;
		w.deps.sources = {
			...w.deps.sources, reportsDir: "/reports",
			files: { list: () => [name], read: () => { if (denied) throw new Error("EACCES: permission denied, open '/reports'"); return "# chaos lost-row: FAIL\n- verdict: a row was lost\n"; } },
		};
		alertPass(w.deps);
		const key = `chaos:${name}`;
		expect(w.g.issues).toHaveLength(1);
		denied = true;
		const r = alertPass(w.deps);
		expect(r.problems).toEqual([expect.stringContaining("EACCES")]);
		expect(w.g.issues[0]!.state).toBe("OPEN");
		expect(w.rows().filter((x) => x.startsWith(`alert: ${key} closed `))).toEqual([]);
		const sourceLines = () => errorLines(w.ledger).filter((l) => l.kind === "alert" && l.line.includes("EACCES"));
		expect(sourceLines()).toHaveLength(1);
		expect(sourceLines()[0]!.line).toContain("chaos");
		denied = false;
		alertPass(w.deps);
		expect(w.g.issues).toHaveLength(1);
		expect(w.g.issues[0]!.state).toBe("OPEN");
		expect(sourceLines()).toEqual([]);
	});

	test("a quota saved state that cannot be read holds the quota alert unchanged and says so; once it reads again nothing is filed twice (review r2 N1)", () => {
		const w = world();
		const dir = tmp("quota-hold");
		const statePath = join(dir, "state.json");
		const usage = JSON.stringify({ capacity: { anthropic: [{ window: "7d", accounts: 1, usedAccounts: 0.96 }] }, reports: [] });
		w.deps.quota = (now) => runQuotaWatch({ dir, now: Date.parse(now), readUsage: () => usage, plistInstalled: () => false });
		alertPass(w.deps);
		const key = "quota:anthropic/7d:level-95";
		expect(w.g.issues).toHaveLength(1);
		expect(w.g.issues[0]!.body).toContain(key);
		const saved = readFileSync(statePath, "utf8");
		writeFileSync(statePath, "{ half");
		w.c.plusHours(0.1);
		const r = alertPass(w.deps);
		expect(w.g.issues[0]!.state).toBe("OPEN");
		expect(w.rows().filter((x) => x.startsWith(`alert: ${key} closed `))).toEqual([]);
		expect(r.problems).toEqual([expect.stringContaining(`quota source: quota watch: ${statePath} is not JSON`)]);
		expect(w.log).toContain(`alert pass: ${key}: held unchanged: its quota source could not be read this pass`);
		const sourceLines = () => errorLines(w.ledger).filter((l) => l.kind === "alert" && l.line.includes("is not JSON"));
		expect(sourceLines()).toHaveLength(1);
		writeFileSync(statePath, saved);
		w.c.plusHours(0.1);
		expect(alertPass(w.deps).problems).toEqual([]);
		expect(w.g.issues).toHaveLength(1);
		expect(w.g.issues[0]!.state).toBe("OPEN");
		expect(sourceLines()).toEqual([]);
	});
});

describe("popup settlement (D3: recorded pid and lstart pairs only, Jo's registry rule)", () => {
	const LS = "Tue Nov  3 10:00:00 2026";
	const CLAIM = `pid=500 pgid=500 lstart=${LS.replace(/ /g, "_")} attempt=1 until=2026-11-04T00:00:00.000Z`;
	/** An urgent ceiling alert after one pass, its attempt-1 claim and `showing` written as a worker would. */
	function claimed(ps: () => string) {
		const w = world({ ps });
		const wl = ceilingStopped(w.ledger, 'Jo said "ASAP"');
		alertPass(w.deps);
		const key = `ceiling:${wl}`;
		const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(key))!;
		const write = (step: Parameters<typeof alertPopupBody>[3], detail?: string) =>
			w.ledger.recordEntry({ by: ALERT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: alertPopupBody(key, ep.id, 2, step, detail) });
		write("claim", CLAIM);
		write("showing");
		return { w, key, ep, registry: popupRegistryPath(w.deps.popup.dir, { episode: ep.id, level: 2, attempt: 1 }) };
	}

	test("a worker past its claim is gone while its recorded osascript remains: SIGTERM to the recorded one only, then `settled` once it is gone", () => {
		let snapshot = "";
		const { w, key, ep, registry } = claimed(() => snapshot);
		writeFileSync(registry, registryLine({ pid: 500, lstart: "Tue Nov 3 10:00:00 2026", name: "worker" }) + registryLine({ pid: 600, lstart: "Tue Nov 3 10:00:00 2026", name: "osascript" }));
		// The worker (500) is gone; its osascript (600) is recorded; 700 is recorded nowhere, though its argv names this attempt.
		snapshot = [`  600     1   500 ${LS} /usr/bin/osascript -e x`, `  700     1   700 ${LS} /usr/bin/osascript AS2_ALERT_POPUP=${ep.id}:2:1`].join("\n");
		alertPass(w.deps);
		expect(w.kills).toEqual([[600, "SIGTERM"]]);
		expect(w.rows().some((r) => r.startsWith(`alert-popup: ${key} ${ep.id} 2 terminating worker ended after showing members=600:`))).toBe(true);
		// 30 s later it still matches: SIGKILL to it alone.
		w.c.plusHours(31 / 3600);
		alertPass(w.deps);
		expect(w.kills).toEqual([[600, "SIGTERM"], [600, "SIGKILL"]]);
		// A process with pid 600 but another start time is not it: the attempt is settled, nothing is signalled.
		snapshot = `  600     1   600 Tue Nov  3 11:00:00 2026 /bin/sleep 5`;
		alertPass(w.deps);
		expect(w.kills).toHaveLength(2);
		expect(w.rows().some((r) => r === `alert-popup: ${key} ${ep.id} 2 settled worker ended after showing`)).toBe(true);
		// Settled with attempts left: the next attempt is spawned with its own number.
		alertPass(w.deps);
		expect(w.spawns.at(-1)!.argv.at(-1)).toBe("2");
	});

	test("a ps refusal is the key's `error popup` and leaves the claim unsettled: nothing signalled, no new worker", () => {
		const w = world({ ps: () => { throw new Error("ps -A exited 126: Operation not permitted"); } });
		const wl = ceilingStopped(w.ledger, 'Jo said "ASAP"');
		alertPass(w.deps);
		alertPass(w.deps);
		expect(w.kills).toEqual([]);
		expect(w.spawns).toHaveLength(1);
		expect(w.rows().some((r) => r.startsWith(`alert: ceiling:${wl} error popup ps -A could not be read`))).toBe(true);
	});

	test("a registry line that is not <pid> <lstart> <name> is the key's `error popup` naming the file: nothing signalled or settled, no new worker", () => {
		const { w, key, registry } = claimed(() => "");
		writeFileSync(registry, "600 yesterday osascript\n");
		alertPass(w.deps);
		alertPass(w.deps);
		expect(w.kills).toEqual([]);
		expect(w.spawns).toHaveLength(1);
		expect(w.rows().some((r) => r.startsWith(`alert-popup: ${key} `) && / (settled|terminating) /.test(r))).toBe(false);
		expect(w.rows().some((r) => r.startsWith(`alert: ${key} error popup settling popup attempt 1 failed: popup registry ${registry} line 1 is not <pid> <lstart> <name>`))).toBe(true);
	});
});
