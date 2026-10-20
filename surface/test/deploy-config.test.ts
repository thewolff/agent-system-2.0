import { describe, expect, test } from "bun:test";
import { carryDeployConfig } from "../scripts/deploy-config";
import { policyHash } from "../../gates/src/deploy-risk";

const rendered = "# template\nbefore: { enabled: true }\ndeploy:\n  targets: []\n  order: []\n# next section\nafter: { value: untouched }\n";
describe("installed deploy carry boundaries", () => {
	test("fresh and pre-deploy profiles retain template defaults", () => {
		expect(carryDeployConfig(rendered, null)).toBe(rendered);
		expect(carryDeployConfig(rendered, "before: 1\n")).toBe(rendered);
	});
	test("only deploy changes, preserving semantic hash and surrounding template comments", () => {
		const deploy = { targets: [], order: [], mergeTriggered: ["Example/worker"], lines: { warn: 30, escalate: 90 } };
		const out = carryDeployConfig(rendered, Bun.YAML.stringify({ deploy, before: "not carried" }, null, 2));
		const doc = Bun.YAML.parse(out);
		expect(doc.before).toEqual({ enabled: true });
		expect(doc.after).toEqual({ value: "untouched" });
		expect(policyHash(doc.deploy)).toBe(policyHash(deploy));
		expect(out).toContain("# next section");
	});
	test("unreadable installed YAML or invalid declarations refuse instead of losing targets", () => {
		for (const text of ["[unclosed", "[]", "deploy: null", "deploy: { targets: [{ name: lost }] }"]) expect(() => carryDeployConfig(rendered, text)).toThrow();
	});
	test("ambiguous or missing rendered deploy boundaries refuse", () => {
		for (const text of ["other: 1\n", "deploy: {targets: []}\ndeploy: {targets: []}\n"]) expect(() => carryDeployConfig(text, "deploy: { targets: [] }\n")).toThrow();
	});
});
