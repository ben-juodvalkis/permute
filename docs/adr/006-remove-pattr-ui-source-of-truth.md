# ADR-006: Remove pattr, Make UI Elements Source of Truth

## Status

Accepted

## Context

The Permute device maintained state in three redundant places:

1. **JS in-memory** — the runtime authoritative state
2. **pattr storage** — persistence via outlet 2 (28-arg flat format) and `getvalueof`/`setvalueof` (JSON)
3. **Max UI elements** — all with `parameter_enable: 1`, which auto-persist with the Live Set

This triple-state architecture required extensive synchronization code:
- `initialized` flag to gate pattr output during startup
- Origin-based conditional broadcasting (`pattr_restore`, `init`, `position` checks)
- Feedback loop prevention (unchanged-pattern comparison, origin filtering)
- Startup race condition guards (`restoreState()` fires before `init()`)
- Two separate restore paths (`restoreState()` for 28-arg list, `setvalueof()` for JSON)

The pattr layer was entirely redundant — UI elements already auto-persist via `parameter_enable: 1`.

## Decision

Remove the pattr persistence layer entirely. UI elements with `parameter_enable: 1` are the sole source of truth for persistence. On device load, `init()` sends `request_ui_values` via outlet 0, triggering the Max patch to re-emit all UI element values to the JS via inlet 2.

## Changes

### Removed
- Outlet 2 (pattr state) — `outlets` changed from 3 to 2
- `broadcastToPattr()` function
- `restoreState()` global function (28-arg pattr format parser)
- `getvalueof()` / `setvalueof()` global functions (JSON pattrstorage interface)
- `initialized` flag and all checks
- Origin-based pattr conditional routing in `broadcastState()`
- All `broadcastToPattr()` calls in `handleMaxUICommand()`

### Added
- `outlet(0, "request_ui_values", 1)` at end of `init()` — triggers UI elements to re-emit persisted values

### Simplified
- `broadcastState()` — now just calls `broadcastToOSC()`, no conditional routing

## New Startup Sequence

```
1. init() fires                              — Live API ready
2. Track reference established
3. checkAndActivateObservers()               — No patterns yet (defaults)
4. broadcastState('init')                    — Defaults to OSC
5. outlet(0, "request_ui_values", 1)         — JS requests values
6. Max patch triggers all UI elements        — They re-emit persisted values
7. handleMaxUICommand() processes each       — Updates sequencer state
8. broadcastToOSC() for each                 — Notifies Svelte UI
9. checkAndActivateObservers() fires         — Activates if patterns non-default
```

No race condition. No `initialized` flag. No pattr feedback loops.

## Max Patch Changes Required

1. Remove pattr routing objects (`[route pattr_state]`, `[prepend restoreState]`, `[pattr]` objects)
2. Remove patchcords from old outlet 2
3. Add `[route request_ui_values]` on outlet 0 to trigger all UI elements to re-emit their values to inlet 2

## Consequences

### Positive
- Eliminates ~100 lines of defensive synchronization code
- Removes the startup race condition entirely
- Removes feedback loop between pattr and JS
- Single source of truth for persistence (UI elements)
- Simpler mental model: UI elements persist, JS processes

### Negative
- Existing Live Sets with pattr data will ignore that data on load (UI element values win, which were always correct)
- Max patch must be updated to handle `request_ui_values` trigger

### Neutral
- OSC `set/state` command still works via `setState()` (no pattr involvement)
- `getState()` debugging utility retained
- Origin tags on OSC broadcasts retained for frontend echo filtering
