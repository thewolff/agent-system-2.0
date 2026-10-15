// The issues projector's tick and row (PLAN wl-mv66ylim0gahog §§ 2, 3, 5, 8, § 9.2): seeding, ingest,
// the budget and the claim, backoff, pushes, the PR scan and footers, and first-merge-wins state, on
// one GitHub tracker. GitHub is a fake behind the exec seam (`FakeGh`, issues-fakes.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import issuesRow, { issuesTickInFlight } from "../extensions/issues";
import { recordRepo } from "../src/decision-log";
import { ensureStandingWorkload } from "../src/identity";
import { type IssuesConfig, ISSUES_DEFAULTS } from "../src/issues/config";
import { closesFooter } from "../src/issues/footer";
import { backoffMs, PR_SCAN_UNKNOWN, type TickPhases, tick } from "../src/issues/projector";
import { BLOCK_BEGIN, BLOCK_END, issueTitle, LABEL, PROJECTION_LABELS } from "../src/issues/render";
import { CLAIM_MS, INTAKE_ACCEPTED, STATE, Sidecar, sidecarPath } from "../src/issues/sidecar";
import { switchBody } from "../src/issues/switch";
import { surfaceSession } from "../src/session";
import { pushDestBody, testRequestedBody } from "../src/test-run";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { arg, type FakeIssue, FakeGh, json, out, REPO } from "./issues-fakes";
import { ctxOf, fakePi, tempLedger, timers, tmp } from "./helpers";

const SHA = "a".repeat(40);
const T0 = Date.parse("2026-10-01T10:00:00.000Z");

/** A temp ledger on a moving clock, a temp sidecar beside it, the fake GitHub, and the tick with its options. */
function setup(over: Partial<IssuesConfig> = {}) {
	let t = T0;
	const { ledger, path } = tempLedger(() => new Date(t).toISOString());
	const sidecar = Sidecar.open(sidecarPath({ AGENT_SYSTEM_LEDGER_DB: path }));
	const gh = new FakeGh();
	const repoDir = tmp("checkout");
	const otherDir = tmp("other-checkout");
	gh.origins.set(repoDir, `https://github.com/${REPO}.git`);
	gh.origins.set(otherDir, "git@github.com:x/other.git");
	const config: IssuesConfig = { trackers: [{ match: REPO, tracker: { kind: "github" } }], overrides: {}, jo: "jo", ...ISSUES_DEFAULTS, perTick: 100, perHour: 10_000, ...over };
	const notices: string[] = [];
	let switches = 0;
	const sw = (on: boolean): string => {
		ensureStandingWorkload(ledger);
		t += 1_000;
		return ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: switchBody(on, `in-sw${++switches}`) });
	};
	const h = {
		ledger,
		sidecar,
		gh,
		repoDir,
		otherDir,
		config,
		notices,
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
		run: (o: { holder?: string; phases?: TickPhases } = {}) =>
			tick({ exec: gh.exec, ledger, sidecar, config, holder: o.holder ?? "h1", now: () => t, notice: (l) => notices.push(l), ...(o.phases ? { phases: o.phases } : {}) }),
		/** Open a workload whose `repo:` entry names `repo` (null: none). */
		open: (brief = "build the thing", repo: string | null = repoDir): string => {
			t += 1_000;
			const id = ledger.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });
			if (repo !== null) recordRepo(ledger, id, repo);
			return id;
		},
		close: (id: string): void => {
			t += 1_000;
			ledger.closeWorkload(id, { by: SURFACE_BY });
		},
		slice: (id: string): string => {
			t += 1_000;
			return ledger.addSlice({ by: SURFACE_BY, workloadId: id, task: "t", doneCondition: "d", inputs: "i" });
		},
		on: () => sw(true),
		off: () => sw(false),
		issueOf: (id: string): FakeIssue | undefined => {
			const n = sidecar.link(id)?.issue_number;
			return n === null || n === undefined ? undefined : gh.issues.get(n);
		},
		/** On, one workload on the repo, its issue pushed; the calls so far cleared. */
		pushedOne: async (brief = "build the thing"): Promise<{ id: string; issue: FakeIssue }> => {
			h.on();
			const id = h.open(brief);
			await h.run();
			const issue = h.issueOf(id);
			if (!issue) throw new Error(`no issue for ${id}: ${notices.join("; ")}`);
			gh.calls.length = 0;
			return { id, issue };
		},
	};
	return h;
}

