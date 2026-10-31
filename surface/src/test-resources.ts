// Executor-owned admission. Costs have no guessed defaults: the trusted install supplies measured
// worker peaks and host + historical proof-load reserve in resources.json beside the fixed Bun.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { availableParallelism, cpus, freemem, loadavg, totalmem } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { childEnv } from "./test-run";

export interface ResourceCosts {
	workerCpu: number;
	workerMemoryBytes: number;
	reserveCpu: number;
	reserveMemoryBytes: number;
	/** Durable measurement receipt, including host and historical-load reservation methodology. */
	calibration: string;
}
export interface ResourceInputs {
	cpuCount: number;
	availableCpuCount: number;
	/** Conservative currently free memory, not total RAM or an inferred reclaimable-memory estimate. */
	availableMemoryBytes: number;
	totalMemoryBytes: number;
	loadAverage: number[];
}
export interface ResourceAdmission {
	configuredWorkers: number;
	selectedWorkers: number;
	nestedConcurrency: 1;
	inputs: ResourceInputs;
	costs: ResourceCosts;
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown, key: string): number => {
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`resource admission: ${key} must be positive and finite (got ${String(v)})`);
	return v;
};
const whole = (v: unknown, key: string): number => {
	const n = positive(v, key);
	if (!Number.isSafeInteger(n)) throw new Error(`resource admission: ${key} must be a safe integer (got ${String(v)})`);
	return n;
};

export function parseResourceCosts(v: unknown): ResourceCosts {
	if (!object(v)) throw new Error("missing resource calibration: provision measured resources.json in the trusted wrapper install; no default worker/reserve estimates are admitted");
	const keys = ["workerCpu", "workerMemoryBytes", "reserveCpu", "reserveMemoryBytes", "calibration"];
	if (Object.keys(v).some((k) => !keys.includes(k))) throw new Error("resource calibration has unknown fields");
	if (typeof v.calibration !== "string" || !v.calibration.trim()) throw new Error("resource calibration needs a measurement receipt for worker peaks and host plus historical-load reserve");
	for (const key of ["reserveCpu", "reserveMemoryBytes"] as const) {
		if (typeof v[key] !== "number" || !Number.isFinite(v[key]) || v[key] < 0) throw new Error(`resource calibration: ${key} must be nonnegative and finite`);
	}
	if (!Number.isSafeInteger(v.reserveMemoryBytes)) throw new Error("resource calibration: reserveMemoryBytes must be a safe integer");
	return { workerCpu: positive(v.workerCpu, "workerCpu"), workerMemoryBytes: whole(v.workerMemoryBytes, "workerMemoryBytes"), reserveCpu: v.reserveCpu as number,
		reserveMemoryBytes: v.reserveMemoryBytes as number, calibration: v.calibration };
}

export function readResourceInputs(): ResourceInputs {
	return { cpuCount: cpus().length, availableCpuCount: availableParallelism(), availableMemoryBytes: freemem(), totalMemoryBytes: totalmem(), loadAverage: loadavg() };
}

