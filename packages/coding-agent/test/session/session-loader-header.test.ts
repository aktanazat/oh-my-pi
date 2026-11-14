import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];
const LARGE_SESSION_BYTES = 9 * 1024 * 1024;

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

// Forces the streaming load path (loadEntriesFromFileStream) even on small files.
class LargeFileSessionStorage extends FileSessionStorage {
	override statSync(filePath: string) {
		return { ...super.statSync(filePath), size: LARGE_SESSION_BYTES };
	}
	override async readText(): Promise<string> {
		throw new Error("Large sessions must stream");
	}
}

async function writeJsonl(file: string, entries: unknown[]): Promise<void> {
	await Bun.write(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
}

// A well-formed entry that is NOT a session header: exactly the foreign first
// line a corrupted or hand-merged file could start with.
function foreignFirstEntry() {
	return {
		type: "message",
		id: "foreign-1",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: "hi" },
	};
}

const lateHeader = {
	type: "session",
	version: 3,
	id: "late-header",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/wrong",
};

const trailingEntry = {
	type: "session_init",
	id: "init-1",
	parentId: "late-header",
	timestamp: "2026-01-01T00:00:00.000Z",
	systemPrompt: "late",
	task: "task",
	tools: [],
};

describe("session header validation at the load boundary", () => {
	it("loadSessionFile refuses to adopt a session whose first entry is not a header (buffered path)", async () => {
		const dir = makeTempDir("@pi-header-buffered-");
		const file = path.join(dir, "foreign.jsonl");
		await writeJsonl(file, [foreignFirstEntry(), lateHeader, trailingEntry]);

		const loaded = await loadSessionFile(file, new FileSessionStorage());
		// The unguarded parser hands back the foreign message as entries[0]; the
		// load boundary must instead refuse the file so no caller ever casts a
		// non-header into SessionHeader (which would read header.cwd as undefined
		// and silently skip cwd adoption).
		expect(loaded.entries).toEqual([]);
		expect(loaded.titleSlot).toBeUndefined();
	});

	it("loadSessionFile refuses to adopt a session whose first entry is not a header (streaming path)", async () => {
		const dir = makeTempDir("@pi-header-streaming-");
		const file = path.join(dir, "foreign.jsonl");
		await writeJsonl(file, [foreignFirstEntry(), lateHeader, trailingEntry]);

		const loaded = await loadSessionFile(file, new LargeFileSessionStorage());
		expect(loaded.entries).toEqual([]);
	});

	it("a valid session file loads unchanged (header first, cwd and title intact)", async () => {
		const cwd = makeTempDir("@pi-header-valid-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");
		const expectedId = manager.getSessionId();
		await manager.ensureOnDisk();

		for (const storage of [new FileSessionStorage(), new LargeFileSessionStorage()]) {
			const loaded = await loadSessionFile(sessionFile, storage);
			expect(loaded.entries).toHaveLength(1);
			const header = loaded.entries[0];
			expect(header.type).toBe("session");
			if (header.type !== "session") throw new Error("unreachable");
			expect(header.id).toBe(expectedId);
			expect(header.cwd).toBe(path.resolve(cwd));
			expect(loaded.malformedRecords).toBe(0);
		}
	});

	it("SessionManager.open starts a fresh session instead of adopting a foreign first line", async () => {
		const cwd = makeTempDir("@pi-header-open-");
		const file = path.join(cwd, "foreign.jsonl");
		await writeJsonl(file, [foreignFirstEntry(), lateHeader, trailingEntry]);

		const manager = await SessionManager.open(file, path.join(cwd, "sessions"), new FileSessionStorage(), {
			initialCwd: cwd,
		});
		// The late "session" entry (id "late-header", cwd "/wrong") must never be
		// adopted: not its id, not its cwd.
		expect(manager.getSessionId()).not.toBe("late-header");
		expect(manager.getCwd()).toBe(path.resolve(cwd));
		await manager.close();
	});

	it("SessionManager.open resumes a valid session and adopts its recorded cwd", async () => {
		const recordedCwd = makeTempDir("@pi-header-resume-");
		const manager = SessionManager.create(recordedCwd, path.join(recordedCwd, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");
		const expectedId = manager.getSessionId();
		await manager.ensureOnDisk();
		await manager.close();

		const resumed = await SessionManager.open(sessionFile, undefined, new FileSessionStorage(), {
			initialCwd: "/elsewhere",
		});
		expect(resumed.getSessionId()).toBe(expectedId);
		expect(resumed.getCwd()).toBe(path.resolve(recordedCwd));
		await resumed.close();
	});
});
