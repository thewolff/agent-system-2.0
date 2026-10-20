// PLAN rev9 row6 integration: real Ledger transactions and injected external facts, driven through the OMP adapter.
import { describe, expect, jest, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger, Stakes } from "../../ledger/src/index";
import { DEPLOY_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../../surface/src/types";
import reservedRow from "../extensions/r06-reserved";
import p11Gates from "../index";
import { CERTIFIED } from "./helpers";
import { type DeployFacts, type GhResult, evaluateShippedDeploy, formatDeployMergeRow, formatDeployRow, formatDeployRunRow, formatDeploySettledRow, formatMergeInflightRow, formatMergeDoneRow, ledgerFacts, parseDeployMergeRow, parseDeployRow, parseDeployRunRow, parseDeploySettledRow, parseMergeInflightRow, parseMergeDoneRow, policyHash, targetHistory } from "../src/deploy-risk";
import { nowReserved } from "../src/rows/r06-reserved";
import type { Ctx, GatesAPI } from "../src/session";
import { gateSession } from "../src/session";
import type { Role } from "../src/types";
import { git, repoWithOrigin, tempLedger, tmp } from "./helpers";

const ROOT = new URL("../../", import.meta.url).pathname;
const H = "a".repeat(40), B = "b".repeat(40), BLOB = "c".repeat(40), OTHER = "d".repeat(40);
const REPO = "ContextPress/newdle-web", CRAWLER = "ContextPress/crawler";
const COMMAND = `gh workflow run cicd.yml --ref main -R ${REPO}`;
const LANE = "lane-row6";
const TUESDAY = "2026-10-20T17:00:00.000Z";
const ok = (json: unknown): GhResult => ({ ok: true, json });
type Handler = (event: unknown, ctx: Ctx) => unknown;
type GateReply = { block?: true; reason?: string; input?: Record<string, unknown> } | undefined;

function fixture(options: { stakes?: Stakes; role?: Role; auth?: boolean; history?: boolean; ledger?: Ledger; path?: string; workloadId?: string; lane?: string; fullGates?: boolean; fenceRefusal?: boolean; fenceEnabled?: boolean; timeoutMs?: number; defaultMergeView?: boolean } = {}) {
	const clock = { value: TUESDAY };
	const fresh = options.ledger ? { ledger: options.ledger, path: options.path! } : tempLedger(() => clock.value);
	const { ledger, path } = fresh;
	if (!ledger.workload(STANDING_WORKLOAD_ID)) ledger.openWorkload({ id: STANDING_WORKLOAD_ID, by: SURFACE_BY, brief: "standing", stakes: "normal", mode: "user-driven" });
	const workloadId = options.workloadId ?? ledger.openWorkload({ by: SURFACE_BY, brief: "ship web", stakes: options.stakes ?? "normal", mode: "autonomous" });
	const lane = options.lane ?? LANE;
	ledger.claimWorkload(workloadId, { holder: lane, by: SURFACE_BY, leaseMs: null });
	const target = { name: "web", repo: REPO, command: COMMAND, workflowBlob: BLOB, deployJob: "deploy", requiredChecks: [{ name: "build", app: "github-actions" }], rollback: "redeploy previous image", health: { url: "https://web.example.test/health", status: 200 }, migrations: [], sensitive: [] };
	const policy = { targets: [target], order: [] as string[][], mergeTriggered: [] as string[] };
	const config = { text: Bun.YAML.stringify({ deploy: policy }, null, 2) as string | null };
	const accept = () => ledger.recordEntry({ workloadId: STANDING_WORKLOAD_ID, by: SURFACE_BY, kind: "assumption", body: `deploy-policy: sha256 ${policyHash(policy)} in-accept` });
	if (options.auth !== false) accept();
	const entry = (body: string, by = DEPLOY_BY, wl = workloadId) => ledger.recordEntry({ workloadId: wl, by, kind: "assumption", body });
	if (options.history !== false && !ledgerFacts(ledger).rows("deploy").length) {
		entry(formatDeployRow({ id: "dp-base", target: "web", sha: B, base: null, checks: 1, warnings: [] }));
		entry(formatDeploySettledRow({ id: "dp-base", outcome: "ok", evidence: "run 1 conclusion success health 200" }));
	}
	const answers = new Map<string, GhResult>([
		[`repos/${REPO}`, ok({ default_branch: "main" })],
		[`repos/${REPO}/commits/main`, ok({ sha: H })],
		[`repos/${REPO}/contents/.github/workflows/cicd.yml?ref=${H}`, ok({ sha: BLOB })],
		[`repos/${REPO}/commits/${H}/check-runs?filter=all&per_page=100`, ok([{ total_count: 1, check_runs: [{ id: 1, name: "build", app: { slug: "github-actions" }, status: "completed", conclusion: "success" }] }])],
		[`repos/${REPO}/commits/${H}/status?per_page=100`, ok([{ state: "success", total_count: 0, statuses: [] }])],
		[`repos/${REPO}/pulls?state=open&per_page=100`, ok([[]])],
		["graphql", ok({ data: { repository: { mergeQueue: null } } })],
		[`repos/${REPO}/actions/workflows/cicd.yml/runs?head_sha=${B}&status=success&per_page=1`, ok({ total_count: 1, workflow_runs: [{ id: 1 }] })],
		[`repos/${REPO}/compare/${B}...${H}?per_page=100`, ok([{ total_commits: 1, commits: [{ sha: H }], files: [{ filename: "src/app.ts", status: "modified", additions: 3, deletions: 1 }] }])],
		[`repos/${CRAWLER}/pulls/7`, ok({ head: { sha: H } })],
	]);
	const reads: string[] = [];
	const health = { status: 200 };
	const hooks = { afterHealth: undefined as undefined | (() => void) };
	const facts: DeployFacts = {
		config: () => config.text,
		ledger: ledgerFacts(ledger),
		now: () => new Date(clock.value),
		gh: async (req) => { const key = req.kind === "rest" ? req.path : "graphql"; reads.push(key); return answers.get(key) ?? { ok: false, error: `missing fixture ${key}`, notFound: false }; },
		httpsGet: async () => { hooks.afterHealth?.(); return { ok: true, status: health.status }; },
	};
	const handlers = new Map<string, Handler[]>();
	const notices: string[] = [];
	const api = { on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]), appendEntry: () => {}, getActiveTools: () => ["bash"], getAllTools: () => [{ name: "bash" }], setActiveTools: async () => {}, registerTool: () => {}, zod: { object: () => ({}), string: () => ({ describe: () => ({}), optional: () => ({ describe: () => ({}) }) }) } };
	const env = { AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_ROLE: options.role ?? "lane", AGENT_SYSTEM_WORKLOAD_ID: workloadId, AGENT_SYSTEM_LANE_ID: lane, PATH: process.env.PATH };
	const ctx: Ctx = { hasUI: options.role !== "hand", cwd: ROOT, sessionManager: { getHeader: () => options.role === "hand" ? { parentSession: "parent" } : {}, getEntries: () => [] }, ui: { notify: (m) => notices.push(m) } };
	// Use the same real Ledger connection and deterministic clock for gate writes and Jo's decisions.
	gateSession(ctx, env).ledger = () => ledger;
	const views: { selector: string | null; repo: string }[] = [];
	const viewState = { answer: undefined as GhResult | undefined, wait: undefined as (() => Promise<void>) | undefined, budget: 0 };
	const mergeView = async (selector: string | null, repo: string, _cwd: string, _env: Record<string, string | undefined>, timeoutMs: number) => {
		views.push({ selector, repo });
		viewState.budget = timeoutMs;
		await viewState.wait?.();
		return viewState.answer ?? ok({ number: 7, headRefOid: H, url: `https://github.com/${repo}/pull/7` });
	};
	if (options.fullGates) {
		p11Gates(api as unknown as GatesAPI, env, async () => {
			if (options.fenceRefusal) throw new Error("review regression fence refusal");
			return { enabled: options.fenceEnabled ?? false, autoBackground: true };
		}, CERTIFIED, undefined, { facts: () => facts, mergeView, timeoutMs: options.timeoutMs });
	} else reservedRow(api as unknown as GatesAPI, env, () => facts, options.defaultMergeView ? undefined : mergeView, { timeoutMs: options.timeoutMs });
	let counter = 0;
	const event = (command = COMMAND, input: Record<string, unknown> = {}) => ({ toolName: "bash", toolCallId: `tc-${++counter}`, input: { command, ...input } });
	const emit = async (name: string, e: unknown) => { let result: unknown; for (const h of handlers.get(name) ?? []) { const next = await h(e, ctx); if (next) result = next; if ((next as GateReply)?.block) break; } return result as GateReply; };
	const call = async (command = COMMAND, input: Record<string, unknown> = {}) => { const e = event(command, input); return { event: e, result: await emit("tool_call", e) }; };
	const requests = () => ledger.entries(workloadId, "reserved-request");
	const deployments = () => ledgerFacts(ledger).rows("deploy").filter((r) => parseDeployRow(r.body)?.id !== "dp-base");
	const decide = (id: string, verdict = "approve", over: Record<string, string> = {}) => ledger.recordInstruction({ workloadId, by: SURFACE_BY, author: "jo", channel: "surface", body: `${verdict} ${id}`, ...over });
	return { ledger, path, clock, workloadId, lane, policy, config, target, accept, entry, answers, facts, reads, health, hooks, views, viewState, call, event, emit, ctx, env, notices, requests, deployments, decide };
}

