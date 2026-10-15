// The reconciler (PLAN wl-mv66ylim0gahog § 4, § 9.3 sl-issues-reconcile, § 13.2): the hourly drift
// entry on wl-orchestrator, `unknown` (never 0) on a 1000-row list, a failed read, a low rate limit
// or a spent budget; remote-only drift (a label, the close reason, a title, a removed `as2` label, a
// deleted issue, a reopen) repaired by the next push; a pending footer and move drift counted; the
// two-run notice; drift on a Linear item; and `surface/scripts/issues.ts check`, which prints the
// same computation and writes nothing. GitHub is `FakeGh` behind the exec seam (its label list and
// a missing issue answered here), Linear is `FakeLinear` behind the injected fetch: no network call.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordRepo } from "../src/decision-log";
import { ensureStandingWorkload } from "../src/identity";
import { type IssuesConfig, ISSUES_DEFAULTS } from "../src/issues/config";
import type { Exec } from "../src/issues/github";
import { PR_SCAN_UNKNOWN, type TickPhases, tick } from "../src/issues/projector";
import { DRIFT_PREFIX, ISSUE_LIST_LIMIT, prsOfBlock, reconcile, reopenComment } from "../src/issues/reconcile";
import { BLOCK_BEGIN, BLOCK_END, issueTitle, LABEL } from "../src/issues/render";
import { INTAKE_IGNORED, STATE, Sidecar, sidecarPath } from "../src/issues/sidecar";
import { switchBody } from "../src/issues/switch";
import { trackerEntryBody } from "../src/issues/tracker";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { check } from "../scripts/issues";
import { arg, ENG_2284, FakeGh, FakeLinear, json, REPO } from "./issues-fakes";
import { tempLedger, tmp } from "./helpers";

const T0 = Date.parse("2026-10-14T10:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY = "lin_api_RECONCILE0123456789";
const SCRIPT = join(import.meta.dir, "..", "scripts", "issues.ts");

/** A temp ledger and sidecar, FakeGh and FakeLinear, a GitHub checkout (o/r) and a Linear one (lin/app ⇒ ENG), the tick with the reconcile phase. */
function setup(o: { over?: Partial<IssuesConfig>; key?: string | null } = {}) {
	let t = T0;
	const { ledger, path } = tempLedger(() => new Date(t).toISOString());
	const sidecar = Sidecar.open(sidecarPath({ AGENT_SYSTEM_LEDGER_DB: path }));
	const gh = new FakeGh();
	const linear = new FakeLinear();
	const repoDir = tmp("rc-checkout");
	const linDir = tmp("rc-lin-checkout");
	gh.origins.set(repoDir, `https://github.com/${REPO}.git`);
	gh.origins.set(linDir, "git@github.com:lin/app.git");
	const config: IssuesConfig = {
		trackers: [
			{ match: REPO, tracker: { kind: "github" } },
			{ match: "lin/*", tracker: { kind: "linear", team: "ENG" } },
		],
		overrides: {},
		jo: "jo",
		...ISSUES_DEFAULTS,
		perTick: 100,
		perHour: 10_000,
		...o.over,
	};
	const key = o.key === undefined ? KEY : o.key;
	const notices: string[] = [];
	let listPad = 0;
	// The reconciler's label list (bodies, states, every as2 issue) and a number GitHub does not have; the rest is FakeGh's.
	const exec: Exec = async (command, args) => {
		if (command === "gh" && args[0] === "issue" && args[1] === "list" && !args.includes("--search")) {
			gh.calls.push(args);
			if (gh.fail(args)) return { stdout: "", stderr: "HTTP 502: Bad Gateway", code: 1, killed: false };
			const rows = [...gh.issues.values()]
				.filter((i) => i.labels.has(arg(args, "--label")))
				.map((i) => ({ number: i.number, title: i.title, state: i.state, stateReason: i.stateReason, labels: [...i.labels].map((name) => ({ name })), body: i.body }));
			for (let i = 0; i < listPad; i++) rows.push({ number: 70_000 + i, title: `pad ${i}`, state: "CLOSED", stateReason: "COMPLETED", labels: [{ name: LABEL.as2 }], body: "" });
			return json(rows.slice(0, Number(arg(args, "-L"))));
		}
		if (command === "gh" && args[0] === "issue" && (args[1] === "view" || args[1] === "edit") && !gh.issues.has(Number(args[2]))) {
			gh.calls.push(args);
			return { stdout: "", stderr: `GraphQL: Could not resolve to an issue or pull request with the number of ${args[2]}. (repository.issue)`, code: 1, killed: false };
		}
		return gh.exec(command, args);
	};
	const h = {
		ledger,
		path,
		sidecar,
		gh,
		linear,
		exec,
		repoDir,
		linDir,
		config,
		notices,
		key,
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
		pad: (n: number) => {
			listPad = n;
		},
		/** One tick; `phases` replaces the reconcile phase (a test wraps it). */
		run: (phases: TickPhases = { reconcile }) => tick({ exec, ledger, sidecar, config, holder: "h1", now: () => t, notice: (l) => notices.push(l), phases, linear: { key, fetch: linear.fetch } }),
		/** An hour on, then a tick: the reconciler is due. */
		hourly: (phases?: TickPhases) => {
			t += HOUR;
			return h.run(phases);
		},
		on: () => {
			ensureStandingWorkload(ledger);
			t += 1_000;
			ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: switchBody(true, "in-sw1") });
		},
		open: (brief = "build the thing", dir = repoDir): string => {
			t += 1_000;
			const id = ledger.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });
			recordRepo(ledger, id, dir);
			return id;
		},
		close: (id: string) => {
			t += 1_000;
			ledger.closeWorkload(id, { by: SURFACE_BY });
		},
		/** The drift entries on wl-orchestrator, oldest first. */
		drift: (): string[] =>
			ledger
				.entries(STANDING_WORKLOAD_ID, "assumption")
				.filter((e) => e.body.startsWith(DRIFT_PREFIX))
				.map((e) => e.body),
		last: (): string => h.drift().at(-1) ?? "",
		issueOf: (id: string) => gh.issues.get(sidecar.link(id)?.issue_number ?? -1)!,
		linearOf: (id: string) => linear.issues.get(sidecar.link(id)?.external_id ?? "")!,
		/** On, one GitHub workload pushed and the first (clean) reconcile recorded. */
		pushedOne: async (brief = "build the thing") => {
			h.on();
			const id = h.open(brief);
			await h.run();
			expect(h.drift()).toHaveLength(1);
			return { id, issue: h.issueOf(id) };
		},
	};
	return h;
}

