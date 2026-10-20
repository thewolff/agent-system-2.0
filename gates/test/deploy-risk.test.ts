// PLAN wl-mvgorfqqbuyyo0 rev 9 § 2, § 3.1, § 3.4 (sl-dr-risk): the deploy-risk module alone, on a real temp ledger, a
// fake `gh api`, a fake HTTPS GET and a fixed clock. Each condition alone gives its outcome; the routine case is
// routine; precedence is hold > escalate > defer > routine and warnings never block (R4); an unreadable fact, a timeout,
// an incomplete page set and a capped compare are E0 (R6, R26); an unauthenticated policy reads nothing more (R15);
// only the newest deploy-policy row counts (R16); a same-name check-run from another app is E2 (R23). R12 and R13 tie
// the code's ids to SPEC-2.0.md § A4 and its source ids to docs/deploy-risk.md.
// The reserved command words are built from pieces so this file reads through a gated shell.
import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger, Stakes } from "../../ledger/src/index";
import { DEPLOY_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../../surface/src/types";
import {
	CONDITION,
	CONDITIONS,
	type ConditionId,
	type DeployFacts,
	type DeployEvaluation,
	type GhRequest,
	type GhResult,
	type HealthResult,
	type LedgerFacts,
	type Verdict,
	evaluateDeploy,
	evaluateMerge,
	ghCli,
	instancesCoveredBy,
	instancesHash,
	insideWindow,
	ledgerFacts,
	matchCall,
	mergesSince,
	parseDeployCommand,
	parsePolicy,
	policyHash,
	readPolicySection,
	WINDOW_DEFAULT,
} from "../src/deploy-risk";
import { tempLedger, tmp } from "./helpers";

const ROOT = join(import.meta.dir, "..", "..");
const RUN = ["gh", "workflow", "run"].join(" ");
const H = "a".repeat(40);
const B = "b".repeat(40);
const BLOB = "c".repeat(40);
const API_H = "d".repeat(40);
const MERGE = "e".repeat(40);
const OTHER = "f".repeat(40);
const WEB = "ContextPress/newdle-web";
const API = "ContextPress/newdle-api";
const CRAWLER = "ContextPress/crawler";
const WEB_CMD = `${RUN} cicd.yml --ref main -R ${WEB}`;
const API_CMD = `${RUN} deploy.yml --ref main -R ${API} -f deploy=true`;
/** Tuesday 10:00 in Los Angeles: inside the default window. */
const TUESDAY = new Date("2026-10-20T17:00:00Z");
const SATURDAY = new Date("2026-10-24T17:00:00Z");
const LANE = "lane-test1";

type Section = Record<string, unknown>;
const webTarget = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	name: "web", repo: WEB, command: WEB_CMD, workflowBlob: BLOB, deployJob: "deploy",
	requiredChecks: [{ name: "build", app: "github-actions" }], rollback: "re-run cicd.yml at the previous sha",
	health: { url: "https://web.example.test/health", status: 200 }, migrations: [], sensitive: [], ...over,
});
const apiTarget = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	name: "api", repo: API, command: API_CMD, workflowBlob: BLOB, deployJob: "deploy", requiredChecks: [],
	rollback: "redeploy the previous image", health: { url: "https://api.example.test/health", status: 200 }, ...over,
});
const section = (over: Section = {}): Section => ({
	window: { tz: "America/Los_Angeles", "mon-thu": "09:00-16:00", fri: "09:00-12:00" },
	lines: { warn: 400, escalate: 1500 }, dirs: { warn: 5 }, order: [], mergeTriggered: [],
	targets: [webTarget(), apiTarget()], ...over,
});
const configOf = (s: Section): string => Bun.YAML.stringify({ deploy: s }, null, 2);

const run = (id: number, name: string, conclusion: string | null, app = "github-actions", status = "completed") => ({ id, name, status, conclusion, app: { slug: app } });
const file = (filename: string, additions = 5, deletions = 1, status = "modified") => ({ filename, status, additions, deletions });
const b64 = (o: unknown): { encoding: string; content: string } => ({ encoding: "base64", content: Buffer.from(JSON.stringify(o)).toString("base64") });

type Answer = GhResult | ((n: number) => GhResult);
const ok = (json: unknown): GhResult => ({ ok: true, json });
const fail = (error: string, notFound = false): GhResult => ({ ok: false, error, notFound });

/** The gh reads a routine deploy of web makes, answered so that nothing holds. */
function routineGh(): Map<string, Answer> {
	return new Map<string, Answer>([
		[`repos/${WEB}`, ok({ default_branch: "main" })],
		[`repos/${WEB}/commits/main`, ok({ sha: H })],
		[`repos/${WEB}/contents/.github/workflows/cicd.yml?ref=${H}`, ok({ sha: BLOB })],
		[`repos/${WEB}/commits/${H}/check-runs?filter=all&per_page=100`, ok([{ total_count: 1, check_runs: [run(1, "build", "success")] }])],
		[`repos/${WEB}/commits/${H}/status?per_page=100`, ok([{ state: "success", total_count: 1, statuses: [{ context: "ci/lint", state: "success" }] }])],
		[`repos/${WEB}/pulls?state=open&per_page=100`, ok([[{ number: 3, auto_merge: null }]])],
		[`graphql ${WEB}`, ok({ data: { repository: { mergeQueue: null } } })],
		[`repos/${WEB}/actions/workflows/cicd.yml/runs?head_sha=${B}&status=success&per_page=1`, ok({ total_count: 1, workflow_runs: [{ id: 9 }] })],
		[`repos/${WEB}/compare/${B}...${H}?per_page=100`, ok([{ total_commits: 1, commits: [{ sha: H }], files: [file("src/app.ts")] }])],
		[`repos/${API}/commits/main`, ok({ sha: API_H })],
	]);
}