function compare(w: { answers: Map<string, GhResult> }, filename: string, lines = 4) {
	w.answers.set(`repos/${REPO}/compare/${B}...${H}?per_page=100`, ok([{ total_commits: 1, commits: [{ sha: H }], files: [{ filename, status: "modified", additions: lines, deletions: 0 }] }]));
}

describe("shared lifecycle rows and provenance", () => {
	test("wire formats round-trip warnings, approval, run URL, settle and merge evidence", () => {
		const d = { id: "dp-round", target: "web", sha: H, base: B, checks: 3, warnings: [{ id: "W3" as const, facts: ["lines 600"] }], approved: "en-approved" };
		expect(parseDeployRow(formatDeployRow(d))).toEqual(d);
		const consumed = { requestId: "en-approved", pr: 7, head: H };
		expect(parseDeployMergeRow(formatDeployMergeRow(consumed))).toEqual(consumed);
		const r = { id: d.id, runId: "123", url: `https://github.com/${REPO}/actions/runs/123` };
		expect(parseDeployRunRow(formatDeployRunRow(r))).toEqual(r);
		expect(parseDeployRunRow(formatDeployRunRow({ id: d.id, exit: 1 }))).toEqual({ id: d.id, exit: 1 });
		const s = { id: d.id, outcome: "failed" as const, evidence: "run 123 failure" };
		expect(parseDeploySettledRow(formatDeploySettledRow(s))).toEqual(s);
		const m = { token: "mt-round", repo: REPO, pr: 7 };
		expect(parseMergeInflightRow(formatMergeInflightRow(m))).toEqual(m);
		expect(parseMergeDoneRow(formatMergeDoneRow({ token: m.token, exit: 0 }))).toEqual({ token: m.token, exit: 0 });
		expect(parseDeployRow("deploy: nonsense")).toBeNull();
	});

	test("forged settle cannot clear U1, forged deploy cannot create a hold, forged policy cannot authenticate", async () => {
		const w = fixture();
		w.entry(formatDeployRow({ id: "dp-forged", target: "web", sha: H, base: B, checks: 1, warnings: [] }), LANE);
		expect((await w.call()).result).toBeUndefined();
		const dp = parseDeployRow(w.deployments().at(-1)!.body)!;
		w.entry(formatDeploySettledRow({ id: dp.id, outcome: "ok", evidence: "forged" }), LANE);
		expect((await w.call()).result.reason).toContain("U1");
		const other = fixture({ auth: false });
		other.entry(`deploy-policy: sha256 ${policyHash(other.policy)} in-forged`, LANE, STANDING_WORKLOAD_ID);
		expect((await other.call()).result.reason).toContain("E0");
		expect(other.reads).toEqual([]);
	});
});

