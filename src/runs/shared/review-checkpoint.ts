import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { readAcknowledgedChildToolResultDetails } from "../../shared/child-transcript.ts";
import type { JsonSchemaObject, ReviewCheckpointPolicy, ReviewCheckpointRecord } from "../../shared/types.ts";

export const REVIEW_CHECKPOINT_POLICY_VERSION = 1 as const;
export const REVIEW_CHECKPOINT_GATE_TURN = 3;
export const REVIEW_CHECKPOINT_FINALIZATION_RESERVE_TURNS = 1;
export const REVIEW_CHECKPOINT_TOOL_NAME = "review_checkpoint";
export const REVIEW_CHECKPOINT_POLICY_ENV = "PI_SUBAGENT_REVIEW_CHECKPOINT_POLICY";
export const REVIEW_CHECKPOINT_STORE_ENV = "PI_SUBAGENT_REVIEW_CHECKPOINT_STORE";

export const REVIEW_CHECKPOINT_PARAMETERS_SCHEMA: JsonSchemaObject = {
	type: "object",
	properties: {
		reviewFindings: {
			type: "array",
			items: { type: "string", minLength: 1 },
		},
		residualRisks: {
			type: "array",
			items: { type: "string", minLength: 1 },
		},
	},
	required: ["reviewFindings", "residualRisks"],
	additionalProperties: false,
};

interface ReviewCheckpointStore {
	version: 1;
	records: ReviewCheckpointRecord[];
}

export interface ReviewCheckpointIdentity {
	runId: string;
	childIndex: number;
	agent: string;
}

export interface ReviewCheckpointSubmission {
	reviewFindings: string[];
	residualRisks: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(nonEmptyString);
}

function sameIdentity(record: ReviewCheckpointRecord, identity: ReviewCheckpointIdentity | undefined): boolean {
	return !identity || (record.runId === identity.runId && record.childIndex === identity.childIndex && record.agent === identity.agent);
}

export function validateCheckpointPolicy(value: unknown, label = "checkpointPolicy"): { policy?: ReviewCheckpointPolicy; error?: string } {
	if (!isRecord(value)) return { error: `${label} must be an object with version: 1.` };
	const unknownField = Object.keys(value).find((key) => key !== "version");
	if (unknownField) return { error: `${label}.${unknownField} is not supported.` };
	if (value.version !== REVIEW_CHECKPOINT_POLICY_VERSION) return { error: `${label}.version must be ${REVIEW_CHECKPOINT_POLICY_VERSION}.` };
	return { policy: { version: REVIEW_CHECKPOINT_POLICY_VERSION } };
}

export function validateReviewCheckpointSubmission(value: unknown, label = "review_checkpoint.value"): { submission?: ReviewCheckpointSubmission; error?: string } {
	if (!isRecord(value)) return { error: `${label} must be an object.` };
	const unknownField = Object.keys(value).find((key) => key !== "reviewFindings" && key !== "residualRisks");
	if (unknownField) return { error: `${label}.${unknownField} is not supported.` };
	if (!stringArray(value.reviewFindings)) return { error: `${label}.reviewFindings must be an array of non-empty strings.` };
	if (!stringArray(value.residualRisks)) return { error: `${label}.residualRisks must be an array of non-empty strings.` };
	return {
		submission: {
			reviewFindings: value.reviewFindings.map((entry) => entry.trim()),
			residualRisks: value.residualRisks.map((entry) => entry.trim()),
		},
	};
}

export function validateReviewCheckpointRecord(value: unknown, identity?: ReviewCheckpointIdentity): ReviewCheckpointRecord | undefined {
	if (!isRecord(value)) return undefined;
	const allowed = new Set(["version", "runId", "childIndex", "agent", "sequence", "timestamp", "assistantTurn", "reviewFindings", "residualRisks"]);
	if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
	if (value.version !== REVIEW_CHECKPOINT_POLICY_VERSION
		|| !nonEmptyString(value.runId)
		|| !Number.isInteger(value.childIndex) || (value.childIndex as number) < 0
		|| !nonEmptyString(value.agent)
		|| !Number.isInteger(value.sequence) || (value.sequence as number) < 1
		|| !nonEmptyString(value.timestamp) || Number.isNaN(Date.parse(value.timestamp as string))
		|| !Number.isInteger(value.assistantTurn) || (value.assistantTurn as number) < 1
		|| !stringArray(value.reviewFindings)
		|| !stringArray(value.residualRisks)) return undefined;
	const record: ReviewCheckpointRecord = {
		version: REVIEW_CHECKPOINT_POLICY_VERSION,
		runId: (value.runId as string).trim(),
		childIndex: value.childIndex as number,
		agent: (value.agent as string).trim(),
		sequence: value.sequence as number,
		timestamp: value.timestamp as string,
		assistantTurn: value.assistantTurn as number,
		reviewFindings: (value.reviewFindings as string[]).map((entry) => entry.trim()),
		residualRisks: (value.residualRisks as string[]).map((entry) => entry.trim()),
	};
	return sameIdentity(record, identity) ? record : undefined;
}

