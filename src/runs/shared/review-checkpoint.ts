import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { readAcknowledgedChildToolResultDetails } from "../../shared/child-transcript.ts";
import type {
	JsonSchemaObject,
	ReviewCheckpointEvidence,
	ReviewCheckpointFinding,
	ReviewCheckpointPolicy,
	ReviewCheckpointPolicyInput,
	ReviewCheckpointRecord,
	ReviewCheckpointSubmission,
	ReviewCheckpointTruncationCause,
	TerminalCause,
} from "../../shared/types.ts";

export const REVIEW_CHECKPOINT_POLICY_VERSION = 1 as const;
export const REVIEW_CHECKPOINT_REQUIRED_BY_TURN = 3 as const;
export const REVIEW_CHECKPOINT_RESERVE_TURNS = 1 as const;
export const REVIEW_CHECKPOINT_FINALIZE_RESERVE_MS = 120000 as const;
export const REVIEW_CHECKPOINT_COLLECTION_RESERVE_MS = 60000 as const;
export const REVIEW_CHECKPOINT_MAX_LINE_RANGE = 200;
export const REVIEW_CHECKPOINT_TOOL_NAME = "review_checkpoint";
export const REVIEW_CHECKPOINT_POLICY_ENV = "PI_SUBAGENT_REVIEW_CHECKPOINT_POLICY";
export const REVIEW_CHECKPOINT_STORE_ENV = "PI_SUBAGENT_REVIEW_CHECKPOINT_STORE";
export const REVIEW_CHECKPOINT_FINALIZE_AT_ENV = "PI_SUBAGENT_REVIEW_CHECKPOINT_FINALIZE_AT";
export const REVIEW_CHECKPOINT_BUDGET_TRUNCATED_MARKER = "BUDGET: truncated";

export const REVIEW_CHECKPOINT_POLICY_V1: ReviewCheckpointPolicy = {
	version: REVIEW_CHECKPOINT_POLICY_VERSION,
	requiredByTurn: REVIEW_CHECKPOINT_REQUIRED_BY_TURN,
	reserveTurns: REVIEW_CHECKPOINT_RESERVE_TURNS,
	finalizeReserveMs: REVIEW_CHECKPOINT_FINALIZE_RESERVE_MS,
	collectionReserveMs: REVIEW_CHECKPOINT_COLLECTION_RESERVE_MS,
};

const FINDING_SEVERITIES = new Set(["blocker", "major", "minor", "non-blocking"]);
const TRUNCATION_CAUSES = new Set<ReviewCheckpointTruncationCause>([
	"explicit-stop",
	"workflow-deadline",
	"interrupt",
	"turn-budget",
	"tool-timeout",
	"protocol-failure",
	"process-signal",
	"process-failure",
	"spawn-failure",
	"no-checkpoint",
]);

const findingSchema = {
	type: "object",
	properties: {
		severity: { type: "string", enum: [...FINDING_SEVERITIES] },
		path: { type: "string", minLength: 1 },
		line: {
			anyOf: [
				{ type: "integer", minimum: 1 },
				{
					type: "object",
					properties: {
						start: { type: "integer", minimum: 1 },
						end: { type: "integer", minimum: 1 },
					},
					required: ["start", "end"],
					additionalProperties: false,
				},
			],
		},
		claim: { type: "string", minLength: 1 },
		evidence: { type: "string", minLength: 1 },
	},
	required: ["severity", "path", "line", "claim", "evidence"],
	additionalProperties: false,
};