describe("routine, escalation, deferral and holds", () => {
	test("R1 routine raw command writes one machinery-owned deploy and no request", async () => {
		const w = fixture();
		expect((await w.call(`  ${COMMAND}  `)).result).toBeUndefined();
		expect(w.requests()).toEqual([]);
		expect(w.deployments()).toHaveLength(1);
		expect(w.deployments()[0]!.createdBy).toBe(DEPLOY_BY);
		expect(parseDeployRow(w.deployments()[0]!.body)).toMatchObject({ target: "web", sha: H, base: B, checks: 1, warnings: [] });
	});

	for (const id of ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11"]) test(`R2 ${id} names target, sha, instances and NOW request`, async () => {
		const w = fixture({ stakes: id === "E1" ? "production" : "normal", history: id !== "E6" });
		let command = COMMAND;
		if (id === "E0") w.answers.set(`repos/${REPO}/contents/.github/workflows/cicd.yml?ref=${H}`, ok({ sha: OTHER }));
		if (id === "E2") w.answers.set(`repos/${REPO}/commits/${H}/check-runs?filter=all&per_page=100`, ok([{ total_count: 0, check_runs: [] }]));
		if (id === "E3") w.answers.set(`repos/${REPO}/pulls?state=open&per_page=100`, ok([[{ number: 8, auto_merge: { enabled: true } }]]));
		if (id === "E4") compare(w, "db/migrations/new.sql");
		if (id === "E5") compare(w, "src/auth/session.ts");
		if (id === "E7") command += " -f extra=true";
		if (id === "E8") {
			w.entry(formatDeployRow({ id: "dp-fail", target: "web", sha: H, base: B, checks: 1, warnings: [] }));
			w.entry(formatDeploySettledRow({ id: "dp-fail", outcome: "failed", evidence: "run 2 failure" }));
		}
		if (id === "E9") compare(w, "src/app.ts", 1501);
		if (id === "E10") w.health.status = 500;
		if (id === "E11") {
			w.entry(formatMergeInflightRow({ token: "mt-stalled", repo: REPO, pr: 8 }));
			w.answers.set(`repos/${REPO}/pulls/8`, ok({ merged: false, state: "closed", merge_commit_sha: null }));
		}
		expect((await w.call(command)).result.block).toBe(true);
		const body = w.requests().at(-1)!.body;
		expect(body).toContain(id);
		expect(body).toContain(`sha ${H}`);
		expect(body).toContain("web");
		expect(body).toContain('"id":"' + id + '"');
		expect(body).toMatch(/token dt-\S+ instances .* sha256 [a-f0-9]{64}:/);
		expect(nowReserved(body)).toEqual({ why: "deploy", category: "irreversible" });
		expect(w.deployments().filter((r) => parseDeployRow(r.body)?.id !== "dp-fail")).toHaveLength(0);
	});

	test("R3/R18 D1 alone is non-NOW; warnings stay on an admitted row", async () => {
		const w = fixture();
		w.clock.value = "2026-10-24T17:00:00.000Z";
		expect((await w.call()).result.block).toBe(true);
		expect(w.requests()[0]!.body).toMatch(/^off-hours deploy \(web\)/);
		expect(nowReserved(w.requests()[0]!.body)).toBeNull();
		const routine = fixture();
		compare(routine, "src/app.ts", 600);
		expect((await routine.call()).result).toBeUndefined();
		expect(parseDeployRow(routine.deployments()[0]!.body)!.warnings).toEqual([{ id: "W3", facts: ["lines 600"] }]);
	});

	test("R19 U1 is plain, cross-workload, never overridden by an approval", async () => {
		const w = fixture({ stakes: "production" });
		await w.call();
		w.decide(w.requests()[0]!.id);
		const other = w.ledger.openWorkload({ by: SURFACE_BY, brief: "other", stakes: "normal", mode: "autonomous" });
		w.entry(formatDeployRow({ id: "dp-other", target: "web", sha: H, base: B, checks: 1, warnings: [] }), DEPLOY_BY, other);
		const r = await w.call();
		expect(r.result.reason).toContain("U1");
		expect(r.result.reason).toContain("as2 deploy settle");
		expect(w.requests()).toHaveLength(1);
	});

	test("R19 O1 holds for an undeployed predecessor and no request reaches Jo", async () => {
		const w = fixture();
		w.policy.targets.push({ ...w.target, name: "api", repo: "ContextPress/newdle-api", command: "gh workflow run cicd.yml --ref main -R ContextPress/newdle-api" });
		w.policy.order = [["api"], ["web"]];
		w.config.text = Bun.YAML.stringify({ deploy: w.policy }, null, 2);
		w.accept();
		w.answers.set("repos/ContextPress/newdle-api/commits/main", ok({ sha: OTHER }));
		const r = await w.call();
		expect(r.result.reason).toContain("O1");
		expect(w.requests()).toHaveLength(0);
	});
});