describe("the drift entry", () => {
	test("a clean run records 0; Jo's title edit is one line naming the tracker, forced, repaired by the next push; the schedule is hourly", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
		expect(h.sidecar.state(STATE.lastReconcile)).toBe(String(h.now()));
		h.advance(30 * MIN);
		await h.run();
		expect(h.drift()).toHaveLength(1);

		issue.title = `${id} — Jo renamed it`;
		const seqBefore = h.ledger.db.query<{ m: number }, []>("SELECT max(seq) AS m FROM provenance").get()!.m;
		await h.hourly();
		const entry = h.last().split("\n");
		expect(entry[0]).toBe(`issues-drift: 1 at ${new Date(h.now()).toISOString()}`);
		expect(entry[1]).toBe(`github ${REPO} #${issue.number} ${id}: title "${id} — Jo renamed it" (ledger: "${issueTitle(id, "build the thing")}")`);
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 1, force: 1, fails: 0 });
		// The entry is the only ledger write: the workload's own provenance did not move.
		expect(h.ledger.db.query<{ m: number }, [string]>("SELECT max(seq) AS m FROM provenance WHERE workload_id = ?").get(id)!.m).toBeLessThan(seqBefore + 1);

		h.gh.calls.length = 0;
		h.advance(MIN);
		await h.run();
		expect(h.gh.made("issue edit")).toHaveLength(1);
		expect(issue.title).toBe(issueTitle(id, "build the thing"));
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 0, force: 0 });
		await h.hourly();
		expect(h.last()).toStartWith("issues-drift: 0 at ");
	});

	test("ignored intake issues since the last run are one line, not counted", async () => {
		const h = setup();
		await h.pushedOne();
		h.sidecar.immediate(() => {
			for (const [n, reason] of [[90, "not Jo"], [91, "not Jo"], [92, "filed before issues on"]] as const) {
				h.sidecar.db.query("INSERT INTO intake (issue_number, verdict, reason, in_id, acked, seen_at) VALUES (?, ?, ?, NULL, 0, ?)").run(n, INTAKE_IGNORED, reason, new Date(h.now() + 1).toISOString());
			}
		});
		await h.hourly();
		expect(h.last().split("\n")).toEqual([`issues-drift: 0 at ${new Date(h.now()).toISOString()}`, "intake: 3 ignored (filed before issues on 1, not Jo 2)"]);
		await h.hourly();
		expect(h.last().split("\n")).toHaveLength(1);
	});
});

describe("unknown, never 0", () => {
	test("a 1000-row label list, a failed list, and a rate limit under the floor each record unknown", async () => {
		const h = setup();
		await h.pushedOne();
		h.pad(ISSUE_LIST_LIMIT);
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: unknown (github ${REPO}: gh issue list returned ${ISSUE_LIST_LIMIT} rows, the limit) at ${new Date(h.now()).toISOString()}`);

		h.pad(0);
		h.gh.fail = (a) => a[0] === "issue" && a[1] === "list" && !a.includes("--search");
		await h.hourly();
		expect(h.last()).toStartWith(`issues-drift: unknown (github ${REPO}: gh issue list exited 1: HTTP 502: Bad Gateway) at `);

		h.gh.fail = () => false;
		h.gh.remaining = 100;
		h.gh.calls.length = 0;
		await h.hourly();
		expect(h.last()).toStartWith("issues-drift: unknown (GitHub rate limit under 500 at the hourly read; GitHub was not read) at ");
		expect(h.gh.made("issue list")).toHaveLength(0);
		expect(h.drift().filter((b) => b.startsWith("issues-drift: 0"))).toHaveLength(1);
	});

	test("a spent budget records unknown, then the stop ends the tick; the run is not repeated next tick", async () => {
		const h = setup();
		await h.pushedOne();
		// The hourly rate_limit read and the PR scan spend the tick's two calls; the label list has none left.
		h.config.perTick = 2;
		const r = await h.hourly();
		expect(r.stopped).toBe("budget");
		expect(h.last()).toStartWith("issues-drift: unknown (the github call budget ran out (2 github calls this tick)) at ");
		h.advance(MIN);
		await h.run();
		expect(h.drift()).toHaveLength(2);
	});

	test("an incomplete open-PR scan (the sidecar's pr_scan_unknown) records unknown (pr scan: <why>), never 0", async () => {
		const h = setup();
		await h.pushedOne();
		// The reconciler alone: the scan's record is set between the tick's scan and the phase.
		const why = `200 open PRs on ${REPO}, the scan's limit`;
		await h.hourly({
			reconcile: async (ctx) => {
				ctx.sidecar.immediate(() => ctx.sidecar.setState(PR_SCAN_UNKNOWN, why));
				await reconcile(ctx);
			},
		});
		expect(h.last()).toBe(`issues-drift: unknown (pr scan: ${why}) at ${new Date(h.now()).toISOString()}`);

		// End to end: a truncated scan records it, a complete one clears it.
		h.gh.scanPad = 200;
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: unknown (pr scan: ${why}) at ${new Date(h.now()).toISOString()}`);
		h.gh.scanPad = 0;
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
	});

	test("a drift entry whose ledger write fails leaves its turn lines uncarried; the next entry carries them", async () => {
		const h = setup();
		const { id } = await h.pushedOne();
		const at = h.now();
		h.sidecar.immediate(() =>
			h.sidecar.db.query("INSERT INTO turns (turn_end_at, workload_id, seq, outcome, ticks, reason, noticed) VALUES (?, ?, 1, 'pending', 2, 'tracker down', 1)").run(at, id),
		);
		const line = `turn ${new Date(at).toISOString()}: ${id} not updated (tracker down)`;
		const record = h.ledger.recordEntry.bind(h.ledger);
		let fail = true;
		h.ledger.recordEntry = ((o: Parameters<typeof record>[0]) => {
			if (fail && o.body.startsWith(DRIFT_PREFIX)) throw new Error("disk I/O error");
			return record(o);
		}) as typeof record;
		await h.hourly();
		expect(h.notices).toContain("the reconcile phase failed: disk I/O error");
		expect(h.drift()).toHaveLength(1);
		expect(h.sidecar.turns()[0]).toMatchObject({ drifted: 0 });

		fail = false;
		await h.hourly();
		expect(h.last().split("\n")).toEqual([`issues-drift: 0 at ${new Date(h.now()).toISOString()}`, line]);
		expect(h.sidecar.turns()[0]).toMatchObject({ drifted: 1 });
		await h.hourly();
		expect(h.last().split("\n")).toHaveLength(1);
	});

	test("a PR the scan found while its push backs off is drift, never 0; check reports the same", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const pr = h.gh.addPr(`wl/${id}`);
		// The scan maps the PR and dirties the link; the push's issue read fails: the link backs off and GitHub's work ends this tick.
		h.gh.fail = (a) => a[0] === "issue" && a[1] === "view";
		await h.hourly();
		// The due reconciler still runs, calls no GitHub, and records unknown (github failed).
		expect(h.drift()).toHaveLength(2);
		expect(h.last()).toBe(`issues-drift: unknown (github failed) at ${new Date(h.now()).toISOString()}`);
		expect(h.sidecar.prs().map((p) => p.number)).toEqual([pr.number]);
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 1, fails: 1 });
		expect(issue.body).not.toContain(pr.url);
		// A minute on the link is still backing off: no push; the check, then the reconciler (made due again), see the PR missing from the issue.
		h.advance(MIN);
		h.sidecar.immediate(() => h.sidecar.setState(STATE.lastReconcile, null));
		const line = `github ${REPO} #${issue.number} ${id}: machine block differs`;
		const cfg = join(tmp("rc-cfg-backoff"), "config.yml");
		writeFileSync(cfg, `issues:\n  trackers:\n    - { match: ${REPO}, kind: github }\n  jo: jo\n`);
		const out: string[] = [];
		const code = await check({ env: { AGENT_SYSTEM_LEDGER_DB: h.path, AGENT_SYSTEM_ISSUES_CONFIG: cfg }, exec: h.exec, fetch: h.linear.fetch, out: (l) => out.push(l), err: () => {}, now: h.now });
		expect({ code, out }).toEqual({ code: 1, out: ["drift: 1", line] });
		await h.run();
		expect(h.last().split("\n")).toEqual([`issues-drift: 1 at ${new Date(h.now()).toISOString()}`, line]);
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 1, force: 1, fails: 0 });

		h.gh.fail = () => false;
		h.advance(MIN);
		await h.run();
		expect(issue.body).toContain(`- ${pr.url} open`);
		await h.hourly();
		expect(h.last()).toStartWith("issues-drift: 0 at ");
	});

	test("a clean link whose sidecar PR rows differ from the PRs its pushed block lists is compared with the PR set read from GitHub", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const pr = h.gh.addPr(`wl/${id}`);
		h.advance(MIN);
		await h.run();
		expect(issue.body).toContain(`- ${pr.url} open`);
		await h.hourly();
		expect(h.last()).toStartWith("issues-drift: 0 at ");
		// A second PR recorded in the sidecar without the link going dirty: the pushed block is not the current set.
		const second = h.gh.addPr(`wl/${id}`);
		h.sidecar.immediate(() => h.sidecar.db.query("INSERT INTO prs (workload_id, number, url, base, footer) VALUES (?, ?, ?, 'main', 'none')").run(id, second.number, second.url));
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 0 });
		await h.hourly();
		expect(h.last().split("\n")).toEqual([`issues-drift: 1 at ${new Date(h.now()).toISOString()}`, `github ${REPO} #${issue.number} ${id}: machine block differs`]);
		h.advance(MIN);
		await h.run();
		expect(issue.body).toContain(`- ${second.url} open`);
		await h.hourly();
		expect(h.last()).toStartWith("issues-drift: 0 at ");
	});
});

