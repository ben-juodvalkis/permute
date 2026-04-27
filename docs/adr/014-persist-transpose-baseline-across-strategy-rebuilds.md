# ADR-014: Persist Transpose Baseline Across Strategy Rebuilds

**Status:** Accepted
**Date:** 2026-04-27
**Refines:** ADR-005 (runaway parameter transpose on transport stop/start). Same race, different trigger.

## Context

ADR-005 fixed runaway octave shifting across transport stop/start by giving the `TransposeStrategy` an instance lifetime that matched the *instrument*, not the transport cycle, so `originalTranspose` survived stop→start. A separate trigger of the same race remained: **adding any device to the track while the pitch was already shifted**.

### Symptom

With pitch step active and the param sitting at +12 (one octave up from a baseline of 0):

1. User drops an FX device (Reverb, EQ, etc.) onto the track.
2. The next pitch cycle that should land at +12 lands at **+24**.
3. Revert drops to +12, not 0. The shift compounds on every subsequent device-list mutation.

### Root cause

Two interacting pieces force the strategy to re-read a *shifted* param value as if it were the user's intended baseline:

1. **`'devices'` observer rebuilds the strategy.** Adding any device fires the track's `devices` listener. The handler nulls `instrumentDevice` / `instrumentDeviceId` / `instrumentStrategy.transposeParam` synchronously (refs become unsafe to dereference once Live's device tree mutates) and schedules a debounced `detectInstrumentType` 75ms later, which constructs a **new** `TransposeStrategy`.

2. **`TransposeStrategy` lazily captures the baseline from the live param.** `originalTranspose` is `null` on a fresh instance; on first `applyTranspose` it does `transposeParam.get("value")` and treats whatever it reads as the original. If the param currently holds Permute's own +12, that becomes the new "baseline" and the next shift produces +24.

The pre-existing guard in `_scheduleDetection` — call `revertTranspose()` before re-detection — was a no-op in this scenario because the `'devices'` observer had already nulled `transposeParam`, so `applyTranspose` hit its `if (!this.transposeParam) return` bail at the top.

Even with the revert moved earlier (see "Decision" below), the deferred boundary between `set("value", 0)` and the new strategy's `get("value")` 75ms later is not a reliable propagation guarantee — the same class of race ADR-005 identified between `defer()`'d transport handlers.

## Decision

Stop trusting the live param value as the baseline at strategy construction. **Persist the baseline on the device controller, keyed by device id, across strategy rebuilds.**

Two changes, layered for redundancy:

### 1. Revert before nulling, not after

In the `'devices'` observer callback, `revertTranspose()` runs **first** while `transposeParam` is still a valid handle, *then* refs are nulled. Removes a no-op revert path that ADR-005's guard had been relying on.

`_scheduleDetection` no longer reverts — by the time its debounced task fires, the revert has already been issued from the observer.

### 2. `transposeBaselines` cache on `SequencerDevice`

```
this.transposeBaselines = {};   // deviceId -> baseline value
```

- **First time** `detectInstrumentType` finds a `parameter_transpose` device: read the param value once (the only moment it is guaranteed to reflect the user's intent — Permute hasn't shifted it yet) and store it in the cache.
- **Subsequent rebuilds** of the same device id: pass the cached baseline into the new `TransposeStrategy` via a new optional `cachedBaseline` constructor arg, which seeds `originalTranspose` directly and bypasses the lazy `get("value")` path entirely.

`TransposeStrategy(device, transposeParam, shiftAmount, paramName, cachedBaseline)` — when `cachedBaseline !== undefined && !== null`, the strategy uses it as `originalTranspose` and never reads the live param for that purpose.

