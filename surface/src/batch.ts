// Batched needs-you arrivals (PLAN wl-mv5msri070p0qo D3, D4; the window replaced by the status clock,
// PLAN wl-mv8igegljun18g D1): which § B3 lines go out on their own poll (on fire) and which wait in the
// session's hold for the next status batch (surface/src/status.ts), plus the blocks the surface adds
// around them. Pure: reads only; the hold itself lives on the session (surface/src/session.ts) and the
// poll and Jo's turn drive it (surface/extensions/wake.ts).
//
// On fire (D3), a line pushes at once on the poll that finds it:
// 1. `lane-died` on a workload that still has open or paused slices;
// 2. a `question` that is the runner's ceiling question (`isCeilingQuestion`): spend at 80 %, and the
//    stop at 100 % through the line's `stopped` state (surface/src/errors.ts);
// 3. `idle` whose `lane-exit:` is `outcome stop reason ceiling`: a ceiling stop after the question
//    was answered or withdrawn;
// 4. `test-run`: a red or error full-suite run at a PR head.
// Everything else waits for the status batch.
import type { Ledger } from "../../ledger/src/index";
import type { ErrorLine } from "./errors";
import { isCeilingQuestion } from "./input";
import { controlEntries, laneExit } from "./launch";
import { pendingBlock, pendingItems, pendingWaits } from "./pending";

/** Jo's turn after `back` (D4): the hold and the complete list, each item written up. */
export const BACK_HEADING = "back: everything waiting on you (complete list; write each up with its content)";
/** Jo's turn after a quiet stretch (D4): the complete list, once. */
export const QUIET_HEADING = "quiet stretch: everything waiting on you (complete list, once)";
/** The heading of a needs-you push and of a Jo turn carrying lines new since his last turn. */
export const NEEDS_YOU_HEADING = "needs you (new since your last turn)";
/** `brb`'s one confirmation (D4; the status batch held too, PLAN wl-mv8igegljun18g D5). */
export const AWAY_NOTICE = "holding status batches and needs-you pushes until `back`; on-fire items still come through";

/** A line's identity, as `Delivered` keys it (surface/src/delivery.ts): `kind:workloadId:rowId`. */
export const lineKey = (l: ErrorLine): string => `${l.kind}:${l.workloadId}:${l.rowId}`;

/** The surface word the whole trimmed input is (D1, D4), case-insensitive; null for anything else. */
export function surfaceWord(text: string): "pending" | "brb" | "back" | null {
	const w = text.trim().toLowerCase();
	return w === "pending" || w === "brb" || w === "back" ? w : null;
}

/** Whether `line` goes out on its own poll rather than waiting for the window (the four kinds above). */
export function onFire(ledger: Ledger, line: ErrorLine): boolean {
	switch (line.kind) {
		case "lane-died": {
			const w = ledger.workload(line.workloadId);
			return w !== null && (w.open_slices > 0 || w.paused_slices > 0);
		}
		case "question": {
			const q = ledger.question(line.rowId);
			return q !== null && isCeilingQuestion(q, ledger.slice(q.slice_id));
		}
		case "idle": {
			const exit = controlEntries(ledger.entries(line.workloadId, "assumption")).find((c) => c.id === line.rowId);
			const parsed = exit?.prefix === "lane-exit" && exit.laneId !== null ? laneExit([exit], exit.laneId) : null;
			return parsed !== null && parsed.outcome === "stop" && parsed.reason === "ceiling";
		}
		case "test-run":
			return true;
		default:
			return false;
	}
}

/** The lines of `current` whose identity is in `keys`, in `current`'s order and with its text and `#n`: the re-check against a fresh read. */
export function present(keys: ReadonlySet<string>, current: readonly ErrorLine[]): ErrorLine[] {
	return current.filter((l) => keys.has(lineKey(l)));
}

/** The `pending` block: every open answer line, with the prompt waits under it (surface/src/pending.ts). */
export function pendingText(ledger: Ledger): string {
	return pendingBlock(pendingItems(ledger), pendingWaits(ledger)).text;
}

/** How many open answer lines the `pending` block lists: the N of the count line and of the status quiet line (PLAN wl-mv8igegljun18g D4). */
export function openAnswerCount(ledger: Ledger): number {
	return pendingBlock(pendingItems(ledger)).count;
}

/** The count line every needs-you push, status batch and Jo turn carries (D3): N is the pending block's count. */
export function countLine(ledger: Ledger): string {
	return `open answer lines: ${openAnswerCount(ledger)} (\`pending\` shows them all)`;
}
