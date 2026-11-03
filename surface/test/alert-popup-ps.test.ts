// The popup worker's identity rule (PLAN wl-mw0vs9uc3xqtka D3, R12, R24).
import { describe, expect, test } from "bun:test";

describe("ps -E on this machine (D3: the popup identity rests on it)", () => {
	test("an orphaned grandchild's inherited AS2_ALERT_POPUP is visible in `ps -A -E -ww -o pid=,ppid=,pgid=,lstart=,command=`", async () => {
		const tag = `ep-pscheck${process.pid}:2:1`;
		// A child shell starts a grandchild (sleep) in the background, prints its pid and exits, so the grandchild is
		// reparented. The variable is set only on the child; the grandchild has it by inheritance alone. Its streams go to
		// /dev/null so the pipe closes when the child exits.
		const child = Bun.spawn(["/bin/sh", "-c", "/bin/sleep 30 </dev/null >/dev/null 2>&1 & echo $!; exit 0"], {
			env: { PATH: "/usr/bin:/bin", AS2_ALERT_POPUP: tag },
			stdin: "ignore", stdout: "pipe", stderr: "pipe",
		});
		const out = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		const gc = Number(out.trim());
		expect(Number.isInteger(gc) && gc > 0).toBe(true);
		try {
			const ps = Bun.spawnSync(["ps", "-A", "-E", "-ww", "-o", "pid=,ppid=,pgid=,lstart=,command="], { stdout: "pipe", stderr: "pipe" });
			expect({ code: ps.exitCode, stderr: ps.stderr.toString() }).toEqual({ code: 0, stderr: "" });
			const line = ps.stdout.toString().split("\n").find((l) => l.trim().split(/\s+/)[0] === String(gc));
			expect(line).toBeDefined();
			const [, ppid] = line!.trim().split(/\s+/);
			// The parent shell is gone: the grandchild is an orphan (reparented away from the exited shell).
			expect(ppid).not.toBe(String(child.pid));
			expect(line!).toContain(`AS2_ALERT_POPUP=${tag}`);
		} finally {
			process.kill(gc, "SIGKILL");
		}
	});
});
