# Sequencer Device for Max4Live

A multi-transformation device for Ableton Live that provides mute sequencing, pitch sequencing, and organic loop variation for both MIDI and audio clips.

## Overview

This Max4Live device provides three powerful transformations:

### Sequenced Transformations
- **Mute Sequencer**: Rhythmically mutes/unmutes notes in MIDI clips or adjusts gain in audio clips
- **Pitch Sequencer**: Transposes MIDI notes or audio clips up/down by an octave

### Loop-Based Transformations
- **Temperature**: Organic loop variation through intelligent pitch swapping
  - Randomly swaps note pitches each loop to create variation
  - Higher temperature = more/larger swaps = more variation
  - Automatically regenerates pattern on each loop jump
  - Composes with pitch sequencer (swaps octave-shifted notes)

All transformations:
- Are enabled by default
- Automatically reset when transport stops
- Work with both MIDI and audio clips
- Compose together seamlessly via layer system

## Installation

1. Place `sequencer-device.js` in your Max4Live device folder
2. Create a Max4Live device that loads this JavaScript file
3. Add the device to any MIDI or audio track in Ableton Live
4. The device auto-initializes when loaded

## Basic Usage

The sequencers start with default settings:
- **Pattern Length**: 8 steps
- **Division**: 1 bar per step (1.0.0)
- **Mute Pattern**: All unmuted [1,1,1,1,1,1,1,1]
- **Pitch Pattern**: No transposition [0,0,0,0,0,0,0,0]

### Pattern Values

**Mute Sequencer:**
- `1` = Unmuted (notes play)
- `0` = Muted (notes silent)

**Pitch Sequencer:**
- `0` = Original pitch
- `1` = One octave up (+12 semitones)

## Command Reference

### Mute Sequencer Commands

#### Set Pattern
```
mute pattern 1 0 1 0 1 0 1 0
```
Sets an 8-step mute pattern (1=play, 0=mute)

#### Set Division (Timing)
```
mute division 1 0 0    // 1 bar per step
mute division 0 1 0    // 1 quarter note per step
mute division 0 0 240  // 1 eighth note per step
mute division 0 0 120  // 1 sixteenth note per step
```
Uses bar.beat.tick format where:
- First number: bars
- Second number: beats (quarter notes)
- Third number: ticks (480 ticks per quarter note)

#### Set Individual Step
```
mute step 0 1    // Set step 0 to unmuted
mute step 3 0    // Set step 3 to muted
```

#### Set Pattern Length
```
mute length 16   // Set pattern to 16 steps (max 64)
```

#### Enable/Disable (optional, enabled by default)
```
mute enable 1    // Enable mute sequencer
mute enable 0    // Disable mute sequencer
```

#### Bypass (for debugging)
```
mute bypass 1    // Bypass mute processing (pattern still advances)
mute bypass 0    // Normal operation
```

#### Reset
```
mute reset       // Reset to step 0
```

#### Tick Processing (sent automatically by transport)
```
mute tick 1920   // Process tick at position 1920
```

### Pitch Sequencer Commands

#### Set Pattern
```
pitch pattern 0 0 1 0 0 1 0 0
```
Sets an 8-step pitch pattern (0=original, 1=octave up)

#### Set Division (Timing)
```
pitch division 1 0 0    // 1 bar per step
pitch division 0 1 0    // 1 quarter note per step
pitch division 0 0 240  // 1 eighth note per step
```

#### Set Individual Step
```
pitch step 2 1    // Set step 2 to octave up
pitch step 5 0    // Set step 5 to original pitch
```

#### Set Pattern Length
```
pitch length 8    // Set pattern to 8 steps
```

#### Enable/Disable (optional, enabled by default)
```
pitch enable 1    // Enable pitch sequencer
pitch enable 0    // Disable pitch sequencer
```

#### Reset
```
pitch reset       // Reset to step 0
```

#### Tick Processing
```
pitch tick 1920   // Process tick at position 1920
```

### Temperature Commands

#### Set Temperature
```
temperature 0.0     // Off (no variation)
temperature 0.3     // Low variation (pairs only)
temperature 0.6     // Medium variation (pairs and triplets)
temperature 1.0     // High variation (groups of 2-5 notes)
```

