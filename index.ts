import { setTimeout as delay } from "node:timers/promises";
import { sep } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { completionMarker, markerToken, parseTaskOutput, wrapCommand } from "./helpers.ts";
import {
	HerdrClient,
	HerdrRequestError,
	creationIds,
	isPaneNotFound,
	isPaneWaitTimeout,
	isShellForeground,
	isTabNotFound,
	isWorkspaceNotFound,
	textFromPaneRead,
} from "./herdr-client.ts";
import {
	assertCursor,
	assertExecParams,
	assertTaskId,
	assertWriteParams,
	type BackgroundExecParams,
	type BackgroundListParams,
	type BackgroundReadParams,
	type BackgroundStopParams,
	type BackgroundWriteParams,
} from "./protocol.ts";
import {
	canonicalProjectRoot,
	loadProjectState,
	loadTaskOutput,
	removeTaskOutput,
	saveTaskOutput,
	taskId,
	taskLabel,
	withProjectLock,
	type ProjectState,
	type TaskRecord,
	type TaskStatus,
} from "./state.ts";

const MAX_LINES = DEFAULT_MAX_LINES;
const MAX_BYTES = DEFAULT_MAX_BYTES;
const DEFAULT_READ_WAIT_MS = 5_000;
const MAX_READ_WAIT_MS = 300_000;
const DEFAULT_OUTPUT_LINES = 120;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const MAX_ACTIVE_TASKS = 64;
const INTERRUPT_RECONCILE_MS = 1_000;
const INTERRUPT_POLL_MS = 50;
const WATCH_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const WATCH_RETRY_MAX_MS = 30_000;

export type TaskState = TaskStatus;

export interface TaskError {
	code: string;
	message: string;
	retryable: boolean;
}

export interface TaskSummary {
	task_id: string;
	label: string;
	state: TaskState;
	exit_code?: number;
	updated_at: string;
	output_truncated?: boolean;
	error?: TaskError;
}

export interface BackgroundListResult {
	tasks: TaskSummary[];
	next_cursor?: string;
}

export interface BackgroundWriteResult {
	task: TaskSummary;
	accepted: true;
}

export interface BackgroundStopResult {
	task: TaskSummary;
	mode: "interrupt" | "terminate";
	accepted: boolean;
	reason?: "already_terminal" | "pane_unavailable";
}

export interface TaskCleanupResult {
	eligible: number;
	removed: number;
}

type ToolResult = BackgroundListResult | BackgroundWriteResult | BackgroundStopResult;

export function assertProjectTrusted(ctx: ExtensionContext): void {
	if (ctx.isProjectTrusted && !ctx.isProjectTrusted()) throw new Error("The current project is not trusted");
}

function clamp(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.floor(value as number)));
}

function isTerminal(status: TaskStatus): boolean {
	return status === "exited" || status === "terminated" || status === "failed" || status === "orphaned";
}

function errorInfo(error: unknown): TaskError {
	if (error instanceof HerdrRequestError) {
		return { code: error.code ?? error.kind, message: error.message.slice(0, 240), retryable: error.retryable };
	}
	return { code: "task_failed", message: String(error).slice(0, 240), retryable: false };
}

function taskSummary(task: TaskRecord): TaskSummary {
	return {
		task_id: task.task_id,
		label: task.name,
		state: task.status,
		exit_code: task.exit_code,
		updated_at: task.updated_at ?? task.created_at,
		output_truncated: task.output_truncated || undefined,
		error: task.error
			? { code: task.error_code ?? "task_failed", message: task.error.slice(0, 240), retryable: task.error_retryable ?? false }
			: undefined,
	};
}

function taskSummaryText(task: TaskSummary): string {
	const exit = task.exit_code === undefined ? "" : ` exit=${task.exit_code}`;
	return `${task.task_id} [${task.state}] ${task.label}${exit}`;
}

