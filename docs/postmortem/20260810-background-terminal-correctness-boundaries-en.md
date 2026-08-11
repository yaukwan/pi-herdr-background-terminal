---
title: "Background terminal correctness boundaries"
type: postmortem
status: closed
date: "2026-08-10"
tags: [bugfix, postmortem]
---

# Postmortem: Background terminal correctness boundaries

## Summary

Background task interactions could overlap, small reads could replace recoverable output, long-running watchers could silently stop, and an unterminated Herdr response frame could grow without bound.

## Trigger

Code review against Pi's parallel tool execution model and the Codex unified-exec interaction model exposed the missing task-level serialization and output ownership boundaries.

## Impact

- Concurrent read, write, interrupt, terminate, status, and watcher finalization could race on one pane.
- A one-line status probe or small model-facing read could permanently reduce the saved output snapshot.
- Tasks running longer than one watcher window could exit without persisted final status or UI notification.
- A malformed or hostile Herdr peer could keep increasing the client response buffer.

## Expected Behavior

Operations for one task are serialized while different tasks remain concurrent. Model output limits only affect the current response, terminal tasks retain the largest bounded snapshot, watchers retain responsibility until terminal state, and socket frames have a hard size limit.

## Actual Behavior

Only project state writes were locked. `readTask()` combined waiting, pane reads, persistence, and response projection. Watchers performed one 24-hour wait and then removed themselves. `HerdrClient.request()` buffered until a newline with no byte limit.

## Root Cause

- The project file lock protected JSON consistency but was incorrectly treated as sufficient coordination for pane interactions.
- Request-specific `output_lines` was reused as the persistence capture budget.
- Watch timeout was treated as watcher completion instead of a normal re-arm event.
- The NDJSON parser validated complete lines but did not constrain an incomplete line.
- Regression coverage focused on sequential lifecycle behavior and did not exercise parallel calls or long-lived watcher responsibility.

## Fix

- Added an abort-aware in-process interaction queue keyed by `task_id`.
- Split lifecycle probing, bounded capture, canonical persistence, and response projection.
- Finalized terminal output with the 2000-line/50KB budget and prevented smaller reads from shrinking it.
- Re-armed watchers after normal timeout, added bounded retry backoff, and orphaned missing panes.
- Rejected Herdr response frames larger than 1 MiB with `response_too_large`.
- Separated exec and read wait ranges, surfaced truncation in model text, and added navigational errors.

## Verification

- `bun test index.test.ts`: validates protocol errors, helpers, state locking, Herdr error typing, and the 1 MiB response limit.
- `bun service.integration.ts`: validates same-task serialization, cross-task concurrency, output preservation, final capture, digest de-duplication, watcher re-arm/orphaning, interrupt reconciliation, and abortable 300-second reads.
- Oxlint LSP diagnostics reported no findings in the five changed TypeScript files.

## Prevention / Follow-ups

- Keep service integration coverage at the public `BackgroundTerminalService` boundary for concurrency and lifecycle changes.
- Preserve the distinction between pane execution truth, canonical bounded state, and model-facing projection.
- Do not add task-level file locking until multiple Pi processes controlling the same task are observed.
- Keep task metadata separate from bounded output, cap active tasks at 64, and require explicit `/bg clean --confirm` for terminal history removal.

## Changed Files

- `index.ts`
- `protocol.ts`
- `herdr-client.ts`
- `index.test.ts`
- `service.integration.ts`
- `OPTIMIZATION.md`
- `state.ts`

## Notes

Herdr still exposes a recent window snapshot rather than a drainable stream. `output_digest` remains a de-duplication token, not a cursor.
