# ADR-004: CommonJS Modularization

**Date:** 2026-02-19
**Status:** Implemented

## Context

`permute-device.js` had grown to ~3000 lines containing all device logic: constants, utilities, sequencer class, observer registry, state classes, instrument detection, command registry, shuffle algorithms, and temperature transformation. This made the file difficult to navigate, reason about, and test.

Max4Live v8 JavaScript supports CommonJS `require()`, enabling modularization.

### Constraints

- **Flat file structure required**: Max4Live resolves `require()` paths relative to the device location. Subdirectory paths (e.g., `require('./lib/utils')`) are not reliably supported.
- **`autowatch` limitation**: Max's `autowatch = 1` only detects changes to the main file. Module changes require manual reload (delete and re-add device).
- **No npm/bundler**: Max4Live has no build pipeline. Modules must be plain CommonJS files.

## Decision

Extract `permute-device.js` into 9 focused CommonJS modules plus the main file:

| Module | Lines | Purpose | Dependencies |
|--------|-------|---------|--------------|
| `permute-constants.js` | 91 | Constants, config, VALUE_TYPES | None |
| `permute-utils.js` | 293 | Debug, error handling, LiveAPI helpers | constants |
| `permute-sequencer.js` | 198 | Generic Sequencer class | constants, utils |
| `permute-observer-registry.js` | 64 | ObserverRegistry class | None |
| `permute-state.js` | 99 | TrackState, ClipState, TransportState | None |
| `permute-instruments.js` | 176 | InstrumentDetector, strategies | constants, utils |
| `permute-commands.js` | 44 | CommandRegistry class | None |
| `permute-shuffle.js` | 173 | Fisher-Yates, swap pattern generation | utils (debug only) |
| `permute-temperature.js` | 322 | Temperature mixin (prototype methods) | constants, utils, shuffle |
| `permute-device.js` | ~1760 | Main controller (SequencerDevice) | All above |

### Temperature Mixin Pattern

Temperature methods are tightly coupled to `SequencerDevice` (they access `this.lastValues`, `this.instrumentType`, `this.clipState`, etc.). Rather than passing numerous parameters, they are applied as a mixin:

```javascript
// permute-temperature.js
function applyTemperatureMethods(proto) {
    proto._getCurrentPitchOffset = function(clipId) { ... };
    proto.setTemperatureValue = function(value) { ... };
    // ... other temperature methods
}
module.exports = { applyTemperatureMethods: applyTemperatureMethods };

// permute-device.js
temperature.applyTemperatureMethods(SequencerDevice.prototype);
```

This keeps temperature logic in its own file while preserving `this` access to device state.

### Rename: lastAppliedValue → lastParameterValue

During extraction, `lastAppliedValue` on the Sequencer class was renamed to `lastParameterValue` to clarify its purpose: tracking the last value applied via parameter-based transpose (distinct from per-clip note-based deltas in `SequencerDevice.lastValues`).

## Dependency Graph

```
permute-constants (no deps)
    ↑
permute-utils (constants)
    ↑
permute-sequencer (constants, utils)
permute-instruments (constants, utils)
permute-shuffle (utils)
    ↑
permute-temperature (constants, utils, shuffle)
    ↑
permute-device (all modules)

permute-observer-registry (no deps)
permute-state (no deps)
permute-commands (no deps)
```

## Consequences

### Positive
- Main file reduced from ~3000 to ~1760 lines (41% reduction)
- Clear separation of concerns with explicit dependency graph
- Pure functions (shuffle, state classes) are independently testable
- Easier to locate and modify specific functionality
- Each module has a focused purpose documented in its header

### Negative
- Module changes require manual device reload (autowatch limitation)
- All files must be in the same directory (Max4Live constraint)
- 10 files instead of 1 (more files to track, but each is manageable)

## Files Changed

| File | Changes |
|------|---------|
| `permute-device.js` | Replaced inline code with `require()` imports, applied temperature mixin |
| `permute-constants.js` | New: extracted constants and configuration |
| `permute-utils.js` | New: extracted utility functions |
| `permute-sequencer.js` | New: extracted Sequencer class |
| `permute-observer-registry.js` | New: extracted ObserverRegistry |
| `permute-state.js` | New: extracted state classes |
| `permute-instruments.js` | New: extracted instrument detection and strategies |
| `permute-commands.js` | New: extracted CommandRegistry |
| `permute-shuffle.js` | New: extracted shuffle/swap functions |
| `permute-temperature.js` | New: extracted temperature mixin |

## Related

- ADR-003: Robust State Restoration (Phases 1-2, same refactor effort)
- ADR-001: Extraction from Looping (original single-file architecture)