function resultText(result: ToolResult): string {
	if ("tasks" in result) return result.tasks.length === 0 ? "No background tasks" : result.tasks.map(taskSummaryText).join("\n");
	if ("mode" in result) return `${taskSummaryText(result.task)} ${result.mode} ${result.accepted ? "accepted" : result.reason ?? "not accepted"}`;
	return `${taskSummaryText(result.task)} input accepted`;
}

function projectTask(state: ProjectState, id: string): TaskRecord {
	const task = state.tasks[id];
	if (!task) throw new Error(`task_not_found: Background task ${id} was not found. Use background_list.`);
	return task;
}

interface Cursor {
	updatedAt: string;
	taskId: string;
}

function listCursor(task: TaskRecord): string {
	return Buffer.from(JSON.stringify({ updatedAt: task.updated_at ?? task.created_at, taskId: task.task_id })).toString("base64url");
}

function parseCursor(cursor: string | undefined): Cursor | undefined {
	assertCursor(cursor);
	if (!cursor) return undefined;
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<Cursor>;
		if (typeof value.updatedAt !== "string" || typeof value.taskId !== "string") throw new Error();
		return { updatedAt: value.updatedAt, taskId: value.taskId };
	} catch {
		throw new Error("invalid_arguments: cursor is invalid. Use background_list without cursor.");
	}
}

function followsCursor(task: TaskRecord, cursor: Cursor | undefined): boolean {
	if (!cursor) return true;
	const updatedAt = task.updated_at ?? task.created_at;
	return updatedAt < cursor.updatedAt || (updatedAt === cursor.updatedAt && task.task_id < cursor.taskId);
}

interface CapturedOutput {
	started: boolean;
	output: string;
	outputTruncated: boolean;
	exitCode?: number;
}

export class BackgroundTerminalService {
	private readonly watchers = new Map<string, AbortController>();
	private readonly taskInteractions = new Map<string, Promise<void>>();

	constructor(
		private readonly client = new HerdrClient(),
		private readonly stateHome?: string,
	) {}

	async ensureAvailable(signal?: AbortSignal): Promise<void> {
		if (!this.client.enabled) throw new Error("Herdr socket path is not configured");
		await this.client.ping(signal);
	}

	private async projectPaths(ctx: ExtensionContext, cwd?: string): Promise<{ projectRoot: string; cwd: string }> {
		const projectRoot = await canonicalProjectRoot(ctx.cwd);
		const target = await canonicalProjectRoot(cwd ?? ".", ctx.cwd);
		if (target !== projectRoot && !target.startsWith(`${projectRoot}${sep}`)) {
			throw new Error(`Background terminal cwd must stay inside ${projectRoot}`);
		}
		return { projectRoot, cwd: target };
	}