describe("remote-only drift is repaired by the next push", () => {
	test("Jo's label change on GitHub (ledger unchanged) is one line and the push puts the rendered labels back; a removed as2 label is found by number", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		expect([...issue.labels].sort()).toEqual([LABEL.as2, LABEL.waiting]);
		issue.labels.delete(LABEL.waiting);
		issue.labels.add(LABEL.running);
		await h.hourly();
		expect(h.last().split("\n")[1]).toBe(`github ${REPO} #${issue.number} ${id}: labels [as2, running] (ledger: [as2, waiting])`);

		h.gh.calls.length = 0;
		h.advance(MIN);
		await h.run();
		const edit = h.gh.made("issue edit");
		expect(edit).toHaveLength(1);
		expect(arg(edit[0]!, "--add-label")).toBe(LABEL.waiting);
		expect(arg(edit[0]!, "--remove-label")).toBe(LABEL.running);
		expect([...issue.labels].sort()).toEqual([LABEL.as2, LABEL.waiting]);

		issue.labels.delete(LABEL.as2);
		h.gh.calls.length = 0;
		await h.hourly();
		expect(h.gh.made("issue view").map((a) => a[2])).toEqual([String(issue.number)]);
		expect(h.last().split("\n")[1]).toBe(`github ${REPO} #${issue.number} ${id}: labels [waiting] (ledger: [as2, waiting])`);
		h.advance(MIN);
		await h.run();
		expect(issue.labels.has(LABEL.as2)).toBe(true);
		await h.hourly();
		expect(h.last()).toStartWith("issues-drift: 0 at ");
	});

	test("a remote-only close-reason change (not planned where the ledger renders completed, no ledger event) is repaired by reopen + close", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		h.close(id);
		h.advance(MIN);
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
		issue.stateReason = "NOT_PLANNED";
		await h.hourly();
		expect(h.last().split("\n")[1]).toBe(`github ${REPO} #${issue.number} ${id}: state closed not planned (ledger: closed completed)`);
		expect(issue.comments).toEqual([]);

		h.gh.calls.length = 0;
		h.advance(MIN);
		await h.run();
		const states = h.gh.calls.filter((a) => a[0] === "issue" && (a[1] === "reopen" || a[1] === "close"));
		expect(states.map((a) => a[1])).toEqual(["reopen", "close"]);
		expect(arg(states[1]!, "-r")).toBe("completed");
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
		await h.hourly();
		expect(h.last()).toStartWith("issues-drift: 0 at ");
	});

	test("Jo reopening a closed workload's issue is repaired toward closed with one comment", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		h.close(id);
		h.advance(MIN);
		await h.run();
		issue.state = "OPEN";
		issue.stateReason = "REOPENED";
		await h.hourly();
		expect(h.last().split("\n")[1]).toBe(`github ${REPO} #${issue.number} ${id}: state open (ledger: closed completed)`);
		expect(issue.comments).toEqual([reopenComment(id)]);
		h.advance(MIN);
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
		expect(issue.comments).toHaveLength(1);
	});

	test("an issue deleted on GitHub is one line; its number is cleared and the next push creates it again", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		h.gh.issues.delete(issue.number);
		await h.hourly();
		expect(h.last().split("\n")[1]).toBe(`github ${REPO} #${issue.number} ${id}: not found on GitHub; the next push creates its issue again`);
		expect(h.sidecar.link(id)).toMatchObject({ issue_number: null, dirty: 1, pushed_hash: null });
		h.advance(MIN);
		await h.run();
		const again = h.issueOf(id);
		expect(again.number).not.toBe(issue.number);
		expect(again.title).toBe(issueTitle(id, "build the thing"));
		await h.hourly();
		expect(h.last()).toStartWith("issues-drift: 0 at ");
	});

	test("a PR line edited in the remote machine block is drift (the expected PRs are the pushed set, not the remote's), repaired by the next push", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const pr = h.gh.addPr(`wl/${id}`);
		h.advance(MIN);
		await h.run();
		expect(issue.body).toContain(`- ${pr.url} open`);
		await h.hourly();
		expect(h.last()).toStartWith("issues-drift: 0 at ");

		// Jo (or anyone) swaps the PR's URL for another valid one inside the block; the ledger is unchanged.
		const forged = `https://github.com/${REPO}/pull/999`;
		issue.body = issue.body.replace(`- ${pr.url} open`, `- ${forged} open`);
		await h.hourly();
		expect(h.last().split("\n")).toEqual([`issues-drift: 1 at ${new Date(h.now()).toISOString()}`, `github ${REPO} #${issue.number} ${id}: machine block differs`]);
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 1, force: 1 });
		h.advance(MIN);
		await h.run();
		expect(issue.body).toContain(`- ${pr.url} open`);
		expect(issue.body).not.toContain(forged);
		await h.hourly();
		expect(h.last()).toStartWith("issues-drift: 0 at ");
	});
});

