import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");

test("tracked AS2 files contain none of the locally supplied private markers", () => {
	const markers = (process.env.AS2_PRIVATE_MARKERS ?? "").split("\n").map(s => s.trim()).filter(Boolean);
	if (markers.length === 0) return;
	const files = spawnSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "buffer" });
	expect(files.status).toBe(0);
	const paths = files.stdout.toString().split("\0").filter(Boolean);
	for (const marker of markers) {
		const found = spawnSync("git", ["grep", "-n", "-I", "-F", "--", marker, "--", ...paths], { cwd: REPO, encoding: "utf8" });
		expect({ marker: "<private>", output: found.stdout }).toEqual({ marker: "<private>", output: "" });
	}
});
