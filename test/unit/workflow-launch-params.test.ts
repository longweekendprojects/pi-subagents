import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareWorkflowLaunchParams, sanitizeRunPathSegment } from "../../src/runs/foreground/subagent-executor.ts";

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

	it("clamps an omitted child timeout strictly inside the parent deadline", () => {
		const parentDeadlineAt = Date.now() + 60_000;
		const params = prepareWorkflowLaunchParams(
			{},
			{ agent: "worker", task: "Run" },
			"workflow-run",
			"run",
			{ parentDeadlineAt },
		);
		assert.equal(params.async, false);
		assert.ok((params.timeoutMs ?? 0) > 0);
		assert.ok((params.timeoutMs ?? Number.MAX_SAFE_INTEGER) < 60_000);
		assert.equal(params.workflowParentDeadlineAt, parentDeadlineAt);
	});

	it("clamps explicit child timeout aliases to the parent deadline", () => {
		const parentDeadlineAt = Date.now() + 60_000;
		const timeoutParams = prepareWorkflowLaunchParams(
			{},
			{ agent: "worker", task: "Run", timeoutMs: 90_000 },
			"workflow-run",
			"timeout",
			{ parentDeadlineAt },
		);
		assert.ok((timeoutParams.timeoutMs ?? Number.MAX_SAFE_INTEGER) < 60_000);
		const maxRuntimeParams = prepareWorkflowLaunchParams(
			{},
			{ agent: "worker", task: "Run", maxRuntimeMs: 90_000 },
			"workflow-run",
			"max-runtime",
			{ parentDeadlineAt },
		);
		assert.ok((maxRuntimeParams.timeoutMs ?? Number.MAX_SAFE_INTEGER) < 60_000);
		assert.equal(maxRuntimeParams.maxRuntimeMs, undefined);
	});

	it("propagates a checkpoint policy from workflow defaults to children", () => {
		const params = prepareWorkflowLaunchParams(
			{ checkpointPolicy: { version: 1 } },
			{ agent: "reviewer", task: "Review" },
			"workflow-run",
			"review",
		);
		assert.deepEqual(params.checkpointPolicy, { version: 1 });
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

	it("clamps retained workflow resumes to the parent deadline", () => {
		const parentDeadlineAt = Date.now() + 60_000;
		const params = prepareWorkflowLaunchParams(
			{},
			{ resume: "retained-run", task: "Continue" },
			"workflow-run",
			"continue",
			{ parentDeadlineAt },
		);
		assert.equal(params.action, "resume");
		assert.ok((params.timeoutMs ?? 0) > 0);
		assert.ok((params.timeoutMs ?? Number.MAX_SAFE_INTEGER) < 60_000);
		assert.equal(params.workflowParentDeadlineAt, parentDeadlineAt);
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
