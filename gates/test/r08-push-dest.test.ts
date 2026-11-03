// P-11 row 8's destination resolution and `push-dest:` records (MIGRATION.md item 24;
// wl-muraerdsgw7gn4 PLAN.md § 2.2 step 2, § 6 row S4c). Row 8 resolves each branch a let-through
// push updates, statically, and the extension writes one `push-dest: <remote> <branch> <sha>` per
// branch at tool_call, as the lane holding the workload. It reads each push option at its last
// spelling and refuses one it does not resolve, a mirroring remote, `--all`, `--mirror`, wildcard
// refspecs, destinations it cannot follow (a remote.<name>.push mapping on a bare push or a lone
// src; push.default matching or nothing) and a push sharing its bash call.
// Real git config in temp repos with a bare origin; every push is judged, none runs.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TRAIN_PREPARE, TRAIN_PUSH } from "../../surface/src/merge-train";
import { artifactTreeBody } from "../../surface/src/signals";
import { boundBranches, parsePushDest } from "../../surface/src/test-run";
import { ctxOf, fakePi } from "../../surface/test/helpers";
import pushRebaseRow from "../extensions/r08-push-rebase";
import { checkReserved } from "../src/rows/r06-reserved";
import { judgePush, type PushJudgment, type TestRecords } from "../src/rows/r08-push-rebase";
import type { CallContext } from "../src/types";
import { advanceOriginMain, commit, git, repoWithOrigin, tempLedger, testRecord, tmp } from "./helpers";

const lane = (cwd: string): CallContext => ({ role: "lane", cwd, env: { HOME: "/nonexistent-home" } });
const bash = (command: string) => ({ toolName: "bash", input: { command } });

/** `feat` one commit ahead of origin/main, checked out, with push.default set in the repository's own config. */
function feature(pushDefault = "simple") {
	const r = repoWithOrigin();
	git(r.work, "switch", "-q", "-c", "feat");
	commit(r.work, "f.txt", "f\n");
	git(r.work, "config", "push.default", pushDefault);
	return { ...r, head: git(r.work, "rev-parse", "HEAD") };
}

/** Row 8 on `command` from `work`, with a passing test record on HEAD's tree. */
const judge = (work: string, command: string, records: TestRecords = () => [testRecord(work)]): PushJudgment => judgePush(bash(command), lane(work), records);
const branches = (j: PushJudgment) => j.dests.map((d) => d.branch);
const EXPLICIT = "push with an explicit `<src>:<dst>` refspec";

describe("row 8 resolves where a let-through push lands", () => {
	test("a bare push under push.default simple gives the current branch", () => {
		const { work, head } = feature("simple");
		const j = judge(work, "git push");
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "feat", sha: head }]);
	});
	test("a bare push under push.default current gives the current branch", () => {
		const { work, head } = feature("current");
		expect(judge(work, "git push origin").dests).toEqual([{ remote: "origin", branch: "feat", sha: head }]);
	});
	test("a bare push under push.default upstream gives branch.<b>.merge", () => {
		const { work, head } = feature("upstream");
		git(work, "config", "branch.feat.remote", "origin");
		git(work, "config", "branch.feat.merge", "refs/heads/wl/up");
		const j = judge(work, "git push");
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "wl/up", sha: head }]);
	});
	test("`git push origin HEAD:wl/other` alone records wl/other, not the current branch", () => {
		const { work, head } = feature();
		const j = judge(work, "git push origin HEAD:wl/other");
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "wl/other", sha: head }]);
	});
	test("two refspecs record two destinations, each with its source's commit", () => {
		const { work, head } = feature();
		const j = judge(work, "git push origin feat HEAD:refs/heads/wl/two");
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([
			{ remote: "origin", branch: "feat", sha: head },
			{ remote: "origin", branch: "wl/two", sha: head },
		]);
	});
	test("a lone src with no remote.<name>.push mapping gives the same branch name", () => {
		const { work, head } = feature();
		git(work, "branch", "side");
		git(work, "config", "push.default", "nothing"); // push.default governs only a push with no refspec
		const j = judge(work, "git push origin side");
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "side", sha: head }]);
	});
	test("a push that cds into the repository is still its own command", () => {
		const { root, work } = feature();
		const j = judgePush(bash(`cd ${work} && git push origin HEAD:wl/cd`), lane(root), () => [testRecord(work)]);
		expect(j.refusal).toBeNull();
		expect(branches(j)).toEqual(["wl/cd"]);
	});
});

