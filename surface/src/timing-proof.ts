// Finite proof-only transport. This store never writes test-requested/test-run or settles a slice.
// Structure finding: runs.db lock/queue owns execution; its main_pending is rebuildable, whereas
// proof manifests and interrupted attempts are evidence and must survive restart. Two proof-only
// tables in that SAME database keep immutable inputs and append-only iteration identities.
// Structure finding (TOOLS-REVIEW-r1 F4): a commit SHA is not the executed input. timing_proofs.inputs keeps the executable
// identity submission computed from the trees fetched from the served origin and the installed executor, so a failed input
// cannot come back under an empty commit, decision-log churn or a new diagnosis string.
import { spawn, type Subprocess } from "bun";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { RESOURCE_POLICY } from "./as2test";
import { procArgv, snapshot } from "./stuck-detect";
import { HEARTBEAT_STALE_MS, isBunTestFile, junitCases, lockHolderStale, parseHeartbeat, type PartResult, runDirOf, SHA_RE, STARTUP_LEASE_MS } from "./test-run";

export type ProofPhase = "base" | "candidate";
export interface ProofFile {
	path: string;
	cases: { base: string[]; candidate: string[]; budgetMs: number; timingUnderTest: boolean }[];
	hooks: Record<ProofPhase, { setup: string[]; cleanup: string[] }>;
	skipped: Record<ProofPhase, string[]>;
}
export interface ProofManifest {
	version: 1;
	kind: "file-series" | "full-series" | "smoke";
	workload: string;
	slice: string;
	repo: string;
	baseSha: string;
	candidateSha: string;
	mode: "isolated" | "installed-OMP";
	productionBudget: boolean;
	load: "none" | "historic";
	runs: { base: number; candidate: number };
	files: ProofFile[];
	/** Required to submit another series after a diagnosed failed input: not permission to retry it. */
	diagnosis?: string;
}
export interface ProofStep { index: number; phase: ProofPhase; file: string | null; sha: string }
export interface ProofIteration extends ProofStep {
	runId: string; requestedAt: number; state: "running" | "complete" | "failed" | "interrupted";
	error: string | null; artifacts: string | null;
}
export interface ProofRecord {
	id: string; requestedAt: number; manifest: ProofManifest; inputs: ProofInputs; state: "admitted" | "running" | "failed" | "complete";
	error: string | null; iterations: ProofIteration[];
}
const object = (v: unknown, label: string): Record<string, unknown> => {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${label}: expected object`);
	return v as Record<string, unknown>;
};
function keys(v: Record<string, unknown>, allowed: string[], label: string): void {
	for (const key of Object.keys(v)) if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}; commands, environment, runtime paths and carried results are not admitted`);
}
function text(v: unknown, label: string): string {
	if (typeof v !== "string" || !v.trim() || v.length > 4096 || /[\r\n\x00]/.test(v)) throw new Error(`${label}: expected nonempty single-line string`);
	return v;
}
function labels(v: unknown, label: string): string[] {
	if (!Array.isArray(v)) throw new Error(`${label}: expected list`);
	const out = v.map((x) => text(x, label));
	if (new Set(out).size !== out.length) throw new Error(`${label}: duplicate identity`);
	return out;
}
export function parseProofManifest(value: unknown): ProofManifest {
	const v = object(value, "timing-proof manifest");
	keys(v, ["version", "kind", "workload", "slice", "repo", "baseSha", "candidateSha", "mode", "productionBudget", "load", "runs", "files", "diagnosis"], "timing-proof manifest");
	if (v.version !== 1 || !["file-series", "full-series", "smoke"].includes(String(v.kind))) throw new Error("timing-proof manifest: version/kind not admitted");
	const kind = v.kind as ProofManifest["kind"];
	const workload = text(v.workload, "workload"), slice = text(v.slice, "slice"), repo = text(v.repo, "repo");
	if (!/^wl-[a-z0-9-]+$/.test(workload) || !/^sl-[a-zA-Z0-9-]+$/.test(slice) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("timing-proof manifest: malformed workload, slice or served owner/repo");
	if (typeof v.baseSha !== "string" || !SHA_RE.test(v.baseSha) || typeof v.candidateSha !== "string" || !SHA_RE.test(v.candidateSha)) throw new Error("timing-proof manifest: baseSha and candidateSha must be pinned full commit SHAs");
	if (v.mode !== "isolated" && v.mode !== "installed-OMP") throw new Error("timing-proof manifest: invalid mode");
	if (typeof v.productionBudget !== "boolean") throw new Error("timing-proof manifest: productionBudget must be boolean");
	if (v.load !== "none" && v.load !== "historic") throw new Error("timing-proof manifest: load must be none or historic");
	if (kind === "file-series" && v.load !== "historic") throw new Error("file-series: historical load recipe is required");
	const r = object(v.runs, "runs"); keys(r, ["base", "candidate"], "runs");
	const counts = kind === "file-series" ? [5, 20] : kind === "full-series" ? [0, 5] : [0, 2];
	if (r.base !== counts[0] || r.candidate !== counts[1]) throw new Error(`${kind}: requires exactly ${counts[0]} base and ${counts[1]} candidate runs`);
	if (!Array.isArray(v.files) || v.files.length === 0 || v.files.length > 10_000) throw new Error("timing-proof manifest: files must be a nonempty bounded list");
	const files = v.files.map((raw): ProofFile => {
		const f = object(raw, "file"); keys(f, ["path", "cases", "hooks", "skipped"], "file");
		const path = text(f.path, "file.path");
		if (isAbsolute(path) || !/^[A-Za-z0-9_./-]+$/.test(path) || path.split("/").some((p) => !p || p === "." || p === ".." || p.startsWith("-")) || !isBunTestFile(path)) throw new Error(`file.path: ${path} is not an explicit repo-relative test file`);
		if (!Array.isArray(f.cases) || f.cases.length === 0) throw new Error(`${path}: expected case mappings`);
		const cases = f.cases.map((raw) => {
			const c = object(raw, `${path} case`); keys(c, ["base", "candidate", "budgetMs", "timingUnderTest"], `${path} case`);
			const base = labels(c.base, `${path} base cases`), candidate = labels(c.candidate, `${path} candidate cases`);
			if (!base.length || !candidate.length || typeof c.budgetMs !== "number" || !Number.isFinite(c.budgetMs) || c.budgetMs <= 0 || typeof c.timingUnderTest !== "boolean") throw new Error(`${path}: mapping needs base/candidate identities and unchanged positive budgetMs/timingUnderTest`);
			return { base, candidate, budgetMs: c.budgetMs, timingUnderTest: c.timingUnderTest };
		});
		const hooks = object(f.hooks, `${path} hooks`), skipped = object(f.skipped, `${path} skipped`);
		keys(hooks, ["base", "candidate"], `${path} hooks`); keys(skipped, ["base", "candidate"], `${path} skipped`);
		const out = { path, cases, hooks: {} as ProofFile["hooks"], skipped: {} as ProofFile["skipped"] };
		for (const phase of ["base", "candidate"] as const) {
			const h = object(hooks[phase], `${path} ${phase} hooks`); keys(h, ["setup", "cleanup"], `${path} hooks`);
			out.hooks[phase] = { setup: labels(h.setup, `${path} setup`), cleanup: labels(h.cleanup, `${path} cleanup`) };
			out.skipped[phase] = labels(skipped[phase], `${path} skipped`);
			const identities = cases.flatMap((c) => c[phase]).concat(out.skipped[phase]);
			if (new Set(identities).size !== identities.length) throw new Error(`${path} ${phase}: duplicate case mapping`);
		}
		if (out.skipped.candidate.some((s) => !out.skipped.base.includes(s))) throw new Error(`${path}: new skipped case is forbidden`);
		return out;
	});
	if (new Set(files.map((f) => f.path)).size !== files.length) throw new Error("timing-proof manifest: duplicate file");
	if (kind === "smoke" && (files.length !== 1 || v.load !== "none")) throw new Error("smoke: exactly one safe file and no load; smoke never constitutes completion proof");
	return { version: 1, kind, workload, slice, repo, baseSha: v.baseSha, candidateSha: v.candidateSha, mode: v.mode, productionBudget: v.productionBudget, load: v.load, runs: { base: r.base as number, candidate: r.candidate as number }, files, ...(v.diagnosis === undefined ? {} : { diagnosis: text(v.diagnosis, "diagnosis") }) };
}
export function proofIterations(m: ProofManifest): ProofStep[] {
	const out: ProofStep[] = [];
	for (const f of m.kind === "full-series" ? [null] : m.files.map((f) => f.path)) {
		for (const phase of ["base", "candidate"] as const) for (let i = 0; i < m.runs[phase]; i++) out.push({ index: out.length, phase, file: f, sha: phase === "base" ? m.baseSha : m.candidateSha });
	}
	return out;
}
export function proofEvidence(m: ProofManifest, step: Pick<ProofStep, "phase" | "file">, xml: string, log: string) {
	const cases = junitCases(xml);
	const selected = m.files.filter((f) => step.file === null || f.path === step.file);
	const expected = new Set<string>();
	const markers: string[] = [];
	const byIdentity = new Map<string, (typeof cases)[number]>();
	for (const c of cases) {
		const key = `${c.file} > ${c.name}`;
		if (byIdentity.has(key)) throw new Error(`${key}: duplicate JUnit case`);
		byIdentity.set(key, c);
	}
	const logLines = new Map<string, number>();
	for (const line of log.split(/\r?\n/)) logLines.set(line, (logLines.get(line) ?? 0) + 1);
	for (const f of selected) {
		for (const c of f.cases) for (const name of c[step.phase]) {
			const key = `${f.path} > ${name}`; expected.add(key);
			const found = byIdentity.get(key);
			if (!found || found.status === "skip") throw new Error(`${key}: expected exactly one EXECUTED case (${found?.status ?? "missing"})`);
			if (step.phase === "candidate" && found.status !== "pass") throw new Error(`${key}: candidate case failed`);
			const max = c.budgetMs * (c.timingUnderTest ? 1 : 0.5);
			if (step.phase === "candidate" && found.ms > max) throw new Error(`${key}: ${found.ms}ms exceeds ${max}ms of unchanged budget ${c.budgetMs}ms`);
		}
		for (const name of f.skipped[step.phase]) {
			expected.add(`${f.path} > ${name}`);
			if (byIdentity.get(`${f.path} > ${name}`)?.status !== "skip") throw new Error(`${f.path} > ${name}: frozen skipped case changed`);
		}
		for (const hook of ["setup", "cleanup"] as const) for (const name of f.hooks[step.phase][hook]) {
			const marker = `timing-proof ${hook} ${f.path} ${name}`;
			if (logLines.get(marker) !== 1) throw new Error(`${f.path}: missing/duplicate ${hook} evidence ${JSON.stringify(marker)}`);
			markers.push(marker);
		}
	}
	for (const key of byIdentity.keys()) if (!expected.has(key)) throw new Error(`${key}: unexpected JUnit case`);
	return { cases, markers };
}
/**
 * Tracked paths the suite and the product never execute or read: decision-log entries are written by closes and read by no
 * test (TOOLS-REVIEW-r1 F4). Every other path, documentation included, stays an executable input, since tests read docs.
 */
export const NON_EXECUTABLE_PREFIXES: readonly string[] = [".ai/decision-log/"];
/** One fetched commit and its executable identity (`executableTree`). */
export interface TreeIdentity { sha: string; tree: string }
/** What a series executes, as submission established it: both fetched trees and the installed executor it runs under. */
export interface ProofInputs {
	base: TreeIdentity;
	candidate: TreeIdentity;
	runtime: { mode: ProofManifest["mode"]; executor: Record<string, string>; identity: string };
}
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The executable identity of `git ls-tree -r -z --full-tree <sha>` output: mode, type, object id and path of every entry
 * (dependency manifests, lockfiles and submodule commits included), sorted by path, minus NON_EXECUTABLE_PREFIXES. An empty
 * commit therefore has its parent's identity, and so does a commit that only adds decision-log entries.
 */
export function executableTree(listing: string): string {
	const entries = listing.split("\0").filter(Boolean).map((line) => {
		const m = /^(\d{6}) (blob|commit|tree) ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/s.exec(line);
		if (!m) throw new Error(`timing-proof executable identity: malformed ls-tree entry ${JSON.stringify(line.slice(0, 120))}`);
		return { line: `${m[1]} ${m[2]} ${m[3]}\t${m[4]}`, path: m[4]! };
	}).filter((e) => !NON_EXECUTABLE_PREFIXES.some((p) => e.path.startsWith(p)));
	if (entries.length === 0) throw new Error("timing-proof executable identity: the fetched tree holds no executable input");
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return sha256(entries.map((e) => e.line).join("\0"));
}
/**
 * The installed files under the install's libexec a proof's runtime identity hashes (TOOLS-REVIEW r2 R4): what a part runs under
 * or is admitted by. `exec`, `bun` and `test-exec.js` run it; `resources.json`, which every part requires, decides its workers.
 * The refresh helper is left out on purpose: it runs no test and only rebuilds `exec` and `test-exec.js`, both hashed here, so a
 * helper-only change is no changed input and opens no route past a failed series.
 */
export const PROOF_RUNTIME_FILES = ["exec", "bun", "test-exec.js", RESOURCE_POLICY] as const;
/** The pinned OMP runtime (root, tree sha-256, version): hashed whenever installed, so a re-pin is a new identity; an installed-OMP proof requires it. */
export const PROOF_OMP_PIN = "installed-omp.json";
/** The sha-256 of each PROOF_RUNTIME_FILES file and, when installed, PROOF_OMP_PIN; every unreadable file is named in one error. */
export function installedRuntimeHashes(libexec: string, mode: ProofManifest["mode"]): Record<string, string> {
	const out: Record<string, string> = {};
	const errors: string[] = [];
	const hash = (name: string, required: boolean): void => {
		const path = join(libexec, name);
		try { out[name] = createHash("sha256").update(readFileSync(path)).digest("hex"); }
		catch (error) {
			if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return;
			errors.push(`installed ${path} ${(error as NodeJS.ErrnoException).code === "ENOENT" ? `is missing${name === PROOF_OMP_PIN ? " (an installed-OMP proof runs only on a pinned runtime)" : ""}` : `is unreadable: ${errText(error)}`}`);
		}
	};
	for (const name of PROOF_RUNTIME_FILES) hash(name, true);
	hash(PROOF_OMP_PIN, mode === "installed-OMP");
	if (errors.length) throw new Error(`timing-proof runtime identity: ${errors.join("; ")}; repair the install with install/as2test-setup.sh before submitting`);
	return out;
}
/** The runtime half of the identity: the proof mode and the sha-256 of each installed executor file it runs under. */
export function runtimeIdentity(mode: ProofManifest["mode"], executor: Record<string, string>): ProofInputs["runtime"] {
	const names = Object.keys(executor).sort();
	if (names.length === 0 || names.some((n) => !HEX64.test(executor[n]!))) throw new Error("timing-proof runtime identity: every installed executor file needs a sha-256");
	const sorted = Object.fromEntries(names.map((n) => [n, executor[n]!]));
	return { mode, executor: sorted, identity: sha256(JSON.stringify({ mode, executor: sorted })) };
}
function checkInputs(v: ProofInputs | null | undefined, id: string): ProofInputs {
	const tree = (t: TreeIdentity | undefined) => !!t && typeof t.sha === "string" && SHA_RE.test(t.sha) && typeof t.tree === "string" && HEX64.test(t.tree);
	if (!v || !tree(v.base) || !tree(v.candidate) || !v.runtime || !HEX64.test(String(v.runtime.identity))) throw new Error(`timing-proof ${id}: executable inputs are malformed; inspect runs.db timing_proofs.inputs`);
	return v;
}

export function openProofSchema(db: Database): void {
	db.exec("CREATE TABLE IF NOT EXISTS timing_proofs (id TEXT PRIMARY KEY, requestedAt INTEGER NOT NULL, fingerprint TEXT NOT NULL, manifest TEXT NOT NULL, inputs TEXT NOT NULL, state TEXT NOT NULL, error TEXT)");
	db.exec("CREATE TABLE IF NOT EXISTS timing_proof_iterations (seriesId TEXT NOT NULL REFERENCES timing_proofs(id), idx INTEGER NOT NULL, runId TEXT UNIQUE NOT NULL, requestedAt INTEGER NOT NULL, step TEXT NOT NULL, state TEXT NOT NULL, error TEXT, artifacts TEXT, PRIMARY KEY(seriesId, idx))");
}
export function inspectProof(db: Database, id: string): ProofRecord {
	const row = db.query<{ id: string; requestedAt: number; manifest: string; inputs: string; state: ProofRecord["state"]; error: string | null }, [string]>("SELECT id, requestedAt, manifest, inputs, state, error FROM timing_proofs WHERE id = ?").get(id);
	if (!row) throw new Error(`timing-proof ${id}: no submitted series in runs.db`);
	const iterations = db.query<{ idx: number; runId: string; requestedAt: number; step: string; state: ProofIteration["state"]; error: string | null; artifacts: string | null }, [string]>("SELECT * FROM timing_proof_iterations WHERE seriesId = ? ORDER BY idx").all(id).map((i) => ({ ...JSON.parse(i.step), runId: i.runId, requestedAt: i.requestedAt, state: i.state, error: i.error, artifacts: i.artifacts }));
	return { ...row, manifest: parseProofManifest(JSON.parse(row.manifest)), inputs: checkInputs(JSON.parse(row.inputs) as ProofInputs, id), iterations };
}
/**
 * Admit a series with the executable inputs submission computed. A failed series on an overlapping file of the same repo
 * refuses: the same candidate SHA (whatever budgets, labels, workload or diagnosis changed), and an EQUIVALENT candidate, the
 * same executable tree under the same runtime however its commit differs (an empty commit, decision-log churn). A changed
 * input still needs a diagnosis naming the cause. A diagnosis is never authority by itself: an infrastructure-only failure
 * with no changed executable input has no route through this function.
 */
export function admitProof(db: Database, id: string, manifest: ProofManifest, inputs: ProofInputs, at: number): void {
	checkInputs(inputs, id);
	if (inputs.base.sha !== manifest.baseSha || inputs.candidate.sha !== manifest.candidateSha || inputs.runtime.mode !== manifest.mode) {
		throw new Error(`timing-proof ${id}: executable inputs describe ${inputs.base.sha}/${inputs.candidate.sha} ${inputs.runtime.mode}, not the manifest's ${manifest.baseSha}/${manifest.candidateSha} ${manifest.mode}`);
	}
	const { diagnosis: _diagnosis, ...intent } = manifest;
	const fingerprint = sha256(JSON.stringify(intent));
	db.transaction(() => {
		const old = db.query<{ id: string }, [string]>("SELECT id FROM timing_proofs WHERE fingerprint = ? LIMIT 1").get(fingerprint);
		if (old) throw new Error(`timing-proof ${id}: same immutable inputs already submitted as ${old.id}; inspect it, never retry until green`);
		const prior = db.query<{ id: string; manifest: string; inputs: string }, []>("SELECT id, manifest, inputs FROM timing_proofs WHERE state = 'failed'").all()
			.map((r) => ({ id: r.id, manifest: JSON.parse(r.manifest) as ProofManifest, inputs: checkInputs(JSON.parse(r.inputs) as ProofInputs, r.id) }))
			.filter((p) => p.manifest.repo.toLowerCase() === manifest.repo.toLowerCase() && p.manifest.files.some((f) => manifest.files.some((x) => x.path === f.path)));
		const unchanged = prior.find((p) => p.manifest.candidateSha === manifest.candidateSha);
		if (unchanged) throw new Error(`timing-proof ${id}: failed candidate ${manifest.candidateSha} already observed in ${unchanged.id}; changing budgets, labels, diagnosis or workload is not a fix`);
		const equivalent = prior.find((p) => p.inputs.candidate.tree === inputs.candidate.tree && p.inputs.runtime.identity === inputs.runtime.identity);
		if (equivalent) {
			throw new Error(`timing-proof ${id}: candidate ${manifest.candidateSha} executes the same inputs as failed ${equivalent.id} at ${equivalent.manifest.candidateSha} (executable tree ${inputs.candidate.tree}, runtime ${inputs.runtime.identity} over ${Object.keys(inputs.runtime.executor).join(", ")}); an empty commit, decision-log churn or a diagnosis is not a fix: change the code, dependencies or installed runtime (${[...PROOF_RUNTIME_FILES, PROOF_OMP_PIN].join(", ")}) the failure diagnosed`);
		}
		if (prior.length && !manifest.diagnosis) throw new Error(`timing-proof ${id}: prior red ${prior[0]!.id} requires a diagnosis and changed executable inputs`);
		db.query("INSERT INTO timing_proofs (id, requestedAt, fingerprint, manifest, inputs, state) VALUES (?, ?, ?, ?, ?, 'admitted')").run(id, at, fingerprint, JSON.stringify(manifest), JSON.stringify(inputs));
	}).immediate();
}
export function nextProofIteration(db: Database, id: string, runId: string, at: number, artifacts: string | null = null): ProofIteration | null {
	return db.transaction(() => {
		const p = inspectProof(db, id);
		if (p.state === "failed" || p.state === "complete") return null;
		if (p.iterations.some((i) => i.state === "running")) throw new Error(`timing-proof ${id}: an iteration is already running; inspect/recover it, do not replay`);
		const step = proofIterations(p.manifest)[p.iterations.length];
		if (!step) throw new Error(`timing-proof ${id}: missing terminal transition`);
		db.query("INSERT INTO timing_proof_iterations (seriesId, idx, runId, requestedAt, step, state, artifacts) VALUES (?, ?, ?, ?, ?, 'running', ?)").run(id, step.index, runId, at, JSON.stringify(step), artifacts);
		db.query("UPDATE timing_proofs SET state = 'running' WHERE id = ?").run(id);
		return { ...step, runId, requestedAt: at, state: "running", error: null, artifacts };
	}).immediate();
}
export function finishProofIteration(db: Database, id: string, index: number, result: Pick<ProofIteration, "state" | "error" | "artifacts">): void {
	db.transaction(() => {
		if (result.state === "running") throw new Error(`timing-proof ${id}: cannot finish as running`);
		const changed = db.query("UPDATE timing_proof_iterations SET state = ?, error = ?, artifacts = ? WHERE seriesId = ? AND idx = ? AND state = 'running'").run(result.state, result.error, result.artifacts, id, index).changes;
		if (changed !== 1) throw new Error(`timing-proof ${id}/${index}: attempt already terminal or absent; evidence cannot be overwritten`);
		const p = inspectProof(db, id);
		const state = result.state !== "complete" ? "failed" : p.iterations.length === proofIterations(p.manifest).length ? "complete" : "admitted";
		db.query("UPDATE timing_proofs SET state = ?, error = ? WHERE id = ?").run(state, result.error, id);
	}).immediate();
}
export function failProof(db: Database, id: string, reason: string): void {
	db.query("UPDATE timing_proofs SET state = 'failed', error = ? WHERE id = ? AND state IN ('admitted', 'running')").run(reason, id);
}
export function recoverProof(db: Database, id: string, live: (runId: string, requestedAt: number) => boolean): ProofRecord {
	const p = inspectProof(db, id);
	if (p.state === "running") {
		const i = p.iterations.find((i) => i.state === "running");
		if (i && !live(i.runId, i.requestedAt)) finishProofIteration(db, id, i.index, { state: "interrupted", error: `timing-proof ${id}/${i.index} ${i.file ?? "full"}: runner ${i.runId} interrupted; preserve artifacts and diagnose before changed-input submission`, artifacts: i.artifacts });
	}
	return inspectProof(db, id);
}
export function proofRun(db: Database, runId: string): { seriesId: string; requestedAt: number; state: string; workload: string } | null {
	return db.query<{ seriesId: string; requestedAt: number; state: string; workload: string }, [string]>("SELECT i.seriesId, i.requestedAt, i.state, json_extract(p.manifest, '$.workload') AS workload FROM timing_proof_iterations i JOIN timing_proofs p ON p.id = i.seriesId WHERE i.runId = ?").get(runId);
}
/** Every proof iteration's run id: permanent evidence that ordinary retention never prunes. */
export function proofRunIds(db: Database): string[] {
	return db.query<{ runId: string }, []>("SELECT runId FROM timing_proof_iterations").all().map((r) => r.runId);
}

/** The pinned fetched tree must hold every manifest file; a full series must name every suite file, with no mainSkip/fast exclusion. */
export function validateProofTree(m: ProofManifest, files: readonly string[], phase: ProofPhase): void {
	for (const f of m.files) if (!files.includes(f.path)) throw new Error(`timing-proof ${phase}: ${f.path} absent from pinned fetched tree`);
	if (m.kind === "full-series") {
		const actual = files.filter(isBunTestFile);
		const frozen = new Set(m.files.map((f) => f.path));
		const missing = actual.filter((f) => !frozen.has(f));
		if (missing.length || frozen.size !== actual.length) throw new Error(`full-series: manifest must name ALL current suite files, without mainSkip/fast exclusions; missing ${missing.join(", ")}`);
	}
}

/** A series' controller directory under the runs root: its runner.log, runner.json and controller heartbeat. */
export function proofDirectory(root: string, id: string): string {
	if (!/^tp-[a-z0-9]+$/.test(id)) throw new Error(`timing-proof ${id}: malformed series id`);
	return join(root, "proofs", id);
}
export const controllerHeartbeatOf = (root: string, id: string): string => join(proofDirectory(root, id), "controller-heartbeat");

/** An iteration's run is live while its heartbeat file is fresh, or, before its first beat, within the startup lease. */
export function proofProcessLive(root: string, runId: string, requestedAt: number, now: number): boolean {
	let beat: number | null = null;
	try {
		beat = parseHeartbeat(readFileSync(join(runDirOf(root, runId), "heartbeat"), "utf8"), runId);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`timing-proof ${runId}: heartbeat unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
	return beat === null ? now - requestedAt <= STARTUP_LEASE_MS : !lockHolderStale(beat, now);
}
/** A lock-queue waiter's liveness when it is a proof iteration (running and beating), or null for an ordinary waiter. */
export function proofWaiterLive(db: Database, root: string, runId: string, now: number): boolean | null {
	const p = proofRun(db, runId);
	return p === null ? null : p.state === "running" && proofProcessLive(root, runId, p.requestedAt, now);
}

/**
 * Terminal transitions for series whose owner is gone: a running attempt whose run is not live becomes interrupted (never
 * replayed), and an admitted series whose controller heartbeat is stale fails before its next unstarted attempt. Pure ledger
 * of runs.db; it kills nothing and removes nothing, so `reap` may call it without the exclusive lock.
 */
export function recoverProofSeries(db: Database, root: string, now: () => number, only?: string): ProofRecord[] {
	const ids = only ? [only] : db.query<{ id: string }, []>("SELECT id FROM timing_proofs WHERE state IN ('running', 'admitted')").all().map((r) => r.id);
	return ids.map((id) => {
		let p = recoverProof(db, id, (runId, at) => proofProcessLive(root, runId, at, now()));
		if (p.state === "admitted") {
			const path = controllerHeartbeatOf(root, id);
			let beat: number | null = null;
			try {
				beat = Number(readFileSync(path, "utf8"));
				if (!Number.isSafeInteger(beat) || beat <= 0) throw new Error(`${path}: malformed controller heartbeat`);
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			if (beat === null ? now() - p.requestedAt > STARTUP_LEASE_MS : lockHolderStale(beat, now())) {
				failProof(db, id, `timing-proof ${id}: controller died before the next unstarted iteration; completed attempts retained; inspect ${path}`);
				p = inspectProof(db, id);
			}
		}
		return p;
	});
}

// ---- the exclusive session a proof attempt drives (TOOLS-REVIEW-r1 F5) --------------------------------------------------

/** The pinned commit a session prepares from `repo` (served owner/repo): its fetched tree (file list and `ls-tree -r -z --full-tree` listing) must pass `check`. */
export interface PinnedTarget {
	label: string;
	repo: string;
	check(tree: { files: readonly string[]; listing: string }): void;
	/** The staged caps.json extension, exactly `timingProof` for a proof. */
	caps: Record<string, unknown>;
}
export interface SessionPart { stem: string; result: PartResult; timedOut: boolean; halted: boolean }
/**
 * The ordinary runner's exclusive lifecycle as a controller drives it: the same runs.db lock, queue and `current` fence, the same
 * install check, sweep, admission, probe, abandoned-session recovery, trusted phase and wrapper. Ownership is checked before every
 * step; a step that cannot run throws. prepareSession → runPart → sweepContained → cleanup (only once evidence is imported) →
 * releaseSession, which always runs and reports every failure it met instead of throwing.
 */
export interface ExclusiveSession {
	readonly runDir: string;
	readonly workDir: string;
	/** The report cap evidence imports read under. */
	readonly capBytes: number;
	/** The wrapper argv a part of `file` (null: full) runs under, for the receipt, and its cap: the bound of anything the part needs. */
	partPlan(file: string | null): { argv: string[]; capMs: number };
	/** Queue, lock and publish, then preflight (recovering abandoned sessions) and the pinned trusted phase; then `prepare`, whose span returns. */
	prepareSession(target: PinnedTarget): Promise<{ startedAt: number; completedAt: number }>;
	/** One full part (`file` null) or one solo `./<file>` under its cap. */
	runPart(file: string | null): Promise<SessionPart>;
	/** The sweep, then the containment check; throws unless contained. */
	sweepContained(label: string): Promise<{ kind: "contained" }>;
	/**
	 * The explicit cleanup transition: the held lock row and `current` move in one transaction to a fresh cleanup-only identity
	 * (the wrapper refuses a world's own cleanup), then the world is removed and its absence verified. Intent, transfer and
	 * verification are each written to `<runDir>/proof-cleanup.json` first, so an interrupted transition is recoverable.
	 */
	cleanup(): Promise<void>;
	/** This session holds the lock row and was not superseded. */
	owned(): boolean;
	/** Release the lock, leave the queue, stop the heartbeat, close runs.db; every failure is returned, never thrown. */
	releaseSession(): Promise<string[]>;
}

// ---- historic load: bounded without its owner, recovered by identity (TOOLS-REVIEW-r1 F1) ------------------------------

export type LoadKind = "cpu" | "spawn";
/** The fixed historic recipe: twelve CPU spinners and two spawn loops, each its own utility-class process group. */
export const HISTORIC_LOAD: readonly LoadKind[] = [...Array.from({ length: 12 }, (): LoadKind => "cpu"), "spawn", "spawn"];
export const TASKPOLICY = "/usr/sbin/taskpolicy";
export const LOAD_TAG = "as2-proof-load";
/** A load process's lease, renewed with its owner's heartbeat: a process past it ends itself. As long as a lock holder's staleness. */
export const LOAD_LEASE_MS = HEARTBEAT_STALE_MS;
/** How long readiness, an owner's reap and a recovery's kill may each take before they are failures. */
const LOAD_READY_MS = 30_000;
const LOAD_REAP_MS = 10_000;
/** The load program's own exits: malformed argv, a failed spawn loop, its hard bound, its owner gone (stdin EOF), its lease expired. */
export const LOAD_EXIT = { usage: 64, failed: 70, hardBound: 73, ownerGone: 74, leaseExpired: 75 } as const;
/**
 * The trusted fixed program, never a caller command or environment. It announces readiness only after its first bound check, and
 * ends itself on whichever bound comes first: its owner's death (stdin EOF: the kernel closes the owner's pipe end), its lease
 * (an owner that is suspended or lost the lock stops renewing), or its hard bound (the part's cap). Work yields every 20 ms.
 */
const LOAD_PROGRAM = [
	"import { readFileSync, writeSync } from 'node:fs';",
	"const [, tag, , , , lease, until, kind] = process.argv;",
	"const stop = (code, why) => { writeSync(2, tag + ' ' + why + '\\n'); process.exit(code); };",
	`if (tag !== '${LOAD_TAG}' || (kind !== 'cpu' && kind !== 'spawn') || !(Number(until) > 0)) stop(${LOAD_EXIT.usage}, 'malformed argv ' + JSON.stringify(process.argv.slice(1)));`,
	"const check = () => {",
	"\tconst now = Date.now();",
	`\tif (now >= Number(until)) stop(${LOAD_EXIT.hardBound}, 'hard bound ' + until + ' reached');`,
	"\tlet expiry = NaN;",
	`\ttry { expiry = Number(readFileSync(lease, 'utf8')); } catch (e) { stop(${LOAD_EXIT.leaseExpired}, 'lease ' + lease + ' unreadable: ' + e.message); }`,
	`\tif (!(now < expiry)) stop(${LOAD_EXIT.leaseExpired}, 'lease expired at ' + expiry);`,
	"};",
	`process.stdin.on('end', () => stop(${LOAD_EXIT.ownerGone}, 'owner closed stdin'));`,
	`process.stdin.on('error', (e) => stop(${LOAD_EXIT.ownerGone}, 'owner stdin failed: ' + e.message));`,
	"process.stdin.resume();",
	"check();",
	"writeSync(1, 'ready\\n');",
	"const work = kind === 'cpu'",
	"\t? () => { const end = performance.now() + 20; while (performance.now() < end) Math.sqrt(Math.random()); }",
	`\t: () => { const p = Bun.spawnSync(['/usr/bin/true'], { env: { PATH: '/usr/bin:/bin' }, stdout: 'ignore', stderr: 'ignore' }); if (p.exitCode !== 0) stop(${LOAD_EXIT.failed}, 'load true failed ' + p.exitCode); };`,
	"let checked = 0;",
	"const tick = () => { work(); const now = Date.now(); if (now - checked >= 100) { checked = now; check(); } setImmediate(tick); };",
	"tick();",
].join("\n");

/** One launched load process: its identity (pid, pgid, kernel start time, exact argv with a per-launch nonce) and its fate. */
export interface LoadProcess {
	index: number; kind: LoadKind; pid: number; pgid: number; startUs: number | null; argv: string[]; startedAt: number;
	readyAt?: number; stoppedAt?: number; exit?: number | null;
}
/** `<runDir>/load.json`: written before the first spawn and after every change, so a dead owner leaves every launched identity behind. */
export interface LoadReceipt {
	recipe: string; schedulingClass: string; owner: string; lease: string; hardUntil: number;
	state: "launching" | "running" | "stopped" | "teardown-failed" | "recovered";
	processes: LoadProcess[]; errors: string[];
}
export interface HistoricLoad { receipt: LoadReceipt; renew(now: number): void; stop(): Promise<void> }
export interface LoadRecovery { path: string; outcomes: { pid: number; outcome: "gone" | "not ours" | "killed" }[] }

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const loadPath = (dir: string): string => join(dir, "load.json");
function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, path);
}
const writeReceipt = (dir: string, r: LoadReceipt): void => writeAtomic(loadPath(dir), `${JSON.stringify(r, null, 2)}\n`);

/**
 * Launch `recipe` (the fixed HISTORIC_LOAD outside tests) for `owner` under `dir` and wait for each process's readiness. Every
 * process holds its stdin pipe from this process, reads `<dir>/load-lease` (`renew` writes it) and ends itself at `hardUntil`.
 * A launch that fails tears down what it launched and throws the launch error, joined with any teardown error.
 */
export async function startHistoricLoad(dir: string, owner: string, hardUntil: number, now: () => number = Date.now, recipe: readonly LoadKind[] = HISTORIC_LOAD): Promise<HistoricLoad> {
	const lease = join(dir, "load-lease");
	const receipt: LoadReceipt = {
		recipe: `${recipe.filter((k) => k === "cpu").length}-cpu-${recipe.filter((k) => k === "spawn").length}-spawn`, schedulingClass: "utility (taskpolicy)",
		owner, lease, hardUntil, state: "launching", processes: [], errors: [],
	};
	const children: Subprocess[] = [];
	const renew = (at: number): void => writeAtomic(lease, String(at + LOAD_LEASE_MS));
	const stop = async (): Promise<void> => {
		const failures: unknown[] = [];
		// Which children still run, from the kernel rather than Bun's reap: an exited, unreaped child is a zombie here, and macOS
		// refuses (EPERM) a group kill whose only member is a zombie.
		const s = snapshot(process.getuid!());
		if (s.kind !== "ok") failures.push(new Error(`load teardown: process list unavailable (${s.why}); an early exit cannot be told from the owner's kill`));
		const running = (pid: number): boolean => s.kind !== "ok" || s.procs.some((p) => p.pid === pid && !p.zombie);
		await Promise.all(children.map(async (child, index) => {
			const row = receipt.processes[index]!;
			try {
				let ended = child.exitCode !== null || !running(child.pid);
				if (!ended) {
					// The pid is our unreaped child, so it cannot have been reused: the handle is its identity.
					try { process.kill(-child.pid, "SIGKILL"); }
					catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						if (code !== "ESRCH" && code !== "EPERM") throw error;
						ended = true;
					}
				}
				let timer: Timer | undefined;
				try {
					row.exit = await Promise.race([child.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`load pid ${child.pid}: reap exceeded ${LOAD_REAP_MS} ms; the next exclusive owner recovers it by identity`)), LOAD_REAP_MS); })]);
					row.stoppedAt = now();
				} finally { clearTimeout(timer); }
				// During a launch the failed process's exit is the launch error itself; once running, an early exit means the load ran short.
				if (ended && receipt.state === "running") failures.push(new Error(`load ${row.kind} pid ${child.pid} ended before its owner stopped it, exit ${row.exit}; inspect ${join(dir, `load-${index}.log`)}`));
			} catch (error) { failures.push(error); }
		}));
		receipt.state = failures.length ? "teardown-failed" : "stopped";
		receipt.errors.push(...failures.map(errText));
		writeReceipt(dir, receipt);
		if (failures.length) throw new AggregateError(failures, `timing-proof load teardown ${loadPath(dir)}: ${failures.map(errText).join("; ")}`);
	};
	try {
		renew(now());
		writeReceipt(dir, receipt);
		for (const [index, kind] of recipe.entries()) {
			const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
			const argv = [TASKPOLICY, "-c", "utility", process.execPath, "-e", LOAD_PROGRAM, LOAD_TAG, owner, String(index), nonce, lease, String(hardUntil), kind];
			const fd = openSync(join(dir, `load-${index}.log`), "a", 0o600);
			let child: Subprocess<"pipe", "pipe", number>;
			try { child = spawn(argv, { cwd: dir, env: { PATH: "/usr/bin:/bin", HOME: dir }, stdin: "pipe", stdout: "pipe", stderr: fd, detached: true }); }
			finally { closeSync(fd); }
			children.push(child);
			// Recorded before anything else can fail: a teardown or a recovery always knows every launched pid.
			const row: LoadProcess = { index, kind, pid: child.pid, pgid: child.pid, startUs: null, argv, startedAt: now() };
			receipt.processes.push(row);
			writeReceipt(dir, receipt);
			const s = snapshot(process.getuid!());
			if (s.kind !== "ok") throw new Error(`load ${kind} pid ${child.pid}: process list unavailable (${s.why}); its identity cannot be recorded`);
			const p = s.procs.find((x) => x.pid === child.pid);
			if (!p) throw new Error(`load ${kind} pid ${child.pid} ended before its identity was recorded; inspect load-${index}.log`);
			row.pgid = p.pgid;
			row.startUs = p.startUs;
			writeReceipt(dir, receipt);
			const reader = child.stdout.getReader();
			let timer: Timer | undefined;
			try {
				const ready = async (): Promise<void> => {
					let line = "";
					while (!line.includes("\n")) {
						const chunk = await reader.read();
						if (chunk.done) throw new Error(`load ${kind} pid ${child.pid} exited before readiness; inspect load-${index}.log`);
						line += new TextDecoder().decode(chunk.value);
						if (line.length > 6) throw new Error(`load ${kind} pid ${child.pid} malformed readiness; inspect load-${index}.log`);
					}
					if (line !== "ready\n") throw new Error(`load ${kind} pid ${child.pid} failed readiness; inspect load-${index}.log`);
				};
				await Promise.race([ready(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`load ${kind} pid ${child.pid} readiness exceeded ${LOAD_READY_MS} ms; inspect load-${index}.log`)), LOAD_READY_MS); })]);
			} finally { clearTimeout(timer); reader.releaseLock(); }
			receipt.processes[index]!.readyAt = now();
		}
		receipt.state = "running";
		writeReceipt(dir, receipt);
		return { receipt, renew, stop };
	} catch (error) {
		receipt.errors.push(`launch: ${errText(error)}`);
		try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], `timing-proof load launch failed: ${errText(error)}; and its teardown: ${errText(cleanup)}`); }
		throw error;
	}
}