	async exec(params: BackgroundExecParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ task_id: string }> {
		assertProjectTrusted(ctx);
		assertExecParams(params);
		await this.ensureAvailable(signal);
		const { projectRoot, cwd } = await this.projectPaths(ctx, params.cwd);
		const label = taskLabel(params.label);
		const previous = await loadProjectState(projectRoot, this.stateHome);
		if (Object.values(previous.tasks).filter((task) => !isTerminal(task.status)).length >= MAX_ACTIVE_TASKS) {
			throw new Error(`too_many_active_tasks: ${MAX_ACTIVE_TASKS} tasks are still active. Terminate one before starting another.`);
		}

		let workspaceId = previous.workspace_id;
		let tabId: string;
		let paneId: string;
		let missingWorkspaceId: string | undefined;
		if (workspaceId) {
			try {
				({ tabId, paneId } = creationIds(await this.client.tabCreate(workspaceId, cwd, label, signal)));
			} catch (error) {
				if (!isWorkspaceNotFound(error)) throw error;
				missingWorkspaceId = workspaceId;
				const created = creationIds(await this.client.workspaceCreate(cwd, `bg:${projectRoot.split(sep).pop() || "project"}`, signal));
				workspaceId = created.workspaceId;
				tabId = created.tabId;
				paneId = created.paneId;
			}
		} else {
			const created = creationIds(await this.client.workspaceCreate(cwd, `bg:${projectRoot.split(sep).pop() || "project"}`, signal));
			workspaceId = created.workspaceId;
			tabId = created.tabId;
			paneId = created.paneId;
		}

		const token = markerToken();
		const record = await withProjectLock(projectRoot, async (state) => {
			const activeTasks = Object.values(state.tasks).filter((task) => !isTerminal(task.status));
			if (activeTasks.length >= MAX_ACTIVE_TASKS) {
				throw new Error(`too_many_active_tasks: ${MAX_ACTIVE_TASKS} tasks are still active. Terminate one before starting another.`);
			}
			if (missingWorkspaceId) {
				const now = new Date().toISOString();
				for (const task of Object.values(state.tasks)) {
					if (task.workspace_id !== missingWorkspaceId || isTerminal(task.status)) continue;
					task.status = "orphaned";
					task.updated_at = now;
					task.error = "Herdr workspace is no longer available";
					task.error_code = "workspace_not_found";
					task.error_retryable = false;
				}
			}
			const now = new Date().toISOString();
			const next: TaskRecord = {
				task_id: taskId(), name: label, workspace_id: workspaceId as string, tab_id: tabId, pane_id: paneId,
				command: params.command, cwd, marker: token, created_at: now, updated_at: now, status: "starting",
			};
			state.workspace_id = workspaceId;
			state.tasks[next.task_id] = next;
			return { state, value: next };
		}, this.stateHome);

		try {
			await this.client.paneSendInput(record.pane_id, wrapCommand(params.command, token), [], signal);
			await this.client.paneSendKeys(record.pane_id, ["enter"], signal);
		} catch (error) {
			const info = errorInfo(error);
			await this.updateTask(projectRoot, record.task_id, (current) => ({
				...current, status: "failed", error: info.message, error_code: info.code, error_retryable: info.retryable,
			}));
			throw error;
		}
		this.watch(record.task_id, projectRoot, ctx);
		return { task_id: record.task_id };
	}

