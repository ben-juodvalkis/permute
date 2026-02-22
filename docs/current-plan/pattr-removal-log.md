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

## Remaining: Max Patch Wiring

The Max patch needs to be rewired to match the JS's 3-inlet / 2-outlet architecture. See the complete wiring reference with diagrams and message formats:

**Wiring reference:** `.claude/plans/dazzling-leaping-neumann.md`

Key tasks:
- [ ] Wire transport chain (metro → transport → prepend song_time) to **inlet 0**
- [ ] Wire OSC bridge to **inlet 1**
- [ ] Rename prepends to `mute_ui_steps`, `mute_ui_length`, `mute_ui_division` and wire to **inlet 2**
- [ ] Add `[i]` objects between `live.text` buttons and `join` (for re-emission)
- [ ] Add `[route request_ui_values]` → `[defer]` → `[t b b b]` on **outlet 0** to bang UI elements on load
- [ ] Wire `[route state_broadcast]` on **outlet 1** to OSC bridge
- [ ] Add pitch UI elements (same pattern as mute with `pitch_ui_*` prefixes)
- [ ] Verify temperature dial has `parameter_enable: 1` and wires through `[prepend temperature_ui]` to inlet 2

---

## Verification Checklist

- [ ] Save/load test: non-default patterns + temperature persist across Live Set save/load
- [ ] OSC round-trip: OSC changes reflect in Max UI; UI changes broadcast via OSC
- [ ] Transport test: start/stop with active patterns works correctly
- [ ] Temperature test: temperature > 0 persists and note swaps function
- [ ] Multiple devices: independent persistence for 2+ Permute devices
