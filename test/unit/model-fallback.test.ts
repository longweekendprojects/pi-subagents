import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildModelCandidates,
	isRetryableModelFailure,
	isStartupAuthUnavailableFailure,
	resolveModelCandidate,
	startupRetryDelayMs,
} from "../../src/runs/shared/model-fallback.ts";

describe("model fallback helpers", () => {
	const availableModels = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	];

	it("keeps explicit provider/model ids unchanged", () => {
		assert.equal(resolveModelCandidate("openai/gpt-5-mini", availableModels), "openai/gpt-5-mini");
	});

	it("resolves a bare id when there is exactly one registry match", () => {
		assert.equal(resolveModelCandidate("gpt-5-mini", availableModels), "openai/gpt-5-mini");
	});

	it("preserves thinking suffix when resolving a bare id", () => {
		assert.equal(resolveModelCandidate("gpt-5-mini:high", availableModels), "openai/gpt-5-mini:high");
	});

	it("leaves ambiguous bare ids untouched", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.equal(resolveModelCandidate("gpt-5-mini", ambiguous), "gpt-5-mini");
	});

	it("prefers the current provider when an ambiguous bare id exists there", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.equal(resolveModelCandidate("gpt-5-mini", ambiguous, "github-copilot"), "github-copilot/gpt-5-mini");
	});

	it("falls back to the unique registry match when the current provider does not offer the model", () => {
		assert.equal(resolveModelCandidate("claude-sonnet-4", availableModels, "github-copilot"), "anthropic/claude-sonnet-4");
	});

	it("builds a deduplicated ordered candidate list", () => {
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["openai/gpt-5-mini", "anthropic/claude-sonnet-4", "gpt-5-mini"], availableModels),
			["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("applies the current provider preference to fallback candidates too", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["gpt-5-mini", "anthropic/claude-sonnet-4"], ambiguous, "github-copilot"),
			["github-copilot/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("detects retryable provider/model failures", () => {
		assert.equal(isRetryableModelFailure("rate limit exceeded for provider"), true);
		assert.equal(isRetryableModelFailure("model unavailable"), true);
		assert.equal(isRetryableModelFailure("authentication failed"), true);
	});

	it("does not treat ordinary task/tool failures as retryable model failures", () => {
		assert.equal(isRetryableModelFailure("bash failed (exit 1): command not found"), false);
		assert.equal(isRetryableModelFailure("read failed (exit 1): no such file or directory"), false);
		assert.equal(isRetryableModelFailure(undefined), false);
	});

	const startupAuthMessages = [
		"No API key found",
		"No API key available",
		"No API key is available",
		"No API key configured",
		"No API key is configured",
		"No authentication token found",
		"No credential found",
		"No credentials found",
	];
	for (const error of startupAuthMessages) {
		it(`classifies ${JSON.stringify(error)} as a retryable startup-auth failure`, () => {
			assert.equal(isStartupAuthUnavailableFailure({
				exitCode: 1,
				error,
				sawAgentStart: false,
				sawMessageStart: false,
			}), true);
			assert.equal(isRetryableModelFailure(error), true);
		});
	}

	it("only retries startup-auth failures before agent or message startup", () => {
		for (const evidence of [
			{ exitCode: 0, sawAgentStart: false, sawMessageStart: false },
			{ exitCode: 1, sawAgentStart: true, sawMessageStart: false },
			{ exitCode: 1, sawAgentStart: false, sawMessageStart: true },
		]) {
			assert.equal(isStartupAuthUnavailableFailure({
				...evidence,
				error: "No credentials found",
			}), false);
		}
		assert.equal(isStartupAuthUnavailableFailure({
			exitCode: 1,
			error: "invalid API key",
			sawAgentStart: false,
			sawMessageStart: false,
		}), false);
	});

	it("uses capped exponential startup retry timing with deterministic jitter", () => {
		assert.equal(startupRetryDelayMs(0, () => 0), 100);
		assert.equal(startupRetryDelayMs(1, () => 0.5), 250);
		assert.equal(startupRetryDelayMs(20, () => 1), 1000);
	});
});
