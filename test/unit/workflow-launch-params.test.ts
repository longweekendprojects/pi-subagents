import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySingleAgentLaunchDefaults, prepareWorkflowLaunchParams, sanitizeRunPathSegment } from "../../src/runs/foreground/subagent-executor.ts";

describe("workflow launch params", () => {
	it("keeps omitted workflow child async foreground", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Run" },
				"workflow-run",
				"run",
			),
			{
				agent: "worker",
				task: "Run",
				async: false,
				workflowParentRunId: "workflow-run",
				workflowKey: "run",
			},
		);
	});

	it("reserves collection time only for checkpoint-enabled workflow children", () => {
		const parentDeadlineAt = Date.now() + 180_000;
		const checkpointDefaults = { checkpointPolicy: { version: 1 as const } };
		const prepareCheckpoint = (child: Record<string, unknown>, key: string) => prepareWorkflowLaunchParams(checkpointDefaults, child, "workflow-run", key, { parentDeadlineAt });
		const agentDefault = applySingleAgentLaunchDefaults(
			prepareCheckpoint({ agent: "worker", task: "Run" }, "agent-default"),
			[{ name: "worker", defaultTimeoutMs: 500_000 }] as never,
		);
		const checkpointCases = [
			{ name: "explicit timeout", params: prepareCheckpoint({ agent: "worker", task: "Run", timeoutMs: 500_000 }, "timeout") },
			{ name: "explicit alias", params: prepareCheckpoint({ agent: "worker", task: "Run", maxRuntimeMs: 500_000 }, "alias") },
			{ name: "workflow default", params: prepareCheckpoint({ agent: "worker", task: "Run" }, "default") },
			{ name: "agent default", params: agentDefault.params },
		];
		for (const testCase of checkpointCases) {
			assert.ok((testCase.params?.timeoutMs ?? 0) > 0, testCase.name);
			assert.ok((testCase.params?.timeoutMs ?? Number.MAX_SAFE_INTEGER) <= 120_000, testCase.name);
			assert.equal(testCase.params?.workflowParentDeadlineAt, parentDeadlineAt, testCase.name);
			assert.deepEqual(testCase.params?.checkpointPolicy, {
				version: 1,
				requiredByTurn: 3,
				reserveTurns: 1,
				finalizeReserveMs: 120000,
				collectionReserveMs: 60000,
			}, testCase.name);
		}
		assert.equal(agentDefault.error, undefined);

		const checkpointFree = prepareWorkflowLaunchParams({}, { agent: "worker", task: "Run", timeoutMs: 500_000 }, "workflow-run", "free", { parentDeadlineAt });
		assert.ok((checkpointFree.timeoutMs ?? 0) > 120_000, "checkpoint-free child keeps the parent deadline available");
		assert.doesNotThrow(() => prepareWorkflowLaunchParams({}, { agent: "worker", task: "Run" }, "workflow-run", "short-free", { parentDeadlineAt: Date.now() + 60_000 }));
		assert.throws(
			() => prepareWorkflowLaunchParams(checkpointDefaults, { agent: "worker", task: "Run" }, "workflow-run", "expired", { parentDeadlineAt: Date.now() + 60_000 }),
			/no positive child interval after the 60000ms collection reserve/,
		);
	});

	it("preserves explicit async workflow children", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Run", async: true },
				"workflow-run",
				"run",
			),
			{
				agent: "worker",
				task: "Run",
				async: true,
				workflowParentRunId: "workflow-run",
				workflowKey: "run",
			},
		);
	});

	it("keeps a bridge override scoped to the target workflow child", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Run", intercomBridge: { mode: "off" } },
				"workflow-run",
				"isolated",
			),
			{
				agent: "worker",
				task: "Run",
				intercomBridge: { mode: "off" },
				async: false,
				workflowParentRunId: "workflow-run",
				workflowKey: "isolated",
			},
		);
		assert.equal(prepareWorkflowLaunchParams({}, { agent: "worker", task: "Run" }, "workflow-run", "sibling").intercomBridge, undefined);
	});

	it("keeps managed worktree children on the single-run contract", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Implement", worktree: true, gate: "npm test" },
				"workflow-run",
				"gated",
			),
			{
				agent: "worker",
				task: "Implement",
				worktree: true,
				async: false,
				workflowParentRunId: "workflow-run",
				workflowKey: "gated",
				acceptance: { level: "verified", verify: [{ id: "gate", command: "npm test" }] },
			},
		);
	});

	it("preserves a bridge override for retained workflow children", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ resume: "retained-run", task: "Continue", intercomBridge: { mode: "off" } },
				"workflow-run",
				"continue",
			),
			{
				action: "resume",
				id: "retained-run",
				message: "Continue",
				workflowParentRunId: "workflow-run",
				workflowKey: "continue",
				intercomBridge: { mode: "off" },
			},
		);
	});

	it("preserves worktree isolation for retained workflow children", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ resume: "retained-run", task: "Continue", worktree: true },
				"workflow-run",
				"continue",
			),
			{
				action: "resume",
				id: "retained-run",
				message: "Continue",
				workflowParentRunId: "workflow-run",
				workflowKey: "continue",
				worktree: true,
			},
		);
	});

	it("rejects gate defaults on retained resume items", () => {
		assert.throws(
			() => prepareWorkflowLaunchParams(
				{ gate: "npm test" },
				{ resume: "retained-run", task: "Continue" },
				"workflow-run",
				"continue",
			),
			/gate is not supported with retained resume/,
		);
		assert.throws(
			() => prepareWorkflowLaunchParams(
				{},
				{ resume: "retained-run", task: "Continue", gate: "npm test" },
				"workflow-run",
				"continue",
			),
			/gate is not supported with retained resume/,
		);
	});

	it("preserves execution limits and fan-out identity when routing retained resume items", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{ turnBudget: { maxTurns: 8 }, toolBudget: { hard: 12, block: ["read"] } },
				{
					resume: " retained-run ",
					task: "Continue carefully",
					maxRuntimeMs: 5_000,
					turnBudget: { maxTurns: 3, graceTurns: 1 },
					toolBudget: { soft: 2, hard: 4, block: "*" },
				},
				"workflow-run",
				"continue",
				{ missionDetached: true, runFanoutBudget: { version: 1, rootRunId: "root-run", directory: "/tmp/fanout", limit: 64, parentPath: "parent" } },
			),
			{
				action: "resume",
				id: "retained-run",
				message: "Continue carefully",
				workflowParentRunId: "workflow-run",
				workflowKey: "continue",
				runFanoutBudget: { version: 1, rootRunId: "root-run", directory: "/tmp/fanout", limit: 64, parentPath: "parent/workflow[continue]" },
				mission: false,
				timeoutMs: 5_000,
				turnBudget: { maxTurns: 3, graceTurns: 1 },
				toolBudget: { soft: 2, hard: 4, block: "*" },
			},
		);
	});

	describe("sanitizeRunPathSegment", () => {
		it("replaces Windows-invalid characters and trims separators", () => {
			assert.equal(sanitizeRunPathSegment("call_VfdHQygxGeL1L49ez04A4tf7|WtnJ9gVpB/jdQGWbnKhfMgDqPGUGmNw"), "call_VfdHQygxGeL1L49ez04A4tf7_WtnJ9gVpB_jdQGWbnKhfMgDqPGUGmNw");
			assert.equal(sanitizeRunPathSegment(":::path//sub?*<file>|name:::"), "path_sub_file_name");
			assert.equal(sanitizeRunPathSegment("   ___invalid___   "), "invalid");
		});

		it("falls back to unknown for empty or all-invalid strings", () => {
			assert.equal(sanitizeRunPathSegment(""), "unknown");
			assert.equal(sanitizeRunPathSegment("   "), "unknown");
			assert.equal(sanitizeRunPathSegment("???///|||"), "unknown");
		});

		it("bounds oversized segments to the maximum byte length", () => {
			const longId = "a".repeat(200);
			const sanitized = sanitizeRunPathSegment(longId, 120);
			assert.equal(sanitized.length, 120);
			assert.equal(Buffer.byteLength(sanitized, "utf-8"), 120);
			assert.equal(sanitized, "a".repeat(120));
		});
	});
});
