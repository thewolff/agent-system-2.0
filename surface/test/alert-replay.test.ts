// The 2:51 AM replay (PLAN wl-mw0vs9uc3xqtka D8): wl-mw01xdcflkdnq0 as the live ledger held it at 2026-11-03T10:52:00Z,
// 33 s after the runner stopped lane-mw01xdcflkdnq0-4 at its $150 ceiling while Jo slept, loaded from
// fixtures/alert-replay/snapshot-10-52Z.json into a temp ledger. One alert pass must give the ALERT line, the jo-issues
// issue, the @thewolff comment and the popup, in that order; Jo's words then close it. Every gh call and popup spawn goes
// to the recording fakes of alert-world.ts; nothing real is filed or shown.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { alertRecords, openEpisode } from "../src/alert-path";
import { ceilingStopped } from "../src/ceiling";
import { alertLines, controlOf, errorLines } from "../src/errors";
import { apply, interpret } from "../src/input";
import { controlEntries } from "../src/launch";
import { STANDING_WORKLOAD_ID } from "../src/types";
import { type AlertPassDeps, lockedAlertPass } from "../scripts/alert-tick";
import { world } from "./alert-world";
import { loadSnapshot } from "./fixtures/alert-replay/load";
import { clock, tempLedger, tmp } from "./helpers";

const AS_OF = "2026-11-03T10:52:00.000Z";
const WL = "wl-mw01xdcflkdnq0";
const KEY = `ceiling:${WL}`;
const PARKED = `parked:${WL}`;
const Q = "q-mw0cxrzs3xrkz7";
const INPUT = "in-mw01ww9xf3gx8s";

/** The snapshot in a temp ledger at 10:52:00Z, the fakes, and a timeline of every gh call and popup spawn in the order the pass made them. */
function replay() {
	const c = clock(AS_OF);
	const { ledger } = tempLedger(c.now);
	loadSnapshot(ledger.db);
	const w = world();
	const standing = () => controlEntries(ledger.entries(STANDING_WORKLOAD_ID, "assumption"));
	// Each step records whether the ceiling's ALERT line was already on the needs-you list when the step ran.
	const timeline: { step: string; args: string[]; ceilingLine: boolean }[] = [];
	const lineUp = () => alertLines(standing()).some((l) => l.workloadId === WL && l.line.includes(`${WL} stopped at its ceiling`));
	const deps: AlertPassDeps = {
		...w.deps,
		ledger,
		gh: (args) => {
			timeline.push({ step: `gh ${args[0]} ${args[1]}`, args, ceilingLine: lineUp() });
			return w.g.gh(args);
		},
		popup: {
			...w.deps.popup,
			spawn: (argv, env, log) => {
				timeline.push({ step: "popup spawn", args: argv, ceilingLine: lineUp() });
				return w.deps.popup.spawn(argv, env, log);
			},
		},
	};
	const pass = () => lockedAlertPass(deps, () => ({ release: () => {} }));
	const alarmFile = join(tmp("alarm"), "alarm.jsonl");
	const needsYou = () => errorLines(ledger, ledger.inFlight(), { reportJobInstalled: () => false, alarmFile }).filter((l) => l.kind === "alert");
	const episode = (key: string) => openEpisode(alertRecords(standing()).get(key));
	const rows = () => standing().filter((e) => e.prefix === "alert").map((e) => `alert: ${e.rest}`);
	const ceilingIssue = () => w.g.issues.find((i) => i.title.startsWith(`${WL} stopped at its ceiling`));
	/** Whether gh call `args` names the ceiling issue (`issue <verb> <number> …`). */
	const onCeilingIssue = (args: string[]) => {
		const issue = ceilingIssue();
		return issue !== undefined && args[0] === "issue" && issue.url.endsWith(`/${args[2]}`);
	};
	const say = (cmd: string) => {
		const parsed = interpret(ledger, cmd);
		if (parsed === null) throw new Error(`input.ts interpret refused "${cmd}"`);
		apply(ledger, parsed);
	};
	return { c, ledger, w, timeline, pass, needsYou, episode, rows, ceilingIssue, onCeilingIssue, say };
}

