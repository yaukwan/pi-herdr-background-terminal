# pi-herdr-background-terminal 工具协议

## 1. 目标

扩展将 Herdr 的可见 pane 作为后台任务执行后端，并将项目级任务摘要和有界输出独立持久化。公共协议由五个职责单一工具组成：创建、列表、读取、写入、停止。

公共工具是 breaking change：不再注册 `background_process`，不接受旧 action 参数，也不提供参数转换。

## 2. 公共工具

### `background_exec`

```ts
{
  command: string;
  cwd?: string;
  label?: string;
}
```

创建 pane、提交命令并挂载 watcher，成功时只返回不透明 `task_id`。它不等待初始输出，也不读取 pane。

- `command` trim 后非空，UTF-8 最大 64 KB。
- 相对 `cwd` 按 `ctx.cwd` 解析，realpath 必须位于项目根内。
- `label` 为 1-80 个字符。
- 命令的非零退出由任务状态表达，不是工具调用错误。
- Herdr、cwd 或提交失败属于基础设施错误，工具调用直接失败。

### `background_list`

```ts
{
  task_id?: string;
  cursor?: string;
  limit?: number;
}
```

从项目状态文件读取任务摘要，不调用 `HerdrClient.ping()`，因此 Herdr 离线时仍可列出任务。传 `task_id` 时只返回该任务（不存在则返回空数组）；不传时默认 25 条、最大 100 条，cursor 是 `(updated_at, task_id)` 的 keyset cursor。

```ts
{
  tasks: Array<{
    task_id: string;
    label: string;
    state: "starting" | "running" | "exited" | "terminated" | "failed" | "orphaned";
    exit_code?: number;
    updated_at: string;
    output_truncated?: boolean;
    error?: { code: string; message: string; retryable: boolean };
  }>;
  next_cursor?: string;
}
```

### `background_read`

```ts
{
  task_id: string;
  wait_ms?: number;
  output_lines?: number;
}
```

只读取单任务的纯控制台输出，不附加 task header、状态或 `details`。默认等待 5 秒，最大 300 秒；默认返回 120 行，最大 2000 行。任务状态、退出码和截断元数据通过 `background_list({ task_id })` 查询。

终态任务只读取本地 canonical output，不要求 Herdr 在线。活动任务才 ping、等待和读取 Herdr。输出按当前响应投影；任务归档输出固定保留最近 2000 行或 50 KB，不会因较小的 `output_lines` 请求缩短。

### `background_write`

```ts
{
  task_id: string;
  input: string;
  submit?: boolean;
}
```

只允许 `starting` 或 `running` 任务。`input` 的 UTF-8 最大 64 KB，`submit` 默认为 `true`。它发送 pane 的 PTY 键盘输入，不是目标进程的可靠 stdin 管道：命令已经退出、shell 已回到前台或目标程序未读取终端时，输入会由 shell 消费。自动化 CLI 交互需要目标进程明确使用 PTY 并处于读取状态。终态任务抛出：

```text
task_not_running: Background task bt_x is exited. Use background_read to inspect it or background_exec to start a new task.
```

### `background_stop`

```ts
{
  task_id: string;
  mode: "interrupt" | "terminate";
}
```

- `interrupt` 发送 `Ctrl+C` 并按 shell foreground 状态收敛；已确认中断的退出码为 130。
- `terminate` 先停止本实例 watcher、保存最终快照，再关闭 pane；`terminated` 是不可回退的终态，迟到的 pane-not-found 事件不得覆盖为 `orphaned`。
- Herdr 当前协议只提供 `pane.close`，扩展不声称能够向整个子进程组发送信号或确认 daemon 已退出；这需要 Herdr 提供相应的进程组控制与查询接口。
- 已终态任务返回幂等结果，不再次发送控制操作。

不会公开 workspace、tab 或 pane ID。

## 3. 生命周期与输出

公开状态包含 `starting`：

```text
starting -> running -> exited
starting -> failed | orphaned
running  -> terminated | orphaned
```

每个新任务使用同一随机 token 派生两行 marker：

```text
__PI_BG_<token>_START__
__PI_BG_<token>_DONE__:<exit-code>
```

仅精确 start marker 后、done marker 前的行属于模型可见任务输出。wrapper 回显、shell prompt、`set +e`、`printf` 和 marker 均不会进入 canonical output 或工具文本。start marker 尚未出现时任务保持 `starting`，不回传原始 pane 内容。

恢复时：

1. 已释放资源的终态任务不会访问 Herdr；旧的未释放终态任务会补偿关闭 pane/tab。
2. `starting` 任务发现 done marker 后归档为 `exited`，发现 start marker 后转为 `running`。
3. pane 不存在时转为 `orphaned`。
4. shell 已回到前台但没有 start marker 时转为 `failed`，错误码为 `launch_incomplete`。
5. foreground 仍有进程时重新挂载 watcher。

同一任务的 read/write/stop/watcher 在进程内串行；不同任务仍可并行。终态状态是吸收态：迟到 watcher 或其他服务实例的 pane-not-found 事件不会把 `exited`、`terminated`、`failed` 或 `orphaned` 覆盖为另一状态。watcher 的非重试错误会写入结构化 `failed` 状态，不会静默丢失监控责任。

任务进入终态并成功保存 canonical output 后，扩展自动关闭对应 pane 和 tab，再写入内部 `resources_released_at` 标记。关闭操作将 pane/tab/workspace not-found 视为幂等成功；其他错误由 watcher 重试，或在下次 session 恢复时补偿。任务元数据和归档输出继续保留，因此终态 `background_list` 和 `background_read` 不依赖 Herdr 资源。`/bg focus` 对已释放资源的任务返回 `task_archived` 导航错误。

## 4. 状态、安全与清理

状态目录：

```text
~/.pi/pi-herdr-background-terminal/<project-hash>/
├── tasks.json
├── tasks.lock
└── outputs/
    └── <task-hash>.txt
```

`tasks.json` 只保存元数据；`command` 仅用于本地诊断，属于 0600 明文数据。完整输出不写入任务摘要。加载时逐条校验 `TaskRecord`，无效记录会被明确拒绝且错误不回显任务正文。

所有公共工具、`/bg focus` 和 `/bg clean --confirm` 都先执行项目可信校验。task ID、cursor、cwd、command 和 input 均有运行时边界；task ID 作为不透明值处理，不参与路径推导。

项目锁只保护本地状态。Herdr 网络调用不在 `withProjectLock()` 内执行。`/bg clean --confirm` 的顺序是：短锁读取终态快照，锁外补偿释放尚未关闭的资源，短锁确认并删除仍为终态的记录，锁外删除输出文件。日常 pane/tab 回收由终态归档流程自动完成，clean 主要用于删除历史。

陈旧锁超过 30 秒后还会检查 owner PID；存活 PID 的锁不会仅因 mtime 被删除。

`/bg clean --confirm` 删除扩展状态和输出文件，不删除 Pi session 历史，也不会终止运行任务。

## 5. 验证

```bash
bun test index.test.ts
bun service.integration.ts
```

测试覆盖五工具注册、运行时输入边界、双 marker 输出裁剪、逐任务状态校验、相对 cwd、项目锁、快速非零退出、终态 pane/tab 自动释放、交互输入、中断、终止、terminate 与迟到 watcher 的跨服务竞态、starting 恢复、终态资源补偿回收、终态离线 list/read、终态 write 拒绝和 cleanup 与并发状态更新。

不实现 SQLite、无界日志、假增量 cursor、token 输出预算、CPU/RSS/PID 统计、模型可调用 bulk clean 或旧 `background_process` 兼容层。
