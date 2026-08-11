---
title: "Herdr input submission and interrupt reconciliation failures"
type: postmortem
status: closed
date: "2026-08-09"
tags: [bugfix, postmortem, herdr, background-terminal]
---

# Postmortem: Herdr input submission and interrupt reconciliation failures

## Summary

`pi-herdr-background-terminal` treated Herdr request acceptance as proof that terminal input and process control had completed. New-pane commands could remain unsubmitted, completion waits could match the echoed command before execution, and `Ctrl+C` could stop the foreground process without emitting the completion marker needed to update task state.

## Trigger

QA found three related symptoms:

- an instant command such as `echo ...; exit 7` remained `running` and returned only the echoed command text
- `background_process write` returned `input accepted` without producing a response
- `background_process interrupt` returned `interrupt accepted` while the task continued running

## Impact

- Short commands could appear permanently running or return before their exit code was available.
- Submitted interactive input could remain buffered in the terminal instead of reaching the foreground command.
- `Ctrl+C` stopped the foreground process, but the task registry remained `running`, leaving pane termination as the only visible reliable stop operation.

Long-running commands could appear partially functional because their output was readable even while submission and completion tracking were incorrect.

## Expected Behavior

- Starting a task waits until the wrapped command text reaches the pane, then submits it.
- Completion waits return only after an exact `marker:<exit_code>` line appears.
- `write` submits input unless `submit: false` is requested.
- `interrupt` stops the foreground process and updates task state even when SIGINT prevents the wrapper from printing its marker.

## Actual Behavior

The extension sent text and keys together in one `pane.send_input` request:

```text
pane.send_input({ text, keys: ["enter"] })
```

The request was accepted, but on a newly created pane the command text could be echoed without the key submitting it. The service then waited for the random marker as a plain substring; that marker was already present in the echoed wrapper text, so waits returned before `marker:<exit_code>` existed. On interrupt, `ctrl+c` stopped the foreground process, but the interactive shell discarded the rest of the compound wrapper before it printed the marker.

## Root Cause

### Direct causes

- Task startup did not establish a readiness boundary between writing command text and submitting it.
- Completion detection used a substring that also appeared in the shell's command echo.
- Interrupt state depended exclusively on the completion marker, although SIGINT could prevent that marker from being emitted.

### Contributing factors

- Herdr request success acknowledges API handling, not shell-level execution or process completion.
- The command wrapper embeds the completion marker in both the submitted command and its eventual output record.
- The integration mock immediately executed any accepted input and always generated an interrupt marker, unlike the real PTY and interactive shell.

### Missing guardrail

No live-socket acceptance test covered quick completion, interactive input, and SIGINT state reconciliation together. The service mock lacked separate text, key, foreground-process, and completion states.

## Fix

- Split logical input into `pane.send_input` for text followed by a separate `pane.send_keys` request.
- Added a startup barrier that waits for the random marker to appear in the echoed command before sending `enter`.
- Changed completion waits to an exact-line regex for `marker:-?digits`, preventing command echo from satisfying completion.
- Added typed `pane.process_info` support.
- After `ctrl+c`, the service polls for either a normal completion marker or the foreground process group returning to the shell. The latter is persisted as `exited` with code `130`.
- Preserved a confirmed exited state during later reads even when no marker exists.
- Expanded the service integration mock to model pending text, separate key submission, completion matching, shell foreground state, submitted and non-submitted writes, interrupt without a marker, and forced pane termination.

## Verification

The regression checks failed before the production changes in three distinct ways:

```text
pane.send_input still included keys instead of separating text and control input
completion wait sequence was substring -> substring instead of substring -> regex
interrupt returned running when process_info showed the shell was foreground
```

After the fix:

- Bun unit tests: 17 passed
- Service integration check: passed repeatedly
- Live Herdr quick command: `exited`, code `9`, expected output present
- Live Herdr interactive write: `exited`, code `0`, submitted input present in output
- Live Herdr interrupt: accepted, `exited`, code `130`, shell confirmed as foreground
- Oxlint LSP diagnostics: 0 across the changed TypeScript files

## Prevention / Follow-ups

- Keep the service mock behavior-dependent: text receipt, key submission, command completion, and shell foreground state are separate transitions.
- Completion matchers must target the emitted result line, not tokens also present in submitted command text.
- Preserve live Herdr smoke coverage for quick exit, interactive write, and interrupt because API acceptance alone cannot prove PTY behavior.
- Preserve coverage for both `submit: true` and `submit: false`.

## Changed Files

- `extensions/pi-herdr-background-terminal/index.ts`
- `extensions/pi-herdr-background-terminal/herdr-client.ts`
- `extensions/pi-herdr-background-terminal/service.integration.ts`
- `extensions/pi-herdr-background-terminal/docs/postmortem/20260809-herdr-input-and-interrupt-reconciliation-en.md`

## Notes

No cwd, workspace-recovery, or pane-termination changes were required. The fix intentionally retains lowercase `enter` and `ctrl+c`, which are the key names accepted by the running Herdr daemon's `pane.send_keys` path.
