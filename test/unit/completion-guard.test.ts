import test from "node:test";
import assert from "node:assert/strict";

import type { Message } from "@earendil-works/pi-ai";

import {
	agentCanEditFiles,
	evaluateCompletionMutationGuard,
	expectsImplementationMutation,
	hasMutationToolCall,
} from "../../src/runs/shared/completion-guard.ts";

function assistantToolCall(name: string, args: Record<string, unknown> = {}): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name, arguments: args }],
	} as unknown as Message;
}

function assistantText(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	} as unknown as Message;
}

test("implementation task with no mutation triggers the completion guard", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Implement the approved fix",
		messages: [assistantText("Plan: update the files...")],
	});

	assert.deepEqual(result, {
		expectedMutation: true,
		attemptedMutation: false,
		triggered: true,
	});
});

test("review-only, research, and framework output instructions do not expect mutation", () => {
	assert.equal(expectsImplementationMutation("worker", "Review only: return findings, do not edit"), false);
	assert.equal(expectsImplementationMutation("worker", "Do not edit files. Tell me how to fix the bug."), false);
	assert.equal(expectsImplementationMutation("worker", "Review the diff and suggest fixes only. Do not edit files."), false);
	assert.equal(expectsImplementationMutation("worker", "Implement this. Do not edit files outside this repo. Do not edit files."), false);
	assert.equal(expectsImplementationMutation("worker", "Investigate why this failed"), false);
	assert.equal(expectsImplementationMutation("researcher", "Research the API behavior"), false);
	assert.equal(expectsImplementationMutation("researcher", "Research this and patch the bug"), false);
	assert.equal(expectsImplementationMutation("reviewer", "Review this and fix any real issues"), false);
	assert.equal(expectsImplementationMutation("reviewer", "Review this and fix any real issues; regardless of findings, apply changes directly"), true);
	assert.equal(expectsImplementationMutation("worker", "[Write to: /tmp/result.md]\n\nSummarize findings"), false);
	assert.equal(expectsImplementationMutation("worker", "Write report"), false);
	assert.equal(expectsImplementationMutation("worker", "Create a report"), false);
	assert.equal(expectsImplementationMutation("worker", "Create a summary"), false);
	assert.equal(expectsImplementationMutation("worker", "Add a report"), false);
	assert.equal(expectsImplementationMutation("worker", "Update a summary"), false);
	assert.equal(expectsImplementationMutation("worker", "Write to {chain_dir}"), false);
	assert.equal(
		expectsImplementationMutation("worker", "Do async work\nUpdate progress at: /tmp/progress.md\nWrite your findings to: /tmp/out.md"),
		false,
	);
});

test("worker implementation verbs win over investigative wording", () => {
	assert.equal(expectsImplementationMutation("worker", "Investigate why the worker did not edit files and fix it"), true);
	assert.equal(expectsImplementationMutation("worker", "Research the current code path and patch the bug"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix the bug where no edits were made"), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the fix and return findings."), true);
});

test("worker edit intent covers common docs, config, and source tasks", () => {
	assert.equal(expectsImplementationMutation("worker", "Update README to mention the native tool"), true);
	assert.equal(expectsImplementationMutation("worker", "Remove share functionality and all Vercel references"), true);
	assert.equal(expectsImplementationMutation("worker", "Replace the registered command with a render tool"), true);
	assert.equal(expectsImplementationMutation("worker", "Create completion-guard.ts"), true);
	assert.equal(expectsImplementationMutation("worker", "Add tests for the completion guard"), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the approved fixes. Do not edit files outside this repo."), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the fix. Do not edit unrelated files."), true);
});

test("edit and write tool calls count as mutation attempts", () => {
	assert.equal(hasMutationToolCall([assistantToolCall("edit", { path: "a.ts" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("write", { path: "a.ts" })]), true);
});

test("obvious mutating bash commands count as mutation attempts", () => {
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "mkdir -p src && cat > src/file.ts <<'EOF'\nhi\nEOF" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "cat <<'EOF' > src/file.ts\nhi\nEOF" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "python3 -c \"from pathlib import Path; Path('x').write_text('hi')\"" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "node script.js > generated.txt" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "echo 'a > b'" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "node -e \"console.log(a > b)\"" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "python3 <<'PY'\nprint('inspect only')\nPY" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "echo 'rm file'" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "printf \"mkdir x\"" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "git apply patch.diff" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "patch -p0 < fix.patch" })]), true);
});

test("implementation task with mutation attempts does not trigger", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Fix the failing test",
		messages: [assistantToolCall("edit", { path: "test.ts" })],
	});

	assert.equal(result.triggered, false);
});

test("agentCanEditFiles gates on edit/write capability, not bash", () => {
	// Unrestricted agents inherit the full toolset and can edit.
	assert.equal(agentCanEditFiles(undefined), true);
	assert.equal(agentCanEditFiles([]), true);
	// Read-only reviewers/verifiers/oracle carry bash for inspection but cannot edit.
	assert.equal(agentCanEditFiles(["read", "grep", "find", "ls", "bash"]), false);
	assert.equal(agentCanEditFiles(["read", "bash"]), false);
	assert.equal(agentCanEditFiles(["read", "grep", "find", "ls", "bash", "subagent"]), false);
	// Agents that declare edit or write can edit.
	assert.equal(agentCanEditFiles(["read", "edit", "write", "bash"]), true);
	assert.equal(agentCanEditFiles(["WRITE"]), true);
});

test("read-only agents are exempt from the completion guard even for implementation-sounding tasks", () => {
	// Reproduces the reported false positive: oracle, review-verifier, and
	// wave-review-orchestrator are read-only (no edit/write tool) yet their
	// tasks describe implementation work they are reviewing.
	const oracle = evaluateCompletionMutationGuard({
		agent: "oracle",
		task: "Recommend how to fix the scheduler concurrency bug and apply the changes",
		messages: [assistantText("Recommendation: set _DEFAULT_MAX_CONCURRENCY = 1 ...")],
		tools: ["read", "grep", "find", "ls", "bash"],
	});
	assert.equal(oracle.expectedMutation, false);
	assert.equal(oracle.triggered, false);

	assert.equal(
		expectsImplementationMutation("review-verifier", "Verify the fix was implemented correctly", ["read", "bash"]),
		false,
	);
	assert.equal(
		expectsImplementationMutation("wave-review-orchestrator", "Review the wave and fix any real issues", ["read", "grep", "find", "ls", "bash", "subagent"]),
		false,
	);

	// A worker with unrestricted tools is still guarded.
	assert.equal(expectsImplementationMutation("worker", "Implement the approved fix", undefined), true);
});
