# ADR-005: Fix Runaway Parameter Transpose on Transport Stop/Start

**Date:** 2026-02-20
**Status:** Implemented

## Context

Instruments using parameter-based transpose (drum racks, instrument racks with named transpose parameters) experienced runaway octave shifting when the transport was stopped and restarted. Each stop/start cycle could add another octave of shift.

### Symptom

With a pitch pattern like `[1, 0, 1, 0, ...]` on a parameter_transpose instrument:
1. First play cycle: correct (+16 / revert / +16 / revert)
2. Stop transport, start again: pitch shifts up by an additional octave
3. Each subsequent stop/start adds another octave

### Root Cause

`onTransportStart()` called `detectInstrumentType()`, which created a **new** `TransposeStrategy` instance on every transport start. This discarded the preserved `originalTranspose` value from the previous instance.

The race condition:

```
1. Transport stop (deferred) → revertTranspose() → sets param back to 64
2. Transport start (deferred) → detectInstrumentType() → new TransposeStrategy(originalTranspose: null)
3. First pitch tick → applyTranspose(true):
   - originalTranspose is null, so reads current param value
   - If revert from step 1 hasn't propagated yet, reads 80 (still shifted!)
   - Captures originalTranspose = 80 (WRONG)
   - Sets param to 80 + 16 = 96
4. Next stop/start: captures 96 as original → shifts to 112 → runaway
```

Both `onTransportStop` and `onTransportStart` use `defer()`, so there is no ordering guarantee. The revert may not have landed before the new strategy reads the parameter.

### Why Previous Fixes Didn't Solve It

The comment in `revertTranspose()` (issue #9) correctly identified that `originalTranspose` must persist across transport cycles. But `detectInstrumentType()` on transport start bypassed this by creating a fresh instance, discarding the preserved value.

## Decision

### 1. Remove `detectInstrumentType()` from `onTransportStart()`

Instrument detection on transport start was redundant. It is already handled by:
- `init()` — initial detection on device load
- `setupDeviceObserver()` — re-detection when devices are added/removed/changed on the track

The device observer fires on any instrument change, which is the only time re-detection is actually needed.

### 2. Guard device observer re-detection

When the device observer fires `detectInstrumentType()` during playback, the current parameter may be in a shifted state. Added a `revertTranspose()` call before re-detection to ensure the parameter is at baseline before the old strategy is discarded.

### 3. Preserve `originalTranspose` across transport cycles

The `TransposeStrategy` instance now persists for the lifetime of the instrument (not recreated per transport cycle). `originalTranspose` is captured once on first use and reused on subsequent transport starts, eliminating the race condition entirely.

## Lifecycle (After Fix)

```
init() or device observer
  → detectInstrumentType()
  → creates TransposeStrategy (originalTranspose: null)

Transport start (1st time)
  → first pitch tick → applyTranspose(true)
  → captures originalTranspose from param (correct, unshifted)
  → shifts param up

Transport stop
  → revertTranspose() → sets param back to originalTranspose
  → originalTranspose preserved on same strategy instance

Transport start (2nd time)
  → same strategy instance, same originalTranspose
  → first pitch tick → applyTranspose(true)
  → uses preserved originalTranspose (no re-read needed)
  → shifts param up from correct baseline

Device change (during or outside playback)
  → device observer fires
  → revertTranspose() (if currently parameter_transpose)
  → detectInstrumentType() → new strategy for new instrument
```

## Consequences

### Positive
- Eliminates runaway octave shifting on transport stop/start
- Removes race condition between deferred stop/start handlers
- Strategy instance lifecycle matches instrument lifetime (not transport cycle)
- Simpler — less work done on every transport start

### Negative
- None observed

## Files Changed

| File | Changes |
|------|---------|
| `permute-device.js` | Removed `detectInstrumentType()` from `onTransportStart()`, added revert guard to device observer |
| `permute-instruments.js` | Updated `revertTranspose()` comment to reflect new lifecycle |

## Related

- ADR-110: Sequencer Device v3.0 (delta-based state tracking)
- ADR-002: Restore State Format Fix
- ADR-003: Robust State Restoration