describe("a remote.<name>.push mapping: a destination resolution cannot follow is refused, an explicit one is not remapped", () => {
	function mapped() {
		const r = repoWithOrigin();
		git(r.work, "switch", "-q", "-c", "wl/source");
		commit(r.work, "s.txt", "s\n");
		git(r.work, "config", "push.default", "simple");
		git(r.work, "config", "remote.origin.push", "refs/heads/wl/source:refs/heads/wl/target");
		return r;
	}
	test.each(["git push", "git push origin", "git push origin wl/source"])("%p refuses", (command) => {
		const { work } = mapped();
		const j = judge(work, command);
		expect(j.refusal?.reason).toContain(EXPLICIT);
		expect(j.refusal?.reason).toContain("remote.origin.push mapping");
		expect(j.dests).toEqual([]);
	});
	test("an explicit `HEAD:wl/x` is allowed and records wl/x", () => {
		const { work } = mapped();
		const j = judge(work, "git push origin HEAD:wl/x");
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "wl/x", sha: git(work, "rev-parse", "HEAD") }]);
	});
});

describe("row 8 refuses a push whose branches it cannot name", () => {
	test("remote.origin.mirror=true refuses, even with an explicit refspec", () => {
		const { work } = feature();
		git(work, "config", "remote.origin.mirror", "true");
		for (const command of ["git push origin HEAD:wl/x", "git push origin feat", "git push"]) {
			const j = judge(work, command);
			expect(j.refusal?.reason).toContain("remote.origin.mirror");
			expect(j.dests).toEqual([]);
		}
	});
	test("a mirroring remote named by --repo refuses", () => {
		const { root, origin, work } = feature();
		const backup = join(root, "backup.git");
		git(root, "clone", "-q", "--bare", origin, backup);
		git(work, "remote", "add", "backup", backup);
		git(work, "config", "remote.backup.mirror", "true");
		expect(judge(work, "git push --repo=backup").refusal?.reason).toContain("remote.backup.mirror");
		expect(judge(work, "git push --repo backup").refusal?.reason).toContain("remote.backup.mirror");
	});
	test.each(["matching", "nothing"])("push.default=%s refuses a bare push", (mode) => {
		const { work } = feature(mode);
		const j = judge(work, "git push origin");
		expect(j.refusal?.reason).toContain(EXPLICIT);
		expect(j.refusal?.reason).toContain(`push.default is '${mode}'`);
		expect(j.dests).toEqual([]);
	});
	test.each(["git push origin --all", "git push --all", "git push origin --branches", "git push --mirror origin", "git push --mirror"])("%p refuses", (command) => {
		const { work } = feature();
		const j = judge(work, command);
		expect(j.refusal?.reason).toMatch(/`--(all|branches|mirror)` pushes every/);
		expect(j.dests).toEqual([]);
	});
	test.each(["git push origin 'refs/heads/*:refs/heads/*'", "git push origin '+refs/heads/wl/*:refs/heads/wl/*'", "git push origin :"])("a wildcard or matching refspec refuses: %p", (command) => {
		const { work } = feature();
		const j = judge(work, command);
		expect(j.refusal?.block).toBe(true);
		expect(j.refusal?.reason).toContain(EXPLICIT);
		expect(j.dests).toEqual([]);
	});
	test("a lone src that is no local branch refuses", () => {
		const { work, head } = feature();
		expect(judge(work, `git push origin ${head}`).refusal?.reason).toContain(EXPLICIT);
	});
	test("push.default upstream with no upstream branch refuses", () => {
		const { work } = feature("upstream");
		expect(judge(work, "git push origin").refusal?.reason).toContain(EXPLICIT);
	});
	test.each([
		"git switch wl/other && git push origin",
		"git checkout -q wl/other; git push origin feat",
		"git fetch origin && git push origin feat",
		"git push origin feat | cat",
		"git push origin feat && git push origin HEAD:wl/two",
	])("a push in a compound command refuses: %p", (command) => {
		const { work } = feature();
		git(work, "branch", "wl/other");
		const j = judge(work, command);
		expect(j.refusal?.reason).toContain("push in its own command");
		expect(j.refusal?.reason).toContain("shares its bash call with");
		expect(j.dests).toEqual([]);
	});
});

