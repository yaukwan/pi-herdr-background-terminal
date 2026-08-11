---
title: "Stale Herdr workspace id blocked background task startup"
type: postmortem
status: closed
date: "2026-08-09"
tags: [bugfix, postmortem, herdr, background-terminal]
---

# Postmortem: Stale Herdr workspace id blocked background task startup

## Summary

`pi-herdr-background-terminal` persisted a Herdr workspace ID across Herdr lifecycles but did not recover when that workspace no longer existed. `background_exec` therefore failed before creating a task, which blocked every subsequent `background_process` lifecycle operation.

## Trigger

QA called `background_exec` twice from `/Users/cyouguang/.pi/agent`. Both calls failed with:

```text
Herdr workspace_not_found: workspace wA not found
```

No task ID was returned, so status, output, input, interrupt, and termination behavior could not be tested.

## Impact

- Every new background task in the affected project failed to start.
- Existing task records still linked to the removed workspace appeared potentially active but could no longer be controlled.
- The complete background-terminal lifecycle was unavailable until state was repaired or the extension recovered automatically.

## Expected Behavior

When the persisted workspace no longer exists, `background_exec` should create a replacement Herdr workspace, start the new task there, and classify non-terminal tasks from the removed workspace as no longer reachable.

## Actual Behavior

The startup path trusted `ProjectState.workspace_id` unconditionally. If it was present, the service called `tab.create` directly. A `workspace_not_found` response propagated as a tool error without updating state or attempting `workspace.create`.

## Root Cause

### Direct cause

`BackgroundTerminalService.start()` handled only two cases:

- no persisted workspace ID: call `workspace.create`
- persisted workspace ID: call `tab.create`

It lacked a third case for a persisted but invalid workspace ID.

### Contributing factors

- Herdr workspace IDs are scoped to a live Herdr server/session and are not durable identifiers.
- The extension state file is durable across Pi and Herdr restarts.
- The typed Herdr error layer preserved `workspace_not_found`, but no helper or service branch consumed that code.

### Missing guardrail

The service-level integration check started only from empty state. It did not pre-seed a stale workspace ID and therefore could not detect the mismatch between durable plugin state and ephemeral Herdr resources.

## Fix

- Added typed `isWorkspaceNotFound()` classification.
- Expanded pane-unavailable classification to include `pane_not_found`, `tab_not_found`, and `workspace_not_found`.
- Updated the shared task creation path to catch only `workspace_not_found` from `tab.create`.
- On that error, the service creates a replacement workspace and continues starting the requested task.
- After replacement succeeds, non-terminal tasks tied to the missing workspace are marked `orphaned` with `error_code=workspace_not_found`.
- Other Herdr errors continue to propagate without fallback.

## Verification

The service integration check now pre-seeds:

```text
workspace_id = wA
old task state = running
```

The mock Herdr server returns `workspace_not_found` for `tab.create(wA)`.

Before the fix, the check reproduced the QA failure exactly:

```text
HerdrRequestError: Herdr workspace_not_found: workspace wA not found
```

After the fix:

- a replacement workspace is created
- `background_exec` returns a running task
- the old task is listed as `orphaned`
- read and terminate behavior continue to work

Final verification:

- Bun unit tests: 17 passed, 0 failed
- Service integration check: passed
- Strict TypeScript check: passed

## Prevention / Follow-ups

- Keep external Herdr IDs classified as ephemeral even when plugin state is durable.
- Every persisted external resource ID must have a not-found recovery test.
- Only recover from the exact typed error that proves the resource disappeared; transport and protocol errors must continue to fail without mutating task state.
- Preserve the stale-workspace fixture in the service integration check.

## Changed Files

- `extensions/pi-herdr-background-terminal/index.ts`
- `extensions/pi-herdr-background-terminal/herdr-client.ts`
- `extensions/pi-herdr-background-terminal/index.test.ts`
- `extensions/pi-herdr-background-terminal/service.integration.ts`
- `extensions/pi-herdr-background-terminal/docs/postmortem/20260809-stale-herdr-workspace-id-en.md`

## Notes

The fix does not require manually clearing the project state file or switching the user to the missing workspace. The next `background_exec` call performs recovery automatically.
