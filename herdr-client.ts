import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_RESPONSE_FRAME_BYTES = 1024 * 1024;

export interface HerdrRequestResult {
	type?: string;
	[key: string]: unknown;
}

export interface PaneReadResult extends HerdrRequestResult {
	type: "pane_read";
	read: {
		pane_id?: string;
		text: string;
	};
}

export interface PaneProcessInfoResult extends HerdrRequestResult {
	type: "pane_process_info";
	process_info: {
		pane_id?: string;
		shell_pid?: number;
		foreground_process_group_id?: number;
	};
}

export type HerdrErrorKind = "cancelled" | "timeout" | "socket" | "protocol" | "remote";

export class HerdrRequestError extends Error {
	readonly kind: HerdrErrorKind;
	readonly method: string;
	readonly code?: string;
	readonly retryable: boolean;

	constructor(
		info: { kind: HerdrErrorKind; method: string; code?: string; retryable: boolean },
		message: string,
	) {
		super(message);
		this.name = "HerdrRequestError";
		this.kind = info.kind;
		this.method = info.method;
		this.code = info.code;
		this.retryable = info.retryable;
	}
}

interface CreationResult extends HerdrRequestResult {
	workspace?: { workspace_id?: string };
	tab?: { tab_id?: string; workspace_id?: string };
	root_pane?: { pane_id?: string; tab_id?: string; workspace_id?: string };
}

export function creationIds(result: CreationResult): { workspaceId: string; tabId: string; paneId: string } {
	const workspaceId = result.workspace?.workspace_id ?? result.tab?.workspace_id ?? result.root_pane?.workspace_id;
	const tabId = result.tab?.tab_id ?? result.root_pane?.tab_id;
	const paneId = result.root_pane?.pane_id;
	if (!workspaceId || !tabId || !paneId) {
		throw new HerdrRequestError(
			{ kind: "protocol", method: "workspace.create", retryable: false },
			"Unexpected Herdr creation response",
		);
	}
	return { workspaceId, tabId, paneId };
}

export function isPaneWaitTimeout(error: unknown): boolean {
	return error instanceof HerdrRequestError
		&& error.method === "pane.wait_for_output"
		&& (error.kind === "timeout" || (error.kind === "remote" && error.code === "timeout"));
}

export function isWorkspaceNotFound(error: unknown): boolean {
	return error instanceof HerdrRequestError && error.kind === "remote" && error.code === "workspace_not_found";
}

export function isPaneNotFound(error: unknown): boolean {
	return error instanceof HerdrRequestError
		&& error.kind === "remote"
		&& (error.code === "not_found" || error.code === "pane_not_found" || error.code === "tab_not_found" || error.code === "workspace_not_found");
}

export function isTabNotFound(error: unknown): boolean {
	return error instanceof HerdrRequestError && error.kind === "remote" && error.code === "tab_not_found";
}