/** `feat` as in `feature()`, with a tag `v1` on HEAD: lightweight, or annotated (a tag object). */
function tagged(kind: "lightweight" | "annotated") {
	const r = feature();
	if (kind === "annotated") git(r.work, "-c", "tag.gpgSign=false", "tag", "-a", "v1", "-m", "v1");
	else git(r.work, "tag", "v1");
	return r;
}

describe("a tag-only push records nothing", () => {
	test.each(["git push origin refs/tags/v1", "git push origin --tags", "git push origin v1", "git push origin HEAD:refs/tags/v2"])("%p", (command) => {
		const { work } = feature();
		git(work, "tag", "v1");
		const j = judge(work, command);
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([]);
	});
	test.each([
		["lightweight", "git push origin v1"],
		["lightweight", "git push origin v1:refs/tags/v1"],
		["lightweight", "git push origin refs/tags/v1:refs/tags/v1"],
		["annotated", "git push origin v1"],
		["annotated", "git push origin v1:refs/tags/v1"],
		["annotated", "git push origin refs/tags/v1:refs/tags/v1"],
	] as const)("%s tag: %p", (kind, command) => {
		const { work } = tagged(kind);
		const j = judge(work, command);
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([]);
	});
});

// review r1 B2: git-push(1) expands an unqualified dst to a ref the remote already has, so a tag
// source can move a branch. Row 8 refuses a tag source with an unqualified or refs/heads/ dst.
describe("a tag pushed to a branch, or to an unqualified destination, refuses", () => {
	test.each([
		["lightweight", "git push origin v1:wl/other"],
		["lightweight", "git push origin refs/tags/v1:wl/other"],
		["lightweight", "git push origin refs/tags/v1:refs/heads/wl/other"],
		["lightweight", "git push origin v1:refs/heads/wl/other"],
		["lightweight", "git push origin +v1:wl/other"],
		["annotated", "git push origin v1:wl/other"],
		["annotated", "git push origin refs/tags/v1:wl/other"],
		["annotated", "git push origin refs/tags/v1:refs/heads/wl/other"],
		["annotated", "git push origin v1:refs/heads/wl/other"],
	] as const)("%s tag: %p", (kind, command) => {
		const { work } = tagged(kind);
		git(work, "push", "-q", "origin", "main:refs/heads/wl/other"); // the remote branch the push could fast-forward
		const j = judge(work, command);
		expect(j.refusal?.block).toBe(true);
		expect(j.refusal?.reason).toContain(EXPLICIT);
		expect(j.refusal?.reason).toContain("pushes the tag");
		expect(j.dests).toEqual([]);
	});
	test("a tag refspec alongside a branch refspec refuses the whole push", () => {
		const { work } = tagged("lightweight");
		const j = judge(work, "git push origin HEAD:wl/ok v1:wl/other");
		expect(j.refusal?.reason).toContain("pushes the tag 'v1' to 'wl/other'");
		expect(j.dests).toEqual([]);
	});
	test("a branch source with an unqualified destination still records it when the repo has tags", () => {
		const { work, head } = tagged("lightweight");
		const j = judge(work, "git push origin feat:wl/other");
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "wl/other", sha: head }]);
	});
});