Temperature value (0.0-1.0) controls:
- **Probability** of forming shuffle groups (higher = more groups)
- **Size** of shuffle groups (higher = larger groups)

**Temperature Ranges:**
- `0.0-0.33`: Pairs only (2 notes)
- `0.34-0.66`: Mix of pairs and triplets (2-3 notes)
- `0.67-1.0`: Larger groups (2-5 notes)

**Behavior:**
- Generates new random pattern on each loop jump
- Swaps are based on temporal adjacency (nearby notes swap)
- Works on current state (composes with pitch shifts)
- Automatically disables when set to 0.0

#### Manual Shuffle
```
temperature_shuffle    // Force immediate pattern regeneration
```
Regenerates the swap pattern without waiting for loop jump.

#### Reset
```
temperature_reset      // Disable temperature and restore original
```
Equivalent to `temperature 0.0`

## How It Works

The sequencer automatically detects track type and instrument to choose the optimal method.

**Configuration**: All parameter indices and shift amounts are loaded from `/config/constants.json` (single source of truth). The device falls back to safe defaults if the config file cannot be read.

### MIDI + Standard Drum Rack
- **Mute**: Sets the `mute` property on individual notes (0=unmuted, 1=muted)
- **Pitch**: Adjusts device transpose parameter (config: `drumRackStandard.parameterIndex`, default: parameter 4, relative shift ±16)
- **Detection**: Identified by macro 1="FX1" and macro 2="FX2"
- **Benefit**: Keeps drum samples on correct pads while transposing
- **Dynamic**: Automatically detected even if added after sequencer device

### MIDI + Komplete Kontrol Drum Rack
- **Mute**: Sets the `mute` property on individual notes (0=unmuted, 1=muted)
- **Pitch**: Adjusts macro parameter (config: `drumRackKompleteKontrol.parameterIndex`, default: parameter 16, absolute positioning: original ↔ original+21)
- **Detection**: Identified by custom macro names (not "FX1"/"FX2")
- **Benefit**: Works with KK-mapped drum racks that use macro 16 for octave control
- **Note**: Never goes below original value, only up by configured shift amount and back to original
- **Dynamic**: Automatically detected even if added after sequencer device

### MIDI + Instrument Rack
- **Mute**: Sets the `mute` property on individual notes (0=unmuted, 1=muted)
- **Pitch**: Adjusts device transpose parameter (config: `instrumentRack.parameterIndex`, default: parameter 15, relative shift ±12 semitones)
- **Detection**: Identified by class name "InstrumentGroupDevice"
- **Benefit**: Uses rack-level transpose control for consistent transposition across all contained instruments
- **Dynamic**: Automatically detected even if added after sequencer device

### MIDI + Other Instruments
- **Mute**: Sets the `mute` property on individual notes (0=unmuted, 1=muted)
- **Pitch**: Adds/subtracts 12 semitones to note pitch values
- **Benefit**: Direct note transposition for melodic instruments

### Audio Clips
- **Mute**: Adjusts clip gain (0 for muted, original gain for unmuted)
- **Pitch**: Adjusts `pitch_coarse` parameter (+12/-12 semitones)
- **Temperature**: Swaps audio clip pitches (future enhancement)

### Temperature Transformation (MIDI only)

Temperature provides organic loop variation by randomly swapping note pitches:

**Algorithm:**
1. **Sort notes** by start time (temporal adjacency)
2. **Form shuffle groups** based on temperature:
   - Roll random number for each position
   - If roll < temperature, form a group
   - Group size determined by temperature range
3. **Shuffle within groups** using Fisher-Yates algorithm
4. **Apply swaps** to current pitch state (includes pitch shifts)

**Key Features:**
- **Loop-synchronized**: Automatically regenerates on loop jump
- **Temporal adjacency**: Swaps nearby notes, preserving musical flow
- **Variable group sizes**: Higher temperature = larger groups = more variation
- **Composes with pitch**: Swaps octave-shifted notes when pitch sequencer is active
- **Debounced**: 50ms delay on slider changes prevents excessive regeneration

**Example (temp=0.7, notes=[C4, D4, E4, F4, G4]):**
```
1. Sort by time: [C4, D4, E4, F4, G4]
2. Form groups: [C4,D4,E4], [F4,G4]
3. Shuffle: [E4,C4,D4], [G4,F4]
4. Result: [E4, C4, D4, G4, F4]
```

