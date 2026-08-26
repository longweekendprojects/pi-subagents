import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	REVIEW_CHECKPOINT_POLICY_ENV,
	REVIEW_CHECKPOINT_STORE_ENV,
	REVIEW_CHECKPOINT_TOOL_NAME,
	persistReviewCheckpoint,
	salvageReviewCheckpoints,
} from "../../src/runs/shared/review-checkpoint.ts";
import registerSubagentPromptRuntime from "../../src/runs/shared/subagent-prompt-runtime.ts";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV } from "../../src/runs/shared/structured-output.ts";

const REVIEW_ENV = [
	REVIEW_CHECKPOINT_POLICY_ENV,
	REVIEW_CHECKPOINT_STORE_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	STRUCTURED_OUTPUT_CAPTURE_ENV,
] as const;
const savedEnv = Object.fromEntries(REVIEW_ENV.map((name) => [name, process.env[name]]));

afterEach(() => {
	for (const name of REVIEW_ENV) {
		const value = savedEnv[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

function configureRuntime(storePath: string): void {
	process.env[REVIEW_CHECKPOINT_POLICY_ENV] = JSON.stringify({ version: 1 });
	process.env[REVIEW_CHECKPOINT_STORE_ENV] = storePath;
	process.env[SUBAGENT_RUN_ID_ENV] = "run-1";
	process.env[SUBAGENT_CHILD_AGENT_ENV] = "reviewer";
	process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
}

describe("review checkpoints", () => {
	it("gates every turn-three tool call and acknowledges only after a clean checkpoint persists", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-checkpoint-gate-"));
		try {
			configureRuntime(path.join(dir, "checkpoint.json"));
			process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = path.join(dir, "structured.json");
			const handlers = new Map<string, Array<(event: any) => unknown>>();
			let checkpointTool: { execute: (_id: string, params: { value: unknown }) => Promise<unknown> } | undefined;
			registerSubagentPromptRuntime({
				on(event: string, handler: (event: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
				registerTool(tool: { name: string; execute: (_id: string, params: { value: unknown }) => Promise<unknown> }) {
					if (tool.name === REVIEW_CHECKPOINT_TOOL_NAME) checkpointTool = tool;
				},
			} as never);

			for (let turn = 0; turn < 3; turn++) {
				for (const handler of handlers.get("message_end") ?? []) handler({ message: { role: "assistant" } });
			}
			const decisions = async (toolName: string) => Promise.all((handlers.get("tool_call") ?? []).map((handler) => handler({ toolName })));
			for (const toolName of ["bash", "mcp_remote", "subagent"]) {
				assert.ok((await decisions(toolName)).some((decision) => (decision as { block?: boolean } | undefined)?.block === true), `${toolName} must be blocked in the finalization reserve`);
			}
			assert.ok(!(await decisions("structured_output")).some((decision) => (decision as { block?: boolean } | undefined)?.block === true));
			assert.ok(checkpointTool, "review_checkpoint tool was not registered");
			const receipt = await checkpointTool.execute("checkpoint-1", { value: { reviewFindings: [], residualRisks: [] } }) as { details?: { reviewCheckpoint?: unknown } };
			assert.ok(receipt.details?.reviewCheckpoint);
			assert.deepEqual(salvageReviewCheckpoints({
				storePath: path.join(dir, "checkpoint.json"),
				identity: { runId: "run-1", agent: "reviewer", childIndex: 0 },
			}).map((record) => record.reviewFindings), [[]]);
			assert.ok(!(await decisions("bash")).some((decision) => (decision as { block?: boolean } | undefined)?.block === true));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the finalization reserve active when persistence fails", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-checkpoint-fail-"));
		try {
			const blockedParent = path.join(dir, "not-a-directory");
			fs.writeFileSync(blockedParent, "file", "utf-8");
			configureRuntime(path.join(blockedParent, "checkpoint.json"));
			const handlers = new Map<string, Array<(event: any) => unknown>>();
			let checkpointTool: { execute: (_id: string, params: { value: unknown }) => Promise<unknown> } | undefined;
			registerSubagentPromptRuntime({
				on(event: string, handler: (event: any) => unknown) {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
				registerTool(tool: { name: string; execute: (_id: string, params: { value: unknown }) => Promise<unknown> }) {
					if (tool.name === REVIEW_CHECKPOINT_TOOL_NAME) checkpointTool = tool;
				},
			} as never);
			for (let turn = 0; turn < 3; turn++) {
				for (const handler of handlers.get("message_end") ?? []) handler({ message: { role: "assistant" } });
			}
			assert.ok(checkpointTool);
			await assert.rejects(checkpointTool.execute("checkpoint-1", { value: { reviewFindings: ["blocker: persistence"], residualRisks: [] } }), /persistence failed/);
			const decisions = await Promise.all((handlers.get("tool_call") ?? []).map((handler) => handler({ toolName: "bash" })));
			assert.ok(decisions.some((decision) => (decision as { block?: boolean } | undefined)?.block === true));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("salvages the same validated receipt for foreground and async terminal paths while ignoring a torn tail", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-checkpoint-salvage-"));
		try {
			const storePath = path.join(dir, "checkpoint.json");
			const identity = { runId: "run-1", agent: "reviewer", childIndex: 0 };
			const record = persistReviewCheckpoint({
				storePath,
				identity,
				assistantTurn: 3,
				submission: { reviewFindings: ["blocker: src/file.ts:12"], residualRisks: ["manual verification"] },
			});
			fs.copyFileSync(storePath, `${storePath}.previous`);
			fs.writeFileSync(storePath, "{\"version\":1,\"records\":[", "utf-8");
			const transcriptPath = path.join(dir, "child.transcript.jsonl");
			fs.writeFileSync(transcriptPath, [
				JSON.stringify({ recordType: "message", role: "assistant", text: "I found no blockers." }),
				JSON.stringify({ recordType: "message", role: "toolResult", toolName: REVIEW_CHECKPOINT_TOOL_NAME, isError: false, detailsPayload: JSON.stringify({ reviewCheckpoint: record }) }),
				"{\"recordType\":",
			].join("\n"), "utf-8");
			const foreground = salvageReviewCheckpoints({ storePath, transcriptPath, identity });
			const async = salvageReviewCheckpoints({ storePath, transcriptPath, identity });
			assert.deepEqual(foreground, async);
			assert.equal(foreground.length, 1);
			assert.deepEqual(foreground[0]?.reviewFindings, ["blocker: src/file.ts:12"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
