# ADR-003: Robust State Restoration & Initialization Lifecycle

**Date:** 2026-02-13
**Status:** Implemented

## Context

After ADR-002 fixed the argument count mismatch in `restoreState()`, a deeper problem remained: `restoreState()` bypassed all setter methods, writing directly to `.pattern[i]`, `.patternLength`, `.division`, and `.temperatureValue`. This left the device in a partially-initialized state where pattern data looked correct but sequencer infrastructure (transport observers, step timing, temperature activation) was never configured.

Additionally, `init()` broadcast default state to pattr before restoration could run, creating a race condition that could overwrite saved state with defaults.

### Root Causes

1. **`restoreState()` bypassed setters** - Side effects like `checkAndActivateObservers()`, `calculateTicksPerStep()`, and temperature state management were never triggered on restore.

2. **`init()` broadcast defaults to pattr** - `broadcastState('init')` output `pattr_state` with default patterns before `restoreState()` or `setvalueof()` could run.

3. **Two restoration paths with divergent behavior** - `restoreState()` (flat 28-arg format) directly wrote properties, while `setvalueof()` (JSON format) correctly called `setState()` with proper setters.

## Decision

### 1. Rewrite `restoreState()` as thin adapter

`restoreState()` now parses the flat 28-arg format into a JSON state object and delegates entirely to `setState()`, which uses proper setters (`setPattern()`, `setLength()`, `setDivision()`, `setTemperatureValue()`).

This ensures:
- Observer activation via `checkAndActivateObservers()` in `setPattern()`
- Tick calculation via `calculateTicksPerStep()` in `setDivision()`
- Temperature state capture/restore via `setTemperatureValue()`
- Pattern validation in `setPattern()`

### 2. Exclude `'init'` origin from pattr_state output

Added `origin !== 'init'` to the pattr_state output guard in `broadcastState()`. This prevents `init()` from overwriting saved pattr data with defaults.

### 3. Add `initialized` lifecycle flag

Added `this.initialized = false` to the constructor, set to `true` at end of `init()`, `restoreState()`, and `setvalueof()`. The pattr_state output is guarded by this flag, preventing any state output during the init/restore window.

### 4. Clean up debug logging

Reduced verbose investigation logging in `getvalueof()` and `setvalueof()` to single-line debug summaries. Error logging preserved.

## Consequences

### Positive
- State restores correctly with all side effects (observers, timing, temperature)
- Single restoration implementation (`setState()`) regardless of entry point
- No pattr feedback during initialization window
- Clean console output (no investigation spam)

### Negative
- Temporary `[INIT-SEQUENCE]` logging added for empirical startup order documentation (to be removed after verification)

## Files Changed

| File | Changes |
|------|---------|
| `permute-device.js` | Rewrote `restoreState()` as adapter, added `initialized` flag, guarded pattr output, cleaned up logging |

## Related

- ADR-002: Restore State Format Fix (previous partial fix)
- Issue #4: State not restoring properly when loading from saved Live Set
