#!/usr/bin/env bun
// drive-backup-notice: the nightly Drive backup's needs-you writer (PLAN wl-mvwkt821jx4d6e slice 3, R5). The two launchd jobs
// (install/drive-backup/backup-nightly.zsh and check-backup-fresh.zsh) call it through install/drive-backup/lib.zsh: on an
// alert (`<job> failed`, the first channel, before the notification and the popup) and on a clean 9 AM check (`check ok`, the
// morning confirmation that clears the line).
//
//   bun run surface/scripts/drive-backup-notice.ts --ledger <db> --job nightly|check --result failed|ok --text <one line> --state <json path> [--now <iso>]
//
// One write on the ledger at <db> (which must exist: a mistyped path never makes a new ledger), under the write lock: the
// standing workload is ensured, then one entry by DRIVE_BACKUP_BY:
//   `drive-backup: <job> <result> <local date> — <text> — <state path>`
// surface/src/errors.ts `driveBackupLines` renders it. --now exists for tests (the entry's clock and its date).
// Exit: 0 written; 1 not written, the reason (what broke, where, the next step) on stderr; 2 bad arguments (nothing done).
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { ensureStandingWorkload } from "../src/identity";
import { DRIVE_BACKUP_BY } from "../src/launch";
import { STANDING_WORKLOAD_ID } from "../src/types";

const USAGE = "usage: bun run surface/scripts/drive-backup-notice.ts --ledger <db> --job nightly|check --result failed|ok --text <one line> --state <json path> [--now <iso>]";

export interface NoticeArgs {
	ledger: string;
	job: "nightly" | "check";
	result: "failed" | "ok";
	text: string;
	state: string;
	/** The entry's clock and date (tests); null = the real time. */
	now: Date | null;
}

// C0 and C1 controls, DEL, and the Unicode line and paragraph separators: the text and the path stay on one line.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SEP = " — ";

/** The arguments, or why they are refused (exit 2). */
export function parseArgs(argv: readonly string[]): NoticeArgs | string {
	const v: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (!["--ledger", "--job", "--result", "--text", "--state", "--now"].includes(a)) return `unknown argument ${JSON.stringify(a)}`;
		const val = argv[++i];
		if (val === undefined) return `${a} needs a value`;
		if (a in v) return `${a} given twice`;
		v[a] = val;
	}
	for (const k of ["--ledger", "--job", "--result", "--text", "--state"]) if (v[k] === undefined) return `${k} is required`;
	const job = v["--job"]!;
	const result = v["--result"]!;
	const text = v["--text"]!.trim();
	const state = v["--state"]!;
	if (job !== "nightly" && job !== "check") return `--job must be nightly or check, not ${JSON.stringify(job)}`;
	if (result !== "failed" && result !== "ok") return `--result must be failed or ok, not ${JSON.stringify(result)}`;
	if (text === "") return "--text is empty";
	if (CONTROL.test(text)) return "--text must be one line with no control characters";
	if (!isAbsolute(state) || CONTROL.test(state) || state.includes(SEP)) return `--state must be an absolute path on one line without " — ", not ${JSON.stringify(state)}`;
	if (!isAbsolute(v["--ledger"]!)) return `--ledger must be an absolute path, not ${JSON.stringify(v["--ledger"])}`;
	let now: Date | null = null;
	if (v["--now"] !== undefined) {
		if (Number.isNaN(Date.parse(v["--now"]))) return "--now needs an ISO-8601 time";
		now = new Date(v["--now"]);
	}
	return { ledger: v["--ledger"]!, job, result, text, state, now };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The entry body: `drive-backup: <job> <result> <local date> — <text> — <state path>`. */
export function noticeBody(a: Pick<NoticeArgs, "job" | "result" | "text" | "state">, now: Date): string {
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	return `drive-backup: ${a.job} ${a.result} ${date}${SEP}${a.text}${SEP}${a.state}`;
}

export type NoticeResult = { exit: 0; entry: string; body: string } | { exit: 1; reason: string };

/** Write the one entry. Never throws: a failure comes back as exit 1 with its reason. */
export function writeNotice(a: NoticeArgs): NoticeResult {
	const now = a.now ?? new Date();
	const body = noticeBody(a, now);
	if (!existsSync(a.ledger)) return { exit: 1, reason: `the ledger ${a.ledger} does not exist (--ledger, from AS2_LEDGER_DB); nothing written. Next: point AS2_LEDGER_DB at the live ledger.db` };
	let ledger: Ledger;
	try {
		ledger = Ledger.open(a.ledger, { backupOnOpen: false, ...(a.now ? { clock: () => now.toISOString() } : {}) });
	} catch (e) {
		return { exit: 1, reason: `the ledger ${a.ledger} could not be opened (${e instanceof Error ? e.message : String(e)}); nothing written. Next: fix the ledger, then the next alert writes again` };
	}
	try {
		const entry = ledger.write(() => {
			ensureStandingWorkload(ledger);
			return ledger.recordEntry({ by: DRIVE_BACKUP_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
		});
		return { exit: 0, entry, body };
	} catch (e) {
		return { exit: 1, reason: `the entry could not be written to ${a.ledger} (${e instanceof Error ? e.message : String(e)}); nothing written. Next: fix the ledger, then the next alert writes again` };
	} finally {
		ledger.close();
	}
}

function main(argv: string[]): number {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const args = parseArgs(argv);
	if (typeof args === "string") {
		process.stderr.write(`drive-backup-notice: ${args}; nothing written\n${USAGE}\n`);
		return 2;
	}
	const r = writeNotice(args);
	if (r.exit !== 0) {
		process.stderr.write(`drive-backup-notice: ${r.reason}\n`);
		return 1;
	}
	process.stdout.write(`wrote ${r.entry} on ${STANDING_WORKLOAD_ID}: ${r.body}\n`);
	return 0;
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
