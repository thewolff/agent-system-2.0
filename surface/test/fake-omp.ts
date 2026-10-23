#!/usr/bin/env bun
// The fake `omp` for the lane launcher's unit tests (DESIGN-lane-launcher.md § 8, "Fake-omp shim
// unit tests"): a shell shim named `omp` on PATH ahead of the real binary execs this file. It
// records argv, env and cwd, speaks the rpc frames the runner reads (measured on OMP 18.4.4 in
// ~/agent-scratch/agent-system-2.0/migration/M7/lane-launcher/verify/out: `ready` first, the
// `get_state` response with `data.sessionFile`, `agent_end` then `prompt_result` with status
// `completed` or `aborted` — an `abort` frame and `--max-time` both end with `aborted` — and
// `sessionSettled`, false while a background job may still wake the session, then `session_settled`
// once it has: @oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-types.ts `RpcPromptResultFrame`), and
// drives the real lane rows (surface/extensions/lane.ts, lane-tools.ts) through the fake extension
// API, so the lane's claim at session_start, its tools, and its session_shutdown release are the
// real code, not a copy.
//
// Script (JSON at $FAKE_OMP_SCRIPT; the step type is FakeStep in ./helpers.ts):
//   { claim?: false,               skip session_start (an extension that did not load: never ready)
//     noSession?: true,            the get_state reply carries no sessionFile
//     steps: [ { tool, args } | { sleepMs } | { exit: code } | { hang: true } | { result: "aborted" | "error", error? }
//              | { usage: { usd, tokens }, hand? } | { background: ms | "never" } | { wake: { ms, steps } }
//              | { ledger: { body, slice? } | { routing: { slice } } } ],
//                                an arg value "$slice" is the id the newest tool result named (lane_add_slice mints it);
//                                a usage step appends one assistant message with that usage (usage.cost.total,
//                                usage.totalTokens) to the session file, or with `hand` to <session>/<hand>.jsonl, where
//                                OMP writes a hand's session file (the runner's ceiling meter reads both);
//                                a background step ends the prompt with `sessionSettled: false`; after `ms` it records
//                                `background-done`, runs the next turn's steps as the woken turn (no prompt_result) and
//                                emits `session_settled`; an EOF first records `background-killed` ("never": always);
//                                a wake step leaves the prompt settled (a job omp does not track) and after `ms` records
//                                `wake` and runs its own steps as a woken turn, then `session_settled`; while any woken
//                                turn runs, get_state answers `isSettled: false`;
//                                a ledger step writes what the classifier would, through the ledger module as the lane:
//                                one `assumption` entry (`$slice` and `$routing` in the body are the newest slice and
//                                routing ids), or one judge routings row on the slice (its id becomes `$routing`)
//     prompts?: [ steps, … ],      the n-th turn (each prompt, each woken turn) runs prompts[n], else `steps`
//                                a result step's `error` ({ message, provider?, model?, retryable }) rides its prompt_result,
//                                as omp's RpcPromptError does (rpc-types.ts);
//     stateModel?: { provider?, id? } | null,  get_state's data.model instead of the one `--model` names (null: none at all);
//                                with no `--model` and no override it stays `{ id: "fake" }` (MIGRATION.md item 85); a
//                                `set_model` frame replaces it (PLAN wl-mv71x5rwdu7eo0 § 4), as omp's does
//     stateFail?: true,            get_state answers `success: false` with no data
//     stateDelayMs?: n,            get_state answers n ms late
//     ignoreAbort?: true,          keep running after an abort frame (the runner's kill path)
//     ignoreEof?: true,            keep running after stdin EOF too (the runner's bounded SIGKILL, B4)
//     ignoreTerm?: true,           record SIGTERM and keep running (a child the by-hand stop must escalate on, review 2 R1)
//     stateOnAbort?: true,         answer get_state at once with no sessionFile, and send the full reply (sessionFile and all)
//                                only when an abort frame arrives (a late session record, review 2 R5; the runner's first
//                                prompt waits for the first answer, PLAN wl-mv71x5rwdu7eo0 § 4)
//     eofDelayMs?: n,              wait n ms between stdin EOF and the shutdown (the runner's late writes land first)
//     shutdownOnTerm?: false,      SIGTERM exits without session_shutdown (default: shutdown, like EOF)
//     holdStdoutUntil?: path }     a helper process inherits stdout and holds it open until that file exists (at most
//                                30 s), so the runner's read loop, and its finish(), wait past this process's own death
//                                (SIGKILL included) until the test opens the gate: a window the test controls
// Record (JSONL appended at $FAKE_OMP_RECORD): { pid, argv, cwd, env: { AGENT_SYSTEM_*, OMP_PROFILE }, hooks: [the
// SHELL_START_HOOK_NAMES its env carries, names only], session, resumed }
// at start, then { pid, event } for each frame or signal seen: prompt (with its id and message; the `@file` initial
// message as { event: "prompt", initial: true, message }, run as the first turn), abort, eof, sigterm, sigint,
// background-done / background-killed, and wake; and { pid, command, id, provider?, modelId? } for every rpc
// command frame received, in arrival order (a test asserts `set_model` and its `get_state` came before `prompt`).
// A new session file opens as OMP's does: a `title` line, then `{"type":"session","id":"<uuid>",…}` (the
// header surface/src/ctx-index.ts reads), and get_state's sessionId is that id; a resumed file keeps its own header.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import { defaultLedgerPath } from "../../ledger/src/locality";
import { SHELL_START_HOOK_NAMES } from "../../gates/src/shell-start";
import orchestratorSurface from "../index";
import { ctxOf, type FakeScript, type FakeStep, fakePi } from "./helpers";