/** The only accepted durable checkpoint receipts. Runtime validation remains authoritative for bounded line ranges. */
export const REVIEW_CHECKPOINT_PARAMETERS_SCHEMA: JsonSchemaObject = {
	anyOf: [
		{
			type: "object",
			properties: { kind: { type: "string", enum: ["finding"] }, finding: findingSchema },
			required: ["kind", "finding"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				kind: { type: "string", enum: ["progress"] },
				status: { type: "string", enum: ["no-confirmed-finding-yet"] },
			},
			required: ["kind", "status"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				kind: { type: "string", enum: ["final"] },
				status: { type: "string", enum: ["complete"] },
			},
			required: ["kind", "status"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				kind: { type: "string", enum: ["final"] },
				status: { type: "string", enum: ["truncated"] },
				cause: { type: "string", enum: [...TRUNCATION_CAUSES] },
			},
			required: ["kind", "status", "cause"],
			additionalProperties: false,
		},
	],
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

export interface ReviewCheckpointMachineArtifact {
	version: 1;
	source: "review-checkpoint";
	status: "complete" | "incomplete" | "truncated";
	checkpointState: "final-complete" | "final-truncated" | "incomplete" | "no-checkpoint";
	cause?: ReviewCheckpointTruncationCause;
	marker?: typeof REVIEW_CHECKPOINT_BUDGET_TRUNCATED_MARKER;
	findings: ReviewCheckpointFinding[];
	records: ReviewCheckpointRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
	return Object.keys(value).find((key) => !allowed.includes(key));
}

function sameIdentity(record: ReviewCheckpointRecord, identity: ReviewCheckpointIdentity | undefined): boolean {
	return !identity || (record.runId === identity.runId && record.childIndex === identity.childIndex && record.agent === identity.agent);
}

function lineValue(value: unknown): number | { start: number; end: number } | undefined {
	if (Number.isInteger(value) && (value as number) >= 1) return value as number;
	if (!isRecord(value) || exactKeys(value, ["start", "end"]) || !Number.isInteger(value.start) || !Number.isInteger(value.end)) return undefined;
	const start = value.start as number;
	const end = value.end as number;
	if (start < 1 || end < start || end - start + 1 > REVIEW_CHECKPOINT_MAX_LINE_RANGE) return undefined;
	return { start, end };
}

function validateFinding(value: unknown, label: string): { finding?: ReviewCheckpointFinding; error?: string } {
	if (!isRecord(value)) return { error: `${label} must be an object.` };
	const unknownField = exactKeys(value, ["severity", "path", "line", "claim", "evidence"]);
	if (unknownField) return { error: `${label}.${unknownField} is not supported.` };
	if (typeof value.severity !== "string" || !FINDING_SEVERITIES.has(value.severity)) return { error: `${label}.severity must be blocker, major, minor, or non-blocking.` };
	if (!nonEmptyString(value.path)) return { error: `${label}.path must be a non-empty string.` };
	const line = lineValue(value.line);
	if (!line) return { error: `${label}.line must be one positive line or an inclusive range no wider than ${REVIEW_CHECKPOINT_MAX_LINE_RANGE} lines.` };
	if (!nonEmptyString(value.claim)) return { error: `${label}.claim must be a non-empty string.` };
	if (!nonEmptyString(value.evidence)) return { error: `${label}.evidence must be a non-empty string.` };
	return {
		finding: {
			severity: value.severity as ReviewCheckpointFinding["severity"],
			path: (value.path as string).trim(),
			line,
			claim: (value.claim as string).trim(),
			evidence: (value.evidence as string).trim(),
		},
	};
}

function isTruncationCause(value: unknown): value is ReviewCheckpointTruncationCause {
	return typeof value === "string" && TRUNCATION_CAUSES.has(value as ReviewCheckpointTruncationCause);
}

/** Normalizes `{ version: 1 }` and rejects any v1 policy mismatch or unknown field. */
export function validateCheckpointPolicy(value: unknown, label = "checkpointPolicy"): { policy?: ReviewCheckpointPolicy; error?: string } {
	if (!isRecord(value)) return { error: `${label} must be an object with version: 1.` };
	const unknownField = exactKeys(value, ["version", "requiredByTurn", "reserveTurns", "finalizeReserveMs", "collectionReserveMs"]);
	if (unknownField) return { error: `${label}.${unknownField} is not supported.` };
	if (value.version !== REVIEW_CHECKPOINT_POLICY_VERSION) return { error: `${label}.version must be ${REVIEW_CHECKPOINT_POLICY_VERSION}.` };
	const expected: Array<[keyof Omit<ReviewCheckpointPolicyInput, "version">, number]> = [
		["requiredByTurn", REVIEW_CHECKPOINT_REQUIRED_BY_TURN],
		["reserveTurns", REVIEW_CHECKPOINT_RESERVE_TURNS],
		["finalizeReserveMs", REVIEW_CHECKPOINT_FINALIZE_RESERVE_MS],
		["collectionReserveMs", REVIEW_CHECKPOINT_COLLECTION_RESERVE_MS],
	];
	for (const [field, required] of expected) {
		if (value[field] !== undefined && value[field] !== required) return { error: `${label}.${field} must be ${required} for version 1.` };
	}
	return { policy: { ...REVIEW_CHECKPOINT_POLICY_V1 } };
}

/** Validates one discriminated, incremental checkpoint submission. */
export function validateReviewCheckpointSubmission(value: unknown, label = "review_checkpoint.value"): { submission?: ReviewCheckpointSubmission; error?: string } {
	if (!isRecord(value)) return { error: `${label} must be an object.` };
	if (value.kind === "finding") {
		const unknownField = exactKeys(value, ["kind", "finding"]);
		if (unknownField) return { error: `${label}.${unknownField} is not supported.` };
		const finding = validateFinding(value.finding, `${label}.finding`);
		return finding.finding ? { submission: { kind: "finding", finding: finding.finding } } : { error: finding.error };
	}
	if (value.kind === "progress") {
		const unknownField = exactKeys(value, ["kind", "status"]);
		if (unknownField) return { error: `${label}.${unknownField} is not supported.` };
		if (value.status !== "no-confirmed-finding-yet") return { error: `${label}.status must be no-confirmed-finding-yet for progress.` };
		return { submission: { kind: "progress", status: "no-confirmed-finding-yet" } };
	}
	if (value.kind === "final") {
		if (value.status === "complete") {
			const unknownField = exactKeys(value, ["kind", "status"]);
			if (unknownField) return { error: `${label}.${unknownField} is not supported.` };
			return { submission: { kind: "final", status: "complete" } };
		}
		if (value.status === "truncated") {
			const unknownField = exactKeys(value, ["kind", "status", "cause"]);
			if (unknownField) return { error: `${label}.${unknownField} is not supported.` };
			if (!isTruncationCause(value.cause)) return { error: `${label}.cause must be a typed truncation cause.` };
			return { submission: { kind: "final", status: "truncated", cause: value.cause } };
		}
		return { error: `${label}.status must be complete or truncated for final.` };
	}
	return { error: `${label}.kind must be finding, progress, or final.` };
}

export function validateReviewCheckpointRecord(value: unknown, identity?: ReviewCheckpointIdentity): ReviewCheckpointRecord | undefined {
	if (!isRecord(value)) return undefined;
	const allowed = ["version", "runId", "childIndex", "agent", "sequence", "timestamp", "assistantTurn", "submission"];
	if (exactKeys(value, allowed)) return undefined;
	if (value.version !== REVIEW_CHECKPOINT_POLICY_VERSION
		|| !nonEmptyString(value.runId)
		|| !Number.isInteger(value.childIndex) || (value.childIndex as number) < 0
		|| !nonEmptyString(value.agent)
		|| !Number.isInteger(value.sequence) || (value.sequence as number) < 1
		|| !nonEmptyString(value.timestamp) || Number.isNaN(Date.parse(value.timestamp as string))
		|| !Number.isInteger(value.assistantTurn) || (value.assistantTurn as number) < 1) return undefined;
	const submission = validateReviewCheckpointSubmission(value.submission, "reviewCheckpoint.submission").submission;
	if (!submission) return undefined;
	const record: ReviewCheckpointRecord = {
		version: REVIEW_CHECKPOINT_POLICY_VERSION,
		runId: (value.runId as string).trim(),
		childIndex: value.childIndex as number,
		agent: (value.agent as string).trim(),
		sequence: value.sequence as number,
		timestamp: value.timestamp as string,
		assistantTurn: value.assistantTurn as number,
		submission,
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

/** Reads the current atomic snapshot and its predecessor so a torn newest write cannot erase acknowledged history. */
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

/** Persists a validated submission before returning its receipt. */
export function persistReviewCheckpoint(input: {
	storePath: string;
	identity: ReviewCheckpointIdentity;
	assistantTurn: number;
	submission: ReviewCheckpointSubmission;
	now?: () => Date;
}): ReviewCheckpointRecord {
	if (!input.storePath.trim()) throw new Error("review checkpoint store path is required.");
	if (!Number.isInteger(input.assistantTurn) || input.assistantTurn < 1) throw new Error("review checkpoint assistant turn is invalid.");
	const submission = validateReviewCheckpointSubmission(input.submission).submission;
	if (!submission) throw new Error("review checkpoint submission is invalid.");
	const primary = fs.existsSync(input.storePath) ? readStoreFile(input.storePath, input.identity) : { valid: true, records: [] };
	const previous = fs.existsSync(`${input.storePath}.previous`) ? readStoreFile(`${input.storePath}.previous`, input.identity) : { valid: true, records: [] };
	if (!primary.valid && !previous.valid) {
		throw new Error("review checkpoint store is unreadable; refusing to acknowledge a record that could erase prior evidence.");
	}
	const current = sortAndDeduplicate([...primary.records, ...previous.records]);
	if (current.some((record) => record.submission.kind === "final")) {
		throw new Error("review checkpoint is already final and cannot accept more submissions.");
	}
	if (current.length > 0) writePrivateAtomicJson(`${input.storePath}.previous`, recordStore(current));
	const record: ReviewCheckpointRecord = {
		version: REVIEW_CHECKPOINT_POLICY_VERSION,
		runId: input.identity.runId,
		childIndex: input.identity.childIndex,
		agent: input.identity.agent,
		sequence: (current.at(-1)?.sequence ?? 0) + 1,
		timestamp: (input.now ?? (() => new Date()))().toISOString(),
		assistantTurn: input.assistantTurn,
		submission,
	};
	writePrivateAtomicJson(input.storePath, recordStore([...current, record]));
	return record;
}

/** Recovers only acknowledged review-checkpoint receipts. It never reads assistant prose, thinking, or tool starts. */
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

/** Projects all durable findings and the final state without replacing older acknowledged evidence. */
export function projectCheckpointEvidence(records: ReviewCheckpointRecord[]): ReviewCheckpointEvidence {
	const recovered = sortAndDeduplicate(records);
	const findings = recovered.flatMap((record) => record.submission.kind === "finding" ? [record.submission.finding] : []);
	const final = recovered.at(-1)?.submission;
	if (final?.kind === "final" && final.status === "complete") {
		return { state: "complete", findings, records: recovered };
	}
	if (final?.kind === "final" && final.status === "truncated") {
		return { state: "truncated", findings, records: recovered, finalCause: final.cause };
	}
	return { state: recovered.length === 0 ? "missing" : "incomplete", findings, records: recovered };
}

export function formatReviewCheckpointFinding(finding: ReviewCheckpointFinding): string {
	const line = typeof finding.line === "number" ? String(finding.line) : `${finding.line.start}-${finding.line.end}`;
	return `${finding.severity}: ${finding.path}:${line} - ${finding.claim}\nEvidence: ${finding.evidence}`;
}

export function checkpointStorePath(root: string, runId: string, childIndex: number): string {
	return path.join(root, "review-checkpoints", `${runId}-${childIndex}.json`);
}

export function checkpointMachineArtifactPath(root: string, runId: string, childIndex: number): string {
	return path.join(root, "review-checkpoints", `${runId}-${childIndex}.final.json`);
}

function terminalTruncationCause(cause: TerminalCause): ReviewCheckpointTruncationCause {
	return cause === "completed" ? "process-failure" : cause;
}

/** Formats the machine-owned terminal artifact from recovered receipts only. */
export function formatReviewCheckpointMachineArtifact(input: {
	records: ReviewCheckpointRecord[];
	terminalCause: TerminalCause;
}): ReviewCheckpointMachineArtifact {
	const evidence = projectCheckpointEvidence(input.records);
	const terminalTruncated = input.terminalCause !== "completed";
	if (terminalTruncated || evidence.state === "truncated") {
		return {
			version: REVIEW_CHECKPOINT_POLICY_VERSION,
			source: "review-checkpoint",
			status: "truncated",
			checkpointState: evidence.state === "missing" ? "no-checkpoint" : evidence.state === "complete" ? "final-complete" : evidence.state === "truncated" ? "final-truncated" : "incomplete",
			cause: terminalTruncated ? terminalTruncationCause(input.terminalCause) : evidence.finalCause,
			marker: REVIEW_CHECKPOINT_BUDGET_TRUNCATED_MARKER,
			findings: evidence.findings,
			records: evidence.records,
		};
	}
	if (evidence.state === "complete") {
		return {
			version: REVIEW_CHECKPOINT_POLICY_VERSION,
			source: "review-checkpoint",
			status: "complete",
			checkpointState: "final-complete",
			findings: evidence.findings,
			records: evidence.records,
		};
	}
	return {
		version: REVIEW_CHECKPOINT_POLICY_VERSION,
		source: "review-checkpoint",
		status: "incomplete",
		checkpointState: evidence.state === "missing" ? "no-checkpoint" : "incomplete",
		findings: evidence.findings,
		records: evidence.records,
	};
}

/** Atomically writes the terminal machine artifact after the child can no longer mutate its checkpoint store. */
export function writeReviewCheckpointMachineArtifact(input: {
	artifactPath: string;
	records: ReviewCheckpointRecord[];
	terminalCause: TerminalCause;
}): ReviewCheckpointMachineArtifact {
	const artifact = formatReviewCheckpointMachineArtifact(input);
	writePrivateAtomicJson(input.artifactPath, artifact);
	return artifact;
}