describe("local drift", () => {
	test("a pending footer is one line; move drift is one line, reported once; an open workload with no issue is one line and gets a dirty link", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const pr = h.gh.addPr(`wl/${id}`);
		h.gh.fail = (a) => a[0] === "pr" && a[1] === "edit";
		// The scan owes the footer, its edit fails: GitHub's work stops; the due reconciler records unknown (github failed).
		await h.hourly();
		expect(h.drift()).toHaveLength(2);
		expect(h.last().split("\n")).toEqual([`issues-drift: unknown (github failed) at ${new Date(h.now()).toISOString()}`, `github ${REPO} PR #${pr.number} ${id}: its Closes #${issue.number} footer is still pending`]);
		h.sidecar.immediate(() => h.sidecar.setState(STATE.moveDrift, JSON.stringify([`wl-old: ${pr.url} still carries the Closes #9 footer, not as its body's suffix; left as it is`])));
		// A minute on: the footer is backing off, the push and the reconciler (made due again) run.
		h.advance(MIN);
		h.sidecar.immediate(() => h.sidecar.setState(STATE.lastReconcile, null));
		await h.run();
		const entry = h.last().split("\n");
		expect(entry[0]).toBe(`issues-drift: 2 at ${new Date(h.now()).toISOString()}`);
		expect(entry.slice(1)).toEqual([
			`github ${REPO} PR #${pr.number} ${id}: its Closes #${issue.number} footer is still pending`,
			`github wl-old: ${pr.url} still carries the Closes #9 footer, not as its body's suffix; left as it is`,
		]);
		expect(h.sidecar.state(STATE.moveDrift)).toBeNull();

		// An open workload whose link was lost (ingest already read past it): one line, a dirty link, pushed next tick.
		h.gh.fail = () => false;
		const b = h.open("second thing");
		h.config.perTick = 0;
		h.advance(MIN);
		await h.run();
		h.config.perTick = 100;
		expect(h.sidecar.link(b)).toMatchObject({ dirty: 1, issue_number: null });
		h.sidecar.immediate(() => h.sidecar.deleteLink(b));
		await h.hourly();
		expect(h.last().split("\n")).toContain(`github ${REPO} ${b}: open and has no issue`);
		expect(h.sidecar.link(b)).toMatchObject({ repo: REPO, dirty: 1, issue_number: null });
		h.advance(MIN);
		await h.run();
		expect(h.issueOf(b).title).toBe(issueTitle(b, "second thing"));
	});

	test("drift on two consecutive runs is one notice, told once until a run comes back 0; an unmapped as2 issue is reported, never closed", async () => {
		const h = setup();
		await h.pushedOne();
		const stray = h.gh.addIssue({ title: "wl-nobody0 — not ours", labels: new Set([LABEL.as2]) });
		const told = () => h.notices.filter((n) => n.startsWith("issues drift on"));
		await h.hourly();
		expect(h.last().split("\n")[1]).toBe(`github ${REPO} #${stray.number}: open, labelled as2, and its title names no workload in the ledger ("wl-nobody0 — not ours"); left open`);
		expect(told()).toEqual([]);
		await h.hourly();
		expect(told()).toHaveLength(1);
		expect(told()[0]).toMatch(/^issues drift on 2 reconciles in a row: 1 difference \(en-\S+ on wl-orchestrator\)$/);
		await h.hourly();
		expect(told()).toHaveLength(1);
		expect(h.gh.made("issue close")).toHaveLength(0);
		expect(stray.state).toBe("OPEN");

		stray.state = "CLOSED";
		await h.hourly();
		expect(h.last()).toStartWith("issues-drift: 0 at ");
		stray.state = "OPEN";
		await h.hourly();
		expect(told()).toHaveLength(1);
		await h.hourly();
		expect(told()).toHaveLength(2);
	});
});

