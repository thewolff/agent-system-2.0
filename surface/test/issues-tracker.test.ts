// Trackers per repo (PLAN wl-mv66ylim0gahog § 13.2, § 13.4 item 2): the `issues.trackers` /
// `issues.overrides` config, the effective-tracker precedence (newest `tracker:` entry, override,
// repo map), routing a workload to GitHub or a Linear team, the seeded override for
// wl-mv5jz4vewt8mbk, a tracker move (old item closed not planned, its footers stripped), per-tracker
// caps, the Linear workflow state and labels for every render state, Linear failures and the key's
// redaction, and the `pushed_seq` receipt (§ 13.3). GitHub is `FakeGh` behind the exec seam and
// Linear is `FakeLinear` behind the injected fetch (issues-fakes.ts): no network call.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TEST_RUNNER_BY } from "../../ledger/src/index";
import { recordRepo } from "../src/decision-log";
import { ensureStandingWorkload } from "../src/identity";
import { intakeRepo, type IssuesConfig, issuesConfig, loadIssuesConfig, matchTracker, parseTrackerKey } from "../src/issues/config";
import { closesFooter } from "../src/issues/footer";
import { LINEAR_LABELS } from "../src/issues/linear";
import { tick } from "../src/issues/projector";
import { BLOCK_BEGIN, BLOCK_END, blockHash, issueTitle, LABEL } from "../src/issues/render";
import { schemaCurrent, STATE, Sidecar, sidecarPath } from "../src/issues/sidecar";
import { switchBody } from "../src/issues/switch";
import { effectiveTracker, linkTracker, trackerEntryBody, trackerEntryOf } from "../src/issues/tracker";
import { testRequestedBody } from "../src/test-run";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { type FakeLinearIssue, FakeGh, FakeLinear } from "./issues-fakes";
import { tempLedger, tmp } from "./helpers";

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const SHA = "b".repeat(40);
const KEY = "lin_api_SECRET0123456789abcdef";
const AS2 = "thewolff/agent-system-2.0";
const JO_ISSUES = "thewolff/jo-issues";
const SEO = "wl-mv5jz4vewt8mbk";

/** The checkout's own profile/config.yml `issues:` block: the trackers and the seeded override Jo merges. */
function profileConfig(): IssuesConfig {
	const c = loadIssuesConfig({});
	if (!c.ok || c.config === null) throw new Error(`profile/config.yml issues block: ${c.ok ? "absent" : c.error}`);
	return c.config;
}

/** A temp ledger and sidecar, the fake GitHub and Linear, three checkouts (as2, a ContextPress repo, jo-wolff-plugins), and the tick on the profile's trackers. */
function setup(o: { over?: Partial<IssuesConfig>; key?: string | null } = {}) {
	let t = T0;
	const { ledger, path } = tempLedger(() => new Date(t).toISOString());
	const sidecar = Sidecar.open(sidecarPath({ AGENT_SYSTEM_LEDGER_DB: path }));
	const gh = new FakeGh();
	const linear = new FakeLinear();
	const dirs = { as2: tmp("as2"), shipyard: tmp("shipyard"), plugins: tmp("plugins") };
	gh.origins.set(dirs.as2, `https://github.com/${AS2}.git`);
	gh.origins.set(dirs.shipyard, "git@github.com:ContextPress/shipyard.git");
	gh.origins.set(dirs.plugins, "git@github.com:thewolff/jo-wolff-plugins.git");
	const config: IssuesConfig = { ...profileConfig(), perTick: 100, perHour: 10_000, ...o.over };
	const notices: string[] = [];
	const key = o.key === undefined ? KEY : o.key;
	const h = {
		ledger,
		sidecar,
		gh,
		linear,
		dirs,
		config,
		notices,
		advance: (ms: number) => {
			t += ms;
		},
		run: () => tick({ exec: gh.exec, ledger, sidecar, config, holder: "h1", now: () => t, notice: (l) => notices.push(l), linear: { key, fetch: linear.fetch } }),
		on: () => {
			ensureStandingWorkload(ledger);
			t += 1_000;
			ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: switchBody(true, "in-sw1") });
		},
		open: (brief: string, dir: string, id?: string): string => {
			t += 1_000;
			const wl = ledger.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous", ...(id ? { id } : {}) });
			recordRepo(ledger, wl, dir);
			return wl;
		},
		close: (id: string) => {
			t += 1_000;
			ledger.closeWorkload(id, { by: SURFACE_BY });
		},
		/** Jo's typed `tracker` word as the surface records it. */
		retrack: (id: string, tracker: Parameters<typeof trackerEntryBody>[1]) => {
			t += 1_000;
			ledger.recordEntry({ by: SURFACE_BY, workloadId: id, kind: "assumption", body: trackerEntryBody(id, tracker, "in-tr1") });
		},
		linearOf: (id: string): FakeLinearIssue | undefined => {
			const ext = sidecar.link(id)?.external_id;
			return ext ? linear.issues.get(ext) : undefined;
		},
	};
	return h;
}