describe("seeding and ingest", () => {
	test("seeding links only the open workloads on the configured repo; the rest are cached as elsewhere or retired", async () => {
		const h = setup();
		const a = h.open("on the repo");
		const b = h.open("on another repo", h.otherDir);
		const c = h.open("closed before on");
		h.close(c);
		const d = h.open("no repo entry", null);
		h.on();
		const r = await h.run();
		expect(r).toMatchObject({ claimed: true, on: true, seeded: true, stopped: null });
		expect(h.gh.issues.size).toBe(1);
		expect(h.issueOf(a)?.title).toBe(issueTitle(a, "on the repo"));
		expect(h.sidecar.link(b)).toMatchObject({ repo: "x/other", dirty: 0, issue_number: null });
		expect(h.sidecar.link(c)).toBeNull();
		expect(h.sidecar.link(d)).toMatchObject({ repo: "-", dirty: 0 });
		expect(h.gh.made("issue create")).toHaveLength(1);
	});

	test("off makes no gh call, and seeding survives off ticks before the first on", async () => {
		const h = setup();
		const a = h.open();
		for (let i = 0; i < 3; i++) {
			const r = await h.run();
			expect(r).toMatchObject({ claimed: true, on: false, seeded: false, calls: 0 });
		}
		expect(h.gh.calls).toHaveLength(0);
		expect(h.sidecar.state(STATE.seededAt)).toBeNull();
		expect(h.sidecar.cursor()).not.toBeNull();
		h.off();
		await h.run();
		expect(h.gh.calls).toHaveLength(0);
		h.on();
		const r = await h.run();
		expect(r.seeded).toBe(true);
		expect(h.issueOf(a)).toBeDefined();
	});

	test("a workload opened between the seeding snapshot and the sidecar write is ingested in the same tick", async () => {
		const h = setup();
		const a = h.open("before the snapshot");
		h.on();
		let b = "";
		h.gh.onGit = () => {
			h.gh.onGit = null;
			b = h.open("inside the seeding window");
		};
		await h.run();
		expect(b).not.toBe("");
		expect(h.issueOf(a)).toBeDefined();
		expect(h.issueOf(b)?.title).toBe(issueTitle(b, "inside the seeding window"));
	});

	test("intake_since is the on entry's created_at, not the seeding tick's clock", async () => {
		const h = setup();
		h.on();
		const onAt = new Date(h.now()).toISOString();
		h.advance(10 * 60_000);
		await h.run();
		expect(h.sidecar.state(STATE.intakeSince)).toBe(onAt);
		expect(h.sidecar.state(STATE.seededAt)).toBe(new Date(h.now()).toISOString());
	});

	test("a lease-only renewal marks nothing; a holder change does", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		h.ledger.claimWorkload(id, { by: "lane-x-1", holder: "lane-x-1", leaseMs: 60_000 });
		await h.run();
		expect([...issue.labels].sort()).toEqual([LABEL.as2, LABEL.running]);
		h.gh.calls.length = 0;
		h.advance(5_000);
		h.ledger.claimWorkload(id, { by: "lane-x-1", holder: "lane-x-1", leaseMs: 60_000 });
		const r = await h.run();
		expect(r.ingested).toBe(0);
		expect(h.sidecar.link(id)?.dirty).toBe(0);
		expect(h.gh.calls.map((a) => `${a[0]} ${a[1]}`)).toEqual(["pr list"]);
	});

	test("off, a workload opens, on: its issue is created; one opened and closed while off gets none", async () => {
		const h = setup();
		h.on();
		await h.run();
		h.off();
		const a = h.open("opened while off");
		const b = h.open("opened and closed while off");
		h.close(b);
		await h.run();
		expect(h.gh.made("issue create")).toHaveLength(0);
		h.on();
		await h.run();
		expect(h.issueOf(a)?.title).toBe(issueTitle(a, "opened while off"));
		expect(h.sidecar.link(b)).toBeNull();
		expect(h.gh.made("issue create")).toHaveLength(1);
	});
});