const script: FakeScript = process.env.FAKE_OMP_SCRIPT && existsSync(process.env.FAKE_OMP_SCRIPT) ? (JSON.parse(readFileSync(process.env.FAKE_OMP_SCRIPT, "utf8")) as FakeScript) : { steps: [] };
const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : null;
};
const sessionDir = flag("--session-dir") ?? join(process.cwd(), "sessions");
const resumed = flag("--resume");
// jo-issues #206: OMP refuses a missing --resume instead of silently creating a session.
if (resumed !== null && !existsSync(resumed)) {
	process.stderr.write(`Error: Session "${resumed}" not found.\n`);
	process.exit(1);
}
/** `--model provider/id` as omp reports it in get_state (measured on 18.8.6: `openai-codex/gpt-6-sol` → provider `openai-codex`, id `gpt-6-sol`). */
const named = flag("--model");
/** The model get_state reports: the script's override, else `--model`'s, else `{ id: "fake" }`; a `set_model` frame replaces it. */
let stateModel: { provider?: string; id?: string } | null =
	script.stateModel !== undefined ? script.stateModel : named ? { provider: named.slice(0, named.indexOf("/")), id: named.slice(named.indexOf("/") + 1) } : { id: "fake" };
const maxTime = flag("--max-time");
// `@<path>` (interactive mode only: OMP refuses it under `--mode rpc` and exits 1, as it does for a missing file): OMP reads
// each file as `<file name="<absolute path>">\n<text>\n</file>\n` and sends the text as the session's first user message
// (@oh-my-pi/pi-coding-agent 18.8.6 src/cli/args.ts, file-processor.ts, initial-message.ts; main.ts session.prompt).
const fileArgs = argv.filter((a) => a.startsWith("@")).map((a) => a.slice(1));
if (fileArgs.length > 0 && flag("--mode") === "rpc") {
	process.stderr.write("Error: @file arguments are not supported in RPC mode\n");
	process.exit(1);
}
let initialMessage: string | null = null;
for (const file of fileArgs) {
	if (!existsSync(file)) {
		process.stderr.write(`Error: File not found: ${file}\n`);
		process.exit(1);
	}
	initialMessage = `${initialMessage ?? ""}<file name="${file}">\n${readFileSync(file, "utf8")}\n</file>\n`;
}
mkdirSync(sessionDir, { recursive: true });
// `--resume <path>` appends to that same file, as OMP 18.4.4 does (`SessionManager.open(path, sessionDir)`): on workload
// wl-muolz8qtp6ylfk, relaunched lanes 2–5 each reported lane 1's sessionFile in get_state (their lane-started: entries),
// and the lane's --session-dir held that one top-level file. The ceiling meter's cumulative scan relies on it (a copy
// would count twice).
const session = resumed && existsSync(resumed) ? resumed : join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${process.pid}.jsonl`);
const sessionId = crypto.randomUUID();
if (session === resumed) appendFileSync(session, `{"type":"resumed","from":${JSON.stringify(resumed)}}\n`);
else {
	const at = new Date().toISOString();
	writeFileSync(session, `${JSON.stringify({ type: "title", v: 1, title: "", updatedAt: at })}\n${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: at, cwd: process.cwd() })}\n`);
}
const recordLine = (o: Record<string, unknown>): void => {
	if (process.env.FAKE_OMP_RECORD) appendFileSync(process.env.FAKE_OMP_RECORD, `${JSON.stringify({ pid: process.pid, ...o })}\n`);
};
{
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (k.startsWith("AGENT_SYSTEM_") || k === "OMP_PROFILE")) env[k] = v;
	const hooks = SHELL_START_HOOK_NAMES.filter((n) => process.env[n] !== undefined);
	recordLine({ argv, cwd: process.cwd(), env, hooks, session, resumed });
}
// The helper keeps a copy of this process's stdout (the runner's pipe) until the gate file exists; it is not killed with it.
if (script.holdStdoutUntil) {
	Bun.spawn(["sh", "-c", 'i=0; while [ ! -e "$1" ] && [ "$i" -lt 600 ]; do sleep 0.05; i=$((i+1)); done', "sh", script.holdStdoutUntil], {
		stdin: "ignore", stdout: "inherit", stderr: "ignore",
	}).unref();
}
if (script.holdStderrUntil) {
	Bun.spawn(["sh", "-c", 'i=0; while [ ! -e "$1" ] && [ "$i" -lt 600 ]; do sleep 0.05; i=$((i+1)); done', "sh", script.holdStderrUntil], {
		stdin: "ignore", stdout: "ignore", stderr: "inherit",
	}).unref();
}
if (script.startup) {
	for (const chunk of script.startup.chunks ?? []) {
		await Bun.write(Bun.stderr, chunk);
		await Bun.sleep(5);
	}
	if (script.startup.delayMs) await Bun.sleep(script.startup.delayMs);
	if (script.startup.signal) {
		process.kill(process.pid, script.startup.signal);
		await Bun.sleep(1000);
	}
	process.exit(script.startup.code ?? 1);
}

const emit = (frame: Record<string, unknown>): void => {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};
const durationMs = (d: string | null): number | null => {
	const m = d ? /^(\d+)(ms|s|m|h)$/.exec(d) : null;
	if (!m) return null;
	const n = Number(m[1]);
	return m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3_600_000;
};

const f = fakePi();
orchestratorSurface(f.pi, process.env, {});
const ctx = ctxOf({ cwd: process.cwd() });
let shutDown = false;
const shutdown = async (): Promise<void> => {
	if (shutDown) return;
	shutDown = true;
	await f.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	appendFileSync(session, `{"type":"session_shutdown"}\n`);
	process.exit(0);
};

emit({ type: "ready", protocolVersion: 1, fake: true });
if (script.claim !== false) await f.emit("session_start", { type: "session_start" }, ctx);

/** The current prompt ended on an abort, the max-time or a result step: the rest of its steps are skipped. */
let aborted = false;
/** The current prompt's prompt_result is still owed. */
let running = false;
let promptId: string | null = null;
/** A background job ended the last prompt and has not finished: the session is not settled. */
let backgroundPending = false;
/** A woken turn is running (a background or wake step's): get_state reports the session unsettled, as omp does. */
let woken = false;
let eofSeen = false;
let turn = 0;
/** The slice the newest tool result named, for a step's "$slice" (a resumed lane keeps none: it names ids itself). */
let lastSlice = "";
/** The routings row the newest ledger step wrote, for "$routing". */
let lastRouting = "";
const result = (status: string, sessionSettled = true, error?: Record<string, unknown>): void => {
	running = false;
	emit({ type: "agent_end", fake: true });
	emit({ type: "prompt_result", id: promptId, agentInvoked: true, status, sessionSettled, ...(error ? { error } : {}) });
};

/** The classifier's writes, through the ledger module as the lane (the fake loads the surface extension, not the classifier). */
const ledgerStep = (step: Extract<FakeStep, { ledger: unknown }>["ledger"]): void => {
	const by = process.env.AGENT_SYSTEM_LANE_ID!;
	const workloadId = process.env.AGENT_SYSTEM_WORKLOAD_ID!;
	const fill = (s: string): string => s.replaceAll("$slice", lastSlice).replaceAll("$routing", lastRouting);
	const ledger = Ledger.open(defaultLedgerPath(process.env));
	try {
		if ("body" in step) {
			ledger.recordEntry({ by, workloadId, sliceId: step.slice ? fill(step.slice) : null, kind: "assumption", body: fill(step.body) });
			return;
		}
		const sliceId = fill(step.routing.slice);
		const models = ["openai-codex/gpt-6-astra"];
		lastRouting = ledger.recordRouting({
			by, workloadId, sliceId, spawnKey: sliceId, sessionRoot: session, agentId: `${sliceId}-fake-${Date.now()}`,
			kind: "judge", confidence: 0.9, probabilities: { judge: 0.9 }, classifiedTier: "strong", tier: "strong",
			models, judgeModel: "typesafe/jev-1.13.0", outcome: "ran", ranModels: models,
		});
	} finally {
		ledger.close();
	}
};

/** One turn's steps; the background step that ended it, if one did. */
const runSteps = async (steps: readonly FakeStep[]): Promise<number | "never" | null> => {
	for (const step of steps) {
		if (aborted) break;
		if ("exit" in step) process.exit(step.exit);
		if ("result" in step) {
			// The prompt ends with this status on omp's own account (a model error, an abort from elsewhere): no completed result follows.
			aborted = true;
			result(step.result, true, step.error);
			break;
		}
		if ("background" in step) return step.background;
		if ("wake" in step) {
			const w = step.wake;
			setTimeout(() => {
				if (eofSeen) return;
				recordLine({ event: "wake" });
				void wokenTurn(w.steps);
			}, w.ms);
			continue;
		}
		if ("hang" in step) {
			await new Promise<void>((r) => {
				const t = setInterval(() => {
					if (aborted) {
						clearInterval(t);
						r();
					}
				}, 50);
			});
			continue;
		}
		if ("sleepMs" in step) {
			await Bun.sleep(step.sleepMs);
			continue;
		}
		if ("usage" in step) {
			const file = step.hand ? join(session.replace(/\.jsonl$/, ""), `${step.hand}.jsonl`) : session;
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: step.usage.tokens, cost: { total: step.usage.usd } } } })}\n`);
			continue;
		}
		if ("ledger" in step) {
			ledgerStep(step.ledger);
			continue;
		}
		const args = Object.fromEntries(Object.entries(step.args).map(([k, v]) => [k, v === "$slice" ? lastSlice : v]));
		const r = await f.tool(step.tool).execute(`c${Date.now()}`, args, undefined, undefined, ctx);
		const text = r.content[0]?.text ?? "";
		lastSlice = (/\bsl-[a-z0-9]+\b/.exec(text) ?? [])[0] ?? lastSlice;
		appendFileSync(session, `${JSON.stringify({ type: "tool", tool: step.tool, text })}\n`);
		if (ctx.shutdowns.length > 0) break;
	}
	return null;
};
const nextSteps = (): readonly FakeStep[] => script.prompts?.[turn++] ?? script.steps ?? [];

