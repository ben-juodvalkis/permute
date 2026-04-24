# ADR-011: Observer-Driven Clip Cache and Parameter-Path Hoist

**Status:** Accepted
**Date:** 2026-04-24
**Refines:** [ADR-008](008-hot-path-efficiency.md) (clip caching)

## Context

A code walk for performance at high track counts (16+ Permute devices) found two LiveAPI IPC paths still firing on every tick per device:

1. **Per-tick clip re-resolution.** The dirty-flag clip cache from ADR-008 invalidated itself at the top of every tick (`processWithSongTime`), so `getCurrentClip()` always missed the cache and did the full work: `playing_slot_index.get()` + (often) `fired_slot_index.get()` + `new LiveAPI(clipPath)`. That's 2-3 IPC round-trips per tick per device. The cache was effectively only saving the *second* sequencer's lookup within the same tick.

2. **Wasted clip lookup on parameter-only paths.** `processSequencerTick` called `getCurrentClip()` *before* checking the `parameter_transpose` / `parameter_mute` early-returns. Those branches write a device parameter and never touch the clip — the IPC was wasted on the most common track type (Drum Racks, Simpler with the Transpose macro from ADR-005's flood fix family).

At low track counts these costs are invisible. They scale linearly with Permute device count and become the dominant cost in busy sets.

## Decision

Drive the clip cache with Live's own slot-change notifications instead of polling. Hoist parameter-only branches above any clip lookup. Keep ADR-008's other optimizations (cached `isActive`, pre-allocated buffers, etc.) intact.

## Changes

### Slot-driven clip cache (`permute-device.js`)

- Removed `_clipCacheDirty`. Added `_playingSlotIndex` / `_firedSlotIndex` state and `setupSlotObservers()`.
- Two new LiveAPI listeners — `playing_slot_index` and `fired_slot_index` on the track — fire on bind (which auto-populates initial state) and on every slot edge.
- The callbacks update the slot indices and call `_refreshClipFromSlots()`, which resolves the clip path and updates `_cachedClip` exactly once per slot change.
- Identity-change cleanup (clearing the temperature `loop_jump` observer, updating `clipState`) moved from inline-in-`getCurrentClip` to `_setCachedClip`, where it runs on the slot edge.
- `getCurrentClip()` is now a pure cache read — zero IPC per tick.
- `invalidateClipCache()` is preserved as a forced refresh and still called from `onTransportStart`, `onTransportStop`, and `onClipChanged`. Those fire once per event, not per tick, so the cost is irrelevant.
- `processWithSongTime` no longer calls `invalidateClipCache` — the slot listeners keep the cache continuously fresh.

### Parameter-path hoist (`permute-device.js`)

- In `processSequencerTick`, the `parameter_transpose` and `parameter_mute` early-returns moved above the `getCurrentClip()` call. These tracks never touch a clip; they write to a device parameter. On those tracks the per-tick path is now zero LiveAPI calls.

## Consequences

### Positive

- **Per-tick LiveAPI IPC drops to zero** on `parameter_transpose` / `parameter_mute` tracks (Drum Racks, Simpler-with-Transpose-macro, Shakers rack).
- **Per-tick LiveAPI IPC drops to a cache hit** on note-based MIDI tracks and audio tracks. Slot-change cost is paid once per slot change, not once per tick.
- **Scales correctly with device count.** With N Permute devices the savings are N × (2-3 IPC + path resolve) per tick.
- **Identity-change cleanup is now event-driven.** Previously the cleanup only ran when `getCurrentClip()` happened to observe the new id; now it runs on the slot edge.

### Negative

- **Two more LiveAPI observers per device.** Total active observers per Permute device rises from ~5 to ~7. The hard-detach machinery from the flood fix family (`ObserverRegistry`, `permute-observer-registry.js:33`) handles their lifecycle the same way as the existing observers, but they are two more candidates if a track is moved or deleted under the device.
- **Slightly more state to reason about.** `_playingSlotIndex` / `_firedSlotIndex` are kept in sync by two independent listeners; precedence is `playing >= 0 ? playing : fired` and is centralized in `_refreshClipFromSlots`.

### Neutral

- The `clip_changed()` patcher entry point is preserved. It now redirects through `_refreshClipFromSlots` for the cache update and still runs the rich temperature/chance reapplication logic for explicit user-driven clip changes.
- ADR-008's other optimizations (cached `isActive`, pre-allocated buffers, `TransposeStrategy` IPC reduction, temperature observer guard) are unaffected.

## Follow-ups not landed in this ADR

**Metro tick rate (Hotspot 3 from the analysis pass).** `Permute.amxd` carries a per-device `transport` + `metro @lock 1 @interval 1 0 0 bars.beats.units` pump. Each device runs its own Max scheduler at full PPQ even though the 120-tick lookahead in `processWithSongTime` already implies sub-16th-note precision is unused. Recommended fix: change the metro `@interval` to `16n` (or `0 0 60 ticks`). This is a Max-side change — `Permute.maxpat` is a partial export per `PATCHER_REBUILD.md`; the change must be made in the `.amxd` working copy.

A bigger architectural variant — one shared transport pump fanned out via `send`/`receive` to all Permute instances — is possible but not pursued here. With the per-tick path now near-zero cost, the per-device pump's overhead is small and the simpler in-device pump is preferred.

## Related

- ADR-005: Fix Runaway Parameter Transpose (introduced parameter-path strategies)
- ADR-008: Hot Path Efficiency (introduced the clip cache this ADR refines)
- `BUG_REPORT_path_listener_flood.md` (observer lifecycle hardening that the new slot listeners inherit)
