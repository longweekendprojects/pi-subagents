import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerNativeSupervisorClient } from "../../intercom/native-supervisor-channel.ts";
import { shouldUseNativeFsWatch } from "../../shared/watch-strategy.ts";
import { decodePermissionRules, permissionDecision, PERMISSION_AUDIT_PATH_ENV, PERMISSION_POLICY_ENV } from "./permissions.ts";
import { consumeSteerRequestsFromDir, MAX_STEER_QUEUE_SIZE, steerAckPathFromDir, writeSteerAckAt, writeSteerCapabilityAt, writeSteerRequestToDir, type SteerDeliveryStatus, type SteerRequest } from "../background/control-channel.ts";
import { SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_CHILD_INDEX_ENV, SUBAGENT_FANOUT_CHILD_ENV, SUBAGENT_RUN_ID_ENV, SUBAGENT_STEER_ACK_DIR_ENV, SUBAGENT_STEER_CAPABILITY_ENV, SUBAGENT_STEER_INBOX_ENV } from "./pi-args.ts";
import { RUNTIME_EXTENSION_ACK_EVENT, RUNTIME_EXTENSION_ACK_PATH_ENV, isRuntimeAcknowledgedExtensionId, writeRuntimeAcknowledgedExtensions } from "./runtime-acknowledged-extensions.ts";
import { createStructuredOutputToolParameters, STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV, validateStructuredOutputValue } from "./structured-output.ts";
import {
	REVIEW_CHECKPOINT_ATTEMPT_ENV,
	REVIEW_CHECKPOINT_FINALIZE_AT_ENV,
	REVIEW_CHECKPOINT_PARAMETERS_SCHEMA,
	REVIEW_CHECKPOINT_POLICY_ENV,
	REVIEW_CHECKPOINT_STORE_ENV,
	REVIEW_CHECKPOINT_TOOL_NAME,
	persistReviewCheckpoint,
	persistReviewCheckpointGateState,
	readReviewCheckpointStoreState,
	validateCheckpointPolicy,
	validateReviewCheckpointSubmission,
} from "./review-checkpoint.ts";
import {
	CHILD_TOOL_DIAGNOSTIC_PATH_ENV,
	MCP_DIRECT_CHILD_TOOLS_ENV,
	REQUIRED_CHILD_TOOLS_ENV,
	writeChildToolDiagnostic,
	type ChildToolDiagnostic,
} from "./tool-availability.ts";
import { TOOL_BUDGET_ENV, TOOL_BUDGET_ZERO_AUTH_ENV, decodeToolBudgetEnv, shouldBlockToolForBudget, toolBudgetBlockedMessage, toolBudgetSoftNudge } from "./tool-budget.ts";
import type { JsonSchemaObject, ResolvedToolBudget, SubagentState } from "../../shared/types.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { resolveWatchPath } from "../../shared/utils.ts";
import { registerChildWatchdog } from "../../watchdog/register-child.ts";
import { CHILD_WATCHDOG_CONFIG_ENV } from "../../watchdog/child-status.ts";
import { requestWatchdogPermission, type WatchdogPermissionRequest, type WatchdogPermissionResult } from "../../watchdog/permission-arbiter.ts";
import { SUBAGENT_WATCHDOG_WARNING_TYPE } from "../../watchdog/types.ts";
import { resolveWaitToolConfig } from "../background/wait-config.ts";
import { registerWaitTool } from "../background/wait-tool.ts";
import { drainOutstandingWork } from "../background/auto-drain.ts";

const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";
export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";
const STEERING_LEGACY_SETTLE_FALLBACK_MS = 1000;
const STEERING_SAFETY_POLL_INTERVAL_MS = 5000;

const STRUCTURED_OUTPUT_INSTRUCTIONS = [
	"This subagent step has a strict structured output contract.",
	"Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
	"Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.",
].join("\n");

const REVIEW_CHECKPOINT_INSTRUCTIONS = [
	"This subagent step requires durable, incremental review checkpoints before assistant turn 3.",
	"Call `review_checkpoint` once for each complete structured finding, use progress/no-confirmed-finding-yet only when no finding is confirmed, and finish with final/complete or final/truncated plus its typed cause.",
	"A finding needs severity, path, one line or a bounded line range, claim, and evidence. A checkpoint is acknowledged only after durable persistence. Do not rely on prose or a tool start as evidence.",
].join("\n");

export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent, not the parent orchestrator.",
	"The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
	"Ignore prior parent-only orchestration instructions in inherited conversation history.",
	"Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
	"If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

export const CHILD_FANOUT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent with explicit fanout responsibility for this assigned task.",
	"The parent session owns final orchestration, acceptance, and follow-up implementation launches.",
	"You may use the `subagent` tool only for the fanout work explicitly requested in this task.",
	"Do not broaden yourself into general parent orchestration. Do not launch follow-up workers unless the task explicitly asks for that.",
	"The maxSubagentDepth cap still applies and may block further fanout.",
	"If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

const PARENT_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
	"subagent-orchestration-instructions",
	"subagent-slash-result",
	"subagent-slash-text-result",
	"subagent-notify",
	"subagent_control_notice",
	"subagent-control",
	"subagent-control-notice",
]);
const SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN = /<name>\s*pi-subagents\s*<\/name>/;
const PROJECT_CONTEXT_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_HEADER = "\nCurrent date:";

function readBooleanEnv(name: string): boolean | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	return value !== "0";
}

