// Ilex resumes its designated conversation (PLAN wl-mv8wzipdczs2rk D1): bin/as2 asks
// surface/scripts/orchestrator-session.ts which file to resume, from the ledger's `orchestrator-session:`
// pointers and never a session-folder scan; Jo's own session choice, read by OMP's real installed parseArgs,
// adds nothing; AGENT_SYSTEM_AS2_LAUNCH=1 reaches omp only for Ilex launches; a resuming launch refuses,
// in three fixed lines per pid, while Ilex runs. Every case runs bin/as2 under sh with a scratch HOME, a
// scratch ledger, and a fake omp, pgrep and ps first on PATH. The fake omp sits in a package whose `src` is
// the installed OMP package's own, so the parser as2 imports is the real one. With no omp on PATH (the
// outside-the-fence test runner) every case is skipped, visibly: there is no real parser to read args with.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { NO_CONVERSATION_LINE } from "../scripts/orchestrator-session";
import { ensureStandingWorkload } from "../src/identity";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { tmp } from "./helpers";

const REPO = realpathSync(join(import.meta.dir, "..", ".."));
const AS2 = join(REPO, "bin", "as2");
const OMP_ON_PATH = Bun.which("omp");
const SKIP_REASON = OMP_ON_PATH ? "" : " [skipped: no omp on PATH]";
const OMP_PKG = OMP_ON_PATH ? dirname(dirname(realpathSync(OMP_ON_PATH))) : "";
const PATTERN = `omp --cwd ${REPO.replace(/[\][\\.*^$+?(){}|]/g, "\\$&")} --append-system-prompt`;
const SLOW = 60_000;

interface Running {
	pid: string;
	/** ps -o command=; empty: the process ended between pgrep and ps; "!blocked": ps itself is refused (exit 126). */
	command: string;
	lstart: string;
}

interface Setup {
	/** Pointer files, oldest first, as `orchestrator-session:` entries by the surface. */
	pointers?: string[];
	/** Processes the fake pgrep reports. */
	running?: Running[];
	/** A plain `omp` script on PATH, in no package: the parser cannot be imported. */
	noPackage?: boolean;
}

/** A scratch world for one as2 run: HOME, ledger, session folder, and the fake commands on PATH. */
function world(setup: Setup = {}) {
	const home = tmp("as2home");
	const bin = tmp("as2bin");
	const out = tmp("as2out");
	const sessions = join(home, ".omp", "profiles", "agent-system-2", "agent", "sessions", "-code-agent-system-2.0");
	mkdirSync(sessions, { recursive: true });
	const db = join(tmp("as2ledger"), "ledger.db");
	const ledger = Ledger.open(db, { create: true, backup: false, backupOnOpen: false });
	ensureStandingWorkload(ledger);
	for (const file of setup.pointers ?? []) {
		ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: `orchestrator-session: ${file} 01a1-${file.length}` });
	}
	ledger.close();

	const omp = `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}/argv'\nprintf '%s' "\${AGENT_SYSTEM_AS2_LAUNCH-unset}" > '${out}/launch-env'\n`;
	if (setup.noPackage) {
		writeFileSync(join(bin, "omp"), omp);
		chmodSync(join(bin, "omp"), 0o755);
	} else {
		const pkg = tmp("as2pkg");
		mkdirSync(join(pkg, "dist"));
		writeFileSync(join(pkg, "dist", "cli.js"), omp);
		chmodSync(join(pkg, "dist", "cli.js"), 0o755);
		symlinkSync(join(OMP_PKG, "src"), join(pkg, "src"));
		symlinkSync(join(pkg, "dist", "cli.js"), join(bin, "omp"));
	}
	const running = setup.running ?? [];
	writeFileSync(join(out, "pids"), running.map((r) => `${r.pid}\n`).join(""));
	for (const r of running) {
		if (r.command === "!blocked") {
			writeFileSync(join(out, `ps-${r.pid}-blocked`), "");
			continue;
		}
		writeFileSync(join(out, `ps-${r.pid}-command`), r.command === "" ? "" : `${r.command}\n`);
		writeFileSync(join(out, `ps-${r.pid}-lstart`), r.command === "" ? "" : `${r.lstart}\n`);
	}
	writeFileSync(join(bin, "pgrep"), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${out}/pgrep-log'\n[ -s '${out}/pids' ] || exit 1\ncat '${out}/pids'\n`);
	writeFileSync(join(bin, "ps"), `#!/bin/sh\npid=""; field=""\nwhile [ "$#" -gt 0 ]; do case "$1" in -p) pid="$2"; shift ;; -o) field="\${2%=}"; shift ;; esac; shift; done\n[ -f '${out}'/ps-"$pid"-blocked ] && exit 126\n[ -f '${out}'/ps-"$pid"-"$field" ] && cat '${out}'/ps-"$pid"-"$field"\nexit 0\n`);
	chmodSync(join(bin, "pgrep"), 0o755);
	chmodSync(join(bin, "ps"), 0o755);

	const prompt = join(home, ".agent-system-2", "orchestrator", "system.md");
	const read = (name: string): string | null => (existsSync(join(out, name)) ? readFileSync(join(out, name), "utf8") : null);
	return {
		sessions,
		prompt,
		run(args: string[]) {
			const r = Bun.spawnSync(["sh", AS2, ...args], { env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, AGENT_SYSTEM_LEDGER_DB: db } });
			return {
				code: r.exitCode,
				stdout: r.stdout.toString(),
				stderr: r.stderr.toString(),
				/** omp's argv after `--cwd <repo> --append-system-prompt <prompt>`, or null when omp never ran. */
				after: (): string[] | null => {
					const argv = read("argv")?.trimEnd().split("\n") ?? null;
					if (argv === null) return null;
					expect(argv.slice(0, 4)).toEqual(["--cwd", REPO, "--append-system-prompt", prompt]);
					return argv.slice(4);
				},
				launchEnv: () => read("launch-env"),
				/** Each pgrep argv, flattened: `-f` then the pattern, per call. */
				pgrep: () => read("pgrep-log")?.trimEnd().split("\n") ?? [],
			};
		},
	};
}