describe("the budget and the claim", () => {
	test("perTick stops the tick at the cap, counting rate_limit and the scan; later ticks finish the work", async () => {
		const h = setup({ perTick: 20 });
		h.on();
		const ids = Array.from({ length: 10 }, (_, i) => h.open(`workload ${i}`));
		const r = await h.run();
		expect(r).toMatchObject({ stopped: "budget", calls: 20 });
		expect(h.gh.calls).toHaveLength(20);
		expect(h.gh.calls[0]).toEqual(["api", "rate_limit", "--jq", ".resources.core.remaining"]);
		expect(h.gh.made("pr list").some((a) => arg(a, "--state") === "open")).toBe(true);
		expect(h.sidecar.callsInHour(h.now())).toBe(20);
		for (let i = 0; i < 5; i++) await h.run();
		for (const id of ids) expect(h.issueOf(id)).toBeDefined();
		expect(h.gh.made("issue create")).toHaveLength(10);
	});

	test("perHour stops every tick once the hour's calls are spent, until the hour rolls", async () => {
		const h = setup({ perTick: 20, perHour: 25 });
		h.on();
		for (let i = 0; i < 10; i++) h.open(`workload ${i}`);
		expect((await h.run()).calls).toBe(20);
		expect(await h.run()).toMatchObject({ stopped: "budget", calls: 5 });
		expect(await h.run()).toMatchObject({ stopped: "budget", calls: 0 });
		expect(h.gh.calls).toHaveLength(25);
		h.advance(60 * 60_000 + 1);
		const r = await h.run();
		expect(r.calls).toBeGreaterThan(0);
	});

	test("a second holder makes no call while the claim is live; after its expiry the tick takes it over", async () => {
		const h = setup();
		h.on();
		const a = h.open();
		expect(h.sidecar.claim("h2", h.now())).toBe(true);
		expect(await h.run()).toMatchObject({ claimed: false, calls: 0 });
		expect(h.gh.calls).toHaveLength(0);
		h.advance(CLAIM_MS + 1);
		expect((await h.run()).claimed).toBe(true);
		expect(h.issueOf(a)).toBeDefined();
	});

	test("a claim lost mid-tick (clock-injected expiry) stops the tick; the new holder adopts the created issue, no duplicate", async () => {
		const h = setup();
		h.on();
		const a = h.open("first");
		const b = h.open("second");
		h.gh.onCall = (args) => {
			if (`${args[0]} ${args[1]}` !== "issue create") return;
			h.gh.onCall = null;
			h.advance(CLAIM_MS + 1);
			expect(h.sidecar.claim("h2", h.now())).toBe(true);
		};
		const r = await h.run({ holder: "h1" });
		expect(r.stopped).toBe("lost");
		expect(h.gh.issues.size).toBe(1);
		expect(h.sidecar.link(a)?.issue_number).toBeNull();
		expect(await h.run({ holder: "h1" })).toMatchObject({ claimed: false });
		const r2 = await h.run({ holder: "h2" });
		expect(r2.stopped).toBeNull();
		expect(h.gh.issues.size).toBe(2);
		expect(h.issueOf(a)?.title).toBe(issueTitle(a, "first"));
		expect(h.issueOf(b)?.title).toBe(issueTitle(b, "second"));
		expect(h.gh.made("issue create")).toHaveLength(2);
	});

	test("the projection's labels are created once", async () => {
		const h = setup();
		h.gh.labels.clear();
		h.gh.labels.add("as2");
		h.on();
		await h.run();
		expect(h.gh.made("label create").map((a) => a[2])).toEqual(PROJECTION_LABELS.filter((l) => l !== "as2"));
		await h.run();
		expect(h.gh.made("label list")).toHaveLength(1);
		expect(h.gh.made("label create")).toHaveLength(PROJECTION_LABELS.length - 1);
	});

	test("under the rate floor the scan, footers and pushes pause; the hourly read is made once an hour", async () => {
		const h = setup();
		h.gh.remaining = 100;
		h.on();
		const a = h.open();
		await h.run();
		expect(h.issueOf(a)).toBeUndefined();
		expect(h.gh.made("pr list")).toHaveLength(0);
		expect(h.notices.some((n) => n.includes("rate limit low"))).toBe(true);
		h.gh.remaining = 5000;
		await h.run();
		expect(h.gh.made("api rate_limit")).toHaveLength(1);
		h.advance(60 * 60_000);
		await h.run();
		expect(h.gh.made("api rate_limit")).toHaveLength(2);
		expect(h.issueOf(a)).toBeDefined();
	});
});