/** Freeze one selection for the whole part; a zero-capacity result is a failure, never a forced worker. */
export function admitResources(configuredWorkers: number, inputs: ResourceInputs, rawCosts: ResourceCosts): ResourceAdmission {
	whole(configuredWorkers, "configuredWorkers");
	const costs = parseResourceCosts(rawCosts);
	for (const key of ["cpuCount", "availableCpuCount", "availableMemoryBytes", "totalMemoryBytes"] as const) whole(inputs[key], key);
	if (inputs.availableCpuCount > inputs.cpuCount) throw new Error("resource admission: availableCpuCount exceeds cpuCount");
	if (inputs.availableMemoryBytes > inputs.totalMemoryBytes) throw new Error("resource admission: availableMemoryBytes exceeds totalMemoryBytes");
	if (inputs.loadAverage.length !== 3 || inputs.loadAverage.some((n) => !Number.isFinite(n) || n < 0)) throw new Error("resource admission: loadAverage reading is malformed");
	const cpu = Math.floor((inputs.availableCpuCount - costs.reserveCpu) / costs.workerCpu);
	const memory = Math.floor((inputs.availableMemoryBytes - costs.reserveMemoryBytes) / costs.workerMemoryBytes);
	const selectedWorkers = Math.min(configuredWorkers, cpu, memory);
	if (selectedWorkers < 1) throw new Error(`resource admission: cannot admit one worker; configured=${configuredWorkers} inputs=${JSON.stringify(inputs)} costs=${JSON.stringify(costs)}; diagnose capacity or calibration before another run`);
	return { configuredWorkers, selectedWorkers, nestedConcurrency: 1, inputs: { ...inputs, loadAverage: [...inputs.loadAverage] }, costs };
}

/**
 * Bun 1.3.14 help exposes independent file-worker and concurrent-case controls; executor checks its fixed binary too.
 * Isolation follows the configured ceiling, never the admitted count (TOOLS-REVIEW r2 R5): Bun's help says `--parallel`
 * "Implies --isolate", so a configured ceiling over 1 always passes `--parallel=<admitted n>`, n = 1 included, and every
 * file runs in a fresh global object however busy the host is; a configured 1 passes none and keeps the serial launch the
 * runner's red-main decision rests on (a file that fails in the suite but passes alone is red, never red-main). Keyed on
 * the admitted count instead, one commit could be red on a busy host (1 admitted, not isolated) and green on an idle one.
 */
export function boundedTestArgs(argv: string[], configuredWorkers: number, selectedWorkers: number): string[] {
	whole(configuredWorkers, "configuredWorkers");
	whole(selectedWorkers, "selectedWorkers");
	if (selectedWorkers > configuredWorkers) throw new Error(`resource admission: selectedWorkers ${selectedWorkers} exceeds the configured ceiling ${configuredWorkers}; admission never selects past fullWorkers, so the caller passed the wrong pair`);
	if (argv[0] !== "test") throw new Error("resource admission: only fixed bun test launches can be bounded");
	return ["test", "--max-concurrency=1", ...(configuredWorkers > 1 ? [`--parallel=${selectedWorkers}`] : []), ...argv.slice(1)];
}

export interface TimingProofCaps { productionBudget: boolean; installedOmp: boolean }
export function parseTimingProof(v: unknown): TimingProofCaps | null {
	if (v === undefined) return null;
	if (!object(v) || Object.keys(v).length !== 2 || Object.keys(v).some((k) => k !== "productionBudget" && k !== "installedOmp") || typeof v.productionBudget !== "boolean" || typeof v.installedOmp !== "boolean") {
		throw new Error("caps.json timingProof must be exactly {productionBudget:boolean,installedOmp:boolean}; no runtime path, command or arbitrary environment is admitted");
	}
	return { productionBudget: v.productionBudget, installedOmp: v.installedOmp };
}

export interface InstalledOmp { root: string; treeSha256: string; version: string }
export function parseInstalledOmp(v: unknown): InstalledOmp {
	if (!object(v) || Object.keys(v).length !== 3 || Object.keys(v).some((k) => !["root", "treeSha256", "version"].includes(k))
		|| typeof v.root !== "string" || !isAbsolute(v.root) || normalize(v.root) !== v.root || /[:\n\0]/.test(v.root)
		|| typeof v.treeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.treeSha256) || typeof v.version !== "string" || !v.version.trim() || /[\n\0]/.test(v.version)) {
		throw new Error("installed OMP config must pin exactly root, treeSha256 and version; provision installed-omp.json in the trusted wrapper install");
	}
	return { root: v.root, treeSha256: v.treeSha256, version: v.version };
}

/**
 * Every component must be physical, owned by one of `owners` (root alone unless a test install names its own uid) and not
 * group/world writable; caller cannot substitute an ancestor.
 */