interface World {
	ledger: Ledger;
	workloadId: string;
	facts: DeployFacts;
	gh: Map<string, Answer>;
	ghCalls: string[];
	httpsCalls: string[];
	ledgerCalls: string[];
	config: { text: string | null };
	health: { result: HealthResult };
	clock: { now: Date };
	/** Accept `s` with a `deploy-policy: sha256` row as Jo's surface writes it. */
	accept(s: Section): void;
	entry(body: string, by?: string, workloadId?: string): void;
	deploy(dp: string, target: string, sha: string, settled: "ok" | "failed" | null): void;
	eval(command?: string, toolEnv?: unknown): Promise<DeployEvaluation>;
	verdict(command?: string, toolEnv?: unknown): Promise<Verdict>;
}

let acceptN = 0;
function world(opts: { section?: Section; stakes?: Stakes; accept?: boolean; history?: boolean } = {}): World {
	const { ledger } = tempLedger();
	ledger.openWorkload({ by: SURFACE_BY, id: STANDING_WORKLOAD_ID, brief: "standing", stakes: "normal", mode: "user-driven" });
	const workloadId = ledger.openWorkload({ by: SURFACE_BY, brief: "ship the change", stakes: opts.stakes ?? "normal", mode: "autonomous" });
	const s = opts.section ?? section();
	const gh = routineGh();
	const ghCalls: string[] = [];
	const httpsCalls: string[] = [];
	const ledgerCalls: string[] = [];
	const config = { text: configOf(s) as string | null };
	const health = { result: { ok: true, status: 200 } as HealthResult };
	const clock = { now: TUESDAY };
	const counts = new Map<string, number>();
	const real = ledgerFacts(ledger);
	const spied: LedgerFacts = {
		mark: () => (ledgerCalls.push("mark"), real.mark()),
		rows: (p) => (ledgerCalls.push(`rows ${p}`), real.rows(p)),
		stakes: (id) => (ledgerCalls.push("stakes"), real.stakes(id)),
	};
	const facts: DeployFacts = {
		config: () => config.text,
		gh: async (req: GhRequest) => {
			const key = req.kind === "rest" ? req.path : `graphql ${req.vars.owner}/${req.vars.name}`;
			ghCalls.push(key);
			const n = counts.get(key) ?? 0;
			counts.set(key, n + 1);
			const a = gh.get(key);
			if (a === undefined) return fail(`unexpected read ${key}`);
			return typeof a === "function" ? a(n) : a;
		},
		ledger: spied,
		now: () => clock.now,
		httpsGet: async (url) => (httpsCalls.push(url), health.result),
	};
	const w: World = {
		ledger, workloadId, facts, gh, ghCalls, httpsCalls, ledgerCalls, config, health, clock,
		accept: (x) => void ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: `deploy-policy: sha256 ${policyHash(x)} in-accept${++acceptN}` }),
		entry: (body, by = DEPLOY_BY, wl = workloadId) => void ledger.recordEntry({ by, workloadId: wl, kind: "assumption", body }),
		deploy: (dp, target, sha, settled) => {
			w.entry(`deploy: ${dp} target ${target} sha ${sha} base none checks 1 warn none`);
			if (settled !== null) w.entry(`deploy-settled: ${dp} ${settled} run 1 conclusion success health 200`, DEPLOY_BY);
		},
		eval: (command = WEB_CMD, toolEnv) => evaluateDeploy({ command, toolEnv, cwd: ROOT, env: {}, workloadId }, facts),
		verdict: async (command, toolEnv) => {
			const e = await w.eval(command, toolEnv);
			if (e.kind !== "verdict") throw new Error("not a verdict");
			return e;
		},
	};
	if (opts.accept !== false) w.accept(s);
	if (opts.history !== false) {
		w.deploy("dp-web1", "web", B, "ok");
		w.deploy("dp-api1", "api", API_H, "ok");
	}
	return w;
}

const ids = (v: { conditions: { id: ConditionId }[] }): ConditionId[] => v.conditions.map((i) => i.id);
const warnIds = (v: Verdict): ConditionId[] => v.warnings.map((i) => i.id);
const factsOf = (v: Verdict, id: ConditionId): string[][] => [...v.conditions, ...v.warnings].filter((i) => i.id === id).map((i) => i.facts);