describe("an open as2 item naming a closed workload with no item linked", () => {
	test("GitHub: one line; the phase links it dirty and forced; the next push closes it per the render; then 0", async () => {
		const h = setup();
		h.on();
		const id = h.open("filed from a ledger copy");
		h.close(id);
		// Filed elsewhere (a smoke run on a ledger copy): the workload closed with no item linked.
		const stray = h.gh.addIssue({ title: issueTitle(id, "filed from a ledger copy"), labels: new Set([LABEL.as2, LABEL.running]) });
		await h.run();
		expect(h.last().split("\n")).toEqual([
			`issues-drift: 1 at ${new Date(h.now()).toISOString()}`,
			`github ${REPO} #${stray.number}: open, labelled as2, names closed workload ${id} with no item linked; the next push closes it`,
		]);
		expect(h.sidecar.link(id)).toMatchObject({ issue_number: stray.number, tracker: "github", repo: REPO, external_id: null, dirty: 1, force: 1, fails: 0 });
		expect(stray.state).toBe("OPEN");

		h.gh.calls.length = 0;
		h.advance(MIN);
		await h.run();
		const close = h.gh.made("issue close");
		expect(close).toHaveLength(1);
		expect(close[0]![2]).toBe(String(stray.number));
		expect(arg(close[0]!, "-r")).toBe("completed");
		expect(h.gh.made("issue create")).toHaveLength(0);
		expect(stray).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
		expect(h.sidecar.link(id)).toMatchObject({ issue_number: stray.number, dirty: 0, force: 0, pushed_state: "closed completed" });
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
	});

	test("Linear: one line; linked by id and identifier, dirty and forced; the next push moves it to Done; an item naming a closed workload whose tracker is elsewhere is left, uncounted", async () => {
		const h = setup();
		h.on();
		h.open("ship the app", h.linDir);
		const id = h.open("an old one", h.linDir);
		h.close(id);
		const onGithub = h.open("lives on github");
		h.close(onGithub);
		const item = h.linear.addIssue({ title: issueTitle(id, "an old one"), labels: [LABEL.as2] });
		const elsewhere = h.linear.addIssue({ title: issueTitle(onGithub, "lives on github"), labels: [LABEL.as2] });
		await h.run();
		expect(h.last().split("\n")).toEqual([
			`issues-drift: 1 at ${new Date(h.now()).toISOString()}`,
			`linear ENG ${item.identifier}: open, labelled as2, names closed workload ${id} with no item linked; the next push closes it`,
		]);
		expect(h.sidecar.link(id)).toMatchObject({ external_id: item.id, issue_ref: item.identifier, tracker: "linear:ENG", issue_number: null, dirty: 1, force: 1, fails: 0 });
		expect(h.sidecar.link(onGithub)).toBeNull();
		const creates = h.linear.made("create").length;

		h.advance(MIN);
		await h.run();
		expect(h.linear.stateName(item)).toBe("Done");
		expect(h.linear.made("create")).toHaveLength(creates);
		expect(h.sidecar.link(id)).toMatchObject({ external_id: item.id, dirty: 0, force: 0, pushed_state: "closed completed" });
		expect(h.linear.stateName(elsewhere)).toBe("In Progress");
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
	});

	test("Linear, a team only the config names: no open workload or link on ENG, the closed workload's stray item is adopted and moved to Done", async () => {
		const h = setup();
		h.on();
		const id = h.open("an old one", h.linDir);
		h.close(id);
		const item = h.linear.addIssue({ title: issueTitle(id, "an old one"), labels: [LABEL.as2] });
		await h.run();
		expect(h.last().split("\n")).toEqual([
			`issues-drift: 1 at ${new Date(h.now()).toISOString()}`,
			`linear ENG ${item.identifier}: open, labelled as2, names closed workload ${id} with no item linked; the next push closes it`,
		]);
		expect(h.sidecar.link(id)).toMatchObject({ external_id: item.id, issue_ref: item.identifier, tracker: "linear:ENG", issue_number: null, dirty: 1, force: 1, fails: 0 });
		const creates = h.linear.made("create").length;

		h.advance(MIN);
		await h.run();
		expect(h.linear.stateName(item)).toBe("Done");
		expect(h.linear.made("create")).toHaveLength(creates);
		expect(h.sidecar.link(id)).toMatchObject({ external_id: item.id, dirty: 0, force: 0, pushed_state: "closed completed" });
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
	});

	test("GitHub, a repo only an override names: the closed workload routed there by issues.overrides has its stray issue adopted and closed", async () => {
		const h = setup();
		h.on();
		// x/other matches no rule; the fake's label list ignores -R, so the repo sorts after o/r, where the item is elsewhere and uncounted.
		const other = "x/other";
		const otherDir = tmp("rc-other-checkout");
		h.gh.origins.set(otherDir, `https://github.com/${other}.git`);
		const id = h.open("routed by an override", otherDir);
		h.config.overrides[id] = { kind: "github" };
		h.close(id);
		const stray = h.gh.addIssue({ title: issueTitle(id, "routed by an override"), labels: new Set([LABEL.as2, LABEL.running]) });
		await h.run();
		expect(h.last().split("\n")).toEqual([
			`issues-drift: 1 at ${new Date(h.now()).toISOString()}`,
			`github ${other} #${stray.number}: open, labelled as2, names closed workload ${id} with no item linked; the next push closes it`,
		]);
		expect(h.sidecar.link(id)).toMatchObject({ issue_number: stray.number, tracker: "github", repo: other, external_id: null, dirty: 1, force: 1, fails: 0 });
		expect(stray.state).toBe("OPEN");

		h.advance(MIN);
		await h.run();
		const close = h.gh.made("issue close");
		expect(close).toHaveLength(1);
		expect(close[0]![2]).toBe(String(stray.number));
		expect(arg(close[0]!, "-R")).toBe(other);
		expect(h.gh.made("issue create")).toHaveLength(0);
		expect(stray).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
		expect(h.sidecar.link(id)).toMatchObject({ issue_number: stray.number, dirty: 0, force: 0, pushed_state: "closed completed" });
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
	});

	test("GitHub, a repo only a tracker: entry names: the closed workload Jo routed to GitHub has its stray issue adopted", async () => {
		const h = setup();
		h.on();
		const other = "x/other";
		const otherDir = tmp("rc-entry-checkout");
		h.gh.origins.set(otherDir, `https://github.com/${other}.git`);
		const id = h.open("routed by a tracker entry", otherDir);
		h.ledger.recordEntry({ by: SURFACE_BY, workloadId: id, kind: "assumption", body: trackerEntryBody(id, { kind: "github" }, "in-route1") });
		h.close(id);
		const stray = h.gh.addIssue({ title: issueTitle(id, "routed by a tracker entry"), labels: new Set([LABEL.as2]) });
		await h.run();
		expect(h.last().split("\n")).toEqual([
			`issues-drift: 1 at ${new Date(h.now()).toISOString()}`,
			`github ${other} #${stray.number}: open, labelled as2, names closed workload ${id} with no item linked; the next push closes it`,
		]);
		expect(h.sidecar.link(id)).toMatchObject({ issue_number: stray.number, tracker: "github", repo: other, dirty: 1, force: 1 });
	});

	test("issues.ts check (computeDrift alone) prints the same line and links nothing; the phase links it", async () => {
		const h = setup();
		h.on();
		const id = h.open("filed from a ledger copy");
		h.close(id);
		await h.run();
		expect(h.sidecar.link(id)).toBeNull();
		const stray = h.gh.addIssue({ title: issueTitle(id, "filed from a ledger copy"), labels: new Set([LABEL.as2]) });
		const cfg = join(tmp("rc-cfg-orphan"), "config.yml");
		writeFileSync(cfg, `issues:\n  trackers:\n    - { match: ${REPO}, kind: github }\n    - { match: "lin/*", kind: linear, team: ENG }\n  jo: jo\n`);
		const snapshot = () => JSON.stringify([h.sidecar.links(), h.sidecar.prs(), h.sidecar.db.query("SELECT * FROM state ORDER BY key").all()]);
		const before = snapshot();
		const out: string[] = [];
		const code = await check({ env: { AGENT_SYSTEM_LEDGER_DB: h.path, AGENT_SYSTEM_ISSUES_CONFIG: cfg, LINEAR_API_KEY: KEY }, exec: h.exec, fetch: h.linear.fetch, out: (l) => out.push(l), err: () => {}, now: h.now });
		const line = `github ${REPO} #${stray.number}: open, labelled as2, names closed workload ${id} with no item linked; the next push closes it`;
		expect({ code, out }).toEqual({ code: 1, out: ["drift: 1", line] });
		expect(snapshot()).toBe(before);
		expect(h.sidecar.link(id)).toBeNull();
		expect(stray.state).toBe("OPEN");

		await h.hourly();
		expect(h.last().split("\n")[1]).toBe(line);
		expect(h.sidecar.link(id)).toMatchObject({ issue_number: stray.number, dirty: 1, force: 1 });
	});

	test("an open workload's unlinked as2 issue is left as before; once that workload is closed holding its own issue, the duplicate is one line, left open", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const dup = h.gh.addIssue({ title: issueTitle(id, "build the thing"), labels: new Set([LABEL.as2]) });
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
		expect(h.sidecar.link(id)).toMatchObject({ issue_number: issue.number, dirty: 0, force: 0 });

		h.close(id);
		h.advance(MIN);
		await h.run();
		expect(issue.state).toBe("CLOSED");
		await h.hourly();
		expect(h.last().split("\n")).toEqual([
			`issues-drift: 1 at ${new Date(h.now()).toISOString()}`,
			`github ${REPO} #${dup.number}: open, labelled as2, names ${id}, which holds another item; left open`,
		]);
		expect(h.sidecar.link(id)).toMatchObject({ issue_number: issue.number, dirty: 0, force: 0 });
		h.advance(MIN);
		await h.run();
		expect(dup.state).toBe("OPEN");
		expect(h.gh.made("issue close").filter((a) => a[2] === String(dup.number))).toEqual([]);
	});
});

