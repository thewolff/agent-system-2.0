#!/usr/bin/env bun
// pair-suggest: the read-only report of the suggest-only `pair` trigger (PLAN wl-mv67564rdkfvnk § 2 D8, PR 1).
//
//   bun surface/scripts/pair-suggest.ts report [--days N]
//
// The ledger is the one the surface opens ($AGENT_SYSTEM_LEDGER_DB, else $HOME/.agent-system-2/ledger.db), opened
// `{ readonly: true }`; nothing is written anywhere. Exit 0 with the report, 1 on a bad argument, 2 when it could not
// run (no ledger to open).
//
// Lanes: every `lane-started:` written in the last N days (default 30), each in a group by `pairLaneExposure`
// (surface/src/pair-suggest.ts). While the switch covers a workload (stakes not throwaway, mode autonomous), each lane's
// classifier writes one `pair-exposure: <laneId> on` per lane session, and only then does the classifier attempt the jev
// signal or the round-limit raise offer pair. A lane is `on` when it has its own `pair-exposure:` row, or a
// classifier-stamped `pair-signal:`, `pair-signal-failed:` or `pair-offer:` falls within its own span (`lane-started:` to
// `lane-exit:`, or now); `off` otherwise, a lane from before the switch existed included.
//
// Compared across the groups (monitoring § 5.3 wants 5 or more lanes per group): `post-signal-failed-rounds`, better
// lower (`pairSuggestLane` in surface/src/pair-suggest.ts), as the all-lanes mean and the mean over the eligible stratum
// (lanes with a mechanical eligibility moment), with the eligible and ineligible counts, so a group diluted with
// zero-scoring ineligible lanes is visible. A taken offer ends the autonomous lane early, which lowers the on group's
// number for reasons other than pairing being right; the per-workload sums across all its lanes are printed for that.
//
// On-only diagnostics, not compared, over rows written in the window on workloads with an `on` lane: take-rate
// (`pair-taken:` / `pair-offer:`), false alarms (an offered question answered with another word, after which the next
// review round to complete on the question's slice passed), the
// signals the offers fired, and the jev cost: the sum of the known costs plus the count of attempts with none.
import { assertNotLiveLedgerUnderTest, CLASSIFIER_BY, defaultLedgerPath, Ledger } from "../../ledger/src/index";
import { controlEntries } from "../src/launch";
import {
	completedRounds, PAIR_OPTION, PAIR_SIGNALS, type PairExposure, pairLaneExposure, pairSuggestLane, parsePairOffer, parsePairSignal,
	parsePairSignalFailed,
} from "../src/pair-suggest";
import { SURFACE_BY } from "../src/types";

const DEFAULT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const USAGE = "usage: bun surface/scripts/pair-suggest.ts report [--days N]";

interface GroupRow {
	lanes: number;
	eligible: number;
	scoreAll: number;
	scoreEligible: number;
}

const mean = (sum: number, n: number): string => (n === 0 ? "-" : (sum / n).toFixed(2));

