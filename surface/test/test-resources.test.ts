import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admitResources, boundedTestArgs, parseResourceCosts, parseTimingProof, proofChildEnv, runtimeTreeHash, verifyTrustedPath } from "../src/test-resources";
import { tmp } from "./helpers";

const costs = { workerCpu: 2, workerMemoryBytes: 400, reserveCpu: 2, reserveMemoryBytes: 200, calibration: "synthetic fixture: worker peak and host plus historical-load reserve" };
const inputs = { cpuCount: 16, availableCpuCount: 12, availableMemoryBytes: 1800, totalMemoryBytes: 3200, loadAverage: [0, 0, 0] };

const roots: string[] = [];
const fixture = (): string => { const root = tmp("resource-runtime"); roots.push(root); return root; };
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
describe("resource admission", () => {
	test("configured workers are only a ceiling; the fixed CPU count and total memory constrain launch", () => {
		expect(admitResources(20, inputs, costs)).toMatchObject({ configuredWorkers: 20, selectedWorkers: 7, nestedConcurrency: 1, inputs, costs });
		expect(admitResources(20, { ...inputs, cpuCount: 8, availableCpuCount: 8 }, costs).selectedWorkers).toBe(3);
		expect(admitResources(20, { ...inputs, totalMemoryBytes: 1400, availableMemoryBytes: 1000 }, costs).selectedWorkers).toBe(3);
		expect(admitResources(1, inputs, costs).selectedWorkers).toBe(1);
	});
	// Jo's "fixed" ruling (q-mvzovbsiyotxuk): live readings are recorded, never selecting, so a busy host cannot change the count.
	test("a busy host admits exactly what an idle one does, and its live readings are kept in the receipt", () => {
		const busyInputs = { ...inputs, availableCpuCount: 1, availableMemoryBytes: 1, loadAverage: [40, 30, 20] };
		const busy = admitResources(20, busyInputs, costs);
		expect(busy.selectedWorkers).toBe(admitResources(20, inputs, costs).selectedWorkers);
		expect(busy.inputs).toEqual(busyInputs);
	});
	test("the measured calibration admits three workers on this 14-CPU, 24 GiB Mac", () => {
		const measured = { workerCpu: 1.995, workerMemoryBytes: 2249719808, reserveCpu: 7.806, reserveMemoryBytes: 13056475136, calibration: "PROVISION-FINDINGS.md: worker CPU p99, host CPU p99, memory maxima" };
		const mac = { cpuCount: 14, availableCpuCount: 14, availableMemoryBytes: 148389888, totalMemoryBytes: 25769803776, loadAverage: [23.9, 17.8, 14.1] };
		expect(admitResources(6, mac, measured).selectedWorkers).toBe(3);
	});
	test("insufficient resources refuse rather than oversubscribing one worker", () => {
		expect(() => admitResources(6, { ...inputs, totalMemoryBytes: 599, availableMemoryBytes: 500 }, costs)).toThrow("cannot admit one worker");
		expect(() => admitResources(6, { ...inputs, cpuCount: 3, availableCpuCount: 3 }, costs)).toThrow("cannot admit one worker");
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
	test("a configured ceiling over 1 isolates even when the calibration admits one worker; a configured 1 never does", () => {
		const small = admitResources(6, { ...inputs, cpuCount: 4, availableCpuCount: 4 }, costs);
		expect(small.selectedWorkers).toBe(1);
		expect(boundedTestArgs(["test"], small.configuredWorkers, small.selectedWorkers)).toEqual(["test", "--max-concurrency=1", "--parallel=1"]);
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
	test("a writable ancestor is refused unless it is a root-owned sticky directory above the path's parent", () => {
		const me = process.getuid?.() ?? -1;
		// /tmp is root-owned 1777 on macOS (/private/tmp) and Linux alike; its physical path, since a trusted path is physical.
		const sharedTmp = realpathSync("/tmp");
		expect(lstatSync(sharedTmp).uid).toBe(0);
		expect(lstatSync(sharedTmp).mode & 0o7777).toBe(0o1777);
		const own = mkdtempSync(join(sharedTmp, "as2-trusted-")); // ours, 0700, directly in the sticky directory
		roots.push(own);
		const leaf = join(own, "libexec");
		mkdirSync(leaf);
		expect(verifyTrustedPath(leaf, [0, me])).toBeUndefined(); // the sticky directory is an ancestor above the parent
		// A name directly in the sticky directory refuses: anyone may plant one there (a hard link to an older trusted file).
		expect(() => verifyTrustedPath(own, [0, me])).toThrow(`${sharedTmp} must be owned by uid 0 or ${me}`);
		expect(() => verifyTrustedPath(sharedTmp, [0, me])).toThrow(`${sharedTmp} must be owned`); // nor is it the path itself
		// Bun's chmodSync drops the sticky bit (review r5 F1), so set it with chmod(1) and check that it took.
		const mid = join(own, "shared");
		const deep = join(mid, "libexec", "as2test");
		mkdirSync(deep, { recursive: true });
		expect(spawnSync("chmod", ["1777", mid]).status).toBe(0);
		expect(lstatSync(mid).mode & 0o7777).toBe(0o1777);
		expect(() => verifyTrustedPath(deep, [0, me])).toThrow(`${mid} must be owned by uid 0 or ${me}`); // sticky, not root's
		chmodSync(mid, 0o777);
		expect(lstatSync(mid).mode & 0o7777).toBe(0o777);
		expect(() => verifyTrustedPath(deep, [0, me])).toThrow(`${mid} must be owned by uid 0 or ${me}`);
	});
});
