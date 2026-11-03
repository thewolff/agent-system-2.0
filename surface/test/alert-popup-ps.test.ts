// The popup's identity rule on the real ps (PLAN wl-mw0vs9uc3xqtka D3, R12, R24; Jo's registry rule, q-mw175xfx2etc13):
// a helper quiet-alarm.zsh recorded by pid and lstart is found by the pass's own ps read after its shell is gone. The
// record is made by quiet-alarm.zsh's own registration code (the block between its `# ---- registration: start` and
// `# ---- registration: end` markers, run as is), with its default /bin/ps. Real processes and the real /bin/ps, so it runs
// only where /bin/ps can be executed: outside a lane's fence (its setuid exec is EPERM inside), in the full suite.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveMembers, parsePs, PS_ARGS, readRegistry } from "../scripts/alert-popup";
import { realPs } from "../scripts/alert-tick";
import { quietAlarmPath } from "../src/notify";
import { tmp } from "./helpers";

function canRunPs(): boolean {
	try {
		return Bun.spawnSync(["/bin/ps", "-p", String(process.pid), "-o", "pid="], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
	} catch {
		return false; // EPERM posix_spawn: the setuid /bin/ps under the fence
	}
}
const REAL_PS = canRunPs();

/** quiet-alarm.zsh's registration code, cut at its markers; throws naming the file when a marker is missing. */
function registrationBlock(): string {
	const path = quietAlarmPath(join(import.meta.dir, "..", ".."));
	const text = readFileSync(path, "utf8");
	const start = text.indexOf("# ---- registration: start");
	const end = text.indexOf("# ---- registration: end");
	if (start < 0 || end < start) throw new Error(`${path} lost its "# ---- registration: start" / "end" markers`);
	return text.slice(start, end);
}

describe.skipIf(!REAL_PS)("the registry on the real ps (outside the fence only: /bin/ps is EPERM inside)", () => {
	test("an orphaned /bin/sleep recorded the way quiet-alarm.zsh records a helper is a member in the pass's `ps -A -ww -o pid=,ppid=,pgid=,lstart=,command=` read, by its pid and lstart", () => {
		const reg = join(tmp("alert-popup-ps"), "ep-pscheck.2.1.pids");
		// The shell backgrounds the sleep (its streams to /dev/null, so the pipe closes when the shell exits), prints its
		// pid, records it with quiet-alarm.zsh's `register`, and exits: the sleep is reparented, an orphan.
		const script = `${registrationBlock()}
/bin/sleep 30 </dev/null >/dev/null 2>&1 &
p=$!
print -r -- $p
register $p sleep || exit 3
exit 0
`;
		const sh = Bun.spawnSync(["/bin/zsh", "-c", script], { env: { PATH: "/usr/bin:/bin", QUIET_ALARM_REGISTER: reg }, stdout: "pipe", stderr: "pipe" });
		const gc = Number(sh.stdout.toString().trim());
		try {
			expect({ code: sh.exitCode, stderr: sh.stderr.toString() }).toEqual({ code: 0, stderr: "" });
			expect(Number.isInteger(gc) && gc > 0).toBe(true);
			const recorded = readRegistry(reg);
			expect(recorded.map((r) => [r.pid, r.name])).toEqual([[gc, "sleep"]]);
			const procs = parsePs(realPs([...PS_ARGS]));
			const members = liveMembers(null, recorded, procs);
			expect(members.map((m) => m.pid)).toEqual([gc]);
			expect(members[0]!.lstart).toBe(recorded[0]!.lstart);
			// The recording shell is gone: the sleep is an orphan (reparented away from it).
			expect(members[0]!.ppid).not.toBe(sh.pid);
			expect(members[0]!.command).toBe("/bin/sleep 30");
		} finally {
			if (Number.isInteger(gc) && gc > 0) process.kill(gc, "SIGKILL");
		}
	});
});
