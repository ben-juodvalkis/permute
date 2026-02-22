# Log: Remove pattr, UI Elements as Source of Truth

**ADR:** `docs/adr/006-remove-pattr-ui-source-of-truth.md`
**Status:** In Progress
**Created:** 2026-02-21

---

## Goal

Remove the pattr persistence layer, simplify messaging, and make UI elements the sole source of truth for state and persistence.

---

## Completed

### Phase 1: pattr Removal (JS)

- [x] Changed `outlets = 3` to `outlets = 2` (removed pattr outlet)
- [x] Removed `this.initialized` flag
- [x] Removed `broadcastToPattr()`, `restoreState()`, `getvalueof()`, `setvalueof()`
- [x] Simplified `broadcastState()` — now just calls `broadcastToOSC()`
- [x] Added `outlet(0, "request_ui_values", 1)` at end of `init()`

### Phase 2: Simplified Messaging

- [x] Renamed inlet 2 messages: dropped `_ui_` infix (`mute_ui_steps` → `mute_steps`, etc.)
- [x] Renamed temperature messages: `temperature_ui` → `temperature`, `temperature_reset_ui` → `temperature_reset`, `temperature_shuffle_ui` → `temperature_shuffle`
- [x] Added `mute_length`, `mute_division`, `pitch_length`, `pitch_division` output on outlet 0
- [x] Added `temperature` output on outlet 0 (`sendTemperatureState()`)
- [x] OSC command handlers now send UI feedback via `sendSequencerState()` / `sendTemperatureState()`

### Phase 3: Efficient Feedback

- [x] Split feedback: `sendSequencerPosition()` (position only, every tick) vs `sendSequencerState()` (full state, on change only)
- [x] Transport tick only sends `mute_current` / `pitch_current` — no pattern/length/division resend
- [x] Max UI commands don't echo back to UI (UI already shows correct value)
- [x] OSC commands DO update UI (Max needs to reflect external changes)
- [x] Skip-if-unchanged guards on division handler (prevents feedback loops)

### Phase 4: UI as Source of Truth

- [x] Removed JS defaults being pushed to UI on init
- [x] Removed `bang()` → `init()` handler (no auto-init)
- [x] Removed empty `loadbang()` handler
- [x] `init()` now triggered explicitly by `live.thisdevice`
- [x] `init()` only sets up track ref + observers, then requests UI values

### Documentation

- [x] Created ADR-006
- [x] Rewrote `docs/api.md` as complete communication reference with data flow diagrams
- [x] Documented echo filtering problem for Svelte frontend

---

## Remaining

### Max Patch Wiring

- [ ] Wire transport chain to inlet 0
- [ ] Wire OSC bridge to inlet 1
- [ ] Rename prepends to `mute_steps`, `mute_length`, `mute_division` (no `_ui_` infix) and wire to inlet 2
- [ ] Same for pitch: `pitch_steps`, `pitch_length`, `pitch_division`
- [ ] Wire `[prepend temperature]` to inlet 2
- [ ] Add `[route request_ui_values]` → `[defer]` → bang UI elements on outlet 0
- [ ] Route `mute_step_0`..`mute_step_7` from outlet 0 to `live.text` buttons
- [ ] Route `mute_length`, `mute_division` from outlet 0 to `live.dial` elements
- [ ] Same for pitch on outlet 0
- [ ] Route `temperature` from outlet 0 to temperature dial
- [ ] Route `state_broadcast` from outlet 1 to OSC bridge
- [ ] Connect `live.thisdevice` to send `init` to JS

### Svelte Echo Filtering Fix

The Svelte frontend currently skips ALL non-position/init broadcasts. This means changes from the Max UI are never reflected in Svelte. The frontend needs smarter echo filtering — see `docs/api.md` "Echo Filtering" section for recommended approaches.

### Verification

- [ ] Save/load: non-default patterns + temperature persist across Live Set save/load
- [ ] OSC → Max UI: OSC commands update Max UI elements
- [ ] Max UI → OSC: Max UI changes broadcast to Svelte
- [ ] Svelte → Max UI: Svelte commands update Max UI elements
- [ ] Transport: start/stop with active patterns works correctly
- [ ] Temperature: persists and note swaps function
- [ ] Multiple devices: independent persistence