describe("config: issues.trackers and issues.overrides", () => {
	test("the profile's block: as2 on GitHub, ContextPress/* on Linear ENG, wl-mv5jz4vewt8mbk overridden to Linear ENG, intake on jo-issues skipping plumb and as2-train", () => {
		const c = profileConfig();
		expect(c.trackers).toEqual([
			{ match: AS2, tracker: { kind: "github" } },
			{ match: "ContextPress/*", tracker: { kind: "linear", team: "ENG" } },
		]);
		expect(c.overrides).toEqual({ [SEO]: { kind: "linear", team: "ENG" } });
		expect(c.intakeRepo).toBe(JO_ISSUES);
		expect(intakeRepo(c)).toBe(JO_ISSUES);
		expect(c.intakeSkipLabels).toEqual(["plumb", "as2-train"]);
	});

	test("issues.intakeRepo is the intake repo when set; unset, the first exact GitHub rule's repo; intakeSkipLabels defaults to plumb and as2-train, lower-cased", () => {
		const trackers = [{ match: "thewolff/*", kind: "github" }, { match: AS2, kind: "github" }];
		const unset = issuesConfig({ issues: { trackers, jo: "jo" } });
		if (!unset.ok || unset.config === null) throw new Error("expected a config");
		expect(unset.config.intakeRepo).toBeUndefined();
		expect(intakeRepo(unset.config)).toBe(AS2);
		expect(unset.config.intakeSkipLabels).toEqual(["plumb", "as2-train"]);
		const set = issuesConfig({ issues: { trackers, jo: "jo", intakeRepo: JO_ISSUES, intakeSkipLabels: ["Plumb", "bot"] } });
		if (!set.ok || set.config === null) throw new Error("expected a config");
		expect(intakeRepo(set.config)).toBe(JO_ISSUES);
		expect(set.config.intakeSkipLabels).toEqual(["plumb", "bot"]);
		const none = issuesConfig({ issues: { trackers, jo: "jo", intakeSkipLabels: [] } });
		expect(none.ok && none.config?.intakeSkipLabels).toEqual([]);
		expect(intakeRepo({ trackers: [{ match: "ContextPress/*", tracker: { kind: "linear", team: "ENG" } }] })).toBeNull();
	});

	test("first match wins, the owner glob covers every repo of the owner, matching ignores case, no match is none", () => {
		const rules = profileConfig().trackers;
		expect(matchTracker(rules, "contextpress/shipyard")).toEqual({ kind: "linear", team: "ENG" });
		expect(matchTracker(rules, "ContextPress/newdle-mobile")).toEqual({ kind: "linear", team: "ENG" });
		expect(matchTracker(rules, "thewolff/agent-system-2.0")).toEqual({ kind: "github" });
		expect(matchTracker(rules, "thewolff/jo-wolff-plugins")).toBeNull();
		expect(matchTracker(rules, "contextpressx/shipyard")).toBeNull();
		expect(matchTracker(rules, null)).toBeNull();
		expect(matchTracker([{ match: "a/*", tracker: { kind: "linear", team: "MKT" } }, { match: "a/b", tracker: { kind: "github" } }], "a/b")).toEqual({ kind: "linear", team: "MKT" });
	});

	test.each([
		[{ issues: { repo: "o/r", jo: "jo" } }, "issues.trackers is not a list"],
		[{ issues: { trackers: [{ match: "o/r", kind: "jira" }], jo: "jo" } }, "issues.trackers[0].kind is not github or linear"],
		[{ issues: { trackers: [{ match: "o/r", kind: "linear" }], jo: "jo" } }, "issues.trackers[0].team is not a Linear team key"],
		[{ issues: { trackers: [{ match: "o/*/x", kind: "github" }], jo: "jo" } }, "issues.trackers[0].match is not an owner/repo or owner/*"],
		[{ issues: { trackers: [], overrides: { [SEO]: "linear" }, jo: "jo" } }, `issues.overrides.${SEO} is not github, linear:<TEAM> or none`],
		[{ issues: { trackers: [], overrides: { "not-a-workload": "github" }, jo: "jo" } }, "issues.overrides: not-a-workload is not a workload id"],
		[{ issues: { trackers: [], jo: "jo", intakeRepo: "jo-issues" } }, "issues.intakeRepo is not an owner/repo"],
		[{ issues: { trackers: [], jo: "jo", intakeRepo: "thewolff/*" } }, "issues.intakeRepo is not an owner/repo"],
		[{ issues: { trackers: [], jo: "jo", intakeSkipLabels: "plumb" } }, "issues.intakeSkipLabels is not a list of label names"],
		[{ issues: { trackers: [], jo: "jo", intakeSkipLabels: ["plumb", ""] } }, "issues.intakeSkipLabels is not a list of label names"],
	])("a malformed block is an error, never a default: %j", (doc, error) => {
		expect(issuesConfig(doc)).toEqual({ ok: false, error });
	});

	test("override values: github, linear:<TEAM>, none", () => {
		expect(parseTrackerKey("github")).toEqual({ kind: "github" });
		expect(parseTrackerKey("linear:eng")).toEqual({ kind: "linear", team: "ENG" });
		expect(parseTrackerKey("none")).toBeNull();
		expect(parseTrackerKey("linear:")).toBeUndefined();
	});
});