describe("the condition table", () => {
	test("ids are exactly the plan's, each with its outcome class", () => {
		expect(CONDITIONS.map((c) => c.id)).toEqual(["O1", "U1", "U2", "U3", "E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11", "M1", "D1", "W1", "W2", "W3", "W4"]);
		for (const c of CONDITIONS) {
			const want = /^[OU]/.test(c.id) ? "hold" : /^[EM]/.test(c.id) ? "escalate" : c.id === "D1" ? "defer" : "warn";
			expect(c.outcome).toBe(want);
			expect(c.sources.length > 0 || (c.basis ?? "") !== "").toBe(true);
		}
	});

	test("R12: SPEC-2.0.md § A4 names every condition id the code defines and no other", () => {
		const spec = readFileSync(join(ROOT, "SPEC-2.0.md"), "utf8");
		const at = spec.indexOf("\n### A4 ");
		expect(at).toBeGreaterThan(0);
		const end = spec.indexOf("\n### ", at + 1);
		const a4 = spec.slice(at, end < 0 ? undefined : end);
		const named = new Set([...a4.matchAll(/`([OUEMDW]\d{1,2})`/g)].map((m) => m[1]!));
		expect([...named].sort()).toEqual(CONDITIONS.map((c) => c.id).sort());
	});

	test("R13: every condition's source ids resolve to a row of docs/deploy-risk.md and match its predicates table", () => {
		const doc = readFileSync(join(ROOT, "docs", "deploy-risk.md"), "utf8");
		const sourceRows = new Set([...doc.matchAll(/^\| (S\d+) \|/gm)].map((m) => m[1]!));
		expect([...sourceRows].sort()).toEqual(Array.from({ length: 18 }, (_, i) => `S${i + 1}`).sort());
		for (const c of CONDITIONS) {
			for (const s of c.sources) expect(sourceRows.has(s)).toBe(true);
			const row = new RegExp(`^\\| ${c.id} \\| (\\w+) \\| ([^|]*) \\|`, "m").exec(doc);
			expect(row).not.toBeNull();
			expect(row![1]).toBe(c.outcome);
			expect([...row![2]!.matchAll(/\bS\d+\b/g)].map((m) => m[0])).toEqual([...c.sources]);
		}
	});
});

describe("the policy: § 2.1 shape, § 3.1 schema, canonical hash", () => {
	test("the declared command shape", () => {
		expect(parseDeployCommand(WEB_CMD)).toEqual({ ok: true, file: "cicd.yml", ref: "main", repo: WEB, inputs: [] });
		expect(parseDeployCommand(API_CMD)).toMatchObject({ ok: true, inputs: [["deploy", "true"]] });
		for (const bad of [
			` ${WEB_CMD}`, `${WEB_CMD} `, WEB_CMD.replace(" --ref", "  --ref"), `${WEB_CMD} && echo hi`, `${WEB_CMD} | cat`, `${WEB_CMD} &`,
			`${WEB_CMD} -f a`, `${WEB_CMD} -F a=1`, `${WEB_CMD} -f a=1 -f a=2`, `${WEB_CMD} -f a=$X`, `X=1 ${WEB_CMD}`, `env ${WEB_CMD}`,
			`${RUN} cicd.yml -R ${WEB} --ref main`, `${RUN} 123 --ref main -R ${WEB}`, `${RUN} cicd.yml --ref -x -R ${WEB}`, `${RUN} cicd.yml --ref main -R web`,
		]) {
			expect(parseDeployCommand(bad).ok).toBe(false);
		}
	});

	test("the section ships with targets: [] and parses to defaults", () => {
		expect(parsePolicy({ targets: [] })).toEqual({ ok: true, policy: { window: WINDOW_DEFAULT, lines: { warn: 400, escalate: 1500 }, dirs: { warn: 5 }, order: [], mergeTriggered: [], targets: [] } });
		expect(parsePolicy(section()).ok).toBe(true);
	});

	test("every departure from the schema is a parse failure", () => {
		const bad: Section[] = [
			section({ extra: 1 }),
			section({ window: { tz: "Mars/Olympus" } }),
			section({ window: { "mon-thu": "16:00-09:00" } }),
			section({ window: { sat: "09:00-12:00" } }),
			section({ lines: { warn: 2000, escalate: 1500 } }),
			section({ lines: { warn: -1 } }),
			section({ dirs: { warn: "5" } }),
			section({ order: [["web"], ["nope"]] }),
			section({ order: [["web"], ["web"]] }),
			section({ mergeTriggered: ["crawler"] }),
			section({ targets: [webTarget(), webTarget()] }),
			section({ targets: [webTarget(), webTarget({ name: "web2" })] }),
			section({ targets: [webTarget({ repo: API })] }),
			section({ targets: [webTarget({ command: `${WEB_CMD} && true` })] }),
			section({ targets: [webTarget({ workflowBlob: "abc" })] }),
			section({ targets: [webTarget({ deployJob: "" })] }),
			section({ targets: [webTarget({ health: { url: "http://web.example.test/health", status: 200 } })] }),
			section({ targets: [webTarget({ health: { url: "https://web.example.test/health", status: 999 } })] }),
			section({ targets: [webTarget({ health: undefined })] }),
			section({ targets: [webTarget({ requiredChecks: [{ name: "build" }] })] }),
			section({ targets: [webTarget({ migrations: "db/**" })] }),
			section({ targets: [webTarget({ cmd: WEB_CMD })] }),
		];
		for (const s of bad) expect(parsePolicy(JSON.parse(JSON.stringify(s))).ok).toBe(false);
	});

	test("the hash is of the section's canonical JSON: key order and YAML spelling do not change it, a value does", () => {
		const a = readPolicySection(configOf(section()));
		const reordered = readPolicySection(`deploy:\n${configOf({ targets: section().targets, mergeTriggered: [], order: [], dirs: { warn: 5 }, lines: { escalate: 1500, warn: 400 }, window: section().window }).split("\n").slice(1).join("\n")}`);
		expect(a.ok && reordered.ok && a.hash === reordered.hash).toBe(true);
		const changed = readPolicySection(configOf(section({ lines: { warn: 401, escalate: 1500 } })));
		expect(a.ok && changed.ok && a.hash !== changed.hash).toBe(true);
		expect(readPolicySection(null).ok).toBe(false);
		expect(readPolicySection("deploy: [unclosed").ok).toBe(false);
		expect(readPolicySection("other: 1\n").ok).toBe(false);
	});
});