// review r2 B5: refs.c ref_rev_parse_rules try `refs/%s` before `refs/heads/%s`, so an unqualified
// dst `heads/wl/other` moves the remote's wl/other when it has one, and row 8 would record a branch
// heads/wl/other. Row 8 refuses an unqualified dst whose first component is heads, tags or remotes.
describe("an unqualified destination starting heads/, tags/ or remotes/ refuses", () => {
	/** `feat` as in `feature()`, with origin already holding wl/other, tag v1 and branch x. */
	function withOther() {
		const r = feature();
		git(r.work, "push", "-q", "origin", "main:refs/heads/wl/other", "main:refs/tags/v1", "main:refs/heads/x");
		return r;
	}
	test.each([
		"git push origin HEAD:heads/wl/other",
		"git push origin +HEAD:heads/wl/other",
		"git push origin feat:heads/wl/other",
		"git push origin HEAD:tags/v1",
		"git push origin HEAD:remotes/origin/x",
		"git push origin HEAD:heads",
		"git push origin HEAD:wl/ok HEAD:heads/wl/other",
	])("%p refuses and records nothing", (command) => {
		const { work } = withOther();
		const j = judge(work, command);
		expect(j.refusal?.block).toBe(true);
		expect(j.refusal?.reason).toContain(EXPLICIT);
		expect(j.refusal?.reason).toContain("`refs/heads/<branch>`");
		expect(j.refusal?.reason).toContain("unqualified destination");
		expect(j.dests).toEqual([]);
	});
	test.each(["git push origin HEAD:refs/heads/wl/other", "git push origin HEAD:wl/other"])("%p records wl/other", (command) => {
		const { work, head } = withOther();
		const j = judge(work, command);
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "wl/other", sha: head }]);
	});
	test("a branch named heads/x pushed bare or as a lone src records heads/x: git qualifies its destination itself", () => {
		const { work, head } = withOther();
		git(work, "switch", "-q", "-c", "heads/x");
		git(work, "config", "push.default", "current");
		for (const command of ["git push origin", "git push origin heads/x"]) {
			const j = judge(work, command);
			expect(j.refusal).toBeNull();
			expect(j.dests).toEqual([{ remote: "origin", branch: "heads/x", sha: head }]);
		}
	});
});

// builtin/push.c refspec_append_mapped: under push.default upstream (or tracking) git rewrites a lone
// src naming one local branch to `<src>:<branch.<b>.merge>` when the branch has exactly one merge
// value and a branch.<b>.remote (remote.c set_merge), so `git push origin side` moves wl/up. Row 8
// refuses that lone src rather than record `side`, and records `<b>` wherever git keeps it on `<b>`.
describe("a lone src under push.default upstream with a branch.<b>.merge refuses", () => {
	/** `feat` as in `feature(mode)`, with branch `side` at HEAD tracking origin's wl/up. */
	function tracking(mode: string) {
		const r = feature(mode);
		git(r.work, "branch", "side");
		git(r.work, "config", "branch.side.remote", "origin");
		git(r.work, "config", "branch.side.merge", "refs/heads/wl/up");
		return r;
	}
	test.each([
		["upstream", "git push origin side"],
		["upstream", "git push origin refs/heads/side"],
		["upstream", "git push origin +side"],
		["tracking", "git push origin side"],
		["upstream", "git push origin HEAD:wl/ok side"],
	] as const)("push.default=%s: %p refuses and records nothing", (mode, command) => {
		const { work } = tracking(mode);
		const j = judge(work, command);
		expect(j.refusal?.block).toBe(true);
		expect(j.refusal?.reason).toContain(EXPLICIT);
		expect(j.refusal?.reason).toContain("branch.side.merge 'refs/heads/wl/up'");
		expect(j.dests).toEqual([]);
	});
	test.each(["simple", "current"])("push.default=%s: the same push records side", (mode) => {
		const { work, head } = tracking(mode);
		const j = judge(work, "git push origin side");
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "side", sha: head }]);
	});
	test("push.default=upstream: a lone src branch with no branch.<b>.merge records its own name", () => {
		const { work, head } = feature("upstream");
		git(work, "branch", "side");
		const j = judge(work, "git push origin side");
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "side", sha: head }]);
	});
	// code review r3, Kimi minor 2: tiers/lane.md's `git push -u origin wl/<wl>`, run a second time
	// under push.default=upstream, finds the merge=refs/heads/wl/<wl> the first run set.
	test("push.default=upstream: the repeat of `git push -u origin wl/<wl>` records wl/<wl>", () => {
		const { work, head } = feature("upstream");
		git(work, "switch", "-q", "-c", "wl/abc");
		git(work, "push", "-q", "-u", "origin", "wl/abc");
		expect(git(work, "config", "--get", "branch.wl/abc.merge")).toBe("refs/heads/wl/abc");
		const j = judge(work, "git push -u origin wl/abc");
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "wl/abc", sha: head }]);
	});
	// Kimi minor 1: with two merge values git keeps the src's own name.
	test("push.default=upstream: a lone src branch with two branch.<b>.merge values records its own name", () => {
		const { work, head } = tracking("upstream");
		git(work, "config", "--add", "branch.side.merge", "refs/heads/wl/two");
		const j = judge(work, "git push origin side");
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "side", sha: head }]);
	});
	test("push.default=upstream: a branch.<b>.merge with no branch.<b>.remote records its own name", () => {
		const { work, head } = tracking("upstream");
		git(work, "config", "--unset", "branch.side.remote");
		const j = judge(work, "git push origin side");
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "side", sha: head }]);
	});
});