**With Pitch Sequencer (octave up):**
```
1. Pitch shifts: [C5, D5, E5, F5, G5]
2. Temperature swaps: [E5, C5, D5, G5, F5]
3. Result: Octave-shifted notes are swapped ✅
```

### Transport Behavior
When transport stops:
- Both sequencers reset to step 0
- Muted clips/notes return to unmuted state
- Pitched clips return to original pitch
- Temperature restores original note order
- All patterns/values are preserved for next playback

When transport starts:
- Temperature automatically reapplies if value > 0
- Uses retry logic (up to 5 attempts) to handle clip availability race conditions

### Timing Synchronization
The device receives tick messages from the transport/clock source. It calculates the current step based on:
- Absolute tick position from transport
- Division setting (how many ticks per step)
- Pattern length

Example: With division set to `0 0 120` (sixteenth notes) and pattern length 8:
- Tick 0-119: Step 0
- Tick 120-239: Step 1
- Tick 240-359: Step 2
- etc.

## Examples

### Classic Trance Gate (Mute)
```
mute pattern 1 1 0 1 1 0 1 0
mute division 0 0 120    // 16th notes
```

### Octave Jumps (Pitch)
```
pitch pattern 0 0 0 0 1 1 1 1
pitch division 0 1 0     // Quarter notes
```

### Combined Mute + Pitch
```
mute pattern 1 0 1 0 1 1 1 1
mute division 0 0 120    // 16th notes

pitch pattern 0 0 0 0 1 0 0 0
pitch division 1 0 0     // 1 bar
```

### Organic Variation (Temperature)
```
temperature 0.5    // Medium variation
```
Notes will randomly swap on each loop, creating organic variation while maintaining musical coherence.

### Temperature + Pitch = Shifting Chaos
```
pitch pattern 0 0 0 0 1 1 1 1    // Octave up on second half
pitch division 0 1 0              // Quarter notes

temperature 0.7                   // High variation
```
Temperature swaps the octave-shifted notes, creating evolving melodic patterns that jump between registers.

## Troubleshooting

### No Effect on Playback
- Ensure transport is playing
- Check that tick messages are being sent
- Verify the device is on the correct track type (MIDI/audio)

### Notes Not Muting
- For MIDI: Ensure the clip contains notes
- For audio: Check that the clip has non-zero gain

### Pitch Not Changing
- Check that pattern contains some `1` values
- Ensure notes aren't already at MIDI limits (0 or 127)

### Pattern Not Advancing
- Verify tick messages are being received
- Check division setting matches your intended timing
- Ensure transport is running

## Technical Details

- **JavaScript API**: Uses Max4Live's JavaScript Live API
- **Tick Resolution**: Based on Ableton's 480 ticks per quarter note
- **Cache Management**: Notes are cached and invalidated on clip/content changes
- **Observer Pattern**: Watches for transport state, clip content changes, and device changes
- **Error Handling**: Defers API calls when in observer context to avoid conflicts
- **Intelligent Detection**: Automatically scans track devices to detect DrumRack/InstrumentRack vs other instruments
- **Dynamic Re-detection**: Device observer watches for instrument additions/removals/reordering and automatically re-detects instrument type
- **Device Parameter Access**: Uses proper Live API paths (device.path + " parameters N") for parameter control

## Debug Mode

Enable comprehensive logging for development and troubleshooting:

1. Open `sequencer-device.js` in a text editor
2. Find line ~113: `var DEBUG_MODE = false;`
3. Change to: `var DEBUG_MODE = true;`
4. Save and reload the device in Ableton Live
5. Open Max console to view detailed logs

**Debug Output Includes:**
- Initialization (track type, instrument detection)
- Step processing (step number, value, tick position)
- Transformation applications
- Layer composition
- Error details with context

**Format:** `[Sequencer DEBUG:context] message | Data: {...}`

## OSC Broadcast Format (V5.0)

The device broadcasts its complete state via OSC for frontend synchronization. This enables multi-track sequencer displays, state caching, and ghost mode editing.

### Broadcast Address
```
/looping/sequencer/state
```

### Message Format (31 arguments)

