// The detached popup worker (PLAN wl-mw0vs9uc3xqtka D3 popups): its claim, its registry line, its ok/failed rows; the
// pass's settlement of an attempt by the pid and lstart pairs recorded for it (Jo's registry rule, q-mw175xfx2etc13) and of
// a legacy quota-move popup, on fake ps snapshots and a fake alarm; and install/drive-backup/quiet-alarm.zsh's registration,
// run for real with fake osascript, afplay, say and ps. No real popup, ps or signal is ever used.
import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AlertEpisode, alertRecords, openEpisode } from "../src/alert-path";
import { errorLines } from "../src/errors";
import { ALERT_BY, alertPopupBody, controlEntries } from "../src/launch";
import { type AlarmOutcome, alarmPopup, quietAlarmPath } from "../src/notify";
import { STANDING_WORKLOAD_ID } from "../src/types";
import { alertPass } from "../scripts/alert-tick";
import { type LegacyClaim, legacyPopupRecord, parsePs, parseRegistry, POPUP_KILL_AFTER_MS, popupRegistryPath, registryLine, settleLegacy, workerRun } from "../scripts/alert-popup";
import { moveText, type QuotaMove } from "../src/quota-move-alert";
import { type AlertWorld, ceilingStopped, world } from "./alert-world";
import { tmp } from "./helpers";

const LS = "Tue Nov  3 10:00:00 2026";
/** LS as a claim or registry line carries it: its spacing collapsed, as parsePs yields it from a snapshot. */
const LS1 = "Tue Nov 3 10:00:00 2026";
const REPO = join(import.meta.dir, "..", "..");

/** An urgent ceiling alert after one pass: its key and its open episode (the pass spawned the level-2 popup, attempt 1). */
interface UrgentEpisode extends AlertWorld {
	key: string;
	ep: AlertEpisode;
}

function urgentEpisode(o: { ps?: () => string } = {}): UrgentEpisode {
	const w = world(o);
	const wl = ceilingStopped(w.ledger, 'Jo said "ASAP": move the header offset into a token');
	alertPass(w.deps);
	const key = `ceiling:${wl}`;
	const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(key))!;
	return { ...w, key, ep };
}

/** Advance the world's clock by `s` seconds. */
const plusSeconds = (w: AlertWorld, s: number) => w.c.plusHours(s / 3600);

/** The level-2 attempt's registry in the world's registry directory. */
const registryOf = (w: UrgentEpisode, attempt = 1) => popupRegistryPath(w.deps.popup.dir, { episode: w.ep.id, level: 2, attempt });

/** Append one line per [pid, name] to attempt 1's registry, each with lstart LS1, as the worker and quiet-alarm.zsh do. */
const record = (w: UrgentEpisode, ...entries: [number, string][]) =>
	appendFileSync(registryOf(w), entries.map(([pid, name]) => registryLine({ pid, lstart: LS1, name })).join(""));

/** Attempt 1's claim (worker pid 500, lstart LS1, `until`) and `showing`, written as the worker writes them. */
function claimRows(w: UrgentEpisode, until = "2026-11-04T00:00:00.000Z") {
	const write = (step: Parameters<typeof alertPopupBody>[3], detail?: string) =>
		w.ledger.recordEntry({ by: ALERT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: alertPopupBody(w.key, w.ep.id, 2, step, detail) });
	write("claim", `pid=500 pgid=500 lstart=${LS1.replace(/ /g, "_")} attempt=1 until=${until}`);
	write("showing");
}

function run(w: UrgentEpisode, outcome: AlarmOutcome, o: { attempt?: number; dir?: string } = {}) {
	const shown: { title: string; text: string; registry: string }[] = [];
	const errs: string[] = [];
	const code = workerRun([w.key, w.ep.id, "2", String(o.attempt ?? 1)], {
		ledger: w.ledger, pid: 500, identity: () => ({ pgid: 500, lstart: LS1 }), dir: o.dir ?? w.deps.popup.dir,
		alarm: (title, text, _spoken, registry) => {
			shown.push({ title, text, registry });
			return outcome;
		},
		err: (l) => errs.push(l),
	});
	return { code, shown, errs };
}

