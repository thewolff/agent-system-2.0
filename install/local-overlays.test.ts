import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installModels, mergeModels, validateLocalOverlays } from "./local-overlays";
import { tmp } from "../gates/test/helpers";

const home = () => {
	const value = tmp("overlay-home");
	mkdirSync(join(value, ".as2"), { recursive: true });
	return value;
};

describe("user-local AS2 overlays", () => {
	test("model providers merge locally over the public base", () => {
		const h = home();
		writeFileSync(join(h, ".as2/models.yml"), "providers:\n  private-gateway:\n    baseUrl: http://127.0.0.1:9123/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: private-model\n", { mode: 0o600 });
		const merged = mergeModels("providers:\n  public:\n    auth: none\n", { HOME: h });
		expect(merged.overlaid).toBe(true);
		expect(Bun.YAML.parse(merged.text).providers).toHaveProperty("private-gateway");
		expect(Bun.YAML.parse(merged.text).providers).toHaveProperty("public");
	});

	test("a local model overlay cannot replace a public provider", () => {
		const h = home();
		writeFileSync(join(h, ".as2/models.yml"), "providers:\n  public:\n    baseUrl: http://127.0.0.1:9999\n", { mode: 0o600 });
		expect(() => mergeModels("providers:\n  public:\n    auth: none\n", { HOME: h })).toThrow("cannot replace public provider");
	});

	test("invalid permissions fail validation before use", () => {
		const h = home();
		const path = join(h, ".as2/config.yml");
		writeFileSync(path, "modelRoles: {}\n", { mode: 0o600 });
		validateLocalOverlays({ HOME: h });
		chmodSync(path, 0o644);
		expect(() => validateLocalOverlays({ HOME: h })).toThrow("0600");
	});

	test("installed models are atomic and mode 0600", async () => {
		const h = home();
		const base = join(h, "base.yml");
		const out = join(h, "profile", "models.yml");
		writeFileSync(base, "providers: {}\n");
		expect(await installModels(base, out, { HOME: h })).toBe(false);
		expect(readFileSync(out, "utf8")).toContain("providers");
	});
});