describe("effective tracker: newest tracker: entry, then override, then repo map", () => {
	test("precedence and the entry body", () => {
		const h = setup();
		const a = h.open("on as2", h.dirs.as2);
		expect(effectiveTracker(h.ledger, h.config, a, AS2)).toEqual({ tracker: { kind: "github" }, source: "repo" });
		const seo = h.open("seo audit", h.dirs.as2, SEO);
		expect(effectiveTracker(h.ledger, h.config, seo, AS2)).toEqual({ tracker: { kind: "linear", team: "ENG" }, source: "override" });
		expect(trackerEntryBody(a, { kind: "linear", team: "eng" }, "in-abc")).toBe(`tracker: ${a} linear ENG by in-abc`);
		expect(trackerEntryBody(a, null, "in-abc")).toBe(`tracker: ${a} none by in-abc`);
		h.retrack(seo, { kind: "github" });
		expect(effectiveTracker(h.ledger, h.config, seo, AS2)).toEqual({ tracker: { kind: "github" }, source: "entry" });
		h.retrack(seo, null);
		expect(effectiveTracker(h.ledger, h.config, seo, AS2)).toEqual({ tracker: null, source: "entry" });
		// Another author's entry in the same words is not Jo's word and is not read.
		h.ledger.recordEntry({ by: "lane-x-1", workloadId: a, kind: "assumption", body: trackerEntryBody(a, { kind: "linear", team: "ENG" }, "in-forged") });
		expect(trackerEntryOf(a, h.ledger.entries(a, "assumption"))).toBeUndefined();
		// No GitHub repo: a GitHub tracker has nowhere to file.
		expect(linkTracker(h.ledger, h.config, a, "-")).toBeNull();
	});
});

describe("routing", () => {
	test("a ContextPress repo's workload is created in Linear ENG; the team's labels are made once", async () => {
		const h = setup();
		h.on();
		const id = h.open("ship the shipyard", h.dirs.shipyard);
		const r = await h.run();
		expect(r.stopped).toBeNull();
		const link = h.sidecar.link(id)!;
		expect(link).toMatchObject({ repo: "contextpress/shipyard", tracker: "linear:ENG", issue_number: null, dirty: 0, pushed_seq: link.last_seq });
		const issue = h.linearOf(id)!;
		expect(link.issue_ref).toBe(issue.identifier);
		expect(issue.title).toBe(issueTitle(id, "ship the shipyard"));
		expect(issue.description.startsWith(BLOCK_BEGIN)).toBe(true);
		expect(issue.description.endsWith(BLOCK_END)).toBe(true);
		expect(h.linear.stateName(issue)).toBe("In Progress");
		expect(h.linear.labelNames(issue)).toEqual([LABEL.as2, LABEL.waiting]);
		expect(h.linear.made("labelCreate").map((q) => q.variables.name).sort()).toEqual([...LINEAR_LABELS].sort());
		expect(h.gh.made("issue create")).toHaveLength(0);
		expect(h.gh.made("issue list")).toHaveLength(0);
		h.linear.requests.length = 0;
		const second = h.open("another newdle job", h.dirs.shipyard);
		await h.run();
		expect(h.linearOf(second)).toBeDefined();
		expect(h.linear.made("labelCreate")).toHaveLength(0);
	});

	test("an as2 workload is filed on GitHub; a jo-wolff-plugins workload is not projected anywhere", async () => {
		const h = setup();
		h.on();
		const a = h.open("as2 work", h.dirs.as2);
		const p = h.open("plugin work", h.dirs.plugins);
		await h.run();
		const link = h.sidecar.link(a)!;
		expect(link).toMatchObject({ repo: AS2, tracker: "github", external_id: null, pushed_seq: link.last_seq });
		expect(h.gh.issues.get(link.issue_number!)?.title).toBe(issueTitle(a, "as2 work"));
		expect(h.sidecar.link(p)).toMatchObject({ repo: "thewolff/jo-wolff-plugins", dirty: 0, issue_number: null, external_id: null, tracker: null });
		expect(h.gh.made("issue create")).toHaveLength(1);
		expect(h.linear.made("create")).toHaveLength(0);
		// Later activity on the plugin workload still files nothing.
		h.ledger.addSlice({ by: SURFACE_BY, workloadId: p, task: "t", doneCondition: "d", inputs: "i" });
		await h.run();
		expect(h.gh.made("issue create")).toHaveLength(1);
		expect(h.linear.made("create")).toHaveLength(0);
	});

	test("wl-mv5jz4vewt8mbk (repo as2) goes to Linear ENG through the profile's seeded override, never a GitHub create or search", async () => {
		const h = setup();
		h.on();
		const id = h.open("SEO audit of newdle.com", h.dirs.as2, SEO);
		await h.run();
		const link = h.sidecar.link(SEO)!;
		expect(id).toBe(SEO);
		expect(link).toMatchObject({ repo: AS2, tracker: "linear:ENG", issue_number: null, dirty: 0 });
		expect(h.linearOf(SEO)?.title).toBe(issueTitle(SEO, "SEO audit of newdle.com"));
		expect(h.gh.made("issue create")).toHaveLength(0);
		expect(h.gh.made("issue list")).toHaveLength(0);
		expect(h.gh.made("issue edit")).toHaveLength(0);
	});
});

