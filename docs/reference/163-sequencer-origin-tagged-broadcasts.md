# ADR-163: Sequencer Origin-Tagged Broadcasts

## Status
Accepted

## Context

Issue #257 documented multiple failed attempts to fix sequencer state management. The core problems were:

1. **Ghost mode showing stale state** - Switching to a track without a sequencer showed values from the previous track
2. **Cross-track pollution** - Ghost edits on Track B modified state used by Track A's sequencer
3. **State loss during loading** - Race conditions between UI edits and Max broadcasts
4. **Echo overwrites** - After `set_state`, Max broadcasts back the state, overwriting any edits made during the round-trip

Previous fixes added complexity (grace periods, `restoredFromMax`, `lastLoadedTimestamp`, `lastHandledDeviceId`) but each fix for one scenario broke another.

### Key Insight

The MiniSequencer system already works correctly:
- Receives `sequencer-state` broadcasts for ALL tracks
- Caches state per-track via `useTrackData` composable
- Always shows correct state because it's purely reactive to broadcasts

The sequencerStore receives the **same data** but throws it away if it's not for the current track. The fix is to:
1. Cache all incoming broadcasts (we're already receiving them)
2. Apply from cache on track switch (instant, no request needed)
3. Use message origin tags to know when to skip echoes

## Decision

Implement origin-tagged broadcasts with per-track state caching.

### Message Format

V5.0 broadcast format adds an `origin` field (31 args total):
```
[trackIndex, origin, mutePattern[8], muteLength, muteBars, muteBeats, muteTicks,
 mutePosition, muteEnabled, pitchPattern[8], pitchLength, pitchBars, pitchBeats,
 pitchTicks, pitchPosition, pitchEnabled, temperature]
```

### Origin Values

| Origin | When Sent | Frontend Action |
|--------|-----------|-----------------|
| `init` | Device just initialized | Apply full state |
| `set_state_ack` | Echo of `set_state` from UI | Skip (we already have this state) |
| `mute_step` | Mute step toggled via OSC | Skip (we sent this) |
| `pitch_step` | Pitch step toggled via OSC | Skip (we sent this) |
| `mute_length` | Mute length changed via OSC | Skip (we sent this) |
| `mute_rate` | Mute rate changed via OSC | Skip (we sent this) |
| `pitch_length` | Pitch length changed via OSC | Skip (we sent this) |
| `pitch_rate` | Pitch rate changed via OSC | Skip (we sent this) |
| `temperature` | Temperature changed via OSC | Skip (we sent this) |
| `position` | Playhead moved (during playback) | Only update position fields |
| `pattr_restore` | Restored from Live Set / pattr | Apply full state (Max is authoritative) |
| `unknown` | Unrecognized or missing origin | Apply full state (safe fallback) |

### Frontend Logic

```typescript
// Always cache incoming state (we're receiving this data anyway)
stateCache.set(trackIndex, state);

// Skip if not our track
if (trackIndex !== selectedTrackStore.trackIndex) return;

// Skip echoes of our own commands
if (ECHO_ORIGINS.has(origin)) return;

// Skip if loading ghost device (pending edits are authoritative)
if (isLoading || loadingInitiated) return;

// Position-only update: just update playhead positions
if (origin === 'position') {
  muteCurrentStep = state.mute.position;
  pitchCurrentStep = state.pitch.position;
  return;
}

// Full state update (init, pattr_restore, unknown)
applyFullState(state);
```

### Track Change Handling

When track changes, `selectedTrackStore` calls `sequencerStore.onTrackChanged(trackIndex)`:

```typescript
function onTrackChanged(newTrackIndex: number) {
  // Apply cached state if available
  const cached = stateCache.get(newTrackIndex);
  if (cached) {
    applyFullState(cached);
  } else {
    // No cached state - reset to defaults (ghost mode)
    resetToDefaults();
  }
}
```

## Consequences

### Positive

1. **No echo overwrites** - Origin tags tell us exactly which broadcasts are echoes
2. **Instant track switches** - Cached state applied immediately, no waiting for broadcast
3. **Simpler mental model** - No timing heuristics, explicit origin-based decisions
4. **Better debugging** - Origin field shows exactly why each broadcast happened
5. **Net code reduction** - Removed ~50 lines (grace period, restoredFromMax), added ~30

### Negative

1. **Breaking change** - Max devices must be updated to include origin in broadcasts
2. **Cache memory** - Grows with number of tracks with sequencers (~200 bytes per track: 8 steps × 2 sequencers × ~10 fields; 100 tracks = 20KB, negligible)

### Implementation Note: pattr Feedback Loop

The Max patch routes `pattr_state` output through a `[pattr]` object for Live Set persistence. The pattr object's left outlet fires whenever data is stored, which was causing a feedback loop:

```
broadcastState() → pattr_state output → [pattr] stores → left outlet fires →
[prepend restoreState] → v8 → restoreState() → broadcastState('pattr_restore') → loop
```

**Fix:** Skip `pattr_state` output for `position` origin broadcasts. Position updates happen constantly during playback and don't need persistence. This breaks the feedback loop while preserving state persistence for actual pattern/setting changes.

### Supersedes

- ADR-160: Sequencer Loading Race Condition Fix
- ADR-161: Sequencer Ghost Mode Pending State Architecture

## Files Changed

### Max
- `ableton/M4L devices/sequencer-device.js` - Add origin parameter to `broadcastState()`

### Frontend
- `interface/src/lib/api/handlers/maxObserverHandler.ts` - Parse 31-arg format with origin
- `interface/src/lib/stores/v6/sequencerStore.svelte.ts` - State cache, origin filtering, track-changed event listener
- `interface/src/lib/stores/v6/selectedTrackStore.svelte.ts` - Dispatch `track-changed` event (avoids circular import)
- `interface/src/__tests__/unit/stores/sequencerStore.test.ts` - Updated tests
