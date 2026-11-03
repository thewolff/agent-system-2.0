// The alert pass's test world: a temp ledger on a settable clock, a recording gh over one in-memory jo-issues repository,
// and recording popup spawn, ps and kill seams. No real gh, popup or signal is ever used.
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger } from "../../ledger/src/index";
import { fsReportFiles } from "../src/alert-sources";
import { ensureStandingWorkload } from "../src/identity";
import { controlEntries, laneExitBody } from "../src/launch";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import type { AlertLock, AlertPassDeps } from "../scripts/alert-tick";
import type { Gh } from "../src/jo-issues";
import { clock, tempLedger, tmp } from "./helpers";

export const T0 = "2026-11-03T10:00:00.000Z";
export const ISSUE = "https://github.com/thewolff/jo-issues/issues/77";

/** A recording gh over one in-memory jo-issues repository: issues, their comments, labels and state. */
export interface FakeGh {
	gh: (args: string[]) => { code: number; stdout: string; stderr: string };
	calls: string[][];
	issues: { url: string; body: string; title: string; state: "OPEN" | "CLOSED"; comments: string[]; labels: string[] }[];
}

export function fakeGh(o: { fail?: (args: string[]) => boolean } = {}): FakeGh {
	const calls: string[][] = [];
	const issues: { url: string; body: string; title: string; state: "OPEN" | "CLOSED"; comments: string[]; labels: string[] }[] = [];
	const labels = new Set(["as2-train"]);
	const byNum = (n: string) => issues.find((i) => i.url.endsWith(`/${n}`))!;
	const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
	const gh = (args: string[]) => {
		calls.push(args);
		if (o.fail?.(args)) return { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" };
		const [a, b] = args;
		if (a === "api") return ok(JSON.stringify([issues.map((i) => ({ html_url: i.url, body: i.body }))]));
		if (a === "label" && b === "list") return ok(JSON.stringify([...labels].map((name) => ({ name }))));
		if (a === "label" && b === "create") {
			labels.add(args[2]!);
			return ok("");
		}
		if (a === "issue" && b === "create") {
			const url = issues.length === 0 ? ISSUE : `https://github.com/thewolff/jo-issues/issues/${77 + issues.length}`;
			issues.push({ url, body: args[args.indexOf("--body") + 1]!, title: args[args.indexOf("--title") + 1]!, state: "OPEN", comments: [], labels: [args[args.indexOf("--label") + 1]!] });
			return ok(`${url}\n`);
		}
		const i = byNum(args[2]!);
		if (b === "view") return ok(JSON.stringify({ state: i.state, body: i.body, comments: i.comments.map((body) => ({ body })) }));
		if (b === "comment") i.comments.push(args[args.indexOf("--body") + 1]!);
		if (b === "edit") i.labels.push(...args[args.indexOf("--add-label") + 1]!.split(","));
		if (b === "close") i.state = "CLOSED";
		return ok("");
	};
	return { gh, calls, issues };
}

/** A ceiling-stopped workload: $50 ceiling, $50.20 spent, the runner's accepted stop and exit, no holder. `brief` decides urgency. */
export function ceilingStopped(ledger: Ledger, brief: string): string {
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: "ceiling: usd 50 wall 360 source stakes normal" });
	ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
	ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "Move the offset", doneCondition: "bun test passes", inputs: "src/header.css" });
	ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "spend: lane-t-1 usd 50.2 tokens 1000 wall 40" });
	ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: "lane-stop: lane-t-1 accepted ceiling" });
	ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: laneExitBody("lane-t-1", { code: 0, signal: null, outcome: "stop", reason: "ceiling" }) });
	return wl;
}

/** What the popup seams recorded: each detached spawn (argv and env) and each signal (pid and signal). */
export interface PopupRecord {
	spawns: { argv: string[]; env: Record<string, string> }[];
	kills: [number, string][];
}

/** The pass's seams beside the ledger, the log and the train repository: what TickDeps.alerts carries (surface/scripts/train-tick.ts). */
export type AlertSeams = Omit<AlertPassDeps, "ledger" | "log" | "sources"> & { sources: Omit<AlertPassDeps["sources"], "trainRepo"> };

/**
 * Recording seams for one alert pass over `gh`: no quota subjects, an alarm file and chaos dir with nothing in them, a runner
 * probe that finds every lane gone, a popup spawn that records and answers pid 4242, an empty registry directory of its
 * own, `ps` from `o.ps` (no process by default) and a kill that records. No real gh, popup, ps or signal is ever used.
 */
export function alertSeams(gh: Gh, o: { ps?: () => string } = {}): PopupRecord & { seams: AlertSeams } {
	const spawns: PopupRecord["spawns"] = [];
	const kills: PopupRecord["kills"] = [];
	const seams: AlertSeams = {
		gh,
		quota: () => ({ subjects: [], log: [], error: null, unavailable: false }),
		sources: { alarmFile: join(tmp("alarm"), "alarm.jsonl"), reportsDir: join(tmp("reports"), "none"), files: fsReportFiles, probe: () => ({ failure: null, omp: () => "gone", runner: () => "gone" }) },
		popup: {
			spawn: (argv, env) => {
				spawns.push({ argv, env });
				return 4242;
			},
			env: { PATH: "/usr/bin:/bin" }, log: join(tmp("alert-log"), "alert-pass.log"), dir: tmp("alert-popups"),
			ps: o.ps ?? (() => ""),
			kill: (pid, sig) => {
				kills.push([pid, sig]);
				return true;
			},
		},
	};
	return { seams, spawns, kills };
}

/** A pass lock that is always free (TickDeps.alerts's `lock`): the tests run one pass at a time. */
export const freeLock: AlertLock = () => ({ release: () => {} });

/** The test world: the ledger and its clock, the fake gh, the pass's deps, and what the popup seams recorded. */
export interface AlertWorld extends PopupRecord {
	c: { now: () => string; at: (iso: string) => void; plusHours: (h: number) => void };
	ledger: Ledger;
	g: FakeGh;
	deps: AlertPassDeps;
	log: string[];
	/** The standing workload's `alert:` and `alert-popup:` rows, oldest first. */
	rows: () => string[];
}

/** The standing workload's `alert:` and `alert-popup:` rows on `ledger`, oldest first, each as `<prefix>: <rest>`. */
export const alertRowsOf = (ledger: Ledger): string[] =>
	controlEntries(ledger.entries(STANDING_WORKLOAD_ID)).filter((e) => e.prefix === "alert" || e.prefix === "alert-popup").map((e) => `${e.prefix}: ${e.rest}`);

export function world(o: { fail?: (args: string[]) => boolean; ps?: () => string } = {}): AlertWorld {
	const c = clock(T0);
	const { ledger } = tempLedger(c.now);
	ensureStandingWorkload(ledger);
	const g = fakeGh(o);
	const log: string[] = [];
	const { seams, spawns, kills } = alertSeams(g.gh, o);
	const deps: AlertPassDeps = { ...seams, ledger, log: (l) => log.push(l), sources: { ...seams.sources, trainRepo: () => null } };
	return { c, ledger, g, deps, spawns, kills, log, rows: () => alertRowsOf(ledger) };
}

