import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, runFileSystemOperationWithRetry, waitForFileSystemRetry } from "./file-system-retry.ts";

type AtomicJsonFs = Pick<typeof fs, "mkdirSync" | "writeFileSync" | "renameSync" | "rmSync" | "openSync" | "fsyncSync" | "closeSync"> & Partial<Pick<typeof fs, "readFileSync">>;

const MAX_PATH_COMPONENT_BYTES = 255;

type AtomicJsonWriterOptions = {
	fs?: AtomicJsonFs;
	now?: () => number;
	pid?: number;
	random?: () => number;
	mode?: number;
	/** Sync the completed temporary file and parent directory before acknowledging the replacement. */
	durable?: boolean;
	retryRenameErrors?: boolean;
	retryDirectoryErrors?: boolean;
	retryDelaysMs?: readonly number[];
	wait?: (delayMs: number) => void;
	platform?: NodeJS.Platform;
};

type DestinationPreimage =
	| { exists: false }
	| { exists: true; content: string };

function renameWithRetry(
	fsImpl: AtomicJsonFs,
	sourcePath: string,
	targetPath: string,
	retryDelaysMs: readonly number[],
	wait: (delayMs: number) => void,
): void {
	runFileSystemOperationWithRetry(() => {
		fsImpl.renameSync(sourcePath, targetPath);
	}, { retryDelaysMs, wait });
}

function tempBaseName(filePath: string, pid: number, nowMs: number, randomId: string): string {
	const suffix = `.${pid}.${nowMs}.${randomId}.tmp`;
	const preferred = `.${path.basename(filePath)}${suffix}`;
	if (Buffer.byteLength(preferred, "utf-8") <= MAX_PATH_COMPONENT_BYTES) return preferred;
	return `.${createHash("sha256").update(path.basename(filePath)).digest("hex")}${suffix}`;
}

/** Sync one path without allowing descriptor cleanup to hide the sync failure. */
function syncPath(fsImpl: AtomicJsonFs, targetPath: string): void {
	let descriptor: number | undefined;
	let operationError: unknown;
	try {
		descriptor = fsImpl.openSync(targetPath, "r");
		fsImpl.fsyncSync(descriptor);
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		if (descriptor !== undefined) {
			try {
				fsImpl.closeSync(descriptor);
			} catch (closeError) {
				if (operationError === undefined) throw closeError;
			}
		}
	}
}

/** Node cannot flush directory handles on Windows; retain file fsync and atomic rename there. */
function syncDirectoryPath(fsImpl: AtomicJsonFs, targetPath: string, platform: NodeJS.Platform): void {
	try {
		syncPath(fsImpl, targetPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (platform === "win32" && (code === "EPERM" || code === "EINVAL")) return;
		throw error;
	}
}

function readDestinationPreimage(fsImpl: AtomicJsonFs, filePath: string): DestinationPreimage {
	if (!fsImpl.readFileSync) throw new Error("Durable atomic replacement requires readFileSync to preserve the destination pre-image.");
	try {
		return { exists: true, content: fsImpl.readFileSync(filePath, "utf-8") as string };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
		throw error;
	}
}

/** Restores a target after a post-rename durability failure without hiding that failure. */
function restoreDestinationPreimage(input: {
	fsImpl: AtomicJsonFs;
	filePath: string;
	preimage: DestinationPreimage;
	pid: number;
	now: () => number;
	random: () => number;
	mode?: number;
	retryDelaysMs: readonly number[];
	wait: (delayMs: number) => void;
	platform: NodeJS.Platform;
}): void {
	let rollbackTempPath: string | undefined;
	try {
		if (!input.preimage.exists) {
			input.fsImpl.rmSync(input.filePath, { force: true });
			syncDirectoryPath(input.fsImpl, path.dirname(input.filePath), input.platform);
			return;
		}
		rollbackTempPath = path.join(
			path.dirname(input.filePath),
			tempBaseName(input.filePath, input.pid, input.now(), `rollback-${input.random().toString(36).slice(2)}`),
		);
		input.fsImpl.writeFileSync(
			rollbackTempPath,
			input.preimage.content,
			input.mode === undefined ? "utf-8" : { encoding: "utf-8", mode: input.mode },
		);
		syncPath(input.fsImpl, rollbackTempPath);
		renameWithRetry(input.fsImpl, rollbackTempPath, input.filePath, input.retryDelaysMs, input.wait);
		syncDirectoryPath(input.fsImpl, path.dirname(input.filePath), input.platform);
	} catch {
		// The original post-rename durability failure is authoritative. Review
		// checkpoint generations remain unacknowledged if restoration also fails.
	} finally {
		if (rollbackTempPath) {
			try {
				input.fsImpl.rmSync(rollbackTempPath, { force: true });
			} catch {
				// Rollback cleanup is best effort and must not mask the write failure.
			}
		}
	}
}

export function createAtomicJsonWriter(options: AtomicJsonWriterOptions = {}): (filePath: string, payload: object) => void {
	const fsImpl = options.fs ?? fs;
	const now = options.now ?? Date.now;
	const pid = options.pid ?? process.pid;
	const random = options.random ?? Math.random;
	const mode = options.mode;
	const durable = options.durable === true;
	const retryRenameErrors = options.retryRenameErrors ?? process.platform === "win32";
	const retryDirectoryErrors = options.retryDirectoryErrors ?? retryRenameErrors;
	const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
	const platform = options.platform ?? process.platform;
	const renameRetryDelaysMs = retryRenameErrors ? retryDelaysMs : [];
	const directoryRetryDelaysMs = retryDirectoryErrors ? retryDelaysMs : [];
	const wait = options.wait ?? waitForFileSystemRetry;
	return (filePath: string, payload: object): void => {
		runFileSystemOperationWithRetry(() => {
			fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
		}, { retryDelaysMs: directoryRetryDelaysMs, wait });
		const tempPath = path.join(
			path.dirname(filePath),
			tempBaseName(filePath, pid, now(), random().toString(36).slice(2)),
		);
		const preimage = durable ? readDestinationPreimage(fsImpl, filePath) : undefined;
		let renamed = false;
		let writeError: unknown;
		try {
			fsImpl.writeFileSync(tempPath, JSON.stringify(payload, null, 2), mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
			if (durable) syncPath(fsImpl, tempPath);
			renameWithRetry(fsImpl, tempPath, filePath, renameRetryDelaysMs, wait);
			renamed = true;
			if (durable) syncDirectoryPath(fsImpl, path.dirname(filePath), platform);
		} catch (error) {
			writeError = error;
			if (durable && renamed && preimage) {
				restoreDestinationPreimage({
					fsImpl,
					filePath,
					preimage,
					pid,
					now,
					random,
					mode,
					retryDelaysMs: renameRetryDelaysMs,
					wait,
					platform,
				});
			}
			throw error;
		} finally {
			try {
				fsImpl.rmSync(tempPath, { force: true });
			} catch (cleanupError) {
				// Preserve the write/rename failure: cleanup is best effort and must
				// not hide the error callers need to classify or report.
				if (writeError === undefined) throw cleanupError;
			}
		}
	};
}

export const writeAtomicJson = createAtomicJsonWriter();
export const writePrivateAtomicJson = createAtomicJsonWriter({ mode: 0o600 });
/** Use for review evidence and terminal artifacts that must survive an acknowledged crash boundary. */
export const writeDurablePrivateAtomicJson = createAtomicJsonWriter({ mode: 0o600, durable: true });
