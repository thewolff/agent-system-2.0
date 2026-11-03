// chaos-stub: the scripted model provider of the nightly chaos run (the approved plan of workload
// wl-mv45yxnkw2251c, revision 4, § 2.3; Jo's instruction in-mv461vwad5gpvk: the provider refusal is
// simulated here and nothing is ever sent to a real provider). chaos.ts starts it in-process:
//
//   startStub({ nonce, scripts }) → { port, setMode(m), mode(), held(), windows(), counts(), log(), stop() }
//   writeStubProfile(agentDir, port, options)   models.yml stub routes + config.yml role overlay
//   bun surface/scripts/chaos-stub.ts judge-probe <cwd> [<brief>]   one judge call through OMP's own client
//
// ── Wire formats, read from the installed OMP 18.8.6 (@oh-my-pi under ~/.bun/install/global) ──
// • POST /v1/messages, Anthropic Messages SSE: the events pi-ai/src/providers/anthropic.ts parses
//   (`message_start` with `usage`, `content_block_start` text/tool_use, `content_block_delta`
//   text_delta/input_json_delta, `content_block_stop`, `message_delta` with `stop_reason`,
//   `message_stop`; an event before message_start is an envelope error). The URL is
//   `{baseUrl}/v1/messages` (the Anthropic SDK's `baseURL`).
// • The refusal (plan § 2.4 fault 4): `message_delta` `{ stop_reason: "refusal", stop_details:
//   { type: "refusal", category: "cyber", explanation } }`. anthropic.ts mapStopReason maps
//   "refusal" to stopReason "error" and the message_delta branch sets errorMessage
//   `Refusal (<category>): <explanation>`. In rpc mode the prompt_result carries
//   `error.retryable = AIError.is(classifyMessage(…), Flag.Transient)`
//   (pi-coding-agent/src/modes/rpc/rpc-prompt-results.ts promptError); the test asserts false.
// • POST /v1/systemone, TypeSafe System One: request `{ model, state, questions: { <id>: { type:
//   noul|choice|score, instructions, criteria? } } }`, response `{ model, answers, usage: {
//   input_tokens, output_tokens } }` (pi-ai/src/providers/systemone-server.ts). The client is
//   pi-ai/src/judgment/typesafe.ts: route JUDGMENT_ROUTES.typesafe = "/v1/systemone" (and
//   "/decisions" for openrouter-decisions), and it throws ProviderResponseError unless every
//   answer's `type` equals its question's `type`, so the stub echoes each question's `type`.
//   The reported judge is `${provider}/${response.model}` (classifier/src/classify.ts), so the
//   stub echoes the request's `model`: typesafe/jev-1.13.0 passes the classifier's calibration
//   check (classifier/extension.ts `classification.judgeModel !== deps.calibration.judgeModel`).
//   Choice answers are `{ type: "choice", choice, confidence, probabilities }` summing to 1
//   (pi-ai/src/judgment/types.ts ChoiceAnswer; classify.ts checkedAnswer).
//
// ── The judge entry outside a session ──
// OMP ships one: `openStandaloneJudge(cwd, purpose)` in
// pi-coding-agent/src/judgment/standalone.ts ("Judge for commands that run outside an agent
// session"): project settings, the auth store, the model registry, then `resolveJudge` — the same
// `resolveJudge` the classifier calls with the session's settings and registry
// (classifier/extension.ts productionExtension). `judge-probe` below imports it from the omp on
// PATH and runs the classifier's own `classify()` with classifier/kind-question.json, so the
// preflight exercises the judge role chain, the TypeSafe client and the classifier's answer checks.
//
// ── Every modelRoles key of the installed OMP ──
// The settings schema registers `modelRoles` as a record (pi-coding-agent/src/config/
// model-settings.ts cfgModelRoles); its built-in keys are MODEL_ROLE_IDS in
// pi-tui/src/overlays/model-browser.ts, with what each accepts in pi-coding-agent/src/config/
// model-roles.ts MODEL_ROLES:
//   chat roles  default smol slow vision plan commit tiny memory task advisor   (chat models; tiny/memory also tiny)
//   kind roles  image (image) web (search, or chat with webSearch) speech (tts) dictation (stt)
//               judge (judge, tiny or chat)
// ROLE_IDS below is that list; installedRoleIds() re-reads it from the installed file, and the
// overlay routes the union, so a role a later OMP adds is routed too (the test fails on drift).
//
// ── Routing (omp://models.md § "Merge and override order", § "Allowed provider/model api values",
//    § "Allowed auth/discovery values"; pi-coding-agent/src/config/model-registry.ts,
//    model-patch.ts resolveProviderBaseUrl) ──
// Adapted from plan § 2.3, which put `api: anthropic-messages` at provider level: a provider-level
// `api` does not change a built-in model's api, it only SCOPES the provider `baseUrl` to models of
// that api (model-registry.ts: "a provider-level api covers the override-only case"). openai-codex
// (openai-codex-responses) and moonshot (openai-completions) would then keep their real hosts. So
// each routed provider gets `baseUrl` with no provider `api` (scope unset = provider-wide), `auth:
// apiKey`, `apiKey: chaos-stub`, and a `modelOverrides.<id>.api: anthropic-messages` for every
// catalog chat/tiny model whose api is not already anthropic-messages. A built-in model's own
// baseUrl never wins over an unscoped provider baseUrl (resolveProviderBaseUrl). The catalog is the
// installed pi-catalog/src/models.json. Providers whose transport is in-process (`local`:
// local-inference, `web`: web-search) carry no HTTP endpoint and are not rewritten. muse-code's
// transport parses its key as JSON (pi-ai/src/registry/muse-code.ts), so its stub key is the
// literal chaos-stub in that shape.
//
// ── Background egress (measured against the proxy by surface/test/chaos-stub.test.ts) ──
// Model discovery of many providers calls a fixed host, not the routed baseUrl, from every omp
// start. config.yml therefore disables every provider the run does not name. What remains is the
// shared catalog fetch (https://catalog.stencil.so/models.json.zstd, pi-catalog/src/provider-models/
// openai-compat.ts MODELS_DEV_URL) of each enabled built-in provider: it can never succeed behind the
// proxy, so the provider's model cache stays non-authoritative and is refetched once it is 5 min old
// (pi-catalog/src/model-manager.ts NON_AUTHORITATIVE_RETRY_MS). A fresh profile's first omp start
// makes it, and so does any omp start 5 min or more after the last such fetch.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classify, type KindJudge, loadKindQuestion } from "../../classifier/src/classify";