describe("a tracker change moves the link", () => {
	test("GitHub → Linear: the old issue is closed not planned with one comment, the suffix footer is stripped with Jo's text kept, a non-suffix footer is left and counted, the new item is created", async () => {
		const h = setup();
		h.on();
		const id = h.open("move me", h.dirs.as2);
		await h.run();
		const old = h.gh.issues.get(h.sidecar.link(id)!.issue_number!)!;
		const lane = h.gh.addPr(`wl/${id}`);
		const asked = h.gh.addPr("jo/hand-made");
		h.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: id, kind: "assumption", body: testRequestedBody({ runId: "tr-move001", pr: asked.number, sha: SHA, slice: "sl-x", by: "lane-x-1" }) });
		await h.run();
		const footer = closesFooter(old.number);
		expect(lane.body).toBe(`lane body${footer}`);
		expect(asked.body).toBe(`lane body${footer}`);
		lane.body = `Jo's preface\n\n${lane.body}`;
		asked.body = `${asked.body}\n\nJo's later note`;
		const askedBefore = asked.body;
		h.gh.calls.length = 0;

		h.retrack(id, { kind: "linear", team: "ENG" });
		const r = await h.run();
		expect(r.stopped).toBeNull();
		expect(old).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });
		expect(old.comments).toHaveLength(1);
		expect(old.comments[0]).toContain("Linear team ENG");
		expect(lane.body).toBe("Jo's preface\n\nlane body");
		expect(asked.body).toBe(askedBefore);
		expect(h.gh.made("pr edit")).toHaveLength(1);
		const drift: string[] = JSON.parse(h.sidecar.state(STATE.moveDrift) ?? "[]");
		expect(drift).toHaveLength(1);
		expect(drift[0]).toContain(asked.url);
		const link = h.sidecar.link(id)!;
		expect(link).toMatchObject({ tracker: "linear:ENG", issue_number: null, moved_from: `github:${AS2}#${old.number}`, dirty: 0 });
		const moved = h.linearOf(id)!;
		expect(moved.title).toBe(issueTitle(id, "move me"));
		expect(h.notices.some((n) => n.includes("moved from") && n.includes("1 PR footer left as drift"))).toBe(true);

		// From now on no PR of the workload is edited, and the old issue is not touched again.
		h.gh.calls.length = 0;
		h.gh.addPr(`wl/${id}`);
		await h.run();
		expect(h.gh.made("pr edit")).toHaveLength(0);
		expect(h.gh.made("issue close")).toHaveLength(0);
		expect(h.sidecar.prs().every((p) => p.footer === "none")).toBe(true);
	});

	test("Linear → none: the Linear issue is canceled with one comment and nothing new is filed", async () => {
		const h = setup();
		h.on();
		const id = h.open("newdle thing", h.dirs.shipyard);
		await h.run();
		const issue = h.linearOf(id)!;
		h.retrack(id, null);
		await h.run();
		expect(h.linear.stateName(issue)).toBe("Canceled");
		expect(issue.comments).toEqual([`${id} moved to no tracker (no longer projected); this issue is no longer updated.`]);
		expect(h.sidecar.link(id)).toMatchObject({ tracker: null, external_id: null, issue_ref: null, moved_from: `linear:${issue.identifier}`, dirty: 0 });
		expect(h.linear.made("create")).toHaveLength(1);
		expect(h.gh.made("issue create")).toHaveLength(0);
	});

	test("a move retried after a failure past its comment does not comment again (GitHub → Linear, then Linear → none)", async () => {
		const h = setup();
		h.on();
		const id = h.open("move me", h.dirs.as2);
		await h.run();
		const old = h.gh.issues.get(h.sidecar.link(id)!.issue_number!)!;
		h.retrack(id, { kind: "linear", team: "ENG" });
		h.gh.fail = (a) => `${a[0]} ${a[1]}` === "issue close";
		expect((await h.run()).stopped).toBe("failed");
		expect(old.comments).toHaveLength(1);
		expect(old.state).toBe("OPEN");
		h.gh.fail = () => false;
		h.advance(2 * 60 * 60_000);
		await h.run();
		expect(old.comments).toHaveLength(1);
		expect(old).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });
		expect(h.sidecar.link(id)).toMatchObject({ tracker: "linear:ENG", moved_from: `github:${AS2}#${old.number}` });
		expect(h.sidecar.state(`move_commented:${id}`)).toBeNull();

		const issue = h.linearOf(id)!;
		h.retrack(id, null);
		let updates = 0;
		h.linear.reply = (q) => (q.op === "update" && updates++ === 0 ? new Response("upstream down", { status: 502 }) : null);
		await h.run();
		expect(issue.comments).toHaveLength(1);
		expect(h.linear.stateName(issue)).toBe("In Progress");
		h.advance(2 * 60 * 60_000);
		await h.run();
		expect(issue.comments).toHaveLength(1);
		expect(h.linear.stateName(issue)).toBe("Canceled");
		expect(h.sidecar.link(id)).toMatchObject({ tracker: null, external_id: null, moved_from: `linear:${issue.identifier}` });
	});

	test("a crash after the move comment posted but before its marker committed does not comment again: the retry reads the old item's comments (GitHub → Linear, then Linear → none)", async () => {
		const h = setup();
		// The sidecar write that records a posted comment dies once, as a process killed in the gap would.
		const setState = h.sidecar.setState.bind(h.sidecar);
		let crash = true;
		h.sidecar.setState = (key, value) => {
			if (crash && key.startsWith("move_commented:")) {
				crash = false;
				throw new Error("killed between the comment and its marker");
			}
			setState(key, value);
		};
		h.on();
		const id = h.open("move me", h.dirs.as2);
		await h.run();
		const old = h.gh.issues.get(h.sidecar.link(id)!.issue_number!)!;
		h.retrack(id, { kind: "linear", team: "ENG" });
		await expect(h.run()).rejects.toThrow("killed between the comment and its marker");
		expect(old.comments).toHaveLength(1);
		expect(h.sidecar.state(`move_commented:${id}`)).toBeNull();
		expect(h.sidecar.state(`move_commenting:${id}`)).not.toBeNull();
		h.gh.calls.length = 0;
		await h.run();
		expect(old.comments).toHaveLength(1);
		expect(h.gh.calls.filter((a) => `${a[0]} ${a[1]}` === "issue view" && a.includes("comments"))).toHaveLength(1);
		expect(h.gh.made("issue comment")).toHaveLength(0);
		expect(old).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });
		expect(h.sidecar.link(id)).toMatchObject({ tracker: "linear:ENG", moved_from: `github:${AS2}#${old.number}` });
		expect(h.sidecar.state(`move_commented:${id}`)).toBeNull();
		expect(h.sidecar.state(`move_commenting:${id}`)).toBeNull();

		const issue = h.linearOf(id)!;
		h.retrack(id, null);
		crash = true;
		await expect(h.run()).rejects.toThrow("killed between the comment and its marker");
		expect(issue.comments).toHaveLength(1);
		await h.run();
		expect(issue.comments).toHaveLength(1);
		expect(h.linear.made("comments")).toHaveLength(1);
		expect(h.linear.made("comment")).toHaveLength(1);
		expect(h.linear.stateName(issue)).toBe("Canceled");
		expect(h.sidecar.link(id)).toMatchObject({ tracker: null, external_id: null, moved_from: `linear:${issue.identifier}` });
	});
});

