/**
 * Contract: a vibe turn advertises `agent://<id>` only when the child's output
 * artifact was actually published.
 *
 * `vibe-turn-result.md` renders `full-output="agent://{{id}}"` whenever
 * `responseTruncated` is set, and `agent://` resolution scans for `<id>.md`.
 * `finalizeRunResult()` assigns `SingleResult.outputPath` only after
 * `writeArtifact()` verified the bytes, so an unverified write leaves that URI
 * absent. Gating truncation on `outputPath` keeps the withheld bytes reachable:
 * without a receipt the whole response stays inline. #9649 applied the same
 * gate to the task envelope (`task/index.ts`) and left this sibling ungated.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

/** Longer than the runtime's 6000-character `RESPONSE_PREVIEW_MAX`. */
const LONG_OUTPUT = `${"work line\n".repeat(700)}tail marker`;

/**
 * Run one vibe turn whose child returns `LONG_OUTPUT`, and return the settled
 * turn text the caller receives. `outputPath` decides whether the executor
 * reports a published artifact.
 */
async function settleLongTurn(options: { outputPath?: string }): Promise<string> {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	const session = {
		cwd: "/tmp",
		settings: Settings.isolated({}),
		asyncJobManager: manager,
		getSessionId: () => "parent-session",
		// No session file: the spawn stays in-memory and skips lifecycle persistence.
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;

	vi.spyOn(executorModule, "runSubprocess").mockImplementation(
		async executorOptions =>
			({
				index: 0,
				id: executorOptions.id,
				agent: executorOptions.agent.name,
				agentSource: "bundled",
				task: executorOptions.task,
				exitCode: 0,
				output: LONG_OUTPUT,
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
				...(options.outputPath
					? {
							outputPath: options.outputPath,
							outputMeta: { lineCount: 701, charCount: LONG_OUTPUT.length },
						}
					: {}),
			}) as SingleResult,
	);

	try {
		const { jobId } = await VibeSessionRegistry.global().spawn(session, { cli: "good", prompt: "work" });
		// The run promise resolves void; `#settleTurn`'s text lands on the job.
		const job = manager.getJob(jobId);
		await job?.promise;
		return job?.resultText ?? "";
	} finally {
		await manager.dispose({ timeoutMs: 1_000 });
	}
}

describe("vibe turn artifact gate", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("keeps a long response inline when no artifact was published", async () => {
		const text = await settleLongTurn({});

		// No receipt means no resolvable pointer, so the bytes must stay here.
		expect(text).not.toContain("full-output=");
		expect(text).not.toContain('truncated="true"');
		expect(text).toContain("tail marker");
	});

	it("advertises the artifact pointer once the output artifact exists", async () => {
		const text = await settleLongTurn({ outputPath: "/tmp/omp-vibe-artifacts/worker.md" });

		expect(text).toContain('truncated="true"');
		expect(text).toMatch(/full-output="agent:\/\/[^"]+"/);
		// Truncation is the point of the pointer: the tail is withheld.
		expect(text).not.toContain("tail marker");
	});
});