// ───────────────────────────── the stub ─────────────────────────────

/** The literal key every routed provider carries; the stub records whether a request presented it. */
export const STUB_API_KEY = "chaos-stub";

/** One tool result found in a request's conversation, in order. */
export interface StubToolResult {
	toolUseId: string;
	/** The tool name, from the assistant `tool_use` block with the same id in the same request. */
	name: string | null;
	text: string;
	isError: boolean;
}

/** What a script sees of one `/v1/messages` request. */
export interface StubRequest {
	model: string;
	/** The system prompt's text blocks joined with newlines. */
	system: string;
	/** Text of the first user message (the prompt, or a subagent's brief). */
	firstUser: string;
	/** Text of the last user message's text blocks. */
	lastUser: string;
	/** Tool names offered in the request. */
	tools: string[];
	/** Every tool result in the conversation, in order. Its length is the turn number. */
	results: StubToolResult[];
	stream: boolean;
	body: Record<string, unknown>;
}

/** One assistant turn. Every turn carries a text block holding the nonce; `tool` adds one tool call. */
export interface StubTurn {
	text?: string;
	tool?: { name: string; input: Record<string, unknown> };
}

export interface StubContext {
	request: StubRequest;
	/** The number of tool results in the request: 0 on the session's first call. */
	turn: number;
	nonce: string;
}

export type StubStep = StubTurn | ((ctx: StubContext) => StubTurn);

/**
 * One session kind's script. The first script whose `match` accepts a request answers it; a request
 * no script matches is kind "unknown" and gets a nonce text. Turn n (n tool results in the request)
 * answers with `steps[n]`; past the end, `after` (default: a nonce text that ends the turn). Steps may
 * be functions of the request, so a later step can quote an id an earlier tool result returned.
 */
export interface StubScript {
	kind: string;
	match: RegExp | ((request: StubRequest) => boolean);
	steps: StubStep[];
	after?: StubStep;
}

/** Answers a judgment question; `undefined` falls back to the default answer for its type. */
export type JudgeAnswerer = (id: string, question: JudgmentQuestion, state: unknown) => Record<string, unknown> | undefined;

export interface JudgmentQuestion {
	type: "choice" | "noul" | "score";
	instructions?: unknown;
	criteria?: unknown;
}

export interface StubOptions {
	nonce: string;
	scripts?: StubScript[];
	/** Overrides the default judgment answers (choice: `judge` for a state naming a review, else `change-small`). */
	judge?: JudgeAnswerer;
}

export type StubMode =
	| { mode: "normal" }
	/** Hold every `/v1/messages` request of session `kind` for `ms` from its arrival, then answer it. */
	| { mode: "stall"; kind: string; ms: number }
	/** Accept every provider request and send nothing; after `ms` reset every held connection and return to normal. */
	| { mode: "blackhole"; ms: number }
	/** Answer every `/v1/messages` request of session `kind` with the cyber refusal frame. */
	| { mode: "refuse"; kind: string };

/** A request the stub held open: by a stall or a blackhole. */
export interface HeldRequest {
	id: number;
	path: string;
	kind: string;
	model: string;
	reason: "stall" | "blackhole";
	since: number;
	ended: number | null;
	/** open: still held · answered: released and answered · dropped: the client closed it · reset: the stub closed it. */
	outcome: "open" | "answered" | "dropped" | "reset";
}

