import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createAtomicJsonWriter } from "../../src/shared/atomic-json.ts";

class FakeFs {
	files = new Map<string, string>();
	madeDirs: string[] = [];
	renameCalls = 0;
	failMkdirCodes: string[] = [];
	failRenameCodes: string[] = [];
	writeOptions = new Map<string, unknown>();
	events: string[] = [];
	nextDescriptor = 1;
	descriptorPaths = new Map<number, string>();
	descriptorFlags = new Map<number, string>();
	failReadOnlyFileFsync = false;
	failFsyncAt: number | undefined;
	failFsyncCodeAt: { call: number; code: string } | undefined;
	fsyncCalls = 0;
	failCleanup = false;

	mkdirSync(dirPath: string): void {
		this.madeDirs.push(dirPath);
		const failureCode = this.failMkdirCodes.shift();
		if (failureCode) {
			const error = new Error(`mkdir failed with ${failureCode}`) as NodeJS.ErrnoException;
			error.code = failureCode;
			throw error;
		}
	}

	writeFileSync(filePath: string, contents: string, options?: unknown): void {
		this.events.push(`write:${filePath}`);
		this.files.set(filePath, contents);
		this.writeOptions.set(filePath, options);
	}

	readFileSync(filePath: string): string {
		const contents = this.files.get(filePath);
		if (contents !== undefined) return contents;
		const error = new Error(`missing file: ${filePath}`) as NodeJS.ErrnoException;
		error.code = "ENOENT";
		throw error;
	}

	renameSync(sourcePath: string, targetPath: string): void {
		this.events.push(`rename:${sourcePath}:${targetPath}`);
		this.renameCalls++;
		const failureCode = this.failRenameCodes.shift();
		if (failureCode) {
			const error = new Error(`rename failed with ${failureCode}`) as NodeJS.ErrnoException;
			error.code = failureCode;
			throw error;
		}
		const contents = this.files.get(sourcePath);
		if (contents === undefined) throw new Error(`missing source file: ${sourcePath}`);
		this.files.delete(sourcePath);
		this.files.set(targetPath, contents);
	}

	openSync(filePath: string, flags = "r"): number {
		this.events.push(`open:${filePath}:${flags}`);
		const descriptor = this.nextDescriptor++;
		this.descriptorPaths.set(descriptor, filePath);
		this.descriptorFlags.set(descriptor, flags);
		return descriptor;
	}

	fsyncSync(descriptor: number): void {
		const filePath = this.descriptorPaths.get(descriptor) ?? "unknown";
		this.events.push(`fsync:${filePath}`);
		this.fsyncCalls++;
		if (this.failReadOnlyFileFsync && this.files.has(filePath) && this.descriptorFlags.get(descriptor) === "r") {
			const error = new Error(`read-only fsync failed for ${filePath}`) as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		}
		if (this.failFsyncCodeAt?.call === this.fsyncCalls) {
			const error = new Error(`fsync failed for ${filePath}`) as NodeJS.ErrnoException;
			error.code = this.failFsyncCodeAt.code;
			throw error;
		}
		if (this.failFsyncAt === this.fsyncCalls) throw new Error(`fsync failed for ${filePath}`);
	}

	closeSync(descriptor: number): void {
		this.events.push(`close:${this.descriptorPaths.get(descriptor) ?? "unknown"}`);
		this.descriptorPaths.delete(descriptor);
		this.descriptorFlags.delete(descriptor);
	}

	rmSync(filePath: string): void {
		if (this.failCleanup) throw new Error("cleanup failed");
		this.files.delete(filePath);
	}
}

function createWriter(fakeFs: FakeFs, waits: number[]) {
	return createAtomicJsonWriter({
		fs: fakeFs as any,
		now: () => 12345,
		pid: 678,
		random: () => 0.5,
		retryRenameErrors: true,
		retryDelaysMs: [1, 2, 3],
		wait: (delayMs) => waits.push(delayMs),
	});
}

