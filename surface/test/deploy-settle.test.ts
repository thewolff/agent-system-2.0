import { describe, expect, test } from "bun:test";
import { defaultFacts, formatDeployRow, formatDeployRunRow, ledgerFacts, policyHash, type DeployFacts, type GhRequest, type GhResult } from "../../gates/src/deploy-risk";
import { settleDeploy } from "../scripts/deploy";
import { DEPLOY_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ensureStandingWorkload } from "../src/identity";
import { clock, tempLedger } from "./helpers";

const H = "a".repeat(40), H2 = "b".repeat(40);
const target = { name: "web", repo: "ContextPress/newdle-web", command: "gh workflow run cicd.yml --ref main -R ContextPress/newdle-web", workflowBlob: "c".repeat(40), deployJob: "deploy", requiredChecks: [{ name: "test", app: "github-actions" }], rollback: "restore previous image; never automatic", health: { url: "https://example.com/health", status: 200 } };
const section = { targets: [target] };
function fixture() {
	const time = clock("2026-10-19T18:00:00.000Z");
	const { ledger, path } = tempLedger(time.now);
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "ship", stakes: "normal", mode: "autonomous" });
	ensureStandingWorkload(ledger);
	const entry = (body: string, by = DEPLOY_BY) => ledger.recordEntry({ by, workloadId: wl, kind: "assumption", body });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: `deploy-policy: sha256 ${policyHash(section)} in-accepted` });
	entry(formatDeployRow({ id: "dp-test", target: "web", sha: H, base: H2, checks: 14, warnings: [1, 2, 3, 4].map((i) => ({ id: `W${i}` as "W1", facts: [`warning-${i}`] })) }));
	const calls: GhRequest[] = [];
	let run = { id: 123, event: "workflow_dispatch", path: ".github/workflows/cicd.yml", created_at: time.now(), head_sha: H, status: "completed", conclusion: "success" };
	let candidates: unknown[] = [run];
	let jobs = [{ name: "deploy", status: "completed", conclusion: "success" }];
	let health = 200;
	let ghError = false;
	const facts: DeployFacts = { ...defaultFacts(ledger), config: () => JSON.stringify({ deploy: section }), now: () => new Date(time.now()), httpsGet: async () => ({ ok: true, status: health }), gh: async (req): Promise<GhResult> => {
		calls.push(req);
		if (ghError) return { ok: false, error: "offline", notFound: false };
		if (req.kind !== "rest") return { ok: false, error: "unexpected graphql", notFound: false };
		if (req.path.includes("/jobs")) return { ok: true, json: [{ total_count: jobs.length, jobs }] };
		if (req.path.includes("/actions/runs/")) return { ok: true, json: run };
		if (req.path.includes("/runs?")) return { ok: true, json: [{ total_count: candidates.length, workflow_runs: candidates }] };
		return { ok: false, error: `unavailable fact ${req.path}`, notFound: false };
	} };
	return { ledger, path, wl, time, entry, facts, calls, set: (v: { candidates?: unknown[]; run?: Partial<typeof run>; jobs?: typeof jobs; health?: number; ghError?: boolean }) => {
		if (v.candidates) candidates = v.candidates;
		if (v.run) run = { ...run, ...v.run };
		if (v.jobs) jobs = v.jobs;
		if (v.health !== undefined) health = v.health;
		if (v.ghError !== undefined) ghError = v.ghError;
	}, settles: () => ledgerFacts(ledger).rows("deploy-settled"), notices: () => ledger.db.query<{ body: string }, []>("SELECT body FROM messages WHERE body LIKE 'notice:%'").all() };
}

