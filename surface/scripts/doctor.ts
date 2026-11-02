#!/usr/bin/env bun
// as2 doctor (PLAN wl-mvwks11ye3x9zu): whether as2's important parts are up. Run it from a plain terminal (`as2 doctor`);
// install/install.sh runs it last, the doctor job runs `--after-restart`, the train tick runs the ctx step in-process.
// The checks, episodes and popups are in surface/src/doctor.ts.
//
//   bun surface/scripts/doctor.ts                 every part: one line each (pass / fail / warn / -), its evidence and fix,
//                                                 then a summary; writes `doctor-up:` for parts that pass with an open
//                                                 episode, and starts the popup process for pending downs
//   bun surface/scripts/doctor.ts --json          the same, as one JSON object on stdout
//   bun surface/scripts/doctor.ts --after-restart the doctor job (RunAtLoad, every 600 s): re-checks parts with an open
//                                                 episode and clears those that pass; once per boot, after 10 min of
//                                                 uptime, checks every part and opens a down for each failure; one log
//                                                 line per run (its heartbeat)
//   bun surface/scripts/doctor.ts --tick          internal: the ctx part and its two-tick episode (the train tick runs
//                                                 the same step in-process)
//   bun surface/scripts/doctor.ts --popup         internal: the popup process; claims every pending down, shows the
//                                                 alarm rule's popup, writes the outcome
//
// Env: AGENT_SYSTEM_LEDGER_DB (default ~/.agent-system-2/ledger.db), AGENT_SYSTEM_PROFILE (default agent-system-2),
// HOME, PATH (every probe resolves on it). AS2_DOCTOR_POPUP_WAIT=1 is a test seam: the popup process runs in the
// foreground and the run waits for it.
// Exit, in every mode: 0 nothing failed, 1 a part failed or the doctor detected and reported a failure of its own (the
// popup failed, an alert could not be written, a probe, kill or spawn failed, the ledger could not be closed), 2 a bad
// argument (--help included: it checks nothing, so it is not a 0) or the doctor itself crashed. A crash after parts were
// checked prints what the run had collected first, then the crash.
import { join, resolve } from "node:path";
import { defaultLedgerPath, Ledger } from "../../ledger/src/index";
import { DoctorCrash, type DoctorDeps, doctorTick, type PartResult, partLine, popupRun, realDeps, type RunOutcome, runAfterRestart, runDefault, thenClose } from "../src/doctor";

const USAGE = "usage: bun surface/scripts/doctor.ts [--json | --after-restart | --tick | --popup]";

const MODES = ["default", "json", "after-restart", "tick", "popup"] as const;
export type Mode = (typeof MODES)[number];

/** The mode, or why the arguments are refused (exit 2). */
export function parseMode(argv: readonly string[]): Mode | string {
	if (argv.length === 0) return "default";
	if (argv.length > 1) return `one flag at most; got ${argv.join(" ")}`;
	const flags: Record<string, Mode> = { "--json": "json", "--after-restart": "after-restart", "--tick": "tick", "--popup": "popup" };
	return flags[argv[0]!] ?? `unknown argument ${argv[0]}`;
}

/** The default mode's last line; a run that failed with no failing part (a write, spawn, kill, probe or close) says so. */
function summary(o: { exit: number; results: readonly PartResult[] }): string {
	const count = (v: string) => o.results.filter((r) => r.verdict === v).length;
	const failed = o.results.filter((r) => r.verdict === "fail").map((r) => r.part);
	const own = o.exit !== 0 && failed.length === 0 ? "; the run failed: see the doctor: lines above" : "";
	return `as2 doctor: ${count("pass")} pass, ${count("fail")} fail${failed.length ? ` (${failed.join(", ")})` : ""}, ${count("warn")} warn, ${count("not installed")} not installed${own}`;
}