describe("the 2:51 AM replay: wl-mw01xdcflkdnq0 at 2026-11-03T10:52:00Z (D8)", () => {
	test("the snapshot reproduces the stop: the workload open with no holder, stopped at its ceiling, q-mw0cxrzs3xrkz7 open", () => {
		const r = replay();
		const w = r.ledger.workload(WL)!;
		expect(w).toMatchObject({ status: "open", holder: null, holder_lease_until: null, closed_at: null });
		const stopped = ceilingStopped(controlOf(r.ledger, WL, w.holder), r.ledger.instructions(WL), w.stakes);
		expect(stopped).not.toBeNull();
		expect(stopped!.ceiling.usd).toBe(150);
		expect(r.ledger.question(Q)).toMatchObject({ state: "open", resolved_by: null });
	});

	test("one pass: the ALERT line, one issue create on thewolff/jo-issues, then the @thewolff comment, then one popup naming the ceiling; urgent from Jo's input", () => {
		const r = replay();
		expect(r.pass()).toEqual({ problems: [] });

		// The needs-you line, as the surface renders it.
		const line = r.needsYou().find((l) => l.workloadId === WL && l.line.includes(`${WL} stopped at its ceiling`));
		expect(line).toBeDefined();
		expect(line!.line).toStartWith("ALERT LOUD ");
		expect(line!.line).toContain(`urgent (from ${INPUT})`);

		// One issue on thewolff/jo-issues for the ceiling, saying why it is urgent.
		const creates = r.timeline.filter((t) => t.step === "gh issue create" && t.args.includes(`${WL} stopped at its ceiling ($153.83 of $150)`));
		expect(creates).toHaveLength(1);
		expect(creates[0]!.args).toEqual(expect.arrayContaining(["-R", "thewolff/jo-issues"]));
		const issue = r.ceilingIssue()!;
		expect(issue.body).toContain(`urgent (from ${INPUT})`);

		// In order: the line was up before the issue create; the create, then the @thewolff comment, then the popup spawn.
		const at = (pred: (t: (typeof r.timeline)[number]) => boolean) => r.timeline.findIndex(pred);
		const create = at((t) => t === creates[0]);
		const comment = at((t) => t.step === "gh issue comment" && r.onCeilingIssue(t.args));
		const popup = at((t) => t.step === "popup spawn" && t.args.includes(KEY));
		expect(r.timeline[create]!.ceilingLine).toBe(true);
		expect(create).toBeLessThan(comment);
		expect(comment).toBeLessThan(popup);
		expect(r.timeline.filter((t) => t.step === "gh issue comment" && r.onCeilingIssue(t.args))).toHaveLength(1);
		expect(issue.comments).toHaveLength(1);
		expect(issue.comments[0]).toContain("@thewolff");
		expect(r.timeline.filter((t) => t.step === "popup spawn" && t.args.includes(KEY))).toHaveLength(1);

		const ep = r.episode(KEY)!;
		expect(ep).toMatchObject({ kind: "ceiling", start: 2, url: issue.url });
		expect([...ep.sent.keys()]).toEqual([1, 2]);
	});

	test("Jo's `extend wl-mw01xdcflkdnq0` through input.ts: the next pass closes the ceiling issue naming the extend; the line goes; the parked key stays", () => {
		const r = replay();
		r.pass();
		const issue = r.ceilingIssue()!;
		r.c.at("2026-11-03T16:05:13.070Z");
		r.say(`extend ${WL}`);
		const before = r.timeline.length;
		expect(r.pass()).toEqual({ problems: [] });
		const closes = r.timeline.slice(before).filter((t) => t.step === "gh issue close" && r.onCeilingIssue(t.args));
		expect(closes).toHaveLength(1);
		expect(closes[0]!.args.join(" ")).toContain("extend");
		expect(issue.state).toBe("CLOSED");
		expect(r.rows().filter((l) => l.startsWith(`alert: ${KEY} closed `))).toHaveLength(1);
		expect(r.needsYou().some((l) => l.line.includes(`${WL} stopped at its ceiling`))).toBe(false);
		// q-mw0cxrzs3xrkz7 is still open: its own key, parked:wl-mw01xdcflkdnq0, stays open and on the list.
		expect(r.ledger.question(Q)!.state).toBe("open");
		const parked = r.episode(PARKED);
		expect(parked).not.toBeNull();
		expect(parked!.closed).toBeNull();
		expect(r.needsYou().some((l) => l.line.includes(`${WL} is waiting on you`))).toBe(true);
	});

	test("variant: Jo's `ack wl-mw01xdcflkdnq0` closes the ceiling issue instead, and the line goes", () => {
		const r = replay();
		r.pass();
		const issue = r.ceilingIssue()!;
		r.c.at("2026-11-03T11:00:00.000Z");
		r.say(`ack ${WL}`);
		const before = r.timeline.length;
		expect(r.pass()).toEqual({ problems: [] });
		const closes = r.timeline.slice(before).filter((t) => t.step === "gh issue close" && r.onCeilingIssue(t.args));
		expect(closes).toHaveLength(1);
		expect(issue.state).toBe("CLOSED");
		expect(r.rows().filter((l) => l.startsWith(`alert: ${KEY} acked `))).toHaveLength(1);
		expect(r.needsYou().some((l) => l.line.includes(`${WL} stopped at its ceiling`))).toBe(false);
	});

	test("variant: Jo closes the ceiling issue on GitHub after level 3: the next pass writes `acked` and sends nothing more", () => {
		const r = replay();
		r.pass();
		r.c.plusHours(8.1);
		r.pass();
		const ep = r.episode(KEY)!;
		expect([...ep.sent.keys()]).toEqual([1, 2, 3]);
		const issue = r.ceilingIssue()!;
		expect(issue.labels).toEqual(expect.arrayContaining(["critical"]));
		issue.state = "CLOSED";
		const comments = issue.comments.length;
		r.c.plusHours(0.1);
		r.pass();
		expect(r.rows().filter((l) => l.startsWith(`alert: ${KEY} acked `))).toHaveLength(1);
		expect(issue.comments).toHaveLength(comments);
		expect(r.needsYou().some((l) => l.line.includes(`${WL} stopped at its ceiling`))).toBe(false);
	});
});
