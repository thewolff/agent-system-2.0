// The routine classifier under a deadline (PLAN wl-mvqwn80onq9hq8 D2 "Deadline", r2 finding 4). The row 6 gate's
// `tool_call` handler is async; it runs `routineVerdict` in a Bun Worker thread (this same file, loaded as the worker's
// entry) and races the worker's reply against a 2-second timer. On timeout it terminates the worker, and a late reply
// is ignored. A worker that fails to start, throws, exits, or posts a malformed reply asks Jo too: only a well-formed
// `{ rule }` reply that arrives before the deadline lets the gate go on to its write (D3). The main thread never runs
// the classifier, so a stalled lstat inside it cannot block the session.
import { type RoutineContext, type RoutineVerdict, routineVerdict } from "./routine";
import type { ToolCall } from "./types";

/** The deadline on one classification (D2). */
export const CLASSIFY_DEADLINE_MS = 2000;

/** What the main thread posts: the call and its context, both plain data. */
interface ClassifyRequest {
	call: ToolCall;
	ctx: RoutineContext;
}

export interface ClassifyOptions {
	/** The deadline, default CLASSIFY_DEADLINE_MS. */
	timeoutMs?: number;
	/** The worker's entry, default this file; a test points it at a stalling or failing worker. */
	entry?: string | URL;
	/** Arms the deadline: `fire` after `ms`, returning its disarm. Default a real timer; a test drives it with a fake clock. */
	deadline?: (ms: number, fire: () => void) => () => void;
}

const realDeadline = (ms: number, fire: () => void): (() => void) => {
	const timer = setTimeout(fire, ms);
	return () => clearTimeout(timer);
};

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** The reply as a verdict, or `{ ask }` naming why it is malformed. */
export function parseVerdict(reply: unknown): RoutineVerdict {
	if (reply === null || typeof reply !== "object") return { ask: `the classifier worker posted a malformed reply (${JSON.stringify(reply)})` };
	if ("ask" in reply) return typeof reply.ask === "string" && reply.ask !== "" ? { ask: reply.ask } : { ask: "the classifier worker posted an ask with no reason" };
	if (!("rule" in reply) || !("detail" in reply) || typeof reply.detail !== "string" || !("network" in reply)) {
		return { ask: `the classifier worker posted a malformed reply (${JSON.stringify(reply).slice(0, 200)})` };
	}
	if (reply.rule === "read-only" && typeof reply.network === "boolean" && "readers" in reply && isStrings(reply.readers)) {
		return { rule: "read-only", detail: reply.detail, network: reply.network, readers: reply.readers };
	}
	if ((reply.rule === "scratch" || reply.rule === "worktree") && reply.network === false && "root" in reply && typeof reply.root === "string" && reply.root.startsWith("/")) {
		return { rule: reply.rule, detail: reply.detail, network: false, root: reply.root };
	}
	return { ask: `the classifier worker posted a malformed reply (${JSON.stringify(reply).slice(0, 200)})` };
}

/**
 * `routineVerdict(call, ctx)` in a worker, under `timeoutMs`. Never rejects: every failure is an `{ ask }` naming it
 * (`classifier timeout after <n> ms`, `classifier worker failed: …`, a malformed reply).
 */
export async function classifyUnderDeadline(call: ToolCall, ctx: RoutineContext, opts: ClassifyOptions = {}): Promise<RoutineVerdict> {
	const timeoutMs = opts.timeoutMs ?? CLASSIFY_DEADLINE_MS;
	let worker: Worker;
	try {
		worker = new Worker(opts.entry ?? new URL(import.meta.url).href);
	} catch (err) {
		return { ask: `classifier worker failed to start: ${err instanceof Error ? err.message : String(err)}` };
	}
	let disarm = (): void => {};
	const reply = new Promise<RoutineVerdict>((resolve) => {
		worker.onmessage = (e: MessageEvent) => resolve(parseVerdict(e.data));
		worker.onerror = (e: ErrorEvent) => resolve({ ask: `classifier worker failed: ${e.message || "an error with no message"}` });
		worker.addEventListener("close", () => resolve({ ask: "classifier worker exited before it replied" }));
	});
	// A deadline seam that throws rejects this promise, and the race's catch below turns it into an ask.
	const deadline = new Promise<RoutineVerdict>((resolve) => {
		disarm = (opts.deadline ?? realDeadline)(timeoutMs, () => resolve({ ask: `classifier timeout after ${timeoutMs} ms` }));
	});
	try {
		const request: ClassifyRequest = { call: { toolName: call.toolName, input: call.input }, ctx: { ...ctx } };
		worker.postMessage(request);
		return await Promise.race([reply, deadline]);
	} catch (err) {
		return { ask: `classifier worker failed: ${err instanceof Error ? err.message : String(err)}` };
	} finally {
		disarm();
		// Settled either way: a stalled worker is stopped, and a late reply has no listener left to reach.
		worker.onmessage = null;
		worker.terminate();
	}
}

// The worker side: one request, one reply. `routineVerdict` catches its own exceptions as `{ ask }`; anything else
// thrown here reaches the main thread as the worker's error event.
if (!Bun.isMainThread) {
	self.onmessage = (e: MessageEvent<ClassifyRequest>) => {
		postMessage(routineVerdict(e.data.call, e.data.ctx));
	};
}
