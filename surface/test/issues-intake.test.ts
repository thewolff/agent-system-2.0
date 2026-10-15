// Intake (PLAN wl-mv66ylim0gahog § 6, § 9.3 sl-issues-intake): discovery by edge cursor, the § 6.2
// proof rules one at a time, the Jo-input row `isJoInput` accepts, the ledger as the dedup authority,
// acknowledgements retried, and binding of an accepted issue to the workload whose brief quotes its
// input. GitHub is a fake behind the exec seam; nothing reaches the network.
import { describe, expect, test } from "bun:test";
import { recordRepo } from "../src/decision-log";
import { ensureStandingWorkload } from "../src/identity";
import { intakeRepo, type IssuesConfig, ISSUES_DEFAULTS } from "../src/issues/config";
import { GitHub, TickStop } from "../src/issues/github";
import { Linear } from "../src/issues/linear";
import { ackLine, DISCOVERY_QUERY, intake, intakeBody, intakePrefix, judge, LAST_INTAKE, PROOF_QUERY, type ProofIssue, REASON, recordIntake } from "../src/issues/intake";
import { type PhaseContext, tick } from "../src/issues/projector";
import { BLOCK_BEGIN, BLOCK_END, issueTitle, LABEL, PROJECTION_LABELS } from "../src/issues/render";
import { INTAKE_ACCEPTED, INTAKE_IGNORED, type IntakeRow, STATE, Sidecar, sidecarPath } from "../src/issues/sidecar";
import { switchBody } from "../src/issues/switch";
import { isJoInput, joInput } from "../src/orchestrator-question";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import type { ExecResult } from "../src/types";
import { tempLedger, tmp } from "./helpers";

const REPO = "o/r";
/** A separate intake repo (`issues.intakeRepo`), as thewolff/jo-issues is for the profile. */
const JO_REPO = "o/jo";
const JO = "jo";
const AGENTS = "jo-engineer";
const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const ON_AT = "2026-10-01T09:00:00.000Z";
const MIN = 60_000;

const out = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
const json = (v: unknown): ExecResult => out(JSON.stringify(v));
const fail = (stderr: string): ExecResult => ({ stdout: "", stderr, code: 1, killed: false });
const arg = (args: readonly string[], name: string): string => args[args.indexOf(name) + 1] ?? "";
/** A `-f`/`-F` GraphQL variable from the argv, or null when it was not passed. */
const variable = (args: readonly string[], name: string): string | null => {
	for (let i = 0; i < args.length - 1; i++) if ((args[i] === "-f" || args[i] === "-F") && args[i + 1]!.startsWith(`${name}=`)) return args[i + 1]!.slice(name.length + 1);
	return null;
};

interface FakeIssue {
	/** The repo it lives on (`owner/name`). */
	repo: string;
	number: number;
	title: string;
	body: string;
	createdAt: string;
	author: string | null;
	/** The login discovery's createdBy filter matches it under, when not its author (to put a non-Jo author through the pre-filter). */
	listedAs: string | null;
	association: string;
	editors: (string | null)[];
	editsMore: boolean;
	events: { type: "RenamedTitleEvent" | "TransferredEvent"; actor: string | null }[];
	eventsMore: boolean;
	labels: Set<string>;
	comments: { author: string; body: string }[];
	state: "OPEN" | "CLOSED";
	stateReason: string | null;
}

/** GitHub as intake's gh argv (and, for the binding test, the projector's) see it. */
class FakeGh {
	next = 1;
	readonly issues = new Map<number, FakeIssue>();
	/** Labels per repo: the projection repo has the projection's, any other repo none until created. */
	readonly labels = new Map<string, Set<string>>([[REPO, new Set(PROJECTION_LABELS)]]);
	readonly calls: string[][] = [];
	fail: (args: readonly string[]) => ExecResult | null = () => null;
	readonly origins = new Map<string, string>();

	/** An issue as Jo files it, unless `o` says otherwise; filed one minute after the last by default. */
	file(o: Partial<FakeIssue> = {}): FakeIssue {
		const n = this.next++;
		const issue: FakeIssue = {
			repo: REPO,
			number: n,
			title: `Jo's ask ${n}`,
			body: `please do thing ${n}`,
			createdAt: new Date(T0 + n * MIN).toISOString(),
			author: JO,
			listedAs: null,
			association: "OWNER",
			editors: [],
			editsMore: false,
			events: [],
			eventsMore: false,
			labels: new Set(),
			comments: [],
			state: "OPEN",
			stateReason: null,
			...o,
		};
		this.issues.set(n, issue);
		return issue;
	}

	graphql(kind: "discovery" | "proof"): string[][] {
		return this.calls.filter((a) => a[0] === "api" && a[1] === "graphql" && (variable(a, "query") === (kind === "discovery" ? DISCOVERY_QUERY : PROOF_QUERY)));
	}

	made(verb: string): string[][] {
		return this.calls.filter((a) => `${a[0]} ${a[1]}` === verb);
	}

	/** Issue N when it lives on the repo `-R` names (`gh` reads only that repo). */
	private on(a: readonly string[]): FakeIssue | undefined {
		const i = this.issues.get(Number(a[2]));
		return i?.repo === arg(a, "-R") ? i : undefined;
	}

	readonly exec = async (command: string, args: string[]): Promise<ExecResult> => {
		if (command === "git") {
			const url = this.origins.get(args[1] ?? "");
			return url === undefined ? fail("error: No such remote 'origin'") : out(`${url}\n`);
		}
		this.calls.push(args);
		const failed = this.fail(args);
		if (failed) return failed;
		return this.answer(args);
	};