// code review r3 B6: git's parse-options gives `--tags` its last spelling, so `--tags --no-tags`
// pushes no tags and takes the default push of the current branch (builtin/push.c `if (tags)`).
// Row 8 reads each option's effective state and refuses any option it does not resolve.
describe("push options take their last spelling, and an option row 8 does not resolve refuses", () => {
	/** `feat` as in `feature()`, already on origin with its upstream set: a tracking branch that is no workload's. */
	function tracked() {
		const r = feature();
		git(r.work, "push", "-q", "-u", "origin", "feat");
		return r;
	}
	// Row 8 records the branch git really moves (not a refusal): the push is an ordinary branch push.
	test.each(["git push origin --tags --no-tags", "git push --tags --no-tags", "git push --no-tags origin", "git push origin --tags --no-tags --no-tags"])(
		"%p records the current branch",
		(command) => {
			const { work, head } = tracked();
			const j = judge(work, command);
			expect(j.refusal).toBeNull();
			expect(j.dests).toEqual([{ remote: "origin", branch: "feat", sha: head }]);
		},
	);
	test("`--tags --no-tags` is judged as a branch push: with no workload it refuses", () => {
		const { work } = tracked();
		expect(judge(work, "git push origin --tags --no-tags", null).refusal?.reason).toContain("this session has no workload");
	});
	test.each(["git push origin --no-tags --tags", "git push --tags", "git push origin --tags --no-tags --tags"])("%p stays tag-only: nothing recorded, no rev judged", (command) => {
		const { work } = tracked();
		git(work, "tag", "v1");
		const j = judge(work, command, null);
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([]);
	});
	test("`--delete --no-delete` is no deletion: the branch push is judged and recorded", () => {
		const { work, head } = tracked();
		const j = judge(work, "git push origin --delete --no-delete feat");
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "feat", sha: head }]);
	});
	test.each([
		"git push -u origin feat",
		"git push -uq origin feat",
		"git push --set-upstream --quiet --verbose -v origin feat",
		"git push --progress --no-progress --porcelain -n --dry-run origin feat",
		"git push --follow-tags --no-follow-tags --verify --no-verify origin feat",
		"git push --repo origin",
		"git push --repo=origin",
		"git push origin -- feat",
	])("an option row 8 resolves: %p records feat", (command) => {
		const { work, head } = tracked();
		const j = judge(work, command);
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: "feat", sha: head }]);
	});
	test.each([
		["--atomic", "git push --atomic origin feat"],
		["-o", "git push -o ci.skip origin feat"],
		["--push-option=ci.skip", "git push --push-option=ci.skip origin feat"],
		["--push-option", "git push --push-option ci.skip origin feat"],
		["--recurse-submodules=no", "git push --recurse-submodules=no origin feat"],
		["--signed", "git push --signed origin feat"],
		["--exec=/not-real/x", "git push --exec=/not-real/x origin feat"],
		["--receive-pack=/not-real/x", "git push --receive-pack=/not-real/x origin feat"],
		["--thin", "git push --thin origin feat"],
		["-4", "git push -4 origin feat"],
		["--ta", "git push origin --ta"],
		["--no-ta", "git push origin --tags --no-ta"],
		["-uo", "git push -uo ci.skip origin feat"],
		["--no-repo", "git push --repo=origin --no-repo feat"],
		["--repo=", "git push --repo= origin feat"],
		["--frobnicate", "git push origin feat --frobnicate"],
	])("%p refuses: not an option row 8 resolves", (opt, command) => {
		const { work } = tracked();
		const j = judge(work, command);
		expect(j.refusal?.block).toBe(true);
		expect(j.refusal?.reason).toContain(`\`${opt}\` is not one row 8 resolves`);
		expect(j.refusal?.reason).toContain("push with plain options");
		expect(j.dests).toEqual([]);
	});
	test("an unresolved option refuses even beside --delete, since it may take the next word", () => {
		const { work } = tracked();
		expect(judge(work, "git push origin --push-option --delete feat").refusal?.reason).toContain("`--push-option` is not one row 8 resolves");
	});
});