/** A woken turn (no prompt_result): its steps, then the shutdown the lane asked for, or `session_settled`. */
const wokenTurn = async (steps: readonly FakeStep[]): Promise<void> => {
	woken = true;
	aborted = false;
	await runSteps(steps);
	woken = false;
	if (ctx.shutdowns.length > 0) {
		await shutdown();
		return;
	}
	emit({ type: "session_settled" });
};

/** The job a background step left: after `ms` the woken turn runs and the session settles; an EOF first kills it. */
const background = (ms: number | "never"): void => {
	backgroundPending = true;
	if (ms === "never") return;
	setTimeout(async () => {
		if (eofSeen) return;
		backgroundPending = false;
		recordLine({ event: "background-done" });
		await wokenTurn(nextSteps());
	}, ms);
};

const runPrompt = async (message: string): Promise<void> => {
	aborted = false;
	running = true;
	appendFileSync(session, `${JSON.stringify({ type: "message", role: "user", text: message })}\n`);
	const limit = durationMs(maxTime);
	const deadline = setTimeout(() => {
		if (running && !aborted) {
			aborted = true;
			result("aborted");
		}
	}, limit ?? 2_147_483_647);
	const job = await runSteps(nextSteps());
	clearTimeout(deadline);
	if (running && !aborted) result("completed", job === null);
	if (ctx.shutdowns.length > 0) {
		await shutdown();
		return;
	}
	if (job !== null) background(job);
};