	private discovery(a: readonly string[]): ExecResult {
		const repo = `${variable(a, "owner")}/${variable(a, "name")}`;
		const by = variable(a, "jo");
		const all = [...this.issues.values()].filter((i) => i.repo === repo && (i.listedAs ?? i.author) === by).sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.number - y.number);
		const after = variable(a, "after");
		const start = after === null ? 0 : all.findIndex((i) => `c${i.number}` === after) + 1;
		const page = all.slice(start, start + 100);
		return json({
			data: {
				repository: {
					issues: {
						edges: page.map((i) => ({ cursor: `c${i.number}`, node: { number: i.number, title: i.title, createdAt: i.createdAt, labels: { nodes: [...i.labels].map((name) => ({ name })) } } })),
						pageInfo: { hasNextPage: start + 100 < all.length },
					},
				},
			},
		});
	}

	private proof(a: readonly string[]): ExecResult {
		const n = Number(variable(a, "number"));
		const found = this.issues.get(n);
		const i = found?.repo === `${variable(a, "owner")}/${variable(a, "name")}` ? found : undefined;
		if (!i) return { stdout: JSON.stringify({ data: { repository: { issue: null } } }), stderr: `gh: Could not resolve to an Issue with the number of ${n}.`, code: 1, killed: false };
		return json({
			data: {
				repository: {
					issue: {
						number: i.number,
						title: i.title,
						body: i.body,
						createdAt: i.createdAt,
						authorAssociation: i.association,
						author: i.author === null ? null : { login: i.author },
						labels: { totalCount: i.labels.size, nodes: [...i.labels].map((name) => ({ name })) },
						userContentEdits: { totalCount: i.editors.length + (i.editsMore ? 100 : 0), pageInfo: { hasNextPage: i.editsMore }, nodes: i.editors.map((e) => ({ editor: e === null ? null : { login: e } })) },
						timelineItems: {
							totalCount: i.events.length + (i.eventsMore ? 100 : 0),
							pageInfo: { hasNextPage: i.eventsMore },
							nodes: i.events.map((e) => ({ __typename: e.type, actor: e.actor === null ? null : { login: e.actor } })),
						},
					},
				},
			},
		});
	}

	private answer(a: readonly string[]): ExecResult {
		const verb = `${a[0]} ${a[1]}`;
		switch (verb) {
			case "api graphql": {
				const q = variable(a, "query");
				if (q === DISCOVERY_QUERY) return this.discovery(a);
				if (q === PROOF_QUERY) return this.proof(a);
				return fail(`fake gh: unknown query ${q}`);
			}
			case "api rate_limit":
				return out("5000\n");
			case "repo view":
				return json({ defaultBranchRef: { name: "main" } });
			case "label list":
				return json([...(this.labels.get(arg(a, "-R")) ?? [])].map((name) => ({ name })));
			case "label create": {
				const repo = arg(a, "-R");
				const have = this.labels.get(repo) ?? new Set<string>();
				if (have.has(a[2]!)) return fail(`label with name "${a[2]}" already exists`);
				have.add(a[2]!);
				this.labels.set(repo, have);
				return out(`✓ Label "${a[2]}" created in ${repo}\n`);
			}
			case "pr list":
				return json([]);
			case "issue list": {
				const quoted = /^"(.*)" in:title$/.exec(arg(a, "--search"))?.[1] ?? "";
				return json([...this.issues.values()].filter((i) => i.repo === arg(a, "-R") && i.labels.has(arg(a, "--label")) && i.title.includes(quoted)).map((i) => ({ number: i.number, title: i.title })));
			}
			case "issue create": {
				const labels = new Set<string>();
				a.forEach((x, i) => {
					if (x === "--label") labels.add(a[i + 1]!);
				});
				const issue = this.file({ repo: arg(a, "-R"), title: arg(a, "--title"), body: arg(a, "--body"), labels, author: AGENTS, association: "COLLABORATOR" });
				return out(`https://github.com/${issue.repo}/issues/${issue.number}\n`);
			}
			case "issue view": {
				const i = this.on(a);
				if (!i) return fail("no such issue");
				if (arg(a, "--json") === "comments") return json({ comments: i.comments.map((c) => ({ author: { login: c.author }, body: c.body })) });
				return json({ title: i.title, body: i.body, labels: [...i.labels].map((name) => ({ name })), state: i.state, stateReason: i.stateReason });
			}
			case "issue edit": {
				const i = this.on(a);
				if (!i) return fail("no such issue");
				// gh refuses a label the repo does not have.
				const missing = a.includes("--add-label") ? arg(a, "--add-label").split(",").find((l) => !this.labels.get(i.repo)?.has(l)) : undefined;
				if (missing !== undefined) return fail(`failed to update https://github.com/${i.repo}/issues/${i.number}: '${missing}' not found`);
				if (a.includes("--title")) i.title = arg(a, "--title");
				if (a.includes("--body")) i.body = arg(a, "--body");
				if (a.includes("--add-label")) for (const l of arg(a, "--add-label").split(",")) i.labels.add(l);
				if (a.includes("--remove-label")) for (const l of arg(a, "--remove-label").split(",")) i.labels.delete(l);
				return out(`https://github.com/${i.repo}/issues/${i.number}\n`);
			}
			case "issue comment": {
				const i = this.on(a);
				if (!i) return fail("no such issue");
				i.comments.push({ author: AGENTS, body: arg(a, "--body") });
				return out(`https://github.com/${i.repo}/issues/${i.number}#issuecomment-1\n`);
			}
			default:
				return fail(`fake gh: unknown ${a.join(" ")}`);
		}
	}
}

