# ADR-003: Robust State Restoration & Initialization Lifecycle

**Date:** 2026-02-19
**Status:** Implemented

## Context

After ADR-002 fixed the 28-arg format alignment, state restoration still had two deeper problems:

1. **`restoreState()` bypassed setter methods** — It wrote directly to sequencer properties instead of using `setState()`, skipping side effects like timing recalculation and lazy observer activation.
2. **No initialization lifecycle** — The device had no concept of "initialized", so `broadcastState('init')` would output defaults to `pattr_state` before pattr had a chance to restore saved values, overwriting them.

### Symptom

On loading a saved Live Set with non-default patterns, state would intermittently reset to defaults. The `init()` broadcast raced with pattr restoration.

### Discovery: Max Startup Order

Phase 2 temporary logging (`[INIT-SEQ]`) revealed the actual Max startup sequence:

```
restoreState(28 args)   ← pattr fires FIRST, before Live API is ready
init()                   ← Live API becomes available
init()                   ← duplicate (bang from Max patch)
```

This meant `restoreState()` → `setState()` → `setPattern()` → `checkAndActivateObservers()` → `ensurePlaybackObservers()` tried to create LiveAPI observers before the API was initialized, causing "Live API is not initialized" errors.

## Decision

### Phase 1: Fix restoreState() to use setter methods

**Before:** `restoreState()` wrote directly to properties:
```javascript
sequencer.sequencers.muteSequencer.pattern = mutePattern;
sequencer.sequencers.muteSequencer.patternLength = muteLength;
```

**After:** `restoreState()` is a thin adapter that delegates to `setState()`:
```javascript
sequencer.setState({
    version: '3.1',
    sequencers: {
        mute: { pattern: mutePattern, patternLength: muteLength, division: muteDivision },
        pitch: { pattern: pitchPattern, patternLength: pitchLength, division: pitchDivision }
    },
    temperature: temp
});
```

This ensures all setter side effects fire: validation, timing recalculation, and observer activation checks.

### Phase 2: Add initialization lifecycle

Added an `initialized` flag to `SequencerDevice`:

```javascript
// Constructor
this.initialized = false;

// Set true after init() completes (and in restoreState/setvalueof)
this.initialized = true;
```

The `broadcastState()` method gates `pattr_state` output on this flag:

```javascript
if (this.initialized && origin !== 'position' && origin !== 'pattr_restore' && origin !== 'init') {
    outlet(0, "pattr_state", ...);
}
```

This prevents `init()` from broadcasting defaults to pattr before saved state is restored.

### Init Sequence Fix: Guard observer creation

Added a guard to `checkAndActivateObservers()` to prevent LiveAPI calls before init:

```javascript
SequencerDevice.prototype.checkAndActivateObservers = function() {
    if (this.playbackObserversActive) return;
    if (!this.trackState.ref) return;  // ← Guard: no LiveAPI before init()
    // ...
};
```

And added a call at the end of `init()` to pick up patterns that were pre-restored by pattr:

```javascript
// At end of init(), after track setup:
this.checkAndActivateObservers();
this.broadcastState('init');
this.initialized = true;
```

## Startup Sequence (After Fix)

```
1. restoreState(28 args)     → setState() stores patterns, skips observer creation
2. init()                     → sets up track, calls checkAndActivateObservers(),
                                activates observers for pre-restored patterns
3. broadcastState('init')     → outputs state (pattr_state gated by initialized flag)
4. initialized = true         → future broadcasts will output to pattr_state
```

## Consequences

### Positive
- State correctly persists across Live Set save/load cycles
- Single code path for all state restoration (setState)
- No "Live API is not initialized" errors on startup
- `init()` broadcast no longer overwrites saved pattr data
- Clean separation: patterns stored immediately, observers deferred until API ready

### Negative
- None observed

## Files Changed

| File | Changes |
|------|---------|
| `permute-device.js` | Rewrote `restoreState()` as adapter to `setState()`, added `initialized` flag, guarded `pattr_state` output, guarded `checkAndActivateObservers()`, cleaned up `getvalueof()`/`setvalueof()` logging |

## Related

- ADR-002: Restore State Format Fix (28-arg alignment)
- ADR-004: Modularization (Phase 3, same refactor effort)