describe("the popup worker (D3)", () => {
	test("it claims its attempt with its pid, pgid and lstart, records itself in the attempt's registry, shows the alert's words and issue with that registry, and writes ok when answered", () => {
		const w = urgentEpisode();
		const r = run(w, { state: "answered", detail: "button=Read it", stderr: "", otherStderr: "" });
		expect(r.code).toBe(0);
		expect(r.shown).toHaveLength(1);
		expect(r.shown[0]!.text).toContain(w.ep.url!);
		expect(r.shown[0]!.text).toContain(`ack ${w.key}`);
		expect(r.shown[0]!.registry).toBe(registryOf(w));
		expect(readFileSync(registryOf(w), "utf8")).toBe(`500 ${LS1} worker\n`);
		const rows = w.rows().filter((x) => x.startsWith(`alert-popup: ${w.key} ${w.ep.id} 2 `));
		expect(rows.find((x) => x.includes(" claim "))).toContain(`pid=500 pgid=500 lstart=${LS1.replace(/ /g, "_")} attempt=1 until=`);
		expect(rows.at(-2)).toBe(`alert-popup: ${w.key} ${w.ep.id} 2 showing`);
		expect(rows.at(-1)).toBe(`alert-popup: ${w.key} ${w.ep.id} 2 ok button=Read it`);
	});

	test("a popup that could not be shown writes failed with quiet-alarm's reason and exits 1", () => {
		const w = urgentEpisode();
		const r = run(w, { state: "failed", detail: "quiet-alarm exited 1: osascript: not authorised", stderr: "osascript: not authorised" });
		expect(r.code).toBe(1);
		expect(w.rows().at(-1)).toBe(`alert-popup: ${w.key} ${w.ep.id} 2 failed quiet-alarm exited 1: osascript: not authorised`);
		expect(r.errs).toEqual([expect.stringContaining("osascript: not authorised")]);
	});

	test("a second worker for the same attempt is refused at its claim and shows nothing", () => {
		const w = urgentEpisode();
		run(w, { state: "answered", detail: "button=Read it", stderr: "", otherStderr: "" });
		const r = run(w, { state: "answered", detail: "button=Read it", stderr: "", otherStderr: "" });
		expect(r.code).toBe(1);
		expect(r.shown).toEqual([]);
		expect(w.rows().at(-1)).toStartWith(`alert-popup: ${w.key} ${w.ep.id} 2 failed claim refused: `);
	});

	test("a worker started without its attempt number exits 2 without writing a row", () => {
		const w = urgentEpisode();
		const before = w.rows().length;
		const errs: string[] = [];
		const code = workerRun([w.key, w.ep.id, "2"], { ledger: w.ledger, pid: 500, identity: () => ({ pgid: 500, lstart: LS1 }), dir: w.deps.popup.dir, alarm: () => { throw new Error("must not show"); }, err: (l) => errs.push(l) });
		expect(code).toBe(2);
		expect(w.rows()).toHaveLength(before);
		expect(errs[0]).toContain("usage: alert-popup.ts <key> <episode> <level> <attempt>");
	});

	test("quiet-alarm's `register FAILED` beside an answered popup is the key's `error popup` and exit 1, after the `ok` (a helper it could not record)", () => {
		const w = urgentEpisode();
		const failed = "quiet-alarm: register FAILED: afplay pid 620: ps -o lstart= -p 620 exited 1: no output";
		const r = run(w, { state: "answered", detail: "Read it to me", stderr: `${failed}\n`, otherStderr: failed });
		expect(r.code).toBe(1);
		expect(w.rows().at(-2)).toBe(`alert-popup: ${w.key} ${w.ep.id} 2 ok Read it to me`);
		expect(w.rows().at(-1)).toBe(`alert: ${w.key} error popup quiet-alarm reported beside an answered popup: ${failed}`);
		expect(r.errs).toEqual([expect.stringContaining(failed)]);
	});

	test("a registry the worker cannot write fails the attempt before anything is shown: failed naming the file, exit 1", () => {
		const w = urgentEpisode();
		const file = join(tmp("not-a-dir"), "file");
		writeFileSync(file, "");
		const r = run(w, { state: "answered", detail: "button=Read it", stderr: "", otherStderr: "" }, { dir: join(file, "registries") });
		expect(r.code).toBe(1);
		expect(r.shown).toEqual([]);
		expect(w.rows().at(-1)).toStartWith(`alert-popup: ${w.key} ${w.ep.id} 2 failed cannot record itself in its registry ${join(file, "registries")}/`);
		expect(r.errs).toEqual([expect.stringContaining("cannot record itself in its registry")]);
	});

	test("a worker that reports failed stays supervised: its recorded voice is signalled, and no replacement starts until it is gone (R12, review r1 #1)", () => {
		let snapshot = "";
		const w = urgentEpisode({ ps: () => snapshot });
		expect(w.spawns).toHaveLength(1);
		run(w, { state: "failed", detail: "quiet-alarm exited 1: osascript: timed out", stderr: "timed out" });
		// The worker (500) is gone; the `say` quiet-alarm started after "Read it to me" (610) is recorded and still alive.
		record(w, [610, "say"]);
		snapshot = `  610     1   610 ${LS} /usr/bin/say the alert`;
		alertPass(w.deps);
		expect(w.kills).toEqual([[610, "SIGTERM"]]);
		expect(w.spawns).toHaveLength(1);
		plusSeconds(w, 31);
		alertPass(w.deps);
		expect(w.kills).toEqual([[610, "SIGTERM"], [610, "SIGKILL"]]);
		expect(w.spawns).toHaveLength(1);
		snapshot = "";
		alertPass(w.deps);
		expect(w.rows()).toContain(alertPopupBody(w.key, w.ep.id, 2, "settled", "worker failed: quiet-alarm exited 1: osascript: timed out"));
		alertPass(w.deps);
		expect(w.spawns).toHaveLength(2);
		expect(w.spawns[1]!.argv.slice(-4)).toEqual([w.key, w.ep.id, "2", "2"]);
		expect(w.kills).toHaveLength(2);
	});

	test("three failed attempts exhaust the level: no fourth worker, and the line says failed 3 of 3 (R12)", () => {
		const w = urgentEpisode();
		for (let n = 1; n <= 3; n++) {
			expect(w.spawns).toHaveLength(n);
			run(w, { state: "failed", detail: `osascript exit 1 (attempt ${n})`, stderr: "" }, { attempt: n });
			alertPass(w.deps);
			alertPass(w.deps);
		}
		alertPass(w.deps);
		expect(w.spawns).toHaveLength(3);
		expect(errorLines(w.ledger).find((l) => l.kind === "alert" && l.rowId === w.ep.id)!.line).toContain(`popup failed 3 of 3: worker failed: osascript exit 1 (attempt 3)`);
	});

	test("an expired attempt's recorded members (worker, zsh, osascript) get SIGTERM; an unrecorded process beside them is never signalled; settled once the recorded ones are gone", () => {
		let snapshot = "";
		const w = urgentEpisode({ ps: () => snapshot });
		claimRows(w, "2026-11-03T10:30:00.000Z");
		record(w, [500, "worker"], [510, "zsh"], [520, "osascript"]);
		snapshot = [
			`  500     1   500 ${LS} /opt/homebrew/bin/bun surface/scripts/alert-popup.ts ${w.key} ${w.ep.id} 2 1`,
			`  510   500   500 ${LS} /bin/zsh install/drive-backup/quiet-alarm.zsh`,
			`  520   510   500 ${LS} /usr/bin/osascript -`,
			`  530   510   500 ${LS} /usr/bin/osascript -`,
		].join("\n");
		plusSeconds(w, 31 * 60);
		alertPass(w.deps);
		expect(w.kills).toEqual([[500, "SIGTERM"], [510, "SIGTERM"], [520, "SIGTERM"]]);
		const m = (pid: number) => `${pid}:${LS1.replace(/ /g, "_")}`;
		expect(w.rows()).toContain(`alert-popup: ${w.key} ${w.ep.id} 2 terminating expired members=${m(500)},${m(510)},${m(520)} sent=${w.c.now()}`);
		snapshot = `  530   510   500 ${LS} /usr/bin/osascript -`;
		alertPass(w.deps);
		expect(w.rows()).toContain(alertPopupBody(w.key, w.ep.id, 2, "settled", "expired"));
		expect(w.kills).toHaveLength(3);
	});

	test("review r2 N2: a process whose argv carries the old AS2_ALERT_POPUP tag of this attempt gets no signal step; the attempt settles", () => {
		let snapshot = "";
		const w = urgentEpisode({ ps: () => snapshot });
		claimRows(w);
		snapshot = `  700     1   700 ${LS} /bin/sleep 30 AS2_ALERT_POPUP=${w.ep.id}:2:1`;
		alertPass(w.deps);
		expect(w.kills).toEqual([]);
		expect(w.rows()).toContain(alertPopupBody(w.key, w.ep.id, 2, "settled", "worker ended without a result"));
	});

	test("an orphaned helper that was never recorded (it outlived its zsh before its line was written) is not touched: the gap Jo accepted", () => {
		let snapshot = "";
		const w = urgentEpisode({ ps: () => snapshot });
		claimRows(w);
		record(w, [510, "zsh"]);
		snapshot = `  620     1   620 ${LS} /usr/bin/afplay /System/Library/Sounds/Glass.aiff`;
		alertPass(w.deps);
		expect(w.kills).toEqual([]);
		expect(w.rows()).toContain(alertPopupBody(w.key, w.ep.id, 2, "settled", "worker ended without a result"));
	});

	test("a recorded pid now held by another process (another lstart) is never signalled", () => {
		let snapshot = "";
		const w = urgentEpisode({ ps: () => snapshot });
		claimRows(w);
		record(w, [620, "afplay"]);
		snapshot = `  620     1   620 Tue Nov  3 11:00:00 2026 /usr/bin/vim notes.txt`;
		alertPass(w.deps);
		expect(w.kills).toEqual([]);
		expect(w.rows()).toContain(alertPopupBody(w.key, w.ep.id, 2, "settled", "worker ended without a result"));
	});

	test("a recorded afplay that outlives the worker and survives TERM gets SIGKILL; surviving that too keeps the key visibly unsettled, with no replacement, until it is gone (R24)", () => {
		let snapshot = "";
		const w = urgentEpisode({ ps: () => snapshot });
		claimRows(w);
		// The worker died after Jo picked "Read it to me"; quiet-alarm.zsh recorded its afplay (620), reparented to launchd.
		record(w, [500, "worker"], [510, "zsh"], [620, "afplay"]);
		snapshot = `  620     1   620 ${LS} /usr/bin/afplay /System/Library/Sounds/Glass.aiff`;
		alertPass(w.deps);
		expect(w.kills).toEqual([[620, "SIGTERM"]]);
		plusSeconds(w, 10);
		alertPass(w.deps);
		expect(w.kills).toEqual([[620, "SIGTERM"]]);
		plusSeconds(w, 21);
		alertPass(w.deps);
		expect(w.kills).toEqual([[620, "SIGTERM"], [620, "SIGKILL"]]);
		plusSeconds(w, 6 * 60);
		alertPass(w.deps);
		expect(errorLines(w.ledger).find((l) => l.kind === "alert" && l.rowId === w.ep.id)!.line).toContain("still alive 5 minutes after SIGKILL: 620:");
		expect(w.spawns).toHaveLength(1);
		snapshot = "";
		alertPass(w.deps);
		alertPass(w.deps);
		expect(w.spawns).toHaveLength(2);
		expect(w.spawns[1]!.argv.slice(-4)).toEqual([w.key, w.ep.id, "2", "2"]);
	});
});