/** A temp ledger and sidecar, seeded as a first `issues on` would leave them, and the intake phase run on its own. */
function setup(over: Partial<IssuesConfig> = {}) {
	let t = T0 + 365 * 24 * 60 * MIN;
	const { ledger, path } = tempLedger(() => new Date(t).toISOString());
	const sidecar = Sidecar.open(sidecarPath({ AGENT_SYSTEM_LEDGER_DB: path }));
	sidecar.immediate(() => {
		sidecar.setState(STATE.intakeSince, ON_AT);
		sidecar.setState(STATE.seededAt, ON_AT);
	});
	const gh = new FakeGh();
	const config: IssuesConfig = { trackers: [{ match: REPO, tracker: { kind: "github" } }], overrides: {}, jo: JO, ...ISSUES_DEFAULTS, perTick: 1_000, perHour: 100_000, ...over };
	const notices: string[] = [];
	const h = {
		ledger,
		path,
		sidecar,
		gh,
		config,
		notices,
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
		/** One intake run as the tick would call it (its own counted caller and claim), the clock moved past the interval first. */
		run: async (o: { rateLow?: boolean; perTick?: number } = {}): Promise<void> => {
			t += config.intakeEveryMin * MIN;
			expect(sidecar.claim("h1", t)).toBe(true);
			const ctx: PhaseContext = {
				config,
				sidecar,
				gh: new GitHub(gh.exec, sidecar, { holder: "h1", perTick: o.perTick ?? config.perTick, perHour: config.perHour, now: () => t }),
				linear: new Linear(() => Promise.reject(new Error("no Linear in intake tests")), null, sidecar, { holder: "h1", perTick: config.perTick, perHour: config.perHour, now: () => t }),
				ledger,
				exec: gh.exec,
				now: () => t,
				notice: (l) => notices.push(l),
				switchState: { on: true, entryId: "en-x", at: ON_AT, instructionId: "in-x" },
				intakeRepo: intakeRepo(config),
				defaultBranch: null,
				rateLow: o.rateLow ?? false,
				stopped: new Map(),
				prSet: async () => ({ known: true, prs: [] }),
				renderOf: () => null,
			};
			try {
				await intake(ctx);
			} finally {
				sidecar.release("h1");
			}
		},
		row: (n: number): IntakeRow | null => sidecar.db.query<IntakeRow, [number]>("SELECT * FROM intake WHERE issue_number = ?").get(n),
		/** wl-orchestrator's Jo-input rows that intake wrote. */
		inputs: () => ledger.instructions(STANDING_WORKLOAD_ID).filter((i) => isJoInput(i) && i.body.startsWith("github-issue #")),
	};
	return h;
}

describe("the § 6.2 proof: each rule refuses alone", () => {
	const cases: [string, Partial<FakeIssue>, string][] = [
		["author is another account", { author: AGENTS, listedAs: JO, association: "COLLABORATOR" }, REASON.notJo],
		["author login is Jo's but the association is not OWNER", { association: "COLLABORATOR" }, REASON.notOwner],
		["author is a deleted account", { author: null, listedAs: JO }, REASON.notJo],
		["a body edit by another account", { editors: [JO, AGENTS] }, REASON.foreignEdit],
		["a body edit by a deleted account", { editors: [null] }, REASON.foreignEdit],
		["a rename by another account", { events: [{ type: "RenamedTitleEvent", actor: AGENTS }] }, REASON.foreignRename],
		["edits with a second page", { editors: [JO], editsMore: true }, REASON.tooMany],
		["renames with a second page", { events: [{ type: "RenamedTitleEvent", actor: JO }], eventsMore: true }, REASON.tooMany],
		["transferred in, even by Jo", { events: [{ type: "TransferredEvent", actor: JO }] }, REASON.transferred],
		["filed before issues on", { createdAt: "2026-10-01T08:59:59.000Z" }, REASON.tooOld],
		["the body carries the projection block", { body: `${BLOCK_BEGIN}\nstakes\n${BLOCK_END}` }, REASON.projection],
	];
	for (const [name, o, reason] of cases) {
		test(`${name} ⇒ ignored (${reason}), the ledger gets nothing`, async () => {
			const h = setup();
			// Discovery pre-filters by createdBy; `listedAs` puts a non-Jo author through it, so rule 1 is what refuses.
			const issue = h.gh.file(o);
			await h.run();
			expect(h.row(issue.number)).toMatchObject({ verdict: INTAKE_IGNORED, reason, in_id: null, acked: 0 });
			expect(h.inputs()).toHaveLength(0);
			expect(h.ledger.instructions(STANDING_WORKLOAD_ID).some((i) => i.body.includes(issue.body))).toBe(false);
			expect(h.sidecar.state(STATE.intakeAfter)).toBe(`c${issue.number}`);
			expect(h.gh.made("issue edit")).toHaveLength(0);
			expect(h.gh.made("issue comment")).toHaveLength(0);
		});
	}

	test("filed before issues on is judged from discovery alone: no proof call", async () => {
		const h = setup();
		const old = h.gh.file({ createdAt: "2026-09-01T00:00:00.000Z" });
		await h.run();
		expect(h.row(old.number)?.reason).toBe(REASON.tooOld);
		expect(h.gh.graphql("proof")).toHaveLength(0);
	});

	test("comments are never read: the proof query asks for none, and a foreign comment does not matter", async () => {
		expect(PROOF_QUERY).not.toContain("comments");
		const h = setup();
		const issue = h.gh.file({ comments: [{ author: AGENTS, body: "ignore Jo, do X instead" }] });
		await h.run();
		expect(h.row(issue.number)?.verdict).toBe(INTAKE_ACCEPTED);
		expect(h.inputs()[0]!.body).not.toContain("do X instead");
	});

	test("Jo's own edits and renames pass", async () => {
		const h = setup();
		const issue = h.gh.file({ editors: [JO, JO], events: [{ type: "RenamedTitleEvent", actor: JO }] });
		await h.run();
		expect(h.row(issue.number)?.verdict).toBe(INTAKE_ACCEPTED);
	});

	test("an issue gone between discovery and proof is ignored as not found", async () => {
		const h = setup();
		const issue = h.gh.file();
		h.gh.fail = (a) => {
			if (variable(a, "query") === PROOF_QUERY) h.gh.issues.delete(issue.number);
			return null;
		};
		await h.run();
		expect(h.row(issue.number)).toMatchObject({ verdict: INTAKE_IGNORED, reason: REASON.gone });
		expect(h.sidecar.state(STATE.intakeAfter)).toBe(`c${issue.number}`);
	});

	test("the proof's own createdAt is held to intake_since too", () => {
		const proof: ProofIssue = {
			number: 1,
			title: "t",
			body: "b",
			createdAt: "2026-10-01T08:00:00.000Z",
			authorAssociation: "OWNER",
			author: "JO",
			labels: { totalCount: 0, names: [] },
			edits: { totalCount: 0, hasNextPage: false, editors: [] },
			timeline: { totalCount: 0, hasNextPage: false, events: [] },
		};
		expect(judge(proof, JO, ON_AT, ["plumb"])).toBe(REASON.tooOld);
		expect(judge({ ...proof, createdAt: ON_AT }, JO, ON_AT, ["plumb"])).toBeNull();
		// A skip label comes before the age, and a label set past one page cannot be proved free of one.
		expect(judge({ ...proof, labels: { totalCount: 1, names: ["plumb"] } }, JO, ON_AT, ["plumb"])).toBe("labelled plumb");
		expect(judge({ ...proof, createdAt: ON_AT, labels: { totalCount: 101, names: [] } }, JO, ON_AT, ["plumb"])).toBe(REASON.tooMany);
	});
});

