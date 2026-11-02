// The two ways as2 gets Jo's attention outside a session (PLAN wl-mvwks11ye3x9zu "Alerts", amendment A1):
//
// - `realNotify`: the merge train's banner, moved here unchanged from surface/scripts/train-tick.ts (PR #412): an
//   osascript `display notification` with no sound clause, so train popups stay silent under Jo's silent-popup alarm
//   rule. It does not stay up and does not wait.
// - `alarmPopup`: the alarm rule's stay-up popup (.ai/decision-log/2026-10-28--1400--plumb--alarms-show-a-silent-popup-
//   before-any-sound.md), by running the repo's own install/drive-backup/quiet-alarm.zsh "<title>" "<text>" "<spoken>"
//   with QUIET_ALARM_GIVE_UP_SECS (12 h for the doctor's popups). It blocks until Jo answers or the dialog gives up.
//   quiet-alarm's exit: 0 shown (Jo picked a button, dismissed it, or it gave up; any sound asked for played) →
//   `answered <button>`; 3 shown, Jo picked "Read it to me", the Glass sound or the speech failed → `answered
//   audio-failed <its stderr line>`; 1 or anything else (the popup could not be shown), a spawn failure or a timeout →
//   `failed <why>`. Every outcome carries the helper's whole stderr; an answered one also carries `otherStderr`, its
//   stderr lines other than the audio-failure line (review r5 F14: quiet-alarm can print a mktemp or rm failure and
//   still exit 0 after the dialog was answered). The dialog stays answered, so it is never shown again for such a line;
//   the caller reports the line and fails its run. Tests point quiet-alarm's QUIET_ALARM_OSASCRIPT / QUIET_ALARM_AFPLAY
//   / QUIET_ALARM_SAY seams at fakes, or inject the runner, so no test ever shows the real dialog.
import { join } from "node:path";

/** No sound clause: train popups stay silent under Jo's silent-popup alarm rule. */
export function realNotify(title: string, text: string): boolean {
	const str = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
	const r = Bun.spawnSync(["osascript", "-e", `display notification ${str(text)} with title ${str(title)}`], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
	return r.exitCode === 0;
}

/** 12 h: a doctor popup that nobody answers closes by itself and counts as shown. */
export const DOCTOR_GIVE_UP_SECS = 43_200;

/**
 * What one popup came to: shown (`answered`, the button or `audio-failed <line>`), or not shown (`failed`, why), with
 * quiet-alarm's whole stderr as captured ("" when it wrote none or never started). `otherStderr` is that stderr without
 * the audio-failure line, as one line ("" when there is none): an error the helper reported beside a shown dialog.
 */
export type AlarmOutcome = { state: "answered"; detail: string; stderr: string; otherStderr: string } | { state: "failed"; detail: string; stderr: string };

/** One quiet-alarm run as spawned: its exit code (null on a signal), both streams, and why it did not finish (spawn error or timeout). */
export interface AlarmRun {
	code: number | null;
	stdout: string;
	stderr: string;
	error?: string;
}

export interface AlarmOptions {
	/** The repository whose install/drive-backup/quiet-alarm.zsh runs. */
	repo: string;
	/** QUIET_ALARM_GIVE_UP_SECS; the dialog closes by itself after this many seconds. */
	giveUpSecs: number;
	/** The environment quiet-alarm runs with (its QUIET_ALARM_* seams come from here). */
	env: Record<string, string | undefined>;
	/** The bound on the whole run; past it the process is killed and the outcome is `failed`. */
	timeoutMs: number;
	/** The process runner (tests inject one); default spawns /bin/zsh. */
	spawn?: (argv: string[], env: Record<string, string | undefined>, timeoutMs: number) => AlarmRun;
}

/** The quiet-alarm script's absolute path in `repo`. */
export const quietAlarmPath = (repo: string): string => join(repo, "install", "drive-backup", "quiet-alarm.zsh");

const spawnAlarm = (argv: string[], env: Record<string, string | undefined>, timeoutMs: number): AlarmRun => {
	try {
		const r = Bun.spawnSync(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
		return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), ...(r.exitedDueToTimeout ? { error: `timed out after ${Math.round(timeoutMs / 1000)} s and was killed` } : {}) };
	} catch (e) {
		return { code: null, stdout: "", stderr: "", error: `could not start: ${e instanceof Error ? e.message : String(e)}` };
	}
};

const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();

/** quiet-alarm's audio-failure line prefix (install/drive-backup/quiet-alarm.zsh, exit 3). */
const AUDIO_FAILED = "quiet-alarm: audio FAILED:";

/** Show the alarm rule's popup through quiet-alarm.zsh and wait for it; never throws (every failure is a `failed` outcome). */
export function alarmPopup(title: string, text: string, spoken: string, opts: AlarmOptions): AlarmOutcome {
	const argv = ["/bin/zsh", quietAlarmPath(opts.repo), title, text, spoken];
	const r = (opts.spawn ?? spawnAlarm)(argv, { ...opts.env, QUIET_ALARM_GIVE_UP_SECS: String(opts.giveUpSecs) }, opts.timeoutMs);
	const what = `zsh ${quietAlarmPath(opts.repo)}`;
	const stderr = r.stderr;
	if (r.error !== undefined) return { state: "failed", detail: oneLine(`${what} ${r.error}${stderr.trim() ? `: ${stderr}` : ""}`), stderr };
	if (r.code === 0 || r.code === 3) {
		const lines = stderr.split("\n").filter((l) => l.trim() !== "");
		const at = r.code === 3 ? lines.findIndex((l) => l.startsWith(AUDIO_FAILED)) : -1;
		const audio = at === -1 ? undefined : lines[at];
		const otherStderr = oneLine(lines.filter((_, i) => i !== at).join("; "));
		if (r.code === 3) return { state: "answered", detail: oneLine(`audio-failed ${audio ?? `(no "${AUDIO_FAILED}" line on stderr)`}`), stderr, otherStderr };
		const choice = /^quiet-alarm: choice=(.*)$/m.exec(r.stdout)?.[1]?.trim();
		return { state: "answered", detail: oneLine(choice || "shown (no choice line)"), stderr, otherStderr };
	}
	return { state: "failed", detail: oneLine(`${what} exited ${r.code ?? "on a signal"}: ${stderr.trim() || "no error text"}`), stderr };
}