describe("per-tracker caps", () => {
	test("one tick's perTick is counted per tracker: each tracker's calls fit, together they exceed it", async () => {
		const h = setup({ over: { perTick: 10 } });
		h.on();
		const a = h.open("as2 work", h.dirs.as2);
		const b = h.open("newdle work", h.dirs.shipyard);
		const r = await h.run();
		expect(r.stopped).toBeNull();
		expect(h.sidecar.link(a)?.issue_number).not.toBeNull();
		expect(h.linearOf(b)).toBeDefined();
		expect(h.gh.calls.length).toBeLessThanOrEqual(10);
		expect(h.linear.requests.length).toBeLessThanOrEqual(10);
		expect(r.calls).toBe(h.gh.calls.length + h.linear.requests.length);
		expect(r.calls).toBeGreaterThan(10);
	});

	test("GitHub's hour spent: GitHub stops; a Linear workload on no GitHub repo is still created, and a ContextPress one (its PR set on GitHub) waits", async () => {
		const offGithub = "wl-nogithub1";
		const h = setup({ over: { perHour: 50, overrides: { ...profileConfig().overrides, [offGithub]: { kind: "linear", team: "ENG" } } } });
		h.on();
		for (let i = 0; i < 50; i++) h.sidecar.db.query("INSERT INTO calls (at, tracker) VALUES (?, 'github')").run(T0);
		const a = h.open("as2 work", h.dirs.as2);
		const b = h.open("newdle work", h.dirs.shipyard);
		const c = h.open("no origin at all", tmp("no-origin"), offGithub);
		const r = await h.run();
		expect(r.stopped).toBe("budget");
		expect(h.gh.calls).toHaveLength(0);
		expect(h.sidecar.link(a)).toMatchObject({ issue_number: null, dirty: 1, fails: 0 });
		expect(h.sidecar.link(b)).toMatchObject({ external_id: null, dirty: 1, fails: 0 });
		expect(h.sidecar.link(c)).toMatchObject({ repo: "-", tracker: "linear:ENG", dirty: 0 });
		expect(h.linearOf(c)?.title).toBe(issueTitle(c, "no origin at all"));
		expect(h.sidecar.callsInHour(T0 + 60_000, "github")).toBe(50);
		expect(h.sidecar.callsInHour(T0 + 60_000, "linear")).toBe(h.linear.requests.length);
	});

	test("Linear's hour spent: the GitHub workload is created, the Linear one waits, and GitHub's count is untouched by Linear's", async () => {
		const h = setup({ over: { perHour: 30 } });
		h.on();
		for (let i = 0; i < 30; i++) h.sidecar.db.query("INSERT INTO calls (at, tracker) VALUES (?, 'linear')").run(T0);
		const a = h.open("as2 work", h.dirs.as2);
		const b = h.open("newdle work", h.dirs.shipyard);
		const r = await h.run();
		expect(r.stopped).toBe("budget");
		expect(h.sidecar.link(a)?.issue_number).not.toBeNull();
		expect(h.sidecar.link(b)).toMatchObject({ external_id: null, dirty: 1, fails: 0 });
		expect(h.linear.requests).toHaveLength(0);
		expect(h.sidecar.callsInHour(T0 + 60_000, "github")).toBe(h.gh.calls.length);
		expect(h.sidecar.callsInHour(T0 + 60_000, "linear")).toBe(30);
	});
});