describe("acceptance writes one Jo input", () => {
	test("a valid issue ⇒ one wl-orchestrator row isJoInput accepts, the sidecar row, a notice, and the ack", async () => {
		const h = setup();
		const issue = h.gh.file({ title: "Add a dark mode", body: "Phones at night." });
		await h.run();
		const row = h.row(issue.number)!;
		expect(row).toMatchObject({ verdict: INTAKE_ACCEPTED, reason: null, acked: 1 });
		const input = joInput(h.ledger, row.in_id!);
		expect(input).not.toBeNull();
		expect(input).toMatchObject({ workload_id: STANDING_WORKLOAD_ID, kind: "instruction", author: "jo", channel: "surface", created_by: SURFACE_BY, question_id: null });
		expect(input!.body).toBe(intakeBody(issue.number, JO, issue.createdAt, "Add a dark mode", "Phones at night."));
		expect(input!.body.startsWith(intakePrefix(issue.number))).toBe(true);
		expect(h.notices).toContain(`Jo filed issue #${issue.number} → input ${row.in_id}: Add a dark mode`);
		expect([...issue.labels]).toEqual([LABEL.intake]);
		expect(issue.comments).toEqual([{ author: AGENTS, body: ackLine(row.in_id!) }]);
	});

	test("a Jo-filed issue titled `wl-… — …` is judged like any other and accepted", async () => {
		const h = setup();
		const issue = h.gh.file({ title: "wl-mv000000000000 — please also cover the footer" });
		await h.run();
		expect(h.row(issue.number)?.verdict).toBe(INTAKE_ACCEPTED);
		expect(h.inputs()).toHaveLength(1);
	});

	test("a crash between the ledger write and the sidecar write yields no second row", async () => {
		const h = setup();
		const issue = h.gh.file();
		// The ledger row as the crashed run left it: written, no sidecar verdict, cursor not moved.
		const first = recordIntake(h, issue.number, intakeBody(issue.number, JO, issue.createdAt, issue.title, issue.body));
		expect(first.recovered).toBe(false);
		await h.run();
		expect(h.inputs()).toHaveLength(1);
		expect(h.row(issue.number)).toMatchObject({ verdict: INTAKE_ACCEPTED, in_id: first.id, acked: 1 });
		// And the sidecar row lost afterwards (a restored sidecar): judged again, still one row.
		h.sidecar.db.query("DELETE FROM intake").run();
		h.sidecar.immediate(() => h.sidecar.setState(STATE.intakeAfter, null));
		await h.run();
		expect(h.inputs()).toHaveLength(1);
		expect(h.row(issue.number)?.in_id).toBe(first.id);
		expect(issue.comments).toHaveLength(1);
	});

	test("a claim lost during the proof writes nothing to the ledger or the sidecar", async () => {
		const h = setup();
		const issue = h.gh.file();
		h.gh.fail = (a) => {
			if (variable(a, "query") === PROOF_QUERY) h.sidecar.db.run("UPDATE claim SET holder = 'h2'");
			return null;
		};
		await expect(h.run()).rejects.toMatchObject({ reason: "lost" });
		expect(h.inputs()).toHaveLength(0);
		expect(h.row(issue.number)).toBeNull();
		expect(h.sidecar.state(STATE.intakeAfter)).toBeNull();
	});

	test("an accepted issue is not judged again", async () => {
		const h = setup();
		h.gh.file();
		await h.run();
		h.sidecar.immediate(() => h.sidecar.setState(STATE.intakeAfter, null));
		await h.run();
		expect(h.inputs()).toHaveLength(1);
		expect(h.gh.graphql("proof")).toHaveLength(1);
	});
});

