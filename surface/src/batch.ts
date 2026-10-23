// Batched needs-you arrivals (PLAN wl-mv5msri070p0qo D3, D4): which § B3 lines go out on their own
// poll (on fire) and which wait in the session's hold for one push per window, plus the blocks the
// surface adds around them. Pure: reads only; the hold itself lives on the session
// (surface/src/session.ts) and the poll and Jo's turn drive it (surface/extensions/wake.ts).
//
// On fire (D3), a line pushes at once on the poll that finds it:
// 1. `lane-died` on a workload that still has open or paused slices; `incident` (PLAN wl-mvfqvd5hy8zv28 § 1.5), the one
//    line a spent relaunch budget writes in place of the death it hides, always;
// 2. a `notice` that is the runner's ceiling notice (`parseCeilingNotice`, written by the lane runner): spend at
//    80 %, or the stop at 100 % (PLAN wl-mvfkv7llkp7nk0 § 4);
// 3. `idle` whose `lane-exit:` is `outcome stop reason ceiling`: a ceiling stop;
// 4. `test-run`: a red or error full-suite run at a PR head;
// 5. `pair` (PLAN wl-mvb9mw00ycfjeo D4): a taken line.
// Everything else waits for the window, every other `notice` line (surface/src/notice.ts) among them.
import { LANE_RUNNER_BY, type Ledger } from "../../ledger/src/index";
import { parseCeilingNotice } from "./ceiling";
import type { ErrorLine } from "./errors";
import { controlEntries, laneExit } from "./launch";
import { pendingBlock, pendingItems, pendingWaits } from "./pending";

/** Jo's turn after `back` (D4): the hold and the complete list, each item written up. */
export const BACK_HEADING = "back: everything waiting on you (complete list; write each up with its content)";
/** Jo's turn after a quiet stretch (D4): the complete list, once. */
export const QUIET_HEADING = "quiet stretch: everything waiting on you (complete list, once)";
/** The heading of a needs-you push and of a Jo turn carrying lines new since his last turn. */
export const NEEDS_YOU_HEADING = "needs you (new since your last turn)";
/** `brb`'s one confirmation (D4). */
export const AWAY_NOTICE = "holding needs-you pushes until `back`; on-fire items still come through";

/** A line's identity, as `Delivered` keys it (surface/src/delivery.ts): `kind:workloadId:rowId`. */
export const lineKey = (l: ErrorLine): string => `${l.kind}:${l.workloadId}:${l.rowId}`;

/** The surface word the whole trimmed input is (D1, D4), case-insensitive; null for anything else. */
export function surfaceWord(text: string): "pending" | "brb" | "back" | null {
	const w = text.trim().toLowerCase();
	return w === "pending" || w === "brb" || w === "back" ? w : null;
}

/** Whether `line` goes out on its own poll rather than waiting for the window (the kinds above). */
export function onFire(ledger: Ledger, line: ErrorLine): boolean {
	switch (line.kind) {
		case "lane-died": {
			const w = ledger.workload(line.workloadId);
			return w !== null && (w.open_slices > 0 || w.paused_slices > 0);
		}
		case "notice": {
			const m = ledger.message(line.rowId);
			return m !== null && m.created_by === LANE_RUNNER_BY && parseCeilingNotice(m.body) !== null;
		}
		case "pair":
			return line.state === "taken";
		case "idle": {
			const exit = controlEntries(ledger.entries(line.workloadId, "assumption")).find((c) => c.id === line.rowId);
			const parsed = exit?.prefix === "lane-exit" && exit.laneId !== null ? laneExit([exit], exit.laneId) : null;
			return parsed !== null && parsed.outcome === "stop" && parsed.reason === "ceiling";
		}
		case "test-run":
		case "incident":
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

/** The count line every needs-you push and every Jo turn carries (D3): N is the pending block's count. */
export function countLine(ledger: Ledger): string {
	return `open answer lines: ${pendingBlock(pendingItems(ledger)).count} (\`pending\` shows them all)`;
}
