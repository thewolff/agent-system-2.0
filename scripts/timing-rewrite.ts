#!/usr/bin/env bun
// Requests are data, not executable code. The library generates every replacement itself.
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { applyGuarded, ownedFile, parseOptions, prepareRewrite, repoPath } from "../surface/src/timing-automation";

const HELP = `Usage:
  bun scripts/timing-rewrite.ts --request /absolute/request.json [--root <repo>] [--dry-run]
  bun scripts/timing-rewrite.ts --request /absolute/request.json [--root <repo>] --apply

Request v1 (UTF-16 source offsets, SHA-256 of exact UTF-8 input):
 {"version":1,"file":"surface/test/example.test.ts","oldHash":"<sha256>",
  "edits":[{"kind":"loop-to-each","start":42,"end":240}]}

loop-to-each accepts only const for-of over a JSON array of distinct single-line strings,
with exactly one unmodified imported Bun test/it, a template name containing exactly one
binding interpolation and a no-argument block callback. It preserves the assertion body,
reports every old/new semantic case name, and refuses mutation, closures and unsupported flow.
The loop must sit at module level or directly in describe/test/it("title", () => {...}) bodies,
and the call name must be bound only by its bun:test import: any parameter, pattern, catch or
declaration of that name anywhere in the module refuses the request as an unproven binding.

remove-sleep accepts only a standalone await Bun.sleep(number); directly followed by an
ALREADY-PRESENT await property.expression; and requires caller-reviewed evidence:
 {"kind":"remove-sleep","start":42,"end":62,"evidence":{"kind":"awaited-event",
  "event":"proc.exited","receipt":"REVIEW.md#case-anchor",
  "reason":"Explain why this delay contributes no timing contract or behavioral coverage."}}
The evidence is a human semantic responsibility, not machine proof of arbitrary equivalence.
Timing-under-test files are refused. No timeout/skip/coverage edits, guessed readiness or DI.
Unsupported shapes fail without a partial write. Dry-run is default and emits hashes, case
mapping, evidence and diff. Apply revalidates input hashes and replaces one owned regular file.
Review the dry-run, retain the original input for undo, then apply the identical request.
`;

function main(): void {
 const options = parseOptions(process.argv.slice(2), ["--root", "--request", "--dry-run", "--apply", "--help"]);
 if (options["--help"]) { console.log(HELP); return; }
 if (typeof options["--request"] !== "string") throw new Error("timing-rewrite: --request <request.json> is required; use --help");
 const root = realpathSync(typeof options["--root"] === "string" ? options["--root"] : resolve(import.meta.dir, ".."));
 const requestPath = realpathSync(options["--request"]);
 const request: unknown = JSON.parse(readFileSync(requestPath, "utf8"));
 if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error(`timing-rewrite: ${requestPath}: expected object request; nothing written`);
 const file = repoPath((request as Record<string, unknown>).file);
 const result = prepareRewrite(readFileSync(ownedFile(root, file), "utf8"), request);
 if (options["--apply"]) applyGuarded(root, file, result.oldHash, result.source);
 console.log(JSON.stringify({ command: "timing-rewrite", mode: options["--apply"] ? "apply" : "dry-run", root, requestPath, ...result }, null, 2));
}
try { main(); }
catch (error) { console.error(`timing-rewrite: ${error instanceof Error ? error.stack : String(error)}`); process.exitCode = 1; }
