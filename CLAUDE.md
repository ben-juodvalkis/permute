# Permute - Claude Code Context

This file provides context for Claude Code when working on the Permute project.

## Project Overview

Permute is a Max4Live device that provides mute sequencing, pitch sequencing, and temperature-based organic variation for Ableton Live clips. It was extracted from the Looping project to be a standalone, reusable device.

## Key Files

| File | Purpose |
|------|---------|
| `permute-device.js` | Main controller - SequencerDevice, Max handlers |
| `permute-constants.js` | Constants, TRANSPOSE_CONFIG, VALUE_TYPES |
| `permute-utils.js` | Debug, error handling, LiveAPI helpers |
| `permute-sequencer.js` | Generic Sequencer class (pattern/timing) |
| `permute-observer-registry.js` | ObserverRegistry for Live API observers |
| `permute-state.js` | TrackState, ClipState, TransportState classes |
| `permute-instruments.js` | Instrument detection, transpose strategies |
| `permute-commands.js` | CommandRegistry (message dispatch) |
| `permute-shuffle.js` | Fisher-Yates shuffle, swap pattern generation |
| `permute-temperature.js` | Temperature mixin (applied to SequencerDevice prototype) |
| `Permute.amxd` | Max4Live device file (load this in Ableton) |
| `Permute.maxpat` | Max patch (UI and routing) |
| `docs/api.md` | **Complete communication reference** — messaging, data flows, echo filtering |
| `docs/adr/` | Architecture decision records |

## Communication Architecture

See `docs/api.md` for the complete reference. Summary:

### JS Interface: 3 Inlets, 2 Outlets

| Port | Purpose | Messages |
|------|---------|----------|
| Inlet 0 | Transport | `song_time <ticks>` |
| Inlet 1 | OSC commands | `/looping/sequencer/*` |
| Inlet 2 | Max UI values | `mute_steps`, `mute_length`, `mute_division`, `temperature`, etc. |
| Outlet 0 | UI feedback | `mute_step_0`..`7`, `mute_current`, `mute_length`, `mute_division`, `temperature`, `request_ui_values` |
| Outlet 1 | OSC broadcast | `state_broadcast` (29-arg flat format) |

### Data Flow Rules

- **Max UI changes** → JS updates state → broadcasts to OSC only (no echo to UI)
- **OSC changes** → JS updates state → sends to Max UI AND broadcasts to OSC
- **Transport ticks** → JS sends position only (`mute_current`, `pitch_current`) — no full state resend

## Initialization

Triggered explicitly by `live.thisdevice` (NOT loadbang/bang). JS has no defaults — UI elements are the source of truth.

```
live.thisdevice → init → track setup → request_ui_values → UI re-emits → JS state populated
```

See `docs/adr/006-remove-pattr-ui-source-of-truth.md`.

## Architecture

### Delta-Based State Tracking (v3.0)

Tracks `lastValues` per clip, applies deltas only on change:
- `0→1`: Apply transformation (shift up, mute)
- `1→0`: Reverse transformation (shift down, unmute)
- `0→0` or `1→1`: No action

### Key Classes

- `SequencerDevice` - Main device controller
- `Sequencer` - Generic pattern/timing wrapper
- `TransposeStrategy` - Parameter-based pitch shifting
- `ObserverRegistry` - Centralized Live API observer management
- `CommandRegistry` - Message dispatch pattern

### Lazy Observer Activation (v6.0)

Transport and time signature observers are only created when a sequencer becomes active (pattern has non-default values). Reduces CPU overhead for idle devices.

### Temperature Transformation (v3.1)

Uses note ID tracking for reversible pitch swapping:
- Captures original pitches by `note_id` when temp goes 0→>0
- Restores original pitches when temp goes >0→0
- Handles overdubbing (new notes preserved) and deletion gracefully

## Common Development Tasks

### Enable Debug Logging
In `permute-utils.js` line 16:
```javascript
var DEBUG_MODE = true;
```

### Test Changes
1. Save the changed file(s)
2. If only `permute-device.js` changed, saving triggers `autowatch` reload
3. If a module file changed, delete and re-add `Permute.amxd` to reload (autowatch only watches the main file)
4. Check Max console for errors/debug output

### Add New OSC Command
1. Add handler in `setupCommandHandlers()` method
2. Add `sendSequencerState()` / `sendTemperatureState()` call for UI feedback
3. Update `docs/api.md`

## Documentation Maintenance

| Change Type | Update |
|-------------|--------|
| Messaging change | `docs/api.md` |
| Architecture change | Create new ADR in `docs/adr/` |
| API change | `docs/api.md` |

## Instrument Detection

Scans for transpose parameters by name (case-insensitive):
1. "custom e" (shift: 21)
2. "pitch" (shift: 16)
3. "transpose" (shift: 16)
4. "octave" (shift: 16)

If found, uses parameter-based shifting. Otherwise, modifies note pitches directly.

## Known Issue: Svelte Echo Filtering

The Svelte frontend currently skips ALL non-position/init broadcasts, which means changes from the Max UI are never reflected in Svelte. See `docs/api.md` "Echo Filtering" section for the problem description and recommended fixes.