function readRequiredChildTools(): string[] | undefined {
	const encoded = process.env[REQUIRED_CHILD_TOOLS_ENV]?.trim();
	if (!encoded) return undefined;
	const required = JSON.parse(encoded) as unknown;
	if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !name)) {
		throw new Error(`Invalid ${REQUIRED_CHILD_TOOLS_ENV} payload.`);
	}
	return required;
}

function readMcpDirectChildTools(): string[] | undefined {
	const encoded = process.env[MCP_DIRECT_CHILD_TOOLS_ENV]?.trim();
	if (!encoded) return undefined;
	try {
		const tools = JSON.parse(encoded) as unknown;
		if (!Array.isArray(tools) || tools.some((name) => typeof name !== "string" || !name)) return undefined;
		return tools;
	} catch {
		return undefined;
	}
}

function refreshChildToolDiagnostic(pi: ExtensionAPI): ChildToolDiagnostic | undefined {
	const filePath = process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV]?.trim();
	const required = readRequiredChildTools();
	if (!filePath || !required) return undefined;
	const available = pi.getAllTools().map((tool) => tool.name);
	return writeChildToolDiagnostic(filePath, required, available, process.env[SUBAGENT_CHILD_AGENT_ENV]?.trim(), readMcpDirectChildTools());
}

function registerRuntimeExtensionAcknowledgements(pi: ExtensionAPI): void {
	const outputPath = process.env[RUNTIME_EXTENSION_ACK_PATH_ENV]?.trim();
	if (!outputPath) return;
	const ids: string[] = [];
	let finalized = false;
	const acknowledge = (payload: unknown): undefined => {
		if (finalized || !payload || typeof payload !== "object") return undefined;
		const id = (payload as { id?: unknown }).id;
		if (isRuntimeAcknowledgedExtensionId(id)) ids.push(id);
		return undefined;
	};
	const finalize = (): undefined => {
		if (finalized) return undefined;
		finalized = true;
		writeRuntimeAcknowledgedExtensions(outputPath, ids);
		return undefined;
	};
	try {
		const events = (pi as { events?: { on?: (event: string, handler: (payload: unknown) => unknown) => unknown } }).events;
		events?.on?.(RUNTIME_EXTENSION_ACK_EVENT, acknowledge);
		const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => void;
		onRuntimeEvent("agent_end", finalize);
		onRuntimeEvent("session_shutdown", finalize);
	} catch {
		// Acknowledgement collection is optional observability and must not affect child execution.
	}
}

function findSectionEnd(prompt: string, startIndex: number, nextHeaders: string[]): number {
	let endIndex = prompt.length;
	for (const header of nextHeaders) {
		const index = prompt.indexOf(header, startIndex);
		if (index !== -1 && index < endIndex) {
			endIndex = index;
		}
	}
	return endIndex;
}

