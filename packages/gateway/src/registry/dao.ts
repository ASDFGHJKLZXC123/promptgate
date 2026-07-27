import type Database from "better-sqlite3";

/** Values that can be represented without loss in a JSON registry column. */
export type JsonValue =
	| boolean
	| null
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface StoredPrompt {
	id: number;
	slug: string;
	description: string | null;
}

export interface StoredPromptVersion {
	promptId: number;
	version: number;
	messages_json: string;
	variables_json: string;
	notes: string | null;
}

export interface LabelMove {
	promptId: number;
	label: string;
	fromVersion: number | null;
	toVersion: number;
}

/** The immutable prompt payload selected by a slug@version or slug@label ref. */
export interface ResolvedPromptRef {
	promptId: number;
	version: number;
	messages_json: string;
	variables_json: string;
}

interface PromptRow {
	id: number;
	slug: string;
	description: string | null;
}

interface VersionNumberRow {
	version: number;
}

interface VersionRow {
	prompt_id: number;
	version: number;
	messages_json: string;
	variables_json: string;
	notes: string | null;
}

interface LabelVersionRow {
	version: number;
}

type ParsedPromptRef =
	| { kind: "label"; slug: string; label: string }
	| { kind: "version"; slug: string; version: number };

/**
 * Creates a prompt identity. Its versions and labels are intentionally added
 * through separate DAO calls so a prompt can exist before it is deployed.
 */
export function createPrompt(
	db: Database.Database,
	slug: string,
	description: string | null = null,
): StoredPrompt {
	const row = db
		.prepare(
			`INSERT INTO prompts (slug, description)
			 VALUES (@slug, @description)
			 RETURNING id, slug, description`,
		)
		.get({ slug, description }) as PromptRow | undefined;
	if (!row) {
		throw new Error("Failed to persist prompt");
	}
	return row;
}

/**
 * Appends the next immutable version for one prompt. Reading the current
 * maximum and inserting the next value are one SQLite transaction, so a
 * failed insert cannot leave a partially allocated version behind.
 */
export function addVersion(
	db: Database.Database,
	promptId: number,
	messages: readonly JsonValue[],
	variables: readonly JsonValue[],
	notes: string | null = null,
): StoredPromptVersion {
	const messagesJson = JSON.stringify(messages);
	const variablesJson = JSON.stringify(variables);

	return db.transaction(() => {
		const next = db
			.prepare(
				`SELECT 1 + COALESCE(MAX(version), 0) AS version
				 FROM prompt_versions
				 WHERE prompt_id = ?`,
			)
			.get(promptId) as VersionNumberRow;

		const row = db
			.prepare(
				`INSERT INTO prompt_versions (
					prompt_id, version, messages_json, variables_json, notes
				) VALUES (
					@prompt_id, @version, @messages_json, @variables_json, @notes
				)
				RETURNING prompt_id, version, messages_json, variables_json, notes`,
			)
			.get({
				prompt_id: promptId,
				version: next.version,
				messages_json: messagesJson,
				variables_json: variablesJson,
				notes,
			}) as VersionRow | undefined;
		if (!row) {
			throw new Error("Failed to persist prompt version");
		}

		return {
			promptId: row.prompt_id,
			version: row.version,
			messages_json: row.messages_json,
			variables_json: row.variables_json,
			notes: row.notes,
		};
	})();
}

/**
 * Moves a mutable label while retaining an append-only deployment history.
 * This uses SQLite's conflict-update form rather than INSERT OR REPLACE, so
 * the label row retains normal UPDATE semantics and its timestamp is renewed.
 */
export function setLabel(
	db: Database.Database,
	promptId: number,
	label: string,
	version: number,
): LabelMove {
	return db.transaction(() => {
		const previous = db
			.prepare(
				`SELECT version FROM prompt_labels
				 WHERE prompt_id = ? AND label = ?`,
			)
			.get(promptId, label) as LabelVersionRow | undefined;

		db.prepare(
			`INSERT INTO prompt_labels (prompt_id, label, version)
			 VALUES (@prompt_id, @label, @version)
			 ON CONFLICT(prompt_id, label) DO UPDATE SET
				version = excluded.version,
				updated_at = datetime('now')`,
		).run({ prompt_id: promptId, label, version });

		db.prepare(
			`INSERT INTO label_history (
				prompt_id, label, from_version, to_version
			) VALUES (@prompt_id, @label, @from_version, @to_version)`,
		).run({
			prompt_id: promptId,
			label,
			from_version: previous?.version ?? null,
			to_version: version,
		});

		return {
			promptId,
			label,
			fromVersion: previous?.version ?? null,
			toVersion: version,
		};
	})();
}

/** Resolves only unambiguous, non-empty slug@target references. */
function parsePromptRef(ref: string): ParsedPromptRef | null {
	const at = ref.indexOf("@");
	if (at <= 0 || at !== ref.lastIndexOf("@") || at === ref.length - 1) {
		return null;
	}

	const slug = ref.slice(0, at);
	const target = ref.slice(at + 1);
	if (/^[1-9]\d*$/.test(target)) {
		const version = Number(target);
		if (!Number.isSafeInteger(version)) {
			return null;
		}
		return { kind: "version", slug, version };
	}

	return { kind: "label", slug, label: target };
}

/**
 * Resolves a prompt reference server-side. A malformed, unknown, dangling,
 * or cross-prompt reference is uniformly a miss and does not mutate the DB.
 */
export function resolveRef(
	db: Database.Database,
	ref: string,
): ResolvedPromptRef | null {
	const parsed = parsePromptRef(ref);
	if (!parsed) {
		return null;
	}

	const row =
		parsed.kind === "version"
			? (db
					.prepare(
						`SELECT pv.prompt_id AS promptId, pv.version, pv.messages_json, pv.variables_json
						 FROM prompts p
						 JOIN prompt_versions pv ON pv.prompt_id = p.id
						 WHERE p.slug = @slug AND pv.version = @version`,
					)
					.get(parsed) as ResolvedPromptRef | undefined)
			: (db
					.prepare(
						`SELECT pv.prompt_id AS promptId, pv.version, pv.messages_json, pv.variables_json
						 FROM prompts p
						 JOIN prompt_labels pl ON pl.prompt_id = p.id
						 JOIN prompt_versions pv
							ON pv.prompt_id = pl.prompt_id AND pv.version = pl.version
						 WHERE p.slug = @slug AND pl.label = @label`,
					)
					.get(parsed) as ResolvedPromptRef | undefined);

	return row ?? null;
}