	async list(params: BackgroundListParams, ctx: ExtensionContext): Promise<BackgroundListResult> {
		assertProjectTrusted(ctx);
		if (params.task_id !== undefined) assertTaskId(params.task_id);
		assertCursor(params.cursor);
		const { projectRoot } = await this.projectPaths(ctx);
		const cursor = parseCursor(params.cursor);
		const limit = clamp(params.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
		const tasks = Object.values((await loadProjectState(projectRoot, this.stateHome)).tasks)
			.filter((task) => params.task_id === undefined || task.task_id === params.task_id)
			.sort((left, right) => {
				const byTime = (right.updated_at ?? right.created_at).localeCompare(left.updated_at ?? left.created_at);
				return byTime || right.task_id.localeCompare(left.task_id);
			})
			.filter((task) => followsCursor(task, cursor));
		const page = tasks.slice(0, limit);
		return { tasks: page.map(taskSummary), next_cursor: tasks.length > page.length ? listCursor(page[page.length - 1] as TaskRecord) : undefined };
	}

	async read(params: BackgroundReadParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
		assertProjectTrusted(ctx);
		assertTaskId(params.task_id);
		const { projectRoot } = await this.projectPaths(ctx);
		const task = await this.getTask(projectRoot, params.task_id);
		const lines = clamp(params.output_lines, DEFAULT_OUTPUT_LINES, 1, MAX_LINES);
		if (isTerminal(task.status)) return this.projectTaskRead(projectRoot, task, lines);
		await this.ensureAvailable(signal);
		return this.withTaskInteraction(task.task_id, signal, () => this.readTask(
			projectRoot, task.task_id, clamp(params.wait_ms, DEFAULT_READ_WAIT_MS, 0, MAX_READ_WAIT_MS), lines, signal,
		));
	}

	async write(params: BackgroundWriteParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<BackgroundWriteResult> {
		assertProjectTrusted(ctx);
		assertWriteParams(params);
		const { projectRoot } = await this.projectPaths(ctx);
		const task = await this.getTask(projectRoot, params.task_id);
		if (isTerminal(task.status)) throw new Error(`task_not_running: Background task ${task.task_id} is ${task.status}. Use background_read to inspect it or background_exec to start a new task.`);
		await this.ensureAvailable(signal);
		return this.withTaskInteraction(task.task_id, signal, async () => {
			const current = await this.getTask(projectRoot, task.task_id);
			if (isTerminal(current.status)) throw new Error(`task_not_running: Background task ${current.task_id} is ${current.status}. Use background_read to inspect it or background_exec to start a new task.`);
			await this.client.paneSendInput(current.pane_id, params.input, params.submit === false ? [] : ["enter"], signal);
			return { task: taskSummary(current), accepted: true };
		});
	}

	async stop(params: BackgroundStopParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<BackgroundStopResult> {
		assertProjectTrusted(ctx);
		assertTaskId(params.task_id);
		const { projectRoot } = await this.projectPaths(ctx);
		const task = await this.getTask(projectRoot, params.task_id);
		if (isTerminal(task.status)) return { task: taskSummary(task), mode: params.mode, accepted: false, reason: "already_terminal" };
		await this.ensureAvailable(signal);
		return this.withTaskInteraction(task.task_id, signal, async () => {
			const current = await this.getTask(projectRoot, task.task_id);
			if (isTerminal(current.status)) return { task: taskSummary(current), mode: params.mode, accepted: false, reason: "already_terminal" };
			try {
				if (params.mode === "interrupt") {
					await this.client.paneSendKeys(current.pane_id, ["ctrl+c"], signal);
					return { task: taskSummary(await this.reconcileInterrupt(projectRoot, current, signal)), mode: "interrupt", accepted: true };
				}
				this.stopWatching(current.task_id);
				await this.saveCapture(projectRoot, current.task_id, await this.captureTaskOutput(current, signal), true);
				await this.client.paneClose(current.pane_id, signal);
				const terminated = await this.updateTask(projectRoot, current.task_id, (record) => ({
					...record, status: "terminated", exit_code: undefined, error: undefined, error_code: undefined, error_retryable: undefined,
				}));
				this.stopWatching(current.task_id);
				return { task: taskSummary(terminated), mode: "terminate", accepted: true };
			} catch (error) {
				return this.controlError(projectRoot, current, params.mode, error);
			}
		});
	}

	async cleanup(ctx: ExtensionContext, confirm: boolean): Promise<TaskCleanupResult> {
		assertProjectTrusted(ctx);
		const { projectRoot } = await this.projectPaths(ctx);
		if (!confirm) {
			const state = await loadProjectState(projectRoot, this.stateHome);
			return { eligible: Object.values(state.tasks).filter((task) => isTerminal(task.status)).length, removed: 0 };
		}
		const snapshot = await withProjectLock(projectRoot, async (state) => {
			const terminal = Object.values(state.tasks).filter((task) => isTerminal(task.status));
			const closableTabs = new Set(terminal
				.filter((task) => !Object.values(state.tasks).some((other) => other.tab_id === task.tab_id && !isTerminal(other.status)))
				.map((task) => task.tab_id));
			return { state, value: { terminal, closableTabs } };
		}, this.stateHome);

		if (this.client.enabled) {
			for (const task of snapshot.terminal) {
				try { await this.client.paneClose(task.pane_id); } catch (error) { if (!isPaneNotFound(error)) throw error; }
			}
			for (const tabId of snapshot.closableTabs) {
				try { await this.client.tabClose(tabId); } catch (error) { if (!isTabNotFound(error)) throw error; }
			}
		}

		const removed = await withProjectLock(projectRoot, async (state) => {
			const ids = snapshot.terminal.map((task) => task.task_id).filter((id) => state.tasks[id] && isTerminal(state.tasks[id].status));
			for (const id of ids) delete state.tasks[id];
			return { state, value: ids };
		}, this.stateHome);
		await Promise.all(removed.map((id) => removeTaskOutput(projectRoot, id, this.stateHome)));
		return { eligible: snapshot.terminal.length, removed: removed.length };
	}

	async focus(id: string, ctx: ExtensionContext): Promise<void> {
		assertProjectTrusted(ctx);
		assertTaskId(id);
		await this.ensureAvailable();
		const { projectRoot } = await this.projectPaths(ctx);
		await this.client.paneFocus((await this.getTask(projectRoot, id)).pane_id);
	}

	async recover(ctx: ExtensionContext): Promise<void> {
		if (!this.client.enabled) return;
		const { projectRoot } = await this.projectPaths(ctx);
		try { await this.ensureAvailable(); } catch { return; }
		const state = await loadProjectState(projectRoot, this.stateHome);
		for (const task of Object.values(state.tasks)) {
			if (isTerminal(task.status)) continue;
			void this.withTaskInteraction(task.task_id, undefined, async () => {
				const current = await this.probeTask(projectRoot, task.task_id);
				if (isTerminal(current.status)) return;
				if (current.status === "starting") {
					try {
						if (isShellForeground(await this.client.paneProcessInfo(current.pane_id))) {
							await this.failTask(projectRoot, current.task_id, "launch_incomplete", "Background task did not reach its start marker");
							return;
						}
					} catch (error) {
						if (isPaneNotFound(error)) { await this.orphanTask(projectRoot, current.task_id, error); return; }
						throw error;
					}
				}
				this.watch(current.task_id, projectRoot, ctx);
			}).catch((error) => void this.recordWatchFailure(projectRoot, task.task_id, error));
		}
	}

	shutdown(): void {
		for (const controller of this.watchers.values()) controller.abort();
		this.watchers.clear();
	}

	private async getTask(projectRoot: string, id: string): Promise<TaskRecord> {
		return projectTask(await loadProjectState(projectRoot, this.stateHome), id);
	}

	private async updateTask(projectRoot: string, id: string, update: (task: TaskRecord) => TaskRecord): Promise<TaskRecord> {
		return withProjectLock(projectRoot, async (state) => {
			const current = projectTask(state, id);
			const next = { ...update(current), updated_at: new Date().toISOString() };
			state.tasks[id] = next;
			return { state, value: next };
		}, this.stateHome);
	}

	private async withTaskInteraction<T>(id: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
		const previous = this.taskInteractions.get(id) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const current = previous.then(() => gate);
		this.taskInteractions.set(id, current);
		try {
			if (signal?.aborted) throw new HerdrRequestError({ kind: "cancelled", method: "task.interaction", retryable: false }, `Background task interaction cancelled: ${id}`);
			await previous;
			return await operation();
		} finally {
			release();
			void current.then(() => { if (this.taskInteractions.get(id) === current) this.taskInteractions.delete(id); });
		}
	}

	private async projectTaskRead(projectRoot: string, task: TaskRecord, lines: number): Promise<string> {
		return truncateTail(await loadTaskOutput(projectRoot, task.task_id, this.stateHome) ?? "", { maxBytes: MAX_BYTES, maxLines: lines }).content;
	}

	private async captureTaskOutput(task: TaskRecord, signal?: AbortSignal): Promise<CapturedOutput> {
		const raw = textFromPaneRead(await this.client.paneRead(task.pane_id, MAX_LINES, signal));
		const parsed = parseTaskOutput(raw, task.marker);
		const projection = truncateTail(parsed.output, { maxBytes: MAX_BYTES, maxLines: MAX_LINES });
		return { started: parsed.started, output: projection.content, outputTruncated: projection.truncated, exitCode: parsed.exitCode };
	}

	private async saveCapture(projectRoot: string, id: string, capture: CapturedOutput, final: boolean): Promise<TaskRecord> {
		return withProjectLock(projectRoot, async (state) => {
			const current = projectTask(state, id);
			if (capture.started && (capture.output || final)) await saveTaskOutput(projectRoot, id, capture.output, this.stateHome);
			const next: TaskRecord = {
				...current,
				status: capture.exitCode === undefined ? (capture.started ? "running" : current.status) : "exited",
				exit_code: capture.exitCode,
				output_truncated: capture.started ? capture.outputTruncated : current.output_truncated,
				error: undefined, error_code: undefined, error_retryable: undefined,
				updated_at: new Date().toISOString(),
			};
			state.tasks[id] = next;
			return { state, value: next };
		}, this.stateHome);
	}

	private async orphanTask(projectRoot: string, id: string, error: unknown): Promise<TaskRecord> {
		const info = errorInfo(error);
		const task = await this.updateTask(projectRoot, id, (current) => {
			if (isTerminal(current.status)) return current;
			return {
				...current, status: "orphaned", error: info.message, error_code: info.code, error_retryable: info.retryable,
			};
		});
		this.stopWatching(id);
		return task;
	}

	private async failTask(projectRoot: string, id: string, code: string, message: string): Promise<TaskRecord> {
		const task = await this.updateTask(projectRoot, id, (current) => ({
			...current, status: "failed", error: message, error_code: code, error_retryable: false,
		}));
		this.stopWatching(id);
		return task;
	}

	private async probeTask(projectRoot: string, id: string, signal?: AbortSignal): Promise<TaskRecord> {
		const task = await this.getTask(projectRoot, id);
		if (isTerminal(task.status)) return task;
		try {
			return this.saveCapture(projectRoot, id, await this.captureTaskOutput(task, signal), false);
		} catch (error) {
			if (isPaneNotFound(error)) return this.orphanTask(projectRoot, id, error);
			throw error;
		}
	}

	private async readTask(projectRoot: string, id: string, waitMs: number, lines: number, signal?: AbortSignal): Promise<string> {
		let task = await this.getTask(projectRoot, id);
		if (isTerminal(task.status)) return this.projectTaskRead(projectRoot, task, lines);
		if (waitMs > 0) {
			try { await this.client.paneWaitForOutput(task.pane_id, completionMarker(task.marker), waitMs, signal); }
			catch (error) { if (!isPaneWaitTimeout(error)) throw error; }
		}
		task = await this.probeTask(projectRoot, id, signal);
		if (isTerminal(task.status)) return this.projectTaskRead(projectRoot, task, lines);
		return this.projectTaskRead(projectRoot, task, lines);
	}

	private async reconcileInterrupt(projectRoot: string, task: TaskRecord, signal?: AbortSignal): Promise<TaskRecord> {
		const deadline = Date.now() + INTERRUPT_RECONCILE_MS;
		do {
			if (isShellForeground(await this.client.paneProcessInfo(task.pane_id, signal))) {
				const captured = await this.probeTask(projectRoot, task.task_id, signal);
				if (captured.status === "exited") return captured;
				const exited = await this.updateTask(projectRoot, task.task_id, (current) => ({
					...current, status: "exited", exit_code: 130, error: undefined, error_code: undefined, error_retryable: undefined,
				}));
				this.stopWatching(task.task_id);
				return exited;
			}
			await delay(INTERRUPT_POLL_MS, undefined, { signal });
		} while (Date.now() < deadline);
		return this.getTask(projectRoot, task.task_id);
	}

	private async controlError(projectRoot: string, task: TaskRecord, mode: "interrupt" | "terminate", error: unknown): Promise<BackgroundStopResult> {
		if (!isPaneNotFound(error)) throw error;
		return { task: taskSummary(await this.orphanTask(projectRoot, task.task_id, error)), mode, accepted: false, reason: "pane_unavailable" };
	}

	private async recordWatchFailure(projectRoot: string, id: string, error: unknown): Promise<void> {
		if (error instanceof HerdrRequestError && error.retryable) return;
		const info = errorInfo(error);
		await this.updateTask(projectRoot, id, (current) => isTerminal(current.status) ? current : ({
			...current, status: "failed", error: info.message, error_code: info.code, error_retryable: info.retryable,
		}));
	}

	private stopWatching(id: string): void {
		this.watchers.get(id)?.abort();
		this.watchers.delete(id);
	}

	private watch(id: string, projectRoot: string, ctx: ExtensionContext): void {
		if (this.watchers.has(id)) return;
		const controller = new AbortController();
		this.watchers.set(id, controller);
		void (async () => {
			let retryMs = 1_000;
			while (!controller.signal.aborted) {
				const task = await this.getTask(projectRoot, id);
				if (isTerminal(task.status)) return;
				try {
					await this.client.paneWaitForOutput(task.pane_id, completionMarker(task.marker), WATCH_TIMEOUT_MS, controller.signal);
					const updated = await this.withTaskInteraction(id, controller.signal, () => this.probeTask(projectRoot, id, controller.signal));
					if (!isTerminal(updated.status)) continue;
					if (ctx.hasUI) ctx.ui.notify(`${updated.name} exited${updated.exit_code === undefined ? "" : ` with ${updated.exit_code}`}`, updated.exit_code === 0 ? "info" : "warning");
					return;
				} catch (error) {
					if (controller.signal.aborted) return;
					if (isPaneWaitTimeout(error)) continue;
					if (isPaneNotFound(error)) { await this.orphanTask(projectRoot, id, error); return; }
					if (error instanceof HerdrRequestError && error.retryable) {
						await delay(retryMs, undefined, { signal: controller.signal });
						retryMs = Math.min(WATCH_RETRY_MAX_MS, retryMs * 2);
						continue;
					}
					throw error;
				}
			}
		})().catch((error) => this.recordWatchFailure(projectRoot, id, error)).finally(() => {
			if (this.watchers.get(id) === controller) this.watchers.delete(id);
		});
	}
}

const service = new BackgroundTerminalService();

function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

function renderResult(result: { content: Array<{ type: string; text?: string }>; details: unknown }, theme: any, expanded: boolean): Text {
	const details = result.details as Partial<BackgroundListResult & { task: TaskSummary }>;
	if (details.tasks) return new Text(theme.fg("accent", `${details.tasks.length} background task(s)`), 0, 0);
	const task = details.task;
	if (!task) return new Text(theme.fg("toolTitle", contentText(result)), 0, 0);
	if (!expanded) return new Text(theme.fg("toolTitle", `${task.label} [${task.state}]`), 0, 0);
	const color = task.state === "exited" && task.exit_code !== 0 ? "warning" : task.state === "failed" || task.state === "orphaned" ? "error" : "success";
	return new Text(theme.fg(color, contentText(result)), 0, 0);
}

export default function backgroundTerminalExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "background_exec", label: "Background Exec", description: "Run a shell command in a persistent Herdr terminal pane.",
		promptSnippet: "Start a command in a persistent Herdr background terminal",
		promptGuidelines: ["Use background_exec for dev servers, watchers, and long-running commands. It returns only a task_id; use background_read to inspect output."],
		parameters: Type.Object({
			command: Type.String({ minLength: 1, maxLength: 65_536, description: "POSIX shell command to run" }),
			cwd: Type.Optional(Type.String({ maxLength: 4096, description: "Working directory inside the current trusted project" })),
			label: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Human-readable task label" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: BackgroundExecParams, signal, _onUpdate, ctx) {
			const result = await service.exec(params, ctx, signal);
			return { content: [{ type: "text", text: result.task_id }], details: result };
		},
		renderCall(args, theme) { const input = args as Partial<BackgroundExecParams>; return new Text(theme.fg("toolTitle", `background_exec ${input.label ?? ""} ${input.command ?? ""}`), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("toolTitle", (result.details as { task_id: string }).task_id), 0, 0); },
	});

	pi.registerTool({
		name: "background_list", label: "Background List", description: "List tracked background tasks or get one task by id from project-local persistent state.",
		promptSnippet: "List persistent Herdr background tasks",
		promptGuidelines: ["Use background_list to discover task ids or pass task_id to get one task's state. It works for terminal tasks while Herdr is offline."],
		parameters: Type.Object({ task_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), cursor: Type.Optional(Type.String({ maxLength: 512 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT })) }, { additionalProperties: false }),
		async execute(_toolCallId, params: BackgroundListParams, _signal, _onUpdate, ctx) { const result = await service.list(params, ctx); return { content: [{ type: "text", text: resultText(result) }], details: result }; },
		renderResult(result, { expanded }, theme) { return renderResult(result, theme, expanded); },
	});