export interface BlackholeWindow {
	start: number;
	/** When the resets were issued, by the stub's clock; null while the window is open. */
	end: number | null;
	ms: number;
	held: number;
	reset: number;
}

export interface StubLogEntry {
	id: number;
	at: number;
	method: string;
	path: string;
	kind: string;
	model: string;
	turn: number | null;
	/** answered · refused · held · judged · not-found · bad-request */
	outcome: string;
	tool: string | null;
	/** Which key the request presented; the value itself is never recorded. */
	key: "chaos-stub" | "other" | "none";
}

export interface StubCounts {
	/** `/v1/messages` requests per model id served. */
	messages: Record<string, number>;
	/** Judgment requests per model id served. */
	judge: Record<string, number>;
	/** `/v1/messages` requests per session kind. */
	kinds: Record<string, number>;
	/** Refusal frames sent per session kind. */
	refused: Record<string, number>;
	/** Requests to any other path, per method and path. */
	other: Record<string, number>;
	/** Requests that presented a key other than chaos-stub. */
	foreignKey: number;
}

export interface Stub {
	port: number;
	baseUrl: string;
	setMode(m: StubMode): void;
	mode(): StubMode;
	held(): HeldRequest[];
	windows(): BlackholeWindow[];
	counts(): StubCounts;
	log(): StubLogEntry[];
	stop(): void;
}

/** The refusal explanation's fixed text (plan § 2.4 fault 4); the nonce follows it. */
export const REFUSAL_EXPLANATION =
	"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.";

/** A JSON object's fields, or none: the request body is outside-controlled. */
const fields = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {});

/** A string, or a content-block array's text blocks joined with newlines. */
const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const raw of content) {
		const b = fields(raw);
		if (b.type === "text" && typeof b.text === "string" && b.text !== "") texts.push(b.text);
	}
	return texts.join("\n");
};

/** The parts of an Anthropic Messages request body a script reads. */
export function parseMessagesRequest(body: Record<string, unknown>): StubRequest {
	const messages = (Array.isArray(body.messages) ? body.messages : []).map(fields);
	const names = new Map<string, string>();
	const results: StubToolResult[] = [];
	for (const m of messages) {
		if (!Array.isArray(m.content)) continue;
		for (const b of m.content.map(fields)) {
			if (m.role === "assistant" && b.type === "tool_use") names.set(String(b.id), String(b.name));
			if (m.role === "user" && b.type === "tool_result") {
				const id = String(b.tool_use_id);
				results.push({ toolUseId: id, name: names.get(id) ?? null, text: textOf(b.content), isError: b.is_error === true });
			}
		}
	}
	const users = messages.filter((m) => m.role === "user");
	return {
		model: typeof body.model === "string" ? body.model : "",
		system: textOf(body.system),
		firstUser: textOf(users[0]?.content),
		lastUser: textOf(users.at(-1)?.content),
		tools: (Array.isArray(body.tools) ? body.tools : []).map((t) => String(fields(t).name)),
		results,
		stream: body.stream === true,
		body,
	};
}

const sse = (events: Record<string, unknown>[]): string =>
	events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** The default answer for one judgment question, echoing its `type`. */
function defaultAnswer(question: JudgmentQuestion, state: unknown): Record<string, unknown> {
	if (question.type === "noul") return { type: "noul", noul: 0.5 };
	if (question.type === "score") {
		const levels = Array.isArray(question.criteria) ? question.criteria.length : 2;
		const probabilities: Record<string, number> = {};
		for (let i = 0; i < levels; i++) probabilities[String(i)] = i === levels - 1 ? 0.9 : 0.1 / Math.max(1, levels - 1);
		return { type: "score", score: levels - 1, probabilities, confidence: 0.9 };
	}
	const labels =
		question.criteria && typeof question.criteria === "object" && !Array.isArray(question.criteria)
			? Object.keys(question.criteria)
			: [];
	const text = typeof state === "string" ? state : JSON.stringify(state ?? "");
	const wanted = /\breview/i.test(text) ? "judge" : "change-small";
	const choice = labels.includes(wanted) ? wanted : (labels[0] ?? wanted);
	const all = labels.length > 0 ? labels : [choice];
	const rest = all.length > 1 ? 0.1 / (all.length - 1) : 0;
	const probabilities: Record<string, number> = {};
	for (const label of all) probabilities[label] = label === choice ? (all.length > 1 ? 0.9 : 1) : rest;
	return { type: "choice", choice, confidence: 0.9, probabilities };
}