describe("routine", () => {
	test("a byte-equal call with no condition is routine, names nothing, and records H, B, M and the checks", async () => {
		const w = world();
		const v = await w.verdict();
		expect(v.outcome).toBe("routine");
		expect(v.conditions).toEqual([]);
		expect(v.warnings).toEqual([]);
		expect(v).toMatchObject({ target: "web", repo: WEB, authenticated: true, head: H, base: B, checks: 2 });
		expect(v.mark).toBeGreaterThan(0);
		expect(v.sha256).toBe(instancesHash([]));
		expect(w.httpsCalls).toEqual(["https://web.example.test/health"]);
	});

	test("a workflow run naming no target is not this module's", async () => {
		const w = world();
		expect(await w.eval(`${RUN} other.yml --ref main -R ${WEB}`)).toEqual({ kind: "not-target" });
		expect(await w.eval(`${RUN} cicd.yml --ref main -R ContextPress/elsewhere`)).toEqual({ kind: "not-target" });
		expect(await w.eval("ls")).toEqual({ kind: "not-target" });
	});
});

describe("each condition alone gives its outcome", () => {
	const alone = async (w: World, id: ConditionId, outcome: string, command?: string, toolEnv?: unknown): Promise<Verdict> => {
		const v = await w.verdict(command, toolEnv);
		expect(ids(v)).toEqual(CONDITION[id].outcome === "warn" ? [] : v.conditions.map(() => id));
		expect(v.conditions.length > 0 || v.warnings.length > 0).toBe(true);
		expect(v.outcome).toBe(outcome);
		return v;
	};

	test("O1: an earlier order group's target has merged work not deployed", async () => {
		const w = world({ section: section({ order: [["api"], ["web"]] }) });
		expect((await w.verdict()).outcome).toBe("routine");
		w.gh.set(`repos/${API}/commits/main`, ok({ sha: OTHER }));
		expect(factsOf(await alone(w, "O1", "hold"), "O1")).toEqual([["target api"]]);
	});

	test("O1: a predecessor never deployed holds too", async () => {
		const w = world({ section: section({ order: [["api"], ["web"]] }), history: false });
		w.deploy("dp-web1", "web", B, "ok");
		expect(factsOf(await w.verdict(), "O1")).toEqual([["target api"]]);
	});

	test("U1: an unsettled deploy of the target on any workload holds and names it", async () => {
		const w = world();
		const other = w.ledger.openWorkload({ by: SURFACE_BY, brief: "other", stakes: "normal", mode: "autonomous" });
		w.entry(`deploy: dp-web2 target web sha ${H} base ${B} checks 1 warn none`, DEPLOY_BY, other);
		expect(factsOf(await alone(w, "U1", "hold"), "U1")).toEqual([["deploy dp-web2"]]);
	});

	test("U3: a merge of the repo started or finished while the facts were read holds", async () => {
		const w = world();
		w.gh.set(`repos/${WEB}/commits/main`, (n) => {
			if (n === 1) {
				w.entry(`merge-inflight: mt-1 ${WEB} pr 7`);
				w.entry("merge-done: mt-1 exit 0");
			}
			return ok({ sha: H });
		});
		const v = await alone(w, "U3", "hold");
		expect(factsOf(v, "U3")).toEqual([["merge-done mt-1"], ["merge-inflight mt-1"]]);
	});

	test("U3 at admission: mergesSince reads only the repo's rows above the mark", () => {
		const w = world();
		w.entry(`merge-inflight: mt-old ${WEB} pr 1`);
		const m = ledgerFacts(w.ledger).mark();
		w.entry(`merge-inflight: mt-api ${API} pr 2`);
		w.entry("merge-done: mt-old exit 0");
		w.entry("merge-done: mt-api exit 0");
		w.entry("merge-done: mt-unknown exit 1");
		expect(mergesSince(ledgerFacts(w.ledger), WEB, m)).toEqual([{ id: "U3", facts: ["merge-done mt-old"] }, { id: "U3", facts: ["merge-done mt-unknown"] }]);
	});

	test("E1: production stakes", async () => {
		await alone(world({ stakes: "production" }), "E1", "escalate");
	});

	test("E2: a required check missing, failing, or another check or status not green", async () => {
		const missing = world();
		missing.gh.set(`repos/${WEB}/commits/${H}/check-runs?filter=all&per_page=100`, ok([{ total_count: 1, check_runs: [run(1, "lint", "success")] }]));
		expect(factsOf(await alone(missing, "E2", "escalate"), "E2")).toEqual([["check build app github-actions missing"]]);

		const failed = world();
		failed.gh.set(`repos/${WEB}/commits/${H}/check-runs?filter=all&per_page=100`, ok([{ total_count: 2, check_runs: [run(1, "build", "success"), run(2, "build", "failure")] }]));
		expect(factsOf(await alone(failed, "E2", "escalate"), "E2")).toEqual([["check build app github-actions failure"]]);

		const pending = world();
		pending.gh.set(`repos/${WEB}/commits/${H}/check-runs?filter=all&per_page=100`, ok([{ total_count: 2, check_runs: [run(1, "build", "success"), run(2, "e2e", null, "github-actions", "in_progress")] }]));
		expect(factsOf(await alone(pending, "E2", "escalate"), "E2")).toEqual([["check e2e app github-actions in_progress"]]);

		const status = world();
		status.gh.set(`repos/${WEB}/commits/${H}/status?per_page=100`, ok([{ state: "failure", total_count: 1, statuses: [{ context: "ci/lint", state: "failure" }] }]));
		expect(factsOf(await alone(status, "E2", "escalate"), "E2")).toEqual([["status ci/lint failure"]]);
	});

	test("R23: a required check satisfied only by a same-name check-run from another app is E2", async () => {
		const w = world();
		w.gh.set(`repos/${WEB}/commits/${H}/check-runs?filter=all&per_page=100`, ok([{ total_count: 1, check_runs: [run(1, "build", "success", "impostor-app")] }]));
		expect(factsOf(await alone(w, "E2", "escalate"), "E2")).toEqual([["check build app github-actions missing"]]);
	});

	test("E3: the ref moved during evaluation, an open PR with auto-merge, a merge queue", async () => {
		const moved = world();
		moved.gh.set(`repos/${WEB}/commits/main`, (n) => ok({ sha: n === 0 ? H : OTHER }));
		expect(factsOf(await alone(moved, "E3", "escalate"), "E3")).toEqual([["ref moved"]]);
		const auto = world();
		auto.gh.set(`repos/${WEB}/pulls?state=open&per_page=100`, ok([[{ number: 3, auto_merge: null }], [{ number: 4, auto_merge: { merge_method: "squash" } }]]));
		expect(factsOf(await alone(auto, "E3", "escalate"), "E3")).toEqual([["auto-merge pr 4"]]);
		const queue = world();
		queue.gh.set(`graphql ${WEB}`, ok({ data: { repository: { mergeQueue: { id: "MQ_1" } } } }));
		expect(factsOf(await alone(queue, "E3", "escalate"), "E3")).toEqual([["merge queue"]]);
	});

	test("E4 and E5: a migration path, a sensitive path, a target's own extra glob, a rename out of one", async () => {
		const compare = (files: unknown[]) => ok([{ total_commits: 1, commits: [{}], files }]);
		const mig = world();
		mig.gh.set(`repos/${WEB}/compare/${B}...${H}?per_page=100`, compare([file("db/migrations/001_add.sql")]));
		expect(factsOf(await alone(mig, "E4", "escalate"), "E4")).toEqual([["path db/migrations/001_add.sql"]]);
		const auth = world();
		auth.gh.set(`repos/${WEB}/compare/${B}...${H}?per_page=100`, compare([file("src/auth/session.ts")]));
		expect(factsOf(await alone(auth, "E5", "escalate"), "E5")).toEqual([["path src/auth/session.ts"]]);
		const extra = world({ section: section({ targets: [webTarget({ sensitive: ["src/money/**"] }), apiTarget()] }) });
		extra.gh.set(`repos/${WEB}/compare/${B}...${H}?per_page=100`, compare([{ ...file("src/cash.ts", 1, 1, "renamed"), previous_filename: "src/money/cash.ts" }]));
		expect(factsOf(await alone(extra, "E5", "escalate"), "E5")).toEqual([["path src/money/cash.ts"]]);
	});

	test("E6: no B, no rollback text, no successful run at B", async () => {
		const first = world({ history: false });
		first.deploy("dp-api1", "api", API_H, "ok");
		expect(factsOf(await alone(first, "E6", "escalate"), "E6")).toEqual([["no B"]]);
		const noRollback = world({ section: section({ targets: [webTarget({ rollback: "" }), apiTarget()] }) });
		expect(factsOf(await alone(noRollback, "E6", "escalate"), "E6")).toEqual([["no rollback"]]);
		const noRun = world();
		noRun.gh.set(`repos/${WEB}/actions/workflows/cicd.yml/runs?head_sha=${B}&status=success&per_page=1`, ok({ total_count: 0, workflow_runs: [] }));
		expect(factsOf(await alone(noRun, "E6", "escalate"), "E6")).toEqual([["no successful run at B"]]);
	});

	test("E7: a run of a declared target's file and repo that is not byte-equal, and the bash tool's env", async () => {
		const w = world();
		expect(factsOf(await alone(w, "E7", "escalate", `${WEB_CMD} -f extra=1`), "E7")).toEqual([["+-f", "+extra=1"]]);
		expect(factsOf(await alone(world(), "E7", "escalate", `${RUN} cicd.yml --ref other -R ${WEB}`), "E7")).toEqual([["+other", "-main"]]);
		expect(factsOf(await alone(world(), "E7", "escalate", `GH_REPO=${WEB} ${RUN} cicd.yml --ref main`), "E7")).toEqual([[`+GH_REPO=${WEB}`, "--R", `-${WEB}`]]);
		expect(factsOf(await alone(world(), "E7", "escalate", `${WEB_CMD} | cat`), "E7")).toEqual([["+cat", "+|"]]);
		expect(factsOf(await alone(world(), "E7", "escalate", WEB_CMD, { GH_HOST: "x" }), "E7")).toEqual([["+env GH_HOST"]]);
		const parsed = parsePolicy(section());
		if (!parsed.ok) throw new Error(parsed.error);
		expect(matchCall({ command: `  ${WEB_CMD}\n`, cwd: ROOT, env: {} }, parsed.policy)?.kind).toBe("exact");
	});

	test("E8: the target's newest settle failed with no later ok", async () => {
		const w = world();
		w.deploy("dp-web2", "web", OTHER, "failed");
		const v = await alone(w, "E8", "escalate");
		expect(v.base).toBe(B);
	});

	test("E9 escalates above the high mark (W3 rides along)", async () => {
		const w = world();
		w.gh.set(`repos/${WEB}/compare/${B}...${H}?per_page=100`, ok([{ total_commits: 1, commits: [{}], files: [file("src/a.ts", 1000, 600)] }]));
		const v = await alone(w, "E9", "escalate");
		expect(factsOf(v, "E9")).toEqual([["lines 1600"]]);
		expect(warnIds(v)).toEqual(["W3"]);
	});

	test("E10: the health probe answers another status, or does not answer", async () => {
		const bad = world();
		bad.health.result = { ok: true, status: 503 };
		expect(factsOf(await alone(bad, "E10", "escalate"), "E10")).toEqual([["health 503"]]);
		const down = world();
		down.health.result = { ok: false, error: "ECONNREFUSED" };
		expect(factsOf(await alone(down, "E10", "escalate"), "E10")).toEqual([["health unreachable"]]);
	});

	test("E11: an unresolved as2 merge, at any age, a closed PR included; merge-done or a merge into H resolves it", async () => {
		const w = world();
		w.entry(`merge-inflight: mt-9 ${WEB} pr 9`);
		w.gh.set(`repos/${WEB}/pulls/9`, ok({ merged: false, state: "closed", merge_commit_sha: null }));
		expect(factsOf(await alone(w, "E11", "escalate"), "E11")).toEqual([["pr 9", "token mt-9"]]);

		const merged = world();
		merged.entry(`merge-inflight: mt-9 ${WEB} pr 9`);
		merged.gh.set(`repos/${WEB}/pulls/9`, ok({ merged: true, state: "closed", merge_commit_sha: MERGE }));
		merged.gh.set(`repos/${WEB}/compare/${H}...${MERGE}`, ok({ status: "behind" }));
		expect((await merged.verdict()).outcome).toBe("routine");
		merged.gh.set(`repos/${WEB}/compare/${H}...${MERGE}`, ok({ status: "ahead" }));
		expect(ids(await merged.verdict())).toEqual(["E11"]);

		const done = world();
		done.entry(`merge-inflight: mt-9 ${WEB} pr 9`);
		done.entry("merge-done: mt-9 exit 1");
		expect((await done.verdict()).outcome).toBe("routine");
	});

	test("D1: outside the window defers", async () => {
		const w = world();
		w.clock.now = SATURDAY;
		await alone(w, "D1", "defer");
		expect(insideWindow(WINDOW_DEFAULT, new Date("2026-10-23T18:30:00Z"))).toBe(true);
		expect(insideWindow(WINDOW_DEFAULT, new Date("2026-10-23T20:30:00Z"))).toBe(false);
		expect(insideWindow(WINDOW_DEFAULT, new Date("2026-10-20T23:00:00Z"))).toBe(false);
	});

	test("W1–W4 alone stay routine (R4)", async () => {
		const pkg = world();
		pkg.gh.set(`repos/${WEB}/compare/${B}...${H}?per_page=100`, ok([{ total_commits: 1, commits: [{}], files: [file("package.json")] }]));
		pkg.gh.set(`repos/${WEB}/contents/package.json?ref=${B}`, ok(b64({ dependencies: { react: "^17.0.2", zod: "3.1.0" } })));
		pkg.gh.set(`repos/${WEB}/contents/package.json?ref=${H}`, ok(b64({ dependencies: { react: "^18.2.0", zod: "3.2.0" } })));
		let v = await pkg.verdict();
		expect([v.outcome, warnIds(v), factsOf(v, "W1")]).toEqual(["routine", ["W1"], [["package.json react 17->18"]]]);

		const rerun = world();
		rerun.gh.set(`repos/${WEB}/commits/${H}/check-runs?filter=all&per_page=100`, ok([{ total_count: 3, check_runs: [run(1, "build", "failure"), run(2, "build", "success"), run(3, "docs", "skipped")] }]));
		v = await rerun.verdict();
		expect([v.outcome, factsOf(v, "W2")]).toEqual(["routine", [["check build app github-actions passed on a re-run"], ["check docs app github-actions skipped"]]]);

		const big = world();
		big.gh.set(`repos/${WEB}/compare/${B}...${H}?per_page=100`, ok([{ total_commits: 1, commits: [{}], files: [file("src/a.ts", 300, 200)] }]));
		v = await big.verdict();
		expect([v.outcome, warnIds(v)]).toEqual(["routine", ["W3"]]);

		const wide = world();
		wide.gh.set(`repos/${WEB}/compare/${B}...${H}?per_page=100`, ok([{ total_commits: 1, commits: [{}], files: ["a", "b", "c", "d", "e", "f"].map((d) => file(`${d}/x.ts`)) }]));
		v = await wide.verdict();
		expect([v.outcome, factsOf(v, "W4")]).toEqual(["routine", [["dirs 6"]]]);
	});
});

