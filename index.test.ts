import { expect, test } from "bun:test";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import backgroundTerminalExtension, { BackgroundTerminalService } from "./index.ts";
import { markerToken, markers, parseTaskOutput, wrapCommand } from "./helpers.ts";
import { HerdrClient, HerdrRequestError } from "./herdr-client.ts";
import { assertExecParams, assertTaskId, assertWriteParams } from "./protocol.ts";
import {
	canonicalProjectRoot,
	ensureStateDirectory,
	loadProjectState,
	loadTaskOutput,
	projectDirectory,
	projectLockPath,
	projectStatePath,
	saveProjectState,
	saveTaskOutput,
	STATE_VERSION,
	taskOutputPath,
	taskId,
	taskLabel,
	withProjectLock,
	type ProjectState,
} from "./state.ts";

function temporaryHome(): string {
	return join(tmpdir(), `.test-bg-terminal-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

function task(id: string, projectRoot = "/tmp/project"): ProjectState["tasks"][string] {
	return {
		task_id: id,
		name: "dev server",
		workspace_id: "w1",
		tab_id: "w1:t1",
		pane_id: "w1:p1",
		command: "bun dev",
		cwd: projectRoot,
		marker: "deadbeef",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:01:00.000Z",
		status: "terminated",
	};
}

test("dual marker wrapper separates task output from pane noise", () => {
	const token = markerToken();
	const pair = markers(token);
	const wrapped = wrapCommand("echo hello", token);
	expect(wrapped).toContain(pair.start);
	expect(wrapped).toContain(pair.done);
	const fixture = [
		"$ ( set +e",
		"); rc=$?",
		"printf '\\n",
		pair.start,
		"real output",
		"second line",
		`${pair.done}:7`,
		"$ ",
	].join("\n");
	const parsed = parseTaskOutput(fixture, token);
	expect(parsed).toEqual({ started: true, output: "real output\nsecond line", exitCode: 7 });
	for (const leaked of ["( set +e", "); rc=$?", "__PI_BG_DONE_", "printf '\\n"]) expect(parsed.output).not.toContain(leaked);
});

test("output is hidden until the exact start marker exists", () => {
	const parsed = parseTaskOutput("prompt\nwrapper echo\n__PI_BG_nope_DONE__:0", "token");
	expect(parsed.started).toBeFalse();
	expect(parsed.output).toBe("");
});

test("runtime payload and opaque-id bounds reject oversized values", () => {
	expect(() => assertExecParams({ command: " " })).toThrow("command must not be empty");
	expect(() => assertExecParams({ command: "x".repeat(64 * 1024 + 1) })).toThrow("UTF-8 bytes");
	expect(() => assertWriteParams({ task_id: "bt_1", input: "x".repeat(64 * 1024 + 1) })).toThrow("UTF-8 bytes");
	expect(() => assertTaskId("x".repeat(129))).toThrow("task_id");
});

test("task ids are opaque and labels are display-only", () => {
	const ids = new Set(Array.from({ length: 20 }, () => taskId()));
	expect(ids.size).toBe(20);
	expect(taskLabel("dev server")).toBe("dev server");
	expect(() => taskLabel("line\nbreak")).toThrow("line breaks");
});

test("state paths keep canonical output outside tasks.json", async () => {
	const home = temporaryHome();
	try {
		await ensureStateDirectory(home);
		const directory = projectDirectory("/tmp/project", home);
		expect(projectStatePath("/tmp/project", home)).toBe(join(directory, "tasks.json"));
		expect(taskOutputPath("/tmp/project", "bt_1", home)).toStartWith(join(directory, "outputs"));
		expect(taskOutputPath("/tmp/project", "bt_1", home)).toEndWith(".txt");
		const state: ProjectState = { version: STATE_VERSION, project_root: "/tmp/project", tasks: { bt_1: task("bt_1") } };
		await saveProjectState(state, home);
		await saveTaskOutput("/tmp/project", "bt_1", "final output", home);
		expect((await loadProjectState("/tmp/project", home)).tasks.bt_1?.status).toBe("terminated");
		expect(await loadTaskOutput("/tmp/project", "bt_1", home)).toBe("final output");
		expect((await readFile(projectStatePath("/tmp/project", home), "utf8")).includes("final output")).toBeFalse();
	} finally {
		await rm(join(home, ".pi"), { recursive: true, force: true });
	}
});

test("invalid task records are rejected without echoing their data", async () => {
	const home = temporaryHome();
	const projectRoot = "/tmp/project";
	try {
		await mkdir(projectDirectory(projectRoot, home), { recursive: true });
		await writeFile(projectStatePath(projectRoot, home), JSON.stringify({
			version: STATE_VERSION,
			project_root: projectRoot,
			tasks: { bad: { task_id: "bad", command: "secret-command" } },
		}));
		await expect(loadProjectState(projectRoot, home)).rejects.toThrow(`Invalid background-terminal state for ${projectRoot}`);
	} finally {
		await rm(join(home, ".pi"), { recursive: true, force: true });
	}
});

test("relative task cwd is resolved from the extension context cwd", async () => {
	const home = temporaryHome();
	const project = join(home, "project");
	const server = join(project, "server");
	try {
		await mkdir(server, { recursive: true });
		expect(await canonicalProjectRoot("server", project)).toBe(await canonicalProjectRoot(server));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("project lock serializes concurrent state changes", async () => {
	const home = temporaryHome();
	try {
		await Promise.all(Array.from({ length: 5 }, (_, index) => withProjectLock("/tmp/project", async (state) => {
			state.tasks[`id-${index}`] = { ...task(`id-${index}`), status: "running" };
			return { state, value: index };
		}, home)));
		expect(Object.keys((await loadProjectState("/tmp/project", home)).tasks)).toHaveLength(5);
	} finally {
		await rm(join(home, ".pi"), { recursive: true, force: true });
	}
});

test("stale locks are reclaimed only after their owner is gone", async () => {
	const home = temporaryHome();
	const projectRoot = "/tmp/project";
	try {
		await ensureStateDirectory(home);
		await mkdir(projectDirectory(projectRoot, home), { recursive: true });
		await writeFile(projectLockPath(projectRoot, home), "99999999\\n");
		const stale = new Date(Date.now() - 31_000);
		await utimes(projectLockPath(projectRoot, home), stale, stale);
		await withProjectLock(projectRoot, async (state) => ({ state, value: undefined }), home);
	} finally {
		await rm(join(home, ".pi"), { recursive: true, force: true });
	}
});

test("active reads surface Herdr transport failures while terminal reads remain local", async () => {
	const home = temporaryHome();
	const projectRoot = "/tmp/project";
	const context = { cwd: projectRoot, hasUI: false, isProjectTrusted: () => true } as never;
	try {
		await saveProjectState({ version: STATE_VERSION, project_root: projectRoot, tasks: { active: { ...task("active", projectRoot), status: "running" }, terminal: task("terminal", projectRoot) } }, home);
		await saveTaskOutput(projectRoot, "terminal", "local output", home);
		const service = new BackgroundTerminalService(new HerdrClient(join(home, "missing.sock"), 20), home);
		const terminal = await service.read({ task_id: "terminal" }, context);
		expect(terminal).toBe("local output");
		expect((await service.list({ task_id: "terminal" }, context)).tasks.map((item) => item.task_id)).toEqual(["terminal"]);
		expect((await service.list({ task_id: "missing" }, context)).tasks).toEqual([]);
		let readError: unknown;
		try {
			await service.read({ task_id: "active", wait_ms: 0 }, context);
		} catch (error) {
			readError = error;
		}
		expect(readError instanceof HerdrRequestError && readError.retryable).toBeTrue();
	} finally {
		await rm(join(home, ".pi"), { recursive: true, force: true });
	}
});

test("extension registers exactly the five public background tools", async () => {
	const tools: Array<{
		name: string;
		parameters: { properties?: Record<string, unknown> };
		execute?: (...args: unknown[]) => Promise<unknown>;
	}> = [];
	backgroundTerminalExtension({
		registerTool: (tool: unknown) => tools.push(tool as typeof tools[number]),
		registerCommand: () => undefined,
		on: () => undefined,
	} as never);
	expect(tools.map((tool) => tool.name)).toEqual(["background_exec", "background_list", "background_read", "background_write", "background_stop"]);
	expect(tools.find((tool) => tool.name === "background_exec")?.parameters.properties).not.toHaveProperty("wait_ms");
	expect(tools.find((tool) => tool.name === "background_exec")?.parameters.properties).not.toHaveProperty("output_lines");
	expect(tools.find((tool) => tool.name === "background_list")?.parameters.properties).toHaveProperty("task_id");
	expect(tools.find((tool) => tool.name === "background_read")?.parameters.properties).not.toHaveProperty("input");
	expect(tools.find((tool) => tool.name === "background_read")?.parameters.properties).not.toHaveProperty("cursor");

	const originalRead = BackgroundTerminalService.prototype.read;
	BackgroundTerminalService.prototype.read = async () => "console only";
	try {
		const execute = tools.find((tool) => tool.name === "background_read")?.execute;
		expect(execute).toBeDefined();
		expect(await execute?.("call", { task_id: "bt_1" }, undefined, undefined, {})).toEqual({
			content: [{ type: "text", text: "console only" }],
		});
	} finally {
		BackgroundTerminalService.prototype.read = originalRead;
	}
});