describe("quiet-alarm.zsh registration (QUIET_ALARM_REGISTER)", () => {
	// One fake for osascript, afplay and say (by its own name): it logs `<name> <pid>`, keeps the AppleScript osascript reads
	// on stdin, and under registration waits until its own line is in the registry (register records only a helper still
	// running), a failure-only guard of 10 s. osascript answers "Read it to me", so all three helpers run.
	const HELPER = `#!/bin/zsh
zmodload zsh/zselect
d=\${0:h} me=\${0:t}
print -r -- "$me $$" >> $d/calls.log
[[ $me == osascript ]] && cat > $d/osascript.stdin
if [[ -n \${QUIET_ALARM_REGISTER:-} && -z \${FAKE_NO_WAIT:-} ]]; then
  for k in {1..1000}; do /usr/bin/grep -q "^$$ " $QUIET_ALARM_REGISTER 2>/dev/null && break; zselect -t 1; done
  /usr/bin/grep -q "^$$ " $QUIET_ALARM_REGISTER || { print -u2 "$me: pid $$ was never recorded in $QUIET_ALARM_REGISTER"; exit 9 }
fi
[[ $me == osascript ]] && print "Read it to me"
exit 0
`;
	// ps -o lstart= -p <pid>, answered with lstart's own padding and trailing blanks, which register must collapse.
	const PS = `#!/bin/sh
printf '%s\\n' "ps $*" >> "\${0%/*}/calls.log"
printf '%s\\n' "Tue Nov  3 13:24:29 2026   "
`;
	function fakes(): string {
		const d = tmp("quiet-alarm-fakes");
		for (const [name, body] of [["osascript", HELPER], ["afplay", HELPER], ["say", HELPER], ["ps", PS]] as const) {
			writeFileSync(join(d, name), body);
			chmodSync(join(d, name), 0o755);
		}
		return d;
	}
	const envOf = (d: string, extra: Record<string, string>) => ({
		PATH: "/usr/bin:/bin", HOME: d, TMPDIR: d,
		QUIET_ALARM_OSASCRIPT: join(d, "osascript"), QUIET_ALARM_AFPLAY: join(d, "afplay"), QUIET_ALARM_SAY: join(d, "say"), QUIET_ALARM_PS: join(d, "ps"),
		...extra,
	});
	const quietAlarm = (env: Record<string, string>) => {
		const r = Bun.spawnSync(["/bin/zsh", quietAlarmPath(REPO), "as2: t", "the alert", "spoken words"], { env, stdout: "pipe", stderr: "pipe" });
		return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), pid: r.pid };
	};
	const calls = (d: string) => readFileSync(join(d, "calls.log"), "utf8").trim().split("\n");

	test("with a registration path it appends `<pid> <lstart> <name>` for its zsh, then each osascript, afplay and say, lstart collapsed; its output and exit are unchanged", () => {
		const d = fakes();
		const reg = join(d, "en-ep1.2.1.pids");
		const r = quietAlarm(envOf(d, { QUIET_ALARM_REGISTER: reg }));
		expect(r).toMatchObject({ code: 0, stdout: "quiet-alarm: choice=Read it to me\n", stderr: "" });
		const helpers = calls(d).filter((l) => !l.startsWith("ps ")).map((l) => l.split(" "));
		expect(helpers.map(([name]) => name)).toEqual(["osascript", "afplay", "say"]);
		const lines = parseRegistry(readFileSync(reg, "utf8"), reg);
		expect(lines).toEqual([
			{ pid: r.pid, lstart: "Tue Nov 3 13:24:29 2026", name: "zsh" },
			...helpers.map(([name, pid]) => ({ pid: Number(pid), lstart: "Tue Nov 3 13:24:29 2026", name: name! })),
		]);
		expect(readFileSync(reg, "utf8")).toBe(lines.map(registryLine).join(""));
		// The same start time as the pass's -A read prints it (the line the full suite saw, tr-0mw15vx4ygdaaik solo-3.log)
		// parses to the very token recorded: the two layouts differ only in spacing.
		expect(parsePs("35299     1 35296 Tue Nov  3 13:24:29 2026     /bin/sleep 30")[0]!.lstart).toBe(lines[0]!.lstart);
		expect(calls(d).filter((l) => l.startsWith("ps "))).toEqual(lines.map((l) => `ps -o lstart= -p ${l.pid}`));
		// Run in the background, osascript still reads the AppleScript on its stdin.
		expect(readFileSync(join(d, "osascript.stdin"), "utf8")).toContain("on run argv");
	});

	test("without a registration path nothing is recorded and ps is never run: the doctor's and drive-backup's popup as before", () => {
		const d = fakes();
		const r = quietAlarm(envOf(d, {}));
		expect(r).toMatchObject({ code: 0, stdout: "quiet-alarm: choice=Read it to me\n", stderr: "" });
		expect(calls(d).map((l) => l.split(" ")[0])).toEqual(["osascript", "afplay", "say"]);
		expect(readFileSync(join(d, "osascript.stdin"), "utf8")).toContain("on run argv");
	});

	test("a registration it cannot write is a `register FAILED` stderr line, the popup still answered: alarmPopup reports it beside the answer, the worker's error", () => {
		const d = fakes();
		const reg = join(d, "missing", "en-ep1.2.1.pids");
		const o = alarmPopup("as2: t", "the alert", "spoken words", { repo: REPO, giveUpSecs: 60, env: envOf(d, { QUIET_ALARM_REGISTER: reg, FAKE_NO_WAIT: "1" }), timeoutMs: 60_000 });
		expect(o).toMatchObject({ state: "answered", detail: "Read it to me" });
		if (o.state !== "answered") throw new Error(`alarmPopup gave ${JSON.stringify(o)}; expected answered`);
		expect(o.otherStderr).toStartWith("quiet-alarm: register FAILED: zsh pid ");
		expect(o.otherStderr).toContain(`cannot append to ${reg}: `);
		expect(o.stderr.trim().split("\n").every((l) => l.startsWith("quiet-alarm: register FAILED: "))).toBe(true);
		expect(existsSync(reg)).toBe(false);
	});
});

