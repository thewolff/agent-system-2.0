// Worker for publication/off tests: synchronous holder across an off word, or an intentionally overlong holder for waiter recovery.
import { appendFileSync } from "node:fs";
import { Ledger } from "../../../ledger/src/index";
import { landFirstOn } from "../../src/launch";
import { STANDING_WORKLOAD_ID } from "../../src/types";
import { withFullSuitePublication } from "../../src/test-run";

declare const self: Worker;
self.onmessage = (event: MessageEvent<{ root: string; repo: string; ledgerPath?: string; signal: SharedArrayBuffer; events: string; holdMs?: number }>) => {
	const { root, repo, ledgerPath, signal, events, holdMs } = event.data;
	const flags = new Int32Array(signal);
	try {
		withFullSuitePublication(root, repo, () => {
			if (holdMs === undefined) {
				const ledger = Ledger.open(ledgerPath!, { readonly: true });
				const on = landFirstOn(ledger.entries(STANDING_WORKLOAD_ID), ledger.instructions(STANDING_WORKLOAD_ID), repo);
				ledger.close();
				if (!on) throw new Error("publisher fixture expected live activation on before the off word");
			}
			appendFileSync(events, "publisher-read-on\n");
			self.postMessage("locked");
			const waited = Atomics.wait(flags, 0, 0, holdMs ?? 5_000);
			if (holdMs === undefined && waited === "timed-out") throw new Error("publisher fixture: off word/reconciliation did not arrive within 5 seconds");
			appendFileSync(events, "publisher-success\n");
		});
		self.postMessage("released");
	} catch (error) {
		self.postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
};
