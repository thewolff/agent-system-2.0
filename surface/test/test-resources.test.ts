import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admitResources, boundedTestArgs, parseResourceCosts, parseTimingProof, proofChildEnv, runtimeTreeHash, verifyTrustedPath } from "../src/test-resources";
import { tmp } from "./helpers";

const costs = { workerCpu: 2, workerMemoryBytes: 400, reserveCpu: 2, reserveMemoryBytes: 200, calibration: "synthetic fixture: worker peak and host plus historical-load reserve" };
const inputs = { cpuCount: 16, availableCpuCount: 12, availableMemoryBytes: 1800, totalMemoryBytes: 3200, loadAverage: [0, 0, 0] };

const roots: string[] = [];
const fixture = (): string => { const root = tmp("resource-runtime"); roots.push(root); return root; };
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
describe("resource admission", () => {
	test("configured workers are only a ceiling; both CPU and current memory constrain launch", () => {
		expect(admitResources(20, inputs, costs)).toMatchObject({ configuredWorkers: 20, selectedWorkers: 4, nestedConcurrency: 1, inputs, costs });
		expect(admitResources(20, { ...inputs, availableCpuCount: 6 }, costs).selectedWorkers).toBe(2);
		expect(admitResources(1, inputs, costs).selectedWorkers).toBe(1);
	});
	test("insufficient resources refuse rather than oversubscribing one worker", () => {
		expect(() => admitResources(6, { ...inputs, availableMemoryBytes: 599 }, costs)).toThrow("cannot admit one worker");
		expect(() => admitResources(6, { ...inputs, availableCpuCount: 3 }, costs)).toThrow("cannot admit one worker");
	});
	test("missing calibration, invalid readings and nonpositive costs fail visibly", () => {
		expect(() => parseResourceCosts(null)).toThrow("missing resource calibration");
		expect(() => parseResourceCosts({ ...costs, calibration: "" })).toThrow("calibration");
		expect(() => parseResourceCosts({ ...costs, workerMemoryBytes: 0 })).toThrow("workerMemoryBytes");
		expect(() => admitResources(2, { ...inputs, availableMemoryBytes: NaN }, costs)).toThrow("availableMemoryBytes");
		expect(() => admitResources(2, { ...inputs, availableMemoryBytes: 4000 }, costs)).toThrow("totalMemoryBytes");
	});
	test("the admitted outer count and serial nested bound reach Bun arguments", () => {
		expect(boundedTestArgs(["test", "./a.test.ts"], 6, 3)).toEqual(["test", "--max-concurrency=1", "--parallel=3", "./a.test.ts"]);
		// A configured 1 stays serial in one process: `--parallel` implies --isolate, which would hide a cross-file failure from the full part.
		expect(boundedTestArgs(["test", "./a.test.ts"], 1, 1)).toEqual(["test", "--max-concurrency=1", "./a.test.ts"]);
		expect(() => boundedTestArgs(["test"], 2, 3)).toThrow("exceeds the configured ceiling 2");
	});
	// TOOLS-REVIEW r2 R5: isolation is a function of configuration, never of host load.
	test("a configured ceiling over 1 isolates even when a busy host admits one worker; a configured 1 never does", () => {
		const busy = admitResources(6, { ...inputs, availableCpuCount: 4 }, costs);
		expect(busy.selectedWorkers).toBe(1);
		expect(boundedTestArgs(["test"], busy.configuredWorkers, busy.selectedWorkers)).toEqual(["test", "--max-concurrency=1", "--parallel=1"]);
		const idle = admitResources(6, inputs, costs);
		expect(idle.selectedWorkers).toBeGreaterThan(1);
		expect(boundedTestArgs(["test"], idle.configuredWorkers, idle.selectedWorkers)).toEqual(["test", "--max-concurrency=1", `--parallel=${idle.selectedWorkers}`]);
		const serial = admitResources(1, inputs, costs);
		expect(boundedTestArgs(["test"], serial.configuredWorkers, serial.selectedWorkers)).toEqual(["test", "--max-concurrency=1"]);
	});
});

