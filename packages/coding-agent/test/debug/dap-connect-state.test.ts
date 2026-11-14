import { describe, expect, it } from "bun:test";
import { DapClient } from "@oh-my-pi/pi-coding-agent/dap/client";
import type { DapResolvedAdapter } from "@oh-my-pi/pi-coding-agent/dap/types";

const TEST_ADAPTER: DapResolvedAdapter = {
	name: "lldb-dap",
	command: "lldb-dap",
	args: [],
	resolvedCommand: "lldb-dap",
	languages: [],
	fileTypes: [],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "stdio",
	acceptsDirectoryProgram: false,
};

describe("DapClient connection state", () => {
	it("reports the absent process state for socket-mode connections instead of a fabricated child process", async () => {
		// Reader contract: a client attached to an already-running DAP server
		// never spawned a process, so a reader of the state field must observe
		// "no process". Pre-fix, connect() fabricated one — a placeholder object
		// cast through `as unknown as DapClientState["proc"]` with a hardcoded
		// `exitCode: null` — so readers saw a live child process that does not
		// exist. The regression this guards: a reader (isAlive, exit reporting,
		// dispose) trusting a process-shaped value for a process-less client.
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open() {},
				data() {},
				close() {},
				error() {},
			},
		});
		let client: DapClient | undefined;
		try {
			client = await DapClient.connect({
				adapter: TEST_ADAPTER,
				cwd: process.cwd(),
				host: "127.0.0.1",
				port: server.port,
			});

			// The state field names the transport honestly: socket-backed, no
			// child process. A fabricated placeholder has no `kind`.
			expect(client.proc.kind).toBe("socket");
			expect(client.proc).not.toHaveProperty("process");
			// The client is alive — the connection is open — and disposing must
			// settle the exit signal without a fake process in between.
			expect(client.isAlive()).toBe(true);
			await client.dispose();
			expect(client.isAlive()).toBe(false);
			await client.exited;
		} finally {
			await client?.dispose();
			server.stop(true);
		}
	});
});
