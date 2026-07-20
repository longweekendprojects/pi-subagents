import type { ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type { Usage } from "../../shared/types.ts";

export type { AvailableModelInfo };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export interface StartupAttemptEvidence {
	exitCode?: number | null;
	error?: string;
	sawAgentStart: boolean;
	sawMessageStart: boolean;
}

export const MAX_STARTUP_AUTH_RETRIES = 2;
const STARTUP_RETRY_BASE_DELAY_MS = 100;
const STARTUP_RETRY_MAX_DELAY_MS = 1_000;
const STARTUP_RETRY_JITTER_MS = 100;

const STARTUP_AUTH_UNAVAILABLE_PATTERNS = [
	/no api key found/i,
	/no api key (?:is )?(?:available|configured)/i,
	/no authentication token found/i,
	/no credentials? found/i,
];

export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: model.substring(colonIdx),
	};
}

export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return model;
	if (!availableModels || availableModels.length === 0) return model;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = matches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return `${preferredMatch.fullId}${thinkingSuffix}`;
	}
	if (matches.length !== 1) return model;
	return `${matches[0]!.fullId}${thinkingSuffix}`;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const raw of [primaryModel, ...(fallbackModels ?? [])]) {
		if (!raw) continue;
		const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/rate\s*limit/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection refused/i,
	/fetch failed/i,
	/network error/i,
	/socket hang up/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
];

export function isRetryableModelFailure(error: string | undefined): boolean {
	if (!error) return false;
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

export function isStartupAuthUnavailableFailure(evidence: StartupAttemptEvidence): boolean {
	return evidence.exitCode !== undefined
		&& evidence.exitCode !== null
		&& evidence.exitCode !== 0
		&& !evidence.sawAgentStart
		&& !evidence.sawMessageStart
		&& Boolean(evidence.error)
		&& STARTUP_AUTH_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(evidence.error!));
}

export function startupRetryDelayMs(retryIndex: number, random: () => number = Math.random): number {
	const exponentialDelay = Math.min(STARTUP_RETRY_MAX_DELAY_MS, STARTUP_RETRY_BASE_DELAY_MS * 2 ** retryIndex);
	const jitter = Math.floor(Math.max(0, Math.min(1, random())) * (STARTUP_RETRY_JITTER_MS + 1));
	return Math.min(STARTUP_RETRY_MAX_DELAY_MS, exponentialDelay + jitter);
}

export function waitForStartupRetry(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function formatStartupRetryNote(attempt: ModelAttemptSummary, delayMs: number): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return `[startup retry] ${attempt.model} could not start: ${failure}. Retrying the same model in ${delayMs}ms.`;
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}
