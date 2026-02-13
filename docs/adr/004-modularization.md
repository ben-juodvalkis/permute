# ADR-004: Modularization into Focused Files

**Date:** 2026-02-13
**Status:** Implemented

## Context

`permute-device.js` was a ~3000-line monolith containing constants, utilities, six class definitions, pure functions, and the main device controller. This made it difficult to navigate, understand dependencies, and test individual components.

Max's `v8` object supports `require()` with CommonJS modules, with the constraint that all required files must be in the same directory (flat structure).

## Decision

Extract logical units into separate CommonJS modules, all placed alongside `permute-device.js` (flat structure per Max constraint).

### Module Structure

| Module | Contents | Dependencies |
|--------|----------|-------------|
| `permute-constants.js` | Constants, config, value types | None |
| `permute-utils.js` | Debug, error handling, observer creation, tick calculation | constants |
| `permute-sequencer.js` | `Sequencer` class | constants, utils |
| `permute-observer-registry.js` | `ObserverRegistry` class | None |
| `permute-state.js` | `TrackState`, `ClipState`, `TransportState` | None |
| `permute-instruments.js` | `InstrumentDetector`, strategy classes | constants, utils |
| `permute-commands.js` | `CommandRegistry` class | None |
| `permute-shuffle.js` | Pure shuffle/swap functions | constants, utils |
| `permute-temperature.js` | Temperature mixin (`applyTemperatureMethods`) | constants, utils, shuffle |

### Temperature Mixin Pattern

Temperature methods operate on `SequencerDevice.prototype` but are logically separate. Used a mixin pattern:

```javascript
// permute-temperature.js
function applyTemperatureMethods(proto) {
    proto.setTemperatureValue = function(value) { ... };
    proto.captureTemperatureState = function(clipId) { ... };
    // ...
}

// permute-device.js (after SequencerDevice is defined)
temperature.applyTemperatureMethods(SequencerDevice.prototype);
```

### Consolidated Pitch Offset Helper

The duplicated pitch offset calculation in `captureTemperatureState()`, `restoreTemperatureState()`, and `onTemperatureLoopJump()` was consolidated into `_getCurrentPitchOffset(clipId)`.

### Renamed `lastAppliedValue` to `lastParameterValue`

Clarified the distinction between `Sequencer.lastParameterValue` (clip-independent, for parameter-based transpose) and `SequencerDevice.lastValues[clipId]` (per-clip, for note-based operations).

### What Stays in Main File

- `require()` imports
- `autowatch`, `inlets`, `outlets`
- `SequencerDevice` constructor and core methods
- All global Max message handler functions (must be in main file for `v8` exposure)
- Global instance: `var sequencer = new SequencerDevice()`

## Consequences

### Positive
- `permute-device.js` reduced from ~3000 to ~1740 lines
- Pitch offset calculation in exactly one place (`_getCurrentPitchOffset`)
- Clear dependency graph between modules
- Shuffle functions independently testable (pure, no device coupling)
- Easier to locate and understand code sections

### Negative
- `autowatch = 1` won't detect changes in required modules (acceptable for production)
- Slight overhead from `require()` calls (negligible, runs once on load)

## Files Changed

| File | Changes |
|------|---------|
| `permute-device.js` | Added requires, removed extracted code, applied temperature mixin, renamed `lastAppliedValue` |
| `permute-constants.js` | New: constants, config, value types |
| `permute-utils.js` | New: utilities |
| `permute-sequencer.js` | New: Sequencer class |
| `permute-observer-registry.js` | New: ObserverRegistry |
| `permute-state.js` | New: TrackState, ClipState, TransportState |
| `permute-instruments.js` | New: InstrumentDetector, strategies |
| `permute-commands.js` | New: CommandRegistry |
| `permute-shuffle.js` | New: pure shuffle functions |
| `permute-temperature.js` | New: temperature mixin with `_getCurrentPitchOffset` |

## Related

- ADR-003: Robust State Restoration (prerequisite)
- Max `v8` module documentation
