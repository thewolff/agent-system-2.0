// Jo's model intent as typed words (PLAN wl-mv8d45mqycd8g0 rev 3, D1): the one narrow line grammar
// `lane model <selector> for <wl-…>` that names the model a workload's lanes run on. Syntax only:
// this module reads lines and never decides whether a selector is a model Jo can name
// (`modelProblem`, surface/src/launch.ts) nor whether the words are Jo's authentic input
// (`isJoInput`, surface/src/orchestrator-question.ts); it imports neither, so the capture, the
// recorder and the launch decision each validate what it returns.
//
// A model line is a whole line, read case-insensitively: `lane model`, an optional colon after
// `model`, the selector, `for`, the workload id, an optional sentence period, then optional
// whitespace and a `#` tail (the five-word form's own comment; input.ts `stripTail` reads only
// two-word commands). A line that opens with `lane model` but is not that shape is a near miss,
// reported so a caller can refuse it rather than let it pass as prose. Anything else — a quoted
// line, a mention inside a sentence, a model named in a reading — is not a model line.

/** One model line of an input: its 1-based line number, the selector as typed (`default` lower-cased), and the target workload id (lower-cased). */
export interface ModelLine {
	line: number;
	selector: string;
	target: string;
}

/** A line that opens with `lane model` but does not parse as a model line: its 1-based number and its trimmed text. */
export interface ModelNearMiss {
	line: number;
	text: string;
}

export interface ModelLines {
	lines: ModelLine[];
	nearMisses: ModelNearMiss[];
}

const MODEL_LINE = /^lane\s+model:?\s+(\S+)\s+for\s+(wl-[a-z0-9]+)\.?(?:\s*#.*)?$/i;
const MODEL_PREFIX = /^lane\s+model\b/i;

/** The correction line Jo sends to name (or clear, with `default`) a workload's lane model. */
export const modelLineShape = (target: string): string => `lane model <provider/model> for ${target}`;

/** Every model line and near miss in `text`, in line order. */
export function modelLines(text: string): ModelLines {
	const lines: ModelLine[] = [];
	const nearMisses: ModelNearMiss[] = [];
	for (const [i, raw] of text.split("\n").entries()) {
		const t = raw.trim();
		const m = MODEL_LINE.exec(t);
		if (m) {
			lines.push({ line: i + 1, selector: m[1]!.toLowerCase() === "default" ? "default" : m[1]!, target: m[2]!.toLowerCase() });
			continue;
		}
		if (MODEL_PREFIX.test(t)) nearMisses.push({ line: i + 1, text: t });
	}
	return { lines, nearMisses };
}