| Args | Field | Description |
|------|-------|-------------|
| 0 | trackIndex | Track index in Ableton (0-based) |
| 1-8 | mutePattern | 8 binary values (0=muted, 1=unmuted) |
| 9 | muteLength | Pattern length (1-64) |
| 10-12 | muteDivision | [bars, beats, ticks] timing format |
| 13 | mutePosition | Current step (0-based) |
| 14 | muteEnabled | Sequencer enabled state (0/1) |
| 15-22 | pitchPattern | 8 binary values (0=original, 1=octave up) |
| 23 | pitchLength | Pattern length (1-64) |
| 24-26 | pitchDivision | [bars, beats, ticks] timing format |
| 27 | pitchPosition | Current step (0-based) |
| 28 | pitchEnabled | Sequencer enabled state (0/1) |
| 29 | temperature | Temperature value (0.0-1.0) |
| 30 | origin | Origin tag (see below) |

### Origin Tags

The `origin` field identifies what triggered the broadcast, enabling the frontend to skip echoes of its own commands:

| Origin | Description | Frontend Action |
|--------|-------------|-----------------|
| `init` | Device initialization | Apply full state |
| `pattr_restore` | Live Set restore | Apply full state |
| `set_state_ack` | Acknowledgment of set/state command | Skip (echo) |
| `mute_step` | Mute step change | Skip (echo) |
| `pitch_step` | Pitch step change | Skip (echo) |
| `mute_length` | Mute length change | Skip (echo) |
| `pitch_length` | Pitch length change | Skip (echo) |
| `mute_rate` | Mute rate/division change | Skip (echo) |
| `pitch_rate` | Pitch rate/division change | Skip (echo) |
| `temperature` | Temperature value change | Skip (echo) |
| `position` | Playhead position update | Update positions only |
| `unknown` | Fallback for unrecognized triggers | Apply full state |

### OSC Input Commands

| Address | Arguments | Description |
|---------|-----------|-------------|
| `/looping/sequencer/mute/step` | deviceId, stepIndex, value | Set mute step |
| `/looping/sequencer/mute/length` | deviceId, length | Set mute pattern length |
| `/looping/sequencer/mute/rate` | deviceId, bars, beats, ticks | Set mute timing |
| `/looping/sequencer/pitch/step` | deviceId, stepIndex, value | Set pitch step |
| `/looping/sequencer/pitch/length` | deviceId, length | Set pitch pattern length |
| `/looping/sequencer/pitch/rate` | deviceId, bars, beats, ticks | Set pitch timing |
| `/looping/sequencer/temperature` | deviceId, value | Set temperature (0.0-1.0) |
| `/looping/sequencer/set/state` | deviceId, ...fullState | Set complete state (28 args) |

See [ADR 163](../../documentation/adr/163-sequencer-origin-tagged-broadcasts.md) for the full architectural rationale.

## Architecture (v3.0)

The device uses a **delta-based state tracking** architecture for simplicity and reliability:

### Core Components

1. **VALUE_TYPES System** - Validates pattern values (binary, midi_range, normalized, semitones)
2. **Sequencer Class** - Generic wrapper that adds timing/pattern control to transformations
3. **Batching System** - Accumulates changes and applies in 1ms (eliminates race conditions)
4. **Delta-Based Tracking** - Tracks last values, applies deltas only on change
5. **Instrument Strategy Pattern** - Device-specific pitch handling (drum racks, instrument racks)

### Key Architectural Principles (v3.0)

**Delta-Based State Tracking:**
- Tracks `lastValues` per clip: `{ pitch: 0/1, mute: 0/1 }`
- Applies deltas only on value change:
  - `0→1`: Apply transformation
  - `1→0`: Reverse transformation
  - `0→0` or `1→1`: Do nothing
- No pristine state needed - simpler and more reliable

**Transport-Scoped Undo:**
- On stop, reverse transformations based on `lastValues`
- Pitch was `1`: Shift down -12 semitones
- Mute was `0`: Unmute all notes
- Delete `lastValues[clipId]` after undo

**Temperature Composition:**
- Reads **current clip state** (includes mute/pitch transformations)
- Generates swap pattern from current notes
- Swaps within current state (octave-shifted notes stay shifted)
- No pristine state required

