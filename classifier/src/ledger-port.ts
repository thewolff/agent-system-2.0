// The classifier's view of the ledger. Routing rows are written through the ledger module's
// `recordRouting` (schema v5, ledger/src/index.ts) and read back through `routingsForHand` — the row
// for exactly one session root and allocated agent id — when a delivery reaches an instance that did
// not settle it. The cross-lab review rule (classifier/src/lab.ts) reads the workload's stakes, its
// routings, entries, questions and instructions, and writes its entries (`recordEntry`, kind
// `assumption`) and park questions (`raiseQuestion`) in one `write` transaction where the plan asks for
// one; `enqueue` carries a message to the orchestrator. `db` is read only by the auto-apply switch the review auto-extend
// checks inside its write (gates/src/routine-switch.ts `routineOn`, PLAN wl-mvqwn80onq9hq8 D10). Nothing here opens the
// file, and the classifier runs no SQL of its own.
import type { Ledger } from "../../ledger/src/index";

/** The subset of the ledger module the classifier calls. `Ledger` satisfies it structurally. */
export type RoutingLedger = Pick<
	Ledger,
	| "slice"
	| "recordRouting"
	| "routingsForHand"
	| "workload"
	| "routings"
	| "questions"
	| "instructions"
	| "entries"
	| "raiseQuestion"
	| "recordEntry"
	| "write"
	| "enqueue"
	| "db"
>;