/** A run's output in its mode; `crash` when the run crashed after collecting `o` (the crash itself goes to stderr, exit 2). */
function report(mode: "default" | "json" | "after-restart", o: { exit: number; results: readonly PartResult[]; notes: readonly string[] }, deps: DoctorDeps, at: string, crash: string | null): void {
	if (mode === "default") {
		for (const r of o.results) deps.out(partLine(r));
		for (const n of o.notes) deps.out(n);
		deps.out(crash === null ? summary(o) : `as2 doctor: crashed after the lines above (${crash}); they are what the run had collected`);
	} else if (mode === "json") {
		deps.out(JSON.stringify({ at, exit: o.exit, parts: o.results, notes: o.notes, ...(crash === null ? {} : { crash }) }));
	} else {
		const failed = o.results.filter((r) => r.verdict === "fail").map((r) => `${r.part} (${r.evidence})`);
		deps.out(`${at} doctor --after-restart: ${o.results.length} part(s) checked, ${failed.length} failing${failed.length ? `: ${failed.join("; ")}` : ""}${o.notes.length ? `; ${o.notes.join("; ")}` : ""}${crash === null ? "" : `; crashed: ${crash}`}`);
	}
}

export async function main(argv: readonly string[], deps: DoctorDeps): Promise<number> {
	const mode = parseMode(argv);
	if (!(MODES as readonly string[]).includes(mode)) {
		process.stderr.write(argv.includes("--help") || argv.includes("-h") ? `${USAGE}\n` : `doctor: ${mode}\n${USAGE}\n`);
		return 2;
	}
	const stamp = () => new Date(deps.now()).toISOString();
	switch (mode as Mode) {
		case "default":
		case "json":
		case "after-restart": {
			const m = mode as "default" | "json" | "after-restart";
			let o: RunOutcome;
			try {
				o = await (m === "after-restart" ? runAfterRestart(deps) : runDefault(deps));
			} catch (e) {
				if (!(e instanceof DoctorCrash)) throw e;
				report(m, { exit: 2, results: e.results, notes: e.notes }, deps, stamp(), e.crash instanceof Error ? e.crash.message : String(e.crash));
				throw e.crash;
			}
			report(m, o, deps, stamp(), null);
			return o.exit;
		}
		case "tick": {
			const out = (l: string) => deps.out(`${stamp()} ${l}`);
			let ledger: Ledger | null = null;
			let openError: string | null = null;
			try {
				ledger = Ledger.open(deps.ledgerPath, { backupOnOpen: false, clock: () => stamp() });
			} catch (e) {
				openError = e instanceof Error ? e.message : String(e);
			}
			if (ledger === null) {
				doctorTick(null, { ...deps, out }, openError);
				return 1;
			}
			const opened = ledger;
			const { value: r, closeError } = thenClose(opened, "the doctor's ctx step", () => doctorTick(opened, { ...deps, out }));
			if (closeError !== null) out(`doctor: the ledger ${deps.ledgerPath} could not be closed after the ctx step: ${closeError}`);
			return closeError !== null || r.failed || r.results.some((x) => x.verdict === "fail") ? 1 : 0;
		}
		case "popup": {
			const out = (l: string) => deps.out(`${stamp()} ${l}`);
			const ledger = Ledger.open(deps.ledgerPath, { backupOnOpen: false, clock: () => stamp() });
			const { value: code, closeError } = thenClose(ledger, "the popup process", () => popupRun(ledger, { ...deps, out }));
			if (closeError !== null) out(`doctor popup: the ledger ${deps.ledgerPath} could not be closed: ${closeError}`);
			return closeError !== null ? 1 : code;
		}
	}
	return 2;
}

if (import.meta.main) {
	try {
		const deps = realDeps({
			env: process.env,
			repo: resolve(import.meta.dir, "..", ".."),
			doctorScript: join(import.meta.dir, "doctor.ts"),
			ledgerPath: defaultLedgerPath(process.env),
			out: (l) => process.stdout.write(`${l}\n`),
		});
		process.exitCode = await main(process.argv.slice(2), deps);
	} catch (e) {
		process.stderr.write(`doctor: crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
		process.exitCode = 2;
	}
}
