// The machinery's `Closes #N` footer (PLAN wl-mv66ylim0gahog § 5, § 9.2).
import { describe, expect, test } from "bun:test";
import { closesFooter, hasFooter } from "../src/issues/footer";

describe("closesFooter / hasFooter", () => {
	test("the footer is a blank line, the marker, then Closes #N", () => {
		expect(closesFooter(42)).toBe("\n\n<!-- as2 -->\nCloses #42");
	});

	test("a body carrying the footer has it; GitHub's CRLF line break still counts", () => {
		expect(hasFooter(`Fixes the header.${closesFooter(7)}`, 7)).toBe(true);
		expect(hasFooter("Fixes the header.\r\n\r\n<!-- as2 -->\r\nCloses #7", 7)).toBe(true);
	});

	test("another issue's footer, a longer number, or a bare keyword a person typed is not the footer", () => {
		expect(hasFooter(`body${closesFooter(7)}`, 8)).toBe(false);
		expect(hasFooter(`body${closesFooter(71)}`, 7)).toBe(false);
		expect(hasFooter("body\n\nCloses #7", 7)).toBe(false);
		expect(hasFooter("", 7)).toBe(false);
	});
});
