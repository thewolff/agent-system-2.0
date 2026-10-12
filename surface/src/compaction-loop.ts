// The compaction loop (MIGRATION.md item 111): a lane whose OMP auto-compacts before turn after turn is stuck,
// and no continue prompt breaks it. Measured 2026-10-12 on workload wl-mv457r7iqmq29s (model
// openai-codex/gpt-6-sol): lane-5's rpc log held 858 `auto_compaction_start` frames for 858 `turn_start`
// frames, one compaction before every turn for four hours; lane-3 259 compacted turns of 259, lane-4 48 of 48.
// The other 243 lane rpc logs under ~/.agent-system-2/lanes (246 in all, re-measured 2026-10-12) never compacted
// before two turns in a row. So COMPACTION_LOOP_TURNS consecutive compacted turns is the loop, not a long session.
//
// A turn is compacted when an `auto_compaction_start` frame arrived since the previous `turn_start` (OMP emits
// it just before the turn it compacts for, `{"type":"auto_compaction_start","reason":"threshold",…}`), whether
// the compaction then ran or was skipped: both alternate in the loop. Two readers share that rule:
//  - the runner (surface/scripts/lane.ts `run`) steps `compactionStep` over every frame and stops the lane;
//  - the invariant report (surface/scripts/invariants.ts `compaction-loop`) reads the tail of a lane's rpc log
//    backwards, a bounded number of bytes (`trailingCompactionRun`), for a lane whose runner did not stop it.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { LANE_DIED_PREFIX } from "./types";

/** Consecutive compacted turns that make a loop: 5 (healthy lanes measured at most 1; the loop lanes ran 48 to 858). */
export const COMPACTION_LOOP_TURNS = 5;
export const COMPACTION_LOOP_REASON = "compaction-loop";

/** The runner's count across frames. */
export interface CompactionWatch {
	/** An `auto_compaction_start` arrived since the last `turn_start`. */
	pending: boolean;
	/** Consecutive compacted turns, the newest included. */
	run: number;
	turns: number;
	compactions: number;
}
export const COMPACTION_WATCH_START: CompactionWatch = { pending: false, run: 0, turns: 0, compactions: 0 };

/** One rpc frame's `type`, stepped; any other type leaves the watch as it is. */
export function compactionStep(w: CompactionWatch, type: unknown): CompactionWatch {
	if (type === "auto_compaction_start") return { ...w, pending: true, compactions: w.compactions + 1 };
	if (type === "turn_start") return { pending: false, run: w.pending ? w.run + 1 : 0, turns: w.turns + 1, compactions: w.compactions };
	return w;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The evidence, one line: the run, the totals this run, the model. Shared by the assumption entry and the death line. */
export function compactionEvidence(w: CompactionWatch, model: string | null): string {
	return `OMP auto-compacted before ${w.run} consecutive turns (${w.compactions} auto_compaction_start for ${w.turns} turn_start in this run) on ${model ?? "the profile default model"}`;
}

/** The runner's `assumption` entry, written before it stops the lane. */
export function compactionLoopBody(laneId: string, w: CompactionWatch, model: string | null): string {
	return `${COMPACTION_LOOP_REASON}: ${laneId} stopped by the runner: ${oneLine(compactionEvidence(w, model))}; a relaunch on the same model is expected to loop again (MIGRATION.md item 111)`;
}

/** `lane-died: <laneId>: compaction-loop: <evidence>`: the needs-you line (surface/src/errors.ts item 4). */
export function compactionLoopDeathBody(laneId: string, w: CompactionWatch, model: string | null): string {
	return `${LANE_DIED_PREFIX} ${laneId}: ${COMPACTION_LOOP_REASON}: ${oneLine(compactionEvidence(w, model))}; relaunch on another model or after a fresh session`;
}

/** What `trailingCompactionRun` read. */
export interface TailRun {
	/** Consecutive compacted turns ending at the newest `turn_start`. */
	run: number;
	turns: number;
	compactions: number;
	bytesRead: number;
	/** The run reached the byte cap or the start of the file without a turn that was not compacted. */
	open: boolean;
}

const CHUNK = 1 << 20;
const HEAD = 64;
const TURN_START = '{"type":"turn_start"';
const COMPACTION_START = '{"type":"auto_compaction_start"';

/**
 * The run of compacted turns at the end of a lane's rpc log (`lane-<n>.jsonl`, one frame per line as the runner
 * wrote it), read backwards in 1 MiB chunks and never more than `maxBytes`. Only each line's first bytes are
 * looked at (frames are written with `type` first; the loop's compaction-end frames run to megabytes), so a scan
 * costs the bytes read, not a parse. It stops at the first turn that was not compacted, so a healthy log costs
 * a chunk or two. Null when the file is missing.
 */
export function trailingCompactionRun(path: string, maxBytes = 16 * CHUNK): TailRun | null {
	if (!existsSync(path)) return null;
	const size = statSync(path).size;
	const out: TailRun = { run: 0, turns: 0, compactions: 0, bytesRead: 0, open: true };
	let seenTurn = false;
	let saw = false;
	/** Reverse order: a compaction seen before the next (earlier) turn_start belongs to the later turn. */
	const mark = (head: string): boolean => {
		if (head.startsWith(COMPACTION_START)) {
			saw = true;
			out.compactions += 1;
		} else if (head.startsWith(TURN_START)) {
			out.turns += 1;
			if (seenTurn) {
				if (!saw) {
					out.open = false;
					return false;
				}
				out.run += 1;
			}
			seenTurn = true;
			saw = false;
		}
		return true;
	};
	const fd = openSync(path, "r");
	try {
		let pos = size;
		/** The first bytes of the line that starts before `pos` and was cut by the chunk boundary. */
		let carry = Buffer.alloc(0);
		while (pos > 0 && out.bytesRead < maxBytes) {
			const len = Math.min(CHUNK, pos, maxBytes - out.bytesRead);
			pos -= len;
			const chunk = Buffer.alloc(len);
			readSync(fd, chunk, 0, len, pos);
			out.bytesRead += len;
			let end = len;
			let first = true;
			for (let i = len - 1; i >= -1; i--) {
				if (i >= 0 && chunk[i] !== 0x0a) continue;
				const piece = chunk.subarray(i + 1, Math.min(end, i + 1 + HEAD));
				const head = first && end - (i + 1) < HEAD ? Buffer.concat([piece, carry]).subarray(0, HEAD) : piece;
				if (i === -1 && pos > 0) {
					carry = Buffer.from(head);
					break;
				}
				if (!mark(head.toString("utf8"))) return out;
				first = false;
				end = i;
			}
		}
		// The start of the file: the earliest turn's compaction counts as it would have forward.
		if (pos === 0 && seenTurn) {
			if (saw) out.run += 1;
			else out.open = false;
		}
		return out;
	} finally {
		closeSync(fd);
	}
}