describe("the extension writes push-dest entries at tool_call, as the lane, once row 8 lets the push through", () => {
	type Revised = { block?: boolean; reason?: string } | undefined;
	function laneSession(o: { role?: string; workload?: boolean } = {}) {
		const r = feature();
		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: "orch", brief: "ship feat", stakes: "normal", mode: "autonomous" });
		const sl = ledger.addSlice({ by: "orch", workloadId: wl, task: "push the branch", doneCondition: "pushed", inputs: "feat" });
		const env: Record<string, string> = { AGENT_SYSTEM_ROLE: o.role ?? "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_LANE_ID: "lane-a", HOME: tmp("r8-dest-home"), PATH: process.env.PATH ?? "" };
		if (o.workload !== false) env.AGENT_SYSTEM_WORKLOAD_ID = wl;
		const f = fakePi();
		pushRebaseRow(f.pi as never, env);
		const ctx = ctxOf({ cwd: r.work });
		const push = async (command: string, id = "p1") => (await f.emit("tool_call", { toolName: "bash", toolCallId: id, input: { command } }, ctx)) as Revised;
		const tested = () => {
			const { repo, tree, command } = testRecord(r.work);
			ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "assumption", body: artifactTreeBody({ repo, tree, command }) });
		};
		const recorded = () => ledger.entries(wl).filter((e) => e.body.startsWith("push-dest:"));
		return { ...r, ledger, wl, push, tested, recorded };
	}

	test("a let-through push writes one entry per destination, by the lane, before the push runs", async () => {
		const s = laneSession();
		s.tested();
		const before = git(s.origin, "for-each-ref", "refs/heads/");
		expect((await s.push("git push origin feat HEAD:wl/other"))?.block).toBeUndefined();
		const rows = s.recorded();
		expect(rows.map((e) => [e.created_by, e.kind, parsePushDest(e.body)])).toEqual([
			["lane-a", "assumption", { remote: "origin", branch: "feat", sha: s.head }],
			["lane-a", "assumption", { remote: "origin", branch: "wl/other", sha: s.head }],
		]);
		expect(git(s.origin, "for-each-ref", "refs/heads/")).toBe(before); // judged at tool_call; nothing ran
		expect(boundBranches(s.wl, s.ledger.entries(s.wl), ["lane-a"])).toEqual([`wl/${s.wl}`, "feat", "wl/other"]);
	});
	test("a push row 8 refused records nothing", async () => {
		const s = laneSession();
		const refused = await s.push("git push origin feat");
		expect(refused?.block).toBe(true);
		expect(refused?.reason).toContain("0 test records");
		s.tested();
		expect((await s.push("git switch main && git push origin feat", "p2"))?.reason).toContain("push in its own command");
		git(s.work, "config", "remote.origin.mirror", "true");
		expect((await s.push("git push origin HEAD:wl/x", "p3"))?.block).toBe(true);
		expect(s.recorded()).toEqual([]);
	});
	test("a tag-only push records nothing", async () => {
		const s = laneSession();
		s.tested();
		git(s.work, "tag", "v1");
		expect((await s.push("git push origin refs/tags/v1"))?.block).toBeUndefined();
		expect((await s.push("git push origin --tags", "p2"))?.block).toBeUndefined();
		expect(s.recorded()).toEqual([]);
	});
	test("a push outside any lane records nothing: no workload, or the orchestrator", async () => {
		const loose = laneSession({ workload: false });
		loose.tested();
		git(loose.work, "tag", "v1");
		expect((await loose.push("git push origin refs/tags/v1"))?.block).toBeUndefined();
		expect((await loose.push("git push origin feat", "p2"))?.reason).toContain("this session has no workload");
		expect(loose.recorded()).toEqual([]);
		const orch = laneSession({ role: "orchestrator" });
		orch.tested();
		expect((await orch.push("git push origin feat"))?.block).toBeUndefined();
		expect(orch.recorded()).toEqual([]);
	});
	test("a destination the ledger cannot carry refuses the push instead of letting it through unrecorded", async () => {
		const s = laneSession();
		s.tested();
		const r = await s.push("git push origin 'HEAD:wl/a b'");
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("its destination could not be recorded");
		expect(s.recorded()).toEqual([]);
	});
});