describe("writeAtomicJson", () => {
	it("retries transient rename failures before replacing the target", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["EPERM", "EBUSY"];
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);
		const targetPath = path.join("/tmp", "status.json");

		writeAtomicJson(targetPath, { state: "running" });

		assert.equal(fakeFs.renameCalls, 3);
		assert.deepEqual(waits, [1, 2]);
		assert.deepEqual(fakeFs.madeDirs, [path.dirname(targetPath)]);
		assert.equal(fakeFs.files.get(targetPath), JSON.stringify({ state: "running" }, null, 2));
		assert.equal(fakeFs.files.size, 1);
	});

	it("retries transient directory creation failures before writing", () => {
		const fakeFs = new FakeFs();
		fakeFs.failMkdirCodes = ["EPERM", "EACCES"];
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);
		const targetPath = path.join("/tmp", "status.json");

		writeAtomicJson(targetPath, { state: "running" });

		assert.equal(fakeFs.renameCalls, 1);
		assert.deepEqual(waits, [1, 2]);
		assert.deepEqual(fakeFs.madeDirs, [path.dirname(targetPath), path.dirname(targetPath), path.dirname(targetPath)]);
		assert.equal(fakeFs.files.get(targetPath), JSON.stringify({ state: "running" }, null, 2));
	});

	it("writes the temporary descriptor with the requested private mode", () => {
		const fakeFs = new FakeFs();
		const writeAtomicJson = createAtomicJsonWriter({
			fs: fakeFs as any,
			now: () => 12345,
			pid: 678,
			random: () => 0.5,
			mode: 0o600,
		});
		const targetPath = path.join("/tmp", "recovery-descriptor.json");

		writeAtomicJson(targetPath, { sourceRunId: "run" });

		assert.deepEqual([...fakeFs.writeOptions.values()], [{ encoding: "utf-8", mode: 0o600 }]);
	});

	it("syncs the temporary file before rename and the parent directory after it, without acknowledging any fault point", () => {
		const targetPath = path.join("/tmp", "durable.json");
		for (const testCase of [
			{ name: "file sync", failFsyncAt: 1, renameCalls: 0 },
			{ name: "rename", failRenameCodes: ["ENOSPC"], renameCalls: 1 },
			{ name: "directory sync", failFsyncAt: 2, renameCalls: 2, preimage: JSON.stringify({ state: "previous" }, null, 2) },
		] as const) {
			const fakeFs = new FakeFs();
			if (testCase.preimage) fakeFs.files.set(targetPath, testCase.preimage);
			fakeFs.failFsyncAt = testCase.failFsyncAt;
			fakeFs.failRenameCodes = testCase.failRenameCodes ? [...testCase.failRenameCodes] : [];
			const writeDurableJson = createAtomicJsonWriter({
				fs: fakeFs as any,
				now: () => 12345,
				pid: 678,
				random: () => 0.5,
				durable: true,
			});

			assert.throws(() => writeDurableJson(targetPath, { state: "running" }), /failed|ENOSPC/, testCase.name);
			assert.equal(fakeFs.renameCalls, testCase.renameCalls, testCase.name);
			if (testCase.name === "file sync") assert.equal(fakeFs.events.some((event) => event.startsWith("rename:")), false);
			if (testCase.name === "rename") assert.equal(fakeFs.events.filter((event) => event.startsWith("fsync:")).length, 1);
			if (testCase.name === "directory sync") assert.equal(fakeFs.files.get(targetPath), testCase.preimage, "post-rename directory sync failure restores the destination pre-image");
		}

		const fakeFs = new FakeFs();
		const writeDurableJson = createAtomicJsonWriter({ fs: fakeFs as any, now: () => 12345, pid: 678, random: () => 0.5, durable: true });
		writeDurableJson(targetPath, { state: "running" });
		const order = fakeFs.events.filter((event) => event.startsWith("write:") || event.startsWith("fsync:") || event.startsWith("rename:"));
		assert.equal(order[0]?.startsWith("write:"), true);
		assert.equal(order[1]?.startsWith("fsync:"), true);
		assert.equal(order[2]?.startsWith("rename:"), true);
		assert.equal(order[3], `fsync:${path.dirname(targetPath)}`);
	});

	it("tolerates unsupported Windows directory fsync without hiding file fsync failures", () => {
		const targetPath = path.join("/tmp", "durable-windows.json");
		const directoryFailure = new FakeFs();
		directoryFailure.failReadOnlyFileFsync = true;
		directoryFailure.failFsyncCodeAt = { call: 2, code: "EPERM" };
		const writeWithUnsupportedDirectorySync = createAtomicJsonWriter({
			fs: directoryFailure as any,
			now: () => 12345,
			pid: 678,
			random: () => 0.5,
			durable: true,
			platform: "win32",
		});

		writeWithUnsupportedDirectorySync(targetPath, { state: "running" });
		assert.equal(directoryFailure.files.get(targetPath), JSON.stringify({ state: "running" }, null, 2));
		assert.equal(directoryFailure.fsyncCalls, 2);

		const fileFailure = new FakeFs();
		fileFailure.failFsyncCodeAt = { call: 1, code: "EPERM" };
		const writeWithFileSyncFailure = createAtomicJsonWriter({
			fs: fileFailure as any,
			now: () => 12345,
			pid: 678,
			random: () => 0.5,
			durable: true,
			platform: "win32",
		});
		assert.throws(() => writeWithFileSyncFailure(targetPath, { state: "running" }), /fsync failed/);
		assert.equal(fileFailure.renameCalls, 0);
	});

	it("keeps temporary names below the component limit for long target names", () => {
		const fakeFs = new FakeFs();
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);
		const targetPath = path.join("/tmp", `${"x".repeat(250)}.json`);

		writeAtomicJson(targetPath, { state: "running" });

		const [tempPath] = fakeFs.writeOptions.keys();
		assert.ok(tempPath);
		assert.ok(Buffer.byteLength(path.basename(tempPath), "utf-8") <= 255);
		assert.equal(fakeFs.files.get(targetPath), JSON.stringify({ state: "running" }, null, 2));
	});

	it("uses longer default retries for transient Windows rename locks", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["EPERM", "EPERM", "EPERM", "EPERM", "EPERM", "EPERM"];
		const waits: number[] = [];
		const writeAtomicJson = createAtomicJsonWriter({
			fs: fakeFs as any,
			now: () => 12345,
			pid: 678,
			random: () => 0.5,
			retryRenameErrors: true,
			wait: (delayMs) => waits.push(delayMs),
		});

		writeAtomicJson(path.join("/tmp", "status.json"), { state: "running" });

		assert.equal(fakeFs.renameCalls, 7);
		assert.deepEqual(waits, [10, 25, 50, 100, 200, 500]);
	});

	it("throws non-retryable rename failures without retrying", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["ENOENT"];
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);

		assert.throws(() => writeAtomicJson(path.join("/tmp", "status.json"), { state: "running" }), /ENOENT/);
		assert.equal(fakeFs.renameCalls, 1);
		assert.deepEqual(waits, []);
		assert.equal(fakeFs.files.size, 0);
	});

	it("does not let cleanup failures mask a write failure", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["ENOSPC"];
		fakeFs.failCleanup = true;
		const writeAtomicJson = createWriter(fakeFs, []);
		assert.throws(() => writeAtomicJson(path.join("/tmp", "status.json"), { state: "running" }), /ENOSPC/);
	});

	it("cleans up the temp file after retryable failures are exhausted", () => {
		const fakeFs = new FakeFs();
		fakeFs.failRenameCodes = ["EPERM", "EPERM", "EPERM", "EPERM"];
		const waits: number[] = [];
		const writeAtomicJson = createWriter(fakeFs, waits);
		const targetPath = path.join("/tmp", "status.json");

		assert.throws(() => writeAtomicJson(targetPath, { state: "running" }), /EPERM/);
		assert.equal(fakeFs.renameCalls, 4);
		assert.deepEqual(waits, [1, 2, 3]);
		assert.equal(fakeFs.files.has(targetPath), false);
		assert.equal(fakeFs.files.size, 0);
	});
});