describe("failures and backoff", () => {
	test("a failed create backs the link off without a throw, retries after the backoff, and parks at parkAfterFails", async () => {
		const h = setup({ parkAfterFails: 2 });
		h.gh.fail = (a) => `${a[0]} ${a[1]}` === "issue create";
		h.on();
		const a = h.open();
		const r = await h.run();
		expect(r.stopped).toBe("failed");
		expect(h.sidecar.link(a)).toMatchObject({ fails: 1, dirty: 1, next_try_at: h.now() + backoffMs(1) });
		expect(h.notices.some((n) => n.includes("HTTP 502"))).toBe(true);
		h.gh.calls.length = 0;
		expect((await h.run()).stopped).toBeNull();
		expect(h.gh.made("issue create")).toHaveLength(0);
		h.advance(backoffMs(1));
		await h.run();
		expect(h.gh.made("issue create")).toHaveLength(1);
		expect(h.sidecar.link(a)?.fails).toBe(2);
		expect(h.notices.some((n) => n.includes("parked after 2 failed pushes"))).toBe(true);
		h.gh.fail = () => false;
		h.advance(2 * 60 * 60_000);
		await h.run();
		expect(h.issueOf(a)).toBeUndefined();
	});

	test("a lost create is recovered by its title; Jo's text outside the block is kept on every push", async () => {
		const h = setup();
		h.on();
		const a = h.open("recover me");
		const lost = h.gh.addIssue({ title: issueTitle(a, "recover me"), body: "Jo's words", labels: new Set([LABEL.as2]) });
		await h.run();
		expect(h.gh.made("issue create")).toHaveLength(0);
		expect(h.sidecar.link(a)?.issue_number).toBe(lost.number);
		expect(lost.body.startsWith(BLOCK_BEGIN)).toBe(true);
		expect(lost.body.endsWith("\n\nJo's words")).toBe(true);
		expect([...lost.labels].sort()).toEqual([LABEL.as2, LABEL.waiting]);
		const block = lost.body.slice(0, lost.body.indexOf(BLOCK_END) + BLOCK_END.length);
		lost.body = `Jo above\n\n${block}\n\nJo below`;
		h.slice(a);
		await h.run();
		expect(lost.body.startsWith("Jo above\n\n<!-- as2:begin -->")).toBe(true);
		expect(lost.body.endsWith("<!-- as2:end -->\n\nJo below")).toBe(true);
		expect(lost.body).toContain("slices: 1 open");
	});

	test("a closed issue whose stateReason drifted is repaired by reopen then close with the rendered reason", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		h.close(id);
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
		issue.stateReason = "NOT_PLANNED";
		h.sidecar.db.query("UPDATE links SET force = 1, dirty = 1 WHERE workload_id = ?").run(id);
		h.gh.calls.length = 0;
		await h.run();
		expect(h.gh.calls.filter((a) => a[0] === "issue" && (a[1] === "reopen" || a[1] === "close")).map((a) => a[1])).toEqual(["reopen", "close"]);
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
	});

	test("a full branch list makes the PR set unknown: no render change, backed off", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const body = issue.body;
		h.gh.branchPad.set(`wl/${id}`, 1000);
		h.slice(id);
		const r = await h.run();
		expect(r.stopped).toBe("failed");
		expect(h.gh.made("issue view")).toHaveLength(0);
		expect(h.gh.made("issue edit")).toHaveLength(0);
		expect(issue.body).toBe(body);
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 1, fails: 1 });
		expect(h.notices.some((n) => n.includes("PR set unknown"))).toBe(true);
	});
});

