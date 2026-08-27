import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	REVIEW_CHECKPOINT_TOOL_NAME,
	persistReviewCheckpoint,
	persistReviewCheckpointGateState,
	projectCheckpointEvidence,
	readReviewCheckpointStoreState,
	validateReviewCheckpointSubmission,
	salvageReviewCheckpoints,
} from "../../src/runs/shared/review-checkpoint.ts";

describe("review checkpoints", () => {
	it("accepts provider terminal causes in truncated checkpoint submissions", () => {
		for (const cause of ["rate-limit", "provider-error"] as const) {
			assert.deepEqual(
				validateReviewCheckpointSubmission({ kind: "final", status: "truncated", cause }).submission,
				{ kind: "final", status: "truncated", cause },
			);
		}
	});

	it("recovers acknowledged legacy evidence when a newer generated snapshot lacks acknowledgement", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-checkpoint-store-"));
		try {
			const storePath = path.join(dir, "checkpoint.json");
			const identity = { runId: "run-1", agent: "reviewer", childIndex: 0 };
			persistReviewCheckpoint({
				storePath,
				identity,
				assistantTurn: 2,
				submission: {
					kind: "finding",
					finding: {
						severity: "blocker",
						path: "src/file.ts",
						line: { start: 12, end: 14 },
						claim: "The checkpoint can lose an acknowledged finding.",
						evidence: "The old snapshot is replaced before terminal collection.",
					},
				},
			});
			persistReviewCheckpoint({
				storePath,
				identity,
				assistantTurn: 3,
				submission: { kind: "progress", status: "no-confirmed-finding-yet" },
			});
			persistReviewCheckpoint({
				storePath,
				identity,
				assistantTurn: 3,
				submission: { kind: "final", status: "complete" },
			});
			const legacyPredecessor = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, unknown>;
			delete legacyPredecessor.generation;
			fs.writeFileSync(`${storePath}.previous`, JSON.stringify(legacyPredecessor), "utf-8");
			const unacknowledgedPrimary = {
				...JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, unknown>,
				generation: "newer-unacknowledged",
			};
			fs.writeFileSync(storePath, JSON.stringify(unacknowledgedPrimary), "utf-8");
			const transcriptPath = path.join(dir, "child.transcript.jsonl");
			fs.writeFileSync(transcriptPath, [
				JSON.stringify({ recordType: "message", role: "assistant", text: "blocker: prose must never become evidence" }),
				JSON.stringify({ recordType: "tool_start", toolName: REVIEW_CHECKPOINT_TOOL_NAME, argsPayload: JSON.stringify({ kind: "finding", finding: { severity: "blocker" } }) }),
				"{\"recordType\":",
			].join("\n"), "utf-8");

			const recovered = salvageReviewCheckpoints({ storePath, transcriptPath, identity });
			const evidence = projectCheckpointEvidence(recovered);
			assert.equal(evidence.state, "complete");
			assert.equal(evidence.findings.length, 1);
			assert.deepEqual(evidence.findings[0]?.line, { start: 12, end: 14 });
			assert.equal(JSON.stringify(evidence.findings).includes("prose must never"), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists the logical turn and finalization latch with the acknowledged final receipt", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-checkpoint-gate-state-"));
		try {
			const storePath = path.join(dir, "checkpoint.json");
			const identity = { runId: "run-state", agent: "reviewer", childIndex: 0 };
			persistReviewCheckpointGateState({ storePath, identity, assistantTurn: 3 });
			assert.deepEqual(readReviewCheckpointStoreState(storePath, identity), {
				records: [],
				assistantTurn: 3,
				checkpointSatisfied: false,
				permanentFinalization: false,
			});
			persistReviewCheckpointGateState({
				storePath,
				identity,
				assistantTurn: 3,
				permanentFinalization: true,
				finalizationAbortDelivered: true,
			});
			persistReviewCheckpointGateState({
				storePath,
				identity,
				assistantTurn: 3,
				finalizationSteerDelivered: true,
			});
			const delivered = readReviewCheckpointStoreState(storePath, identity);
			assert.equal(delivered.finalizationAbortDelivered, true);
			assert.equal(delivered.finalizationSteerDelivered, true);
			persistReviewCheckpoint({
				storePath,
				identity,
				assistantTurn: 3,
				submission: { kind: "final", status: "complete" },
			});
			const recovered = readReviewCheckpointStoreState(storePath, identity);
			assert.equal(recovered.assistantTurn, 3);
			assert.equal(recovered.checkpointSatisfied, true);
			assert.equal(recovered.permanentFinalization, true);
			assert.equal(recovered.finalizationAbortDelivered, true);
			assert.equal(recovered.finalizationSteerDelivered, true);
			assert.equal(recovered.records.at(-1)?.submission.kind, "final");
			assert.throws(() => persistReviewCheckpoint({
				storePath,
				identity,
				assistantTurn: 4,
				submission: { kind: "progress", status: "no-confirmed-finding-yet" },
			}), /already final/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
