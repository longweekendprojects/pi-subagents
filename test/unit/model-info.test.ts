import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findModelInfo, getSupportedThinkingLevels, type ModelInfo } from "../../src/shared/model-info.ts";

describe("model info helpers", () => {
	const ambiguousModels: ModelInfo[] = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", reasoning: true, thinkingLevelMap: { high: "high" } },
		{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini", reasoning: true, thinkingLevelMap: { off: null, high: "high", xhigh: "xhigh" } },
	];

	it("does not choose arbitrary metadata for ambiguous bare model ids", () => {
		assert.equal(findModelInfo("gpt-5-mini", ambiguousModels), undefined);
	});

	it("uses the preferred provider for ambiguous bare model metadata", () => {
		assert.equal(findModelInfo("gpt-5-mini", ambiguousModels, "github-copilot")?.fullId, "github-copilot/gpt-5-mini");
	});

	it("matches provider-qualified model metadata before bare ids", () => {
		assert.equal(findModelInfo("openai/gpt-5-mini:high", ambiguousModels, "github-copilot")?.fullId, "openai/gpt-5-mini");
	});

	it("keeps legacy levels but withholds max when model metadata is unavailable", () => {
		assert.deepEqual(getSupportedThinkingLevels(undefined), ["off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("keeps legacy levels but withholds max for reasoning models without level metadata", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5", reasoning: true }),
			["off", "minimal", "low", "medium", "high", "xhigh"],
		);
	});

	it("requires independent non-null mappings for xhigh and max", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({
				provider: "deepseek",
				id: "xhigh-only",
				fullId: "deepseek/xhigh-only",
				reasoning: true,
				thinkingLevelMap: { off: null, xhigh: "xhigh" },
			}),
			["minimal", "low", "medium", "high", "xhigh"],
		);
		assert.deepEqual(
			getSupportedThinkingLevels({
				provider: "deepseek",
				id: "max-only",
				fullId: "deepseek/max-only",
				reasoning: true,
				thinkingLevelMap: { high: null, xhigh: null, max: "max" },
			}),
			["off", "minimal", "low", "medium", "max"],
		);
		assert.deepEqual(
			getSupportedThinkingLevels({
				provider: "always-thinking",
				id: "model",
				fullId: "always-thinking/model",
				reasoning: false,
				thinkingLevelMap: { max: "max" },
			}),
			["off"],
		);
	});
});