describe("the PR scan and footers", () => {
	test("a lane PR opened after the push gets its footer on the next scan, with no ledger change", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const pr = h.gh.addPr(`wl/${id}`);
		await h.run();
		expect(pr.body).toBe(`lane body${closesFooter(issue.number)}`);
		expect(issue.body).toContain(`- ${pr.url} open`);
		h.gh.calls.length = 0;
		await h.run();
		await h.run();
		expect(h.gh.made("pr edit")).toHaveLength(0);
	});

	test("a push-dest PR, a lane PR and a test-requested PR each get one footer; a footed PR is not edited again; a removed footer is restored on the next scan", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		h.ledger.claimWorkload(id, { by: "lane-x-1", holder: "lane-x-1", leaseMs: null });
		h.ledger.recordEntry({ by: "lane-x-1", workloadId: id, kind: "assumption", body: pushDestBody({ remote: "origin", branch: "feature/side", sha: SHA }) });
		const lane = h.gh.addPr(`wl/${id}`);
		const side = h.gh.addPr("feature/side");
		const asked = h.gh.addPr("jo/hand-made");
		h.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: id, kind: "assumption", body: testRequestedBody({ runId: "tr-abc1234", pr: asked.number, sha: SHA, slice: "sl-x", by: "lane-x-1" }) });
		await h.run();
		const footer = closesFooter(issue.number);
		for (const pr of [lane, side, asked]) expect(pr.body).toBe(`lane body${footer}`);
		expect(h.gh.made("pr edit")).toHaveLength(3);
		h.slice(id);
		await h.run();
		await h.run();
		expect(h.gh.made("pr edit")).toHaveLength(3);
		// The footer removed by an edit is owed again: the scan alone (no ledger change) restores it, once.
		lane.body = "Jo edited the body";
		await h.run();
		expect(lane.body).toBe(`Jo edited the body${footer}`);
		expect(h.sidecar.prs().find((p) => p.number === lane.number)?.footer).toBe("done");
		await h.run();
		expect(h.gh.made("pr edit")).toHaveLength(4);
	});

	test("a non-default-base PR gets no footer; its merge closes the closed workload's issue within one tick", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const pr = h.gh.addPr(`wl/${id}`, { base: "develop" });
		await h.run();
		expect(h.sidecar.prs()).toMatchObject([{ number: pr.number, footer: "none" }]);
		expect(h.gh.made("pr edit")).toHaveLength(0);
		h.close(id);
		await h.run();
		expect(issue.state).toBe("OPEN");
		expect(issue.labels.has(LABEL.awaitingMerge)).toBe(true);
		pr.state = "MERGED";
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
		expect(issue.labels.has(LABEL.awaitingMerge)).toBe(false);
		expect(h.gh.made("pr edit")).toHaveLength(0);
	});

	test("a PR retargeted onto the default branch gets its footer on the next scan; retargeted off again it records none and is not edited", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const pr = h.gh.addPr(`wl/${id}`, { base: "develop" });
		await h.run();
		expect(h.sidecar.prs()).toMatchObject([{ number: pr.number, base: "develop", footer: "none" }]);
		expect(h.gh.made("pr edit")).toHaveLength(0);
		pr.base = "main";
		await h.run();
		expect(pr.body).toBe(`lane body${closesFooter(issue.number)}`);
		expect(h.sidecar.prs()).toMatchObject([{ number: pr.number, base: "main", footer: "done" }]);
		expect(h.gh.made("pr edit")).toHaveLength(1);
		pr.base = "develop";
		await h.run();
		expect(h.sidecar.prs()).toMatchObject([{ number: pr.number, base: "develop", footer: "none" }]);
		expect(h.gh.made("pr edit")).toHaveLength(1);
	});

	test("a PR merged before any scan saw it closes the issue from MERGED", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		h.gh.addPr(`wl/${id}`, { state: "MERGED" });
		h.close(id);
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
	});

	test("a scan of 200 open PRs marks nothing", async () => {
		const h = setup();
		const { id } = await h.pushedOne();
		h.gh.scanPad = 200;
		const pr = h.gh.addPr(`wl/${id}`);
		const r = await h.run();
		expect(r.stopped).toBeNull();
		expect(h.sidecar.prs()).toHaveLength(0);
		expect(h.sidecar.link(id)?.dirty).toBe(0);
		expect(pr.body).toBe("lane body");
		expect(h.notices.some((n) => n.includes("nothing was marked"))).toBe(true);
	});

	test("a truncated or failed open-PR scan records pr_scan_unknown for the reconciler; a complete scan clears it", async () => {
		const h = setup();
		await h.pushedOne();
		expect(h.sidecar.state(PR_SCAN_UNKNOWN)).toBeNull();
		h.gh.scanPad = 200;
		await h.run();
		expect(h.sidecar.state(PR_SCAN_UNKNOWN)).toBe(`200 open PRs on ${REPO}, the scan's limit`);
		h.gh.scanPad = 0;
		await h.run();
		expect(h.sidecar.state(PR_SCAN_UNKNOWN)).toBeNull();
		h.gh.fail = (a) => `${a[0]} ${a[1]}` === "pr list" && arg(a, "--state") === "open";
		expect((await h.run()).stopped).toBe("failed");
		expect(h.sidecar.state(PR_SCAN_UNKNOWN)).toContain("HTTP 502");
		h.gh.fail = () => false;
		await h.run();
		expect(h.sidecar.state(PR_SCAN_UNKNOWN)).toBeNull();
	});

	test("a PR opened on a closed, unmerged workload's branch reopens its issue as awaiting-merge; once a PR merged, a later PR leaves it closed", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		h.close(id);
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
		expect(h.sidecar.link(id)?.pushed_state).toBe("closed completed");
		// The decision-log PR publication opens after the tick that pushed the close: no ledger change wakes the link.
		const log = h.gh.addPr(`wl/${id}`, { body: "decision log" });
		await h.run();
		expect(issue.state).toBe("OPEN");
		expect([...issue.labels].sort()).toEqual([LABEL.as2, LABEL.awaitingMerge]);
		expect(log.body).toBe(`decision log${closesFooter(issue.number)}`);
		log.state = "MERGED";
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
		h.gh.calls.length = 0;
		const later = h.gh.addPr(`wl/${id}`);
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
		expect(issue.body).toContain(`- ${later.url} open`);
		expect(h.gh.made("issue reopen")).toHaveLength(0);
	});

	test("a closed link's repo is scanned only inside 24 h of the close and while no PR of its set merged; an open link's repo always is", async () => {
		// An owner glob: no exact rule keeps x/other in the scan, only its links do.
		const h = setup({ trackers: [{ match: "x/*", tracker: { kind: "github" } }] });
		h.on();
		const scans = () => h.gh.calls.filter((a) => `${a[0]} ${a[1]}` === "pr list" && arg(a, "--state") === "open" && arg(a, "-R") === "x/other").length;
		const late = h.open("closes without a PR", h.otherDir);
		const merged = h.open("closes merged", h.otherDir);
		await h.run();
		h.gh.addPr(`wl/${merged}`, { state: "MERGED" });
		h.close(late);
		h.close(merged);
		await h.run();
		expect(h.sidecar.link(late)?.pushed_state).toBe("closed completed");
		expect(h.sidecar.link(merged)?.pushed_state).toBe("closed completed");
		// Inside the window: the closed, unmerged link keeps its repo in the scan.
		h.gh.calls.length = 0;
		await h.run();
		expect(scans()).toBe(1);
		// Past the 24 h window (LATE_PR_WINDOW_MS): neither closed link adds its repo.
		h.advance(24 * 60 * 60_000);
		h.gh.calls.length = 0;
		await h.run();
		expect(scans()).toBe(0);
		// The merged one alone, inside its window: merged is final, so no scan either.
		const merged2 = h.open("closes merged too", h.otherDir);
		await h.run();
		h.gh.addPr(`wl/${merged2}`, { state: "MERGED" });
		h.close(merged2);
		await h.run();
		h.gh.calls.length = 0;
		await h.run();
		expect(scans()).toBe(0);
		// An open link on the repo puts it back.
		h.open("still open", h.otherDir);
		await h.run();
		h.gh.calls.length = 0;
		await h.run();
		expect(scans()).toBe(1);
	});

	test("a test-requested PR outside every branch list is fetched by number, footed, and its merge closes the closed workload's issue within one tick", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const pr = h.gh.addPr("jo/elsewhere");
		h.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: id, kind: "assumption", body: testRequestedBody({ runId: "tr-def5678", pr: pr.number, sha: SHA, slice: "sl-x", by: "lane-x-1" }) });
		await h.run();
		expect(pr.body).toBe(`lane body${closesFooter(issue.number)}`);
		expect(h.gh.made("pr view").some((a) => a[2] === String(pr.number))).toBe(true);
		h.close(id);
		await h.run();
		expect(issue.state).toBe("OPEN");
		expect(issue.labels.has(LABEL.awaitingMerge)).toBe(true);
		pr.state = "MERGED";
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
	});
});

