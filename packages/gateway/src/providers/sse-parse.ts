/**
 * A minimal, spec-shaped Server-Sent Events framing parser
 * (IMPLEMENTATION_GUIDE.md §3.3, BUILD_PLAYBOOK.md phase 2 step 3). It reads a
 * `ReadableStream<Uint8Array>` from an upstream `fetch` response and yields the
 * concatenated `data` payload of each dispatched event, promptly, without
 * buffering the whole response. It is provider-agnostic: it only understands
 * SSE framing (fields, comments, line terminators), not chat chunks.
 *
 * What it handles safely (the step-3 requirement):
 * - arbitrary byte-chunk boundaries, including a multi-byte UTF-8 sequence or a
 *   `\r\n` terminator split across two network reads;
 * - `\n`, `\r`, and `\r\n` line terminators, mixed within one stream;
 * - comment lines (`: ...`) and non-`data` fields (`event:`, `id:`, `retry:`),
 *   which are ignored;
 * - multi-line `data:` fields, joined with `\n` per the SSE spec.
 *
 * End-of-stream (blocker 5): WHATWG dispatches an event only on a blank line
 * and discards any incomplete pending event at EOF. This parser keeps that
 * rule — with ONE narrow, opt-in provider-compatibility exception: a caller may
 * pass `pendingSentinel` (the OpenAI-compatible `[DONE]`) so that a *complete,
 * line-terminated* pending event whose payload is exactly that sentinel is
 * dispatched, because the official fixtures end `data: [DONE]` with a single
 * newline and no trailing blank line. Any other pending event is discarded; a
 * non-empty *unterminated* trailing line is a truncated transcript and raises
 * `SseTruncationError`, which the streaming adapter turns into a fail-closed
 * `StreamContractError`.
 */

/** Raised when the byte stream ends in the middle of a line (truncated SSE). */
export class SseTruncationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SseTruncationError";
	}
}

export interface ParseSseOptions {
	/**
	 * If set, a complete (line-terminated) pending event at EOF whose payload is
	 * exactly this string is dispatched instead of discarded — the narrow
	 * `[DONE]`-only exception described above. Omit it for strict WHATWG discard.
	 */
	pendingSentinel?: string;
}

/**
 * Frames a logical SSE data payload as one or more `data:` lines terminated by
 * a blank line, so a standards-compliant downstream parser reconstructs the
 * exact same logical payload (BUILD_PLAYBOOK.md phase 2 step 3, blocker 1).
 * Every embedded newline becomes its own `data:` line — SSE joins multiple
 * `data:` lines with `\n`, so emitting a newline-bearing payload under a single
 * `data:` prefix would let the client silently drop everything after the first
 * line.
 */
export function frameSseData(payload: string): string {
	const framed = payload
		.split("\n")
		.map((line) => `data: ${line}`)
		.join("\n");
	return `${framed}\n\n`;
}

/**
 * Extracts complete lines from `buffer` using SSE line terminators. A lone
 * trailing `\r` is left in `rest` unless `atEof`, because it may be the first
 * half of a `\r\n` terminator split across two byte chunks.
 */
function takeLines(
	buffer: string,
	atEof: boolean,
): { lines: string[]; rest: string } {
	const lines: string[] = [];
	let lineStart = 0;
	let i = 0;
	while (i < buffer.length) {
		const ch = buffer[i];
		if (ch === "\n") {
			lines.push(buffer.slice(lineStart, i));
			i += 1;
			lineStart = i;
		} else if (ch === "\r") {
			if (i === buffer.length - 1 && !atEof) {
				break; // possible CRLF split across reads — wait for more bytes
			}
			lines.push(buffer.slice(lineStart, i));
			i += buffer[i + 1] === "\n" ? 2 : 1;
			lineStart = i;
		} else {
			i += 1;
		}
	}
	return { lines, rest: buffer.slice(lineStart) };
}

/**
 * One dispatched SSE event: its `event:` field name (or null when the stream
 * omitted it, per the WHATWG "message" default being represented as absence)
 * and the concatenated `data` payload. Anthropic's Messages stream names every
 * event (`message_start`, `content_block_delta`, …), so the translator
 * (`anthropic-stream.ts`) both consumes the name and cross-checks it against
 * the payload's own `type` field before trusting either.
 */
export interface SseEvent {
	event: string | null;
	data: string;
}

