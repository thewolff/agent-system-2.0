#!/usr/bin/env bun
// Read-only inventory by default; shrink applies ONE exact, old-hash-guarded baseline file.
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { applyGuarded, BASELINE_PATH, baselineRows, exactBaseline, gitOutput, hashSource, inspectSources, ownedFile, parseAuditMap, parseOptions, readSources, reconcileMembership, trackedTests } from "../surface/src/timing-automation";
import { counts, ratchet, shrinkOnly } from "../surface/src/timing-lint";

const HELP = `Usage:
  bun scripts/timing-audit.ts scan --audit /absolute/AUDIT-MAP.json --base <main-ref> [--root <repo>]
  bun scripts/timing-audit.ts shrink --base <main-ref> [--root <repo>] [--dry-run]
  bun scripts/timing-audit.ts shrink --base <main-ref> --apply --old-hash <sha256> --scan-hash <sha256> [--root <repo>]

scan emits current findings, lexical subprocess observations, generated revised audit rows/totals,
and membership differences against both the historical audit and pinned main. Historical mechanisms
remain review-required, never runtime proof. Exits 1 on membership drift, opt-out or ratchet errors.
shrink generates the EXACT current scan baseline, rejects any addition/raise/move against current
AND the main merge-base baseline, and preserves existing comments. Dry-run emits hashes and diff.
Apply requires the dry-run oldHash AND scanHash and never rewrites a test file. JSON stdout; errors stderr.
`;

function main(): void {
 const argv = process.argv.slice(2);
 if (argv.length === 0 || argv[0] === "--help") { console.log(HELP); return; }
 const command = argv.shift();
 if (command !== "scan" && command !== "shrink") throw new Error(`timing-audit: unsupported command ${command}; use --help`);
 const options = parseOptions(argv, command === "scan" ? ["--root", "--audit", "--base", "--help"] : ["--root", "--base", "--dry-run", "--apply", "--old-hash", "--scan-hash", "--help"]);
 if (options["--help"]) { console.log(HELP); return; }
 if (typeof options["--base"] !== "string") throw new Error("timing-audit: --base <main-ref> is required; no guessed main or silent fallback");
 const root = realpathSync(typeof options["--root"] === "string" ? options["--root"] : resolve(import.meta.dir, ".."));
 const mainSha = gitOutput(root, ["rev-parse", "--verify", `${options["--base"]}^{commit}`]).trim();
 const mergeBase = gitOutput(root, ["merge-base", "HEAD", mainSha]).trim();
 const baseText = gitOutput(root, ["show", `${mergeBase}:${BASELINE_PATH}`]);
 const baseline = readFileSync(ownedFile(root, BASELINE_PATH), "utf8");
 const currentFiles = trackedTests(root);
 const allFiles = trackedTests(root, undefined, true);
 const tracked = new Set(currentFiles);
 const untrackedTests = allFiles.filter((file) => !tracked.has(file));
 const sources = readSources(root, allFiles);
 if (command === "shrink") {
  const candidate = exactBaseline(sources, baseline, baseText);
  if (options["--apply"]) {
   if (options["--old-hash"] !== candidate.oldHash) throw new Error(`timing-audit: --old-hash must match dry-run baseline ${candidate.oldHash}; nothing written`);
   if (options["--scan-hash"] !== candidate.scanHash) throw new Error(`timing-audit: --scan-hash must match dry-run inputs ${candidate.scanHash}; source/inventory changed or hash missing, nothing written`);
   if (JSON.stringify(trackedTests(root, undefined, true)) !== JSON.stringify(allFiles)) throw new Error("timing-audit: test inventory changed during apply; nothing written");
   for (const [file, hash] of Object.entries(candidate.sourceHashes)) {
    if (hashSource(readFileSync(ownedFile(root, file), "utf8")) !== hash) throw new Error(`timing-audit: ${file} changed during apply; nothing written`);
   }
   applyGuarded(root, BASELINE_PATH, candidate.oldHash, candidate.text);
  } else if (options["--old-hash"] && options["--old-hash"] !== candidate.oldHash) throw new Error(`timing-audit: stale --old-hash, observed ${candidate.oldHash}; nothing written`);
  console.log(JSON.stringify({ command, mode: options["--apply"] ? "apply" : "dry-run", root, mainSha, mergeBase, file: BASELINE_PATH, ...candidate }, null, 2));
  return;
 }
 if (typeof options["--audit"] !== "string") throw new Error("timing-audit scan: --audit <AUDIT-MAP.json> is required");
 const auditPath = realpathSync(options["--audit"]);
 const auditText = readFileSync(auditPath, "utf8");
 const audit = parseAuditMap(JSON.parse(auditText));
 const report = inspectSources(sources, audit);
 const membership = reconcileMembership(currentFiles, audit.files.map((row) => row.file), trackedTests(root, mainSha));
 const current = baselineRows(baseline, BASELINE_PATH), base = baselineRows(baseText, `merge-base ${mergeBase} ${BASELINE_PATH}`);
 const byFile = new Map(report.files.map((row) => [row.file, row.scan.findings]));
 const errors = [
  ...report.files.flatMap((row) => row.scan.problems.map((p) => `${row.file}:${p.line}: ${p.problem}`)),
  ...ratchet(counts(byFile), current, (key) => {
   const [file, pattern] = key.split("\t");
   return (byFile.get(file!) ?? []).filter((f) => f.pattern === pattern).map((f) => `${file}:${f.line} ${f.text}`).join("; ");
  }),
  ...shrinkOnly(base, current),
 ];
 const membershipDrift = Object.values(membership).some((files) => files.length > 0);
 console.log(JSON.stringify({ command, root, mainSha, mergeBase, auditPath, auditHash: hashSource(auditText), historicalBase: audit.base, membership, untrackedTests, revisedAudit: report, errors, status: errors.length || membershipDrift || untrackedTests.length ? "review-required" : "static-checks-pass-not-runtime-proof" }, null, 2));
 if (errors.length || membershipDrift || untrackedTests.length) process.exitCode = 1;
}
try { main(); }
catch (error) { console.error(`timing-audit: ${error instanceof Error ? error.stack : String(error)}`); process.exitCode = 1; }
