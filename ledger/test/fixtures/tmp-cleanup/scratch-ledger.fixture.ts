// tmp-cleanup fixture: the existing classifier helper scratchLedger(), which puts its ledger under
// LEDGER_TEST_TMP when that is set. FIX_BLOCK: wait for stdin to close before closing the ledger.
import { test } from "bun:test";
import { scratchLedger } from "../../../../classifier/test/helpers";
import { block, ready } from "./io";

test("tmp-cleanup fixture: scratchLedger", async () => {
	const { ledger } = scratchLedger();
	ready();
	await block();
	ledger.close();
}, 120_000);
