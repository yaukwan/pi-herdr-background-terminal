export type BackgroundExecParams = {
	command: string;
	cwd?: string;
	label?: string;
};

export type BackgroundListParams = {
	task_id?: string;
	cursor?: string;
	limit?: number;
};

export type BackgroundReadParams = {
	task_id: string;
	wait_ms?: number;
	output_lines?: number;
};

export type BackgroundWriteParams = {
	task_id: string;
	input: string;
	submit?: boolean;
};

export type BackgroundStopParams = {
	task_id: string;
	mode: "interrupt" | "terminate";
};

export const MAX_TASK_ID_LENGTH = 128;
export const MAX_CURSOR_LENGTH = 512;
export const MAX_CWD_LENGTH = 4096;
export const MAX_PAYLOAD_BYTES = 64 * 1024;

function assertUtf8Bytes(value: string, maximum: number, name: string): void {
	if (Buffer.byteLength(value, "utf8") > maximum) {
		throw new Error(`invalid_arguments: ${name} must be at most ${maximum} UTF-8 bytes.`);
	}
}

export function assertTaskId(value: string): void {
	if (typeof value !== "string" || !value || value.length > MAX_TASK_ID_LENGTH) {
		throw new Error(`invalid_arguments: task_id must be 1-${MAX_TASK_ID_LENGTH} characters.`);
	}
}

export function assertCursor(value: string | undefined): void {
	if (value !== undefined && (typeof value !== "string" || value.length > MAX_CURSOR_LENGTH)) {
		throw new Error(`invalid_arguments: cursor must be at most ${MAX_CURSOR_LENGTH} characters.`);
	}
}

export function assertExecParams(params: BackgroundExecParams): void {
	if (typeof params.command !== "string" || !params.command.trim()) throw new Error("invalid_arguments: command must not be empty.");
	assertUtf8Bytes(params.command, MAX_PAYLOAD_BYTES, "command");
	if (params.cwd !== undefined && (typeof params.cwd !== "string" || params.cwd.length > MAX_CWD_LENGTH)) {
		throw new Error(`invalid_arguments: cwd must be at most ${MAX_CWD_LENGTH} characters.`);
	}
}

export function assertWriteParams(params: BackgroundWriteParams): void {
	assertTaskId(params.task_id);
	if (typeof params.input !== "string") throw new Error("invalid_arguments: input must be a string.");
	assertUtf8Bytes(params.input, MAX_PAYLOAD_BYTES, "input");
}
