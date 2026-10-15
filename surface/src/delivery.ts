// Delivery of the § B3 lines to a running surface between wakes (Codex B1): a line reaches the
// orchestrator once, and again only when its state changes — the row it is about is different, or
// the state token on the line moved (an artifact count grew). Quiet by default: nothing else is
// delivered on this channel (SPEC-2.0.md:413-414). The wake render seeds the tracker with every
// line it carried; the poll (surface/extensions/wake.ts) and the next turn's context take only the
// rest. Lines that disappear are forgotten, so a state that recurs is delivered again — except an
// idle line (MIGRATION.md item 68), which is keyed by one `lane-exit:` entry and is remembered for the
// session: a question or a hold masking it for a while is not a new ending, and only a newer exit
// entry (a new identity) is pushed again.
//
// The consumer half: a delivered line's held orchestrator-bound messages move to `delivered`
// (P-7c one step), which is what makes a lane death "surfaced once" and what keeps a held
// `artifact-failed:` message from ever meaning "no live lane" (fable (a)).
import type { Ledger } from "../../ledger/src/index";
import type { ErrorLine } from "./errors";
import { ORCHESTRATOR_RECIPIENT, SURFACE_BY } from "./types";

const identity = (l: ErrorLine): string => `${l.kind}:${l.workloadId}:${l.rowId}`;

export class Delivered {
	/** identity → state token at the last delivery. */
	#seen = new Map<string, string>();

	/** The lines not yet delivered in their current state; records them as delivered now. */
	take(lines: ErrorLine[]): ErrorLine[] {
		const current = new Set<string>();
		const fresh: ErrorLine[] = [];
		for (const l of lines) {
			const id = identity(l);
			current.add(id);
			const state = l.state ?? "";
			if (this.#seen.get(id) === state) continue;
			this.#seen.set(id, state);
			fresh.push(l);
		}
		// an idle line's identity is one lane-exit: entry, which never recurs as a new state: keep it
		for (const id of [...this.#seen.keys()]) if (!current.has(id) && !id.startsWith("idle:")) this.#seen.delete(id);
		return fresh;
	}

	/** Whether the line with this identity (`kind:workloadId:rowId`) was delivered in some state and is still remembered. */
	has(identity: string): boolean {
		return this.#seen.has(identity);
	}

	get size(): number {
		return this.#seen.size;
	}
}

/** Move each of `ids` that is still a held orchestrator-bound message to `delivered`: the surface has shown it (a message an earlier delivery moved is skipped). */
export function consumeIds(ledger: Ledger, ids: readonly string[]): number {
	let n = 0;
	for (const id of ids) {
		const m = ledger.message(id);
		if (!m || m.state !== "held" || m.recipient !== ORCHESTRATOR_RECIPIENT) continue;
		ledger.advanceMessage(id, "delivered", { by: SURFACE_BY });
		n++;
	}
	return n;
}

/** Move every held orchestrator-bound message behind `lines` to `delivered`: the surface has read them. */
export function consumeLines(ledger: Ledger, lines: ErrorLine[]): number {
	return consumeIds(ledger, lines.flatMap((l) => l.messageIds ?? []));
}

/**
 * The on-demand ledger read (orchestrator_ledger) rendered every held orchestrator-bound message on an open
 * workload (or on the one workload it rendered) whole in its blocks: they are delivered. A wake consumes only
 * what its delta section rendered whole (PLAN wl-mv8igegljun18g D2a), through `consumeIds`.
 */
export function consumeAllToOrchestrator(ledger: Ledger, workloadId?: string): number {
	const sql = `SELECT m.id FROM messages m JOIN workloads w ON w.id = m.workload_id WHERE w.status = 'open' AND m.state = 'held' AND m.recipient = ?1 ${workloadId ? "AND m.workload_id = ?2" : ""} ORDER BY m.created_at, m.rowid`;
	const q = ledger.db.query<{ id: string }, [string] | [string, string]>(sql);
	const held = workloadId ? q.all(ORCHESTRATOR_RECIPIENT, workloadId) : q.all(ORCHESTRATOR_RECIPIENT);
	for (const { id } of held) ledger.advanceMessage(id, "delivered", { by: SURFACE_BY });
	return held.length;
}

/** One needs-you bullet: `- #<n> <line>` when the line is numbered (a literal `#`, so a markdown renderer cannot renumber it), else `- <line>`. */
export function needsYouBullet(l: ErrorLine): string {
	return l.n === undefined ? `- ${l.line}` : `- #${l.n} ${l.line}`;
}

/** The lines as one block for the turn's context or a pushed message. */
export function needsYouBlock(lines: ErrorLine[], heading: string): string {
	return [`## ${heading}`, ...lines.map(needsYouBullet)].join("\n");
}
