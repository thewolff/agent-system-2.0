// plugins/index.ts — the one OMP extension entry for Jo's vendored plugins (plugins/VENDOR.md):
// i-have-audhd (the AuDHD core at each session crossing, a Stop check that warns unless armed),
// ask-graham (a hidden "should we build this?" nudge on before_agent_start at intensity every-idea,
// and a Stop check on turns that read the skill) and paired-coding (agreed change sets, the pair_*
// tools and their write gate).
//
// WHO GETS WHAT (PLAN-2 D4). AGENT_SYSTEM_ROLE is set by bin/as2 (orchestrator) and the lane
// launcher (lane); AGENT_SYSTEM_BY_HAND=1 only by `as2 lane`'s by-hand launch, which the autonomous
// launch clears.
//   orchestrator           i-have-audhd, ask-graham
//   lane                   i-have-audhd, ask-graham
//   lane, by hand          i-have-audhd, ask-graham, paired-coding (agreement and typed `pair stop`
//                          need a person at the keyboard; an rpc lane has none)
//   hand, or no role       nothing
//
// HANDS ARE FOUND BY SESSION CONTEXT, NOT ENVIRONMENT. OMP rebinds the parent's prepared extension
// factories into every subagent session (task/executor.ts, sdk.ts preloadedPreparedExtensions), so a
// hand runs this factory with the parent's role and by-hand values still set, and a factory gets no
// session context. So every adapter is bound inert, and the first handler this extension registers is
// a session_start bootstrap that classifies the session:
//   - a child is `ctx.agent.kind === "sub"` (OMP's own task-depth identity), or failing that the
//     gates' parent-session test (gates/src/session.ts roleOf: no UI and a header parentSession);
//   - anything else is this bound instance's own session, and its adapters are enabled.
// Each adapter's `on` handler is registered at bind time as a trampoline that calls it only while its
// instance is enabled. The bootstrap sits before every trampoline in the same handler array, so the
// first session_start reaches each adapter once, through its trampoline: no handler is called by hand
// and none is appended while OMP dispatches. registerTool, registerCommand and every other
// register* call are buffered and replayed onto the real API once per bound instance, the first time
// it is enabled (OMP installs a tool registered from session_start into the live registry). A repeated
// session_start re-registers nothing.
//
// Listed last in profile/config.yml's extensions: OMP returns the first session_stop block, so the
// surface's and the gates' blocks come first, and the gates' tool_call checks run before
// paired-coding's (VENDOR.md clash C3).

import askGrahamOmp from "./ask-graham/omp/ask-graham-omp.ts";
import iHaveAudhdOmp from "./i-have-audhd/omp/i-have-audhd-omp.ts";
import { bindPairedCoding } from "./paired-as2.ts";

export const ROLE_ENV = "AGENT_SYSTEM_ROLE";
export const BY_HAND_ENV = "AGENT_SYSTEM_BY_HAND";

export type Role = "orchestrator" | "lane";
type Env = Record<string, string | undefined>;
type Handler = (event: unknown, ctx: unknown) => unknown;

/** The members of OMP's ExtensionAPI this file touches; the adapters see the whole API through the gate. */
export interface PluginsPi {
	on(event: string, handler: Handler): void;
}

/** What one vendored adapter needs from this loader. */
export interface PluginAdapter {
	name: string;
	/** Whether a session of `role` (by hand or not) runs this adapter at all. */
	admits(role: Role, byHand: boolean): boolean;
	bind(pi: never, deps: { env: Env; home?: string }): void;
}

export const ADAPTERS: readonly PluginAdapter[] = [
	{ name: "i-have-audhd", admits: () => true, bind: (pi) => iHaveAudhdOmp(pi) },
	{ name: "ask-graham", admits: () => true, bind: (pi, deps) => askGrahamOmp(pi, { env: deps.env, home: deps.home }) },
	{ name: "paired-coding", admits: (role, byHand) => role === "lane" && byHand, bind: (pi, deps) => bindPairedCoding(pi, { env: deps.env }) },
];

export interface PluginsDeps {
	/** The environment the role is read from (default process.env); ask-graham and paired-coding also read it. */
	env?: Env;
	/** ask-graham's home for its user config file (default os.homedir()). */
	home?: string;
	/** Replaced in tests only. */
	adapters?: readonly PluginAdapter[];
}

export function roleOf(env: Env): Role | null {
	const role = env[ROLE_ENV];
	return role === "orchestrator" || role === "lane" ? role : null;
}

/** The session context this file reads; OMP's ExtensionContext carries all of it. */
export interface SessionContext {
	agent?: { kind?: string };
	hasUI?: boolean;
	sessionManager?: { getHeader?(): { parentSession?: string } | null | undefined };
}

/** A subagent session: OMP's own identity first, then the gates' parent-session test (gates/src/session.ts roleOf). */
export function isChildSession(ctx: SessionContext): boolean {
	if (ctx.agent?.kind === "sub") return true;
	return !ctx.hasUI && Boolean(ctx.sessionManager?.getHeader?.()?.parentSession);
}

interface Gate {
	enabled: boolean;
	replayed: boolean;
	registrations: (() => void)[];
}

/** `pi` as the adapters see it: `on` registers a gated trampoline, register* is buffered, the rest passes through. */
function gatedApi(pi: PluginsPi, gate: Gate): never {
	return new Proxy(pi, {
		get(target, prop) {
			if (prop === "on") {
				return (event: string, handler: Handler) => target.on(event, (e, ctx) => (gate.enabled ? handler(e, ctx) : undefined));
			}
			const value: unknown = Reflect.get(target, prop);
			if (typeof value !== "function") return value;
			if (typeof prop === "string" && /^register[A-Z]/.test(prop)) {
				return (...args: unknown[]) => {
					gate.registrations.push(() => value.apply(target, args));
				};
			}
			return value.bind(target);
		},
	}) as never;
}

export default function jowolffPlugins(pi: PluginsPi, deps: PluginsDeps = {}): void {
	const env = deps.env ?? process.env;
	const role = roleOf(env);
	if (!role) return;
	const byHand = env[BY_HAND_ENV] === "1";
	const admitted = (deps.adapters ?? ADAPTERS).filter((a) => a.admits(role, byHand));
	if (admitted.length === 0) return;

	const gate: Gate = { enabled: false, replayed: false, registrations: [] };
	// First in this extension's session_start array, before any adapter's trampoline.
	pi.on("session_start", (_event, ctx) => {
		gate.enabled = !isChildSession(ctx as SessionContext);
		if (!gate.enabled || gate.replayed) return undefined;
		gate.replayed = true;
		for (const register of gate.registrations) register();
		return undefined;
	});
	const gated = gatedApi(pi, gate);
	for (const adapter of admitted) adapter.bind(gated, { env, home: deps.home });
}