interface SessionShape {
	cwd?: string;
	/** An assistant message after the user's. */
	replied?: boolean;
	/** Only the title and the session header: a `/new` quit before its first reply. */
	headerOnly?: boolean;
	/** `surface-wake` messages appended. */
	wakes?: number;
}

/** An OMP session file in the shape OMP writes (title line, `session` header, then entries). */
function session(dir: string, name: string, s: SessionShape = {}): string {
	const file = join(dir, `${name}.jsonl`);
	const lines: unknown[] = [
		{ type: "title", v: 1, title: "" },
		{ type: "session", version: 3, id: `id-${name}`, timestamp: "2026-10-14T10:00:00.000Z", cwd: s.cwd ?? REPO },
	];
	if (!s.headerOnly) {
		lines.push({ type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hi" }] } });
		if (s.replied ?? true) lines.push({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
		for (let i = 0; i < (s.wakes ?? 0); i++) lines.push({ type: "custom_message", id: `w${i}`, customType: "surface-wake", content: "(wake: restart)" });
	}
	writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return file;
}

describe.skipIf(!OMP_ON_PATH)(`the pointer chooses the conversation; no session folder is scanned${SKIP_REASON}`, () => {
	test("the pointer's file is resumed even when a newer wake-bearing session for the same cwd exists", () => {
		const dir = tmp("sess");
		const ilex = session(dir, "a-ilex", { wakes: 2 });
		const w = world({ pointers: [ilex] });
		session(w.sessions, "z-probe", { wakes: 5 });
		session(dir, "z-newer", { wakes: 9 });
		const r = w.run([]);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(r.after()).toEqual([`--resume=${ilex}`]);
		expect(r.launchEnv()).toBe("1");
		expect(r.pgrep()).toEqual(["-f", PATTERN]);
	}, SLOW);

	test("a newest pointer to a missing file falls back to the previous valid one, both named on stderr", () => {
		const dir = tmp("sess");
		const good = session(dir, "good");
		const gone = join(dir, "gone.jsonl");
		const r = world({ pointers: [good, gone] }).run([]);
		expect(r.stderr).toBe(`as2: the recorded Ilex conversation ${gone} cannot be resumed (the file is missing)\nas2: resuming the previous recorded Ilex conversation: ${good}\n`);
		expect(r.after()).toEqual([`--resume=${good}`]);
		expect(r.launchEnv()).toBe("1");
	}, SLOW);

	test("a newest pointer to a header-only file (a /new quit before its first reply) falls back the same way", () => {
		const dir = tmp("sess");
		const good = session(dir, "good");
		const fresh = session(dir, "new", { headerOnly: true });
		const r = world({ pointers: [good, fresh] }).run([]);
		expect(r.stderr).toBe(`as2: the recorded Ilex conversation ${fresh} cannot be resumed (no assistant message yet)\nas2: resuming the previous recorded Ilex conversation: ${good}\n`);
		expect(r.after()).toEqual([`--resume=${good}`]);
	}, SLOW);

	test("only invalid pointers: a new conversation with the no-recorded-conversation line, never a pick from the folder", () => {
		const dir = tmp("sess");
		const other = session(dir, "other-cwd", { cwd: "/somewhere/else", wakes: 4 });
		const quiet = session(dir, "no-reply", { replied: false });
		const folder = join(dir, "a-directory.jsonl");
		mkdirSync(folder);
		const w = world({ pointers: [other, quiet, folder] });
		for (const n of ["many-1", "many-2", "many-3"]) session(w.sessions, n, { wakes: 12 });
		const r = w.run([]);
		expect(r.stderr).toBe(
			[
				`as2: the recorded Ilex conversation ${folder} cannot be resumed (not a regular file)`,
				`as2: the recorded Ilex conversation ${quiet} cannot be resumed (no assistant message yet)`,
				`as2: the recorded Ilex conversation ${other} cannot be resumed (its session cwd is /somewhere/else, not ${REPO})`,
				NO_CONVERSATION_LINE,
				"",
			].join("\n"),
		);
		expect(r.code).toBe(0);
		expect(r.after()).toEqual([]);
		expect(r.launchEnv()).toBe("1");
		expect(r.pgrep()).toEqual([]);
	}, SLOW);

	test("no pointer at all: a new conversation, said on stderr, though the folder holds many-wake files", () => {
		const w = world();
		for (const n of ["many-1", "many-2"]) session(w.sessions, n, { wakes: 12 });
		const r = w.run([]);
		expect(r.stderr).toBe(`${NO_CONVERSATION_LINE}\n`);
		expect(r.after()).toEqual([]);
		expect(r.launchEnv()).toBe("1");
	}, SLOW);

	test("--fresh is not an as2 word: it goes to omp like any other arg, and the pointer still resumes", () => {
		const good = session(tmp("sess"), "good");
		const r = world({ pointers: [good] }).run(["--fresh"]);
		expect(r.after()).toEqual([`--resume=${good}`, "--fresh"]);
	}, SLOW);
});

describe.skipIf(!OMP_ON_PATH)(`Jo's session choice, read by OMP's own parser: as2 adds no --resume${SKIP_REASON}`, () => {
	const ilexLaunch = [["-c"], ["--continue"], ["-r"], ["--resume"], ["--resume=f.jsonl"], ["--session", "f.jsonl"], ["--session=f.jsonl"]];
	const independent = [["--session-dir", "/tmp/elsewhere"], ["--no-session"], ["--fork", "f.jsonl"], ["--from-claude"], ["--from-codex"], ["--goal", "ship it"]];

	test("resume and continue forms: argv as given, the env set, the running-Ilex check made", () => {
		const good = session(tmp("sess"), "good");
		for (const args of ilexLaunch) {
			const r = world({ pointers: [good] }).run(args);
			expect({ args, stderr: r.stderr, code: r.code, after: r.after(), env: r.launchEnv(), pgrep: r.pgrep() }).toEqual({ args, stderr: "", code: 0, after: args, env: "1", pgrep: ["-f", PATTERN] });
		}
	}, SLOW);

	test("independent sessions (--session-dir, --no-session, --fork, --from-*, --goal): argv as given, no env, no check", () => {
		const good = session(tmp("sess"), "good");
		for (const args of independent) {
			const r = world({ pointers: [good] }).run(args);
			expect({ args, stderr: r.stderr, after: r.after(), env: r.launchEnv(), pgrep: r.pgrep() }).toEqual({ args, stderr: "", after: args, env: "unset", pgrep: [] });
		}
	}, SLOW);

	test("--resume as a message or a consumed value still auto-resumes: -- --resume, --append-system-prompt --resume, --prompt-cache-key --resume", () => {
		const good = session(tmp("sess"), "good");
		for (const args of [["--", "--resume"], ["--append-system-prompt", "--resume"], ["--prompt-cache-key", "--resume"]]) {
			const r = world({ pointers: [good] }).run(args);
			expect({ args, after: r.after(), env: r.launchEnv() }).toEqual({ args, after: [`--resume=${good}`, ...args], env: "1" });
		}
	}, SLOW);

	test("a parser as2 cannot import (a PATH omp in no package): one stderr line naming why, and today's argv", () => {
		const good = session(tmp("sess"), "good");
		const r = world({ pointers: [good], noPackage: true }).run(["--model", "x"]);
		expect(r.stderr).toStartWith("as2: cannot read your arguments with omp's own parser (cannot import ");
		expect(r.stderr).toEndWith("); launching them as given, without resuming Ilex's conversation\n");
		expect(r.stderr.split("\n")).toHaveLength(2);
		expect(r.code).toBe(0);
		expect(r.after()).toEqual(["--model", "x"]);
		expect(r.launchEnv()).toBe("unset");
		expect(r.pgrep()).toEqual([]);
	}, SLOW);
});

describe.skipIf(!OMP_ON_PATH)(`a resuming launch while Ilex runs: exit 1, omp not run, three lines per pid${SKIP_REASON}`, () => {
	const longCommand = `omp --cwd ${REPO} --append-system-prompt /Users/x/.agent-system-2/orchestrator/system.md --resume=/Users/x/.omp/profiles/agent-system-2/agent/sessions/s.jsonl`;
	const lines = (pid: string, lstart: string, command: string) => [
		`as2: Ilex is already running (pid ${pid}, started ${lstart}): ${command.slice(0, 120)}`,
		"as2: two Ilex processes on one conversation would corrupt it, so this as2 did not start.",
		`as2: quit that Ilex (/exit in its terminal), or run: kill ${pid} — then run as2 again.`,
	];

	test("as2's own resume: the three lines verbatim, the command cut to 120 characters", () => {
		expect(longCommand.length).toBeGreaterThan(120);
		const good = session(tmp("sess"), "good");
		const r = world({ pointers: [good], running: [{ pid: "66571", command: longCommand, lstart: "Wed Oct 14 09:12:03 2026" }] }).run([]);
		expect(r.code).toBe(1);
		expect(r.stderr).toBe(`${lines("66571", "Wed Oct 14 09:12:03 2026", longCommand).join("\n")}\n`);
		expect(r.after()).toBeNull();
		expect(r.pgrep()).toEqual(["-f", PATTERN]);
	}, SLOW);

	test("Jo's explicit resume, two running: one line set per pid; a pid gone before ps looks is not named", () => {
		const r = world({
			running: [
				{ pid: "101", command: "omp --cwd r --append-system-prompt p", lstart: "Tue Oct 13 08:00:00 2026" },
				{ pid: "102", command: "", lstart: "" },
				{ pid: "103", command: "omp --cwd r --append-system-prompt p -c", lstart: "Tue Oct 13 09:00:00 2026" },
			],
		}).run(["--resume", "x.jsonl"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toBe(`${[...lines("101", "Tue Oct 13 08:00:00 2026", "omp --cwd r --append-system-prompt p"), ...lines("103", "Tue Oct 13 09:00:00 2026", "omp --cwd r --append-system-prompt p -c")].join("\n")}\n`);
		expect(r.after()).toBeNull();
	}, SLOW);

	test("only gone pids: the launch goes ahead", () => {
		const good = session(tmp("sess"), "good");
		const r = world({ pointers: [good], running: [{ pid: "102", command: "", lstart: "" }] }).run([]);
		expect(r.code).toBe(0);
		expect(r.after()).toEqual([`--resume=${good}`]);
	}, SLOW);

	test("ps refused (a sandbox): the pid pgrep found still counts, named with what as2 could not read", () => {
		const good = session(tmp("sess"), "good");
		const r = world({ pointers: [good], running: [{ pid: "13037", command: "!blocked", lstart: "" }] }).run([]);
		expect(r.code).toBe(1);
		expect(r.stderr).toBe(`${lines("13037", "unknown", "(ps could not read its command line)").join("\n")}\n`);
		expect(r.after()).toBeNull();
	}, SLOW);

	test("a launch that does not resume (a new conversation, --no-session) makes no check", () => {
		const running = [{ pid: "66571", command: longCommand, lstart: "Wed Oct 14 09:12:03 2026" }];
		for (const args of [[], ["--no-session"]]) {
			const r = world({ running }).run(args);
			expect({ args, code: r.code, after: r.after(), pgrep: r.pgrep() }).toEqual({ args, code: 0, after: args, pgrep: [] });
		}
	}, SLOW);
});

describe.skipIf(!OMP_ON_PATH)(`--print shows the launch's own env and argv, without the check or omp${SKIP_REASON}`, () => {
	test("plain: the env variable and as2's --resume=<file>, as the launch passes them", () => {
		const good = session(tmp("sess"), "good");
		const w = world({ pointers: [good], running: [{ pid: "66571", command: "omp", lstart: "Wed Oct 14 09:12:03 2026" }] });
		const p = w.run(["--print", "--model", "x"]);
		expect(p.code).toBe(0);
		expect(p.stdout).toBe(`env -u AGENT_SYSTEM_AS2_LAUNCH OMP_PROFILE=agent-system-2 AGENT_SYSTEM_ROLE=orchestrator AGENT_SYSTEM_AS2_LAUNCH=1 omp --cwd ${REPO} --append-system-prompt ${w.prompt} --resume=${good} --model x\n`);
		expect(p.after()).toBeNull();
		expect(p.pgrep()).toEqual([]);
	}, SLOW);

	test("an independent session: no env variable, no --resume", () => {
		const good = session(tmp("sess"), "good");
		const w = world({ pointers: [good] });
		const p = w.run(["--print", "--no-session"]);
		expect(p.stdout).toBe(`env -u AGENT_SYSTEM_AS2_LAUNCH OMP_PROFILE=agent-system-2 AGENT_SYSTEM_ROLE=orchestrator omp --cwd ${REPO} --append-system-prompt ${w.prompt} --no-session\n`);
	}, SLOW);
});
