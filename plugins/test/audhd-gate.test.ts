import { describe, expect, test } from "bun:test";
import { explicitAudhdRequest } from "../i-have-audhd/omp/i-have-audhd-omp";

describe("the AuDHD prompt gate", () => {
	test.each([
		"I have AuDHD; please write to me that way.",
		"I'm ADHD and autistic.",
		"Please use the i-have-audhd writing rules.",
		"/skill:i-have-audhd",
	])("activates for an explicit request: %s", (prompt) => {
		expect(explicitAudhdRequest(prompt)).toBe(true);
	});

	test.each([
		"AuDHD is only run when requested, but read very often.",
		"Document how the i-have-audhd plugin works.",
		"Fix the login test.",
		"The reader might have ADHD.",
		"Use the accessibility skill.",
	])("stays inactive for a mention or unrelated prompt: %s", (prompt) => {
		expect(explicitAudhdRequest(prompt)).toBe(false);
	});
});