	pi.registerTool({
		name: "background_read", label: "Background Read", description: "Read one background task's console output.",
		promptSnippet: "Read console output from a persistent Herdr background task",
		promptGuidelines: ["Use background_read with a task_id for plain console output. Use background_list with task_id for state and exit metadata."],
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1, maxLength: 128 }),
			wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_READ_WAIT_MS })),
			output_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LINES })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: BackgroundReadParams, signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: await service.read(params, ctx, signal) }] };
		},
	});

	pi.registerTool({
		name: "background_write", label: "Background Write", description: "Send input to a starting or running background task.",
		promptSnippet: "Send input to a persistent Herdr background task",
		promptGuidelines: ["Use background_write only for an active task. It presses Enter unless submit is false."],
		parameters: Type.Object({ task_id: Type.String({ minLength: 1, maxLength: 128 }), input: Type.String({ maxLength: 65_536 }), submit: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
		async execute(_toolCallId, params: BackgroundWriteParams, signal, _onUpdate, ctx) { const result = await service.write(params, ctx, signal); return { content: [{ type: "text", text: resultText(result) }], details: result }; },
		renderResult(result, { expanded }, theme) { return renderResult(result, theme, expanded); },
	});

	pi.registerTool({
		name: "background_stop", label: "Background Stop", description: "Interrupt or terminate a background task.",
		promptSnippet: "Interrupt or terminate a persistent Herdr background task",
		promptGuidelines: ["Use mode=interrupt for Ctrl+C or mode=terminate to snapshot output and close the pane."],
		parameters: Type.Object({ task_id: Type.String({ minLength: 1, maxLength: 128 }), mode: Type.Union([Type.Literal("interrupt"), Type.Literal("terminate")]) }, { additionalProperties: false }),
		async execute(_toolCallId, params: BackgroundStopParams, signal, _onUpdate, ctx) { const result = await service.stop(params, ctx, signal); return { content: [{ type: "text", text: resultText(result) }], details: result }; },
		renderResult(result, { expanded }, theme) { return renderResult(result, theme, expanded); },
	});

	pi.registerCommand("bg", {
		description: "List or control Herdr background terminal tasks",
		handler: async (args, ctx) => {
			const parts = args.trim() ? args.trim().split(/\s+/) : [];
			const [action = "list", id, ...rest] = parts;
			if (action === "clean") {
				const confirmed = id === "--confirm";
				const result = await service.cleanup(ctx, confirmed);
				ctx.ui.notify(confirmed ? `Removed ${result.removed} terminal background task(s).` : `${result.eligible} terminal background task(s) can be cleaned. Run /bg clean --confirm.`, "info");
				return;
			}
			if (action === "focus" && id) { await service.focus(id, ctx); ctx.ui.notify(`Focused background task ${id}`, "info"); return; }
			if (action === "list") { ctx.ui.notify(resultText(await service.list({}, ctx)), "info"); return; }
			if (action === "read" && id) { ctx.ui.notify(await service.read({ task_id: id }, ctx), "info"); return; }
			if (action === "write" && id) { ctx.ui.notify(resultText(await service.write({ task_id: id, input: rest.join(" ") }, ctx)), "info"); return; }
			if ((action === "interrupt" || action === "terminate") && id) { ctx.ui.notify(resultText(await service.stop({ task_id: id, mode: action }, ctx)), "info"); return; }
			ctx.ui.notify("Usage: /bg [list|read|write|interrupt|terminate|focus|clean] [task_id|--confirm] [input]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => { await service.recover(ctx); });
	pi.on("session_shutdown", () => { service.shutdown(); });
}