describe("deploy settle (R4 R8 R25 R27)", () => {
	test("own dispatch id wins; success preserves all warnings; concurrent and repeated settlement send one notice", async () => {
		const x = fixture();
		x.entry(formatDeployRunRow({ id: "dp-test", runId: "123", url: "https://github.com/ContextPress/newdle-web/actions/runs/123" }));
		x.set({ candidates: [{ id: 999 }, { id: 1000 }] });
		const results = await Promise.all([settleDeploy(x.ledger, "dp-test", { facts: x.facts }), settleDeploy(x.ledger, "dp-test", { facts: x.facts })]);
		expect(results.every((r) => r.code === 0)).toBe(true);
		expect(x.settles()).toHaveLength(1);
		expect(x.settles()[0]!.body).toContain(" ok ");
		expect(x.notices()).toHaveLength(1);
		for (const id of ["W1", "W2", "W3", "W4"]) expect(x.notices()[0]!.body).toContain(id);
		expect(x.notices()[0]!.body).toContain("14 checks green");
		expect(x.calls.some((c) => c.kind === "rest" && c.path.includes("/runs?"))).toBe(false);
		await settleDeploy(x.ledger, "dp-test", { facts: x.facts });
		expect(x.notices()).toHaveLength(1);
	});
	test("unique dispatch-window candidate succeeds, but other events and out-of-window candidates do not bind", async () => {
		const x = fixture();
		x.set({ candidates: [{ id: 123, event: "workflow_dispatch", created_at: x.time.now() }, { id: 999, event: "push", created_at: x.time.now() }, { id: 888, event: "workflow_dispatch", created_at: "2026-10-19T18:02:01.000Z" }] });
		expect((await settleDeploy(x.ledger, "dp-test", { facts: x.facts })).code).toBe(0);
		const list = x.calls.find((c) => c.kind === "rest" && c.path.includes("/runs?"));
		expect(list?.kind === "rest" && list.paginate).toBe(true);
		expect(list?.kind === "rest" && decodeURIComponent(list.path)).toContain("created=2026-10-19T18:00:00.000Z..2026-10-19T18:02:00.000Z");
	});
	test("filtered fallback still requires complete pagination and checks every candidate's window", async () => {
		for (const complete of [false, true]) {
			const x = fixture();
			const original = x.facts.gh;
			x.facts.gh = async (req) => req.kind === "rest" && req.path.includes("/runs?")
				? { ok: true, json: [{ total_count: 2, workflow_runs: [{ id: 123, event: "workflow_dispatch", created_at: x.time.now() }] }, ...(complete ? [{ total_count: 2, workflow_runs: [{ id: 999, event: "workflow_dispatch", created_at: "2026-10-19T18:02:01.000Z" }] }] : [])] }
				: original(req);
			const result = await settleDeploy(x.ledger, "dp-test", { facts: x.facts });
			expect(result.code).toBe(complete ? 0 : 1);
			expect(x.settles()).toHaveLength(complete ? 1 : 0);
			if (!complete) expect(result.line).toContain("incomplete workflow_runs pagination");
		}
	});
	test("nonzero dispatch exit alone never settles; no run waits until 600s then fails not-dispatched", async () => {
		const x = fixture();
		x.entry(formatDeployRunRow({ id: "dp-test", exit: 1 })); x.set({ candidates: [] });
		x.time.at("2026-10-19T18:09:59.000Z");
		expect((await settleDeploy(x.ledger, "dp-test", { facts: x.facts })).code).not.toBe(0);
		expect(x.settles()).toHaveLength(0); expect(x.notices()).toHaveLength(0);
		x.time.at("2026-10-19T18:10:00.000Z");
		expect((await settleDeploy(x.ledger, "dp-test", { facts: x.facts })).code).not.toBe(0);
		expect(x.settles()[0]!.body).toContain("failed not-dispatched"); expect(x.notices()).toHaveLength(1);
	});
	test("nonzero dispatch exit can still bind an accepted successful run", async () => {
		const x = fixture(); x.entry(formatDeployRunRow({ id: "dp-test", exit: 1 }));
		expect((await settleDeploy(x.ledger, "dp-test", { facts: x.facts })).code).toBe(0);
	});
	test("several candidates fail ambiguous-run", async () => {
		const x = fixture(); x.set({ candidates: [123, 124].map((id) => ({ id, event: "workflow_dispatch", created_at: x.time.now() })) });
		await settleDeploy(x.ledger, "dp-test", { facts: x.facts });
		expect(x.settles()[0]!.body).toContain("failed ambiguous-run");
	});
	test("running or unreadable run leaves unsettled without notice", async () => {
		for (const change of [{ run: { status: "in_progress", conclusion: null as unknown as string } }, { ghError: true }]) {
			const x = fixture(); x.entry(formatDeployRunRow({ id: "dp-test", runId: "123" })); x.set(change);
			expect((await settleDeploy(x.ledger, "dp-test", { facts: x.facts })).code).not.toBe(0);
			expect(x.settles()).toHaveLength(0); expect(x.notices()).toHaveLength(0);
		}
	});
	for (const [name, change] of [
		["failed run", { run: { conclusion: "failure" } }],
		["skipped deploy job", { jobs: [{ name: "deploy", status: "completed", conclusion: "skipped" }] }],
		["missing deploy job", { jobs: [] }],
		["failed health", { health: 503 }],
	] as const) test(`${name} fails and preserves rollback text without executing it`, async () => {
		const x = fixture(); x.set(change as Parameters<typeof x.set>[0]);
		expect((await settleDeploy(x.ledger, "dp-test", { facts: x.facts })).code).not.toBe(0);
		expect(x.settles()[0]!.body).toContain("failed");
		expect(x.notices()[0]!.body).toContain(target.rollback);
	});
	test("shipped sha mismatch uses shared predicates at H2 and names migration, sensitive and size conditions", async () => {
		const x = fixture(); x.set({ run: { head_sha: H2 } });
		x.entry(formatDeployRow({ id: "dp-base", target: "web", sha: H, base: null, checks: 1, warnings: [] }));
		x.entry("deploy-settled: dp-base ok run 1 success");
		const gh = x.facts.gh;
		x.facts.gh = async (req) => {
			if (req.kind === "rest" && req.path.includes("/compare/")) {
				expect(req.path).toContain(`${H}...${H2}`);
				return { ok: true, json: [{ total_commits: 1, commits: [{}], files: [
					{ filename: "db/migrations/new.sql", status: "added", additions: 1600, deletions: 0 },
					{ filename: "src/auth/token.ts", status: "modified", additions: 1, deletions: 1 },
				] }] };
			}
			return gh(req);
		};
		await settleDeploy(x.ledger, "dp-test", { facts: x.facts });
		expect(x.settles().find((r) => r.body.startsWith("deploy-settled: dp-test"))!.body).toContain("failed shipped-unevaluated");
		for (const condition of ["E0", "E4 path db/migrations/new.sql", "E5 path src/auth/token.ts", "E9 lines 1602"]) expect(x.notices()[0]!.body).toContain(condition);
		expect(x.notices()[0]!.body).toContain(H2);
	});
	test("settlement and notice enqueue roll back together on enqueue failure, allowing a clean retry", async () => {
		const x = fixture();
		const first = await settleDeploy(x.ledger, "dp-test", { facts: x.facts, notice: () => { throw new Error("notice unavailable"); } });
		expect(first.line).toContain("notice unavailable");
		expect(x.settles()).toHaveLength(0); expect(x.notices()).toHaveLength(0);
		expect((await settleDeploy(x.ledger, "dp-test", { facts: x.facts })).code).toBe(0);
		expect(x.settles()).toHaveLength(1); expect(x.notices()).toHaveLength(1);
	});
	test("policy revocation leaves settlement pending without using unauthenticated facts", async () => {
		const x = fixture();
		x.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: "deploy-policy: off in-off" });
		expect((await settleDeploy(x.ledger, "dp-test", { facts: x.facts })).code).not.toBe(0);
		expect(x.calls).toHaveLength(0); expect(x.settles()).toHaveLength(0); expect(x.notices()).toHaveLength(0);
	});
	test("forged deploy and settle rows have no authority", async () => {
		const x = fixture(); x.entry("deploy-settled: dp-test ok forged", "lane-forger");
		await settleDeploy(x.ledger, "dp-test", { facts: x.facts });
		expect(x.notices()).toHaveLength(1);
		x.entry(formatDeployRow({ id: "dp-forged", target: "web", sha: H, base: H2, checks: 1, warnings: [] }), "lane-forger");
		expect((await settleDeploy(x.ledger, "dp-forged", { facts: x.facts })).code).not.toBe(0);
	});
});