describe("the merge train's step 2 preparation and step 6 push pass row 8 (PLAN wl-mv8s8srodefytc, trainBrief)", () => {
	const HEAD_BRANCH = "wl/wl-pr";
	/** The brief's literal command with its placeholders filled in. */
	const fill = (template: string, path: string, attempt: number) =>
		template.replace("<k>", "mv8s8srodefytc").replace("<n>", "101").replace("<a>", String(attempt)).replace("<a new path beside the lane worktree>", path).replace("<head branch>", HEAD_BRANCH);
	/** A PR head branch on origin behind an advanced origin/main, and the lane's checkout fetched after (step 2's `git fetch origin`). */
	function train() {
		const r = repoWithOrigin();
		git(r.work, "switch", "-q", "-c", HEAD_BRANCH);
		commit(r.work, "pr.txt", "pr\n");
		git(r.work, "push", "-q", "origin", HEAD_BRANCH);
		git(r.work, "switch", "-q", "main");
		advanceOriginMain(r.root, r.origin);
		git(r.work, "fetch", "-q", "origin");
		return r;
	}
	/** Step 2's command run in the lane's checkout, then step 3's merge of main in the new PR worktree. */
	function prepare(work: string, prepareCommand: string, pr: string): void {
		expect(checkReserved(bash(prepareCommand), lane(work))).toBeNull();
		git(work, ...prepareCommand.split(" ").slice(1));
		git(pr, "merge", "--no-ff", "-q", "-m", "merge main", "origin/main");
	}

	test("a fresh branch tracking the head: the push is let through onto the head branch when the test record matches the tree", () => {
		const r = train();
		const pr = join(r.root, "pr-101-1");
		prepare(r.work, fill(TRAIN_PREPARE, pr, 1), pr);
		const push = fill(TRAIN_PUSH, pr, 1);
		const j = judgePush(bash(push), lane(pr), () => [testRecord(pr)]);
		expect(j.refusal).toBeNull();
		expect(j.dests).toEqual([{ remote: "origin", branch: HEAD_BRANCH, sha: git(pr, "rev-parse", "HEAD") }]);
		// the same push with no record on the merged tree is refused
		expect(judgePush(bash(push), lane(pr), () => []).refusal?.reason).toContain("no passing test record");
		// a second attempt at the same PR takes the next attempt number: the first branch stays
		const again = join(r.root, "pr-101-2");
		expect(() => git(r.work, ...fill(TRAIN_PREPARE, again, 1).split(" ").slice(1))).toThrow("already exists");
		prepare(r.work, fill(TRAIN_PREPARE, again, 2), again);
		expect(judgePush(bash(fill(TRAIN_PUSH, again, 2)), lane(again), () => [testRecord(again)]).refusal).toBeNull();
	});

	test("a detached worktree at the head cannot make the step 6 push", () => {
		const r = train();
		const pr = join(r.root, "pr-101-detached");
		git(r.work, "worktree", "add", "--detach", pr, `origin/${HEAD_BRANCH}`);
		git(pr, "merge", "--no-ff", "-q", "-m", "merge main", "origin/main");
		const j = judgePush(bash(fill(TRAIN_PUSH, pr, 1)), lane(pr), () => [testRecord(pr)]);
		expect(j.refusal?.reason).toContain("detached HEAD");
		expect(j.dests).toEqual([]);
	});
});
