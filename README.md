# Permute

A multi-transformation Max4Live device for Ableton Live that provides mute sequencing, pitch sequencing, note chance, and organic loop variation.

## Features

### Sequenced Transformations
- **Mute Sequencer**: Rhythmically mutes/unmutes notes in MIDI clips or adjusts gain in audio clips
- **Pitch Sequencer**: Transposes MIDI notes or audio clips up/down by an octave

### Non-Sequenced Transformations
- **Temperature**: Organic loop variation through intelligent pitch swapping
  - Randomly swaps note pitches each loop to create variation
  - Higher temperature = more swaps = more variation
  - Automatically regenerates pattern on each loop jump
- **Chance**: Sets Ableton's `note.probability` on every note in the current clip
  - `0.0` = never play, `1.0` = always play
  - Persists across transport start/stop so the slider value is always authoritative

All transformations:
- Work with both MIDI and audio clips (chance and temperature are MIDI-only)
- Revert their sequenced state when transport stops
- Compose together seamlessly

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/ben-juodvalkis/permute.git
   ```

2. Place the folder somewhere permanent (e.g., `~/Documents/Max4Live/permute`)

3. In Ableton Live, drag `Permute.amxd` onto any MIDI or audio track

## Usage

### Default Settings
- **Pattern Length**: 8 steps (mute + pitch sequencers)
- **Rate**: `1/4` note per step (index 5 of the rate menu)
- **Mute Pattern**: All unmuted `[1,1,1,1,1,1,1,1]`
- **Pitch Pattern**: No transposition `[0,0,0,0,0,0,0,0]`
- **Temperature**: `0.0` (off)
- **Chance**: `1.0` (every note plays)

### Pattern Values

**Mute Sequencer:**
- `1` = Unmuted (notes play)
- `0` = Muted (notes silent)

**Pitch Sequencer:**
- `0` = Original pitch
- `1` = One octave up (+12 semitones)

**Temperature:**
- `0.0` = Off (no variation)
- `0.3` = Low variation (pairs only)
- `0.6` = Medium variation (pairs and triplets)
- `1.0` = High variation (groups of 2-5 notes)

**Chance:**
- `0.0` = Never play
- `1.0` = Always play (default)

## How It Works

### MIDI Clips
- **Mute**: Sets the `mute` property on individual notes
- **Pitch**: Either adjusts a named device transpose parameter (drum / instrument racks) or modifies note pitches directly
- **Temperature**: Swaps pitches of temporally adjacent notes
- **Chance**: Sets `note.probability` on every note

### Audio Clips
- **Mute**: Adjusts clip gain (0 when muted, original gain when unmuted)
- **Pitch**: Adjusts `pitch_coarse` parameter (+12/-12 semitones)
- Temperature and chance are MIDI-only (no notes to manipulate on audio clips)

### Intelligent Instrument Detection

The device automatically detects instrument type and chooses the optimal pitch method:

- **Drum Racks** (`DrumGroupDevice`): Uses a named transpose parameter to keep samples on correct pads
- **Instrument Racks** (`InstrumentGroupDevice`): Uses rack-level transpose control
- **Other Instruments**: Modifies note pitches directly

See [permute-constants.js](permute-constants.js) for the priority-ordered list of parameter names.

## Architecture

Permute uses a **delta-based state tracking** architecture:

- Tracks last-applied values per clip (`{ pitch, mute }`)
- Applies changes only on value transitions (`0 → 1` or `1 → 0`)
- Temperature captures original pitches by `note_id` so shuffling is reversible even with overdubs
- All Live API modifications from observers use `defer()` to avoid notification conflicts

The Max UI is the source of truth: every `live.*` object has `parameter_enable: 1`, so Live handles persistence, automation, undo, and Push mapping directly — there is no OSC layer and no JS shadow state. See [ADR-010](docs/adr/010-ui-native-revamp.md) for the rationale.

## Integration

Permute is a self-contained Max4Live device. Its only external surfaces are its Max inlets/outlets (see [docs/api.md](docs/api.md)) and the named Live parameters, which are readable by any Push/LiveAPI/automation consumer in the normal way.

## Debug Mode

Enable comprehensive logging:

1. Open [permute-utils.js](permute-utils.js)
2. Find `var DEBUG_MODE = false;` (near the top of the file)
3. Change to `var DEBUG_MODE = true;`
4. Save and reload the device

## Version History

- **v3.3**: UI-native revamp — removed OSC, removed `request_ui_values` handshake, per-step `live.toggle` objects replace bulk pattern messages (ADR-010)
- **v3.2**: Note chance (probability) feature (ADR-009)
- **v3.1**: Note ID-based temperature tracking for reversible transformations
- **v3.0**: Delta-based state tracking refactor (30% code reduction)
- **v2.2**: Performance optimization with deferred batching
- **v2.1**: Temperature transformation with loop-synchronized variation
- **v2.0**: Architectural transformation with generic Sequencer class
- **v1.0**: Initial dual sequencer implementation

## License

MIT