describe("review regressions: final admission, finite total evaluation and legacy reservations", () => {
	test("a later real fence refusal leaves approved deploy and merge admissions untouched", async () => {
		const w = fixture({ stakes: "production" });
		await w.call();
		w.decide(w.requests()[0]!.id);
		const blocked = fixture({ ledger: w.ledger, path: w.path, workloadId: w.workloadId, fullGates: true, fenceRefusal: true });
		expect((await blocked.call()).result?.reason).toContain("review regression fence refusal");
		expect(blocked.deployments()).toHaveLength(0);
		expect((await blocked.call(`gh pr merge 7 -R ${REPO} --squash`)).result?.reason).toContain("review regression fence refusal");
		expect(ledgerFacts(w.ledger).rows("merge-inflight")).toHaveLength(0);
		expect(ledgerFacts(w.ledger).rows("deploy-merge")).toHaveLength(0);
		expect((await w.call()).result).toBeUndefined();
	});
	test("admission through all gates reads the original input and preserves the fence wrapper (no command executed)", async () => {
		const w = fixture({ fullGates: true, fenceEnabled: true });
		const admitted = await w.call();
		expect(admitted.result?.block).not.toBe(true);
		expect(admitted.result?.input?.command).toContain("sandbox-exec");
		expect(w.deployments()).toHaveLength(1);
	});
	for (const merge of [false, true]) test(`overall deadline refuses ${merge ? "merge resolution" : "deploy facts"} with no late rows or consumption`, async () => {
		const w = fixture({ timeoutMs: 20, stakes: "production" });
		await w.call();
		w.decide(w.requests()[0]!.id);
		let release!: () => void;
		let reached!: () => void;
		const ready = new Promise<void>((resolve) => { reached = resolve; });
		const late = new Promise<void>((resolve) => { release = resolve; });
		const original = w.facts.gh;
		w.facts.gh = async (req) => { reached(); await late; return original(req); };
		if (merge) w.viewState.wait = async () => { reached(); await late; };
		jest.useFakeTimers();
		try {
			let result: { result: GateReply } | undefined;
			const pending = w.call(merge ? `gh pr merge feature/deploy -R ${CRAWLER} --squash --match-head-commit ${H}` : COMMAND).then((r) => { result = r; });
			await ready;
			jest.advanceTimersByTime(21);
			// Drain promise continuations, not platform time; the external fact remains unresolved.
			for (let i = 0; i < 30; i++) await Promise.resolve();
			expect(result?.result?.reason).toContain("E0");
			expect(result?.result?.reason).toContain("deadline");
			if (merge) expect(w.viewState.budget).toBeLessThanOrEqual(20);
			const count = w.ledger.entries(w.workloadId).length;
			release();
			await pending;
			for (let i = 0; i < 100; i++) await Promise.resolve();
			expect(w.ledger.entries(w.workloadId)).toHaveLength(count);
			expect(w.deployments()).toHaveLength(0);
			expect(ledgerFacts(w.ledger).rows("merge-inflight")).toHaveLength(0);
			expect(ledgerFacts(w.ledger).rows("deploy-merge")).toHaveLength(0);
		} finally { release(); jest.useRealTimers(); }
	});
	test("the real synchronous merge resolver is killed within the remaining total budget", async () => {
		const w = fixture({ timeoutMs: 30, defaultMergeView: true });
		const bin = tmp("deploy-merge-deadline");
		const fake = join(bin, "gh");
		// Real subprocess timeout/kill is the boundary under test; fake JS timers cannot kill it.
		writeFileSync(fake, "#!/bin/sh\nexec /bin/sleep 5\n");
		chmodSync(fake, 0o755);
		w.env.PATH = `${bin}:/usr/bin:/bin`;
		const started = performance.now();
		expect((await w.call(`gh pr merge feature/deploy -R ${REPO} --squash`)).result?.reason).toContain("E0");
		expect(performance.now() - started).toBeLessThan(2000);
		expect(w.requests()).toHaveLength(0);
		expect(ledgerFacts(w.ledger).rows("merge-inflight")).toHaveLength(0);
	});
	for (const text of [null, "other: 1\n", "deploy: [unclosed"]) test(`no parsed target retains original workflow reservation: ${text}`, async () => {
		const w = fixture();
		w.config.text = text;
		expect((await w.call()).result?.block).toBe(true);
		expect(w.requests()[0]!.body).toStartWith("gh workflow run triggers a workflow (deploy path):");
		expect(w.reads).toHaveLength(0);
	});
	test("a workflow basename without a resolved repo does not bind another repo's target", async () => {
		const w = fixture();
		await w.call("gh workflow run cicd.yml --ref main", { cwd: "/nonexistent-deploy-origin" });
		expect(w.requests()[0]!.body).toStartWith("gh workflow run triggers a workflow (deploy path):");
	});
});