describe("Linear: state and labels for every render state, close by observing MERGED, no PR edits", () => {
	test("open waiting → running → closed awaiting merge (In Review) → PR merged closes it Done within one tick; no PR is ever edited", async () => {
		const h = setup();
		h.on();
		const id = h.open("newdle feature", h.dirs.shipyard);
		await h.run();
		const issue = h.linearOf(id)!;
		expect([h.linear.stateName(issue), h.linear.labelNames(issue)]).toEqual(["In Progress", [LABEL.as2, LABEL.waiting]]);
		h.ledger.claimWorkload(id, { by: "lane-x-1", holder: "lane-x-1", leaseMs: null });
		await h.run();
		expect([h.linear.stateName(issue), h.linear.labelNames(issue)]).toEqual(["In Progress", [LABEL.as2, LABEL.running]]);
		const pr = h.gh.addPr(`wl/${id}`);
		await h.run();
		h.ledger.releaseWorkload(id, { by: "lane-x-1", holder: "lane-x-1" });
		h.close(id);
		await h.run();
		expect([h.linear.stateName(issue), h.linear.labelNames(issue)]).toEqual(["In Review", [LABEL.as2, LABEL.awaitingMerge]]);
		expect(issue.description).toContain(`- ${pr.url} open`);
		pr.state = "MERGED";
		await h.run();
		expect([h.linear.stateName(issue), h.linear.labelNames(issue)]).toEqual(["Done", [LABEL.as2]]);
		expect(h.gh.made("pr edit")).toHaveLength(0);
		expect(pr.body).toBe("lane body");
	});

	test("an open question adds question; closed with every PR unmerged ⇒ unmerged and Canceled; no PR and every slice cancelled ⇒ Canceled", async () => {
		const h = setup();
		h.on();
		const q = h.open("asks a question", h.dirs.shipyard);
		const qs = h.ledger.addSlice({ by: SURFACE_BY, workloadId: q, task: "t", doneCondition: "d", inputs: "i" });
		h.ledger.raiseQuestion({ by: SURFACE_BY, workloadId: q, sliceId: qs, body: "which way?", options: ["a", "b"] });
		const u = h.open("closes unmerged", h.dirs.shipyard);
		const c = h.open("all cancelled", h.dirs.shipyard);
		const cs = h.ledger.addSlice({ by: SURFACE_BY, workloadId: c, task: "t", doneCondition: "d", inputs: "i" });
		await h.run();
		expect(h.linear.labelNames(h.linearOf(q)!)).toEqual([LABEL.as2, LABEL.question, LABEL.waiting]);
		const pr = h.gh.addPr(`wl/${u}`, { state: "CLOSED" });
		h.close(u);
		h.ledger.cancelSlice(cs, { by: SURFACE_BY });
		h.close(c);
		await h.run();
		expect([h.linear.stateName(h.linearOf(u)!), h.linear.labelNames(h.linearOf(u)!)]).toEqual(["Canceled", [LABEL.as2, LABEL.unmerged]]);
		expect(h.linearOf(u)!.description).toContain(`- ${pr.url} closed`);
		expect([h.linear.stateName(h.linearOf(c)!), h.linear.labelNames(h.linearOf(c)!)]).toEqual(["Canceled", [LABEL.as2]]);
	});

	test("Jo's text outside the markers and Jo's own labels survive an update; only the block is replaced", async () => {
		const h = setup();
		h.on();
		const id = h.open("keep jo's text", h.dirs.shipyard);
		await h.run();
		const issue = h.linearOf(id)!;
		const jo = { id: "lbl-jo", name: "customer" };
		h.linear.team().labels.push(jo);
		issue.labelIds.add(jo.id);
		issue.description = `Jo's note on top\n\n${issue.description}\n\n\\--- Jo's footer ---`;
		h.ledger.claimWorkload(id, { by: "lane-x-1", holder: "lane-x-1", leaseMs: null });
		await h.run();
		expect(issue.description.startsWith("Jo's note on top\n\n<!-- as2:begin -->")).toBe(true);
		expect(issue.description.endsWith("<!-- as2:end -->\n\n\\--- Jo's footer ---")).toBe(true);
		expect(issue.description).toContain("holder: lane-x-1");
		expect(h.linear.labelNames(issue)).toEqual(["as2", "customer", "running"]);
	});

	test("an issue with 25 of Jo's labels, more than one read returns: every label page is read, title, state and projection labels are updated, all 25 kept", async () => {
		const h = setup();
		h.on();
		const id = h.open("many labels", h.dirs.shipyard);
		await h.run();
		const issue = h.linearOf(id)!;
		const jo: string[] = [];
		for (let i = 0; i < 25; i++) {
			const l = { id: `lbl-jo-${i}`, name: `jo-${i}` };
			h.linear.team().labels.push(l);
			issue.labelIds.add(l.id);
			jo.push(l.name);
		}
		expect(h.linear.labelNames(issue)).toEqual([LABEL.as2, ...jo, LABEL.waiting].sort());
		issue.title = "renamed by hand";
		h.close(id);
		await h.run();
		expect(h.linear.made("read")).toHaveLength(1);
		expect(h.linear.made("labels")).toHaveLength(1);
		expect(h.linear.made("update")).toHaveLength(1);
		expect(issue.title).toBe(issueTitle(id, "many labels"));
		expect(h.linear.stateName(issue)).toBe("Done");
		expect(h.linear.labelNames(issue)).toEqual([LABEL.as2, ...jo].sort());
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 0, fails: 0, pushed_state: "closed completed" });
	});

	test("a failed label page read backs the link off: no update, no label dropped", async () => {
		const h = setup();
		h.on();
		const id = h.open("many labels", h.dirs.shipyard);
		await h.run();
		const issue = h.linearOf(id)!;
		for (let i = 0; i < 25; i++) {
			const l = { id: `lbl-jo-${i}`, name: `jo-${i}` };
			h.linear.team().labels.push(l);
			issue.labelIds.add(l.id);
		}
		const before = h.linear.labelNames(issue);
		h.linear.reply = (q) => (q.op === "labels" ? new Response("upstream down", { status: 502 }) : null);
		h.ledger.claimWorkload(id, { by: "lane-x-1", holder: "lane-x-1", leaseMs: null });
		await h.run();
		expect(h.linear.made("update")).toHaveLength(0);
		expect(h.linear.labelNames(issue)).toEqual(before);
		expect(h.sidecar.link(id)).toMatchObject({ dirty: 1, fails: 1 });
		expect(h.notices.some((n) => n.includes("HTTP 502"))).toBe(true);
	});
});

