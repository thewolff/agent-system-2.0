import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
		expect(boundedTestArgs(["test", "./a.test.ts"], 3)).toEqual(["test", "--max-concurrency=1", "--parallel=3", "./a.test.ts"]);
		// One worker stays serial in one process: `--parallel` implies --isolate, which would hide a cross-file failure from the full part.
		expect(boundedTestArgs(["test", "./a.test.ts"], 1)).toEqual(["test", "--max-concurrency=1", "./a.test.ts"]);
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
});