describe("raw spelling and unchanged reserved rules", () => {
	for (const command of [COMMAND + " -f extra=true", COMMAND.replace("--ref main", "--ref other"), "env X=y " + COMMAND, "X=y " + COMMAND, COMMAND + " | cat", COMMAND + " && true", COMMAND + " &"]) test(`R7 non-equal spelling is not routine: ${command}`, async () => {
		const w = fixture();
		expect((await w.call(command)).result.block).toBe(true);
		expect(w.deployments()).toHaveLength(0);
	});
	for (const toolEnv of [{}, { X: "y" }]) test(`R7 bash tool env ${JSON.stringify(toolEnv)} is never routine`, async () => {
		const w = fixture();
		expect((await w.call(COMMAND, { env: toolEnv })).result.block).toBe(true);
		expect(w.deployments()).toHaveLength(0);
	});
	for (const [command, why] of [
		["vercel deploy --prod", "deploy (vercel)"], ["netlify deploy", "deploy (netlify)"], ["fly deploy", "deploy (fly)"],
		["doctl apps create-deployment x", "deploy (DigitalOcean App Platform)"], ["wrangler deploy", "deploy (wrangler)"],
		["firebase deploy", "deploy (firebase)"], ["serverless deploy", "deploy"], ["gcloud run deploy app", "deploy (gcloud)"],
		["helm upgrade app chart", "deploy (helm)"], ["kubectl apply -f app.yml", "deploy (kubectl)"], ["git push heroku main", "deploy (git push to a deploy remote)"],
		["terraform apply", "infrastructure change (apply/up)"], ["npm publish", "publishes a package"],
		["gh release create v1", "gh release publishes or destroys a release"], ["gh secret set TOKEN", "sets or deletes a GitHub Actions secret"],
		[`gh workflow run other.yml --ref main -R ${REPO}`, "gh workflow run triggers a workflow (deploy path)"],
	]) test(`R5 unchanged reservation: ${why}`, async () => {
		const w = fixture();
		expect((await w.call(command)).result.block).toBe(true);
		expect(w.requests()[0]!.body.startsWith(`${why}:`)).toBe(true);
	});
	test("other passes still reject a composed workflow plus secret mutation", async () => {
		const w = fixture();
		expect((await w.call(COMMAND + " && gh secret set TOKEN")).result.block).toBe(true);
		expect(w.requests()[0]!.body).toMatch(/^sets or deletes a GitHub Actions secret:/);
	});
	for (const role of ["hand", "orchestrator", "train", "train-fix", "nonholder"]) test(`R11 ${role} never gets routine admission`, async () => {
		const w = fixture({ role: role === "hand" || role === "orchestrator" ? role : "lane" });
		if (role === "train" || role === "train-fix") w.entry(`${role}: 1`, LANE);
		if (role === "nonholder") w.ledger.releaseWorkload(w.workloadId, { by: LANE, holder: LANE });
		expect((await w.call()).result.block).toBe(true);
		expect(w.requests()).toHaveLength(1);
		expect(w.deployments()).toHaveLength(0);
	});
});