export function startStub(options: StubOptions): Stub {
	const { nonce } = options;
	const scripts = options.scripts ?? [];
	let current: StubMode = { mode: "normal" };
	let seq = 0;
	let ids = 0;
	const heldList: HeldRequest[] = [];
	const windowList: BlackholeWindow[] = [];
	const logList: StubLogEntry[] = [];
	const counts: StubCounts = { messages: {}, judge: {}, kinds: {}, refused: {}, other: {}, foreignKey: 0 };
	const bump = (map: Record<string, number>, key: string) => {
		map[key] = (map[key] ?? 0) + 1;
	};
	/** Holds still open, by held id: the record and the hook that ends it. */
	const live = new Map<number, { held: HeldRequest; release: (how: "answered" | "reset" | "stop") => void }>();
	let blackholeTimer: Timer | undefined;

	const keyOf = (req: Request): StubLogEntry["key"] => {
		const raw = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
		if (raw === null || raw === "") return "none";
		return raw === STUB_API_KEY ? "chaos-stub" : "other";
	};

	const kindOf = (request: StubRequest): StubScript | null => {
		for (const s of scripts) {
			const hit = s.match instanceof RegExp ? s.match.test(request.system) : s.match(request);
			if (hit) return s;
		}
		return null;
	};

	/** Hold `req` until released (answered), reset by the stub, or dropped by the client; resolves with the outcome. */
	const hold = (req: Request, record: Omit<HeldRequest, "id" | "since" | "ended" | "outcome">, ms: number | null): Promise<HeldRequest["outcome"]> => {
		const held: HeldRequest = { ...record, id: ++ids, since: Date.now(), ended: null, outcome: "open" };
		heldList.push(held);
		const { promise, resolve } = Promise.withResolvers<HeldRequest["outcome"]>();
		let timer: Timer | undefined;
		const end = (outcome: HeldRequest["outcome"]) => {
			if (held.outcome !== "open") return false;
			held.outcome = outcome;
			held.ended = Date.now();
			clearTimeout(timer);
			live.delete(held.id);
			return true;
		};
		// A reset ends the record first, so the abort that follows it resolves the hold without rewriting it.
		req.signal.addEventListener("abort", () => {
			end("dropped");
			resolve(held.outcome);
		});
		if (ms !== null) timer = setTimeout(() => end("answered") && resolve("answered"), ms);
		live.set(held.id, {
			held,
			release: (how) => {
				if (how === "answered") {
					if (end("answered")) resolve("answered");
				} else if (how === "stop") {
					// The server is stopping and closes the socket itself.
					if (end("reset")) resolve("reset");
				} else if (end("reset")) {
					// Close the socket with no response: a 1 s idle timeout on this request makes Bun end the
					// connection (the client sees ECONNRESET), and the abort then resolves the hold.
					server.timeout(req, 1);
				}
			},
		});
		return promise;
	};

	/** Answer one `/v1/messages` request with its script's step; returns the tool it called, if any. */
	const answerMessages = (request: StubRequest, script: StubScript | null): { response: Response; tool: string | null } => {
		const turn = request.results.length;
		const step = script ? (turn < script.steps.length ? script.steps[turn]! : (script.after ?? {})) : {};
		const t: StubTurn = typeof step === "function" ? step({ request, turn, nonce }) : step;
		const id = `msg_chaos_${++seq}`;
		const text = t.text ? `[${nonce}] ${t.text}` : `[${nonce}]`;
		const toolId = `toolu_chaos_${seq}`;
		const stop = t.tool ? "tool_use" : "end_turn";
		const usage = { input_tokens: 1, output_tokens: 1 };
		const tool = t.tool?.name ?? null;
		if (!request.stream) {
			const content: Record<string, unknown>[] = [{ type: "text", text }];
			if (t.tool) content.push({ type: "tool_use", id: toolId, name: t.tool.name, input: t.tool.input });
			return { tool, response: Response.json({ id, type: "message", role: "assistant", model: request.model, content, stop_reason: stop, stop_sequence: null, usage }) };
		}
		const events: Record<string, unknown>[] = [
			{ type: "message_start", message: { id, type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, stop_sequence: null, usage } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
			{ type: "content_block_stop", index: 0 },
		];
		if (t.tool) {
			events.push(
				{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: toolId, name: t.tool.name, input: {} } },
				{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(t.tool.input) } },
				{ type: "content_block_stop", index: 1 },
			);
		}
		events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" });
		return { tool, response: new Response(sse(events), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } }) };
	};

	const refusal = (request: StubRequest): Response => {
		const id = `msg_chaos_${++seq}`;
		const usage = { input_tokens: 1, output_tokens: 0 };
		const stopDetails = { type: "refusal", category: "cyber", explanation: `${REFUSAL_EXPLANATION} [${nonce}]` };
		if (!request.stream) {
			return Response.json({ id, type: "message", role: "assistant", model: request.model, content: [], stop_reason: "refusal", stop_details: stopDetails, stop_sequence: null, usage });
		}
		return new Response(
			sse([
				{ type: "message_start", message: { id, type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, stop_sequence: null, usage } },
				{ type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null, stop_details: stopDetails }, usage: { output_tokens: 0 } },
				{ type: "message_stop" },
			]),
			{ headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
		);
	};

	const judgment = (body: Record<string, unknown>): Response | null => {
		if (typeof body.model !== "string") return null;
		const answers: Record<string, unknown> = {};
		const questions = Object.entries(fields(body.questions));
		if (questions.length === 0) return null;
		for (const [qid, raw] of questions) {
			const q = fields(raw);
			if (q.type !== "choice" && q.type !== "noul" && q.type !== "score") return null;
			const question: JudgmentQuestion = { type: q.type, instructions: q.instructions, criteria: q.criteria };
			answers[qid] = options.judge?.(qid, question, body.state) ?? defaultAnswer(question, body.state);
		}
		return Response.json({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } });
	};

	const entry = (req: Request, path: string, init: Partial<StubLogEntry>): StubLogEntry => {
		const e: StubLogEntry = { id: ++ids, at: Date.now(), method: req.method, path, kind: "", model: "", turn: null, outcome: "", tool: null, key: keyOf(req), ...init };
		if (e.key === "other") counts.foreignKey++;
		logList.push(e);
		return e;
	};

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		// Stalls and blackholes hold requests for minutes; Bun's default 10 s idle timeout would end them.
		idleTimeout: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			// OpenRouter's decisions route shares the System One wire (pi-ai/src/judgment/typesafe.ts JUDGMENT_ROUTES).
			const judging = path.endsWith("/systemone") || path.endsWith("/decisions");
			const messages = path.endsWith("/v1/messages");
			if (req.method !== "POST" || !(judging || messages)) {
				if (req.method === "POST" && path.endsWith("/count_tokens")) {
					entry(req, path, { outcome: "answered" });
					return Response.json({ input_tokens: 1 });
				}
				bump(counts.other, `${req.method} ${path}`);
				entry(req, path, { outcome: "not-found" });
				return Response.json({ type: "error", error: { type: "not_found_error", message: `chaos-stub serves no ${req.method} ${path}` } }, { status: 404 });
			}
			let body: Record<string, unknown>;
			try {
				body = fields(await req.json());
			} catch {
				entry(req, path, { outcome: "bad-request" });
				return Response.json({ type: "error", error: { type: "invalid_request_error", message: "body is not JSON" } }, { status: 400 });
			}
			const model = typeof body.model === "string" ? body.model : "";
			const request = messages ? parseMessagesRequest(body) : null;
			const script = request ? kindOf(request) : null;
			const kind = request ? (script?.kind ?? "unknown") : "judge";
			const e = entry(req, path, { kind, model, turn: request ? request.results.length : null });
			if (request) {
				bump(counts.messages, model);
				bump(counts.kinds, kind);
			} else bump(counts.judge, model);

			const arrived = current;
			if (arrived.mode === "blackhole") {
				const w = windowList.at(-1);
				if (w && w.end === null) w.held++;
				e.outcome = "held";
				await hold(req, { path, kind, model, reason: "blackhole" }, null);
				// Reached only once the socket is gone or the stub stops; nothing reads this response.
				return new Response(null, { status: 503 });
			}
			if (request && arrived.mode === "stall" && arrived.kind === kind) {
				e.outcome = "held";
				if ((await hold(req, { path, kind, model, reason: "stall" }, arrived.ms)) !== "answered") return new Response(null, { status: 503 });
			}
			if (request) {
				if (current.mode === "refuse" && current.kind === kind) {
					bump(counts.refused, kind);
					e.outcome = "refused";
					return refusal(request);
				}
				const { response, tool } = answerMessages(request, script);
				e.outcome = "answered";
				e.tool = tool;
				return response;
			}
			const res = judgment(body);
			if (!res) {
				e.outcome = "bad-request";
				return Response.json({ error: { type: "validation_error", message: "systemone: malformed request" } }, { status: 422 });
			}
			e.outcome = "judged";
			return res;
		},
	});

	/** End the open blackhole window: reset every connection it holds and record when and how many. */
	const closeWindow = () => {
		clearTimeout(blackholeTimer);
		const w = windowList.at(-1);
		if (!w || w.end !== null) return;
		w.end = Date.now();
		const holds = [...live.values()].filter((l) => l.held.reason === "blackhole");
		w.reset = holds.length;
		for (const l of holds) l.release("reset");
	};

	return {
		port: server.port!,
		baseUrl: `http://127.0.0.1:${server.port}`,
		/**
		 * A new mode ends the old one: an open blackhole window resets what it holds, and leaving a stall
		 * answers what it holds now. A blackhole returns to normal by itself after its `ms`.
		 */
		setMode(m) {
			closeWindow();
			if (current.mode === "stall" && !(m.mode === "stall" && m.kind === current.kind)) {
				for (const l of [...live.values()]) if (l.held.reason === "stall") l.release("answered");
			}
			current = m;
			if (m.mode === "blackhole") {
				windowList.push({ start: Date.now(), end: null, ms: m.ms, held: 0, reset: 0 });
				blackholeTimer = setTimeout(() => {
					closeWindow();
					current = { mode: "normal" };
				}, m.ms);
			}
		},
		mode: () => current,
		held: () => heldList.map((h) => ({ ...h })),
		windows: () => windowList.map((w) => ({ ...w })),
		counts: () => structuredClone(counts),
		log: () => logList.map((e) => ({ ...e })),
		stop() {
			clearTimeout(blackholeTimer);
			for (const l of [...live.values()]) l.release("stop");
			server.stop(true);
		},
	};
}