export function stripProjectContext(prompt: string): string {
	const startIndex = prompt.indexOf(PROJECT_CONTEXT_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + PROJECT_CONTEXT_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripInheritedSkills(prompt: string): string {
	const startIndex = prompt.indexOf(SKILLS_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripSubagentOrchestrationSkill(prompt: string): string {
	return prompt
		.replace(/\n{0,2}<skill\s+name=["']pi-subagents["'][^>]*>[\s\S]*?<\/skill>\n{0,2}/g, "\n\n")
		.replace(/[ \t]*<skill>\s*[\s\S]*?<\/skill>\s*/g, (block) => SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN.test(block) ? "" : block);
}

function stripChildBoundaryInstructions(prompt: string): string {
	let rewritten = prompt;
	for (const boundary of [CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, CHILD_FANOUT_BOUNDARY_INSTRUCTIONS]) {
		rewritten = rewritten.split(boundary).join("");
	}
	return rewritten.replace(/^(?:[ \t]*\r?\n)+/, "");
}

export function rewriteSubagentPrompt(
	prompt: string,
	options: { inheritProjectContext: boolean; inheritSkills: boolean; fanoutChild?: boolean },
): string {
	let rewritten = prompt;
	if (!options.inheritProjectContext) {
		rewritten = stripProjectContext(rewritten);
	}
	if (!options.inheritSkills) {
		rewritten = stripInheritedSkills(rewritten);
	}
	rewritten = stripSubagentOrchestrationSkill(rewritten);
	rewritten = stripChildBoundaryInstructions(rewritten);
	const boundary = options.fanoutChild ? CHILD_FANOUT_BOUNDARY_INSTRUCTIONS : CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS;
	const structured = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] ? `\n\n${STRUCTURED_OUTPUT_INSTRUCTIONS}` : "";
	const checkpoint = process.env[REVIEW_CHECKPOINT_POLICY_ENV] ? `\n\n${REVIEW_CHECKPOINT_INSTRUCTIONS}` : "";
	return `${boundary}${structured}${checkpoint}\n\n${rewritten}`;
}

function isParentOnlySubagentMessage(message: unknown): boolean {
	const m = message as { role?: string; customType?: string };
	if (m?.role !== "custom" || typeof m.customType !== "string") return false;
	if (m.customType === SUBAGENT_WATCHDOG_WARNING_TYPE) return true;
	return PARENT_ONLY_CUSTOM_MESSAGE_TYPES.has(m.customType);
}

function isSubagentToolResultMessage(message: unknown): boolean {
	const m = message as { role?: string; toolName?: string };
	return m?.role === "toolResult" && m.toolName === "subagent";
}

function isSubagentToolCallBlock(block: unknown): boolean {
	const b = block as { type?: string; name?: string };
	return b?.type === "toolCall" && b.name === "subagent";
}

const PORTABLE_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_PORTABLE_TOOL_ID_LENGTH = 64;
const COMPOSITE_TOOL_ID_APIS = new Set([
	"azure-openai-responses",
	"openai-completions",
	"openai-responses",
]);

function portableToolId(id: string): string {
	if (PORTABLE_TOOL_ID_PATTERN.test(id) && id.length <= MAX_PORTABLE_TOOL_ID_LENGTH) return id;
	const encoded = `tool_${Buffer.from(id).toString("base64url") || "empty"}`;
	if (encoded.length <= MAX_PORTABLE_TOOL_ID_LENGTH) return encoded;
	return `tool_${createHash("sha256").update(id).digest("base64url")}`;
}

function sanitizeToolHistoryMessage(message: unknown): unknown {
	const m = message as { role?: string; content?: unknown; toolCallId?: unknown };
	if (m?.role === "toolResult" && typeof m.toolCallId === "string") {
		const toolCallId = portableToolId(m.toolCallId);
		return toolCallId === m.toolCallId ? message : { ...m, toolCallId };
	}
	if (m?.role !== "assistant" || !Array.isArray(m.content)) return message;
	let changed = false;
	const content = m.content.map((block) => {
		const b = block as { type?: string; id?: unknown };
		if (b?.type !== "toolCall" || typeof b.id !== "string") return block;
		const id = portableToolId(b.id);
		if (id === b.id) return block;
		changed = true;
		return { ...b, id };
	});
	return changed ? { ...m, content } : message;
}

function stripAssistantSubagentToolCallBlocks(message: unknown): unknown | undefined {
	const m = message as { role?: string; content?: unknown };
	if (m?.role !== "assistant" || !Array.isArray(m.content)) return message;
	const filteredContent = m.content.filter((block) => !isSubagentToolCallBlock(block));
	if (filteredContent.length === m.content.length) return message;
	if (filteredContent.length === 0) return undefined;
	return { ...m, content: filteredContent };
}

export function stripParentOnlySubagentMessages(messages: unknown[], options: { sanitizeToolIds?: boolean } = {}): unknown[] {
	const preserveCurrentFanoutToolHistory = process.env[SUBAGENT_FANOUT_CHILD_ENV] === "1";
	const sanitizeToolIds = options.sanitizeToolIds ?? true;
	let changed = false;
	const filtered: unknown[] = [];
	for (const message of messages) {
		if (isParentOnlySubagentMessage(message) || (!preserveCurrentFanoutToolHistory && isSubagentToolResultMessage(message))) {
			changed = true;
			continue;
		}
		const stripped = preserveCurrentFanoutToolHistory ? message : stripAssistantSubagentToolCallBlocks(message);
		if (stripped === undefined) {
			changed = true;
			continue;
		}
		const sanitized = sanitizeToolIds ? sanitizeToolHistoryMessage(stripped) : stripped;
		if (stripped !== message || sanitized !== stripped) changed = true;
		filtered.push(sanitized);
	}
	return changed ? filtered : messages;
}

export function formatSteerMessage(request: SteerRequest): string {
	return [
		request.mode === "follow_up" ? "Queued follow-up from the parent orchestrator:" : "Mid-run steering from the parent orchestrator:",
		"",
		request.message,
		"",
		"Incorporate this guidance at the next safe point. Do not restart the task unless the guidance explicitly asks you to.",
	].join("\n");
}

export function registerPermissionGate(
	pi: ExtensionAPI,
	requestPermission: (request: WatchdogPermissionRequest) => Promise<WatchdogPermissionResult> = requestWatchdogPermission,
): void {
	const rules = decodePermissionRules(process.env[PERMISSION_POLICY_ENV]);
	if (!rules) return;
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: { toolName?: string; input?: unknown }, ctx: ExtensionContext) => unknown) => void;
	onRuntimeEvent("tool_call", async (event, ctx) => {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const decision = permissionDecision(rules, toolName);
		if (decision === "allow") return undefined;
		if (decision === "deny") return { block: true, reason: `Blocked by pi-subagents permission rule: '${toolName}' is denied.` };
		const result = await requestPermission({
			ctx,
			toolName,
			args: event.input ?? {},
			rawWatchdogConfig: process.env[CHILD_WATCHDOG_CONFIG_ENV],
			auditPath: process.env[PERMISSION_AUDIT_PATH_ENV],
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
		if (result.approved) return undefined;
		return { block: true, reason: `Blocked by pi-subagents permission rule: ${result.reason}` };
	});
}

function registerReviewCheckpoint(pi: ExtensionAPI): void {
	const rawPolicy = process.env[REVIEW_CHECKPOINT_POLICY_ENV]?.trim();
	if (!rawPolicy) return;
	let policy: ReturnType<typeof validateCheckpointPolicy>["policy"];
	try {
		policy = validateCheckpointPolicy(JSON.parse(rawPolicy)).policy;
	} catch {
		policy = undefined;
	}
	const storePath = process.env[REVIEW_CHECKPOINT_STORE_ENV]?.trim();
	const runId = process.env[SUBAGENT_RUN_ID_ENV]?.trim();
	const agent = process.env[SUBAGENT_CHILD_AGENT_ENV]?.trim();
	const childIndex = Number(process.env[SUBAGENT_CHILD_INDEX_ENV]);
	const rawFinalizeAt = Number(process.env[REVIEW_CHECKPOINT_FINALIZE_AT_ENV]);
	const finalizeAt = Number.isFinite(rawFinalizeAt) && rawFinalizeAt > 0 ? rawFinalizeAt : undefined;
	const rawAttempt = process.env[REVIEW_CHECKPOINT_ATTEMPT_ENV];
	const attempt = rawAttempt === undefined ? 1 : Number(rawAttempt);
	if (!policy || !storePath || !runId || !agent || !Number.isInteger(childIndex) || childIndex < 0 || !Number.isInteger(attempt) || attempt < 1) {
		throw new Error("Invalid review checkpoint runtime configuration.");
	}
	const identity = { runId, agent, childIndex, attempt };
	const recovered = readReviewCheckpointStoreState(storePath, identity);
	let assistantTurn = recovered.assistantTurn;
	let checkpointCompleted = recovered.checkpointSatisfied;
	let permanentFinalization = recovered.permanentFinalization;
	let durableFinalCheckpoint = recovered.records.some((record) => record.submission.kind === "final");
	let finalizationAbortDelivered = recovered.finalizationAbortDelivered === true;
	let finalizationSteerDelivered = recovered.finalizationSteerDelivered === true;
	let gateStatePersistenceError: string | undefined;
	let finalizationAbortError: string | undefined;
	let finalizationSteerError: string | undefined;
	let investigativeCallAdmittedThisTurn = false;
	let checkpointBoundaryThisTurn = false;
	let pendingFinalizationThisTurn = false;
	let activeLifecycle = false;
	let activeContext: ExtensionContext | undefined;
	let finalizationTimer: ReturnType<typeof setTimeout> | undefined;
	let sessionShutdown = false;
	const FINALIZATION_RETRY_MS = 250;
	const structuredOutputActive = Boolean(process.env[STRUCTURED_OUTPUT_CAPTURE_ENV]);
	const sendUserMessage = (pi as { sendUserMessage?: (content: string, options: { deliverAs: "steer" }) => unknown }).sendUserMessage;
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: { toolName?: unknown; input?: unknown }, ctx?: ExtensionContext) => unknown) => void;
	const finalizationIsDue = (): boolean => assistantTurn >= policy.requiredByTurn + policy.reserveTurns
		|| (finalizeAt !== undefined && Date.now() >= finalizeAt);
	const persistGateState = (update: {
		permanentFinalization?: boolean;
		finalizationAbortDelivered?: boolean;
		finalizationSteerDelivered?: boolean;
	} = {}): boolean => {
		try {
			const state = persistReviewCheckpointGateState({
				storePath,
				identity,
				assistantTurn,
				checkpointSatisfied: checkpointCompleted,
				permanentFinalization: permanentFinalization || update.permanentFinalization === true,
				finalizationAbortDelivered: finalizationAbortDelivered || update.finalizationAbortDelivered === true,
				finalizationSteerDelivered: finalizationSteerDelivered || update.finalizationSteerDelivered === true,
			});
			assistantTurn = state.assistantTurn;
			checkpointCompleted = state.checkpointSatisfied;
			permanentFinalization = state.permanentFinalization;
			finalizationAbortDelivered = state.finalizationAbortDelivered === true;
			finalizationSteerDelivered = state.finalizationSteerDelivered === true;
			gateStatePersistenceError = undefined;
			return true;
		} catch (error) {
			const message = `Review checkpoint gate state persistence failed: ${error instanceof Error ? error.message : String(error)}`;
			if (gateStatePersistenceError !== message) console.error(message);
			gateStatePersistenceError = message;
			return false;
		}
	};
	const currentGateError = (): string | undefined => gateStatePersistenceError ?? finalizationAbortError ?? finalizationSteerError;
	const reportFinalizationError = (operation: "abort" | "steering", error: unknown): string => {
		const message = `Review checkpoint finalization ${operation} failed: ${error instanceof Error ? error.message : String(error)}`;
		console.error(message);
		return message;
	};
	const clearFinalizationTimer = (): void => {
		if (!finalizationTimer) return;
		clearTimeout(finalizationTimer);
		finalizationTimer = undefined;
	};
	const absoluteFinalizationIsDue = (): boolean => finalizeAt !== undefined && Date.now() >= finalizeAt;
	const finalizationDeliveryComplete = (): boolean => finalizationAbortDelivered && finalizationSteerDelivered;
	const finalizeActiveTurn = (): boolean => {
		if (durableFinalCheckpoint) return true;
		if (!permanentFinalization) {
			if (!absoluteFinalizationIsDue()) return false;
			if (!persistGateState({ permanentFinalization: true })) return false;
		}
		if (!finalizationAbortDelivered) {
			if (!activeContext) {
				finalizationAbortError = reportFinalizationError("abort", "active extension context is unavailable");
			} else {
				try {
					activeContext.abort();
					finalizationAbortDelivered = true;
					finalizationAbortError = undefined;
					persistGateState({ finalizationAbortDelivered: true });
				} catch (error) {
					finalizationAbortError = reportFinalizationError("abort", error);
				}
			}
		}
		if (!finalizationSteerDelivered) {
			if (!sendUserMessage) {
				finalizationSteerError = reportFinalizationError("steering", "sendUserMessage is unavailable");
			} else {
				try {
					sendUserMessage(
						"Review checkpoint finalization is required now. Immediately checkpoint every confirmed finding, submit the final status, and return your final response. Do not investigate further.",
						{ deliverAs: "steer" },
					);
					finalizationSteerDelivered = true;
					finalizationSteerError = undefined;
					persistGateState({ finalizationSteerDelivered: true });
				} catch (error) {
					finalizationSteerError = reportFinalizationError("steering", error);
				}
			}
		}
		if (finalizationDeliveryComplete() && gateStatePersistenceError) {
			persistGateState({
				permanentFinalization: true,
				finalizationAbortDelivered: true,
				finalizationSteerDelivered: true,
			});
		}
		return finalizationDeliveryComplete() && !gateStatePersistenceError;
	};
	const armFinalizationTimer = (ctx?: ExtensionContext): void => {
		if (ctx) activeContext = ctx;
		clearFinalizationTimer();
		if (!finalizeAt || !activeLifecycle || sessionShutdown || durableFinalCheckpoint || (finalizationDeliveryComplete() && !gateStatePersistenceError)) return;
		const delay = absoluteFinalizationIsDue() ? FINALIZATION_RETRY_MS : Math.max(0, finalizeAt - Date.now());
		finalizationTimer = setTimeout(() => {
			finalizationTimer = undefined;
			if (!finalizeActiveTurn()) armFinalizationTimer();
		}, delay);
		finalizationTimer.unref?.();
	};
	const beginFinalizationIfDue = (): boolean => permanentFinalization || finalizationIsDue();
	const allowsFinalizationTool = (toolName: string): boolean => toolName === REVIEW_CHECKPOINT_TOOL_NAME || (toolName === "structured_output" && structuredOutputActive);
	const checkpointToolValue = (input: unknown): unknown => input && typeof input === "object" && !Array.isArray(input) && Object.hasOwn(input, "value")
		? (input as { value: unknown }).value
		: input;
	const finalCheckpointInput = (input: unknown): boolean => {
		const value = checkpointToolValue(input);
		return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (value as { kind?: unknown }).kind === "final";
	};
	onRuntimeEvent("agent_start", (_event, ctx) => {
		activeLifecycle = true;
		if (ctx) activeContext = ctx;
		if (absoluteFinalizationIsDue()) {
			if (!finalizeActiveTurn()) armFinalizationTimer(ctx);
		} else {
			armFinalizationTimer(ctx);
		}
		return undefined;
	});
	onRuntimeEvent("turn_start", (_event, ctx) => {
		activeLifecycle = true;
		if (ctx) activeContext = ctx;
		assistantTurn += 1;
		investigativeCallAdmittedThisTurn = false;
		checkpointBoundaryThisTurn = false;
		pendingFinalizationThisTurn = false;
		persistGateState();
		if (absoluteFinalizationIsDue()) {
			if (!finalizeActiveTurn()) armFinalizationTimer(ctx);
		} else {
			armFinalizationTimer(ctx);
		}
		return undefined;
	});
	onRuntimeEvent("agent_end", () => {
		activeLifecycle = false;
		activeContext = undefined;
		clearFinalizationTimer();
		return undefined;
	});
	onRuntimeEvent("session_shutdown", () => {
		sessionShutdown = true;
		activeLifecycle = false;
		activeContext = undefined;
		clearFinalizationTimer();
		return undefined;
	});
	onRuntimeEvent("tool_call", (event, ctx) => {
		if (ctx) activeContext = ctx;
		if (absoluteFinalizationIsDue() && !finalizeActiveTurn()) armFinalizationTimer(ctx);
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const checkpointFinal = toolName === REVIEW_CHECKPOINT_TOOL_NAME && finalCheckpointInput(event.input);
		if (toolName === REVIEW_CHECKPOINT_TOOL_NAME) {
			if (checkpointFinal && investigativeCallAdmittedThisTurn) {
				return { block: true, reason: `Review checkpoint finalization must precede investigative tools in assistant turn ${assistantTurn}.` };
			}
			if (pendingFinalizationThisTurn && !checkpointFinal) {
				return { block: true, reason: `Review checkpoint finalization is pending in assistant turn ${assistantTurn}; retry the final checkpoint instead.` };
			}
			checkpointBoundaryThisTurn = true;
			if (checkpointFinal) pendingFinalizationThisTurn = true;
			return undefined;
		}
		const gateError = currentGateError();
		if (gateError && !allowsFinalizationTool(toolName)) {
			return { block: true, reason: `${gateError} Only finalization tools may retry durable recovery.` };
		}
		if (!allowsFinalizationTool(toolName)) {
			if (beginFinalizationIfDue() || pendingFinalizationThisTurn) {
				return {
					block: true,
					reason: `Review checkpoint finalization is permanent at assistant turn ${assistantTurn}. Only '${REVIEW_CHECKPOINT_TOOL_NAME}'${structuredOutputActive ? " and 'structured_output'" : ""} may run.`,
				};
			}
			if (checkpointBoundaryThisTurn) {
				return { block: true, reason: `Review checkpoint activity cannot reopen investigation during assistant turn ${assistantTurn}.` };
			}
			if (assistantTurn >= policy.requiredByTurn && !checkpointCompleted) {
				return {
					block: true,
					reason: `Review checkpoint gate is active at assistant turn ${assistantTurn}. Only '${REVIEW_CHECKPOINT_TOOL_NAME}'${structuredOutputActive ? " and 'structured_output'" : ""} may run until a checkpoint persists.`,
				};
			}
			investigativeCallAdmittedThisTurn = true;
		}
		return undefined;
	});
	if (typeof pi.registerTool !== "function") return;
	const registerTool = pi.registerTool as unknown as (tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute: (_id: string, params: { value: unknown }) => Promise<unknown>;
	}) => void;
	registerTool({
		name: REVIEW_CHECKPOINT_TOOL_NAME,
		label: "Review Checkpoint",
		description: "Persist one structured finding, explicit progress, or a final complete/truncated status. This is acknowledged only after durable persistence.",
		parameters: createStructuredOutputToolParameters(REVIEW_CHECKPOINT_PARAMETERS_SCHEMA) as never,
		async execute(_id: string, params: { value: unknown }) {
			const declaredFinal = finalCheckpointInput({ value: params.value });
			const clearFailedFinalization = (): void => {
				if (declaredFinal && !permanentFinalization) pendingFinalizationThisTurn = false;
			};
			const schemaValidation = await validateStructuredOutputValue(REVIEW_CHECKPOINT_PARAMETERS_SCHEMA, params.value);
			if (schemaValidation.status === "invalid") {
				clearFailedFinalization();
				throw new Error(`Review checkpoint validation failed: ${schemaValidation.message}`);
			}
			const submission = validateReviewCheckpointSubmission(params.value);
			if (!submission.submission) {
				clearFailedFinalization();
				throw new Error(submission.error ?? "Review checkpoint validation failed.");
			}
			let record;
			try {
				record = persistReviewCheckpoint({
					storePath,
					identity,
					assistantTurn: Math.max(1, assistantTurn),
					submission: submission.submission,
				});
			} catch (error) {
				clearFailedFinalization();
				throw new Error(`Review checkpoint persistence failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			checkpointCompleted = true;
			gateStatePersistenceError = undefined;
			// The receipt and its durable gate state permanently close investigation.
			if (submission.submission.kind === "final") {
				permanentFinalization = true;
				durableFinalCheckpoint = true;
				finalizationAbortError = undefined;
				finalizationSteerError = undefined;
				clearFinalizationTimer();
			}
			return {
				content: [{ type: "text", text: "Review checkpoint persisted." }],
				details: { reviewCheckpoint: record },
			};
		},
	});
}

function registerToolBudget(pi: ExtensionAPI, budget: ResolvedToolBudget | undefined): void {
	if (!budget) return;
	let toolCount = 0;
	let softNudged = false;
	const sendUserMessage = (pi as { sendUserMessage?: (content: string, options: { deliverAs: "steer" }) => unknown }).sendUserMessage;
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: { toolName?: string }) => unknown) => void;
	onRuntimeEvent("tool_call", (event) => {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		toolCount++;
		if (budget.soft !== undefined && toolCount >= budget.soft && !softNudged) {
			softNudged = true;
			try {
				sendUserMessage?.(toolBudgetSoftNudge(budget, toolCount), { deliverAs: "steer" });
			} catch {
				// Budget nudges are advisory; blocking below remains authoritative.
			}
		}
		if (!shouldBlockToolForBudget(budget, toolName, toolCount)) return undefined;
		return { block: true, reason: toolBudgetBlockedMessage(budget, toolName, toolCount) };
	});
}

export function registerSteeringInbox(
	pi: ExtensionAPI,
	deps: {
		watch?: typeof fs.watch;
		nativeRealpath?: (filePath: string) => string;
		legacySettleFallbackMs?: number;
		safetyPollIntervalMs?: number;
		platform?: NodeJS.Platform;
		timers?: Pick<typeof globalThis, "setInterval" | "clearInterval">;
	} = {},
): void {
	const steerInbox = process.env[SUBAGENT_STEER_INBOX_ENV]?.trim();
	if (!steerInbox) return;
	const capabilityPath = process.env[SUBAGENT_STEER_CAPABILITY_ENV]?.trim();
	const ackDir = process.env[SUBAGENT_STEER_ACK_DIR_ENV]?.trim();
	const sendUserMessage = (pi as { sendUserMessage?: (content: string, options?: { deliverAs: "steer" | "followUp" }) => unknown }).sendUserMessage;
	const childIndex = Number(process.env[SUBAGENT_CHILD_INDEX_ENV]);
	const pending = new Map<string, Array<{ request: SteerRequest; deliveryStatus: SteerDeliveryStatus }>>();
	const queued: Array<{ request: SteerRequest; ready: boolean }> = [];
	let disposed = false;
	let agentRunning = false;
	let inTurn = false;
	let awaitingSettlement = false;
	let flushing = false;
	let started = false;
	let canSteer = typeof sendUserMessage === "function";
	let watcher: fs.FSWatcher | undefined;
	let interval: NodeJS.Timeout | undefined;
	let safetyInterval: NodeJS.Timeout | undefined;
	let settleFallback: NodeJS.Timeout | undefined;
	const legacySettleFallbackMs = deps.legacySettleFallbackMs ?? STEERING_LEGACY_SETTLE_FALLBACK_MS;
	const acknowledge = (request: SteerRequest, state: "delivered" | "queued" | "failed", message: string, deliveryStatus?: SteerDeliveryStatus): void => {
		if (!ackDir || !Number.isInteger(childIndex) || childIndex < 0) return;
		writeSteerAckAt(steerAckPathFromDir(ackDir, request.id), {
			requestId: request.id,
			index: childIndex,
			ts: Date.now(),
			state,
			...(deliveryStatus ? { deliveryStatus } : {}),
			message,
		});
	};
	const publishCapability = (): void => {
		if (!capabilityPath || !Number.isInteger(childIndex) || childIndex < 0) return;
		writeSteerCapabilityAt(capabilityPath, { index: childIndex, pid: process.pid, readyAt: Date.now(), supported: canSteer });
	};
	const flush = (): void => {
		if (disposed || flushing) return;
		flushing = true;
		try {
			const requests = consumeSteerRequestsFromDir(steerInbox);
			for (let index = 0; index < requests.length; index++) {
				const request = requests[index]!;
				if (!canSteer || typeof sendUserMessage !== "function") {
					acknowledge(request, "failed", "Child Pi session does not support sendUserMessage steering.");
					continue;
				}
				const requestedMode = request.mode ?? "steer";
				const autoCanUseIdle = requestedMode === "auto" && !agentRunning && !awaitingSettlement;
				const delivery = requestedMode === "follow_up" || (requestedMode === "auto" && (inTurn || awaitingSettlement)) ? "followUp" as const : "steer" as const;
				const pendingFollowUps = [...pending.values()].reduce((count, entries) => count + entries.filter((entry) => entry.deliveryStatus === "queued").length, 0);
				if (delivery === "followUp" && queued.length + pendingFollowUps >= MAX_STEER_QUEUE_SIZE) {
					acknowledge(request, "failed", `Follow-up queue is full (${MAX_STEER_QUEUE_SIZE} messages).`);
					continue;
				}
				const formatted = formatSteerMessage(request);
				const entries = pending.get(formatted) ?? [];
				entries.push({ request, deliveryStatus: delivery === "followUp" ? "queued" : "delivered" });
				pending.set(formatted, entries);
				try {
					sendUserMessage(formatted, autoCanUseIdle ? undefined : { deliverAs: delivery });
				} catch (error) {
					entries.pop();
					if (entries.length === 0) pending.delete(formatted);
					acknowledge(request, "failed", error instanceof Error ? error.message : String(error));
					for (const retry of requests.slice(index + 1)) writeSteerRequestToDir(steerInbox, retry);
					break;
				}
			}
		} finally {
			flushing = false;
		}
	};
	const onInput = (event: unknown): undefined => {
		if (disposed || !event || typeof event !== "object") return undefined;
		const input = event as { source?: unknown; streamingBehavior?: unknown; text?: unknown; content?: unknown };
		if (input.source !== "extension") return undefined;
		const text = typeof input.text === "string" ? input.text : typeof input.content === "string" ? input.content : undefined;
		if (!text) return undefined;
		const entries = pending.get(text);
		const entry = entries?.shift();
		if (!entry) return undefined;
		if (entries?.length === 0) pending.delete(text);
		if (entry.deliveryStatus === "queued") {
			queued.push({ request: entry.request, ready: !inTurn });
			acknowledge(entry.request, "queued", "Pi queued the correlated follow-up input.", "queued");
		} else {
			acknowledge(entry.request, "delivered", "Pi accepted the correlated steering input.", "delivered");
		}
		return undefined;
	};
	const start = (): void => {
		if (started || disposed) return;
		try {
			fs.mkdirSync(steerInbox, { recursive: true });
			publishCapability();
		} catch {
			return;
		}
		started = true;
		const startPolling = (): void => {
			if (interval || disposed) return;
			interval = (deps.timers?.setInterval ?? setInterval)(flush, 250) as NodeJS.Timeout;
			interval.unref?.();
		};
		const startSafetyPolling = (): void => {
			if (safetyInterval || disposed) return;
			safetyInterval = (deps.timers?.setInterval ?? setInterval)(flush, deps.safetyPollIntervalMs ?? STEERING_SAFETY_POLL_INTERVAL_MS) as NodeJS.Timeout;
			safetyInterval.unref?.();
		};
		if (!shouldUseNativeFsWatch("child-steering-inbox", deps.platform)) {
			startPolling();
		} else {
			try {
				watcher = (deps.watch ?? fs.watch)(resolveWatchPath(steerInbox, deps.nativeRealpath), () => flush());
				watcher.on("error", startPolling);
				startSafetyPolling();
			} catch {
				watcher = undefined;
				startPolling();
			}
		}
	};
	const activate = (): undefined => {
		start();
		flush();
		return undefined;
	};
	const clearSettleFallback = (): void => {
		if (!settleFallback) return;
		clearTimeout(settleFallback);
		settleFallback = undefined;
	};
	const markSettled = (): undefined => {
		clearSettleFallback();
		agentRunning = false;
		inTurn = false;
		awaitingSettlement = false;
		return activate();
	};
	const armLegacySettleFallback = (): void => {
		clearSettleFallback();
		settleFallback = setTimeout(() => {
			settleFallback = undefined;
			if (disposed || !awaitingSettlement) return;
			agentRunning = false;
			inTurn = false;
			awaitingSettlement = false;
			activate();
		}, legacySettleFallbackMs);
		settleFallback.unref?.();
	};

	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => void;
	// Register input before the watcher so an accepted extension input cannot race request dispatch.
	onRuntimeEvent("input", onInput);
	onRuntimeEvent("session_start", () => start());
	onRuntimeEvent("agent_start", () => {
		clearSettleFallback();
		agentRunning = true;
		awaitingSettlement = false;
		return activate();
	});
	onRuntimeEvent("agent_end", (event) => {
		inTurn = false;
		if ((event as { willRetry?: unknown } | undefined)?.willRetry === true) {
			clearSettleFallback();
			agentRunning = true;
			awaitingSettlement = true;
			return activate();
		}
		agentRunning = true;
		awaitingSettlement = true;
		armLegacySettleFallback();
		return activate();
	});
	onRuntimeEvent("agent_settled", markSettled);
	onRuntimeEvent("session_compact", () => {
		const unresolved = [...pending.values()].flat();
		pending.clear();
		for (const entry of unresolved) {
			try {
				writeSteerRequestToDir(steerInbox, { ...entry.request, mode: "follow_up" });
			} catch (error) {
				acknowledge(entry.request, "failed", `Could not retry steering after compaction: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return activate();
	});
	onRuntimeEvent("turn_start", () => {
		clearSettleFallback();
		agentRunning = true;
		awaitingSettlement = false;
		inTurn = true;
		const next = queued.findIndex((entry) => entry.ready);
		if (next >= 0) {
			const [entry] = queued.splice(next, 1);
			if (entry) acknowledge(entry.request, "delivered", "Pi delivered the queued follow-up at a turn boundary.", "delivered");
		}
		return activate();
	});
	onRuntimeEvent("turn_end", () => {
		inTurn = false;
		for (const entry of queued) entry.ready = true;
		return activate();
	});
	for (const eventName of ["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end"] as const) {
		onRuntimeEvent(eventName, activate);
	}
	onRuntimeEvent("session_shutdown", () => {
		for (const entry of queued) acknowledge(entry.request, "failed", "Run ended before queued follow-up delivery.", "queued");
		for (const entries of pending.values()) {
			for (const entry of entries) acknowledge(entry.request, "failed", "Run ended before Pi confirmed steering input delivery.");
		}
		disposed = true;
		clearSettleFallback();
		try { watcher?.close(); } catch {}
		if (interval) (deps.timers?.clearInterval ?? clearInterval)(interval);
		if (safetyInterval) (deps.timers?.clearInterval ?? clearInterval)(safetyInterval);
	});
}

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
	registerRuntimeExtensionAcknowledgements(pi);
	registerSteeringInbox(pi);
	registerReviewCheckpoint(pi);
	registerPermissionGate(pi);
	registerToolBudget(pi, decodeToolBudgetEnv(process.env[TOOL_BUDGET_ENV], { allowZero: process.env[TOOL_BUDGET_ZERO_AUTH_ENV] === "1" }));
	registerChildWatchdog(pi);
	const waitToolEnabled = resolveWaitToolConfig().enabled;
	const waitState = {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as unknown as SubagentState;
	if (typeof pi.registerTool === "function") registerWaitTool(pi, waitState, waitToolEnabled);
	let nativeSupervisorClientRegistered = false;
	const registerNativeSupervisorClientOnce = (): void => {
		if (nativeSupervisorClientRegistered) return;
		nativeSupervisorClientRegistered = true;
		registerNativeSupervisorClient(pi);
	};
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: unknown, ctx?: ExtensionContext) => unknown) => void;
	onRuntimeEvent("session_start", (_event: unknown, ctx?: ExtensionContext) => {
		const sessionManager = (ctx as { sessionManager?: Parameters<typeof resolveCurrentSessionId>[0] } | undefined)?.sessionManager;
		waitState.currentSessionId = sessionManager ? resolveCurrentSessionId(sessionManager) : null;
		registerNativeSupervisorClientOnce();
	});
	onRuntimeEvent("agent_start", () => {
		refreshChildToolDiagnostic(pi);
	});
	onRuntimeEvent("agent_end", async (_event: unknown, ctx: unknown) => {
		if ((ctx as { hasUI?: boolean } | undefined)?.hasUI === true) return;
		await drainOutstandingWork({ state: waitState, events: pi.events });
	});
	const structuredOutputPath = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
	const structuredSchemaPath = process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
	if (structuredOutputPath && structuredSchemaPath) {
		const schema = JSON.parse(fs.readFileSync(structuredSchemaPath, "utf-8")) as JsonSchemaObject;
		const parameters = createStructuredOutputToolParameters(schema);
		const registerTool = pi.registerTool as unknown as (tool: {
			name: string;
			label: string;
			description: string;
			parameters: unknown;
			execute: (_id: string, params: { value: unknown }) => Promise<unknown>;
		}) => void;
		registerTool({
			name: "structured_output",
			label: "Structured Output",
			description: "Submit the required final structured output for this subagent step. This terminates the step.",
			parameters: parameters as never,
			async execute(_id: string, params: { value: unknown }) {
				const validation = await validateStructuredOutputValue(schema, params.value);
				if (validation.status === "invalid") {
					throw new Error(`Structured output validation failed: ${validation.message}`);
				}
				fs.mkdirSync(path.dirname(structuredOutputPath), { recursive: true });
				fs.writeFileSync(structuredOutputPath, JSON.stringify(params.value), { mode: 0o600 });
				return {
					content: [{ type: "text", text: "Structured output captured." }],
					details: { path: structuredOutputPath },
					terminate: true,
				};
			},
		});
	}

	onRuntimeEvent("context", (event: unknown, ctx?: ExtensionContext) => {
		if (!event || typeof event !== "object" || !("messages" in event) || !Array.isArray(event.messages)) return undefined;
		const messages = stripParentOnlySubagentMessages(event.messages, {
			sanitizeToolIds: !COMPOSITE_TOOL_ID_APIS.has(ctx?.model?.api ?? ""),
		});
		if (messages === event.messages) return undefined;
		return { messages };
	});

	onRuntimeEvent("before_agent_start", async (event: unknown) => {
		if (!event || typeof event !== "object" || !("systemPrompt" in event) || typeof event.systemPrompt !== "string") return undefined;
		registerNativeSupervisorClientOnce();
		const intercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
		if (intercomSessionName && typeof pi.setSessionName === "function") {
			pi.setSessionName(intercomSessionName);
		}

		const inheritProjectContext = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV);
		const inheritSkills = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV);
		const fanoutChild = readBooleanEnv(SUBAGENT_FANOUT_CHILD_ENV);
		let rewritten = event.systemPrompt;
		if (inheritProjectContext !== undefined || inheritSkills !== undefined || fanoutChild !== undefined) {
			rewritten = rewriteSubagentPrompt(event.systemPrompt, {
				inheritProjectContext: inheritProjectContext ?? true,
				inheritSkills: inheritSkills ?? true,
				fanoutChild: fanoutChild === true,
			});
		}
		if (rewritten === event.systemPrompt) return;
		return { systemPrompt: rewritten };
	});
}