describe("approval binding and one-time atomic consumption", () => {
	test("R10 approve once at H, consume on deploy row; settled retry cannot reuse it", async () => {
		const w = fixture({ stakes: "production" });
		await w.call();
		const request = w.requests()[0]!;
		w.decide(request.id);
		expect((await w.call()).result).toBeUndefined();
		const dp = parseDeployRow(w.deployments()[0]!.body)!;
		expect(dp.approved).toBe(request.id);
		w.entry(formatDeploySettledRow({ id: dp.id, outcome: "ok", evidence: "run 123 success" }));
		expect((await w.call()).result.block).toBe(true);
		expect(w.deployments()).toHaveLength(1);
	});
	for (const defect of ["expired", "deny", "withdrawn", "wrong-author", "wrong-writer", "wrong-channel", "wrong-holder", "wrong-workload", "policy-off", "new-instance", "moved-H", "different-command"]) test(`R10 refuses approval with ${defect}`, async () => {
		const w = fixture({ stakes: "production" });
		await w.call();
		const request = w.requests()[0]!;
		const over = defect === "wrong-author" ? { author: "lane" } : defect === "wrong-writer" ? { by: LANE } : defect === "wrong-channel" ? { channel: "direct" } : {};
		if (defect === "wrong-workload") {
			const other = w.ledger.openWorkload({ by: SURFACE_BY, brief: "other", stakes: "normal", mode: "autonomous" });
			w.ledger.recordInstruction({ workloadId: other, by: SURFACE_BY, author: "jo", channel: "surface", body: `approve ${request.id}` });
		} else w.decide(request.id, "approve", over);
		if (defect === "expired") w.clock.value = "2026-10-21T17:00:00.000Z";
		if (defect === "deny") w.decide(request.id, "deny");
		if (defect === "withdrawn") w.entry(`reserved-withdrawn: ${request.id} no longer needed`, LANE);
		if (defect === "wrong-holder") w.ledger.handoffWorkload(w.workloadId, { by: LANE, holder: LANE, to: "lane-other" });
		if (defect === "policy-off") w.entry("deploy-policy: off in-off", SURFACE_BY, STANDING_WORKLOAD_ID);
		if (defect === "new-instance") compare(w, "src/auth/new.ts");
		if (defect === "moved-H") w.answers.set(`repos/${REPO}/commits/main`, ok({ sha: OTHER }));
		const command = defect === "different-command" ? COMMAND + " -f extra=true" : COMMAND;
		expect((await w.call(command)).result.block).toBe(true);
		expect(w.deployments()).toHaveLength(0);
	});

	test("R10 replacing or adding E11 instances at unchanged H invalidates approval", async () => {
		const w = fixture();
		w.entry(formatMergeInflightRow({ token: "mt-one", repo: REPO, pr: 8 }));
		w.answers.set(`repos/${REPO}/pulls/8`, ok({ merged: false, merge_commit_sha: null }));
		await w.call();
		w.decide(w.requests()[0]!.id);
		w.entry(formatMergeInflightRow({ token: "mt-two", repo: REPO, pr: 9 }));
		w.answers.set(`repos/${REPO}/pulls/9`, ok({ merged: false, merge_commit_sha: null }));
		expect((await w.call()).result.block).toBe(true);
		expect(w.requests().at(-1)!.body).toContain("mt-two");
		expect(w.deployments()).toHaveLength(0);
	});

	for (const approved of [false, true]) test(`R21 concurrent cross-workload ${approved ? "approved" : "routine"} admits one target only`, async () => {
		const a = fixture({ stakes: approved ? "production" : "normal" });
		const b = fixture({ ledger: a.ledger, path: a.path, stakes: approved ? "production" : "normal", lane: "lane-second" });
		if (approved) { await a.call(); await b.call(); a.decide(a.requests()[0]!.id); b.decide(b.requests()[0]!.id); }
		const results = await Promise.all([a.call(), b.call()]);
		expect(results.filter((r) => r.result === undefined)).toHaveLength(1);
		expect(targetHistory(ledgerFacts(a.ledger), "web").unsettled).toHaveLength(1);
	});
});

