---
title: "Terminate watcher state regression"
type: postmortem
status: closed
date: "2026-08-11"
tags: [bugfix, postmortem, background-terminal]
---

# Postmortem: Terminate watcher state regression

## Summary
A completed `background_stop(mode="terminate")` could later appear as `orphaned` when a delayed watcher received `pane_not_found` after the pane had been closed.

## Trigger
QA started a long-running command, terminated it, then read the task. The stop call returned `terminated`, while the later read reported `orphaned`.

## Impact
The persisted task state no longer matched the completed control operation. This obscured the user's explicit terminate result and made cleanup or diagnosis misleading. It did not prove that a child process survived pane closure; the extension had no process-group visibility for that claim.

## Expected Behavior
`terminated` is terminal and must remain terminal after a successful terminate operation. A stale watcher must not downgrade it when pane closure makes the pane unavailable.

## Actual Behavior
`orphanTask()` unconditionally wrote `orphaned`. A watcher that was still waiting for output could receive `pane_not_found` after another service instance had persisted `terminated`, then overwrite the state.

## Root Cause
The persistent state transition for `orphaned` lacked a terminal-state guard. In-process watcher cancellation reduced the race window but could not protect project state from a watcher owned by a separate extension service instance.

## Fix
- Stop the local watcher before the terminate snapshot and pane close sequence.
- Make `orphanTask()` retain any existing terminal state instead of overwriting it.
- Add a service integration regression that uses separate watcher and control service instances against shared project state, then injects `pane_not_found` after terminate.

## Verification
- The new integration regression was red before the guard: it deterministically changed `terminated` to `orphaned`.
- `bun service.integration.ts` passes after the fix.
- `bun test index.test.ts` passes.
- Oxlint reports zero diagnostics for the changed TypeScript files.

## Prevention / Follow-ups
- Treat all public terminal states as absorbing in lifecycle update helpers unless an explicit transition is documented.
- Preserve the PTY boundary: `background_write` is terminal keyboard input, not a process stdin pipe.
- Herdr currently exposes only pane close. Add process-group termination verification only if Herdr adds an explicit process-control and process-query API.

## Changed Files
- extensions/pi-herdr-background-terminal/index.ts
- extensions/pi-herdr-background-terminal/service.integration.ts
- extensions/pi-herdr-background-terminal/docs/OPTIMIZATION.md
- extensions/pi-herdr-background-terminal/docs/postmortem/20260811-terminate-watcher-state-regression-en.md

## Notes
The regression addresses state correctness, not a claim about daemon or child-process cleanup. The latter is outside the current Herdr client protocol.
