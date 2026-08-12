import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BackgroundTerminalService } from "./index.ts";
import { markers } from "./helpers.ts";
import { HerdrClient, HerdrRequestError } from "./herdr-client.ts";
import { canonicalProjectRoot, loadProjectState, saveProjectState, STATE_VERSION, type TaskRecord } from "./state.ts";

class MockRemoteError extends Error {
	constructor(readonly code: string, message: string) { super(message); }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function listen(handler: (request: Record<string, unknown>) => Record<string, unknown>): Promise<Server & { unixPath: string }> {
	return new Promise((resolve, reject) => {
		const socketPath = join("/tmp", `.bg-service-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
		const server = createServer((socket) => {
			socket.once("data", (chunk) => {
				const request = JSON.parse(chunk.toString().trim()) as Record<string, unknown>;
				try {
					socket.write(`${JSON.stringify({ id: request.id, result: handler(request) })}\n`);
				} catch (error) {
					const code = error instanceof MockRemoteError ? error.code : "test_error";
					socket.write(`${JSON.stringify({ id: request.id, error: { code, message: String(error) } })}\n`);
				}
			});
		});
		server.on("error", reject);
		server.listen(socketPath, () => resolve(Object.assign(server, { unixPath: socketPath })));
	});
}

function startingTask(id: string, paneId: string, projectRoot: string, token: string): TaskRecord {
	return {
		task_id: id, name: id, workspace_id: "w1", tab_id: `tab-${id}`, pane_id: paneId,
		command: "sleep 30", cwd: projectRoot, marker: token, created_at: "2026-01-01T00:00:00.000Z", status: "starting",
	};
}

async function runTerminateWatcherRaceRegression(): Promise<void> {
	const home = join(tmpdir(), `.test-bg-terminal-terminate-race-${process.pid}-${Math.random().toString(36).slice(2)}`);
	const projectPath = join(home, "project");
	const context = { cwd: projectPath, hasUI: false, isProjectTrusted: () => true } as never;
	const token = "terminatewatcherrace";
	const pair = markers(token);
	const watchStarted = deferred<void>();
	let rejectWatch!: (error: unknown) => void;
	const watchFailure = new Promise<{ matched: true }>((_resolve, reject) => { rejectWatch = reject; });
	let reads = 0;
	try {
		await mkdir(projectPath, { recursive: true });
		const projectRoot = await canonicalProjectRoot(projectPath);
		await saveProjectState({
			version: STATE_VERSION,
			project_root: projectRoot,
			tasks: { race: { ...startingTask("race", "race-pane", projectRoot, token), status: "running" } },
		}, home);
		const client = {
			enabled: true,
			ping: async () => ({}),
			paneWaitForOutput: async () => { watchStarted.resolve(); return watchFailure; },
			paneRead: async () => {
				reads += 1;
				if (reads <= 2) return { type: "pane_read" as const, read: { pane_id: "race-pane", text: `${pair.start}\nrunning` } };
				throw new HerdrRequestError({ kind: "remote", method: "pane.read", code: "pane_not_found", retryable: false }, "pane closed");
			},
			paneClose: async () => ({}),
		} as unknown as HerdrClient;
		const watcherService = new BackgroundTerminalService(client, home);
		const controlService = new BackgroundTerminalService(client, home);
		await watcherService.recover(context);
		await watchStarted.promise;
		const stopped = await controlService.stop({ task_id: "race", mode: "terminate" }, context);
		assert.equal(stopped.task.state, "terminated");
		rejectWatch(new HerdrRequestError({ kind: "remote", method: "pane.wait_for_output", code: "pane_not_found", retryable: false }, "pane closed"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal((await loadProjectState(projectRoot, home)).tasks.race?.status, "terminated", "a stale watcher must not overwrite terminate with orphaned");
		watcherService.shutdown();
		controlService.shutdown();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

async function runServiceIntegration(): Promise<void> {
	const home = join(tmpdir(), `.test-bg-terminal-service-${process.pid}-${Math.random().toString(36).slice(2)}`);
	const projectPath = join(home, "project");
	const pendingInputs = new Map<string, string>();
	const outputs = new Map<string, string>();
	const tokens = new Map<string, string>();
	const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
	let nextPane = 1;
	await mkdir(projectPath, { recursive: true });
	const projectRoot = await canonicalProjectRoot(projectPath);
	const server = await listen((request) => {
		const params = request.params as Record<string, unknown>;
		requests.push({ method: String(request.method), params });
		switch (request.method) {
			case "ping": return { type: "pong" };
			case "workspace.create": {
				const pane = `p${nextPane++}`;
				return { type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: `t-${pane}`, workspace_id: "w1" }, root_pane: { pane_id: pane, tab_id: `t-${pane}`, workspace_id: "w1" } };
			}
			case "tab.create": {
				const pane = `p${nextPane++}`;
				return { type: "tab_created", tab: { tab_id: `t-${pane}`, workspace_id: "w1" }, root_pane: { pane_id: pane, tab_id: `t-${pane}`, workspace_id: "w1" } };
			}
			case "pane.send_input":
				pendingInputs.set(String(params.pane_id), String(params.text));
				return { accepted: true };
			case "pane.send_keys": {
				const pane = String(params.pane_id);
				const keys = params.keys;
				if (Array.isArray(keys) && keys[0] === "enter") {
					const input = pendingInputs.get(pane) ?? "";
					if (!input.includes("__PI_BG_")) return { accepted: true };
					const token = input.match(/__PI_BG_([a-f0-9]+)_START__/)?.[1];
					assert.ok(token);
					tokens.set(pane, token);
					const pair = markers(token);
					outputs.set(pane, input.includes("exit 7")
						? `$ ( set +e\n); rc=$?\nexit "$rc"\n${pair.start}\nquick output\n${pair.done}:7\n$ `
						: `${pair.start}\nserver ready`);
				} else if (Array.isArray(keys) && keys[0] === "ctrl+c") {
					const pair = markers(tokens.get(pane) as string);
					outputs.set(pane, `${pair.start}\ninterrupted\n${pair.done}:130`);
				}
				return { accepted: true };
			}
			case "pane.wait_for_output": {
				const output = outputs.get(String(params.pane_id)) ?? "";
				if (output.includes("_DONE__:")) return { matched: true };
				throw new MockRemoteError("timeout", "wait expired");
			}
			case "pane.read": return { type: "pane_read", read: { pane_id: String(params.pane_id), text: outputs.get(String(params.pane_id)) ?? "" } };
			case "pane.process_info": return { type: "pane_process_info", process_info: { pane_id: String(params.pane_id), shell_pid: 100, foreground_process_group_id: 100 } };
			case "pane.close": return { closed: true };
			case "tab.close": return { closed: true };
			default: throw new Error(`Unexpected Herdr method: ${String(request.method)}`);
		}
	});
	const context = { cwd: projectPath, hasUI: false, isProjectTrusted: () => true } as never;
	const service = new BackgroundTerminalService(new HerdrClient(server.unixPath), home);
	try {
		const quick = await service.exec({ command: "echo quick; exit 7", label: "quick command" }, context);
		assert.match(quick.task_id, /^bt_/);
		await waitUntil(async () => (await loadProjectState(projectRoot, home)).tasks[quick.task_id]?.status === "exited");
		const quickRead = await service.read({ task_id: quick.task_id, wait_ms: 0 }, context);
		assert.equal(quickRead, "quick output");
		assert.equal((await service.list({ task_id: quick.task_id }, context)).tasks[0]?.exit_code, 7);
		for (const leaked of ["( set +e", "); rc=$?", "printf '\\n", "__PI_BG_"]) assert.equal(quickRead.includes(leaked), false);

		const active = await service.exec({ command: "sleep 30", label: "interactive" }, context);
		const activeRead = await service.read({ task_id: active.task_id, wait_ms: 0 }, context);
		assert.equal(activeRead, "server ready");
		assert.equal((await service.list({ task_id: active.task_id }, context)).tasks[0]?.state, "running");
		await service.write({ task_id: active.task_id, input: "continue" }, context);
		assert.equal(requests.some((request) => request.method === "pane.send_input" && request.params.text === "continue"), true);
		const interrupted = await service.stop({ task_id: active.task_id, mode: "interrupt" }, context);
		assert.equal(interrupted.task.state, "exited");
		assert.equal(interrupted.task.exit_code, 130);

		const terminable = await service.exec({ command: "sleep 30", label: "terminable" }, context);
		const terminated = await service.stop({ task_id: terminable.task_id, mode: "terminate" }, context);
		assert.equal(terminated.task.state, "terminated");
		await assert.rejects(
			() => service.write({ task_id: terminable.task_id, input: "nope" }, context),
			/task_not_running: Background task .* is terminated\. Use background_read to inspect it or background_exec to start a new task\./,
		);

		const crashToken = "cafebabedeadbeef";
		const crashPair = markers(crashToken);
		outputs.set("crash-pane", `${crashPair.start}\nrecovered\n${crashPair.done}:0`);
		await saveProjectState({
			version: STATE_VERSION, project_root: projectRoot,
			tasks: { crash: startingTask("crash", "crash-pane", projectRoot, crashToken) },
		}, home);
		await service.recover(context);
		await waitUntil(async () => (await loadProjectState(projectRoot, home)).tasks.crash?.status === "exited");

		const offline = new BackgroundTerminalService({ enabled: false } as HerdrClient, home);
		const listed = await offline.list({ task_id: "crash" }, context);
		assert.equal(listed.tasks[0]?.state, "exited");
		const offlineRead = await offline.read({ task_id: "crash" }, context);
		assert.equal(offlineRead, "recovered");

		const closeStarted = deferred<void>();
		const closeRelease = deferred<void>();
		const slowClient = {
			enabled: true,
			paneClose: async () => { closeStarted.resolve(); await closeRelease.promise; return {}; },
			tabClose: async () => ({}),
		} as unknown as HerdrClient;
		const slowService = new BackgroundTerminalService(slowClient, home);
		const cleaning = slowService.cleanup(context, true);
		await closeStarted.promise;
		await saveProjectState({ version: STATE_VERSION, project_root: projectRoot, tasks: { concurrent: { ...startingTask("concurrent", "p-concurrent", projectRoot, "token"), status: "running" } } }, home);
		closeRelease.resolve();
		await cleaning;
		assert.ok((await loadProjectState(projectRoot, home)).tasks.concurrent, "cleanup must not overwrite a concurrent state update while closing panes");
	} finally {
		service.shutdown();
		await closeServer(server);
		await rm(home, { recursive: true, force: true });
	}
}

await runServiceIntegration();
await runTerminateWatcherRaceRegression();
console.log("service integration passed");