// ───────────────────────────── the scratch profile ─────────────────────────────

/** The installed OMP's built-in model roles (pi-tui/src/overlays/model-browser.ts MODEL_ROLE_IDS, OMP 18.8.6). */
export const ROLE_IDS = [
	"default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor",
	"image", "web", "speech", "dictation", "judge",
] as const;

/** Providers whose catalog transport is in-process (no HTTP endpoint to route). */
const IN_PROCESS_PROVIDERS: Record<string, true> = { local: true, web: true };
/** Providers OMP adds without a catalog or models.yml entry (pi-coding-agent/src/config/model-registry.ts #addImplicitDiscoverableProviders). */
const IMPLICIT_PROVIDERS = ["local", "web", "ollama", "llama.cpp", "apple", "lm-studio"];
const JUDGMENT_APIS: Record<string, true> = { typesafe: true, "openrouter-decisions": true };
/**
 * Providers whose built-in transport decodes the key before use (pi-ai/src/registry/muse-code.ts parses it
 * as JSON at discovery and on every request, and throws on a bare string): the stub key in their shape.
 */
const STUB_KEY_SHAPES: Record<string, string> = {
	"muse-code": JSON.stringify({ oauthAccessToken: STUB_API_KEY, apiKey: STUB_API_KEY }),
};