describe("a legacy quota-move popup at cutover (D3 legacy adoption)", () => {
	const move: QuotaMove = {
		eventId: "E-1", messageId: "msg-q-1", workloadId: "wl-t1", subject: "lane-t-1", kind: "lane",
		from: "anthropic/claude-opus-5-5", to: "openai-codex/gpt-6-sol", reason: "weekly quota at 96%", at: "2026-11-03T09:00:00.000Z",
	};
	const claim: LegacyClaim = { pid: 900, attempt: 1 };
	const OWNER = `/opt/homebrew/bin/bun surface/scripts/lane.ts move-alert wl-t1 E-1`;
	test("no helper left: settled with no signal; a process on the claim's pid running something else is a reused pid, not the worker", () => {
		expect(settleLegacy(legacyPopupRecord([]), [], claim, move, "2026-11-03T10:01:00.000Z")).toEqual([{ do: "settle", text: "settled worker ended without a result" }]);
		const reused = parsePs(`  900     1   900 Tue Nov  3 11:00:00 2026 /bin/sleep 5`);
		expect(settleLegacy(legacyPopupRecord([]), reused, claim, move, "2026-11-03T10:01:00.000Z")).toEqual([{ do: "settle", text: "settled claim pid reused" }]);
	});

	test("a live legacy worker is sent SIGTERM, then SIGKILL only once the grace has passed", () => {
		const procs = parsePs([`  900     1   900 ${LS} ${OWNER}`, `  901   900   900 ${LS} /usr/bin/say hello`, `  950     1   950 ${LS} /bin/sleep 5`].join("\n"));
		if (procs.length !== 3) throw new Error(`parsePs read ${procs.length} processes from a three-line snapshot`);
		const t0 = "2026-11-03T10:01:00.000Z";
		const [first, ...more] = settleLegacy(legacyPopupRecord([]), procs, claim, move, t0);
		if (first?.do !== "terminate" || more.length > 0) throw new Error(`settleLegacy gave ${JSON.stringify([first, ...more])} for a live legacy worker; expected one terminate`);
		expect(first.members.map((p) => p.pid).sort()).toEqual([900, 901]);
		const rec = legacyPopupRecord([first.text]);
		expect(settleLegacy(rec, procs, claim, move, "2026-11-03T10:01:10.000Z")).toEqual([]);
		const late = new Date(Date.parse(t0) + POPUP_KILL_AFTER_MS).toISOString();
		expect(settleLegacy(rec, procs, claim, move, late)).toMatchObject([{ do: "kill" }]);
		expect(settleLegacy(rec, [], claim, move, late)).toEqual([{ do: "settle", text: "settled cancelled at cutover" }]);
	});

	test("a voice first seen after the terminating row is folded in and signalled; settled only once the whole identifiable set is gone (review r1 #2)", () => {
		const t0 = "2026-11-03T10:01:00.000Z";
		const [first] = settleLegacy(legacyPopupRecord([]), parsePs(`  900     1   900 ${LS} ${OWNER}`), claim, move, t0);
		if (first?.do !== "terminate") throw new Error(`settleLegacy gave ${JSON.stringify(first)} for a live legacy worker; expected terminate`);
		// The owner is gone; the move's `say <moveText>` (the legacy glassAndSay argv), not in the first snapshot, is alive.
		const voice = parsePs(`  901     1   901 ${LS} /usr/bin/say ${moveText(move)}`);
		const t1 = "2026-11-03T10:01:10.000Z";
		const [second, ...rest] = settleLegacy(legacyPopupRecord([first.text]), voice, claim, move, t1);
		if (second?.do !== "terminate" || rest.length > 0) throw new Error(`settleLegacy gave ${JSON.stringify([second, ...rest])} with the move's voice alive; expected one terminate`);
		expect(second.members.map((p) => p.pid)).toEqual([901]);
		const rec = legacyPopupRecord([first.text, second.text]);
		expect(settleLegacy(rec, voice, claim, move, "2026-11-03T10:01:20.000Z")).toEqual([]);
		expect(settleLegacy(rec, voice, claim, move, new Date(Date.parse(t1) + POPUP_KILL_AFTER_MS).toISOString())).toMatchObject([{ do: "kill", members: [{ pid: 901 }] }]);
		expect(settleLegacy(rec, [], claim, move, "2026-11-03T10:02:00.000Z")).toEqual([{ do: "settle", text: "settled cancelled at cutover" }]);
	});
});
