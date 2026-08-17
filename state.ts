import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type TaskStatus = "starting" | "running" | "exited" | "terminated" | "failed" | "orphaned";
export const STATE_VERSION = 2 as const;

export interface TaskRecord {
	task_id: string;
	name: string;
	workspace_id: string;
	tab_id: string;
	pane_id: string;
	command: string;
	cwd: string;
	marker: string;
	created_at: string;
	updated_at?: string;
	status: TaskStatus;
	exit_code?: number;
	error?: string;
	error_code?: string;
	error_retryable?: boolean;
	output_truncated?: boolean;
	resources_released_at?: string;
}

export interface ProjectState {
	version: typeof STATE_VERSION;
	project_root: string;
	workspace_id?: string;
	tasks: Record<string, TaskRecord>;
}

const TASK_STATUSES = new Set<TaskStatus>(["starting", "running", "exited", "terminated", "failed", "orphaned"]);

export function stateDirectory(home = homedir()): string {
	return join(home, ".pi", "pi-herdr-background-terminal");
}

export function projectDirectory(projectRoot: string, home = homedir()): string {
	const key = createHash("sha256").update(projectRoot).digest("hex");
	return join(stateDirectory(home), key);
}

export function legacyProjectStatePath(projectRoot: string, home = homedir()): string {
	const key = createHash("sha256").update(projectRoot).digest("hex");
	return join(stateDirectory(home), "projects", `${key}.json`);
}

export function projectStatePath(projectRoot: string, home = homedir()): string {
	return join(projectDirectory(projectRoot, home), "tasks.json");
}

export function projectLockPath(projectRoot: string, home = homedir()): string {
	return join(projectDirectory(projectRoot, home), "tasks.lock");
}

export function taskOutputPath(projectRoot: string, id: string, home = homedir()): string {
	const key = createHash("sha256").update(id).digest("hex");
	return join(projectDirectory(projectRoot, home), "outputs", `${key}.txt`);
}

export async function canonicalProjectRoot(cwd: string, basePath?: string): Promise<string> {
	const absolute = resolve(basePath ?? process.cwd(), cwd);
	try {
		return await realpath(absolute);
	} catch {
		return absolute;
	}
}

function emptyState(projectRoot: string): ProjectState {
	return { version: STATE_VERSION, project_root: projectRoot, tasks: {} };
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || isString(value);
}

export function isTaskRecord(value: unknown): value is TaskRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const task = value as Record<string, unknown>;
	return isString(task.task_id)
		&& isString(task.name)
		&& isString(task.workspace_id)
		&& isString(task.tab_id)
		&& isString(task.pane_id)
		&& isString(task.command)
		&& isString(task.cwd)
		&& isString(task.marker)
		&& isString(task.created_at)
		&& isOptionalString(task.updated_at)
		&& isString(task.status)
		&& TASK_STATUSES.has(task.status as TaskStatus)
		&& (task.exit_code === undefined || Number.isInteger(task.exit_code))
		&& isOptionalString(task.error)
		&& isOptionalString(task.error_code)
		&& (task.error_retryable === undefined || typeof task.error_retryable === "boolean")
		&& (task.output_truncated === undefined || typeof task.output_truncated === "boolean")
		&& isOptionalString(task.resources_released_at);
}

function validateTasks(tasks: unknown): asserts tasks is Record<string, TaskRecord> {
	if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) throw new Error("invalid background-terminal state");
	for (const [id, task] of Object.entries(tasks)) {
		if (!isTaskRecord(task) || task.task_id !== id) throw new Error("invalid background-terminal task record");
	}
}

export async function ensureStateDirectory(home = homedir()): Promise<void> {
	await mkdir(stateDirectory(home), { recursive: true, mode: 0o700 });
}

async function ensureProjectDirectory(projectRoot: string, home = homedir()): Promise<void> {
	await ensureStateDirectory(home);
	await mkdir(join(projectDirectory(projectRoot, home), "outputs"), { recursive: true, mode: 0o700 });
}