describe("Linear failures and the key", () => {
	test("GraphQL errors on HTTP 200 are a failure: the link backs off, one notice, GitHub's workload still pushed", async () => {
		const h = setup();
		h.on();
		h.linear.reply = (q) => (q.op === "create" ? new Response(JSON.stringify({ data: null, errors: [{ message: "Argument Validation Error" }] }), { status: 200 }) : null);
		const a = h.open("as2 work", h.dirs.as2);
		const b = h.open("newdle work", h.dirs.shipyard);
		const r = await h.run();
		expect(r.stopped).toBe("failed");
		expect(h.sidecar.link(b)).toMatchObject({ external_id: null, dirty: 1, fails: 1 });
		expect(h.notices.some((n) => n.includes("GraphQL error: Argument Validation Error"))).toBe(true);
		expect(h.sidecar.link(a)?.issue_number).not.toBeNull();
	});

	test("the key never appears in an error text or a notice, wherever Linear echoes it", async () => {
		const h = setup();
		h.on();
		let n = 0;
		h.linear.reply = (q) => {
			if (q.op !== "team") return null;
			n++;
			if (n === 1) return new Response(`unauthorized: bad key ${KEY}`, { status: 401 });
			if (n === 2) return new Response(JSON.stringify({ errors: [{ message: `key ${KEY} is revoked` }] }), { status: 200 });
			throw new Error(`socket closed for ${KEY}`);
		};
		const id = h.open("newdle work", h.dirs.shipyard);
		for (let i = 0; i < 3; i++) {
			await h.run();
			h.advance(2 * 60 * 60_000);
		}
		expect(n).toBe(3);
		expect(h.linear.requests.every((q) => q.auth === KEY)).toBe(true);
		expect(h.notices.length).toBeGreaterThanOrEqual(3);
		for (const line of h.notices) expect(line).not.toContain(KEY);
		expect(h.notices.filter((l) => l.includes("[redacted]"))).toHaveLength(3);
		expect(h.sidecar.link(id)?.fails).toBe(3);
	});

	test("no LINEAR_API_KEY: the Linear link backs off with a notice, no Linear request, and GitHub is unaffected", async () => {
		const h = setup({ key: null });
		h.on();
		const a = h.open("as2 work", h.dirs.as2);
		const b = h.open("newdle work", h.dirs.shipyard);
		await h.run();
		expect(h.linear.requests).toHaveLength(0);
		expect(h.sidecar.link(b)).toMatchObject({ external_id: null, dirty: 1, fails: 1 });
		expect(h.notices.some((n) => n.includes("LINEAR_API_KEY is not set"))).toBe(true);
		expect(h.sidecar.link(a)?.issue_number).not.toBeNull();
		expect(h.gh.made("issue create")).toHaveLength(1);
	});

	test("a lost create is adopted by title instead of filed twice", async () => {
		const h = setup();
		h.on();
		const id = h.open("adopt me", h.dirs.shipyard);
		h.linear.team().labels.push({ id: "lbl-as2-ENG", name: "as2" });
		const lost = h.linear.addIssue({ title: issueTitle(id, "adopt me"), labels: ["as2"] });
		await h.run();
		expect(h.sidecar.link(id)).toMatchObject({ external_id: lost.id, issue_ref: lost.identifier });
		expect(h.linear.made("create")).toHaveLength(0);
		expect(lost.description.startsWith(BLOCK_BEGIN)).toBe(true);
	});
});

