# ADR-006: Remove pattr, Make UI Elements Source of Truth

## Status

Accepted (implemented)

**Supersedes:** ADR-002 (restore-state-format-fix), ADR-003 (robust-state-restoration) — both dealt with pattr synchronization problems that no longer exist.

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

Remove the pattr persistence layer entirely. UI elements with `parameter_enable: 1` are the sole source of truth for persistence and initial state. The JS has no defaults — it receives all state from the UI on load.

## Changes

### Removed
- Outlet 2 (pattr state) — `outlets` changed from 3 to 2
- `broadcastToPattr()` function
- `restoreState()` global function (28-arg pattr format parser)
- `getvalueof()` / `setvalueof()` global functions (JSON pattrstorage interface)
- `initialized` flag and all checks
- Origin-based pattr conditional routing in `broadcastState()`
- All `broadcastToPattr()` calls from `handleMaxUICommand()`
- `bang()` → `init()` handler (no auto-init)
- `loadbang()` handler
- JS pushing defaults to UI on init

### Added
- `outlet(0, "request_ui_values", 1)` at end of `init()` — triggers UI re-emission
- `sendSequencerState()` — sends full state to Max UI (called from OSC handlers, init, setState)
- `sendSequencerPosition()` — sends only current step (called every tick during playback)
- `sendTemperatureState()` — sends temperature to Max UI
- UI feedback in all OSC command handlers (so Max patch reflects external changes)

### Simplified
- `broadcastState()` → just calls `broadcastToOSC()`, no conditional routing
- `handleMaxUICommand()` → renamed messages (dropped `_ui_` infix), no echo to UI
- Playback ticks → send position only, not full state dump

### Message Naming
Dropped the `_ui_` infix from inlet 2 messages for cleaner naming:
- `mute_ui_steps` → `mute_steps`
- `mute_ui_length` → `mute_length`
- `mute_ui_division` → `mute_division`
- `temperature_ui` → `temperature`
- `temperature_reset_ui` → `temperature_reset`
- `temperature_shuffle_ui` → `temperature_shuffle`

## Startup Sequence

Initialization is triggered explicitly by `live.thisdevice` (not loadbang):

```
1. live.thisdevice → init message to JS
2. Track reference established via Live API
3. Instrument type detected
4. Device observer set up
5. outlet(0, "request_ui_values", 1)     — JS requests values
6. Max patch bangs all UI elements        — They re-emit persisted values
7. handleMaxUICommand() processes each   — JS state populated from UI
8. checkAndActivateObservers() fires     — Activates if patterns non-default
9. broadcastToOSC() for each            — Svelte gets initial state
```

No race condition. No defaults. No feedback loops.

## Consequences

### Positive
- Eliminates ~100 lines of defensive synchronization code
- Removes the startup race condition entirely
- Removes feedback loop between pattr and JS
- Single source of truth for persistence (UI elements)
- Simpler mental model: UI elements persist, JS processes
- Efficient playback: only position sent per tick, not full state
- Bidirectional sync: OSC changes update Max UI, Max UI changes broadcast to OSC

### Negative
- Existing Live Sets with pattr data will ignore that data on load (UI element values win, which were always correct)
- Max patch must be updated to handle `request_ui_values` and route outlet 0 messages to UI elements

### Neutral
- OSC `set/state` command still works via `setState()` (no pattr involvement)
- `getState()` debugging utility retained
- Origin tags on OSC broadcasts retained for frontend echo filtering

### Known Issue
The Svelte frontend's echo filtering skips all non-position/init broadcasts, which means Max UI changes are never reflected in Svelte. See `docs/api.md` "Echo Filtering" section.