export function verifyTrustedPath(path: string, owners: readonly number[] = [0]): void {
	if (!isAbsolute(path) || normalize(path) !== path) throw new Error(`trusted install: ${path} is not a normalized absolute path`);
	const owned = owners.length === 1 && owners[0] === 0 ? "root-owned" : `owned by uid ${owners.join(" or ")}`;
	for (let p = path; ; p = dirname(p)) {
		const s = lstatSync(p);
		if (s.isSymbolicLink() || !owners.includes(s.uid) || (s.mode & 0o022) !== 0) throw new Error(`trusted install: ${p} must be ${owned}, physical and not group/world writable; repair provisioning before execution`);
		if (dirname(p) === p) break;
	}
	if (realpathSync(path) !== path) throw new Error(`trusted install: ${path} is not a physical path`);
}

/** Hash every transitive file, relative name and executable bit. No symlinks/special nodes escape the pinned artifact. */
export function runtimeTreeHash(root: string, trusted = false): string {
	const hash = createHash("sha256");
	const visit = (path: string, rel: string): void => {
		const s = lstatSync(path);
		if (s.isSymbolicLink()) throw new Error(`installed OMP artifact: symlink ${path} is not admitted; package transitive files inside the artifact`);
		if ((s.mode & 0o022) !== 0) throw new Error(`installed OMP artifact: ${path} is group/world writable; seal the verified artifact before provisioning`);
		if (trusted && (s.uid !== 0 || (s.mode & 0o022) !== 0)) throw new Error(`installed OMP artifact: ${path} must be root-owned and read-only to the test identity`);
		if (s.isDirectory()) {
			hash.update(JSON.stringify(["dir", rel]));
			for (const name of readdirSync(path).sort()) visit(join(path, name), rel ? `${rel}/${name}` : name);
		} else if (s.isFile()) {
			hash.update(JSON.stringify(["file", rel, s.mode & 0o111, createHash("sha256").update(readFileSync(path)).digest("hex")]));
		} else throw new Error(`installed OMP artifact: special file ${path} is not admitted`);
	};
	if (!lstatSync(root).isDirectory()) throw new Error(`installed OMP artifact: ${root} is not a directory`);
	visit(root, "");
	return hash.digest("hex");
}

export function readInstalledOmp(path: string): InstalledOmp {
	verifyTrustedPath(path);
	const pin = parseInstalledOmp(JSON.parse(readFileSync(path, "utf8")));
	verifyTrustedPath(pin.root);
	const actual = runtimeTreeHash(pin.root, true);
	if (actual !== pin.treeSha256) throw new Error(`installed OMP artifact ${pin.root}: tree hash ${actual} differs from pinned ${pin.treeSha256}; reinstall verified artifact`);
	for (const name of ["omp", "bun"]) {
		const exe = join(pin.root, "bin", name);
		const s = lstatSync(exe);
		if (!s.isFile() || !(s.mode & 0o111)) throw new Error(`installed OMP artifact: ${exe} is not executable; include every pinned runtime dependency`);
	}
	return pin;
}

/** Caller PATH and proof flags are discarded; only the trusted runtime bin and fixed OS paths are exposed. */
export function proofChildEnv(parent: Record<string, string | undefined>, dir: string, proof: TimingProofCaps | null, omp: InstalledOmp | null): Record<string, string> {
	if (proof?.installedOmp && !omp) throw new Error("installed OMP proof requested but no verified trusted runtime is available; provision the pinned artifact first");
	const env = childEnv({ ...parent, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, dir);
	if (proof?.productionBudget) env.AS2_STUCK_BUDGET_PROOF = "1";
	if (proof?.installedOmp) env.PATH = `${omp!.root}/bin:${dir}/shim:/usr/bin:/bin:/usr/sbin:/sbin`;
	return env;
}