describe("pushed_seq: the receipt of a successful push (§ 13.3)", () => {
	test("written on create, on edit, and on a no-diff push; a failed push leaves it", async () => {
		const h = setup();
		h.on();
		const a = h.open("as2 work", h.dirs.as2);
		await h.run();
		const first = h.sidecar.link(a)!;
		expect(first.pushed_seq).toBe(first.last_seq);
		h.ledger.addSlice({ by: SURFACE_BY, workloadId: a, task: "t", doneCondition: "d", inputs: "i" });
		await h.run();
		const edited = h.sidecar.link(a)!;
		expect(edited.last_seq).toBeGreaterThan(first.last_seq);
		expect(edited.pushed_seq).toBe(edited.last_seq);
		// No diff: the receipt is written all the same.
		h.sidecar.immediate(() => h.sidecar.db.query("UPDATE links SET pushed_seq = NULL, dirty = 1 WHERE workload_id = ?").run(a));
		h.gh.calls.length = 0;
		await h.run();
		expect(h.gh.made("issue edit")).toHaveLength(0);
		expect(h.sidecar.link(a)).toMatchObject({ dirty: 0, pushed_seq: edited.last_seq });
		// A failed push leaves it where it was.
		h.gh.fail = (args) => args[0] === "issue" && args[1] === "view";
		h.ledger.addSlice({ by: SURFACE_BY, workloadId: a, task: "t2", doneCondition: "d", inputs: "i" });
		await h.run();
		const failed = h.sidecar.link(a)!;
		expect(failed.fails).toBe(1);
		expect(failed.pushed_seq).toBe(edited.last_seq);
		expect(failed.last_seq).toBeGreaterThan(edited.last_seq);
	});

	test("a sidecar written before § 13 gains the columns on open and keeps its rows; its issues read as GitHub", () => {
		const dir = tmp("old-sidecar");
		const path = join(dir, "issues.db");
		const db = new Database(path, { create: true });
		db.run(`CREATE TABLE links (workload_id TEXT PRIMARY KEY, issue_number INTEGER, repo TEXT, dirty INTEGER NOT NULL DEFAULT 0, force INTEGER NOT NULL DEFAULT 0,
			last_seq INTEGER NOT NULL DEFAULT 0, pushed_hash TEXT, pushed_title TEXT, pushed_labels TEXT, pushed_state TEXT, fails INTEGER NOT NULL DEFAULT 0, next_try_at INTEGER NOT NULL DEFAULT 0)`);
		db.run("CREATE UNIQUE INDEX links_issue ON links (issue_number) WHERE issue_number IS NOT NULL");
		db.run("CREATE TABLE calls (at INTEGER NOT NULL)");
		db.run("INSERT INTO links (workload_id, issue_number, repo, last_seq) VALUES ('wl-old', 7, 'o/r', 3), ('wl-new', NULL, 'o/r', 4)");
		db.run("INSERT INTO calls (at) VALUES (1)");
		db.close();
		const s = Sidecar.open(path);
		expect(s.link("wl-old")).toMatchObject({ issue_number: 7, tracker: "github", external_id: null, issue_ref: null, moved_from: null, pushed_seq: null, remote_hash: null, last_seq: 3 });
		expect(s.link("wl-new")).toMatchObject({ issue_number: null, tracker: null });
		expect(s.callsInHour(1 + 1_000, "github")).toBe(1);
		// The same issue number on another repo is a different issue.
		s.immediate(() => s.db.query("INSERT INTO links (workload_id, issue_number, repo) VALUES ('wl-other', 7, 'x/y')").run());
		expect(s.link("wl-other")?.issue_number).toBe(7);
		s.close();
		// Opening again changes nothing.
		const again = Sidecar.open(path);
		expect(again.link("wl-old")?.tracker).toBe("github");
		again.close();
	});

	test("a sidecar from before remote_hash gains the column on open, null on every row, and opening again changes nothing", () => {
		const dir = tmp("pre-remote-hash");
		const path = join(dir, "issues.db");
		const first = Sidecar.open(path);
		first.immediate(() => first.db.query("INSERT INTO links (workload_id, external_id, tracker, pushed_hash) VALUES ('wl-l', 'iss-1', 'linear:ENG', 'h')").run());
		first.db.run("ALTER TABLE links DROP COLUMN remote_hash");
		expect(schemaCurrent(first.db)).toBe(false);
		first.close();
		const s = Sidecar.open(path);
		expect(schemaCurrent(s.db)).toBe(true);
		expect(s.link("wl-l")).toMatchObject({ external_id: "iss-1", pushed_hash: "h", remote_hash: null });
		s.close();
		const again = Sidecar.open(path);
		expect(again.link("wl-l")?.remote_hash).toBeNull();
		again.close();
	});
});

describe("remote_hash: the block as Linear returned it from a push (ENG-2284)", () => {
	test("a create and an update that writes the description record the blockHash of the description in the reply; an update that leaves the description records the read-back's; a GitHub push records null", async () => {
		const h = setup();
		h.linear.normalise = true;
		h.on();
		const id = h.open("ship the shipyard", h.dirs.shipyard);
		const a = h.open("as2 work", h.dirs.as2);
		// The reply to the create carries a description other than the block sent: the hash is the reply's.
		const replied = `${BLOCK_BEGIN}\nas Linear keeps it\n  ${BLOCK_END}`;
		h.linear.reply = (q) => (q.op === "create" ? new Response(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: "iss-77", identifier: "ENG-77", description: replied } } } }), { status: 200 }) : null);
		await h.run();
		expect(h.sidecar.link(id)).toMatchObject({ external_id: "iss-77", remote_hash: blockHash(replied) });
		expect(h.sidecar.link(a)).toMatchObject({ tracker: "github", remote_hash: null });

		// An update that writes the description: the hash of the description the update returned.
		h.linear.reply = null;
		const issue = h.linear.addIssue({ title: issueTitle(id, "ship the shipyard"), description: replied, labels: [LABEL.as2, LABEL.waiting] });
		h.sidecar.immediate(() => h.sidecar.db.query("UPDATE links SET external_id = ?, issue_ref = ? WHERE workload_id = ?").run(issue.id, issue.identifier, id));
		h.ledger.addSlice({ by: SURFACE_BY, workloadId: id, task: "t", doneCondition: "d", inputs: "i" });
		h.advance(1_000);
		await h.run();
		expect(h.linear.made("update").at(-1)!.variables).toMatchObject({ input: { description: expect.stringContaining("slices: 1 open") } });
		expect(issue.description).toContain("slices: 1 open");
		expect(h.sidecar.link(id)?.remote_hash).toBe(blockHash(issue.description));

		// A forced push whose description already matches: no description is written, the read-back's block is hashed.
		const team = h.linear.team("ENG");
		issue.stateId = team.states.find((s) => s.name === "Canceled")!.id;
		h.sidecar.immediate(() => h.sidecar.db.query("UPDATE links SET dirty = 1, force = 1, remote_hash = NULL WHERE workload_id = ?").run(id));
		h.advance(1_000);
		await h.run();
		expect(h.linear.made("update").at(-1)!.variables).not.toHaveProperty("input.description");
		expect(h.sidecar.link(id)?.remote_hash).toBe(blockHash(issue.description));
	});

	test("a reply with no description records remote_hash null", async () => {
		const h = setup();
		h.on();
		const id = h.open("ship the shipyard", h.dirs.shipyard);
		h.linear.reply = (q) => (q.op === "create" ? new Response(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: "iss-78", identifier: "ENG-78" } } } }), { status: 200 }) : null);
		await h.run();
		expect(h.sidecar.link(id)).toMatchObject({ external_id: "iss-78", dirty: 0, remote_hash: null });
	});
});