describe("proof child boundary", () => {
	test("proof caps admit only the two fixed booleans", () => {
		expect(parseTimingProof(undefined)).toBeNull();
		expect(parseTimingProof({ productionBudget: true, installedOmp: false })).toEqual({ productionBudget: true, installedOmp: false });
		for (const value of [null, [], {}, { productionBudget: true, installedOmp: true, env: {} }, { productionBudget: 1, installedOmp: false }, { productionBudget: false, installedOmp: false, runtime: "/operator/omp" }]) {
			expect(() => parseTimingProof(value)).toThrow("timingProof");
		}
	});
	test("ordinary and opted-out children cannot inherit the proof flag or credentials", () => {
		const parent = { PATH: "/operator/bin", HOME: "/operator/home", GH_TOKEN: "sentinel", OMP_API_KEY: "sentinel", AS2_STUCK_BUDGET_PROOF: "1" };
		const ordinary = proofChildEnv(parent, "/work/part", null, null);
		expect(ordinary.HOME).toBe("/work/part/home");
		expect(ordinary.PATH).toBe("/work/part/shim:/usr/bin:/bin:/usr/sbin:/sbin");
		for (const key of ["GH_TOKEN", "OMP_API_KEY", "AS2_STUCK_BUDGET_PROOF"]) expect(ordinary[key]).toBeUndefined();
		expect(proofChildEnv(parent, "/work/part", { productionBudget: true, installedOmp: false }, null).AS2_STUCK_BUDGET_PROOF).toBe("1");
		expect(proofChildEnv(parent, "/work/part", { productionBudget: false, installedOmp: false }, null).AS2_STUCK_BUDGET_PROOF).toBeUndefined();
		expect(() => proofChildEnv(parent, "/work/part", { productionBudget: false, installedOmp: true }, null)).toThrow("installed OMP");
	});
	test("a transitive runtime modification changes the pin; symlinks are rejected", () => {
		const root = fixture();
		mkdirSync(join(root, "bin"));
		writeFileSync(join(root, "bin", "omp"), "runtime");
		writeFileSync(join(root, "dependency.js"), "before");
		const before = runtimeTreeHash(root);
		writeFileSync(join(root, "dependency.js"), "after");
		expect(runtimeTreeHash(root)).not.toBe(before);
		symlinkSync("dependency.js", join(root, "linked.js"));
		expect(() => runtimeTreeHash(root)).toThrow("symlink");
	});
	test("operator-owned runtime paths are not a trusted install", () => {
		const root = fixture();
		expect(() => verifyTrustedPath(root)).toThrow("root-owned");
	});
	test("a writable ancestor is refused unless it is a root-owned sticky directory", () => {
		const me = process.getuid?.() ?? -1;
		const root = realpathSync(fixture()); // a trusted path is physical (macOS /var is a symlink)
		const leaf = join(root, "shared", "libexec");
		mkdirSync(leaf, { recursive: true });
		// Under the runner, tmp sits below /Users/Shared (root, 1777): this passing is the root-sticky exception at work.
		expect(verifyTrustedPath(leaf, [0, me])).toBeUndefined();
		chmodSync(join(root, "shared"), 0o1777); // sticky, but owned by the test identity, not root
		expect(() => verifyTrustedPath(leaf, [0, me])).toThrow(`${join(root, "shared")} must be owned by uid 0 or ${me}`);
		chmodSync(join(root, "shared"), 0o777);
		expect(() => verifyTrustedPath(leaf, [0, me])).toThrow("not group/world writable");
		chmodSync(join(root, "shared"), 0o755);
		chmodSync(leaf, 0o1777); // the install path itself never takes the exception
		expect(() => verifyTrustedPath(leaf, [0, me])).toThrow(`${leaf} must be owned`);
	});
});
