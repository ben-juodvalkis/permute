# ADR-166: Sequencer Auto-Load & Lazy Observer Simplification

**Date:** 2026-01-22
**Status:** Implemented

## Context

The sequencer device was manually loaded by users when needed, and immediately created transport/time signature observers on initialization. This caused:

1. **Manual overhead** - Users had to explicitly load the sequencer device
2. **Unnecessary CPU** - Observers running even when sequencer wasn't in use
3. **Complex state** - Explicit `enabled` flags that could desync from actual usage

## Decision

Radically simplify the sequencer by:

1. **Auto-load on track creation** - Sequencer device loaded automatically on new MIDI/audio tracks
2. **Auto-load on ghost editing** - If user edits sequencer UI without a device, load it on demand
3. **Lazy observer activation** - Transport/time signature observers only created when sequencer becomes active
4. **Pattern-derived active state** - Remove explicit `enabled` flag; derive from pattern content

## State Broadcast Format

### New 29-Argument Format

| Index | Field | Description |
|-------|-------|-------------|
| 0 | `trackIndex` | Track index in Ableton |
| 1 | `origin` | Why broadcast occurred |
| 2-9 | `mutePattern[8]` | Mute steps (1=unmuted, 0=muted) |
| 10 | `muteLength` | Active pattern length (1-8) |
| 11 | `muteBars` | Mute division: bars |
| 12 | `muteBeats` | Mute division: beats |
| 13 | `muteTicks` | Mute division: ticks |
| 14 | `mutePosition` | Current mute step (playhead) |
| 15-22 | `pitchPattern[8]` | Pitch steps (1=shifted, 0=no shift) |
| 23 | `pitchLength` | Active pattern length (1-8) |
| 24 | `pitchBars` | Pitch division: bars |
| 25 | `pitchBeats` | Pitch division: beats |
| 26 | `pitchTicks` | Pitch division: ticks |
| 27 | `pitchPosition` | Current pitch step (playhead) |
| 28 | `temperature` | Randomization amount (0.0-1.0) |

### Origin Values

| Origin | Description |
|--------|-------------|
| `init` | Device just initialized |
| `set_state_ack` | Echo of set_state from UI |
| `mute_step` | Mute step toggled |
| `pitch_step` | Pitch step toggled |
| `mute_length` | Mute length changed |
| `pitch_length` | Pitch length changed |
| `mute_rate` | Mute rate changed |
| `pitch_rate` | Pitch rate changed |
| `temperature` | Temperature changed |
| `position` | Playhead moved (during playback) |
| `pattr_restore` | Restored from Live Set |

### Removed Fields (was 31 args)

- `muteEnabled` (was arg 15) - Now derived: `muteActive = pattern has any 0`
- `pitchEnabled` (was arg 29) - Now derived: `pitchActive = pattern has any 1`

## Implementation

### 1. Lazy Observer Activation (`sequencer-device.js`)

```javascript
// Only device observer created on init
SequencerDevice.prototype.init = function() {
    this.setupDeviceObserver();
    // Transport/time sig observers NOT created here
};

// Lazy creation when sequencer becomes active
SequencerDevice.prototype.ensurePlaybackObservers = function() {
    if (this.playbackObserversActive) return;
    this.setupTransportObserver();
    this.setupTimeSignatureObserver();
    this.playbackObserversActive = true;
};

// Called from setPattern/setStep
SequencerDevice.prototype.checkAndActivateObservers = function() {
    if (this.playbackObserversActive) return;
    if (this.sequencers.muteSequencer.isActive() ||
        this.sequencers.pitchSequencer.isActive()) {
        this.ensurePlaybackObservers();
    }
};
```

### 2. Pattern-Derived Active State

```javascript
Sequencer.prototype.isActive = function() {
    for (var i = 0; i < this.patternLength; i++) {
        if (this.pattern[i] !== this.defaultValue) {
            return true;
        }
    }
    return false;
};
// Mute: defaultValue = 1 (unmuted), active if any step = 0
// Pitch: defaultValue = 0 (no shift), active if any step = 1
```

### 3. Auto-Load on Track Creation (`liveAPI-v6.js`)

```javascript
var SEQUENCER_DEVICE_PATH = "/path/to/Sequencer.amxd";
var SEQUENCER_AUTO_LOAD_ENABLED = true;

function createMidiTrack(index) {
    // ... create track ...
    if (SEQUENCER_AUTO_LOAD_ENABLED && SEQUENCER_DEVICE_PATH) {
        outlet(1, "/looping/devices/addfile", SEQUENCER_DEVICE_PATH);
    }
}
```

### 4. Auto-Load on Ghost Editing (`sequencerStore.svelte.ts`)

When user edits sequencer UI without a device present (ghost mode), auto-load:

```typescript
// Ghost mode = no device present
let isGhost = $derived(!device);

function triggerLoad() {
    if (isGhost && !loadingInitiated) {
        loadingInitiated = true;
        isLoading = true;
        send('/looping/devices/load', [DEVICE_PRESETS.sequencer.presetPath]);
    }
}

// All ghost handlers update local state then trigger load
function handleMuteStepToggleGhost(stepIndex: number) {
    muteSteps[stepIndex] = !muteSteps[stepIndex];
    triggerLoad();  // Load device, onDeviceLoaded will push state
}
```

### 5. Frontend Parsing (`maxObserverHandler.ts`)

```typescript
// Derive active state from pattern
const muteActive = mutePattern.some(v => !v);  // Any muted step
const pitchActive = pitchPattern.some(v => v); // Any shifted step
```

## Timing

The 40-tick lookahead for transformations is unchanged:

```javascript
SequencerDevice.prototype.processWithSongTime = function(ticks) {
    var lookaheadTicks = 40;  // ~1/3 of a 16th note
    var targetTicks = ticks + lookaheadTicks;
    this.processSequencerTick('mute', targetTicks);
    this.processSequencerTick('pitch', targetTicks);
};
```

## CPU Impact

| State | Observers | CPU |
|-------|-----------|-----|
| Device loaded, no activity | 1 (device) | ~0% |
| One sequencer active | 3 (device, transport, time sig) | Minimal |
| Both active | 3 (shared) | Minimal |
| Transport stopped | Observers dormant | ~0% |

## Files Modified

| File | Changes |
|------|---------|
| `ableton/M4L devices/sequencer-device.js` | Lazy observers, isActive(), remove enabled |
| `ableton/scripts/liveAPI-v6.js` | Auto-load on track creation |
| `interface/src/lib/api/handlers/maxObserverHandler.ts` | Parse 29-arg format |
| `interface/src/lib/stores/v6/sequencerStore.svelte.ts` | Derived active state, ghost editing with auto-load |

## Consequences

### Positive
- Zero CPU overhead when sequencer not in use
- Sequencer always available without manual loading
- Simpler state model (no enable/disable sync issues)
- Backward compatible (frontend still uses `enabled` field name)

### Negative
- Slightly larger Live Set files (sequencer on every track)
- Small delay on first sequencer activation (observer creation)
- **Hardcoded path limitation**: `SEQUENCER_DEVICE_PATH` in `liveAPI-v6.js` must be manually updated by users. Max/MSP JavaScript cannot import JSON files, so this path cannot use `constants.json`. See CLAUDE.md "Common User Issues" for setup instructions.
