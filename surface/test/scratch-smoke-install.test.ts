// scratch-smoke's install step (surface/scripts/scratch-smoke.ts installProfile), driven through a fake `run`: install.sh is
// never spawned. Since install/install.sh ends with the full doctor, an isolated HOME exits 5 (the seat part cannot pass: no
// orchestrator runs for the copy); setup takes that as success with one logged line, as chaos.ts setup does (review r5 F15).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError } from "../src/chaos";
import { type InstallDeps, installProfile, type Ran } from "../scripts/scratch-smoke";
import { tmp } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A run directory with a HOME in it; `profile` writes the config.yml install.sh would have written before its closing doctor. */
function fixture(result: Ran, profile = true): { deps: InstallDeps; said: string[]; calls: string[][]; runDir: string; agentDir: string } {
	const runDir = tmp("scratch-smoke-install");
	dirs.push(runDir);
	const home = join(runDir, "home");
	const agentDir = join(home, ".omp", "profiles", "agent-system-2", "agent");
	if (profile) {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "config.yml"), "x: 1\n");
	}
	const said: string[] = [];
	const calls: string[][] = [];
	const deps: InstallDeps = {
		repo: join(runDir, "repo"),
		home,
		path: "/usr/bin:/bin",
		runDir,
		run: async (cmd) => {
			calls.push(cmd);
			return result;
		},
		say: (l) => said.push(l),
	};
	return { deps, said, calls, runDir, agentDir };
}

const DOCTOR_FAILED_ERR = "seat: no orchestrator for this repository\ninstall incomplete: as2 doctor found failing parts (above)";

describe("scratch-smoke installProfile", () => {
	test("exit 5 (install's closing doctor failed) is setup success: one logged line naming install.log, full output kept", async () => {
		const f = fixture({ code: 5, out: "installed the profile\nas2 doctor: seat FAIL", err: DOCTOR_FAILED_ERR, timedOut: false });
		expect(await installProfile(f.deps)).toBe(f.agentDir);
		expect(f.calls).toEqual([["bash", join(f.deps.repo, "install", "install.sh")]]);
		const log = join(f.runDir, "install.log");
		expect(f.said).toHaveLength(1);
		expect(f.said[0]).toContain("closing doctor failed");
		expect(f.said[0]).toContain("exit 5");
		expect(f.said[0]).toContain(log);
		expect(readFileSync(log, "utf8")).toBe(`installed the profile\nas2 doctor: seat FAIL\n--- stderr ---\n${DOCTOR_FAILED_ERR}`);
	});

	test("exit 0 logs nothing extra and returns the agent dir", async () => {
		const f = fixture({ code: 0, out: "ok", err: "", timedOut: false });
		expect(await installProfile(f.deps)).toBe(f.agentDir);
		expect(f.said).toEqual([]);
	});

	test("every other nonzero exit throws HarnessError naming the code, the last stderr line and the log", async () => {
		for (const code of [1, 2, 4, 6, null]) {
			const f = fixture({ code, out: "", err: "boom\nlast line", timedOut: false });
			const run = installProfile(f.deps);
			await expect(run).rejects.toThrow(HarnessError);
			await expect(installProfile(f.deps)).rejects.toThrow(`install.sh exited ${code}: last line (log ${join(f.runDir, "install.log")})`);
			expect(readFileSync(join(f.runDir, "install.log"), "utf8")).toBe("\n--- stderr ---\nboom\nlast line");
		}
	});

	test("a timed-out install throws, even when its code is 5", async () => {
		const f = fixture({ code: 5, out: "", err: "", timedOut: true });
		await expect(installProfile(f.deps)).rejects.toThrow(/install\.sh exited 5 \(timed out\)/);
	});

	test("exit 5 with no profile written still throws: the profile is what setup needs", async () => {
		const f = fixture({ code: 5, out: "", err: DOCTOR_FAILED_ERR, timedOut: false }, false);
		await expect(installProfile(f.deps)).rejects.toThrow(`install.sh wrote no profile at ${f.agentDir}`);
	});
});