/** The `@oh-my-pi` packages dir of the omp on PATH (its bin resolves to pi-coding-agent/dist/cli.js). */
export function ompPackagesRoot(): string {
	const bin = Bun.which("omp");
	if (!bin) throw new Error("chaos-stub: omp is not on PATH");
	const root = dirname(dirname(dirname(realpathSync(bin))));
	if (!existsSync(join(root, "pi-catalog", "src", "models.json"))) {
		throw new Error(`chaos-stub: ${realpathSync(bin)} is not inside an @oh-my-pi install (no pi-catalog/src/models.json under ${root})`);
	}
	return root;
}

/** MODEL_ROLE_IDS as the installed pi-tui declares it. */
export function installedRoleIds(ompRoot: string = ompPackagesRoot()): string[] {
	const src = readFileSync(join(ompRoot, "pi-tui", "src", "overlays", "model-browser.ts"), "utf8");
	const m = /export const MODEL_ROLE_IDS[^=]*=\s*\[([^\]]*)\]/.exec(src);
	if (!m) throw new Error("chaos-stub: MODEL_ROLE_IDS not found in the installed pi-tui model-browser.ts");
	return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

interface CatalogModel {
	id: string;
	api: string;
	kind?: string;
	webSearch?: unknown;
}

export interface StubProfileOptions {
	/** Providers left exactly as the profile has them, and enabled (the egress self-test's un-routed path). */
	unrouted?: string[];
	/** The chat model every chat role is pinned to; must be a routed catalog chat model. */
	chatModel?: string;
	/** Routed providers kept enabled beyond those the roles and `task.agentModelOverrides` name. */
	enabled?: string[];
	ompRoot?: string;
}

export interface StubProfile {
	modelsPath: string;
	configPath: string;
	routedProviders: string[];
	/** Every model id a routed request can carry on the wire (bare ids, as `/v1/messages` sees them). */
	routedModelIds: string[];
	roles: Record<string, string>;
	/** Providers left enabled: those the roles and tier rows name, `enabled` and `unrouted`. */
	enabledProviders: string[];
	/** config.yml `disabledProviders`: every other provider OMP knows. */
	disabledProviders: string[];
}

/** Every `provider/model` string anywhere under `v` (the tier rows of `task.agentModelOverrides`). */
function selectorsIn(v: unknown): string[] {
	if (typeof v === "string") return v.includes("/") ? [v] : [];
	if (Array.isArray(v)) return v.flatMap(selectorsIn);
	return Object.values(fields(v)).flatMap(selectorsIn);
}

const readYaml = (path: string): Record<string, unknown> => (existsSync(path) ? fields(Bun.YAML.parse(readFileSync(path, "utf8"))) : {});
const isChat = (m: CatalogModel) => m.kind === undefined || m.kind === "chat" || m.kind === "tiny";

