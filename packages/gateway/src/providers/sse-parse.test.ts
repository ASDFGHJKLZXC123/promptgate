import { describe, expect, test } from "vitest";

import {
	frameSseData,
	type ParseSseOptions,
	parseSseData,
	SseTruncationError,
} from "./sse-parse.js";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(chunk);
			}
			controller.close();
		},
	});
}

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function singleByteChunks(text: string): Uint8Array[] {
	return Array.from(encode(text), (byte) => Uint8Array.of(byte));
}

/** Collect with the `[DONE]` compatibility sentinel, matching the adapter. */
const DONE: ParseSseOptions = { pendingSentinel: "[DONE]" };

async function collect(
	body: ReadableStream<Uint8Array>,
	options: ParseSseOptions = DONE,
): Promise<string[]> {
	const payloads: string[] = [];
	for await (const payload of parseSseData(body, options)) {
		payloads.push(payload);
	}
	return payloads;
}

const TRANSCRIPT = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n';

describe("parseSseData", () => {
	test("yields each event's data payload, dispatching the final newline-terminated [DONE]", async () => {
		expect(await collect(streamFromChunks([encode(TRANSCRIPT)]))).toEqual([
			'{"a":1}',
			'{"b":2}',
			"[DONE]",
		]);
	});

	test("is invariant to arbitrary byte-chunk boundaries (one byte at a time)", async () => {
		expect(
			await collect(streamFromChunks(singleByteChunks(TRANSCRIPT))),
		).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
	});

	test("handles a CRLF terminator split across network reads (CR then LF)", async () => {
		// The data line's own `\r\n` terminator is split: the `\r` is the last
		// byte of read #1 and the `\n` is the first byte of read #2. The parser
		// must join them into one terminator, not see a blank line.
		const chunks = [
			encode('data: {"a":1}\r'),
			encode("\n\r\ndata: [DONE]\r\n"),
		];
		expect(await collect(streamFromChunks(chunks))).toEqual([
			'{"a":1}',
			"[DONE]",
		]);
	});

	test("handles bare-CR line terminators", async () => {
		const chunks = [encode('data: {"a":1}\r\rdata: [DONE]\r')];
		expect(await collect(streamFromChunks(chunks))).toEqual([
			'{"a":1}',
			"[DONE]",
		]);
	});

	test("ignores comment lines and non-data fields", async () => {
		const transcript =
			': keep-alive\nevent: chunk\nid: 7\ndata: {"a":1}\nretry: 100\n\ndata: [DONE]\n';
		expect(await collect(streamFromChunks([encode(transcript)]))).toEqual([
			'{"a":1}',
			"[DONE]",
		]);
	});

	test("joins multi-line data fields with a newline", async () => {
		const transcript = 'data: {"a":\ndata: 1}\n\ndata: [DONE]\n';
		expect(await collect(streamFromChunks([encode(transcript)]))).toEqual([
			'{"a":\n1}',
			"[DONE]",
		]);
	});

	test("strips exactly one leading space after the colon", async () => {
		const transcript =
			"data:no-space\n\ndata:  one-leading-space\n\ndata: [DONE]\n";
		expect(await collect(streamFromChunks([encode(transcript)]))).toEqual([
			"no-space",
			" one-leading-space",
			"[DONE]",
		]);
	});

	test("decodes a multi-byte UTF-8 sequence split inside the emoji bytes", async () => {
		const smiley = "😀"; // F0 9F 98 80 — 4 UTF-8 bytes
		const full = encode(`data: {"t":"${smiley}"}\n\ndata: [DONE]\n`);
		// Cut two bytes into the 4-byte emoji so the sequence spans both reads.
		const cut = encode('data: {"t":"').length + 2;
		const chunks = [full.subarray(0, cut), full.subarray(cut)];
		expect(await collect(streamFromChunks([...chunks]))).toEqual([
			`{"t":"${smiley}"}`,
			"[DONE]",
		]);
	});

	test("throws SseTruncationError when the stream ends mid-line", async () => {
		const chunks = [encode('data: {"a":1}\n\ndata: {"b":')];
		await expect(collect(streamFromChunks(chunks))).rejects.toBeInstanceOf(
			SseTruncationError,
		);
	});

	test("dispatches nothing extra for a stream ending in a blank line", async () => {
		expect(
			await collect(streamFromChunks([encode("data: [DONE]\n\n")])),
		).toEqual(["[DONE]"]);
	});

	describe("EOF pending-event handling (blocker 5)", () => {
		test("dispatches a complete pending [DONE] only when the sentinel is configured", async () => {
			expect(
				await collect(streamFromChunks([encode("data: [DONE]\n")]), DONE),
			).toEqual(["[DONE]"]);
		});

		test("discards a pending [DONE] when no sentinel is configured (no general extension)", async () => {
			expect(
				await collect(streamFromChunks([encode("data: [DONE]\n")]), {}),
			).toEqual([]);
		});

		test("discards a complete pending non-[DONE] event at EOF even with the sentinel set", async () => {
			expect(
				await collect(
					streamFromChunks([encode('data: {"a":1}\n\ndata: {"late":1}\n')]),
					DONE,
				),
			).toEqual(['{"a":1}']);
		});

		test("treats an unterminated pending [DONE] as truncation, not a dispatch", async () => {
			await expect(
				collect(streamFromChunks([encode("data: [DONE]")]), DONE),
			).rejects.toBeInstanceOf(SseTruncationError);
		});
	});
});

describe("frameSseData", () => {
	test("frames a single-line payload as one data: line and a blank line", () => {
		expect(frameSseData('{"a":1}')).toBe('data: {"a":1}\n\n');
	});

	test("frames each newline of a multi-line payload as its own data: line", () => {
		expect(frameSseData("line1\nline2")).toBe("data: line1\ndata: line2\n\n");
	});

	test("round-trips a multi-line payload back through the parser unchanged", async () => {
		const payload = '{"a":\n1,"b":\n2}';
		const framed = frameSseData(payload);
		expect(await collect(streamFromChunks([encode(framed)]), {})).toEqual([
			payload,
		]);
	});
});
