/**
 * permute-constants.js - Constants, configuration, and value types
 *
 * No dependencies.
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
    defaultShiftAmount: 12,
    // Devices that use parameter-based transposition (if a named param is found).
    // All other instruments use note_transpose by default.
    // Fallback to note_transpose if no named param is found even for listed devices.
    parameterTransposeDevices: [
        "DrumGroupDevice",
        "InstrumentGroupDevice"
    ]
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

// ===== RATE ENUM =====
// live.menu indices map to per-step tick durations. Entries with barsPerStep
// scale with the current time-signature numerator so bar-length steps stay
// musically correct in 3/4, 5/4, etc.
var ENUM_RATES = [
    { label: "8 bar", barsPerStep: 8 },
    { label: "4 bar", barsPerStep: 4 },
    { label: "2 bar", barsPerStep: 2 },
    { label: "1 bar", barsPerStep: 1 },
    { label: "1/2",   ticks: 960 },
    { label: "1/4",   ticks: 480 },
    { label: "1/8",   ticks: 240 },
    { label: "1/16",  ticks: 120 }
];

var DEFAULT_RATE_ENUM = 5; // 1/4 note

function ticksForRateEnum(index, timeSigNumerator) {
    var entry = ENUM_RATES[index];
    if (!entry) { entry = ENUM_RATES[DEFAULT_RATE_ENUM]; }
    if (entry.ticks) { return entry.ticks; }
    var numer = timeSigNumerator || DEFAULT_TIME_SIGNATURE;
    return entry.barsPerStep * numer * TICKS_PER_QUARTER_NOTE;
}

// ===== VALUE TYPES =====

/**
 * Value type definitions for sequencer patterns.
 * Each type defines validation, default value, and range.
 */
var VALUE_TYPES = {
    binary: {
        validate: function(v) { return v === 0 || v === 1; },
        default: 0,
        range: [0, 1]
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
    VALUE_TYPES: VALUE_TYPES,
    ENUM_RATES: ENUM_RATES,
    DEFAULT_RATE_ENUM: DEFAULT_RATE_ENUM,
    ticksForRateEnum: ticksForRateEnum
};
