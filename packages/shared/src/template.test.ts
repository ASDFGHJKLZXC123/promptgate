import { describe, expect, test } from "vitest";
import { renderTemplate } from "./template.js";

describe("renderTemplate", () => {
	test("interpolates supplied variables and ignores extras", () => {
		expect(
			renderTemplate("Hello, {{name}}!", { name: "Ada", unused: "x" }),
		).toEqual({
			text: "Hello, Ada!",
			missing: [],
		});
	});

	test("keeps missing placeholders and reports names in first-use order", () => {
		expect(renderTemplate("{{first}} {{second}} {{first}}", {})).toEqual({
			text: "{{first}} {{second}} {{first}}",
			missing: ["first", "second"],
		});
	});

	test("interpolates repeated and multiple placeholders", () => {
		expect(
			renderTemplate("{{name}}/{{name}}: {{place}}", {
				name: "Ada",
				place: "London",
			}),
		).toEqual({
			text: "Ada/Ada: London",
			missing: [],
		});
	});

	test("does not recursively interpolate replacement text", () => {
		expect(
			renderTemplate("Value: {{value}}", {
				value: "{{other}}",
				other: "unexpected",
			}),
		).toEqual({
			text: "Value: {{other}}",
			missing: [],
		});
	});

	test("treats an escaped opening delimiter as literal text", () => {
		expect(
			renderTemplate("Show \\{{name}}; use {{name}}.", { name: "Ada" }),
		).toEqual({
			text: "Show {{name}}; use Ada.",
			missing: [],
		});
	});
});