describe("E0: unreadable facts, timeouts, incomplete pages, a capped compare, a moved blob (R6, R26)", () => {
	const e0 = async (w: World): Promise<string[][]> => {
		const v = await w.verdict();
		expect(v.outcome).toBe("escalate");
		expect(ids(v).every((i) => i === "E0")).toBe(true);
		return factsOf(v, "E0");
	};

	test("gh non-zero and a missing JSON field", async () => {
		const down = world();
		down.gh.set(`repos/${WEB}/commits/${H}/status?per_page=100`, fail("gh api exited 1: HTTP 502"));
		expect(await e0(down)).toEqual([["read commit statuses"]]);
		const field = world();
		field.gh.set(`repos/${WEB}/pulls?state=open&per_page=100`, ok([[{ number: 3 }]]));
		expect(await e0(field)).toEqual([["read open pull requests"]]);
	});

	test("an unreadable H stops every read that needs it", async () => {
		const w = world();
		w.gh.set(`repos/${WEB}/commits/main`, ok({}));
		const v = await w.verdict();
		expect(factsOf(v, "E0")).toEqual([["read head"]]);
		expect(v.head).toBeNull();
		expect(w.ghCalls.some((c) => c.includes("check-runs") || c.includes("compare"))).toBe(false);
	});

	test("a timeout", async () => {
		const w = world();
		w.gh.set(`graphql ${WEB}`, fail("gh api graphql gave no answer in 20000 ms"));
		expect(await e0(w)).toEqual([["read merge queue"]]);
	});

	test("incomplete pagination of check-runs and statuses", async () => {
		const runs = world();
		runs.gh.set(`repos/${WEB}/commits/${H}/check-runs?filter=all&per_page=100`, ok([{ total_count: 101, check_runs: [run(1, "build", "success")] }]));
		expect(await e0(runs)).toEqual([["read check-runs"]]);
		const statuses = world();
		statuses.gh.set(`repos/${WEB}/commits/${H}/status?per_page=100`, ok([{ state: "success", total_count: 2, statuses: [{ context: "a", state: "success" }] }]));
		expect(await e0(statuses)).toEqual([["read commit statuses"]]);
	});

	test("R26: a compare of 300 files, or fewer commits listed than its total, is capped", async () => {
		const files = world();
		files.gh.set(`repos/${WEB}/compare/${B}...${H}?per_page=100`, ok([{ total_commits: 1, commits: [{}], files: Array.from({ length: 300 }, (_, i) => file(`src/f${i}.ts`)) }]));
		expect(await e0(files)).toEqual([["compare capped"]]);
		const commits = world();
		commits.gh.set(`repos/${WEB}/compare/${B}...${H}?per_page=100`, ok([{ total_commits: 250, commits: Array.from({ length: 100 }, () => ({})), files: [file("src/a.ts")] }]));
		expect(await e0(commits)).toEqual([["compare capped"]]);
	});

	test("the workflow blob at H is not the accepted one; the default branch is not --ref", async () => {
		const blob = world();
		blob.gh.set(`repos/${WEB}/contents/.github/workflows/cicd.yml?ref=${H}`, ok({ sha: OTHER }));
		expect(await e0(blob)).toEqual([["workflow blob"]]);
		const branch = world();
		branch.gh.set(`repos/${WEB}`, ok({ default_branch: "trunk" }));
		expect(await e0(branch)).toEqual([["default branch is not --ref"]]);
	});

	test("a malformed declaration has no parsed target and retains the original reservation", async () => {
		const bad = section({ targets: [webTarget({ command: `${WEB_CMD} ; true` })] });
		const w = world({ section: bad });
		expect(await evaluateDeploy({ command: WEB_CMD, cwd: ROOT, env: {}, workloadId: w.workloadId }, w.facts)).toEqual({ kind: "not-target" });
		expect(w.ghCalls).toEqual([]);
	});

	test("the default gh reader: a timeout, a 404, every page slurped", async () => {
		const dir = tmp("deploy-gh");
		const fake = join(dir, "gh");
		writeFileSync(fake, `#!/bin/sh\ncase "$*" in\n  *slow*) sleep 5 ;;\n  *missing*) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;\n  *) printf '%s' "$*" > "${dir}/args"; echo '[{"n":1},{"n":2}]' ;;\nesac\n`);
		chmodSync(fake, 0o755);
		const gh = ghCli({ bin: fake, timeoutMs: 300 });
		const t0 = Date.now();
		const slow = await gh({ kind: "rest", path: "repos/x/slow", paginate: false });
		expect(slow.ok).toBe(false);
		expect(Date.now() - t0).toBeLessThan(3000);
		expect(await gh({ kind: "rest", path: "repos/x/missing", paginate: false })).toMatchObject({ ok: false, notFound: true });
		expect(await gh({ kind: "rest", path: "repos/x/y", paginate: true })).toEqual({ ok: true, json: [{ n: 1 }, { n: 2 }] });
		expect(readFileSync(join(dir, "args"), "utf8")).toBe("api --paginate --slurp -H Accept: application/vnd.github+json repos/x/y");
		expect((await ghCli({ bin: join(dir, "absent") })({ kind: "rest", path: "x", paginate: false })).ok).toBe(false);
	});
});

