# Permute - Claude Code Context

This file provides context for Claude Code when working on the Permute project.

## Project Overview

Permute is a Max4Live device that provides mute sequencing, pitch sequencing, and temperature-based organic variation for Ableton Live clips. It was extracted from the Looping project to be a standalone, reusable device.

## Key Files

| File | Purpose |
|------|---------|
| `permute-device.js` | Main device controller (~1740 lines) - init, transport, batching, state |
| `permute-constants.js` | Constants, config, value types |
| `permute-utils.js` | Debug, error handling, observer creation, tick calculation |
| `permute-sequencer.js` | `Sequencer` class (pattern, timing, step progression) |
| `permute-observer-registry.js` | `ObserverRegistry` class |
| `permute-state.js` | `TrackState`, `ClipState`, `TransportState` |
| `permute-instruments.js` | `InstrumentDetector`, transpose strategy classes |
| `permute-commands.js` | `CommandRegistry` class |
| `permute-shuffle.js` | Pure shuffle/swap functions for temperature |
| `permute-temperature.js` | Temperature mixin (capture/restore/loop jump) |
| `Permute.amxd` | Max4Live device file (load this in Ableton) |
| `Permute.maxpat` | Max patch (UI and routing) |
| `README.md` | User-facing documentation |
| `docs/api.md` | OSC command and broadcast reference |
| `docs/extraction-plan.md` | Extraction plan from Looping |
| `docs/adr/` | Architecture decision records |
| `docs/reference/` | Historical ADRs from Looping repo |

## Architecture

### Delta-Based State Tracking (v3.0)

The device tracks `lastValues` per clip and applies deltas only on change:
- `0→1`: Apply transformation (shift up, mute)
- `1→0`: Reverse transformation (shift down, unmute)
- `0→0` or `1→1`: No action

This eliminated ~30% of code compared to the previous pristine-state approach.

### Key Classes

- `SequencerDevice` - Main device controller
- `Sequencer` - Generic pattern/timing wrapper
- `TransposeStrategy` - Parameter-based pitch shifting
- `ObserverRegistry` - Centralized Live API observer management
- `CommandRegistry` - Message dispatch pattern

### Lazy Observer Activation (v6.0)

Transport and time signature observers are only created when a sequencer becomes active (pattern has non-default values). This reduces CPU overhead for idle devices.

### Temperature Transformation (v3.1)

Uses note ID tracking for reversible pitch swapping:
- Captures original pitches by `note_id` when temp goes 0→>0
- Restores original pitches when temp goes >0→0
- Handles overdubbing (new notes preserved) and deletion gracefully

## OSC Namespace

All messages use `/looping/sequencer/` prefix (retained for Looping compatibility).

Key addresses:
- `/looping/sequencer/mute/step` - Toggle mute step
- `/looping/sequencer/pitch/step` - Toggle pitch step
- `/looping/sequencer/temperature` - Set temperature
- `/looping/sequencer/set/state` - Full state sync
- `/looping/sequencer/state` - Broadcast (output)

See `docs/api.md` for complete reference.

## State Broadcast Format

29 arguments: `[trackIndex, origin, mutePattern[8], muteLength, muteDivision[3], mutePosition, pitchPattern[8], pitchLength, pitchDivision[3], pitchPosition, temperature]`

Origin tags enable echo filtering - see `docs/api.md` for details.

## Common Development Tasks

### Enable Debug Logging
In `permute-device.js` line ~106:
```javascript
var DEBUG_MODE = true;
```

### Test Changes
1. Save `permute-device.js`
2. In Ableton, delete and re-add `Permute.amxd` to reload
3. Check Max console for errors/debug output

### Add New OSC Command
1. Add handler in `setupCommandHandlers()` method
2. Add global function to expose it to Max
3. Update `docs/api.md` with new command

### Modify State Broadcast
1. Update `broadcastState()` method
2. Update `restoreState()` for pattr compatibility
3. Update `docs/api.md` format table

## Documentation Maintenance

When making changes, update these docs as needed:

| Change Type | Update |
|-------------|--------|
| New feature | README.md, docs/api.md if OSC involved |
| API change | docs/api.md |
| Architecture change | Create new ADR in docs/adr/ |
| Bug fix | CHANGELOG.md (when created) |

## Origin

Extracted from the Looping repository. See:
- `docs/adr/001-extraction-from-looping.md` - Extraction decision
- `docs/extraction-plan.md` - Detailed extraction plan
- `docs/reference/` - Original ADRs from Looping

## Instrument Detection

The device scans for transpose parameters by name (case-insensitive):
1. "custom e" (shift: 21)
2. "pitch" (shift: 16)
3. "transpose" (shift: 16)
4. "octave" (shift: 16)

If found, uses parameter-based shifting. Otherwise, modifies note pitches directly.
