# pi-herdr-background-terminal

A Pi coding-agent extension that runs shell commands in persistent [Herdr](https://github.com/yaukwan/herdr) terminal panes and exposes their lifecycle through background-task tools.

## Features

- Start long-running commands without blocking the current session.
- Inspect task state and bounded console output after Herdr or Pi restarts.
- Send PTY input to running tasks.
- Interrupt or terminate tasks explicitly.
- Persist task metadata and canonical output per project.
- Recover active tasks when a Pi session starts.
- Serialize interactions for the same task while allowing different tasks to run concurrently.

## Requirements

- Pi coding agent.
- A running Herdr daemon with its Unix socket available.
- Bun for the test commands below.

The extension uses `HERDR_SOCKET_PATH` when set; otherwise it defaults to:

```text
~/.config/herdr/herdr.sock
```

## Tools

| Tool | Purpose |
| --- | --- |
| `background_exec` | Start a command and return an opaque `task_id`. |
| `background_list` | List task state, exit codes, and errors. |
| `background_read` | Read a task's console output. |
| `background_write` | Send input to an active task. |
| `background_stop` | Interrupt or terminate a task. |

The `/bg` command provides the same controls interactively:

```text
/bg list
/bg read <task_id>
/bg write <task_id> <input>
/bg interrupt <task_id>
/bg terminate <task_id>
/bg focus <task_id>
/bg clean --confirm
```

## State and output

Project-local task state is stored outside the repository under:

```text
~/.pi/pi-herdr-background-terminal/<project-hash>/
```

Task metadata is kept in `tasks.json`; bounded canonical output is stored separately in `outputs/`. The extension validates project trust and keeps all task working directories inside the current project root.

See [`docs/OPTIMIZATION.md`](docs/OPTIMIZATION.md) for the complete tool protocol, lifecycle model, persistence format, and correctness boundaries.

## Development

Run the focused unit tests:

```bash
bun test index.test.ts
```

Run the Herdr-backed service integration suite:

```bash
bun service.integration.ts
```

The integration suite starts a local Unix-socket mock server and does not require a live Herdr daemon.

## License

[MIT](LICENSE)
