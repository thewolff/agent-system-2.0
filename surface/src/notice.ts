// The notice channel (PLAN wl-mvfkv7llkp7nk0 § 2): something Jo is told and does not answer — a ceiling
// reached, a plan that started on its own. A notice is a held lane→orchestrator message whose body opens
// with `notice: `, on the same path as every other machinery signal (ORCHESTRATOR_RECIPIENT); it is never a
// `questions` row. surface/src/errors.ts shows it as an unnumbered needs-you line of kind `notice` while it is
// held, the surface's delivery moves it to `delivered` (surface/src/delivery.ts), and from then on it no longer
// shows. Its writers are trusted tool code (the ceiling meter, the plan auto-start), never a lane's own words:
// a notice written by a lane that holds or held the workload is shown as that lane's plain message instead.
import type { Ledger } from "../../ledger/src/index";
import { ORCHESTRATOR_RECIPIENT } from "./types";

/** Body prefix of a notice message. */
export const NOTICE_PREFIX = "notice:";

/** Enqueue a notice to the orchestrator on `workloadId`, written and sent as `by`; returns the message id. */
export function sendNotice(ledger: Ledger, input: { by: string; workloadId: string; body: string }): string {
	const text = input.body.trim();
	if (!text) throw new Error("a notice has a body");
	return ledger.enqueue({ by: input.by, workloadId: input.workloadId, sender: input.by, recipient: ORCHESTRATOR_RECIPIENT, body: `${NOTICE_PREFIX} ${text}` });
}
