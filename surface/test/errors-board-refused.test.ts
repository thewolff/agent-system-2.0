// The needs-you line for the tick's `train-board-refused:` (PLAN wl-mvr888nftz0vcl D2, surface/src/errors.ts
// `boardRefusalLines`): one line per standing refusal, naming the PR, its repository and the one merge train with the
// repository it serves, and gone once a train boards that PR. Real temp ledger, no gh.
import { describe, expect, test } from "bun:test";
import { errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { applyTrain, interpret } from "../src/input";
import { trainBoardBody, trainBoardRefusedBody } from "../src/launch";
import { trainCheckout } from "../src/merge-train";
import { MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tempLedger, tmp } from "./helpers";

const SHA = "a".repeat(40);

function world() {
	const c = clock();
	const { ledger } = tempLedger(c.now);
	const lane = ledger.openWorkload({ by: SURFACE_BY, brief: "fix the parser", stakes: "normal", mode: "autonomous" });
	const refuse = (pr: number, repo: string) => {
		c.plusHours(0.01);
		return ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: lane, kind: "assumption", body: trainBoardRefusedBody(pr, repo) });
	};
	return { ledger, c, lane, refuse };
}

describe("train-board-refused on the needs-you list (D2)", () => {
	test("one train line per standing refusal, naming the PR, its repository and the train with the repository it serves", () => {
		const { ledger, lane, refuse } = world();
		const cmd = interpret(ledger, "train 101");
		if (cmd?.kind !== "train") throw new Error(`not a train: ${JSON.stringify(cmd)}`);
		const train = applyTrain(ledger, cmd, tmp("train-repo")).workloadId;
		const serves = trainCheckout(ledger, train)!;
		refuse(42, "jowolff/other-repo");
		const id = refuse(42, "jowolff/other-repo");
		const lines = errorLines(ledger).filter((l) => l.kind === "train" && l.workloadId === lane);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ rowId: id, next: "merge #42 of jowolff/other-repo yourself: the one merge train takes PRs of its own repository only" });
		expect(lines[0]!.line).toBe(
			`merge train: #42 of jowolff/other-repo (${lane}) was not boarded: merge train ${train} serves ${serves} — merge #42 of jowolff/other-repo yourself: the one merge train takes PRs of its own repository only`,
		);
	});

	test("with no train open the line says so; a later train-board of the same PR clears it", () => {
		const { ledger, c, lane, refuse } = world();
		refuse(7, "jowolff/x");
		const line = errorLines(ledger).find((l) => l.kind === "train" && l.workloadId === lane);
		expect(line?.line).toBe(`merge train: #7 of jowolff/x (${lane}) was not boarded: no merge train is open now — merge #7 of jowolff/x yourself: the one merge train takes PRs of its own repository only`);
		c.plusHours(0.01);
		const other = ledger.openWorkload({ by: SURFACE_BY, brief: "a train", stakes: "normal", mode: "autonomous" });
		ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: other, kind: "assumption", body: trainBoardBody({ pr: 7, workload: lane, head: SHA, run: "tr-x1", review: "en-x1" }) });
		expect(errorLines(ledger).some((l) => l.kind === "train" && l.workloadId === lane)).toBe(false);
	});

	test("the tick's row on the standing workload naming a closed landing W shows on W, naming the PR, its repository and the train", () => {
		const { ledger, c } = world();
		ensureStandingWorkload(ledger);
		const landed = ledger.openWorkload({ by: SURFACE_BY, brief: "landed elsewhere", stakes: "normal", mode: "autonomous" });
		ledger.closeWorkload(landed, { by: SURFACE_BY });
		c.plusHours(0.01);
		const id = ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: trainBoardRefusedBody(9, "jowolff/y", landed) });
		const lines = errorLines(ledger).filter((l) => l.rowId === id);
		expect(lines).toEqual([expect.objectContaining({ kind: "train", workloadId: landed })]);
		expect(lines[0]!.line).toBe(`merge train: #9 of jowolff/y (${landed}) was not boarded: no merge train is open now — merge #9 of jowolff/y yourself: the one merge train takes PRs of its own repository only`);
	});
});
