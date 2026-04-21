# Permute - Claude Code Context

This file provides context for Claude Code when working on the Permute project.

## Project Overview

Permute is a Max4Live device that provides mute sequencing, pitch sequencing, and temperature-based organic variation for Ableton Live clips. It was extracted from the Looping project to be a standalone, reusable device.

## Key Files

| File | Purpose |
|------|---------|
| `permute-device.js` | Main controller - SequencerDevice, Max handlers |
| `permute-constants.js` | Constants, TRANSPOSE_CONFIG, VALUE_TYPES, ENUM_RATES |
| `permute-utils.js` | Debug, error handling, LiveAPI helpers |
| `permute-sequencer.js` | Generic Sequencer class (pattern/timing) |
| `permute-observer-registry.js` | ObserverRegistry for Live API observers |
| `permute-state.js` | TrackState, ClipState, TransportState classes |
| `permute-instruments.js` | Instrument detection, transpose strategies |
| `permute-shuffle.js` | Fisher-Yates shuffle, swap pattern generation |
| `permute-temperature.js` | Temperature mixin (applied to SequencerDevice prototype) |
| `permute-chance.js` | Chance/note probability mixin (applied to SequencerDevice prototype) |
| `Permute.amxd` | Max4Live device file (load this in Ableton) |
| `Permute.maxpat` | Max patch (UI and routing) |
| `docs/api.md` | **Complete communication reference** — inlets, outlets, rate enum |
| `docs/adr/` | Architecture decision records |

## Communication Architecture

See `docs/api.md` for the complete reference. Summary:

### JS Interface: 2 Inlets, 1 Outlet

| Port | Purpose | Messages |
|------|---------|----------|
| Inlet 0 | Transport | `song_time <ticks>` |
| Inlet 1 | Max UI | `mute_step N v`, `mute_length v`, `mute_rate i`, `pitch_step N v`, `pitch_length v`, `pitch_rate i`, `temperature v`, `chance v` |
| Outlet 0 | Position display | `mute_current <step>`, `pitch_current <step>` |

`live.*` UI objects with `parameter_enable: 1` own their own values. Live handles persistence, automation, undo, and Push mapping. JS never echoes values back.

## Initialization

Triggered by `live.thisdevice`. `live.*` UI objects emit their stored values into inlet 1 on instantiation; JS populates state from those emissions. No handshake, no `request_ui_values`. See `docs/adr/010-ui-native-revamp.md`.

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

### Temperature Transformation (v3.1)

Uses note ID tracking for reversible pitch swapping:
- Captures original pitches by `note_id` when temp goes 0→>0
- Restores original pitches when temp goes >0→0
- Handles overdubbing (new notes preserved) and deletion gracefully

### Note Chance (v3.2)

Sets `note.probability` on all notes in the current clip (MIDI only):
- Value 0.0–1.0 (0=never, 1=always play)
- Applied immediately on value change, on clip change, and on transport start
- Restored to 1.0 on transport stop

## Common Development Tasks

### Enable Debug Logging
In `permute-utils.js`:
```javascript
var DEBUG_MODE = true;
```

### Test Changes
1. Save the changed file(s)
2. If only `permute-device.js` changed, saving triggers `autowatch` reload
3. If a module file changed, delete and re-add `Permute.amxd` to reload (autowatch only watches the main file)
4. Check Max console for errors/debug output

### Add New UI Control
1. Add the `live.*` object to the patcher with `parameter_enable: 1` and a long name
2. Prepend its output with a new message name and merge into inlet 1
3. Add a handler branch in `handleMaxUICommand` in `permute-device.js`
4. Update `docs/api.md`

## Documentation Maintenance

| Change Type | Update |
|-------------|--------|
| Messaging change | `docs/api.md` |
| Architecture change | Create new ADR in `docs/adr/` |

## Instrument Detection

Scans for transpose parameters by name (case-insensitive):
1. "custom e" (shift: 21)
2. "pitch" (shift: 16)
3. "transpose" (shift: 16)
4. "octave" (shift: 16)

If found, uses parameter-based shifting. Otherwise, modifies note pitches directly.