function requestId(): string {
	return `pi-background-terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class HerdrClient {
	readonly socketPath: string;
	readonly defaultTimeoutMs: number;

	constructor(socketPath?: string, defaultTimeoutMs?: number) {
		this.socketPath = socketPath ?? process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
		this.defaultTimeoutMs = defaultTimeoutMs ?? 10_000;
	}

	get enabled(): boolean {
		return Boolean(this.socketPath);
	}

	async request<T extends HerdrRequestResult = HerdrRequestResult>(
		method: string,
		params: Record<string, unknown> = {},
		signal?: AbortSignal,
		timeoutMs = this.defaultTimeoutMs,
	): Promise<T> {
		if (!this.socketPath) {
			throw new HerdrRequestError({ kind: "socket", method, retryable: false }, "HERDR_SOCKET_PATH is not set");
		}
		if (signal?.aborted) {
			throw new HerdrRequestError({ kind: "cancelled", method, retryable: false }, `Herdr request cancelled: ${method}`);
		}

		const id = requestId();
		return new Promise<T>((resolve, reject) => {
			let socket: Socket | undefined;
			let buffer = "";
			let settled = false;
			const finish = (error?: HerdrRequestError, value?: T) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				socket?.destroy();
				if (error) reject(error);
				else resolve(value as T);
			};
			const timer = setTimeout(
				() => finish(new HerdrRequestError({ kind: "timeout", method, retryable: true }, `Herdr request timed out: ${method}`)),
				timeoutMs,
			);
			timer.unref?.();
			const abort = () => finish(new HerdrRequestError({ kind: "cancelled", method, retryable: false }, `Herdr request cancelled: ${method}`));
			signal?.addEventListener("abort", abort, { once: true });

			const handleLine = (line: string) => {
				if (!line.trim()) return;
				let response: { id?: string; result?: T; error?: { code?: string; message?: string } };
				try {
					const parsed: unknown = JSON.parse(line);
					if (!parsed || typeof parsed !== "object") throw new Error("response must be an object");
					response = parsed as typeof response;
				} catch (error) {
					finish(new HerdrRequestError({ kind: "protocol", method, retryable: false }, `Invalid Herdr JSON response: ${errorMessage(error)}`));
					return;
				}
				if (response.id !== id) return;
				if (response.error) {
					finish(new HerdrRequestError(
						{ kind: "remote", method, code: response.error.code, retryable: false },
						`Herdr ${response.error.code ?? "error"}: ${response.error.message ?? "request failed"}`,
					));
					return;
				}
				finish(undefined, response.result ?? ({} as T));
			};

			socket = createConnection(this.socketPath);
			socket.setEncoding("utf8");
			socket.on("connect", () => socket?.write(`${JSON.stringify({ id, method, params })}\n`));
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (Buffer.byteLength(line, "utf8") > MAX_RESPONSE_FRAME_BYTES) {
						finish(new HerdrRequestError(
							{ kind: "protocol", method, code: "response_too_large", retryable: false },
							`Herdr response for ${method} exceeded ${MAX_RESPONSE_FRAME_BYTES} bytes`,
						));
						return;
					}
					handleLine(line);
					if (settled) return;
					newline = buffer.indexOf("\n");
				}
				if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_FRAME_BYTES) {
					finish(new HerdrRequestError(
						{ kind: "protocol", method, code: "response_too_large", retryable: false },
						`Herdr response for ${method} exceeded ${MAX_RESPONSE_FRAME_BYTES} bytes`,
					));
				}
			});
			socket.on("error", (error) => finish(new HerdrRequestError(
				{ kind: "socket", method, retryable: true },
				`Herdr socket error: ${errorMessage(error)}`,
			)));
			socket.on("end", () => {
				if (!settled) {
					finish(new HerdrRequestError(
						{ kind: "socket", method, retryable: true },
						`Herdr socket closed before responding to ${method}`,
					));
				}
			});
		});
	}

	ping(signal?: AbortSignal): Promise<HerdrRequestResult> {
		return this.request("ping", {}, signal);
	}

	workspaceCreate(cwd: string, label: string, signal?: AbortSignal): Promise<CreationResult> {
		return this.request("workspace.create", { cwd, label, focus: false }, signal);
	}

	tabCreate(workspaceId: string, cwd: string, label: string, signal?: AbortSignal): Promise<CreationResult> {
		return this.request("tab.create", { workspace_id: workspaceId, cwd, label, focus: false }, signal);
	}

	async paneSendInput(paneId: string, text: string, keys: string[] = ["enter"], signal?: AbortSignal): Promise<HerdrRequestResult> {
		const result = await this.request("pane.send_input", { pane_id: paneId, text }, signal);
		if (keys.length > 0) await this.paneSendKeys(paneId, keys, signal);
		return result;
	}

	paneSendKeys(paneId: string, keys: string[], signal?: AbortSignal): Promise<HerdrRequestResult> {
		return this.request("pane.send_keys", { pane_id: paneId, keys }, signal);
	}

	paneRead(paneId: string, lines: number, signal?: AbortSignal): Promise<PaneReadResult> {
		return this.request<PaneReadResult>("pane.read", {
			pane_id: paneId,
			source: "recent_unwrapped",
			lines,
			strip_ansi: true,
		}, signal);
	}

	paneProcessInfo(paneId: string, signal?: AbortSignal): Promise<PaneProcessInfoResult> {
		return this.request<PaneProcessInfoResult>("pane.process_info", { pane_id: paneId }, signal);
	}

	paneWaitForText(paneId: string, text: string, timeoutMs: number, signal?: AbortSignal): Promise<HerdrRequestResult> {
		return this.paneWaitForMatch(paneId, { type: "substring", value: text }, timeoutMs, signal);
	}

	paneWaitForOutput(paneId: string, marker: string, timeoutMs: number, signal?: AbortSignal): Promise<HerdrRequestResult> {
		const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return this.paneWaitForMatch(paneId, {
			type: "regex",
			value: `(?:^|\n)${escaped}:-?\\d+(?:\n|$)`,
		}, timeoutMs, signal);
	}

	private paneWaitForMatch(
		paneId: string,
		match: { type: "substring" | "regex"; value: string },
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<HerdrRequestResult> {
		return this.request("pane.wait_for_output", {
			pane_id: paneId,
			source: "recent_unwrapped",
			match,
			lines: 2000,
			strip_ansi: true,
			timeout_ms: timeoutMs,
		}, signal, timeoutMs + 2_000);
	}

	paneFocus(paneId: string, signal?: AbortSignal): Promise<HerdrRequestResult> {
		return this.request("pane.focus", { pane_id: paneId }, signal);
	}

	paneClose(paneId: string, signal?: AbortSignal): Promise<HerdrRequestResult> {
		return this.request("pane.close", { pane_id: paneId }, signal);
	}

	tabClose(tabId: string, signal?: AbortSignal): Promise<HerdrRequestResult> {
		return this.request("tab.close", { tab_id: tabId }, signal);
	}
}

export function textFromPaneRead(result: PaneReadResult): string {
	if (result.type !== "pane_read" || typeof result.read?.text !== "string") {
		throw new HerdrRequestError({ kind: "protocol", method: "pane.read", retryable: false }, "Unexpected Herdr pane.read response");
	}
	return result.read.text;
}

export function isShellForeground(result: PaneProcessInfoResult): boolean {
	if (result.type !== "pane_process_info" || !result.process_info) {
		throw new HerdrRequestError({ kind: "protocol", method: "pane.process_info", retryable: false }, "Unexpected Herdr pane.process_info response");
	}
	const { shell_pid: shellPid, foreground_process_group_id: foregroundProcessGroupId } = result.process_info;
	return Number.isInteger(shellPid) && shellPid === foregroundProcessGroupId;
}
