import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..");
const MANIFEST = join(REPO, "install", "manifest.tsv");
const POINTER = "Read [instructions.md](instructions.md) before applying this skill.";

const skillPaths = readFileSync(MANIFEST, "utf8")
	.split("\n")
	.filter((line) => line.split("\t")[1] === "skill")
	.map((line) => line.split("\t")[0]!);

function body(markdown: string): string {
	const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
	if (!match) throw new Error("missing frontmatter");
	return match[1]!.trim();
}

describe("skill entrypoints", () => {
	test("the manifest exposes 25 short gates, not full instruction bodies", () => {
		expect(skillPaths).toHaveLength(25);
		for (const relative of skillPaths) {
			const path = join(REPO, relative);
			const entrypoint = body(readFileSync(path, "utf8"));
			expect(entrypoint, relative).toContain(POINTER);
			expect(entrypoint.split("\n").length, relative).toBeLessThanOrEqual(6);
			expect(entrypoint, relative).not.toMatch(/^## /m);
		}
	});

	test("every gate points at a manifest-owned instruction file beside it", () => {
		const rows = new Map(
			readFileSync(MANIFEST, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [path, kind] = line.split("\t");
					return [path!, kind!];
				}),
		);
		for (const relative of skillPaths) {
			const instructions = join(dirname(relative), "instructions.md");
			expect(existsSync(join(REPO, instructions)), instructions).toBe(true);
			expect(rows.get(instructions), instructions).toBe("skill-asset");
		}
	});
});
