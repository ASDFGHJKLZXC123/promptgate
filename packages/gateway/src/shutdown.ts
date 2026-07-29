export interface ShutdownProcess {
	on(signal: NodeJS.Signals, listener: () => void): unknown;
	removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
	exit(code: number): void;
}

export function registerSignalShutdown(
	runtime: ShutdownProcess,
	close: () => Promise<void> | void,
	reportFailure: (signal: NodeJS.Signals, error: unknown) => void,
): () => void {
	let shutdown: Promise<void> | undefined;
	const requestShutdown = (signal: NodeJS.Signals): void => {
		if (shutdown) return;

		shutdown = Promise.resolve().then(() => close());
		void shutdown.then(
			() => runtime.exit(0),
			(error: unknown) => {
				reportFailure(signal, error);
				runtime.exit(1);
			},
		);
	};
	const handleSigterm = () => requestShutdown("SIGTERM");
	const handleSigint = () => requestShutdown("SIGINT");
	runtime.on("SIGTERM", handleSigterm);
	runtime.on("SIGINT", handleSigint);
	return () => {
		runtime.removeListener("SIGTERM", handleSigterm);
		runtime.removeListener("SIGINT", handleSigint);
	};
}