describe("first merge wins", () => {
	test("A merged + B open on a closed workload: closed completed, not reopened by the next scan, and B closing later changes nothing", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const a = h.gh.addPr(`wl/${id}`);
		const b = h.gh.addPr(`wl/${id}`);
		await h.run();
		a.state = "MERGED";
		h.close(id);
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
		h.gh.calls.length = 0;
		await h.run();
		b.state = "CLOSED";
		await h.run();
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
		expect(h.gh.calls.filter((x) => x[0] === "issue" && (x[1] === "reopen" || x[1] === "close"))).toHaveLength(0);
		expect(issue.labels.has(LABEL.unmerged)).toBe(false);
	});

	test("A closed unmerged + B open: open awaiting-merge; both closed unmerged: closed not planned and unmerged", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const a = h.gh.addPr(`wl/${id}`);
		const b = h.gh.addPr(`wl/${id}`);
		await h.run();
		a.state = "CLOSED";
		h.close(id);
		await h.run();
		expect(issue.state).toBe("OPEN");
		expect([...issue.labels].sort()).toEqual([LABEL.as2, LABEL.awaitingMerge]);
		b.state = "CLOSED";
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });
		expect([...issue.labels].sort()).toEqual([LABEL.as2, LABEL.unmerged]);
	});

	test("the lane PR merged, then the decision-log PR opened: closed completed at the ledger close", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		const lane = h.gh.addPr(`wl/${id}`);
		await h.run();
		lane.state = "MERGED";
		await h.run();
		expect(issue.state).toBe("OPEN");
		h.close(id);
		const log = h.gh.addPr(`wl/${id}`, { body: "decision log" });
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
		expect(issue.body).toContain(`- ${log.url} open`);
	});

	test("a merged PR beyond the first 30 of its branch still counts", async () => {
		const h = setup();
		const { id, issue } = await h.pushedOne();
		for (let i = 0; i < 40; i++) h.gh.addPr(`wl/${id}`, { state: i === 34 ? "MERGED" : "CLOSED" });
		h.close(id);
		await h.run();
		expect(issue).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
	});
});

