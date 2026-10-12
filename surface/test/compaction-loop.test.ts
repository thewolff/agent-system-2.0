// MIGRATION.md item 111: the compaction-loop rule, forward (the runner's `compactionStep`) and backward over a lane rpc
// log's tail (`trailingCompactionRun`, the invariant's read), on synthetic event streams shaped like
// ~/.agent-system-2/lanes/wl-mv457r7iqmq29s/lane-5.jsonl: `auto_compaction_start` just before each `turn_start`, and
// compaction-end frames large enough to cross the 1 MiB read chunks.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACTION_LOOP_TURNS, COMPACTION_WATCH_START, compactionStep, trailingCompactionRun } from "../src/compaction-loop";

const dir = mkdtempSync(join(tmpdir(), "compaction-loop-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const C = '{"type":"auto_compaction_start","reason":"threshold","action":"remote"}';
const T = '{"type":"turn_start"}';
/** A compaction end the size of the loop's (the remote replacement history rides it). */
const big = (bytes: number) => JSON.stringify({ type: "auto_compaction_end", action: "remote", result: { summary: "x".repeat(bytes) } });
const E = '{"type":"turn_end"}';
const tool = '{"type":"tool_execution_start","toolCallId":"c1","toolName":"ledger_wake_read","args":{}}';

/** A turn: compacted (with an end frame of `endBytes`) or not, then a tool call and the turn end. */
const turn = (compacted: boolean, endBytes = 200): string[] => [...(compacted ? [C, big(endBytes)] : []), T, tool, E];
const write = (name: string, lines: string[], trailingNewline = true): string => {
	const p = join(dir, name);
	writeFileSync(p, lines.join("\n") + (trailingNewline ? "\n" : ""));
	return p;
};
const forward = (lines: string[]) => {
	let w = COMPACTION_WATCH_START;
	let max = 0;
	for (const l of lines) {
		w = compactionStep(w, (JSON.parse(l) as { type: string }).type);
		max = Math.max(max, w.run);
	}
	return { ...w, max };
};

describe("compactionStep (the runner, forward)", () => {
	test("a compaction before every turn counts each turn; a turn without one resets the run; other frames change nothing", () => {
		const loop = Array.from({ length: COMPACTION_LOOP_TURNS }, () => turn(true)).flat();
		expect(forward(loop)).toMatchObject({ run: 5, turns: 5, compactions: 5, pending: false });
		const broken = [...turn(true), ...turn(true), ...turn(false), ...turn(true)];
		expect(forward(broken)).toMatchObject({ run: 1, turns: 4, compactions: 3, max: 2 });
		// healthy lanes measured: one compaction in a long session never makes a run past 1
		const healthy = [...Array.from({ length: 40 }, () => turn(false)).flat(), ...turn(true), ...Array.from({ length: 40 }, () => turn(false)).flat()];
		expect(forward(healthy).max).toBe(1);
		// a compaction after the last turn belongs to the next turn, not the last one
		expect(forward([...turn(false), C])).toMatchObject({ run: 0, pending: true });
	});
});

describe("trailingCompactionRun (the invariant, backward over the tail)", () => {
	test("agrees with the forward count at the end of the file, for loops, broken runs and healthy logs", () => {
		const cases: string[][] = [
			Array.from({ length: 8 }, () => turn(true)).flat(),
			[...turn(true), ...turn(false), ...Array.from({ length: 3 }, () => turn(true)).flat()],
			Array.from({ length: 20 }, (_, i) => turn(i === 7)).flat(),
			[...turn(true), ...turn(true), C],
		];
		cases.forEach((lines, i) => {
			const path = write(`agree-${i}.jsonl`, lines);
			expect(trailingCompactionRun(path)!.run).toBe(forward(lines).run);
		});
	});

	test("compaction-end frames bigger than a read chunk (1 MiB) and an unterminated last line still read line by line", () => {
		const lines = Array.from({ length: 6 }, () => turn(true, 1_500_000)).flat();
		const path = write("big.jsonl", lines, false);
		const r = trailingCompactionRun(path)!;
		expect(r).toMatchObject({ run: 6, turns: 6, compactions: 6, open: true });
	});

	test("a healthy log stops at its first plain turn: one chunk read, not the file", () => {
		const lines = [...Array.from({ length: 30 }, () => turn(true, 400_000)).flat(), ...turn(false), ...turn(false)];
		const r = trailingCompactionRun(write("healthy.jsonl", lines))!;
		expect(r).toMatchObject({ run: 0, open: false });
		expect(r.bytesRead).toBeLessThanOrEqual(1 << 20);
	});

	test("the byte cap bounds the read; a run still open at the cap is reported as open", () => {
		const lines = Array.from({ length: 40 }, () => turn(true, 300_000)).flat();
		const r = trailingCompactionRun(write("capped.jsonl", lines), 2 << 20)!;
		expect(r.bytesRead).toBe(2 << 20);
		expect(r.open).toBe(true);
		expect(r.run).toBeGreaterThanOrEqual(COMPACTION_LOOP_TURNS);
		expect(r.run).toBeLessThan(40);
	});

	test("a missing file is null; an empty one is no run", () => {
		expect(trailingCompactionRun(join(dir, "missing.jsonl"))).toBeNull();
		expect(trailingCompactionRun(write("empty.jsonl", [], false))).toMatchObject({ run: 0, turns: 0 });
	});
});