export interface ParseSseEventsOptions {
	/**
	 * If set, a complete (line-terminated) pending event at EOF whose `event:`
	 * name is exactly this string is dispatched instead of discarded. This is the
	 * Anthropic analogue of `parseSseData`'s `[DONE]` exception: the official
	 * Messages transcript ends its final `message_stop` event with a single
	 * newline and no trailing blank line, so a strict WHATWG parser would drop
	 * it. Matching on the *event name* (not the data payload) keeps this narrow to
	 * a complete terminal event and deliberately does NOT widen the separate
	 * data-payload `[DONE]` exception. Omit it for strict WHATWG discard.
	 */
	pendingEventSentinel?: string;
}

/**
 * Event-name-aware sibling of `parseSseData` (BUILD_PLAYBOOK.md phase 2 step 4).
 * Anthropic's native stream is not a sequence of anonymous `data:` payloads —
 * each frame carries an `event:` name that must agree with the payload's `type`
 * — so this yields the `{event, data}` pair for the same framing rules (mixed
 * `\n`/`\r`/`\r\n` terminators, byte-split UTF-8/CRLF, comments/`id`/`retry`
 * ignored, multi-line `data:` joined with `\n`). `parseSseData` is left exactly
 * as-is so every step-3 consumer and test is untouched.
 */
export async function* parseSseEvents(
	body: ReadableStream<Uint8Array>,
	options: ParseSseEventsOptions = {},
): AsyncGenerator<SseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const dataLines: string[] = [];
	let sawData = false;
	let eventName: string | null = null;

	/** Applies one complete line; returns a dispatched event, or null. */
	function processLine(line: string): SseEvent | null {
		if (line === "") {
			if (!sawData) {
				// WHATWG: a blank line with no data buffer dispatches nothing and
				// resets the event-type buffer.
				eventName = null;
				return null;
			}
			const event: SseEvent = { event: eventName, data: dataLines.join("\n") };
			dataLines.length = 0;
			sawData = false;
			eventName = null;
			return event;
		}
		if (line.startsWith(":")) {
			return null; // comment line
		}
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) {
			value = value.slice(1);
		}
		if (field === "data") {
			dataLines.push(value);
			sawData = true;
		} else if (field === "event") {
			eventName = value;
		}
		// Other fields (id/retry) are ignored, exactly as in parseSseData.
		return null;
	}

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const { lines, rest } = takeLines(buffer, false);
			buffer = rest;
			for (const line of lines) {
				const event = processLine(line);
				if (event !== null) {
					yield event;
				}
			}
		}

		buffer += decoder.decode();
		const { lines, rest } = takeLines(buffer, true);
		for (const line of lines) {
			const event = processLine(line);
			if (event !== null) {
				yield event;
			}
		}
		if (rest.length > 0) {
			throw new SseTruncationError("SSE stream ended in the middle of a line.");
		}
		// A complete but non-blank-line-terminated pending event: WHATWG discards
		// it. The single opt-in exception is an exact `pendingEventSentinel` name.
		if (
			sawData &&
			options.pendingEventSentinel !== undefined &&
			eventName === options.pendingEventSentinel
		) {
			yield { event: eventName, data: dataLines.join("\n") };
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}

export async function* parseSseData(
	body: ReadableStream<Uint8Array>,
	options: ParseSseOptions = {},
): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const dataLines: string[] = [];
	let sawData = false;

	/** Applies one complete line; returns a dispatched data payload, or null. */
	function processLine(line: string): string | null {
		if (line === "") {
			if (!sawData) {
				return null;
			}
			const payload = dataLines.join("\n");
			dataLines.length = 0;
			sawData = false;
			return payload;
		}
		if (line.startsWith(":")) {
			return null; // comment line
		}
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		if (field !== "data") {
			return null; // non-data field (event/id/retry): ignored
		}
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) {
			value = value.slice(1);
		}
		dataLines.push(value);
		sawData = true;
		return null;
	}

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const { lines, rest } = takeLines(buffer, false);
			buffer = rest;
			for (const line of lines) {
				const payload = processLine(line);
				if (payload !== null) {
					yield payload;
				}
			}
		}

		buffer += decoder.decode();
		const { lines, rest } = takeLines(buffer, true);
		for (const line of lines) {
			const payload = processLine(line);
			if (payload !== null) {
				yield payload;
			}
		}
		if (rest.length > 0) {
			// A non-empty line with no terminator: the stream was cut mid-line.
			throw new SseTruncationError("SSE stream ended in the middle of a line.");
		}
		// A complete but non-blank-line-terminated pending event: WHATWG discards
		// it. The single opt-in exception is an exact `pendingSentinel` payload.
		if (sawData && options.pendingSentinel !== undefined) {
			const pending = dataLines.join("\n");
			if (pending === options.pendingSentinel) {
				yield pending;
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}