describe("intake binding and phases", () => {
	test("an accepted intake issue whose input id the brief quotes is adopted: no create, retitled, intake label gone, Jo's text kept", async () => {
		const h = setup();
		const jo = h.gh.addIssue({ title: "Please add a dark mode", body: "Jo's ask", labels: new Set([LABEL.intake]) });
		h.sidecar.db
			.query("INSERT INTO intake (issue_number, verdict, reason, in_id, acked, seen_at) VALUES (?, ?, ?, ?, 1, ?)")
			.run(jo.number, INTAKE_ACCEPTED, null, "in-jo1", new Date(h.now()).toISOString());
		h.on();
		const id = h.open("Add a dark mode (from in-jo1)");
		await h.run();
		expect(h.gh.made("issue create")).toHaveLength(0);
		expect(h.gh.made("issue list")).toHaveLength(0);
		expect(h.sidecar.link(id)?.issue_number).toBe(jo.number);
		expect(jo.title).toBe(issueTitle(id, "Add a dark mode (from in-jo1)"));
		expect([...jo.labels].sort()).toEqual([LABEL.as2, LABEL.waiting]);
		expect(jo.body.endsWith("\n\nJo's ask")).toBe(true);
	});

	test("phases run after the push while on, reconcile first, in the tick's budget; a phase's throw is one notice", async () => {
		const h = setup();
		const order: string[] = [];
		const phases: TickPhases = {
			reconcile: async (ctx) => {
				order.push(`reconcile:${ctx.defaultBranch}:${ctx.rateLow}`);
				const r = await ctx.gh.run(["api", "rate_limit", "--jq", ".resources.core.remaining"]);
				expect(r.ok).toBe(true);
			},
			intake: async () => {
				order.push("intake");
				throw new Error("boom");
			},
		};
		await h.run({ phases });
		expect(order).toEqual([]);
		h.on();
		const r = await h.run({ phases });
		expect(order).toEqual(["reconcile:main:false", "intake"]);
		expect(r.calls).toBe(h.gh.calls.length);
		expect(h.gh.made("api rate_limit")).toHaveLength(2);
		expect(h.notices).toContain("the intake phase failed: boom");
	});

	test("a GitHub budget stop still runs reconcile with stopped = {github: budget}; intake waits", async () => {
		const h = setup({ perTick: 1 });
		const seen: ReadonlyMap<string, string>[] = [];
		const phases: TickPhases = {
			reconcile: async (ctx) => {
				seen.push(new Map(ctx.stopped));
			},
			intake: async () => {
				throw new Error("intake must not run while GitHub is stopped");
			},
		};
		h.on();
		h.open();
		const r = await h.run({ phases });
		expect(r.stopped).toBe("budget");
		expect(h.gh.calls).toHaveLength(1);
		expect(seen).toEqual([new Map([["github", "budget"]])]);
		expect(h.notices.some((n) => n.includes("intake"))).toBe(false);
	});
});