/**
 * Route the profile at `agentDir` to the stub on `port` (plan § 2.1 "Every role routed", § 2.3):
 * models.yml sends every catalog provider (but `unrouted`) to the stub with the literal key
 * chaos-stub, and config.yml pins every modelRoles key to a stub-routed model and sets every
 * retry.fallbackChains entry (and one per role) to []. Both files are rewritten as JSON, which is
 * YAML; keys this does not own are kept.
 *
 * config.yml also lists every provider the run does not name in `disabledProviders`. Model discovery
 * of many providers calls a fixed host rather than the provider's baseUrl (bedrock-mantle, cline,
 * openrouter, google's code-assist hosts, xiaomimimo's regions, and the shared catalog at
 * catalog.stencil.so), and each new omp process tries it again; disabled providers are not
 * discovered (pi-coding-agent/src/config/model-registry.ts `getDisabledProviderIdsFromSettings`).
 * Without this every omp start would show in the proxy log as egress.
 */
export function writeStubProfile(agentDir: string, port: number, opts: StubProfileOptions = {}): StubProfile {
	const ompRoot = opts.ompRoot ?? ompPackagesRoot();
	// The installed catalog (pi-catalog/src/models.json): provider → model id → model.
	const catalog: Record<string, Record<string, CatalogModel>> = JSON.parse(readFileSync(join(ompRoot, "pi-catalog", "src", "models.json"), "utf8"));
	const unrouted = new Set(opts.unrouted ?? []);
	const baseUrl = `http://127.0.0.1:${port}`;
	mkdirSync(agentDir, { recursive: true });

	const modelsPath = join(agentDir, "models.yml");
	const modelsDoc = readYaml(modelsPath);
	const providers = fields(modelsDoc.providers);
	const routedProviders: string[] = [];
	const routedIds = new Set<string>();
	const names = new Set([...Object.keys(catalog), ...Object.keys(providers)]);
	for (const name of [...names].sort()) {
		if (unrouted.has(name) || IN_PROCESS_PROVIDERS[name]) continue;
		const existing = fields(providers[name]);
		const models = Object.values(catalog[name] ?? {});
		const overrides: Record<string, unknown> = fields(existing.modelOverrides);
		for (const m of models) {
			routedIds.add(m.id);
			if (isChat(m) && m.api !== "anthropic-messages") overrides[m.id] = { ...fields(overrides[m.id]), api: "anthropic-messages" };
		}
		const entry: Record<string, unknown> = { ...existing, baseUrl, auth: "apiKey", apiKey: STUB_KEY_SHAPES[name] ?? STUB_API_KEY };
		delete entry.headers;
		delete entry.transport;
		delete entry.discovery;
		if (Array.isArray(existing.models)) {
			// Custom models keep a judgment api (the stub serves /v1/systemone); any other goes to the stub's
			// Messages wire. A provider with custom models scopes its baseUrl to their apis (model-registry.ts).
			entry.models = existing.models.map((raw) => {
				const m = fields(raw);
				const api = String(m.api ?? existing.api ?? "");
				const out: Record<string, unknown> = { ...m, api: JUDGMENT_APIS[api] ? api : "anthropic-messages" };
				delete out.baseUrl;
				delete out.headers;
				routedIds.add(String(m.id));
				return out;
			});
		} else delete entry.api; // unscoped: the baseUrl applies to every model of the provider
		if (Object.keys(overrides).length > 0) entry.modelOverrides = overrides;
		providers[name] = entry;
		routedProviders.push(name);
	}
	modelsDoc.providers = providers;
	writeFileSync(modelsPath, `# chaos-stub routes (surface/scripts/chaos-stub.ts writeStubProfile): every provider → ${baseUrl}\n${JSON.stringify(modelsDoc, null, 1)}\n`);

	// Roles: every chat role on one routed chat model; each kind role on a routed model it accepts, from
	// a provider the run already uses when one serves that kind.
	const routed = new Set(routedProviders);
	const configPath = join(agentDir, "config.yml");
	const config = readYaml(configPath);
	const tierProviders = selectorsIn(fields(config.task).agentModelOverrides).map((s) => s.split("/")[0]!);
	const chatModel = opts.chatModel ?? "anthropic/claude-haiku-5-5";
	const [chatProvider, ...chatRest] = chatModel.split("/");
	const chatEntry = catalog[chatProvider!]?.[chatRest.join("/")];
	if (!chatEntry || !isChat(chatEntry) || !routed.has(chatProvider!)) throw new Error(`chaos-stub: ${chatModel} is not a routed catalog chat model`);
	const preferred = new Set([chatProvider!, ...tierProviders, ...(opts.enabled ?? [])]);
	const searchOrder = [...routedProviders.filter((p) => preferred.has(p)), ...routedProviders.filter((p) => !preferred.has(p))];
	const find = (pred: (m: CatalogModel) => boolean): string | undefined => {
		for (const p of searchOrder) for (const m of Object.values(catalog[p] ?? {})) if (pred(m)) return `${p}/${m.id}`;
		return undefined;
	};
	const roles: Record<string, string> = {};
	for (const [role, selector] of Object.entries(fields(config.modelRoles))) if (typeof selector === "string") roles[role] = selector;
	const pick = (role: string, kind: string): string => {
		const hit = find((m) => m.kind === kind);
		if (!hit) throw new Error(`chaos-stub: no routed catalog model of kind ${kind} for role ${role}`);
		return hit;
	};
	const allRoles = [...new Set<string>([...ROLE_IDS, ...installedRoleIds(ompRoot), ...Object.keys(roles)])];
	for (const role of allRoles) {
		if (role === "judge") {
			const judge = roles.judge;
			const judgeProvider = judge?.split("/")[0];
			roles.judge = judge && judgeProvider && routed.has(judgeProvider) ? judge : (find((m) => m.kind === "judge") ?? chatModel);
		} else if (role === "image") roles.image = pick(role, "image");
		else if (role === "speech") roles.speech = pick(role, "tts");
		else if (role === "dictation") roles.dictation = pick(role, "stt");
		else if (role === "web") roles.web = chatEntry.webSearch !== undefined ? chatModel : (find((m) => isChat(m) && m.webSearch !== undefined) ?? chatModel);
		else roles[role] = chatModel; // every chat role, and any custom role the profile names (custom roles use chat models)
	}
	for (const [role, selector] of Object.entries(roles)) {
		const provider = selector.split("/")[0]!;
		if (!routed.has(provider)) throw new Error(`chaos-stub: role ${role} → ${selector} is not stub-routed`);
	}
	config.modelRoles = roles;
	const retry = fields(config.retry);
	const chains: Record<string, unknown[]> = {};
	for (const key of Object.keys(fields(retry.fallbackChains))) chains[key] = [];
	for (const role of allRoles) chains[role] = [];
	config.retry = { ...retry, fallbackChains: chains };
	const enabled = new Set([...Object.values(roles).map((s) => s.split("/")[0]!), ...tierProviders, ...(opts.enabled ?? []), ...unrouted]);
	// Every provider id OMP defines: the catalog's, the compat rules' (pi-catalog/src/compat/rules.json
	// `providers`, which holds runtime-only gateways such as charm-hyper that discover with no key), the
	// implicit local ones, and any the profile already disables.
	const rules = fields(fields(JSON.parse(readFileSync(join(ompRoot, "pi-catalog", "src", "compat", "rules.json"), "utf8"))).providers);
	const known = new Set([...names, ...Object.keys(rules), ...IMPLICIT_PROVIDERS, ...(Array.isArray(config.disabledProviders) ? config.disabledProviders.map(String) : [])]);
	const disabledProviders = [...known].filter((p) => !enabled.has(p)).sort();
	config.disabledProviders = disabledProviders;
	writeFileSync(configPath, `# chaos-stub overlay (surface/scripts/chaos-stub.ts writeStubProfile): every role stub-routed, no fallbacks\n${JSON.stringify(config, null, 1)}\n`);

	return { modelsPath, configPath, routedProviders, routedModelIds: [...routedIds].sort(), roles, enabledProviders: [...enabled].sort(), disabledProviders };
}