describe("merge interlock and merge-triggered deploys", () => {
	const merge = (repo = REPO, extra = "") => `gh pr merge 7 -R ${repo} --squash${extra}`;
	test("R24 any session merge is held U2; settled row releases the freeze", async () => {
		const w = fixture();
		await w.call();
		const hand = fixture({ ledger: w.ledger, path: w.path, workloadId: w.workloadId, role: "hand" });
		expect((await hand.call(merge())).result.reason).toContain("U2");
		expect(hand.requests()).toHaveLength(0);
		const dp = parseDeployRow(w.deployments()[0]!.body)!;
		w.entry(formatDeploySettledRow({ id: dp.id, outcome: "ok", evidence: "run 1 success" }));
		const admitted = await hand.call(merge());
		expect(admitted.result).toBeUndefined();
		expect(ledgerFacts(w.ledger).rows("merge-inflight")).toHaveLength(1);
		await hand.emit("tool_result", { ...admitted.event, isError: false, details: { exitCode: 0 } });
		expect(ledgerFacts(w.ledger).rows("merge-done")[0]!.body).toMatch(/^merge-done: mt-\S+ exit 0$/);
	});

	test("R24 U2 recheck inside transaction catches deploy inserted during merge facts", async () => {
		const w = fixture({ auth: false, history: false });
		const gh = w.facts.gh;
		w.facts.gh = async (req) => {
			w.entry(formatDeployRow({ id: "dp-racer", target: "unknown", sha: H, base: null, checks: 1, warnings: [] }));
			return gh(req);
		};
		expect((await w.call(merge(CRAWLER, ` --match-head-commit ${H}`))).result.reason).toContain("U2");
		expect(w.requests()).toHaveLength(0);
	});

	test("R28 ancient merge with closed-unmerged PR remains E11; merged and contained resolves it", async () => {
		const w = fixture();
		w.entry(formatMergeInflightRow({ token: "mt-ancient", repo: REPO, pr: 7 }));
		w.clock.value = "2026-10-27T17:00:00.000Z";
		w.answers.set(`repos/${REPO}/pulls/7`, ok({ merged: false, state: "closed", merge_commit_sha: null }));
		expect((await w.call()).result.reason).toContain("E11");
		expect(w.requests()[0]!.body).toContain("mt-ancient");
		w.answers.set(`repos/${REPO}/pulls/7`, ok({ merged: true, state: "closed", merge_commit_sha: OTHER }));
		w.answers.set(`repos/${REPO}/compare/${H}...${OTHER}`, ok({ status: "behind" }));
		expect((await w.call()).result).toBeUndefined();
	});

	test("U3 admission recheck catches a merge inserted after evaluation's last read", async () => {
		const w = fixture();
		const real = w.facts.ledger;
		let mergeReads = 0;
		w.facts.ledger = { ...real, rows: (p) => {
			const rows = real.rows(p);
			if (p === "merge-done" && ++mergeReads === 2) w.entry(formatMergeInflightRow({ token: "mt-racer", repo: REPO, pr: 8 }));
			return rows;
		} };
		expect((await w.call()).result.reason).toContain("U3");
		expect(w.requests()).toHaveLength(0);
		expect(w.deployments()).toHaveLength(0);
	});

	test("R22 M1 constant survives absent policy; exact pinned command admits and consumes once", async () => {
		const w = fixture({ auth: false, history: false });
		w.config.text = null;
		const command = merge(CRAWLER, ` --match-head-commit ${H}`);
		expect((await w.call(command)).result.reason).toContain("M1");
		w.decide(w.requests()[0]!.id);
		expect((await w.call(command)).result).toBeUndefined();
		expect(ledgerFacts(w.ledger).rows("deploy-merge")).toHaveLength(1);
		expect((await w.call(command)).result.block).toBe(true);
		expect(w.deployments()).toHaveLength(0);
	});
	for (const defect of ["no-pin", "unknown-head", "moved-head"]) test(`R22 M1 cannot approve ${defect}`, async () => {
		const w = fixture({ auth: false, history: false });
		w.config.text = null;
		if (defect === "unknown-head") w.answers.delete(`repos/${CRAWLER}/pulls/7`);
		const command = merge(CRAWLER, defect === "no-pin" ? "" : ` --match-head-commit ${H}`);
		await w.call(command);
		w.decide(w.requests()[0]!.id);
		if (defect === "moved-head") w.answers.set(`repos/${CRAWLER}/pulls/7`, ok({ head: { sha: OTHER } }));
		expect((await w.call(command)).result.block).toBe(true);
		expect(ledgerFacts(w.ledger).rows("deploy-merge")).toHaveLength(0);
	});
	for (const role of ["hand", "orchestrator", "train", "train-fix", "nonholder"]) test(`M1 ${role} refusal says role-not-admissible; approval cannot help`, async () => {
		const w = fixture({ role: role === "hand" || role === "orchestrator" ? role : "lane" });
		if (role === "train" || role === "train-fix") w.entry(`${role}: 1`, LANE);
		if (role === "nonholder") w.ledger.releaseWorkload(w.workloadId, { by: LANE, holder: LANE });
		const r = await w.call(merge(CRAWLER, ` --match-head-commit ${H}`));
		expect(r.result?.reason).toContain("role-not-admissible");
		expect(r.result?.reason).toContain("approval cannot admit");
		expect(w.requests()).toHaveLength(0);
		expect(ledgerFacts(w.ledger).rows("deploy-merge")).toHaveLength(0);
	});

	test("safe numeric URL resolution and repo mismatch refusal", async () => {
		const w = fixture({ auth: false, history: false });
		w.config.text = null;
		expect((await w.call(`gh pr merge https://github.com/${CRAWLER}/pull/7 --squash`)).result.reason).toContain("M1");
		const before = w.requests().length;
		expect((await w.call(`gh pr merge https://github.com/${CRAWLER}/pull/7 -R ${REPO} --squash`)).result.reason).toContain("disagree");
		expect(w.requests()).toHaveLength(before);
	});

	for (const selector of [null, "feature/deploy"]) test(`branch/current-branch selector ${selector ?? "(omitted)"} resolves and records PR 7`, async () => {
		const w = fixture();
		const command = `gh pr merge${selector ? ` ${selector}` : ""} -R ${REPO} --squash`;
		expect((await w.call(command)).result).toBeUndefined();
		expect(w.views).toEqual([{ selector, repo: REPO }]);
		expect(parseMergeInflightRow(ledgerFacts(w.ledger).rows("merge-inflight")[0]!.body)).toMatchObject({ repo: REPO, pr: 7 });
	});

	test("branch selector cannot bypass crawler M1 or unresolved/mismatched view facts", async () => {
		const w = fixture({ auth: false, history: false });
		w.config.text = null;
		expect((await w.call(`gh pr merge feature/crawler -R ${CRAWLER} --squash`)).result?.reason).toContain("M1");
		expect(w.views).toEqual([{ selector: "feature/crawler", repo: CRAWLER }]);
		for (const answer of [{ ok: false, error: "view failed", notFound: false }, ok({ number: 7, headRefOid: H }), ok({ number: 7, headRefOid: H, url: `https://github.com/${REPO}/pull/7` })] as GhResult[]) {
			w.viewState.answer = answer;
			const before = w.requests().length;
			expect((await w.call(`gh pr merge feature/crawler -R ${CRAWLER} --squash`)).result?.block).toBe(true);
			expect(w.requests()).toHaveLength(before);
		}
	});

	test("bare gh pr merge resolves current branch against a verified GitHub origin", async () => {
		const { work } = repoWithOrigin();
		git(work, "remote", "set-url", "origin", `https://github.com/${REPO}.git`);
		const w = fixture();
		expect((await w.call("gh pr merge --squash", { cwd: work })).result).toBeUndefined();
		expect(w.views).toEqual([{ selector: null, repo: REPO }]);
		expect(parseMergeInflightRow(ledgerFacts(w.ledger).rows("merge-inflight")[0]!.body)).toMatchObject({ repo: REPO, pr: 7 });
	});

	test("a policy changed while merge facts are read cannot silently add M1 after its evaluation", async () => {
		const w = fixture();
		let changed = false;
		w.facts.config = () => {
			const before = w.config.text;
			if (!changed) {
				changed = true;
				w.policy.mergeTriggered.push(REPO);
				w.config.text = Bun.YAML.stringify({ deploy: w.policy }, null, 2);
				w.accept();
			}
			return before;
		};
		expect((await w.call(`gh pr merge 7 -R ${REPO} --squash`)).result?.reason).toContain("E0");
		expect(w.requests()).toHaveLength(0);
		expect(ledgerFacts(w.ledger).rows("merge-inflight")).toHaveLength(0);
	});
});

