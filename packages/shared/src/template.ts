export function renderTemplate(
	tpl: string,
	vars: Record<string, string>,
): { text: string; missing: string[] } {
	const missing = new Set<string>();
	const text = tpl.replace(/\\?\{\{([^{}]+)\}\}/g, (match, name: string) => {
		if (match.startsWith("\\")) {
			return match.slice(1);
		}
		if (Object.hasOwn(vars, name)) {
			return vars[name];
		}
		missing.add(name);
		return match;
	});
	return { text, missing: [...missing] };
}