describe("R15 and R16: authentication first; only the newest deploy-policy row counts", () => {
	test("R15: unauthenticated, no gh read, no health probe, no ledger read beyond the policy rows", async () => {
		const w = world({ accept: false });
		w.ledgerCalls.length = 0;
		const v = await w.verdict();
		expect([v.outcome, v.authenticated, v.conditions]).toEqual(["escalate", false, [{ id: "E0", facts: ["policy not authenticated"] }]]);
		expect(w.ghCalls).toEqual([]);
		expect(w.httpsCalls).toEqual([]);
		expect(w.ledgerCalls).toEqual(["rows deploy-policy"]);
	});

	test("R5 precedes R6: absent, unreadable or unparsable policy retains legacy reservation", async () => {
		for (const text of [null, "deploy: [unclosed", "other: 1\n"]) {
			const w = world();
			w.config.text = text;
			expect(await evaluateDeploy({ command: WEB_CMD, cwd: ROOT, env: {}, workloadId: w.workloadId }, w.facts)).toEqual({ kind: "not-target" });
			expect(w.ghCalls).toEqual([]);
			expect(w.httpsCalls).toEqual([]);
		}
	});

	test("R16: accepting A, then B, then restoring A's bytes is E0; B is authenticated; off is E0", async () => {
		const a = section();
		const b = section({ lines: { warn: 300, escalate: 1500 } });
		const w = world({ section: a });
		w.accept(b);
		expect(ids(await w.verdict())).toEqual(["E0"]);
		expect(w.ghCalls).toEqual([]);
		w.config.text = configOf(b);
		expect((await w.verdict()).outcome).toBe("routine");
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: "deploy-policy: off in-off1" });
		expect(factsOf(await w.verdict(), "E0")).toEqual([["policy not authenticated"]]);
	});

	test("an acceptance not written by the surface on the standing workload does not count", async () => {
		const w = world({ accept: false });
		w.entry(`deploy-policy: sha256 ${policyHash(section())} in-forged`);
		w.ledger.recordEntry({ by: LANE, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: `deploy-policy: sha256 ${policyHash(section())} in-forged2` });
		expect(ids(await w.verdict())).toEqual(["E0"]);
	});
});

