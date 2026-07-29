import { describe, expect, test, vi } from "vitest";
import { registerSignalShutdown, type ShutdownProcess } from "./shutdown.js";

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
} {
	let resolve: (() => void) | undefined;
	let reject: ((error: unknown) => void) | undefined;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return {
		promise,
		resolve: () => resolve?.(),
		reject: (error) => reject?.(error),
	};
}

function runtime() {
	const listeners = new Map<NodeJS.Signals, () => void>();
	const process: ShutdownProcess & { emit(signal: NodeJS.Signals): void } = {
		on: (signal, listener) => listeners.set(signal, listener),
		removeListener: (signal, listener) => {
			if (listeners.get(signal) === listener) listeners.delete(signal);
		},
		exit: vi.fn(),
		emit: (signal) => listeners.get(signal)?.(),
	};
	return process;
}

describe("signal shutdown", () => {
	test("shares a single close promise across repeated SIGTERM and SIGINT", async () => {
		const process = runtime();
		const close = vi.fn(() => deferredClose.promise);
		const reportFailure = vi.fn();
		const deferredClose = deferred();
		registerSignalShutdown(process, close, reportFailure);

		process.emit("SIGTERM");
		process.emit("SIGINT");
		process.emit("SIGTERM");
		await Promise.resolve();
		expect(close).toHaveBeenCalledExactlyOnceWith();
		expect(process.exit).not.toHaveBeenCalled();

		deferredClose.resolve();
		await deferredClose.promise;
		await vi.waitFor(() => {
			expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
		});
		expect(reportFailure).not.toHaveBeenCalled();
	});

	test("reports a close failure and exits one only after settlement", async () => {
		const process = runtime();
		const failure = new Error("close failed");
		const deferredClose = deferred();
		const close = vi.fn(() => deferredClose.promise);
		const reportFailure = vi.fn();
		registerSignalShutdown(process, close, reportFailure);

		process.emit("SIGINT");
		await Promise.resolve();
		expect(process.exit).not.toHaveBeenCalled();
		deferredClose.reject(failure);
		await deferredClose.promise.catch(() => undefined);
		await vi.waitFor(() => {
			expect(reportFailure).toHaveBeenCalledExactlyOnceWith("SIGINT", failure);
			expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
		});
	});
});
