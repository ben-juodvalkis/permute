# Permute

A multi-transformation Max4Live device for Ableton Live that provides mute sequencing, pitch sequencing, and organic loop variation.

## Features

### Sequenced Transformations
- **Mute Sequencer**: Rhythmically mutes/unmutes notes in MIDI clips or adjusts gain in audio clips
- **Pitch Sequencer**: Transposes MIDI notes or audio clips up/down by an octave

### Loop-Based Transformations
- **Temperature**: Organic loop variation through intelligent pitch swapping
  - Randomly swaps note pitches each loop to create variation
  - Higher temperature = more swaps = more variation
  - Automatically regenerates pattern on each loop jump

All transformations:
- Work with both MIDI and audio clips
- Automatically reset when transport stops
- Compose together seamlessly

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/permute.git
   ```

2. Place the folder somewhere permanent (e.g., `~/Documents/Max4Live/permute`)

3. In Ableton Live, drag `Permute.amxd` onto any MIDI or audio track

## Usage

### Default Settings
- **Pattern Length**: 8 steps
- **Division**: 1 bar per step
- **Mute Pattern**: All unmuted `[1,1,1,1,1,1,1,1]`
- **Pitch Pattern**: No transposition `[0,0,0,0,0,0,0,0]`

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

## How It Works

### MIDI Clips
- **Mute**: Sets the `mute` property on individual notes
- **Pitch**: Either adjusts device transpose parameter (drum/instrument racks) or modifies note pitches directly
- **Temperature**: Swaps pitches of temporally adjacent notes

### Audio Clips
- **Mute**: Adjusts clip gain (0 for muted, original gain for unmuted)
- **Pitch**: Adjusts `pitch_coarse` parameter (+12/-12 semitones)

### Intelligent Instrument Detection

The device automatically detects instrument type and chooses the optimal pitch method:

- **Drum Racks**: Uses device transpose parameter to keep samples on correct pads
- **Instrument Racks**: Uses rack-level transpose control
- **Other Instruments**: Modifies note pitches directly

## Architecture

Permute uses a **delta-based state tracking** architecture:

- Tracks last applied values per clip
- Applies changes only on value transitions (0→1 or 1→0)
- Temperature reads current state, enabling natural composition with pitch shifts
- All Live API modifications from observers use `defer()` to avoid notification conflicts

See [docs/architecture.md](docs/architecture.md) for detailed technical documentation.

## Integration

Permute communicates via OSC for external control. See [docs/api.md](docs/api.md) for the complete protocol reference.

## Debug Mode

Enable comprehensive logging:

1. Open `permute-device.js`
2. Find line ~106: `var DEBUG_MODE = false;`
3. Change to: `var DEBUG_MODE = true;`
4. Save and reload the device

## Version History

- **v3.1**: Note ID-based temperature tracking for reversible transformations
- **v3.0**: Delta-based state tracking refactor (30% code reduction)
- **v2.2**: Performance optimization with deferred batching
- **v2.1**: Temperature transformation with loop-synchronized variation
- **v2.0**: Architectural transformation with generic Sequencer class
- **v1.0**: Initial dual sequencer implementation

## License

MIT
