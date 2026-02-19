/**
 * permute-constants.js - Constants, configuration, and value types
 *
 * Shared constants used across all Permute modules.
 *
 * @requires Max4Live JavaScript API
 */

// ===== Configuration =====
// Transpose configuration for pitch sequencer
var TRANSPOSE_CONFIG = {
    parameterNames: [
        { name: "custom e", shiftAmount: 21 },
        { name: "pitch", shiftAmount: 16 },
        { name: "transpose", shiftAmount: 16 },
        { name: "octave", shiftAmount: 16 }
    ],
    defaultShiftAmount: 12
};

// ===== CONSTANTS =====
var TICKS_PER_QUARTER_NOTE = 480;
var MIDI_MIN = 0;
var MIDI_MAX = 127;
var OCTAVE_SEMITONES = 12;
var DEFAULT_TIME_SIGNATURE = 4;
var MAX_PATTERN_LENGTH = 64;
var MIN_PATTERN_LENGTH = 1;
var DEFAULT_GAIN_VALUE = 1.0;
var MUTED_GAIN = 0.0;
var DEFAULT_DRUM_RACK_TRANSPOSE = 64;
var INVALID_LIVE_API_ID = "0";
var TASK_SCHEDULE_DELAY = 1;

// ===== VALUE TYPES =====

/**
 * Value type definitions for different sequencer types.
 * Each type defines validation, default value, and range.
 */
var VALUE_TYPES = {
    binary: {
        validate: function(v) { return v === 0 || v === 1; },
        default: 0,
        range: [0, 1],
        description: "On/Off (0 or 1)"
    },
    midi_range: {
        validate: function(v) { return v >= MIDI_MIN && v <= MIDI_MAX; },
        default: 64,
        range: [MIDI_MIN, MIDI_MAX],
        description: "MIDI value (0-127)"
    },
    normalized: {
        validate: function(v) { return v >= 0.0 && v <= 1.0; },
        default: 0.5,
        range: [0.0, 1.0],
        description: "Normalized (0.0-1.0)"
    },
    semitones: {
        validate: function(v) { return v >= -48 && v <= 48; },
        default: 0,
        range: [-48, 48],
        description: "Semitones (-48 to +48)"
    }
};

module.exports = {
    TRANSPOSE_CONFIG: TRANSPOSE_CONFIG,
    TICKS_PER_QUARTER_NOTE: TICKS_PER_QUARTER_NOTE,
    MIDI_MIN: MIDI_MIN,
    MIDI_MAX: MIDI_MAX,
    OCTAVE_SEMITONES: OCTAVE_SEMITONES,
    DEFAULT_TIME_SIGNATURE: DEFAULT_TIME_SIGNATURE,
    MAX_PATTERN_LENGTH: MAX_PATTERN_LENGTH,
    MIN_PATTERN_LENGTH: MIN_PATTERN_LENGTH,
    DEFAULT_GAIN_VALUE: DEFAULT_GAIN_VALUE,
    MUTED_GAIN: MUTED_GAIN,
    DEFAULT_DRUM_RACK_TRANSPOSE: DEFAULT_DRUM_RACK_TRANSPOSE,
    INVALID_LIVE_API_ID: INVALID_LIVE_API_ID,
    TASK_SCHEDULE_DELAY: TASK_SCHEDULE_DELAY,
    VALUE_TYPES: VALUE_TYPES
};
