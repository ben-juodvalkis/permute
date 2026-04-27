# ADR-012: Shakers Parameter-Mute — Graph-Safe Target and Stale-Handle Defense

**Status:** Accepted
**Date:** 2026-04-27
**Refines:** SHAKERS_MUTE_CONFIG path introduced in `permute-constants.js` / `permute-instruments.js` `MuteStrategy`.

## Context

The Shakers instrument rack uses Permute's `parameter_mute` strategy: instead of editing clip notes, the mute sequencer writes one of two values to a designated rack parameter on every step change. The original config wrote to `paramIndex 0` (the rack's Device On).

On a track containing the Shakers rack, hitting transport play reproducibly crashed Live with `EXC_BAD_ACCESS, KERN_INVALID_ADDRESS at 0x0000000000000058` on `com.apple.audio.IOThread.client` (frames `Live+28024416 → Live+27973052`, identical signature across every captured crash dump). Removing the Shakers track removed the crash. Live's `Log.txt` immediately preceding the crash showed thousands of `_path_listener_callback` tracebacks containing `RuntimeError: The Max function "SendMessage" returned with error 2: Bad parameter value` — the same shape as the flood already documented in `BUG_REPORT_path_listener_flood.md`, but triggered by playback rather than `Simpler.replace_sample`.

### Root cause

Two independent issues, both load-bearing:

1. **Audio-graph topology mutation at sequencer rate.** Writing to `Device On` (paramIndex 0) tears down and re-allocates the rack's audio path on each toggle. Live's audio I/O thread reads from a parameter cache concurrently with the control thread's mutation; under tick-rate flips the audio thread dereferences a freed audio object (offset `0x58` of a null/recycled pointer). The same hazard applies to any topology-mutating parameter — `Chain Mute`, `Chain Solo`, `Chain Selector`, sample-slot swaps. We confirmed this empirically: remapping the special path to a macro that drove **Chain Mute** crashed identically.

2. **Stale `LiveAPI` parameter handle.** `MuteStrategy` cached the parameter `LiveAPI` once at instrument-detection time and reused it for every write. Rack mutations (chain edits, device add/remove, the very topology changes triggered by issue #1) invalidate the underlying parameter object. Subsequent writes through the cached handle either silently fail with `SendMessage error 2` (path listener flood) or — when the audio thread is still holding a reference — segfault. This is why the path-listener flood and the audio-thread crash co-occurred in the logs.

The "JS write storm saturates Live's automation engine" hypothesis was wrong on both counts. The crash happens on the **audio thread**, not the main thread; and the storm rate is a symptom of the path-listener flood (one error per failed write × N retries), not the cause.

## Decision

Two changes, applied together:

1. **Constrain the special path to value-only parameters.** Only target rack parameters whose write does not mutate audio-graph topology. For Shakers this means a Macro mapped to a `Utility` device's `Gain` (range 0 → -inf dB, with macro `127` set to `0 dB` in the mapping editor). The macro index is `4`; values `127` (audible) / `0` (silent). The Utility lives at the rack's output, sonically equivalent to muting but a pure DSP-block multiply.

2. **Re-resolve the parameter `LiveAPI` on every write.** `MuteStrategy` no longer caches `muteParam`. It stores `devicePath` + `paramIndex` and constructs a fresh `LiveAPI(devicePath + " parameters " + paramIndex)` per `applyMute` call. If the path resolves to `id === "0"` (rack mid-mutation), the write is skipped. The IPC cost is negligible compared to the parameter `set` itself.

These layers compose: even if a future macro mapping accidentally introduced topology mutation, the stale-handle defense would prevent the crash from compounding into a Live segfault — at worst the writes would no-op until the next instrument detection rebuilt state.

## Changes

### `permute-constants.js`

```diff
 var SHAKERS_MUTE_CONFIG = {
     rackClassName: "InstrumentGroupDevice",
     rackName: "shakers",
-    paramIndex: 0,
+    paramIndex: 4,
     mutedValue: 0,
-    playingValue: 1
+    playingValue: 127
 };
```

Comment expanded to record the rack-parameter layout (`0 = Device On`, `1..8 = Macro 1..8`) and the topology-mutation hazard.

### `permute-instruments.js` — `MuteStrategy`

- Constructor signature: `MuteStrategy(device, paramIndex, mutedValue, playingValue)` (was `MuteStrategy(device, muteParam, mutedValue, playingValue)`).
- Stores `this.devicePath` and `this.paramIndex`. No cached `muteParam`.
- `applyMute` constructs a fresh `LiveAPI(this.devicePath + " parameters " + this.paramIndex)` per call, checks `id !== INVALID_LIVE_API_ID`, then writes.

### `permute-device.js` — Shakers detection

Restored the special-path branch (it was disabled while diagnosing). Constructs `MuteStrategy` with the new signature; no longer calls `getDeviceParameter` for this path.

## Consequences

### Positive

- Live no longer crashes with the Shakers rack on the track during playback.
- The path-listener flood at the heart of `BUG_REPORT_path_listener_flood.md` is no longer triggered by ordinary play (it was driven by repeated writes through the stale handle).
- The fix is generalizable: any future `parameter_mute` rack target gets the same stale-handle protection for free, and the `Utility Gain` pattern is portable to other instruments where note-edit muting is undesirable.

### Negative / accepted trade-offs

- The Shakers rack now requires a specific configuration (Utility at output, Macro 4 mapped to its Gain, mapping range `0 dB` at macro `127`). This is a setup precondition documented here and in the constant's comment, not enforced by code. If the precondition is violated (e.g., Macro 4 remapped to Chain Mute), the crash returns. The stale-handle defense alone is **not** sufficient; the value-only-target constraint is load-bearing.
- One extra `LiveAPI` construction per mute write. Cost is microseconds; mute writes are edge-triggered (`if (value !== seq.lastParameterValue)`) so the rate is at most one per actual mute-state change.

### Out of scope / explicitly not done

- **Throttling / `defer()`-batching of mute writes.** During diagnosis we briefly added per-sequencer rate-limiting and `defer()`-coalescing for `*_current` outlet writes, on the (incorrect) hypothesis that the crash was a JS write storm. Both were reverted once the audio-thread signature ruled out main-thread saturation. Edge-triggering at the sequencer level is the only rate control we need.
- **Generalizing `parameter_mute` beyond Shakers.** The detection path remains gated on the rack class + name match. A more general "find a safe value-only mute target" mechanism would require either user configuration or heuristics for "is this parameter topology-mutating?", neither of which is worth building without a second use case.

## Verification

- Re-instantiate Permute on the Shakers track (saving JS does not re-run instrument detection) and play. Live remains stable; mute steps audibly duck the Shakers via the Utility gain.
- Inspect `/Library/Preferences/Ableton/Live 12.4b16/Log.txt` after a play session: no `_path_listener_callback` tracebacks, no `SendMessage error 2: Bad parameter value`.
- Crash dump signature `EXC_BAD_ACCESS at 0x58` on `com.apple.audio.IOThread.client` with frames `Live+28024416 → Live+27973052` no longer reproduces.