describe("discovery", () => {
	test("a linked number is skipped without a proof call and the cursor moves past it", async () => {
		const h = setup();
		const linked = h.gh.file();
		const fresh = h.gh.file();
		h.sidecar.immediate(() => h.sidecar.db.query("INSERT INTO links (workload_id, issue_number, repo, dirty, last_seq) VALUES ('wl-a', ?, 'o/r', 0, 1)").run(linked.number));
		await h.run();
		expect(h.row(linked.number)).toBeNull();
		expect(h.gh.graphql("proof").map((a) => variable(a, "number"))).toEqual([String(fresh.number)]);
		expect(h.sidecar.state(STATE.intakeAfter)).toBe(`c${fresh.number}`);
	});

	test("the first discovery passes no cursor; later ones pass the last settled edge's", async () => {
		const h = setup();
		const a = h.gh.file();
		await h.run();
		expect(variable(h.gh.graphql("discovery")[0]!, "after")).toBeNull();
		expect(variable(h.gh.graphql("discovery")[0]!, "jo")).toBe(JO);
		const b = h.gh.file();
		await h.run();
		expect(variable(h.gh.graphql("discovery")[1]!, "after")).toBe(`c${a.number}`);
		expect(h.row(b.number)?.verdict).toBe(INTAKE_ACCEPTED);
	});

	test("101 issues sharing one createdAt are all judged across two runs", async () => {
		const h = setup();
		const at = "2026-10-01T10:30:00.000Z";
		const all = Array.from({ length: 101 }, () => h.gh.file({ createdAt: at }));
		await h.run();
		expect(h.gh.graphql("proof")).toHaveLength(100);
		expect(h.inputs()).toHaveLength(100);
		await h.run();
		expect(h.inputs()).toHaveLength(101);
		for (const i of all) expect(h.row(i.number)?.verdict).toBe(INTAKE_ACCEPTED);
		expect(new Set(h.inputs().map((i) => i.body.split(" ")[1])).size).toBe(101);
	});

	test("a restart with a full page of settled edges ahead of the cursor reaches a new issue on the next page", async () => {
		const h = setup();
		const settled = Array.from({ length: 100 }, () => h.gh.file({ author: JO, association: "COLLABORATOR" }));
		await h.run();
		for (const i of settled) expect(h.row(i.number)?.reason).toBe(REASON.notOwner);
		// The restart: the sidecar's cursor is gone, the verdicts kept.
		h.sidecar.immediate(() => h.sidecar.setState(STATE.intakeAfter, null));
		const fresh = h.gh.file();
		h.gh.calls.length = 0;
		await h.run();
		expect(h.gh.graphql("proof")).toHaveLength(0);
		expect(h.sidecar.state(STATE.intakeAfter)).toBe(`c${settled[99]!.number}`);
		await h.run();
		expect(h.row(fresh.number)?.verdict).toBe(INTAKE_ACCEPTED);
	});

	test("a budget stop mid-page leaves the schedule; the next tick resumes after the last settled edge", async () => {
		const h = setup();
		const issues = Array.from({ length: 4 }, () => h.gh.file({ author: JO, association: "MEMBER" }));
		const before = h.sidecar.state(LAST_INTAKE);
		// 1 discovery + 2 proofs, then the third proof is over the tick's budget.
		await expect(h.run({ perTick: 3 })).rejects.toBeInstanceOf(TickStop);
		expect(h.sidecar.state(LAST_INTAKE)).toBe(before);
		expect(h.sidecar.state(STATE.intakeAfter)).toBe(`c${issues[1]!.number}`);
		await h.run();
		expect(h.gh.graphql("proof").map((a) => Number(variable(a, "number")))).toEqual([1, 2, 3, 4]);
		for (const i of issues) expect(h.row(i.number)?.reason).toBe(REASON.notOwner);
	});

	test("runs every intakeEveryMin, not every tick; paused while the rate limit is low", async () => {
		const h = setup();
		h.gh.file();
		await h.run({ rateLow: true });
		expect(h.gh.calls).toHaveLength(0);
		await h.run();
		expect(h.gh.graphql("discovery")).toHaveLength(1);
		h.advance(-MIN);
		await h.run();
		expect(h.gh.graphql("discovery")).toHaveLength(1);
		h.advance(MIN);
		await h.run();
		expect(h.gh.graphql("discovery")).toHaveLength(2);
	});

	test("a failed discovery is one notice and no verdict; the next run retries", async () => {
		const h = setup();
		const issue = h.gh.file();
		h.gh.fail = (a) => (variable(a, "query") === DISCOVERY_QUERY ? fail("HTTP 502: Bad Gateway") : null);
		await h.run();
		expect(h.notices).toEqual(["issue intake: gh api graphql exited 1: HTTP 502: Bad Gateway"]);
		expect(h.row(issue.number)).toBeNull();
		h.gh.fail = () => null;
		await h.run();
		expect(h.row(issue.number)?.verdict).toBe(INTAKE_ACCEPTED);
	});
});