/**
 * Recovery of a load whose owner never recorded it stopped (`launching`, `running`, `teardown-failed`), for the exclusive owner
 * before any part of its own: the lock holder's load is the only legitimate one. A recorded process is killed (its group, SIGKILL)
 * only when the live process has the recorded pid, pgid and kernel start time and its argv is the recorded one (the taskpolicy
 * argv before exec, its bun tail after), nonce included; a reused pid is left alone. Kills are then awaited to `deadlineMs`.
 * Appends `<dir>/load-recovery.jsonl` and marks load.json `recovered`; anything unverifiable or still live throws, leaving the
 * receipt open for the next owner. Returns null when there is nothing to recover.
 */
export async function recoverHistoricLoad(dir: string, by: string, now: () => number = Date.now, deadlineMs = LOAD_REAP_MS): Promise<LoadRecovery | null> {
	const path = loadPath(dir);
	let text: string;
	try { text = readFileSync(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`load recovery ${path}: unreadable: ${errText(error)}`);
	}
	const receipt = JSON.parse(text) as LoadReceipt;
	if (!Array.isArray(receipt?.processes) || !Array.isArray(receipt.errors)) throw new Error(`load recovery ${path}: malformed receipt; inspect it and its load-*.log before any part runs`);
	if (receipt.state === "stopped" || receipt.state === "recovered") return null;
	const uid = process.getuid!();
	const s = snapshot(uid);
	if (s.kind !== "ok") throw new Error(`load recovery ${path}: process list of uid ${uid} unavailable (${s.why}); no identity verified, nothing killed`);
	const errors: string[] = [];
	const outcomes: LoadRecovery["outcomes"] = [];
	const killed: number[] = [];
	const same = (a: string[] | null, b: string[]): boolean => a !== null && a.length === b.length && a.every((x, i) => x === b[i]);
	for (const rec of receipt.processes) {
		const live = s.procs.find((p) => p.pid === rec.pid && !p.zombie);
		if (!live) { outcomes.push({ pid: rec.pid, outcome: "gone" }); continue; }
		// A start time recorded is compared; one never recorded (the launch died in between) leaves the argv's per-launch nonce as identity.
		if ((rec.startUs !== null && live.startUs !== rec.startUs) || live.pgid !== rec.pgid) { outcomes.push({ pid: rec.pid, outcome: "not ours" }); continue; }
		const argv = procArgv(rec.pid);
		if (argv === null) { errors.push(`pid ${rec.pid}: argv unreadable, identity unverified, not killed`); continue; }
		if (!same(argv, rec.argv) && !same(argv, rec.argv.slice(3))) { outcomes.push({ pid: rec.pid, outcome: "not ours" }); continue; }
		// ESRCH, or EPERM for a group whose members are all zombies now: it ended between the list and the kill; the wait below confirms.
		try { process.kill(-rec.pgid, "SIGKILL"); }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ESRCH" && code !== "EPERM") { errors.push(`pid ${rec.pid}: SIGKILL of group ${rec.pgid} failed: ${errText(error)}`); continue; }
		}
		killed.push(rec.pid);
		outcomes.push({ pid: rec.pid, outcome: "killed" });
	}
	const deadline = now() + deadlineMs;
	for (let left = killed; left.length > 0;) {
		const t = snapshot(uid);
		if (t.kind !== "ok") { errors.push(`process list unavailable after the kill (${t.why}); pids ${left.join(",")} unconfirmed`); break; }
		left = left.filter((pid) => t.procs.some((p) => p.pid === pid && !p.zombie));
		if (left.length === 0) break;
		if (now() >= deadline) { errors.push(`pids ${left.join(",")} still live ${deadlineMs} ms after SIGKILL`); break; }
		await Bun.sleep(50);
	}
	appendFileSync(join(dir, "load-recovery.jsonl"), `${JSON.stringify({ by, at: now(), recordedState: receipt.state, outcomes, errors })}\n`, { mode: 0o600 });
	if (errors.length) {
		receipt.errors.push(...errors.map((e) => `recovery by ${by}: ${e}`));
		writeReceipt(dir, receipt);
		throw new Error(`load recovery ${path}: ${errors.join("; ")}; no part may run until it is contained; inspect ${join(dir, "load-recovery.jsonl")}`);
	}
	receipt.state = "recovered";
	writeReceipt(dir, receipt);
	return { path, outcomes };
}
