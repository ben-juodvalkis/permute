# Log: Remove pattr, UI Elements as Source of Truth

**ADR:** `docs/adr/006-remove-pattr-ui-source-of-truth.md`
**Status:** In Progress
**Created:** 2026-02-21

---

## Goal

Remove the pattr persistence layer and rely on Max UI elements with `parameter_enable: 1` for state persistence. This eliminates triple-state synchronization, the startup race condition, and ~100 lines of defensive code.

---

## Completed

### JS Changes (permute-device.js)

- [x] Changed `outlets = 3` to `outlets = 2` (removed pattr outlet)
- [x] Removed `this.initialized` flag (constructor, init, restoreState, setvalueof)
- [x] Removed `broadcastToPattr()` function
- [x] Removed `restoreState()` global function (28-arg pattr parser)
- [x] Removed `getvalueof()` / `setvalueof()` global functions
- [x] Simplified `broadcastState()` — now just calls `broadcastToOSC()`
- [x] Removed 5x `this.broadcastToPattr()` calls from `handleMaxUICommand()`
- [x] Added `outlet(0, "request_ui_values", 1)` at end of `init()`
- [x] Updated all JSDoc and comments referencing pattr

### Documentation

- [x] Created ADR-006: `docs/adr/006-remove-pattr-ui-source-of-truth.md`
- [x] Updated `docs/api.md` — removed pattr_restore origin, updated persistence section
- [x] Updated `CLAUDE.md` — updated initialization lifecycle, removed pattr references

---

## Remaining (Max patch — user does in Max editor)

- [ ] Remove pattr routing objects (`[route pattr_state]`, `[prepend restoreState]`, `[pattr]` objects)
- [ ] Remove patchcords from old outlet 2
- [ ] Add `[route request_ui_values]` on outlet 0 to trigger all UI elements to re-emit their values to inlet 2
- [ ] Verify temperature live.dial has `parameter_enable` and wiring through `[prepend temperature_ui]`

---

## Verification Checklist

- [ ] Save/load test: non-default patterns + temperature persist across Live Set save/load
- [ ] OSC round-trip: OSC changes reflect in Max UI; UI changes broadcast via OSC
- [ ] Transport test: start/stop with active patterns works correctly
- [ ] Temperature test: temperature > 0 persists and note swaps function
- [ ] Multiple devices: independent persistence for 2+ Permute devices