describe("acknowledgement", () => {
	test("a failed label after the ledger write is acked on the next run, with one comment", async () => {
		const h = setup();
		const issue = h.gh.file();
		h.gh.fail = (a) => (a[0] === "issue" && a[1] === "edit" ? fail("HTTP 502: Bad Gateway") : null);
		await h.run();
		const row = h.row(issue.number)!;
		expect(row).toMatchObject({ verdict: INTAKE_ACCEPTED, acked: 0 });
		expect(h.inputs()).toHaveLength(1);
		expect(issue.comments).toHaveLength(0);
		h.gh.fail = () => null;
		const mark = h.gh.calls.length;
		await h.run();
		expect(h.row(issue.number)?.acked).toBe(1);
		expect(issue.labels.has(LABEL.intake)).toBe(true);
		expect(issue.comments).toEqual([{ author: AGENTS, body: ackLine(row.in_id!) }]);
		expect(h.inputs()).toHaveLength(1);
		// Pending acks go first, before discovery.
		expect(h.gh.calls.slice(mark).map((a) => (a[1] === "graphql" ? (variable(a, "query") === DISCOVERY_QUERY ? "discovery" : "proof") : `${a[0]} ${a[1]}`))).toEqual([
			"issue edit",
			"issue view",
			"issue comment",
			"discovery",
		]);
	});

	test("a comment whose reply was lost is not posted twice", async () => {
		const h = setup();
		const issue = h.gh.file();
		let lose = true;
		h.gh.fail = (a) => {
			if (a[0] === "issue" && a[1] === "comment" && lose) {
				lose = false;
				issue.comments.push({ author: AGENTS, body: arg(a, "--body") });
				return { stdout: "", stderr: "", code: 0, killed: true };
			}
			return null;
		};
		await h.run();
		expect(h.row(issue.number)?.acked).toBe(0);
		await h.run();
		expect(h.row(issue.number)?.acked).toBe(1);
		expect(issue.comments).toHaveLength(1);
		expect(h.gh.made("issue comment")).toHaveLength(1);
	});

	test("an issue already bound to a workload is acked without the intake label", async () => {
		const h = setup();
		const issue = h.gh.file();
		h.gh.fail = (a) => (a[0] === "issue" && a[1] === "edit" ? fail("HTTP 502") : null);
		await h.run();
		h.gh.fail = () => null;
		h.sidecar.immediate(() => h.sidecar.db.query("INSERT INTO links (workload_id, issue_number, repo, dirty, last_seq) VALUES ('wl-a', ?, 'o/r', 0, 1)").run(issue.number));
		await h.run();
		expect(h.row(issue.number)?.acked).toBe(1);
		expect(issue.labels.has(LABEL.intake)).toBe(false);
		expect(issue.comments).toHaveLength(1);
	});
});

describe("binding through the tick", () => {
	test("the phase accepts Jo's issue; a workload whose brief quotes the input id adopts it: no create, retitled, intake label gone, Jo's text kept", async () => {
		let t = T0 + 365 * 24 * 60 * MIN;
		const { ledger, path } = tempLedger(() => new Date(t).toISOString());
		const sidecar = Sidecar.open(sidecarPath({ AGENT_SYSTEM_LEDGER_DB: path }));
		const gh = new FakeGh();
		const repoDir = tmp("checkout");
		gh.origins.set(repoDir, `https://github.com/${REPO}.git`);
		const config: IssuesConfig = { trackers: [{ match: REPO, tracker: { kind: "github" } }], overrides: {}, jo: JO, ...ISSUES_DEFAULTS, perTick: 100, perHour: 10_000 };
		const notices: string[] = [];
		const run = () => tick({ exec: gh.exec, ledger, sidecar, config, holder: "h1", now: () => t, notice: (l) => notices.push(l), phases: { intake } });
		ensureStandingWorkload(ledger);
		ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: switchBody(true, "in-sw1") });
		t += MIN;
		const jo = gh.file({ title: "Please add a dark mode", body: "Jo's ask", createdAt: new Date(t).toISOString() });
		t += MIN;
		await run();
		const row = sidecar.db.query<IntakeRow, [number]>("SELECT * FROM intake WHERE issue_number = ?").get(jo.number)!;
		expect(row).toMatchObject({ verdict: INTAKE_ACCEPTED, acked: 1 });
		expect(jo.labels.has(LABEL.intake)).toBe(true);
		t += MIN;
		const id = ledger.openWorkload({ by: SURFACE_BY, brief: `Add a dark mode (from ${row.in_id})`, stakes: "normal", mode: "autonomous" });
		recordRepo(ledger, id, repoDir);
		t += MIN;
		await run();
		expect(gh.made("issue create")).toHaveLength(0);
		expect(sidecar.link(id)?.issue_number).toBe(jo.number);
		expect(jo.title).toBe(issueTitle(id, `Add a dark mode (from ${row.in_id})`));
		expect([...jo.labels].sort()).toEqual([LABEL.as2, LABEL.waiting]);
		expect(jo.body.endsWith("\n\nJo's ask")).toBe(true);
		// The bound issue now carries the projection block and a link: intake never judges it again.
		t += config.intakeEveryMin * MIN;
		await run();
		expect(ledger.instructions(STANDING_WORKLOAD_ID).filter((i) => isJoInput(i) && i.body.startsWith("github-issue #"))).toHaveLength(1);
		expect(notices.filter((n) => n.startsWith("Jo filed issue"))).toHaveLength(1);
	});
});