describe("Linear", () => {
	test("Jo's state and label change on a Linear item is one line naming the team, repaired by the next push", async () => {
		const h = setup();
		h.on();
		const id = h.open("ship the app", h.linDir);
		await h.run();
		expect(h.last()).toStartWith("issues-drift: 0 at ");
		expect(h.linear.made("list")).toHaveLength(1);
		const item = h.linearOf(id);
		expect(h.linear.stateName(item)).toBe("In Progress");
		const team = h.linear.team("ENG");
		item.stateId = team.states.find((s) => s.name === "Canceled")!.id;
		item.labelIds.delete(team.labels.find((l) => l.name === LABEL.waiting)!.id);
		await h.hourly();
		expect(h.last().split("\n")[1]).toBe(`linear ENG ${item.identifier} ${id}: labels [as2] (ledger: [as2, waiting]); state Canceled (ledger: In Progress)`);
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 1, force: 1 });

		h.advance(MIN);
		await h.run();
		expect(h.linear.stateName(item)).toBe("In Progress");
		expect(h.linear.labelNames(item)).toEqual([LABEL.as2, LABEL.waiting]);
		await h.hourly();
		expect(h.last()).toStartWith("issues-drift: 0 at ");
	});

	test("a Linear item deleted is one line and re-created; without a key the run is unknown", async () => {
		const h = setup();
		h.on();
		const id = h.open("ship the app", h.linDir);
		await h.run();
		const item = h.linearOf(id);
		h.linear.issues.delete(item.id);
		await h.hourly();
		expect(h.last().split("\n")[1]).toBe(`linear ENG ${item.identifier} ${id}: not found on Linear; the next push creates its issue again`);
		expect(h.sidecar.link(id)).toMatchObject({ external_id: null, issue_ref: null, dirty: 1 });
		h.advance(MIN);
		await h.run();
		expect(h.linearOf(id).id).not.toBe(item.id);

		const k = setup({ key: null });
		k.on();
		k.open("ship the app", k.linDir);
		await k.run();
		// The push's Linear call failed for the key, so Linear's work stopped this tick: the reconciler does not call it.
		expect(k.last()).toStartWith("issues-drift: unknown (linear failed) at ");
	});

	test("a Linear item with more than 20 labels is compared on its whole label set: right labels are 0, a projection label wrong past page one is drift; a failed label read is unknown", async () => {
		const h = setup();
		h.on();
		const id = h.open("ship the app", h.linDir);
		await h.run();
		expect(h.last()).toStartWith("issues-drift: 0 at ");
		const item = h.linearOf(id);
		const team = h.linear.team("ENG");
		// 25 labels: as2 and waiting first, then Jo's 23.
		for (let i = 0; i < 23; i++) {
			const l = { id: `lbl-jo${i}`, name: `jo-${i}` };
			team.labels.push(l);
			item.labelIds.add(l.id);
		}
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 0, force: 0 });

		// `waiting` moved past the first page: still there, still 0.
		const waiting = team.labels.find((l) => l.name === LABEL.waiting)!.id;
		item.labelIds.delete(waiting);
		item.labelIds.add(waiting);
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);

		// Jo adds the projection's `question` past the first page: drift, forced, repaired by the next push.
		const question = team.labels.find((l) => l.name === LABEL.question) ?? { id: "lbl-question", name: LABEL.question };
		if (!team.labels.includes(question)) team.labels.push(question);
		item.labelIds.add(question.id);
		await h.hourly();
		expect(h.last()).toBe(
			`issues-drift: 1 at ${new Date(h.now()).toISOString()}\nlinear ENG ${item.identifier} ${id}: labels [as2, question, waiting] (ledger: [as2, waiting])`,
		);
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 1, force: 1 });
		h.advance(MIN);
		await h.run();
		expect(item.labelIds.has(question.id)).toBe(false);
		expect(item.labelIds.has(waiting)).toBe(true);
		expect(item.labelIds.size).toBe(25);

		// A label read that fails is unknown with its reason, never 0.
		h.linear.reply = (r) => (r.op === "labels" ? new Response(JSON.stringify({ data: { issue: { labels: null } } }), { status: 200 }) : null);
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: unknown (linear ENG ${item.identifier} ${id}: Linear issue labels ${item.id} printed a malformed label list) at ${new Date(h.now()).toISOString()}`);
	});
});

describe("Linear's Markdown normalisation (ENG-2284)", () => {
	/** On, one Linear workload with one open PR, pushed through a Linear that normalises descriptions; the first reconcile recorded. */
	const normalised = async () => {
		const h = setup();
		h.linear.normalise = true;
		h.on();
		const id = h.open("ship the app", h.linDir);
		const pr = h.gh.addPr(`wl/${id}`);
		await h.run();
		return { h, id, pr, item: h.linearOf(id) };
	};

	test("a normalised push, then the reconciler: drift 0, the link stays clean, nothing is rewritten, and the PR set is the block's own", async () => {
		const { h, id, pr, item } = await normalised();
		// Linear stored the block normalised: the item starred, its URL a link, the lines after it (the end marker too) indented.
		expect(item.description).toContain(`PRs:\n\n* [${pr.url}](<${pr.url}>) open\n  ledger seq: `);
		expect(item.description).toEndWith(`\n  ${BLOCK_END}`);
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
		const updates = h.linear.made("update").length;
		const calls = h.gh.calls.length;
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 0, force: 0 });
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
		expect(h.linear.made("update")).toHaveLength(updates);
		// The expected PRs are the normalised block's own lines: no PR set is read from GitHub (`pr list --head`).
		expect(h.gh.calls.slice(calls).filter((a) => a[0] === "pr" && a[1] === "list" && a.includes("--head"))).toEqual([]);
	});

	test("a human edit inside the normalised remote block is drift 1 and forces the link; the forced push heals it", async () => {
		const { h, id, item } = await normalised();
		item.description = item.description.replace("  ledger seq: ", "  ledger seq: 9");
		await h.hourly();
		expect(h.last().split("\n")).toEqual([`issues-drift: 1 at ${new Date(h.now()).toISOString()}`, `linear ENG ${item.identifier} ${id}: machine block differs`]);
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 1, force: 1 });
		h.advance(MIN);
		await h.run();
		expect(item.description).not.toContain("ledger seq: 9");
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 0, force: 0 });
	});

	test("Jo's text outside the block survives a normalised round trip with the end marker indented", async () => {
		const { h, id, item } = await normalised();
		expect(item.description).toEndWith(`\n  ${BLOCK_END}`);
		item.description = `Jo's note above\n\n${item.description}\n\nJo's note below`;
		h.ledger.addSlice({ by: SURFACE_BY, workloadId: id, task: "t2", doneCondition: "d", inputs: "i" });
		h.advance(MIN);
		await h.run();
		expect(item.description).toStartWith(`Jo's note above\n\n${BLOCK_BEGIN}\n`);
		expect(item.description).toContain("slices: 1 open");
		expect(item.description).toEndWith(`\n  ${BLOCK_END}\n\nJo's note below`);
		expect(item.description.split(BLOCK_END)).toHaveLength(2);
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
	});

	test("a link pushed before remote_hash existed mismatches once; the forced push records it and the next run is 0", async () => {
		const { h, id, item } = await normalised();
		expect(h.sidecar.link(id)?.remote_hash).toMatch(/^[0-9a-f]{64}$/);
		h.sidecar.immediate(() => h.sidecar.db.query("UPDATE links SET remote_hash = NULL WHERE workload_id = ?").run(id));
		await h.hourly();
		expect(h.last().split("\n")).toEqual([`issues-drift: 1 at ${new Date(h.now()).toISOString()}`, `linear ENG ${item.identifier} ${id}: machine block differs`]);
		h.advance(MIN);
		await h.run();
		expect(h.sidecar.link(id)?.remote_hash).toMatch(/^[0-9a-f]{64}$/);
		await h.hourly();
		expect(h.last()).toBe(`issues-drift: 0 at ${new Date(h.now()).toISOString()}`);
	});

	test("issues.ts check compares the same way: 0 after a normalised push, the human edit inside the block 1", async () => {
		const { h, id, item } = await normalised();
		const cfg = join(tmp("rc-cfg-normalised"), "config.yml");
		writeFileSync(cfg, `issues:\n  trackers:\n    - { match: ${REPO}, kind: github }\n    - { match: "lin/*", kind: linear, team: ENG }\n  jo: jo\n`);
		const run = async () => {
			const out: string[] = [];
			const code = await check({ env: { AGENT_SYSTEM_LEDGER_DB: h.path, AGENT_SYSTEM_ISSUES_CONFIG: cfg, LINEAR_API_KEY: KEY }, exec: h.exec, fetch: h.linear.fetch, out: (l) => out.push(l), err: () => {}, now: h.now });
			return { code, out };
		};
		expect(await run()).toEqual({ code: 0, out: ["drift: 0"] });
		item.description = item.description.replace("* [", "* edited [");
		expect(await run()).toEqual({ code: 1, out: ["drift: 1", `linear ENG ${item.identifier} ${id}: machine block differs`] });
	});
});