export function report(ledger: Ledger, days: number): string {
	const since = new Date(Date.parse(ledger.now()) - days * DAY_MS).toISOString();
	const ids = ledger.db.query<{ id: string }, []>("SELECT id FROM workloads ORDER BY created_at, id").all().map((r) => r.id);
	const groups: Record<PairExposure, GroupRow> = {
		on: { lanes: 0, eligible: 0, scoreAll: 0, scoreEligible: 0 },
		off: { lanes: 0, eligible: 0, scoreAll: 0, scoreEligible: 0 },
	};
	const perWorkload: string[] = [];
	let offers = 0;
	let taken = 0;
	let declined = 0;
	let falseAlarms = 0;
	const fired = new Map<string, number>(PAIR_SIGNALS.map((s) => [s, 0]));
	let knownCost = 0;
	let knownAttempts = 0;
	let unknownAttempts = 0;

	for (const id of ids) {
		const entries = ledger.entries(id);
		const laneIds = [...new Set(controlEntries(entries).filter((c) => c.prefix === "lane-started" && c.createdAt >= since && c.laneId !== null).map((c) => c.laneId!))];
		const lanes = laneIds.flatMap((l) => {
			const lane = pairSuggestLane(ledger, l);
			return lane ? [{ ...lane, laneId: l }] : [];
		});
		if (lanes.length === 0) continue;
		const exposures = lanes.map((lane) => pairLaneExposure(entries, lane.laneId, lane));
		let sum = 0;
		lanes.forEach((lane, i) => {
			const g = groups[exposures[i]!];
			g.lanes++;
			g.scoreAll += lane.score;
			if (lane.moment !== null) {
				g.eligible++;
				g.scoreEligible += lane.score;
			}
			sum += lane.score;
		});
		const anyOn = exposures.includes("on");
		perWorkload.push(`  ${id}  ${(anyOn ? "on" : "off").padEnd(7)}  lanes ${lanes.length}  post-signal-failed-rounds ${sum}`);
		if (!anyOn) continue;

		const instructions = ledger.instructions(id);
		const rounds = completedRounds(entries);
		for (const e of entries) {
			if (e.created_at < since || e.kind !== "assumption") continue;
			const attempt = e.created_by === CLASSIFIER_BY ? (parsePairSignal(e.body) ?? parsePairSignalFailed(e.body)) : null;
			if (attempt && attempt.cost === null) unknownAttempts++;
			else if (attempt && attempt.cost !== null) {
				knownCost += attempt.cost;
				knownAttempts++;
			}
			const offer = e.created_by === CLASSIFIER_BY ? parsePairOffer(e.body) : null;
			if (!offer) continue;
			offers++;
			for (const s of offer.signals) fired.set(s, (fired.get(s) ?? 0) + 1);
			const q = ledger.question(offer.questionId);
			const answer = q?.state === "answered" ? instructions.find((x) => x.id === q.resolved_by) : undefined;
			if (!q || !answer || answer.body.trim().split(/\s+/)[0]?.toLowerCase() === PAIR_OPTION) continue;
			declined++;
			const next = rounds.find((r) => r.at > answer.created_at && r.slice === q.slice_id);
			if (next?.passed) falseAlarms++;
		}
		taken += controlEntries(entries).filter((c) => c.prefix === "pair-taken" && c.createdBy === SURFACE_BY && c.createdAt >= since).length;
	}

	const row = (name: PairExposure) => {
		const g = groups[name];
		return `  ${name.padEnd(7)}  ${String(g.lanes).padStart(5)}  ${String(g.eligible).padStart(8)}  ${String(g.lanes - g.eligible).padStart(10)}  ${mean(g.scoreAll, g.lanes).padStart(9)}  ${mean(g.scoreEligible, g.eligible).padStart(14)}`;
	};
	const rate = offers === 0 ? "-" : `${((taken / offers) * 100).toFixed(0)}%`;
	return [
		`pair-suggest report: lanes started since ${since} (${days} days)`,
		"",
		"post-signal-failed-rounds per lane (better lower)",
		"  group    lanes  eligible  ineligible  mean(all)  mean(eligible)",
		row("on"),
		row("off"),
		"",
		"per workload, across all its lanes in the window",
		...(perWorkload.length > 0 ? perWorkload : ["  (no lanes)"]),
		"",
		"on-only diagnostics (not compared)",
		`  offers ${offers}, taken ${taken}, take-rate ${rate}`,
		`  false alarms ${falseAlarms} of ${declined} declined offers`,
		`  signals fired: ${PAIR_SIGNALS.map((s) => `${s} ${fired.get(s) ?? 0}`).join(", ")}`,
		`  jev cost: $${knownCost.toFixed(6)} known over ${knownAttempts} attempts; ${unknownAttempts} attempts with unknown cost`,
	].join("\n");
}

function main(argv: string[]): number {
	const [verb, ...rest] = argv;
	if (verb !== "report") {
		console.error(USAGE);
		return 1;
	}
	let days = DEFAULT_DAYS;
	for (let i = 0; i < rest.length; i++) {
		const n = rest[i] === "--days" ? Number(rest[++i]) : Number.NaN;
		if (!Number.isFinite(n) || n <= 0) {
			console.error(USAGE);
			return 1;
		}
		days = n;
	}
	const path = defaultLedgerPath(process.env);
	assertNotLiveLedgerUnderTest(path);
	let ledger: Ledger;
	try {
		ledger = Ledger.open(path, { readonly: true });
	} catch (err) {
		console.error(`pair-suggest report: could not open the ledger (${err instanceof Error ? err.message : String(err)})`);
		return 2;
	}
	try {
		console.log(report(ledger, days));
	} finally {
		ledger.close();
	}
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
