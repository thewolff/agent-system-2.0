#!/usr/bin/env bun
// `as2 deploy settle <dp>` (SPEC-2.0.md § A4): read evidence, never dispatch or roll back.
// A settle and its one notice commit together. Repeated/concurrent callers recheck in Ledger.write.
import { defaultLedgerPath, Ledger } from "../../ledger/src/index";
import {
	defaultFacts, evaluateShippedDeploy, formatDeploySettledRow, ledgerFacts, parseDeployRow, parseDeployRunRow,
	parseDeploySettledRow, policyAuth, type DeployFacts, type DeploySettledRecord,
} from "../../gates/src/deploy-risk";
import { sendNotice } from "../src/notice";
import { DEPLOY_BY } from "../src/types";

export interface SettleResult { code: number; line: string }
export interface SettleOptions {
	facts?: DeployFacts;
	/** Synchronous enqueue, inside the settlement transaction; an enqueue failure rolls both writes back. */
	notice?: (ledger: Ledger, input: { by: string; workloadId: string; body: string }) => string;
}
const USAGE = "usage: as2 deploy settle <dp-id>";
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function string(v: unknown, field: string): string {
	if (typeof v !== "string" || !v) throw new Error(`unreadable run field ${field}`);
	return v;
}
function positiveId(v: unknown): string {
	if ((typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) && (typeof v !== "string" || !/^[1-9]\d*$/.test(v))) throw new Error("unreadable run id");
	return String(v);
}
function pageItems(json: unknown, key: string): unknown[] {
	if (!Array.isArray(json) || json.length === 0) throw new Error(`incomplete ${key} pagination`);
	const all: unknown[] = [];
	let total = 0;
	for (const page of json) {
		if (!object(page) || !Array.isArray(page[key]) || !Number.isSafeInteger(page.total_count) || (page.total_count as number) < 0) throw new Error(`unreadable ${key} page`);
		total = Math.max(total, page.total_count as number);
		all.push(...page[key] as unknown[]);
	}
	if (all.length < total) throw new Error(`incomplete ${key} pagination (${all.length}/${total})`);
	return all;
}
function settled(ledger: Ledger, id: string): DeploySettledRecord | undefined {
	return ledgerFacts(ledger).rows("deploy-settled").map((r) => parseDeploySettledRow(r.body)).find((r) => r?.id === id) ?? undefined;
}
const replay = (s: DeploySettledRecord): SettleResult => ({ code: s.outcome === "ok" ? 0 : 1, line: `deploy ${s.id} already settled ${s.outcome}: ${s.evidence}` });

