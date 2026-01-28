# ADR-002: Restore State Format Fix (28-arg alignment)

**Date:** 2026-01-27
**Status:** Implemented

## Context

After implementing ADR-166 (Lazy Observer Simplification), which removed the `muteEnabled` and `pitchEnabled` fields from the broadcast format (reducing from 31 to 29 args), the `restoreState()` function was not updated to match.

### Symptom

When loading a saved Live Set, state would reset to defaults instead of restoring:

```
print: restoreState 1 0 0 0 0 1 1 1 1 8 1 0 0 -1 0 0 0 0 1 1 1 1 8 1 0 0 -1 0
v8: [RESTORE] restoreState called with 28 args
v8: [RESTORE] Not enough args, skipping
```

### Root Cause

The state format evolution:

| Version | Broadcast Args | pattr Args | Notes |
|---------|---------------|------------|-------|
| ADR-163 | 31 | 30 | Included `muteEnabled`, `pitchEnabled` |
| ADR-166 | 29 | 28 | Removed enabled fields (derived from pattern) |

The `broadcastState()` function correctly outputs 28 args to pattr (29-arg broadcast minus origin), but `restoreState()` still expected 30 args and checked `args.length < 30`, causing all restores to be skipped.

## Decision

### 1. Update `restoreState()` to expect 28 args

**Before (incorrect):**
```javascript
if (args.length < 30) {
    post('[RESTORE] Not enough args, skipping\n');
    return;
}
// ...
idx += 2;  // Skip mute position AND enabled
// ...
idx += 2;  // Skip pitch position AND enabled
```

**After (correct):**
```javascript
if (args.length < 28) {
    post('[RESTORE] Not enough args (expected 28, got ' + args.length + '), skipping\n');
    return;
}
// ...
idx += 1;  // Skip mute position only (enabled removed in ADR-166)
// ...
idx += 1;  // Skip pitch position only (enabled removed in ADR-166)
```

### 2. Prevent pattr feedback loop

When `restoreState()` completes, it calls `broadcastState('pattr_restore')`. This was outputting to `pattr_state`, which triggered another `restoreState()` call, creating a loop.

**Fix:** Skip `pattr_state` output for `pattr_restore` origin:

```javascript
// Before
if (origin !== 'position') {

// After
if (origin !== 'position' && origin !== 'pattr_restore') {
```

## pattr State Format (28 args)

| Index | Field | Description |
|-------|-------|-------------|
| 0 | trackIndex | Track index in Ableton |
| 1-8 | mutePattern[8] | Mute steps (1=unmuted, 0=muted) |
| 9 | muteLength | Active pattern length (1-8) |
| 10 | muteBars | Mute division: bars |
| 11 | muteBeats | Mute division: beats |
| 12 | muteTicks | Mute division: ticks |
| 13 | mutePosition | Current mute step (runtime, skipped on restore) |
| 14-21 | pitchPattern[8] | Pitch steps (1=shifted, 0=no shift) |
| 22 | pitchLength | Active pattern length (1-8) |
| 23 | pitchBars | Pitch division: bars |
| 24 | pitchBeats | Pitch division: beats |
| 25 | pitchTicks | Pitch division: ticks |
| 26 | pitchPosition | Current pitch step (runtime, skipped on restore) |
| 27 | temperature | Randomization amount (0.0-1.0) |

## Consequences

### Positive
- State now correctly restores when loading Live Sets
- No more feedback loop on restore (single restore call per device)
- Format documented and aligned with ADR-166

### Negative
- None

## Files Changed

| File | Changes |
|------|---------|
| `permute-device.js` | Updated `restoreState()` to expect 28 args, skip `pattr_restore` in pattr output |

## Related

- ADR-166: Sequencer Auto-Load & Lazy Observer Simplification (removed enabled fields)
- ADR-163: Sequencer Origin-Tagged Broadcasts (introduced origin field)