describe("dispatch evidence is not settlement", () => {
	test("R25 URL from tool content records run; failed dispatch records exit and remains unsettled", async () => {
		for (const failed of [false, true]) {
			const w = fixture();
			const admitted = await w.call();
			await w.emit("tool_result", { ...admitted.event, isError: failed, details: { exitCode: failed ? 1 : 0 }, content: [{ type: "text", text: failed ? "failed to get dispatch response" : `https://github.com/${REPO}/actions/runs/123` }] });
			const dp = parseDeployRow(w.deployments()[0]!.body)!;
			expect(parseDeployRunRow(ledgerFacts(w.ledger).rows("deploy-run")[0]!.body)).toEqual(failed ? { id: dp.id, exit: 1 } : { id: dp.id, runId: "123", url: `https://github.com/${REPO}/actions/runs/123` });
			expect(targetHistory(ledgerFacts(w.ledger), "web").unsettled).toEqual([dp.id]);
			expect(ledgerFacts(w.ledger).rows("deploy-settled")).toHaveLength(1);
		}
	});

	test("background merge is not recorded done; unadmitted results write nothing", async () => {
		const w = fixture();
		const admitted = await w.call(`gh pr merge 7 -R ${REPO} --squash`);
		await w.emit("tool_result", { ...admitted.event, isError: false, details: { async: { state: "running", jobId: "bg_1" } } });
		expect(ledgerFacts(w.ledger).rows("merge-done")).toHaveLength(0);
		await w.emit("tool_result", { ...w.event(), isError: false, details: { runId: 42 } });
		expect(ledgerFacts(w.ledger).rows("deploy-run")).toHaveLength(0);
	});

	test("shipped-sha evaluation uses the shared engine, ignores only its deploy, reads H2 predicates", async () => {
		const w = fixture();
		await w.call();
		const dp = parseDeployRow(w.deployments()[0]!.body)!;
		for (const [key, value] of [...w.answers]) if (key.includes(H)) w.answers.set(key.replaceAll(H, OTHER), value);
		w.answers.set(`repos/${REPO}/compare/${B}...${OTHER}?per_page=100`, ok([{ total_commits: 1, commits: [{}], files: [{ filename: "db/migrations/new.sql", status: "modified", additions: 1, deletions: 0 }] }]));
		const v = await evaluateShippedDeploy({ workloadId: w.workloadId, target: "web", sha: OTHER, deployId: dp.id }, w.facts);
		expect(v.kind).toBe("verdict");
		if (v.kind !== "verdict") throw new Error("expected verdict");
		expect(v.head).toBe(OTHER);
		expect(v.ids).toEqual(["E4"]);
		expect(gateSession(w.ctx, w.env).role).toBe("lane");
	});
});
