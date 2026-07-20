export interface RunnerSubagentStep {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	thinking?: string;
	modelCandidates?: string[];
	tools?: string[];
	extensions?: string[];
	mcpDirectTools?: string[];
	systemPrompt?: string | null;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills?: string[];
	outputPath?: string;
	outputMode?: "inline" | "file-only";
	sessionFile?: string;
	maxSubagentDepth?: number;
}

export interface ParallelStepGroup {
	parallel: RunnerSubagentStep[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
}

export type RunnerStep = RunnerSubagentStep | ParallelStepGroup;

export function isParallelGroup(step: RunnerStep): step is ParallelStepGroup {
	return "parallel" in step && Array.isArray(step.parallel);
}

export function flattenSteps(steps: RunnerStep[]): RunnerSubagentStep[] {
	const flat: RunnerSubagentStep[] = [];
	for (const step of steps) {
		if (isParallelGroup(step)) {
			for (const task of step.parallel) flat.push(task);
		} else {
			flat.push(step);
		}
	}
	return flat;
}

export interface ParallelLaunchOptions {
	random?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export function parallelLaunchJitterMs(effectiveConcurrency: number, random: () => number = Math.random): number {
	if (effectiveConcurrency <= 1) return 0;
	return Math.floor(Math.max(0, Math.min(1, random())) * 100);
}

export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, i: number) => Promise<R>,
	options: ParallelLaunchOptions = {},
): Promise<R[]> {
	const safeLimit = Math.max(1, Math.floor(limit) || 1);
	const effectiveConcurrency = Math.min(safeLimit, items.length);
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const results: R[] = new Array(items.length);
	let next = 0;

	async function worker(_workerIndex: number): Promise<void> {
		while (next < items.length) {
			const i = next++;
			const jitterMs = parallelLaunchJitterMs(effectiveConcurrency, options.random);
			if (jitterMs > 0) await sleep(jitterMs);
			results[i] = await fn(items[i], i);
		}
	}

	await Promise.all(
		Array.from({ length: effectiveConcurrency }, (_, wi) => worker(wi)),
	);
	return results;
}

export interface ParallelTaskResult {
	agent: string;
	taskIndex?: number;
	output: string;
	exitCode: number | null;
	error?: string;
	model?: string;
	attemptedModels?: string[];
	outputTargetPath?: string;
	outputTargetExists?: boolean;
}

export function aggregateParallelOutputs(
	results: ParallelTaskResult[],
	headerFormat: (index: number, agent: string) => string = (i, agent) =>
		`=== Parallel Task ${i + 1} (${agent}) ===`,
): string {
	return results
		.map((r, i) => {
			const header = headerFormat(r.taskIndex ?? i, r.agent);
			const hasOutput = Boolean(r.output?.trim());
			const status =
				r.exitCode === -1
					? "SKIPPED"
					: r.exitCode !== 0 && r.exitCode !== null
						? `FAILED (exit code ${r.exitCode})${r.error ? `: ${r.error}` : ""}`
						: r.error
							? `WARNING: ${r.error}`
							: !hasOutput && r.outputTargetPath && r.outputTargetExists === false
								? `EMPTY OUTPUT (expected output file missing: ${r.outputTargetPath})`
								: !hasOutput && !r.outputTargetPath
									? "EMPTY OUTPUT (no textual response returned)"
							: "";
			const body = status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
			return `${header}\n${body}`;
		})
		.join("\n\n");
}

export const MAX_PARALLEL_CONCURRENCY = 4;