function sortAndDeduplicate(records: ReviewCheckpointRecord[]): ReviewCheckpointRecord[] {
	const byKey = new Map<string, ReviewCheckpointRecord>();
	for (const record of records) {
		const key = `${record.runId}\u0000${record.childIndex}\u0000${record.agent}\u0000${record.sequence}`;
		const previous = byKey.get(key);
		if (!previous || previous.timestamp <= record.timestamp) byKey.set(key, record);
	}
	return [...byKey.values()].sort((left, right) => left.sequence - right.sequence || left.timestamp.localeCompare(right.timestamp));
}

function readStoreFile(filePath: string, identity?: ReviewCheckpointIdentity): { valid: boolean; records: ReviewCheckpointRecord[] } {
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return { valid: false, records: [] };
	}
	if (!isRecord(value) || value.version !== REVIEW_CHECKPOINT_POLICY_VERSION || !Array.isArray(value.records)) return { valid: false, records: [] };
	const records = value.records.map((record) => validateReviewCheckpointRecord(record, identity));
	return records.some((record) => !record)
		? { valid: false, records: [] }
		: { valid: true, records: records as ReviewCheckpointRecord[] };
}

/** Reads the current atomic snapshot and its immediate predecessor so a torn newest write cannot erase acknowledged history. */
export function readReviewCheckpointStore(storePath: string | undefined, identity?: ReviewCheckpointIdentity): ReviewCheckpointRecord[] {
	if (!storePath) return [];
	return sortAndDeduplicate([
		...readStoreFile(storePath, identity).records,
		...readStoreFile(`${storePath}.previous`, identity).records,
	]);
}

function recordStore(records: ReviewCheckpointRecord[]): ReviewCheckpointStore {
	return { version: REVIEW_CHECKPOINT_POLICY_VERSION, records };
}

/** Persists before returning the record, so callers can use a successful return as an acknowledgement receipt. */
export function persistReviewCheckpoint(input: {
	storePath: string;
	identity: ReviewCheckpointIdentity;
	assistantTurn: number;
	submission: ReviewCheckpointSubmission;
	now?: () => Date;
}): ReviewCheckpointRecord {
	if (!input.storePath.trim()) throw new Error("review checkpoint store path is required.");
	if (!Number.isInteger(input.assistantTurn) || input.assistantTurn < 1) throw new Error("review checkpoint assistant turn is invalid.");
	const primary = fs.existsSync(input.storePath) ? readStoreFile(input.storePath, input.identity) : { valid: true, records: [] };
	const previous = fs.existsSync(`${input.storePath}.previous`) ? readStoreFile(`${input.storePath}.previous`, input.identity) : { valid: true, records: [] };
	if (!primary.valid && !previous.valid) {
		throw new Error("review checkpoint store is unreadable; refusing to acknowledge a record that could erase prior evidence.");
	}
	const current = sortAndDeduplicate([...primary.records, ...previous.records]);
	if (current.length > 0) writePrivateAtomicJson(`${input.storePath}.previous`, recordStore(current));
	const record: ReviewCheckpointRecord = {
		version: REVIEW_CHECKPOINT_POLICY_VERSION,
		runId: input.identity.runId,
		childIndex: input.identity.childIndex,
		agent: input.identity.agent,
		sequence: (current.at(-1)?.sequence ?? 0) + 1,
		timestamp: (input.now ?? (() => new Date()))().toISOString(),
		assistantTurn: input.assistantTurn,
		reviewFindings: [...input.submission.reviewFindings],
		residualRisks: [...input.submission.residualRisks],
	};
	writePrivateAtomicJson(input.storePath, recordStore([...current, record]));
	return record;
}

/**
 * Recovers only acknowledged `review_checkpoint` tool results. It never reads
 * assistant prose, thinking, or an unacknowledged tool start.
 */
export function salvageReviewCheckpoints(input: {
	storePath?: string;
	transcriptPath?: string;
	identity?: ReviewCheckpointIdentity;
}): ReviewCheckpointRecord[] {
	const durable = readReviewCheckpointStore(input.storePath, input.identity);
	const transcript = input.transcriptPath
		? readAcknowledgedChildToolResultDetails(input.transcriptPath, REVIEW_CHECKPOINT_TOOL_NAME)
			.flatMap((details) => {
				const candidate = isRecord(details) ? details.reviewCheckpoint : undefined;
				const record = validateReviewCheckpointRecord(candidate, input.identity);
				return record ? [record] : [];
			})
		: [];
	return sortAndDeduplicate([...durable, ...transcript]);
}

export function projectCheckpointEvidence(records: ReviewCheckpointRecord[]): Pick<ReviewCheckpointRecord, "reviewFindings" | "residualRisks"> | undefined {
	const latest = records.at(-1);
	return latest
		? { reviewFindings: [...latest.reviewFindings], residualRisks: [...latest.residualRisks] }
		: undefined;
}

export function checkpointStorePath(root: string, runId: string, childIndex: number): string {
	return path.join(root, "review-checkpoints", `${runId}-${childIndex}.json`);
}