describe("a tracker stopped this tick", () => {
	test("GitHub stopped for budget: the due run records unknown (github budget) with zero GitHub calls and advances its cadence", async () => {
		const h = setup();
		await h.pushedOne();
		let made = -1;
		const stopped = (reason: "budget" | "failed") => ({
			reconcile: async (ctx: Parameters<typeof reconcile>[0]) => {
				const before = h.gh.calls.length;
				await reconcile({ ...ctx, stopped: new Map([["github", reason]]) });
				made = h.gh.calls.length - before;
			},
		});
		await h.hourly(stopped("budget"));
		expect(made).toBe(0);
		expect(h.last()).toBe(`issues-drift: unknown (github budget) at ${new Date(h.now()).toISOString()}`);
		expect(h.sidecar.state(STATE.lastReconcile)).toBe(String(h.now()));
		// The cadence moved: a minute on, the run is not due.
		h.advance(MIN);
		made = -1;
		await h.run(stopped("budget"));
		expect(made).toBe(0);
		expect(h.drift()).toHaveLength(2);
		await h.hourly(stopped("failed"));
		expect(h.last()).toBe(`issues-drift: unknown (github failed) at ${new Date(h.now()).toISOString()}`);
	});

	test("a Linear-only reconcile still compares Linear when only GitHub is stopped; a PR set it would read from GitHub is unknown, not read", async () => {
		const h = setup({ over: { trackers: [{ match: "lin/*", tracker: { kind: "linear", team: "ENG" } }] } });
		h.on();
		const id = h.open("ship the app", h.linDir);
		await h.run();
		expect(h.last()).toStartWith("issues-drift: 0 at ");
		const item = h.linearOf(id);
		const team = h.linear.team("ENG");
		item.stateId = team.states.find((s) => s.name === "Canceled")!.id;
		let made = -1;
		let dirty = false;
		const phases = {
			reconcile: async (ctx: Parameters<typeof reconcile>[0]) => {
				if (dirty) ctx.sidecar.immediate(() => ctx.sidecar.db.query("UPDATE links SET dirty = 1 WHERE workload_id = ?").run(id));
				const before = h.gh.calls.length;
				await reconcile({ ...ctx, stopped: new Map([["github", "budget"]]) });
				made = h.gh.calls.length - before;
			},
		};
		await h.hourly(phases);
		expect(made).toBe(0);
		expect(h.last()).toBe(`issues-drift: 1 at ${new Date(h.now()).toISOString()}\nlinear ENG ${item.identifier} ${id}: state Canceled (ledger: In Progress)`);
		expect(h.sidecar.link(id)).toMatchObject({ force: 1 });

		// A dirty link's PR set comes from GitHub: with GitHub stopped it is unknown, and no call is made.
		dirty = true;
		await h.hourly(phases);
		expect(made).toBe(0);
		expect(h.last()).toStartWith(`issues-drift: unknown (${id}: its PR set was not read (github budget)) at `);
	});
});

