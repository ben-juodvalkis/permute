# ADR-016: Gate Parameter-Transpose Writes on a Prior Shift

**Status:** Accepted
**Date:** 2026-06-06
**Refines:** ADR-005 and ADR-014 (runaway / mis-captured baseline on parameter transpose). Same family — a `TransposeStrategy` writing the param when it shouldn't — but a different trigger that survived both prior fixes.

## Context

On a `parameter_transpose` instrument (drum rack, instrument rack, Simpler with
a named transpose param), the transpose parameter would **intermittently snap to
a rail** (e.g. a drum rack macro to 0, audible as the bottom of its mapped pitch
range) when the transport was started or stopped — **even with no pitch steps
enabled and no devices added to the track.**

### Symptom

- All pitch sequencer steps are 0 (off).
- Pressing play, or stopping, occasionally drives the transpose param to its
  minimum (or, on a narrower-range param, its maximum).
- Intermittent: most cycles are fine; the rail appears sporadically.

The "no steps enabled, no device change" qualifier is what distinguishes this
from ADR-005 (runaway across stop/start *with* an active pattern) and ADR-014
(compounding on device-list mutation). Those required a real shift to have
happened; this fires when nothing was ever shifted.

### Root cause

Two code paths write the param via `applyTranspose(false)` regardless of whether
a shift had ever been applied:

1. **The per-tick pitch path** (`processSequencerTick`,
   `permute-device.js`). On transport start, every sequencer's
   `lastParameterValue` is reset to `undefined`. The first tick computes the
   pitch step value — and **even when the value is `0`** (step off),
   `0 !== undefined` is true, so it calls
   `instrumentStrategy.applyTranspose(value === 1)` → `applyTranspose(false)`,
   which **writes the param.**

2. **The transport-stop handler** (`onTransportStop`) calls
   `revertTranspose()` → `applyTranspose(false)`, writing the param a second
   time.

`applyTranspose(false)` writes `originalTranspose` back to the param. When
`originalTranspose` is not yet populated at that instant, it lazily reads the
live param value as the baseline (the same lazy-capture relied on by ADR-005 /
ADR-014). If that read is stale, falsy, or otherwise untrustworthy at the exact
moment of a start/stop boundary, the value written rails the param. Because it
hinges on observer/IPC timing, it is intermittent.

This is why the param "switches on both transport start and stop": path 1 writes
it on the first tick after start, path 2 writes it again on stop.

A previous mitigation fell back to a hardcoded `DEFAULT_DRUM_RACK_TRANSPOSE`
(64) on a failed baseline read. That is innocuous only for a 0–127 macro that
happens to be centered; it is wrong for any param with a different range or a
non-centered user setting, and it does not prevent the spurious write in the
first place.

## Decision

A transpose-down write only makes sense as the counterpart of a real
transpose-up. **Gate every shift-down write on a recorded prior shift-up.**

`TransposeStrategy` tracks `hasShifted`, set `true` only when
`applyTranspose(true)` actually writes a shifted value:

```js
// applyTranspose(shouldShiftUp):
// asked to return to baseline but we never shifted up — nothing to restore.
if (!shouldShiftUp && !this.hasShifted) return;   // no-op, no param write
```

Cleared back to `false` after a successful revert, so the next play cycle
re-applies correctly if a step is on.

Supporting changes:

1. **No invented baseline.** When `originalTranspose` is `null` and the live
   read returns a falsy/empty value, `applyTranspose` bails without writing
   rather than falling back to a hardcoded constant that rails narrow-range
   params.

2. **`revertTranspose` early-out.** It returns immediately when `!hasShifted`.
   This is now redundant with the `applyTranspose` gate but kept for clarity at
   the call site (transport stop, `devices` observer).

3. **Retry path seeds a real baseline.** `scheduleDetectionRetries` now
   snapshots and caches the param value into `transposeBaselines[deviceId]`
   (matching the synchronous `detectInstrumentType` path), so retry-built
   strategies are never born baseline-less.

## Consequences

- With no pitch steps active, transport start/stop performs **zero** transpose
  param writes. The rail can no longer occur on idle cycles.
- A genuine shift cycle is unchanged: step on → `applyTranspose(true)` (bypasses
  the gate, sets `hasShifted`), step off / stop → `applyTranspose(false)`
  reverts, then `hasShifted` clears.
- The hardcoded `DEFAULT_DRUM_RACK_TRANSPOSE` fallback is no longer used for
  writes; the constant remains defined but its only former consumer is gone.

## Files

- `permute-instruments.js` — `hasShifted` field, the shift-down gate in
  `applyTranspose`, no-invented-baseline bail, `revertTranspose` early-out.
- `permute-device.js` — `scheduleDetectionRetries` baseline capture.