describe("precedence: hold > escalate > defer > routine (§ 2.3)", () => {
	test("a hold wins over escalations and a deferral, and every condition is named", async () => {
		const w = world({ stakes: "production" });
		w.deploy("dp-web2", "web", OTHER, null);
		w.clock.now = SATURDAY;
		const v = await w.verdict();
		expect([v.outcome, v.ids]).toEqual(["hold", ["U1", "E1", "D1"]]);
	});

	test("an escalation wins over a deferral", async () => {
		const w = world({ stakes: "production" });
		w.clock.now = SATURDAY;
		const v = await w.verdict();
		expect([v.outcome, v.ids]).toEqual(["escalate", ["E1", "D1"]]);
	});

	test("a deferral wins over warnings, which never block", async () => {
		const w = world();
		w.clock.now = SATURDAY;
		w.gh.set(`repos/${WEB}/compare/${B}...${H}?per_page=100`, ok([{ total_commits: 1, commits: [{}], files: [file("src/a.ts", 300, 200)] }]));
		const v = await w.verdict();
		expect([v.outcome, v.ids, warnIds(v)]).toEqual(["defer", ["D1"], ["W3"]]);
	});
});

describe("§ 3.4 condition instances", () => {
	test("the hash is of the canonical sorted list: order and duplicates do not change it, a new instance does", () => {
		const a = [{ id: "E2" as const, facts: ["check b app x missing"] }, { id: "E11" as const, facts: ["token mt-1", "pr 4"] }];
		const b = [{ id: "E11" as const, facts: ["pr 4", "token mt-1"] }, ...a.slice(0, 1), ...a.slice(0, 1)];
		expect(instancesHash(a)).toBe(instancesHash(b));
		expect(instancesHash([...a, { id: "E11", facts: ["pr 5", "token mt-2"] }])).not.toBe(instancesHash(a));
		expect(instancesCoveredBy(a.slice(1), a)).toBe(true);
		expect(instancesCoveredBy([...a, { id: "E11", facts: ["pr 5", "token mt-2"] }], a)).toBe(false);
	});

	test("a verdict's sha256 is the hash of its conditions, warnings excluded", async () => {
		const w = world({ stakes: "production" });
		w.gh.set(`repos/${WEB}/compare/${B}...${H}?per_page=100`, ok([{ total_commits: 1, commits: [{}], files: [file("src/a.ts", 300, 200)] }]));
		const v = await w.verdict();
		expect(v.sha256).toBe(instancesHash([{ id: "E1", facts: [] }]));
		expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("gh pr merge: M1 and U2 (§ 3.4, § 2.4)", () => {
	test("M1: the code constant holds with no policy at all, and records the PR head", async () => {
		const w = world();
		w.config.text = null;
		w.gh.set(`repos/${CRAWLER}/pulls/5`, ok({ head: { sha: H } }));
		const v = await evaluateMerge({ repo: CRAWLER, pr: 5 }, w.facts);
		expect([v.outcome, v.ids, v.head]).toEqual(["escalate", ["M1"], H]);
	});

	test("M1: an unreadable head is `head unknown`", async () => {
		const w = world();
		const v = await evaluateMerge({ repo: CRAWLER, pr: 5 }, w.facts);
		expect([v.outcome, v.head]).toEqual(["escalate", null]);
		expect(v.notes.join(" ")).toContain("head unknown");
	});

	test("M1: the policy's mergeTriggered counts only when authenticated", async () => {
		const s = section({ mergeTriggered: ["ContextPress/other"] });
		const w = world({ section: s });
		w.gh.set("repos/ContextPress/other/pulls/2", ok({ head: { sha: H } }));
		expect((await evaluateMerge({ repo: "ContextPress/other", pr: 2 }, w.facts)).ids).toEqual(["M1"]);
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: "deploy-policy: off in-off2" });
		expect((await evaluateMerge({ repo: "ContextPress/other", pr: 2 }, w.facts)).outcome).toBe("routine");
	});

	test("U2: a merge on a repo whose deploy is unsettled holds; another repo's merge does not", async () => {
		const w = world();
		w.deploy("dp-web2", "web", H, null);
		const v = await evaluateMerge({ repo: WEB, pr: 8 }, w.facts);
		expect([v.outcome, v.conditions]).toEqual(["hold", [{ id: "U2", facts: ["deploy dp-web2"] }]]);
		expect((await evaluateMerge({ repo: API, pr: 8 }, w.facts)).outcome).toBe("routine");
		w.entry("deploy-settled: dp-web2 ok run 2", DEPLOY_BY);
		expect((await evaluateMerge({ repo: WEB, pr: 8 }, w.facts)).outcome).toBe("routine");
	});
});