/** Any lane can settle any trusted deploy; only GitHub/run/health facts decide the outcome. */
export async function settleDeploy(ledger: Ledger, id: string, options: SettleOptions = {}): Promise<SettleResult> {
	if (!/^dp-[A-Za-z0-9-]+$/.test(id)) return { code: 1, line: USAGE };
	const already = settled(ledger, id);
	if (already) return replay(already);
	const rows = ledgerFacts(ledger).rows("deploy").filter((r) => parseDeployRow(r.body)?.id === id);
	if (rows.length !== 1) return { code: 1, line: `deploy ${id}: ${rows.length ? "ambiguous" : "no trusted"} deploy row` };
	const row = rows[0]!;
	const deploy = parseDeployRow(row.body)!;
	const facts = options.facts ?? defaultFacts(ledger);
	try {
		const auth = policyAuth(facts);
		const target = auth.policy?.targets.find((t) => t.name === deploy.target);
		if (!target) throw new Error(auth.problem ?? `target ${deploy.target} unavailable in installed policy`);
		if (!auth.authenticated) throw new Error(auth.problem ?? "deploy policy is not authenticated");
		const request = async (path: string, paginate = false) => {
			const result = await facts.gh({ kind: "rest", path, paginate });
			if (!result.ok) throw new Error(result.error);
			return result.json;
		};
		const finish = (outcome: "ok" | "failed", evidence: string, extra = ""): SettleResult => ledger.write(() => {
			const existing = settled(ledger, id);
			if (existing) return replay(existing);
			const warnings = deploy.warnings.length ? `; warn ${deploy.warnings.map((w) => `${w.id}${w.facts.length ? ` ${w.facts.join(", ")}` : ""}`).join("; ")}` : "";
			const body = outcome === "ok"
				? `deployed ${deploy.target} ${deploy.sha.slice(0, 7)} (${row.workloadId}): ${evidence}, ${deploy.checks} checks green${warnings}${extra}`
				: `deploy FAILED ${deploy.target} ${deploy.sha.slice(0, 7)} (${row.workloadId}): ${evidence}${extra}${warnings}; rollback: ${target.rollback ?? "not declared"}`;
			ledger.recordEntry({ by: DEPLOY_BY, workloadId: row.workloadId, kind: "assumption", body: formatDeploySettledRow({ id, outcome, evidence: `${evidence}${extra}` }) });
			(options.notice ?? sendNotice)(ledger, { by: DEPLOY_BY, workloadId: row.workloadId, body });
			return { code: outcome === "ok" ? 0 : 1, line: body };
		});
		const own = ledgerFacts(ledger).rows("deploy-run").map((r) => parseDeployRunRow(r.body)).findLast((r) => r?.id === id && r.runId !== undefined);
		let runId = own?.runId;
		if (!runId) {
			const start = Date.parse(row.createdAt);
			if (!Number.isFinite(start)) throw new Error("unreadable deploy timestamp");
			const end = start + 120_000;
			const created = encodeURIComponent(`${new Date(start).toISOString()}..${new Date(end).toISOString()}`);
			const json = await request(`repos/${target.repo}/actions/workflows/${target.file}/runs?event=workflow_dispatch&created=${created}&per_page=100`, true);
			const candidates = new Set<string>();
			for (const item of pageItems(json, "workflow_runs")) {
				if (!object(item)) throw new Error("unreadable workflow run");
				const event = string(item.event, "event");
				const created = Date.parse(string(item.created_at, "created_at"));
				if (!Number.isFinite(created)) throw new Error("unreadable run created_at");
				if (event === "workflow_dispatch" && created >= start && created <= start + 120_000) candidates.add(positiveId(item.id));
			}
			if (candidates.size > 1) return finish("failed", `ambiguous-run ${[...candidates].join(",")}`);
			if (candidates.size === 0) {
				if (facts.now().getTime() - start < 600_000) return { code: 1, line: `deploy ${id}: not dispatched yet; still unsettled, retry ${USAGE.slice(7).replace("<dp-id>", id)}` };
				return finish("failed", "not-dispatched (no workflow_dispatch run within 120s)");
			}
			runId = [...candidates][0]!;
		}
		const run = await request(`repos/${target.repo}/actions/runs/${runId}`);
		if (!object(run) || positiveId(run.id) !== runId) throw new Error("unreadable bound run");
		if (string(run.event, "event") !== "workflow_dispatch" || string(run.path, "path").split("@")[0] !== `.github/workflows/${target.file}`) throw new Error("bound run is not the declared workflow_dispatch workflow");
		if (string(run.status, "status") !== "completed") return { code: 1, line: `deploy ${id}: run ${runId} still running; unsettled` };
		const head = string(run.head_sha, "head_sha");
		if (!/^[a-f0-9]{40}$/i.test(head)) throw new Error("unreadable run head_sha");
		const conclusion = string(run.conclusion, "conclusion");
		if (head !== deploy.sha) {
			const shipped = await evaluateShippedDeploy({ workloadId: row.workloadId, target: deploy.target, sha: head, deployId: id }, facts);
			const conditions = shipped.kind === "verdict" ? [...shipped.conditions, ...shipped.warnings].map((c) => `${c.id}${c.facts.length ? ` ${c.facts.join(", ")}` : ""}`).join("; ") || "none" : "E0 shipped target unavailable";
			return finish("failed", `shipped-unevaluated run ${runId} ${conclusion} shipped ${head} expected ${deploy.sha}`, `; shipped conditions: ${conditions}`);
		}
		if (conclusion !== "success") return finish("failed", `run ${runId} ${conclusion}`);
		const jobs = pageItems(await request(`repos/${target.repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`, true), "jobs");
		const deployed = jobs.filter((j) => object(j) && j.name === target.deployJob);
		if (deployed.length !== 1 || !object(deployed[0]) || deployed[0].status !== "completed" || deployed[0].conclusion !== "success") return finish("failed", `run ${runId} success, deployJob ${target.deployJob} ${deployed.length === 1 && object(deployed[0]) ? String(deployed[0].conclusion) : "missing or ambiguous"}`);
		const health = await facts.httpsGet(target.health.url);
		if (!health.ok || health.status !== target.health.status) return finish("failed", `run ${runId} success, health ${health.ok ? health.status : health.error}`);
		return finish("ok", `run ${runId} success, health ${health.status}`);
	} catch (err) {
		return { code: 1, line: `deploy ${id}: ${err instanceof Error ? err.message : String(err)}; remains unsettled` };
	}
}

export async function main(argv: string[]): Promise<number> {
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) { console.log(USAGE); return 0; }
	if (argv.length !== 2 || argv[0] !== "settle" || !/^dp-[A-Za-z0-9-]+$/.test(argv[1]!)) { console.error(USAGE); return 1; }
	let ledger: Ledger;
	try { ledger = Ledger.open(defaultLedgerPath(process.env)); }
	catch (err) { console.error(`as2 deploy: could not open ledger (${err instanceof Error ? err.message : String(err)})`); return 2; }
	try {
		const result = await settleDeploy(ledger, argv[1]!);
		(result.code === 0 ? console.log : console.error)(result.line);
		return result.code;
	} finally { ledger.close(); }
}
if (import.meta.main) process.exit(await main(process.argv.slice(2)));
