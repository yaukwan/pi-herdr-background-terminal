---
title: "Exited tasks lost historical output after pane snapshots disappeared"
type: postmortem
status: closed
date: "2026-08-09"
tags: [bugfix, postmortem, herdr, background-terminal, output]
---

# Postmortem: Exited tasks lost historical output after pane snapshots disappeared

## Summary

The extension returned output from the initial `pane.read`, but stored only task metadata. Later reads depended entirely on Herdr's `recent-unwrapped` window, so an exited task could report no output after its pane snapshot was cleared or unavailable.

## Trigger

QA2 observed that quick commands, live-then-exit tasks, timeline tasks, and first-return tasks showed output from `background_exec` but returned `(no output)` from later `background_process read` calls.

## Impact

- Historical output was not reliably available after a task exited.
- The digest contract could not help because the extension had no local copy with which to answer a later read.
- The failure affected both quick commands and tasks that had first been observed while running.

## Expected Behavior

After a task has produced output, a later `read` should return the last bounded snapshot even if Herdr no longer returns the pane's historical scrollback.

## Actual Behavior

`TaskRecord` persisted command and lifecycle metadata but no output. Every `readTask` call queried `pane.read`; an empty response became an empty `TaskRead`, including for exited tasks.

## Root Cause

### Direct cause

The extension treated Herdr's `recent-unwrapped` window as the only output source and discarded the previously returned snapshot after sending it to the caller.

### Contributing factors

- `recent-unwrapped` is a bounded pane snapshot, not a durable log stream.
- The state model had `output_digest` only in the transient response and no persisted output payload.
- No regression test simulated a pane returning output once and then returning an empty snapshot.

### Missing guardrail

The integration mock always returned the same output on every `pane.read`, so it could not detect the missing local fallback.

## Fix

- Added bounded `output` and `output_truncated` fields to `TaskRecord`.
- Persisted the already-truncated display snapshot whenever `readTask` successfully reads output.
- Used the cached snapshot when a running task's pane returns empty output.
- Returned the cached snapshot directly for exited tasks, avoiding dependence on later pane scrollback.
- Extended the integration test so the first quick-task read returns output and all subsequent pane reads return empty output; the second public read must still return the cached snapshot.

The extension still uses digest comparison for response-level de-duplication. It does not claim to provide an unbounded or lossless log cursor.

## Verification

- Regression integration check failed before the fix with `"" !== "quick"`.
- Regression integration check passed after the fix.
- Existing unit tests: 17 passed.
- Repeated service integration checks: passed.
- Oxlint diagnostics: 0.
- Live Herdr quick-command, write, and interrupt checks remained passing after the state change.

## Prevention / Follow-ups

- Keep output persistence bounded by the existing 50 KB / 2000 line limits.
- Test both pane-history loss and task reload paths for historical reads.
- Preserve the distinction between a bounded last snapshot and a future true offset-based log stream.

## Changed Files

- `extensions/pi-herdr-background-terminal/index.ts`
- `extensions/pi-herdr-background-terminal/state.ts`
- `extensions/pi-herdr-background-terminal/service.integration.ts`
- `extensions/pi-herdr-background-terminal/OPTIMIZATION.md`
- `extensions/pi-herdr-background-terminal/docs/postmortem/20260809-exited-task-output-history-en.md`

## Notes

Existing state files remain compatible because the new fields are optional. They will gain an output snapshot after the next successful read.