// ───────────────────────────── judge-probe ─────────────────────────────

/**
 * One classification through OMP's own judge client, outside a session: openStandaloneJudge →
 * resolveJudge (the `judge` role chain of the profile OMP_PROFILE/HOME select) → TypeSafeJudge →
 * POST {baseUrl}/v1/systemone, then the classifier's classify() with its kind question. Prints the
 * classification as one JSON line.
 */
async function judgeProbe(cwd: string, brief: string): Promise<void> {
	// Runtime-selected module: the omp on PATH decides which install's judge client runs.
	const standaloneModule: { openStandaloneJudge(cwd: string, purpose: string): Promise<{ judge: KindJudge; close(): void }> } = await import(
		join(ompPackagesRoot(), "pi-coding-agent", "src", "judgment", "standalone.ts")
	);
	const standalone = await standaloneModule.openStandaloneJudge(cwd, "chaos-preflight");
	try {
		const c = await classify(brief, standalone.judge, loadKindQuestion());
		process.stdout.write(`${JSON.stringify(c)}\n`);
	} finally {
		standalone.close();
	}
}

if (import.meta.main) {
	const [verb, cwd, brief] = process.argv.slice(2);
	if (verb !== "judge-probe" || !cwd) {
		process.stderr.write("usage: bun surface/scripts/chaos-stub.ts judge-probe <cwd> [<brief>]\n");
		process.exit(2);
	}
	try {
		await judgeProbe(cwd, brief ?? "append one line to chaos/scratch.txt and run bun test chaos/");
		process.exit(0);
	} catch (err) {
		process.stderr.write(`judge-probe: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	}
}