async function migrateLegacyProjectState(projectRoot: string, home = homedir()): Promise<void> {
	try {
		await readFile(projectStatePath(projectRoot, home), "utf8");
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const legacyPath = legacyProjectStatePath(projectRoot, home);
	let legacy: { version?: number; project_root?: string; workspace_id?: string; tasks?: Record<string, TaskRecord & { output?: string }> };
	try {
		legacy = JSON.parse(await readFile(legacyPath, "utf8")) as typeof legacy;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (legacy.version !== 1 || legacy.project_root !== projectRoot) throw new Error(`Invalid legacy background-terminal state for ${projectRoot}`);
	validateTasks(legacy.tasks);

	const migrated: ProjectState = {
		version: STATE_VERSION,
		project_root: projectRoot,
		workspace_id: legacy.workspace_id,
		tasks: legacy.tasks,
	};
	for (const task of Object.values(migrated.tasks) as Array<TaskRecord & { output?: string }>) {
		if (typeof task.output === "string") await saveTaskOutput(projectRoot, task.task_id, task.output, home);
		delete task.output;
	}
	await saveProjectState(migrated, home);
	await atomicWrite(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);
	await rename(legacyPath, join(projectDirectory(projectRoot, home), "legacy-v1.json"));
	await rm(`${legacyPath}.lock`, { force: true });
}

export async function loadProjectState(projectRoot: string, home = homedir()): Promise<ProjectState> {
	await ensureProjectDirectory(projectRoot, home);
	await migrateLegacyProjectState(projectRoot, home);
	try {
		const parsed = JSON.parse(await readFile(projectStatePath(projectRoot, home), "utf8")) as Partial<ProjectState>;
		if (parsed.version !== STATE_VERSION || parsed.project_root !== projectRoot) throw new Error("invalid background-terminal state");
		validateTasks(parsed.tasks);
		if (parsed.workspace_id !== undefined && typeof parsed.workspace_id !== "string") throw new Error("invalid background-terminal state");
		return { version: STATE_VERSION, project_root: projectRoot, workspace_id: parsed.workspace_id, tasks: parsed.tasks };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(projectRoot);
		if (error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("invalid background-terminal"))) {
			throw new Error(`Invalid background-terminal state for ${projectRoot}`);
		}
		throw error;
	}
}

async function atomicWrite(target: string, content: string): Promise<void> {
	const temporary = join(dirname(target), `.${createHash("sha256").update(`${target}:${process.pid}:${randomBytes(6).toString("hex")}`).digest("hex")}.tmp`);
	await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, target);
}

export async function saveProjectState(state: ProjectState, home = homedir()): Promise<void> {
	validateTasks(state.tasks);
	await ensureProjectDirectory(state.project_root, home);
	await atomicWrite(projectStatePath(state.project_root, home), `${JSON.stringify(state, null, 2)}\n`);
}

export async function loadTaskOutput(projectRoot: string, id: string, home = homedir()): Promise<string | undefined> {
	await ensureProjectDirectory(projectRoot, home);
	try {
		return await readFile(taskOutputPath(projectRoot, id, home), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function saveTaskOutput(projectRoot: string, id: string, output: string, home = homedir()): Promise<void> {
	await ensureProjectDirectory(projectRoot, home);
	await atomicWrite(taskOutputPath(projectRoot, id, home), output);
}

export async function removeTaskOutput(projectRoot: string, id: string, home = homedir()): Promise<void> {
	await rm(taskOutputPath(projectRoot, id, home), { force: true });
}

function ownerIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function removeStaleLock(lockPath: string): Promise<void> {
	try {
		const lock = await stat(lockPath);
		if (Date.now() - lock.mtimeMs <= 30_000) return;
		const owner = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);
		if (!ownerIsAlive(owner)) await rm(lockPath, { force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function withProjectLock<T>(
	projectRoot: string,
	operation: (state: ProjectState) => Promise<{ state: ProjectState; value: T }>,
	home = homedir(),
): Promise<T> {
	await ensureProjectDirectory(projectRoot, home);
	const lockPath = projectLockPath(projectRoot, home);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${process.pid}\n`);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await removeStaleLock(lockPath);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
	}
	if (!handle) throw new Error(`Timed out acquiring background-terminal lock for ${projectRoot}`);

	try {
		const result = await operation(await loadProjectState(projectRoot, home));
		await saveProjectState(result.state, home);
		return result.value;
	} finally {
		await handle.close();
		await rm(lockPath, { force: true });
	}
}

export function taskId(): string {
	return `bt_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
}

export function taskLabel(value: string | undefined): string {
	const label = value?.trim() || `task-${Date.now().toString(36)}`;
	if (label.length > 80 || /[\r\n]/.test(label)) {
		throw new Error("Task label must be at most 80 characters and contain no line breaks");
	}
	return label;
}
