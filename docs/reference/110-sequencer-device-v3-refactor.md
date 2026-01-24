# ADR 110: Sequencer Device v3.0 Refactor - Delta-Based State Tracking

**Status:** Implemented
**Date:** 2025-11-08
**Author:** Claude + User
**Related:** [sequencer-v3-refactor-plan.md](../../docs-archive/sequencer-v3-refactor-plan.md), [sequencer-v3-refactor-log.md](../../docs-archive/sequencer-v3-refactor-log.md)

## Context

The sequencer-device.js v2.1 implementation used a complex layer-based architecture with pristine state tracking, resulting in:
- ~1200 lines of transformation layer code
- Complex pristine state management across transport cycles
- Difficulties composing transformations (especially temperature)
- Fragile state restoration logic

The initial v3.0 plan called for transport-scoped pristine state, but during implementation we discovered a simpler approach was sufficient.

## Decision

### Core Architecture: Delta-Based State Tracking

Instead of maintaining pristine state, we track **last applied values** per clip and apply **deltas on change**:

```javascript
// V3.0: Simple state tracking (no pristine needed)
this.lastValues = {}; // clipId -> { pitch: 0/1, mute: 0/1 }
```

**Key insight:** "If we go from 0 to 1 we shift up an octave. If we go from 1 to 0 we shift down. If we go from 1 to 1 or 0 to 0 we do nothing."

### Implementation Details

#### 1. Delta-Based Transformation Application

**MIDI clips (non-device instruments):**
```javascript
var delta = 0;
if (shouldShiftUp && lastPitch !== 1) {
    delta = OCTAVE_SEMITONES;  // 0→1: shift up
} else if (!shouldShiftUp && lastPitch === 1) {
    delta = -OCTAVE_SEMITONES; // 1→0: shift down
}

if (delta !== 0) {
    for (var i = 0; i < notes.notes.length; i++) {
        notes.notes[i].pitch += delta;
    }
}
```

**Device-based instruments (drum racks/instrument racks):**
```javascript
// Absolute state (parameter handles the value)
this.instrumentStrategy.applyTranspose(shouldShiftUp);
```

**Audio clips:**
```javascript
// Absolute state
var pitchValue = shouldShiftUp ? OCTAVE_SEMITONES : 0;
clip.set("pitch_coarse", pitchValue);
```

#### 2. Transport Stop Undo

On transport stop, reverse transformations based on last applied values:

```javascript
// Undo pitch if was on
if (this.lastValues[clipId].pitch === 1) {
    if (this.instrumentType === 'drum_rack_standard' || ...) {
        this.instrumentStrategy.revertTranspose();
    } else {
        for (var i = 0; i < notes.notes.length; i++) {
            notes.notes[i].pitch -= OCTAVE_SEMITONES;
        }
    }
}

// Undo mute if was on
if (this.lastValues[clipId].mute === 0) {
    for (var i = 0; i < notes.notes.length; i++) {
        notes.notes[i].mute = 0; // Unmute all
    }
}

delete this.lastValues[clipId];
```

#### 3. Temperature Transformation

Temperature reads **current clip state** (post mute/pitch transformations) and generates swap pattern from current notes:

```javascript
// Read CURRENT clip state (includes mute/pitch changes)
var notesJson = clip.call("get_all_notes_extended");
var notes = parseNotesResponse(notesJson);

// Generate swap pattern from CURRENT notes
this.temperatureSwapPattern = generateSwapPattern(
    notes.notes,  // CURRENT, not pristine!
    this.temperatureValue
);

// Apply swaps to CURRENT pitches
applySwapPattern(notes.notes, this.temperatureSwapPattern);
```

This allows temperature to naturally compose with mute/pitch transformations.

#### 4. Live API Observer Pattern

**Critical fix:** All Live API calls from observer callbacks must use `defer()`:

```javascript
var observer = createObserver("live_set", "is_playing", function(args) {
    if (playing === 0 && self.transportState.isPlaying) {
        defer(function() {  // CRITICAL: Breaks out of notification context
            self.onTransportStop();
        });
    }
});
```

Without defer(), attempting to call `apply_note_modifications` from an observer triggers:
```
v8liveapi: Changes cannot be triggered by notifications.
```

## Architecture Changes

### Removed (~1336 lines)
- `MuteTransformation` class
- `PitchTransformation` class
- `TemperatureTransformation` class
- Pristine state capture/restoration logic
- Layer system coordination

### Added (~200 lines)
- `lastValues` tracking system
- Delta-based batch apply methods
- Temperature helper functions:
  - `fisherYatesShuffle()`
  - `generateSwapPattern()`
  - `applySwapPattern()`
- Instrument strategy pattern (retained from v2.1)

### Net Result
- **Before:** 2917 lines (v2.1)
- **After:** 2048 lines (v3.0)
- **Reduction:** 869 lines (30%)

## Consequences

### Positive

1. **Simplicity:** Delta-based approach is much easier to understand and debug
2. **Natural composition:** Temperature works on current state, composing naturally with mute/pitch
3. **Less code:** 30% reduction in lines of code
4. **Fewer bugs:** Simpler state machine = fewer edge cases
5. **Per-clip tracking:** `lastValues` keyed by clipId allows switching between clips without losing state

### Negative

1. **No arbitrary undo:** Can only undo on transport stop, not mid-playback
2. **Stateful:** Must track last values per clip (though this is simpler than pristine state)

### Neutral

1. **Same user experience:** Functionally identical to v2.1 from user perspective
2. **State persistence:** Still uses same v2.0/v2.1 state format (backward compatible)

## Key Learnings

1. **Pristine state was overengineered:** The delta-based approach is sufficient for this use case
2. **Temperature doesn't need pristine:** Reading current state and swapping within it works perfectly
3. **defer() is essential:** Live API modifications from observers must be deferred
4. **Simplicity wins:** The user's question "why is that so hard?" led to the breakthrough

## Migration Path

- **v2.1 → v3.0:** Automatic (state format unchanged)
- **Backward compatibility:** Supports v1.x, v2.0, v2.1, and v3.0 state formats

## References

- **Implementation log:** [documentation/current/sequencer-v3-refactor-log.md](../../docs-archive/sequencer-v3-refactor-log.md)
- **Original plan:** [documentation/current/sequencer-v3-refactor-plan.md](../../docs-archive/sequencer-v3-refactor-plan.md)
- **Device code:** [ableton/M4L devices/sequencer-device.js](../../ableton/M4L%20devices/sequencer-device.js)
- **Transpose config:** ADR 064 - Centralize Transpose Configuration

## Decision Rationale

The delta-based approach emerged from recognizing that:
1. We only need to know the **change** (0→1, 1→0, or no change)
2. Transport stop can undo by reversing the **last applied transformation**
3. Temperature can work on **current state** rather than pristine
4. Simpler state = fewer bugs

This represents a significant simplification from the original v3.0 plan while achieving all functional goals.