**Deferred Apply Pattern:**
- All Live API modifications from observers use `defer()`
- Prevents "Changes cannot be triggered by notifications" error
- Critical for transport observers and loop jump handlers

### Benefits

- **Simple**: 30% less code than v2.1 (869 lines removed)
- **Reliable**: Delta-based approach eliminates complex state management
- **Composable**: Temperature naturally composes with mute/pitch
- **Performant**: Smart batching minimizes Live API calls
- **Maintainable**: Straightforward state machine

See [ADR 110](../../documentation/adr/110-sequencer-device-v3-refactor.md) for full architectural details.

## Version History

- **v5.0**: Origin-tagged broadcasts with state caching (2026-01-21)
  - Added origin tags to state broadcasts (31 args total)
  - Enables frontend to skip echoes of its own commands
  - Per-track state caching for instant track switches
  - Fixed ghost mode stale state and echo overwrites
  - Fixed pattr feedback loop during playback
  - See [ADR 163](../../documentation/adr/163-sequencer-origin-tagged-broadcasts.md) for details
- **v3.0**: Delta-based state tracking refactor (2025-11-08)
  - Removed layer system architecture (~1336 lines)
  - Implemented delta-based state tracking with `lastValues`
  - Simplified from pristine state to delta-on-change approach
  - Temperature now reads current state (natural composition)
  - Added `defer()` pattern for Live API observer callbacks
  - Fixed "Changes cannot be triggered by notifications" error
  - Net reduction: 869 lines (30%)
  - Functionally equivalent to v2.2 with simpler implementation
  - See [ADR 110](../../documentation/adr/110-sequencer-device-v3-refactor.md) for full details
- **v2.2**: Performance optimization with deferred batching (2025-11-06)
  - Added deferred apply batching to prevent race conditions
  - Implemented value-based cache invalidation for efficiency
  - Reduced `apply_note_modifications` calls by ~90%
  - Eliminated race conditions between mute, pitch, and temperature
  - Fixed temperature evolution reliability issues
  - Improved CPU performance (~40% reduction during playback)
  - See [ADR 108](../../documentation/adr/108-deferred-transformation-batching.md) for full details
- **v2.1**: Temperature transformation with loop-synchronized variation (2025-11-05)
  - Added Temperature transformation for organic loop variation
  - Group-based pitch shuffling with variable group sizes (2-5 notes)
  - Loop jump observer for automatic pattern regeneration
  - Proper layer composition (temperature swaps already-transformed pitches)
  - Race condition fixes with retry logic for transport start
  - Debounced temperature changes (50ms) for smooth slider interaction
  - See [ADR 106](../../documentation/adr/106-temperature-transformation-architecture.md) for full details
- **v2.0**: Architectural transformation for extensibility (2025-10-30)
  - Complete refactor with generic Sequencer and Transformation classes
  - Two-phase TransformationLayerManager (generative → modificative)
  - VALUE_TYPES system for pattern validation
  - State format v2.0 with backward compatibility for v1.x
  - All instrument detection encapsulated in PitchTransformation
  - Ready for future transformations (velocity, ratchet, probability, etc.)
  - ~1000 lines of new architecture, eliminates future code duplication
- **v1.3**: Dynamic device observation and Instrument Rack support
  - Added device observer that watches for instrument changes on track
  - Automatically re-detects instrument type when devices are added/removed/reordered
  - Added Instrument Rack support (parameter 8, ±12 semitones)
  - Resets pitch state when instrument device changes
  - Fixes issue where drum racks added after sequencer weren't detected
- **v1.2**: Enhanced drum rack detection to support Komplete Kontrol variants
  - Distinguishes between standard and Komplete Kontrol drum racks via macro name detection
  - Standard drum racks use parameter 4 with relative shifting (±16)
  - KK drum racks use parameter 16 (macro 16) with absolute positioning (original ↔ original+21)
  - KK drum racks never go below original value, ensuring predictable behavior
- **v1.1**: Added intelligent instrument detection
  - DrumRack detection and device-level transpose control
  - Three-tier pitch handling (DrumRack/MIDI/Audio)
  - Enhanced debugging and device scanning
- **v1.0**: Initial dual sequencer implementation with MIDI/audio support
  - Transport stop reset functionality
  - Bar.beat.tick timing format
  - Bypass mode for debugging