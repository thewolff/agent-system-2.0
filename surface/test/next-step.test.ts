// Issue #334 item 3 (principle 2: every failure names its next step): every needs-you line kind the surface shows Jo carries a
// next step, or says exactly "no next step known". The kind list is the one ErrorKind is read from, so a new kind lands here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lineWithNext } from "../src/delivery";
import { NEEDS_YOU_KINDS, NO_NEXT_STEP } from "../src/errors";

const SRC = join(import.meta.dir, "..", "src");
/** Every object literal in the surface source that builds a needs-you line: `kind: "<kind>"` with a `line` beside it. */
const sources = ["errors.ts"].map((f) => readFileSync(join(SRC, f), "utf8")).join("\n");

describe("every needs-you line kind names its next step", () => {
	test("the kind list is the full union: sixteen kinds, none repeated", () => {
		expect(NEEDS_YOU_KINDS).toHaveLength(16);
		expect(new Set(NEEDS_YOU_KINDS).size).toBe(16);
	});

	test("each kind is built somewhere with a `next` field, and no line is built without one", () => {
		for (const kind of NEEDS_YOU_KINDS) {
			// The train lines are built through one `push(rowId, line, next, state?)` helper, which takes the next step positionally.
			if (kind === "train") {
				expect(sources).toContain('out.push({ kind: "train", workloadId: wl, rowId, line, next,');
				continue;
			}
			const builds = [...sources.matchAll(new RegExp(`kind: "${kind}"(?: as const)?,[^\\n]*`, "g"))].map((m) => m[0]);
			expect({ kind, built: builds.length > 0 }).toEqual({ kind, built: true });
			for (const b of builds) expect({ kind, b, next: /\bnext: /.test(b) }).toEqual({ kind, b, next: true });
		}
	});

	test("NO_NEXT_STEP is the explicit words, and a line that does not already say its step shows it after the line", () => {
		expect(NO_NEXT_STEP).toBe("no next step known");
		expect(lineWithNext({ line: "daily self-heal report 3 heals", next: NO_NEXT_STEP })).toBe("daily self-heal report 3 heals — next: no next step known");
		expect(lineWithNext({ line: "held 3h on x — relaunch, close, or instruct", next: "relaunch, close, or instruct" })).toBe("held 3h on x — relaunch, close, or instruct");
	});
});
