// The OMP harness guide and start card (wl-mv8k0fby51uakg, plan D4). The guide profile/OMP-HARNESS.md
// carries a `verified-omp: X.Y.Z` header line; its major.minor must equal VERIFIED_HOST in
// gates/src/host.ts, so an OMP minor upgrade that bumps the gates' pin fails here until the guide is
// re-verified. A patch upgrade passes unnoticed: re-verify the guide on any OMP upgrade. The card
// profile/AGENTS.md is the native user context OMP loads into every top-level session of the profile,
// so it stays short, starts with its marker line and names the guide by its {repo} path, which
// install/install.sh fills with the checkout's absolute path.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERIFIED_HOST } from "../../gates/src/host";

const REPO = join(import.meta.dir, "..", "..");
const GUIDE = join(REPO, "profile", "OMP-HARNESS.md");
const CARD = join(REPO, "profile", "AGENTS.md");
const MARKER = "# OMP harness card (agent-system 2.0)";
const CARD_MAX_BYTES = 8000;

describe("the OMP harness guide matches the gates' verified host", () => {
	test("its verified-omp header line names an X.Y.Z whose major.minor is VERIFIED_HOST", () => {
		const line = readFileSync(GUIDE, "utf8").split("\n").find((l) => l.startsWith("verified-omp:"));
		expect(line).toBeDefined();
		const m = /^verified-omp: (\d+)\.(\d+)\.(\d+)$/.exec(line!.trim());
		expect(m).not.toBeNull();
		expect(`${m![1]}.${m![2]}`).toBe(VERIFIED_HOST);
	});
});

describe("the OMP harness card is short and names the guide", () => {
	const bytes = readFileSync(CARD);
	const text = bytes.toString("utf8");

	test(`it is at most ${CARD_MAX_BYTES} bytes`, () => {
		expect(bytes.byteLength).toBeLessThanOrEqual(CARD_MAX_BYTES);
	});

	test("it starts with the marker line", () => {
		expect(text.split("\n")[0]).toBe(MARKER);
	});

	test("it names the guide by its {repo} path", () => {
		expect(text).toContain("{repo}/profile/OMP-HARNESS.md");
	});
});