describe("issues.ts check", () => {
	test("prints the same drift as the reconciler and writes nothing but its call count: no entry, no link, PR, state or claim change, gh reads only", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const cfg = join(tmp("rc-cfg"), "config.yml");
		writeFileSync(cfg, `issues:\n  trackers:\n    - { match: ${REPO}, kind: github }\n    - { match: "lin/*", kind: linear, team: ENG }\n  jo: jo\n`);
		const env = { AGENT_SYSTEM_LEDGER_DB: h.path, AGENT_SYSTEM_ISSUES_CONFIG: cfg, LINEAR_API_KEY: h.key ?? undefined };
		const run = async () => {
			const out: string[] = [];
			const err: string[] = [];
			const code = await check({ env, exec: h.exec, fetch: h.linear.fetch, out: (l) => out.push(l), err: (l) => err.push(l), now: h.now });
			return { code, out, err };
		};
		expect(await run()).toEqual({ code: 0, out: ["drift: 0"], err: [] });

		issue.labels.add(LABEL.question);
		const snapshot = () =>
			JSON.stringify([h.sidecar.links(), h.sidecar.prs(), h.sidecar.db.query("SELECT * FROM state ORDER BY key").all(), h.sidecar.db.query("SELECT * FROM claim").all()]);
		const before = snapshot();
		const callsBefore = h.sidecar.callsInHour(h.now(), "github");
		const entries = h.ledger.entries(STANDING_WORKLOAD_ID).length;
		h.gh.calls.length = 0;
		const r = await run();
		expect(r).toEqual({ code: 1, out: ["drift: 1", `github ${REPO} #${issue.number} ${id}: labels [as2, question, waiting] (ledger: [as2, waiting])`], err: [] });
		expect(snapshot()).toBe(before);
		expect(h.ledger.entries(STANDING_WORKLOAD_ID)).toHaveLength(entries);
		expect(h.gh.calls.every((a) => ["issue list", "issue view", "pr list", "pr view"].includes(`${a[0]} ${a[1]}`))).toBe(true);
		expect(h.gh.calls.length).toBeGreaterThan(0);
		expect(h.sidecar.callsInHour(h.now(), "github")).toBe(callsBefore + h.gh.calls.length);

		// The reconciler, an hour on, reports the same line.
		await h.hourly();
		expect(h.last().split("\n")[1]).toBe(r.out[1]!);
	});

	test("its calls count against the projector's hourly budget and its own per-run cap; at either cap it makes no further call and prints unknown (budget)", async () => {
		const h = setup();
		const { issue } = await h.pushedOne();
		const cfg = join(tmp("rc-cfg-budget"), "config.yml");
		const caps = (perTick: number, perHour: number) =>
			writeFileSync(cfg, `issues:\n  trackers:\n    - { match: ${REPO}, kind: github }\n  jo: jo\n  perTick: ${perTick}\n  perHour: ${perHour}\n`);
		const env = { AGENT_SYSTEM_LEDGER_DB: h.path, AGENT_SYSTEM_ISSUES_CONFIG: cfg };
		const run = async () => {
			const out: string[] = [];
			const code = await check({ env, exec: h.exec, fetch: h.linear.fetch, out: (l) => out.push(l), err: () => {}, now: h.now });
			return { code, out };
		};
		const hour = () => h.sidecar.callsInHour(h.now(), "github");

		// Under both caps: every gh call it makes is one more call in the sidecar's hour.
		caps(20, 300);
		let before = hour();
		h.gh.calls.length = 0;
		expect(await run()).toEqual({ code: 0, out: ["drift: 0"] });
		expect(h.gh.calls.length).toBeGreaterThan(0);
		expect(hour()).toBe(before + h.gh.calls.length);

		// The hour already spent (the projector's calls and the check's own): no call at all.
		caps(20, hour());
		before = hour();
		h.gh.calls.length = 0;
		expect(await run()).toEqual({ code: 1, out: ["drift: unknown (budget)"] });
		expect(h.gh.calls).toEqual([]);
		expect(hour()).toBe(before);

		// The per-run cap: the issue off the as2 list needs a second call (its view); the first is made and counted, then it stops.
		issue.labels.delete(LABEL.as2);
		caps(1, 10_000);
		before = hour();
		h.gh.calls.length = 0;
		expect(await run()).toEqual({ code: 1, out: ["drift: unknown (budget)"] });
		expect(h.gh.calls).toHaveLength(1);
		expect(hour()).toBe(before + 1);
	});

	test("a bad argument, no issues block, or no sidecar exits 2", async () => {
		const bad = Bun.spawnSync(["bun", SCRIPT, "drain"], { stdout: "pipe", stderr: "pipe" });
		expect(bad.exitCode).toBe(2);
		expect(bad.stderr.toString()).toContain("usage: bun surface/scripts/issues.ts check");
		const h = setup();
		const none = join(tmp("rc-none"), "config.yml");
		writeFileSync(none, "other: 1\n");
		const err: string[] = [];
		const io = { exec: h.exec, fetch: h.linear.fetch, out: () => {}, err: (l: string) => err.push(l) };
		expect(await check({ env: { AGENT_SYSTEM_LEDGER_DB: h.path, AGENT_SYSTEM_ISSUES_CONFIG: none }, ...io })).toBe(2);
		const cfg = join(tmp("rc-cfg2"), "config.yml");
		writeFileSync(cfg, `issues:\n  trackers:\n    - { match: ${REPO}, kind: github }\n  jo: jo\n`);
		const elsewhere = join(tmp("rc-empty"), "ledger.db");
		expect(await check({ env: { AGENT_SYSTEM_LEDGER_DB: elsewhere, AGENT_SYSTEM_ISSUES_CONFIG: cfg }, ...io })).toBe(2);
		expect(err[0]).toContain("no issues: block");
		expect(err[1]).toContain("no sidecar at");
	});

	test("on a sidecar not yet migrated it prints unknown, exits 1, and leaves the file byte for byte as it was", async () => {
		const { ledger, path } = tempLedger();
		const sc = sidecarPath({ AGENT_SYSTEM_LEDGER_DB: path });
		const db = new Database(sc, { create: true });
		db.run(`CREATE TABLE links (workload_id TEXT PRIMARY KEY, issue_number INTEGER, repo TEXT, dirty INTEGER NOT NULL DEFAULT 0, force INTEGER NOT NULL DEFAULT 0,
			last_seq INTEGER NOT NULL DEFAULT 0, pushed_hash TEXT, pushed_title TEXT, pushed_labels TEXT, pushed_state TEXT, fails INTEGER NOT NULL DEFAULT 0, next_try_at INTEGER NOT NULL DEFAULT 0)`);
		db.run("CREATE UNIQUE INDEX links_issue ON links (issue_number) WHERE issue_number IS NOT NULL");
		db.run("CREATE TABLE calls (at INTEGER NOT NULL)");
		db.run("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		db.run("INSERT INTO links (workload_id, issue_number, repo, last_seq) VALUES ('wl-old', 7, 'o/r', 3)");
		db.close();
		const before = readFileSync(sc);
		const files = readdirSync(dirname(sc)).sort();
		const cfg = join(tmp("rc-cfg-old"), "config.yml");
		writeFileSync(cfg, `issues:\n  trackers:\n    - { match: ${REPO}, kind: github }\n  jo: jo\n`);
		const gh = new FakeGh();
		const out: string[] = [];
		const code = await check({ env: { AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_ISSUES_CONFIG: cfg }, exec: gh.exec, fetch: new FakeLinear().fetch, out: (l) => out.push(l), err: () => {}, now: () => T0 });
		expect({ code, out }).toEqual({ code: 1, out: ["drift: unknown (sidecar not migrated; start the surface first)"] });
		expect(readFileSync(sc).equals(before)).toBe(true);
		expect(readdirSync(dirname(sc)).sort()).toEqual(files);
		expect(gh.calls).toEqual([]);
		ledger.close();
	});
});

describe("prsOfBlock", () => {
	test("reads the PR lines of the machine block only", () => {
		const body = "Jo's note\n- https://github.com/o/r/pull/9 merged\n<!-- as2:begin -->\nopen questions:\n- q-1: see /pull/3 open\nPRs:\n- https://github.com/o/r/pull/4 open\n- https://github.com/o/r/pull/5 closed\nledger seq: 3\n<!-- as2:end -->";
		expect(prsOfBlock(body)).toEqual([
			{ number: 4, url: "https://github.com/o/r/pull/4", state: "OPEN", base: "" },
			{ number: 5, url: "https://github.com/o/r/pull/5", state: "CLOSED", base: "" },
		]);
		expect(prsOfBlock("no block")).toEqual([]);
	});

	test("reads the lines as Linear stores them: `* [<url>](<<url>>) <state>`, the end marker indented; a link whose text is not its target is not a PR line", () => {
		expect(prsOfBlock(ENG_2284.returned)).toEqual([{ number: 114, url: "https://github.com/thewolff/agent-system-2.0/pull/114", state: "MERGED", base: "" }]);
		const body = "<!-- as2:begin -->\nPRs:\n\n* [https://github.com/o/r/pull/4](<https://github.com/o/r/pull/9>) open\n  <!-- as2:end -->";
		expect(prsOfBlock(body)).toEqual([]);
	});
});
