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
// `artifact-failed:` message from ever meaning "no live lane" (fable (a)). A notice
// (surface/src/notice.ts) is shown only while held, so this one step is also what makes it shown once. An ALERT line (PLAN
// wl-mw0vs9uc3xqtka D4, surface/src/errors.ts `alertLines`) carries no message, so a delivery consumes nothing of it: it is
// level-triggered, delivered again at each new state (its level and standing errors), and shown until its episode ends.
import { type Ledger, type MessageRow, TEST_RUNNER_BY } from "../../ledger/src/index";
import type { ErrorLine } from "./errors";
import { QUOTA_MOVE_PREFIX, trustedQuotaMove } from "./quota-move-alert";
import { parseSecurityRed, SECURITY_RED_PREFIX } from "./test-run";
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

	get size(): number {
		return this.#seen.size;
	}
}

/** Move every held orchestrator-bound message behind `lines` to `delivered`: the surface has read them. */
export function consumeLines(ledger: Ledger, lines: ErrorLine[]): number {
	let n = 0;
	for (const l of lines) {
		for (const id of l.messageIds ?? []) {
			const m = ledger.message(id);
			if (!m || m.state !== "held" || m.recipient !== ORCHESTRATOR_RECIPIENT) continue;
			ledger.advanceMessage(id, "delivered", { by: SURFACE_BY });
			n++;
		}
	}
	return n;
}

/**
 * At a wake the whole queue was rendered: every held orchestrator-bound message on an open workload
 * is delivered, and on a closed one every held trusted `security-red:` and every held trusted
 * `quota-move:` (`trustedQuotaMove`), which the render shows whatever the workload's state
 * (surface/src/errors.ts, fix round 1 F3; PLAN wl-mvwk0v0gmp6cjc D4); no other message on a closed
 * workload is touched. The on-demand ledger read (orchestrator_ledger) does the same, for one
 * workload when it rendered one.
 */
export function consumeAllToOrchestrator(ledger: Ledger, workloadId?: string): number {
	const sql = `SELECT m.*, w.status FROM messages m JOIN workloads w ON w.id = m.workload_id
		WHERE m.state = 'held' AND m.recipient = ?1 AND (w.status = 'open' OR instr(m.body, ?2) = 1 OR instr(m.body, ?3) = 1)
		${workloadId ? "AND m.workload_id = ?4" : ""} ORDER BY m.created_at, m.rowid`;
	const q = ledger.db.query<MessageRow & { status: string }, [string, string, string] | [string, string, string, string]>(sql);
	const rows = workloadId ? q.all(ORCHESTRATOR_RECIPIENT, SECURITY_RED_PREFIX, QUOTA_MOVE_PREFIX, workloadId) : q.all(ORCHESTRATOR_RECIPIENT, SECURITY_RED_PREFIX, QUOTA_MOVE_PREFIX);
	// On a closed workload only the trusted signals the render showed: the runner's security red with a well-formed body naming
	// its own workload, and a quota move as `recordQuotaMove` wrote it.
	const held = rows.filter((m) =>
		m.status === "open" ||
		(m.created_by === TEST_RUNNER_BY && parseSecurityRed(m.body)?.workloadId === m.workload_id) ||
		trustedQuotaMove(ledger, m) !== null);
	for (const { id } of held) ledger.advanceMessage(id, "delivered", { by: SURFACE_BY });
	return held.length;
}

/** A line's text with its next step (issue #334 item 3): `<line> — next: <step>` unless the line already says the step. */
export function lineWithNext(l: Pick<ErrorLine, "line" | "next">): string {
	return l.next && !l.line.includes(l.next) ? `${l.line} — next: ${l.next}` : l.line;
}

/** One needs-you bullet: `- #<n> <line>` when the line is numbered (a literal `#`, so a markdown renderer cannot renumber it), else `- <line>`; the line with its next step. */
export function needsYouBullet(l: ErrorLine): string {
	const text = lineWithNext(l);
	return l.n === undefined ? `- ${text}` : `- #${l.n} ${text}`;
}

/** The lines as one block for the turn's context or a pushed message. */
export function needsYouBlock(lines: ErrorLine[], heading: string): string {
	return [`## ${heading}`, ...lines.map(needsYouBullet)].join("\n");
}
