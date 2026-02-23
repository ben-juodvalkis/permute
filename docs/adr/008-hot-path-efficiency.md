# ADR-008: Hot Path Efficiency Optimization

**Date:** 2026-02-22
**Status:** Implemented

## Context

The `song_time` handler fires every few ms during playback, driving both sequencers through `processWithSongTime()` → `processSequencerTick()` (x2). Profiling the hot path revealed several categories of unnecessary overhead:

- **Redundant LiveAPI IPC:** `getCurrentClip()` made 2-3 IPC calls to Live on every invocation, and was called once per active sequencer per tick (plus additional times from temperature methods)
- **Duplicate broadcasts:** When both sequencers advanced on the same tick, two identical full-state broadcasts were sent via OSC
- **Per-tick array allocation:** Every broadcast created 3+ new arrays via `push()`, `slice()`, and `concat()`
- **Linear scans:** `isActive()` scanned up to 8 pattern values per call, despite patterns only changing on user input
- **Dead code:** Several fields and variables were written but never read

## Decision

Optimize the hot path through caching, deduplication, pre-allocation, and dead code removal. No behavioral changes — all optimizations preserve the existing messaging contract.

## Changes

### Clip Reference Caching (`permute-device.js`)
- Added `_cachedClip`, `_cachedClipId`, `_clipCacheDirty` fields
- `getCurrentClip()` returns cached clip when cache is clean, avoiding IPC entirely
- Cache invalidated once per tick in `processWithSongTime()` (first sequencer re-fetches, second reuses) and on transport start/stop/clip change events
- **Impact:** Cuts LiveAPI IPC from 2-3x per tick to 1x when both sequencers active

### Cached `isActive()` (`permute-sequencer.js`)
- Added `_isActive` boolean, recomputed in `setPattern()`, `setStep()`, `setLength()`
- `isActive()` now returns the cached value instead of scanning the pattern
- **Impact:** Eliminates up to 16 comparisons per tick (8 per sequencer x 2)

### Eliminated String Concatenation (`permute-device.js`)
- `processWithSongTime()` now passes sequencer instances directly to `processSequencerTick()` instead of constructing lookup keys via `seqName + 'Sequencer'`

### Broadcast Deduplication (`permute-device.js`)
- Removed `broadcastState('position')` from `sendSequencerPosition()` (now UI-only)
- Added single `broadcastState('position')` at end of `processWithSongTime()`, only if a position changed
- Added explicit position broadcast in `onTransportStop()` for reset positions
- **Impact:** Halves broadcast calls during normal playback

### Pre-allocated Broadcast Buffers (`permute-device.js`)
- Added `_stateBuffer` (28 elements) and `_outletBuffer` (30 elements) to constructor
- `buildStateData()` fills `_stateBuffer` in-place via indexed writes (no `push()`)
- `broadcastToOSC()` fills `_outletBuffer` in-place (no `slice()`/`concat()`)
- **Impact:** Eliminates ~6 array allocations per broadcast

### TransposeStrategy IPC Reduction (`permute-instruments.js`)
- Moved `transposeParam.get("value")` inside `if (this.originalTranspose === null)` guard
- Parameter value is now read only once (first call), not on every `applyTranspose()`

### Temperature Observer Guard (`permute-temperature.js`)
- Observer setup/teardown in `setTemperatureValue()` now only fires on actual 0↔>0 transitions
- Previously destroyed and recreated the observer on every dial change while temperature was active

### Dead Code Removed
- `capturedWithPitchOn` field and `pitchWasOn` variable in `permute-temperature.js` — written but never read
- `pitch` field in `sortedIndices` objects in `permute-shuffle.js` — stored but never accessed
- `Object.keys()` emptiness check in `onClipChanged()` replaced with `for...in` early break

## Consequences

### Positive
- Significant reduction in per-tick LiveAPI IPC overhead (the dominant cost)
- Halved OSC broadcast frequency during playback
- Eliminated per-tick GC pressure from array allocations
- Removed dead code that could mislead future development

### Negative
- Clip caching adds invalidation complexity — cache must be invalidated at all the right points (transport events, clip changes, tick boundaries)

### Neutral
- `_stateBuffer` and `_outletBuffer` are shared across broadcasts — callers must not hold references to returned data across calls (existing code already follows this pattern)

## Related

- ADR-007: Post-Refactor Cleanup (prior dead code removal pass)
