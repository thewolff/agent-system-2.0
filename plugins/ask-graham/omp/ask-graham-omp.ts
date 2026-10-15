// ask-graham-omp.ts — the OMP half of the every-idea nudge.
//
// OMP does not run a plugin's hooks/hooks.json, so the Claude Code UserPromptSubmit hook never
// fires there. This extension does the same job on OMP's `input` event, which fires for each
// message the user submits (source "interactive" from the editor, "rpc" over RPC). It resolves
// the level from the session's working directory (skills/ask-graham/scripts/intensity.mjs) and,
// only at every-idea, queues NUDGE as hidden context for that turn (sendMessage, deliverAs
// "nextTurn", display false). It never revises the input. Text another extension injects
// (source "extension") is not the user's idea and gets no nudge.
//
// The plugin's package.json declares this file under omp.extensions, which OMP loads for an
// installed marketplace plugin.
//
// SYNTAX: erasable-types TypeScript only, so node strips the types and imports this file in the
// unit tests without Bun. `pi` is typed structurally; there are no imports from the host.

import { NUDGE, resolveIntensity } from "../skills/ask-graham/scripts/intensity.mjs";

export type OmpContext = { cwd: string };

export type PiLike = {
	on(event: "input", handler: (event: { text: string; source: string }, ctx: OmpContext) => unknown): void;
	sendMessage?(message: { customType: string; content: string; display: boolean }, options: { deliverAs: "nextTurn" }): void;
};

export type AdapterDeps = {
	env?: Record<string, string | undefined>;
	home?: string;
};

export default function askGrahamOmp(pi: PiLike, deps: AdapterDeps = {}): void {
	const env = deps.env ?? process.env;
	pi.on("input", (event, ctx) => {
		if (event?.source === "extension") return undefined;
		let level: string;
		try {
			level = resolveIntensity({ cwd: ctx.cwd, env, home: deps.home }).level;
		} catch {
			return undefined; // fail open: an unreadable setting behaves as ask
		}
		if (level === "every-idea") {
			pi.sendMessage?.({ customType: "ask-graham", content: NUDGE, display: false }, { deliverAs: "nextTurn" });
		}
		return undefined;
	});
}
