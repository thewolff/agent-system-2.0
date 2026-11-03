// install/phoenix-run.sh's watch (wl-mv65t5d34lts00 PLAN.md §§ 3, 8.3), against a fake Phoenix: PHOENIX_PYTHON is a
// script that runs bun on a listener binding PHOENIX_PORT and PHOENIX_GRPC_PORT the way the shim does, and answers
// the wrapper's footprint samples (`<python> -I -S phoenix-footprint.py <pid>`) from FAKE_FOOTPRINT. The sampler
// itself is tested against a real Python holding incompressible bytes.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmp } from "./helpers";

const INSTALL = resolve(import.meta.dir, "..", "..", "install");
const RUN = join(INSTALL, "phoenix-run.sh");
const FOOTPRINT = join(INSTALL, "phoenix-footprint.py");

const dir = tmp("phoenix-run");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const listener = join(dir, "listen.ts");
writeFileSync(
	listener,
	[
		"const socket = { data() {} };",
		'Bun.listen({ hostname: "127.0.0.1", port: Number(process.env.PHOENIX_PORT), socket });',
		'Bun.listen({ hostname: process.env.FAKE_GRPC_HOST ?? "127.0.0.1", port: Number(process.env.PHOENIX_GRPC_PORT), socket });',
		"",
	].join("\n"),
);
const fakePython = join(dir, "python");
writeFileSync(
	fakePython,
	[
		"#!/bin/sh",
		'case "$3" in',
		'\t*/phoenix-footprint.py) printf "%s\\n" "${FAKE_FOOTPRINT:-1024}"; exit 0 ;;',
		"esac",
		`exec "${process.execPath}" "${listener}"`,
		"",
	].join("\n"),
);
chmodSync(fakePython, 0o755);

/** Runs the wrapper on two free ports until its log matches `until` or it exits; then stops it with TERM. */
async function runWrapper(until: RegExp, extraEnv: Record<string, string> = {}, timeoutMs = 20_000) {
	const [port, grpc] = [0, 0].map(() => {
		const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		const free = s.port;
		s.stop(true);
		return free;
	});
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("PHOENIX_") && !k.startsWith("FAKE_")) env[k] = v;
	const proc = Bun.spawn(["/bin/bash", RUN], {
		env: { ...env, ...extraEnv, PHOENIX_PYTHON: fakePython, PHOENIX_PORT: String(port), PHOENIX_GRPC_PORT: String(grpc) },
		stdout: "pipe",
		stderr: "pipe",
	});
	let log = "";
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + timeoutMs;
	let next = reader.read();
	while (!until.test(log) && Date.now() < deadline) {
		// A real-process wait: the wrapper's log is the only signal, so each read races the deadline, never a fixed sleep.
		const chunk = await Promise.race([next, Bun.sleep(deadline - Date.now()).then(() => null)]);
		if (chunk === null || chunk.done) break;
		log += decoder.decode(chunk.value);
		next = reader.read();
	}
	if (proc.exitCode === null) proc.kill("SIGTERM");
	for (let chunk = await next; !chunk.done; chunk = await reader.read()) log += decoder.decode(chunk.value);
	return { port, grpc, log, exit: await proc.exited };
}

test("both listeners on 127.0.0.1, side by side in lsof's list, count as bound; TERM stops it with 143", async () => {
	const r = await runWrapper(/phoenix-run\[\d+\]: bound:/);
	expect(r.log).toMatch(new RegExp(`bound: (127\\.0\\.0\\.1:${r.port} 127\\.0\\.0\\.1:${r.grpc}|127\\.0\\.0\\.1:${r.grpc} 127\\.0\\.0\\.1:${r.port})\\n`));
	expect(r.log).not.toContain("bind check:");
	expect(r.log).not.toContain("memory cap:");
	expect(r.exit).toBe(143);
}, 30_000);

test("a gRPC listener on every address is refused: Phoenix killed, exit 78", async () => {
	const r = await runWrapper(/bind check: Phoenix killed; exit 78/, { FAKE_GRPC_HOST: "0.0.0.0" });
	expect(r.log).toMatch(new RegExp(`listens on \\*:${r.grpc}, not 127\\.0\\.0\\.1`));
	expect(r.log).not.toContain("bound:");
	expect(r.exit).toBe(78);
}, 30_000);

test("a footprint sample over the cap: Phoenix killed at once, exit 75; one at the cap is not over", async () => {
	const at = await runWrapper(/phoenix-run\[\d+\]: bound:/, { PHOENIX_MEM_CAP_MB: "2", FAKE_FOOTPRINT: "2048" });
	expect(at.log).not.toContain("memory cap:");
	expect(at.exit).toBe(143);
	const over = await runWrapper(/memory cap: Phoenix killed; exit 75/, { PHOENIX_MEM_CAP_MB: "2", FAKE_FOOTPRINT: "2049" });
	expect(over.log).toMatch(/memory cap: footprint sample 2049 KiB > cap 2048 KiB \(2 MiB\); SIGKILL Phoenix pid \d+\n/);
	expect(over.exit).toBe(75);
}, 30_000);

test("a footprint the sampler cannot give fails closed: Phoenix killed, exit 78", async () => {
	const r = await runWrapper(/memory cap: Phoenix killed; exit 78/, { FAKE_FOOTPRINT: "proc_pid_rusage(1) failed: errno 1 (Operation not permitted)" });
	expect(r.log).toMatch(/memory cap: cannot sample Phoenix pid \d+'s footprint \(sampler said: proc_pid_rusage\(1\) failed: errno 1 \(Operation not permitted\)\); the cap cannot be enforced; SIGKILL\n/);
	expect(r.exit).toBe(78);
}, 30_000);

// The real sampler against a Python process holding incompressible bytes: the footprint counts them wherever the
// kernel keeps them (RSS on a machine under memory pressure does not; PLAN.md § 8.3).
const PYTHON3 = "/usr/bin/python3";
const python3Works = (() => {
	try {
		return Bun.spawnSync([PYTHON3, "-I", "-S", "-c", "pass"]).exitCode === 0;
	} catch {
		return false;
	}
})();

test.skipIf(!python3Works)("phoenix-footprint.py reports a process's footprint in KiB, held random bytes included; a missing pid exits 1", async () => {
	const holder = Bun.spawn([PYTHON3, "-I", "-S", "-c", "import os, sys, time\nb = os.urandom(256 << 20)\nprint('held', flush=True)\nsys.stdin.read()"], {
		stdin: "pipe",
		stdout: "pipe",
	});
	try {
		const reader = holder.stdout.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe("held\n");
		const r = Bun.spawnSync([PYTHON3, "-I", "-S", FOOTPRINT, String(holder.pid)]);
		expect(r.exitCode).toBe(0);
		const kib = Number(r.stdout.toString().trim());
		expect(kib).toBeGreaterThanOrEqual(256 * 1024);
		expect(kib).toBeLessThan(1024 * 1024);
	} finally {
		holder.kill("SIGKILL");
		await holder.exited;
	}
	const gone = Bun.spawnSync([PYTHON3, "-I", "-S", FOOTPRINT, String(holder.pid)]);
	expect(gone.exitCode).toBe(1);
	expect(gone.stderr.toString()).toMatch(new RegExp(`^proc_pid_rusage\\(${holder.pid}\\) failed: errno 3 \\(No such process\\)\\n$`));
}, 30_000);
