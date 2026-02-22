# ADR-007: Post-Refactor Cleanup

**Date:** 2026-02-22
**Status:** Implemented

## Context

After the modularization (ADR-004) and pattr removal (ADR-006) refactors, the codebase carried accumulated debt:

- **Dead code** from earlier architecture versions that was never removed during extraction
- **Duplicated logic** where module extraction copied functions without removing the originals
- **Stale comments** referencing version numbers (V3.0, V4.x, etc.) and extraction history
- **Unused exports** and constants that no longer had any callers
- **Legacy format support** for state formats and division strings that predated the current architecture

A systematic audit identified ~293 lines of code that could be removed without changing any behavior.

## Decision

Perform a single cleanup pass across all 10 modules, removing dead code, eliminating duplication, and cleaning stale comments. No behavioral changes — only removal of code that is provably unreachable or redundant.

## Changes

### Dead Functions Removed
- `needsStateChange()` — legacy sequencer comparison function, unused since delta-based tracking (v3.0)
- `post_error()` — replaced by `handleError()` during modularization, never called
- `msg_int()` / `msg_float()` — empty Max message stubs with no purpose
- `setupClipObservers()` — inlined into `getCurrentClip()` (only meaningful action was `clearTemperatureLoopJumpObserver`)

### Vestigial Properties Removed
- `Sequencer.transformation` — holdover from pre-delta architecture, never read
- `Sequencer.lastState` — same; tracked previous state for comparison, replaced by `lastValues` on device
- `Sequencer.cacheValid` / `invalidateCache()` — cache mechanism that was never populated or checked

### Unused Constants Removed
- `VALUE_TYPES.midi_range`, `.normalized`, `.semitones` — only `VALUE_TYPES.binary` is used; mute and pitch sequencers both use binary patterns with delta-based application
- Unused imports in device: `TICKS_PER_QUARTER_NOTE`, `MAX_PATTERN_LENGTH`, `MIN_PATTERN_LENGTH`

### Duplicated Tick Calculation Eliminated
Two independent implementations of division-to-ticks conversion existed:
- `permute-utils.js` — `calculateTicksPerStep(division, timeSignature)` (shared utility)
- `permute-device.js` — `getTicksPerStep(division)` + `barBeatTickToTicks()` (device-local)

Removed the device-local versions. `SequencerDevice.processSongTime()` now calls `calculateTicksPerStep()` from utils, the single source of truth.

### Legacy Format Support Removed
- **v1.x state format** in `setState()` — handled a flat array format from the original Looping project; current format is a structured object
- **String division format** (`"1/16"`) in `calculateTicksPerStep()` — divisions have been `[bars, beats, ticks]` arrays since the modularization

### Unused Exports Cleaned
- `InstrumentStrategy` base class — only `TransposeStrategy` and `NoteStrategy` are instantiated; base class was exported but never imported
- `getDeviceParameter()` — internal helper used only within `findTransposeParameterByName()`; unexported and moved to local scope

### Simplified Logic
- `buildStateData()` division handling — removed null/non-array fallback paths since division is always an array after initialization
- `ObserverRegistry.get()` was identified as dead code but retained since it's a natural part of the registry API (3 lines)

### Stale Comments Cleaned
- Removed version annotations (`// V3.0 Delta-based`, `// V5.0 Lazy activation`, etc.) from inline comments — version history belongs in ADRs, not scattered through code
- Removed `// Extracted from permute-device.js — Phase 3 modularization` headers from all modules — the extraction is documented in ADR-004

## Consequences

### Positive
- **293 net lines removed** across all 10 modules
- Single source of truth for tick calculation (eliminates a class of potential drift bugs)
- Easier onboarding — no dead code paths to understand or accidentally invoke
- Module headers are clean and focused on purpose, not history

### Negative
- None identified. All removed code was provably dead or duplicated.

### Neutral
- `ObserverRegistry.get()` retained despite having no current callers — low cost, natural API surface

## Related

- ADR-004: CommonJS Modularization (created the module structure being cleaned)
- ADR-006: Remove pattr (removed the persistence layer, leaving some dead code behind)
