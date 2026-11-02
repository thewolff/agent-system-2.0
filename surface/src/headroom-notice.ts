// Shared Anthropic weekly usage is advisory: the original message is the durable once-per-window
// marker, even after delivery. Keep the check and enqueue together; no process-local latch or schema.
import { headroom, type Headroom } from "../../classifier/src/headroom";
import type { Ledger } from "../../ledger/src/index";
import { ensureStandingWorkload } from "./identity";
import { NOTICE_PREFIX, sendNotice } from "./notice";
import { ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "./types";

const WEEK_NOTICE_PREFIX = `${NOTICE_PREFIX} Anthropic 7-day meter `;
const WEEK_NOTICE_RESET = /^notice: Anthropic 7-day meter [^;\n]*, resets ([^;\n]+); weekly pace does not block dispatch; Jo decides whether to change usage\.$/;
const RESET_JITTER_MS = 60_000;

/**
 * Observe fresh shared weekly headroom and return the queued notice id, or null for no new notice.
 * `snapshot` replaces the reader for deterministic callers; `path` and `now` otherwise go to headroom.
 * Read/write failures propagate to the surface's existing error reporting, never marking a failed send.
 */
export function notifyAnthropicWeek(ledger: Ledger, opts: { now?: number; path?: string; snapshot?: Pick<Headroom, "anthropicWeek"> } = {}): string | null {
	const now = opts.now ?? Date.now();
	const week = (opts.snapshot ?? headroom({ now, path: opts.path })).anthropicWeek;
	if (week === null || week.used < 0.70) return null;
	const reset = new Date(week.resetsAt).toISOString();
	return ledger.write(() => {
		ensureStandingWorkload(ledger);
		// No state predicate: delivered, consumed and acted-on messages remain the dedup evidence.
		const previous = ledger.db.query<{ body: string }, [string, string, string, string, string]>(
			"SELECT body FROM messages WHERE workload_id = ? AND created_by = ? AND sender = ? AND recipient = ? AND instr(body, ?) = 1",
		).all(STANDING_WORKLOAD_ID, SURFACE_BY, SURFACE_BY, ORCHESTRATOR_RECIPIENT, WEEK_NOTICE_PREFIX);
		for (const row of previous) {
			const match = WEEK_NOTICE_RESET.exec(row.body);
			if (!match) continue;
			const notifiedReset = Date.parse(match[1]!);
			if (Number.isFinite(notifiedReset) && Math.abs(notifiedReset - week.resetsAt) <= RESET_JITTER_MS) return null;
		}
		const percent = (fraction: number): string => String(Number((fraction * 100).toFixed(1)));
		return sendNotice(ledger, {
			by: SURFACE_BY,
			workloadId: STANDING_WORKLOAD_ID,
			body: `Anthropic 7-day meter ${percent(week.used)}% used (${percent(1 - week.used)}% left), resets ${reset}; weekly pace does not block dispatch; Jo decides whether to change usage.`,
		});
	});
}
