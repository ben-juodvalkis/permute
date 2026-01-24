# Permute API Reference

Permute communicates via OSC (Open Sound Control) for external control and state synchronization.

## OSC Namespace

All Permute OSC messages use the `/looping/sequencer/` namespace prefix.

> **Note:** The namespace retains "looping" for backward compatibility with the Looping project. This may become configurable in a future version.

---

## Input Commands

Commands sent TO Permute to control the device. All commands include `deviceId` as the first argument for multi-device filtering.

### Mute Sequencer

#### Set Step
```
/looping/sequencer/mute/step [deviceId, stepIndex, value]
```
Toggle a single mute step.
- `deviceId`: Integer - Live API device ID
- `stepIndex`: Integer 0-7 - Step to modify
- `value`: Integer 0 or 1 - Mute state (0=muted, 1=unmuted)

#### Set Length
```
/looping/sequencer/mute/length [deviceId, length]
```
Set pattern length.
- `length`: Integer 1-64

#### Set Rate
```
/looping/sequencer/mute/rate [deviceId, bars, beats, ticks]
```
Set timing division in bar.beat.tick format.
- `bars`: Integer - Bars per step
- `beats`: Integer - Beats per step
- `ticks`: Integer - Ticks per step (480 ticks = 1 quarter note)

**Common divisions:**
| Division | bars | beats | ticks |
|----------|------|-------|-------|
| 1 bar | 1 | 0 | 0 |
| 1 beat | 0 | 1 | 0 |
| 1/8 note | 0 | 0 | 240 |
| 1/16 note | 0 | 0 | 120 |

### Pitch Sequencer

#### Set Step
```
/looping/sequencer/pitch/step [deviceId, stepIndex, value]
```
Toggle a single pitch step.
- `value`: Integer 0 or 1 - Pitch state (0=original, 1=octave up)

#### Set Length
```
/looping/sequencer/pitch/length [deviceId, length]
```

#### Set Rate
```
/looping/sequencer/pitch/rate [deviceId, bars, beats, ticks]
```

### Temperature

```
/looping/sequencer/temperature [deviceId, value]
```
Set temperature for organic variation.
- `value`: Float 0.0-1.0

### Complete State

```
/looping/sequencer/set/state [deviceId, ...state]
```
Set complete device state in one message. Used for ghost editing sync.

**Arguments (26 total):**
| Index | Field |
|-------|-------|
| 0 | deviceId |
| 1-8 | mutePattern[8] |
| 9 | muteLength |
| 10 | muteBars |
| 11 | muteBeats |
| 12 | muteTicks |
| 13-20 | pitchPattern[8] |
| 21 | pitchLength |
| 22 | pitchBars |
| 23 | pitchBeats |
| 24 | pitchTicks |
| 25 | temperature |

---

## Output Broadcasts

Messages sent FROM Permute for state synchronization.

### State Broadcast

```
/looping/sequencer/state [trackIndex, origin, ...state]
```

Broadcast whenever state changes. Enables multi-track displays and UI synchronization.

**Format (29 arguments):**

| Index | Field | Description |
|-------|-------|-------------|
| 0 | trackIndex | Track index in Ableton (0-based) |
| 1 | origin | Why this broadcast occurred |
| 2-9 | mutePattern[8] | 8 binary values (0=muted, 1=unmuted) |
| 10 | muteLength | Pattern length (1-64) |
| 11-13 | muteDivision | [bars, beats, ticks] |
| 14 | mutePosition | Current step (0-based) |
| 15-22 | pitchPattern[8] | 8 binary values (0=original, 1=octave up) |
| 23 | pitchLength | Pattern length (1-64) |
| 24-26 | pitchDivision | [bars, beats, ticks] |
| 27 | pitchPosition | Current step (0-based) |
| 28 | temperature | Temperature value (0.0-1.0) |

### Origin Values

The `origin` field indicates why the broadcast occurred:

| Origin | Description | Typical Frontend Action |
|--------|-------------|------------------------|
| `init` | Device just initialized | Apply full state |
| `pattr_restore` | Restored from Live Set | Apply full state |
| `set_state_ack` | Echo of set/state command | Skip (it's an echo) |
| `mute_step` | Mute step changed | Skip (echo) |
| `pitch_step` | Pitch step changed | Skip (echo) |
| `mute_length` | Mute length changed | Skip (echo) |
| `pitch_length` | Pitch length changed | Skip (echo) |
| `mute_rate` | Mute rate changed | Skip (echo) |
| `pitch_rate` | Pitch rate changed | Skip (echo) |
| `temperature` | Temperature changed | Skip (echo) |
| `position` | Playhead position update | Update positions only |
| `unknown` | Fallback | Apply full state |

**Echo Filtering:**

When the frontend sends a command (e.g., toggle mute step), Permute broadcasts the new state with an origin tag. The frontend should skip these "echo" broadcasts since it already has the correct local state. This prevents:
- UI flicker from round-trip updates
- Race conditions during rapid edits
- Stale state overwriting pending changes

---

## Max Patch Integration

### Internal Messages

These messages are routed internally within the Max patch:

#### Song Time
```
song_time [ticks]
```
Sent every 16th note with absolute tick position. Drives both mute and pitch sequencers from a single time source.

#### Direct Commands
```
mute pattern 1 0 1 0 1 0 1 0
mute division 0 0 120
mute step 3 0
mute length 16
mute reset

pitch pattern 0 0 1 0 0 1 0 0
pitch division 1 0 0
pitch step 2 1
pitch length 8
pitch reset

temperature 0.7
temperature_reset
temperature_shuffle
```

### State Persistence (pattr)

Permute integrates with Max's `pattr` system for Live Set persistence:

- `getvalueof()` - Returns JSON state when Live saves
- `setvalueof(json)` - Restores state when Live loads
- `restoreState(args...)` - Alternative restore via pattr routing

---

## Timing

### Tick Resolution

Ableton uses 480 ticks per quarter note. Common step divisions:

| Musical Value | Ticks |
|--------------|-------|
| Whole note | 1920 |
| Half note | 960 |
| Quarter note | 480 |
| 8th note | 240 |
| 16th note | 120 |
| 32nd note | 60 |

### Lookahead

Permute applies a 120-tick (1 sixteenth note) lookahead to compensate for Live API processing latency. Transformations are applied slightly ahead of when the audio actually plays.

---

## Examples

### Classic Trance Gate
```
/looping/sequencer/mute/step [deviceId, 2, 0]  // Mute step 2
/looping/sequencer/mute/step [deviceId, 5, 0]  // Mute step 5
/looping/sequencer/mute/rate [deviceId, 0, 0, 120]  // 16th notes
```

### Octave Jump Pattern
```
/looping/sequencer/pitch/step [deviceId, 4, 1]  // Octave up on step 4
/looping/sequencer/pitch/step [deviceId, 5, 1]
/looping/sequencer/pitch/step [deviceId, 6, 1]
/looping/sequencer/pitch/step [deviceId, 7, 1]
/looping/sequencer/pitch/rate [deviceId, 0, 1, 0]  // Quarter notes
```

### Organic Variation
```
/looping/sequencer/temperature [deviceId, 0.5]  // Medium variation
```

### Full State Sync
```
/looping/sequencer/set/state [deviceId, 1,0,1,0,1,1,1,1, 8, 0,0,120, 0,0,0,0,1,1,1,1, 8, 0,1,0, 0.3]
```