process.on("SIGTERM", () => {
	recordLine({ event: "sigterm" });
	if (script.ignoreTerm) return;
	if (script.shutdownOnTerm === false) process.exit(143);
	void shutdown();
});
process.on("SIGINT", () => {
	recordLine({ event: "sigint" });
	void shutdown();
});

// The `@file` text is the first user message, after session_start, as OMP prompts it (no `input` event: it is not typed).
if (initialMessage !== null) {
	recordLine({ event: "prompt", initial: true, message: initialMessage });
	void runPrompt(initialMessage);
}

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buf = "";
let heldState: Record<string, unknown> | null = null;
for (;;) {
	const { value, done } = await reader.read();
	if (done) break;
	buf += decoder.decode(value, { stream: true });
	for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
		const raw = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (!raw.trim()) continue;
		let o: Record<string, unknown>;
		try {
			o = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (typeof o.type === "string") {
			recordLine({ command: o.type, id: o.id, ...(o.type === "set_model" ? { provider: o.provider, modelId: o.modelId } : {}) });
		}
		if (o.type === "get_state") {
			const state = { ...(stateModel ? { model: stateModel } : {}), isSettled: !running && !backgroundPending && !woken };
			const reply = script.stateFail
				? { id: o.id, type: "response", command: "get_state", success: false, error: "fake get_state failure" }
				: { id: o.id, type: "response", command: "get_state", success: true, data: script.noSession ? state : { ...state, sessionFile: session, sessionId } };
			if (script.stateOnAbort && !script.stateFail) {
				heldState = reply;
				emit({ id: o.id, type: "response", command: "get_state", success: true, data: state });
			} else if (script.stateDelayMs) setTimeout(() => emit(reply), script.stateDelayMs);
			else emit(reply);
		} else if (o.type === "set_model") {
			// omp://rpc.md § Model: `{ type: "set_model", provider, modelId }` answers with the selected Model.
			stateModel = { provider: String(o.provider ?? ""), id: String(o.modelId ?? "") };
			emit({ id: o.id, type: "response", command: "set_model", success: true, data: stateModel });
		} else if (o.type === "prompt") {
			const message = String(o.message ?? "");
			recordLine({ event: "prompt", id: o.id, message });
			promptId = typeof o.id === "string" ? o.id : null;
			emit({ id: o.id, type: "response", command: "prompt", success: true });
			void runPrompt(message);
		} else if (o.type === "abort") {
			recordLine({ event: "abort" });
			if (heldState) emit(heldState);
			heldState = null;
			emit({ id: o.id, type: "response", command: "abort", success: true });
			if (!script.ignoreAbort && running && !aborted) {
				aborted = true;
				result("aborted");
			}
		}
	}
}
eofSeen = true;
recordLine({ event: "eof" });
if (backgroundPending) recordLine({ event: "background-killed" });
if (script.ignoreEof) await new Promise<never>(() => undefined);
if (script.eofDelayMs) await Bun.sleep(script.eofDelayMs);
await shutdown();