describe("the issues row", () => {
	afterEach(() => {
		timers.length = 0;
	});

	function rowEnv(config: string) {
		const ledgerPath = join(tmp("row-ledger"), "ledger.db");
		Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false }).close();
		const configPath = join(tmp("row-config"), "config.yml");
		writeFileSync(configPath, config);
		return {
			AGENT_SYSTEM_ROLE: "orchestrator",
			AGENT_SYSTEM_LEDGER_DB: ledgerPath,
			AGENT_SYSTEM_ISSUES_CONFIG: configPath,
			AGENT_SYSTEM_SURFACE_POLL_MS: "1234",
			HOME: "/nonexistent-home",
		};
	}

	test("a session that is not the surface registers nothing", async () => {
		const e = { ...rowEnv(`issues:\n  trackers:\n    - match: ${REPO}\n      kind: github\n  jo: jo\n`), AGENT_SYSTEM_ROLE: "lane" };
		const f = fakePi(undefined, { exec: true });
		issuesRow(f.pi, e);
		timers.length = 0;
		await f.emit("session_start", { type: "session_start" }, ctxOf());
		expect(timers).toHaveLength(0);
	});

	test("the surface registers one interval at the poll cadence; a tick runs fire-and-forget, one at a time", async () => {
		const e = rowEnv(`issues:\n  trackers:\n    - match: ${REPO}\n      kind: github\n  jo: jo\n`);
		const ledger = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { backup: false, backupOnOpen: false });
		ensureStandingWorkload(ledger);
		ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: switchBody(true, "in-on1") });
		ledger.close();
		const f = fakePi(undefined, { exec: true });
		f.execs.answer = (_c, args) => {
			if (args[0] === "api") return out("5000\n");
			if (args[0] === "repo") return json({ defaultBranchRef: { name: "main" } });
			if (args[0] === "label") return json(PROJECTION_LABELS.map((name) => ({ name })));
			return json([]);
		};
		issuesRow(f.pi, e, { phases: {} });
		timers.length = 0;
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		expect(timers).toEqual([{ fn: expect.any(Function), ms: 1234 }]);
		const s = surfaceSession(ctx, e);
		timers[0]!.fn();
		const first = issuesTickInFlight(s);
		timers[0]!.fn();
		expect(issuesTickInFlight(s)).toBe(first);
		await first;
		expect(f.execs.calls.map((c) => `${c.command} ${c.args[0]} ${c.args[1]}`)).toEqual(["gh api rate_limit", "gh repo view", "gh label list", "gh pr list"]);
		timers[0]!.fn();
		await issuesTickInFlight(s);
		expect(f.execs.calls).toHaveLength(5);
		expect(s.tickNotices).toEqual([]);
		await f.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	});

	test("no issues: block makes no call; a malformed block is one notice however many ticks see it", async () => {
		const e = rowEnv("other: 1\n");
		const f = fakePi(undefined, { exec: true });
		issuesRow(f.pi, e);
		timers.length = 0;
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		const s = surfaceSession(ctx, e);
		timers[0]!.fn();
		await issuesTickInFlight(s);
		expect(f.execs.calls).toHaveLength(0);
		writeFileSync(e.AGENT_SYSTEM_ISSUES_CONFIG, "issues:\n  repo: not a repo\n");
		for (let i = 0; i < 2; i++) {
			timers[0]!.fn();
			await issuesTickInFlight(s);
		}
		expect(f.execs.calls).toHaveLength(0);
		expect(s.tickNotices).toHaveLength(1);
		expect(s.tickNotices[0]).toStartWith("tick: issues: the issues: block of the profile config does not parse:");
	});
});