describe("a separate intake repo (issues.intakeRepo) and the skip labels", () => {
	const repoOf = (a: readonly string[]): string => `${variable(a, "owner")}/${variable(a, "name")}`;

	test("intake reads issues.intakeRepo when set and the first exact GitHub rule when unset", async () => {
		const github = { kind: "github" } as const;
		expect(intakeRepo({ ...ISSUES_DEFAULTS, trackers: [{ match: "o/*", tracker: github }, { match: REPO, tracker: github }] })).toBe(REPO);
		expect(intakeRepo({ ...ISSUES_DEFAULTS, trackers: [{ match: REPO, tracker: github }], intakeRepo: JO_REPO })).toBe(JO_REPO);
		const set = setup({ intakeRepo: JO_REPO });
		const there = set.gh.file({ repo: JO_REPO });
		const here = set.gh.file();
		await set.run();
		expect(set.gh.graphql("discovery").map(repoOf)).toEqual([JO_REPO]);
		expect(set.gh.graphql("proof").map(repoOf)).toEqual([JO_REPO]);
		expect(set.row(there.number)?.verdict).toBe(INTAKE_ACCEPTED);
		expect(set.row(here.number)).toBeNull();
		const unset = setup();
		const home = unset.gh.file();
		await unset.run();
		expect(unset.gh.graphql("discovery").map(repoOf)).toEqual([REPO]);
		expect(unset.row(home.number)?.verdict).toBe(INTAKE_ACCEPTED);
	});

	test("a plumb- or as2-train-labelled issue by thewolff is skipped and counted as ignored, with no proof, comment or label call", async () => {
		const h = setup({ intakeRepo: JO_REPO });
		const plumb = h.gh.file({ repo: JO_REPO, labels: new Set(["plumb"]) });
		const cased = h.gh.file({ repo: JO_REPO, labels: new Set(["bug", "Plumb"]) });
		const train = h.gh.file({ repo: JO_REPO, labels: new Set(["as2-train"]) });
		await h.run();
		// The reconciler's `intake: <K> ignored (<reason> <n>)` counts these rows (reconcile.ts intakeLine).
		for (const i of [plumb, cased]) expect(h.row(i.number)).toMatchObject({ verdict: INTAKE_IGNORED, reason: "labelled plumb", in_id: null, acked: 0 });
		expect(h.row(train.number)).toMatchObject({ verdict: INTAKE_IGNORED, reason: "labelled as2-train", in_id: null, acked: 0 });
		expect(h.inputs()).toHaveLength(0);
		expect(h.gh.graphql("proof")).toHaveLength(0);
		expect(h.gh.calls.filter((a) => a[0] === "issue" || a[0] === "label")).toEqual([]);
		expect(plumb.comments).toEqual([]);
		expect([...plumb.labels]).toEqual(["plumb"]);
		expect(train.comments).toEqual([]);
		expect([...train.labels]).toEqual(["as2-train"]);
		expect(h.sidecar.state(STATE.intakeAfter)).toBe(`c${train.number}`);
		expect(h.notices).toEqual([]);
	});

	test("a skip label put on between discovery and proof is caught by the proof", async () => {
		const h = setup({ intakeRepo: JO_REPO });
		const issue = h.gh.file({ repo: JO_REPO });
		h.gh.fail = (a) => {
			if (variable(a, "query") === PROOF_QUERY) issue.labels.add("plumb");
			return null;
		};
		await h.run();
		expect(h.row(issue.number)).toMatchObject({ verdict: INTAKE_IGNORED, reason: "labelled plumb" });
		expect(h.inputs()).toHaveLength(0);
		expect(h.gh.calls.filter((a) => a[0] === "issue" || a[0] === "label")).toEqual([]);
	});

	test("a plain Jo issue on the intake repo becomes the wl-orchestrator instruction, labelled and commented there", async () => {
		const h = setup({ intakeRepo: JO_REPO });
		const issue = h.gh.file({ repo: JO_REPO, title: "Add a dark mode", body: "Phones at night.", labels: new Set(["enhancement"]) });
		await h.run();
		const row = h.row(issue.number)!;
		expect(row).toMatchObject({ verdict: INTAKE_ACCEPTED, reason: null, acked: 1 });
		const input = joInput(h.ledger, row.in_id!);
		expect(input).toMatchObject({ workload_id: STANDING_WORKLOAD_ID, kind: "instruction", author: "jo", channel: "surface", created_by: SURFACE_BY });
		expect(input!.body).toBe(intakeBody(issue.number, JO, issue.createdAt, "Add a dark mode", "Phones at night."));
		expect(h.notices).toContain(`Jo filed issue #${issue.number} → input ${row.in_id}: Add a dark mode`);
		expect([...issue.labels].sort()).toEqual(["enhancement", LABEL.intake]);
		expect(issue.comments).toEqual([{ author: AGENTS, body: ackLine(row.in_id!) }]);
		for (const a of h.gh.calls.filter((c) => c[0] === "issue")) expect(arg(a, "-R")).toBe(JO_REPO);
	});

	test("the intake label is ensured on the intake repo once: one counted list, one create, cached across runs", async () => {
		const h = setup({ intakeRepo: JO_REPO });
		expect(h.gh.labels.has(JO_REPO)).toBe(false);
		const a = h.gh.file({ repo: JO_REPO });
		await h.run();
		const b = h.gh.file({ repo: JO_REPO });
		await h.run();
		for (const i of [a, b]) {
			expect(h.row(i.number)).toMatchObject({ verdict: INTAKE_ACCEPTED, acked: 1 });
			expect([...i.labels]).toEqual([LABEL.intake]);
		}
		expect(h.gh.made("label list")).toEqual([["label", "list", "-R", JO_REPO, "--json", "name", "-L", "1000"]]);
		expect(h.gh.made("label create")).toEqual([["label", "create", LABEL.intake, "-R", JO_REPO]]);
		// Only intake's own label: the projection's labels are not made on a repo it files no issue on.
		expect([...h.gh.labels.get(JO_REPO)!]).toEqual([LABEL.intake]);
		// The list and create went before the first --add-label.
		const verbs = h.gh.calls.filter((c) => c[0] !== "api").map((c) => `${c[0]} ${c[1]}`);
		expect(verbs.indexOf("label create")).toBeLessThan(verbs.indexOf("issue edit"));
	});

	test("a failed label list leaves the ack pending with no --add-label; the next run ensures and acks", async () => {
		const h = setup({ intakeRepo: JO_REPO });
		const issue = h.gh.file({ repo: JO_REPO });
		h.gh.fail = (a) => (a[0] === "label" && a[1] === "list" ? fail("HTTP 502: Bad Gateway") : null);
		await h.run();
		expect(h.row(issue.number)).toMatchObject({ verdict: INTAKE_ACCEPTED, acked: 0 });
		expect(h.gh.made("issue edit")).toHaveLength(0);
		expect(issue.comments).toHaveLength(0);
		expect(h.notices).toContain("issue intake: gh label list exited 1: HTTP 502: Bad Gateway");
		h.gh.fail = () => null;
		await h.run();
		expect(h.row(issue.number)?.acked).toBe(1);
		expect(issue.labels.has(LABEL.intake)).toBe(true);
		expect(issue.comments).toHaveLength(1);
		expect(h.gh.made("label create")).toHaveLength(1);
	});

	test("through the tick: an intake-repo issue is never a projected issue; the workload quoting its input gets its own issue on its repo", async () => {
		let t = T0 + 365 * 24 * 60 * MIN;
		const { ledger, path } = tempLedger(() => new Date(t).toISOString());
		const sidecar = Sidecar.open(sidecarPath({ AGENT_SYSTEM_LEDGER_DB: path }));
		const gh = new FakeGh();
		const repoDir = tmp("checkout");
		gh.origins.set(repoDir, `https://github.com/${REPO}.git`);
		const config: IssuesConfig = { trackers: [{ match: REPO, tracker: { kind: "github" } }], overrides: {}, jo: JO, ...ISSUES_DEFAULTS, intakeRepo: JO_REPO, perTick: 100, perHour: 10_000 };
		const notices: string[] = [];
		const run = () => tick({ exec: gh.exec, ledger, sidecar, config, holder: "h1", now: () => t, notice: (l) => notices.push(l), phases: { intake } });
		ensureStandingWorkload(ledger);
		ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: switchBody(true, "in-sw1") });
		t += MIN;
		const jo = gh.file({ repo: JO_REPO, title: "Please add a dark mode", body: "Jo's ask", createdAt: new Date(t).toISOString() });
		const plumb = gh.file({ repo: JO_REPO, title: "plumb: nightly report", labels: new Set(["plumb"]), createdAt: new Date(t).toISOString() });
		t += MIN;
		await run();
		const row = sidecar.db.query<IntakeRow, [number]>("SELECT * FROM intake WHERE issue_number = ?").get(jo.number)!;
		expect(row).toMatchObject({ verdict: INTAKE_ACCEPTED, acked: 1 });
		expect(sidecar.db.query<IntakeRow, [number]>("SELECT * FROM intake WHERE issue_number = ?").get(plumb.number)).toMatchObject({ verdict: INTAKE_IGNORED, reason: "labelled plumb" });
		expect([...jo.labels]).toEqual([LABEL.intake]);
		t += MIN;
		const id = ledger.openWorkload({ by: SURFACE_BY, brief: `Add a dark mode (from ${row.in_id})`, stakes: "normal", mode: "autonomous" });
		recordRepo(ledger, id, repoDir);
		t += MIN;
		await run();
		const created = gh.made("issue create");
		expect(created.map((a) => arg(a, "-R"))).toEqual([REPO]);
		const projected = sidecar.link(id)!.issue_number!;
		expect(gh.issues.get(projected)?.repo).toBe(REPO);
		expect(projected).not.toBe(jo.number);
		// Jo's issue on the intake repo is left as intake left it.
		expect(jo.title).toBe("Please add a dark mode");
		expect(jo.body).toBe("Jo's ask");
		expect([...jo.labels]).toEqual([LABEL.intake]);
		expect(jo.comments).toHaveLength(1);
		expect([...plumb.labels]).toEqual(["plumb"]);
		expect(plumb.comments).toEqual([]);
		t += config.intakeEveryMin * MIN;
		await run();
		expect(ledger.instructions(STANDING_WORKLOAD_ID).filter((i) => isJoInput(i) && i.body.startsWith("github-issue #"))).toHaveLength(1);
		expect(gh.made("label list").filter((a) => arg(a, "-R") === JO_REPO)).toHaveLength(1);
		expect(gh.made("label create").filter((a) => arg(a, "-R") === JO_REPO)).toEqual([["label", "create", LABEL.intake, "-R", JO_REPO]]);
		// Nothing the projection does reaches the intake repo: no issue edit there but intake's own label.
		expect(gh.made("issue edit").filter((a) => arg(a, "-R") === JO_REPO)).toHaveLength(1);
	});
});