The retry path in `scheduleDetectionRetries` (for racks whose macros aren't populated at first detection) reads from the same cache.

## Why this is robust where the revert alone isn't

The two mechanisms cover different failure modes:

| Mechanism | Defends against |
|---|---|
| Revert-before-null in `'devices'` observer | The fast path: revert lands, param is at baseline, even a re-read would be correct. |
| `transposeBaselines` cache | The race path: revert was issued but Live hasn't propagated the write by the time the new strategy runs. The cache hit makes the re-read irrelevant. |

If the cache misses (device id changed across the rebuild — uncommon but possible), the strategy falls back to reading the param, which by then should have settled to the reverted baseline. The pre-revert improves the fallback's reliability; the cache makes correctness independent of it.

## Lifecycle (after fix)

```
init() / device observer
  → detectInstrumentType()
  → first time seeing this device:
       read param value → store in transposeBaselines[deviceId]
       construct TransposeStrategy(..., cachedBaseline)  // seeds originalTranspose
     subsequent times:
       read cached baseline → construct TransposeStrategy(..., cachedBaseline)

User adds an FX device on the track
  → 'devices' observer fires
  → revertTranspose() while param handle still valid (writes baseline back)
  → null instrumentDevice / instrumentDeviceId / transposeParam
  → schedule detection (75ms debounce)
  → detectInstrumentType() re-runs
  → same instrument device id → cache hit → new strategy seeded with same baseline
  → next pitch shift: baseline + 12 (correct)
```

## Changes

### `permute-device.js`

- **Add `this.transposeBaselines = {}`** to `SequencerDevice` constructor.
- **`'devices'` observer** (`setupDeviceObserver`): call `revertTranspose()` *before* nulling `instrumentDevice` / `instrumentDeviceId` / `transposeParam`.
- **`_scheduleDetection`**: drop the revert call from both the `Task` body and the inline (`typeof Task === 'undefined'`) fallback. The observer now owns reverts.
- **`detectInstrumentType` (primary path)**: on first sight of a device, snapshot `transposeParam.get("value")` into `transposeBaselines[deviceId]`. On subsequent sights, read from the cache. Either way, pass the value as the new `cachedBaseline` arg to `TransposeStrategy`.
- **`scheduleDetectionRetries` (retry path)**: same cache lookup, passed through to `TransposeStrategy`.

### `permute-instruments.js`

- **`TransposeStrategy` constructor**: new optional `cachedBaseline` parameter. When provided, sets `this.originalTranspose = cachedBaseline` so `applyTranspose` skips the lazy `transposeParam.get("value")` path on first call.

## Consequences

### Positive

- Adding an FX device mid-shift no longer compounds the transpose. Empirically confirmed.
- Fix is independent of the deferred-write propagation timing the prior approach relied on.
- The capture moment is now well-defined ("the first time this device appeared on the track") instead of "whenever the strategy happens to be reconstructed."
- Removes a redundant revert call from `_scheduleDetection`; the responsibility is in one place.

### Negative / accepted trade-offs

- **Project-load with a saved-shifted param.** If a user saves a Live set while Permute is mid-shift (param at +12) and reopens it, the first detection captures +12 as the baseline and Permute will revert to +12 instead of 0. This was already true before this ADR — the change doesn't make it worse — and is bounded by the user reverting Permute (set pitch step to 0) before saving. Out of scope; not observed in practice because the typical workflow is to stop transport (which reverts) before saving.
- **Stale cache entries for removed devices.** `transposeBaselines` grows over the device's lifetime. Entries are not pruned when a device is removed. Bounded by the number of distinct instrument devices the user cycles through in one Live session — typically < 10, each entry is one number — so it's not worth the bookkeeping to evict.

### Out of scope / explicitly not done

- **Tracking baselines per-track.** Permute is a single-track device; one cache on the controller is sufficient. If a future revision lets one Permute follow multiple tracks, the cache would need to be keyed by `(trackId, deviceId)`.
- **Detecting external param changes between rebuilds.** If the user manually drags the transpose macro while Permute is at the un-shifted state of its cycle, the *next* rebuild won't notice — the cache still has the original. This is the correct trade-off: the alternative (re-read on every rebuild) is exactly the bug we just fixed. External rebaselining belongs to a "user re-arms Permute" gesture (toggle off/on), not to incidental device-list mutations.

## Verification

- With pitch sequencer active and step landing on `+12`: drop a Reverb (or any device) on the track. Confirm the next pitch-on cycle still lands at `+12`, not `+24`. Revert (pitch step `0`) returns the param to the original baseline (e.g., 0), not to `+12`.
- Repeat with the device added during the *off* phase of the pitch sequence: same result on the next on-cycle.
- With `DEBUG_MODE = true` in `permute-utils.js`, look for `[Sequencer DEBUG:instrument] Captured fresh baseline N for device <id>` on the first detection and `Seeded baseline N from cache for device <id>` on every subsequent rebuild for the same device.
- Confirm ADR-005's transport stop/start scenario still works (no regression): pitch shifts to `+16`, stop, start, pitch shifts to `+16` again — not `+32`.

## Related

- ADR-005: Fix Runaway Parameter Transpose on Transport Stop/Start — same race, transport-cycle trigger.
- ADR-008: Hot-Path Efficiency — the `if (this.originalTranspose === null)` guard that the cache now front-runs.
- ADR-013: Drop the `instrument_params` Observer — adjacent observer-lifecycle work; the `'devices'` observer addressed here is unrelated to that one.
