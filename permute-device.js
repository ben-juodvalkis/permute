/**
 * permute-device.js - Dual mute/pitch sequencer for Max4Live
 *
 * A comprehensive step sequencer that provides synchronized mute and pitch
 * sequencing for both MIDI and audio clips in Ableton Live.
 *
 * Features:
 * - Dual independent sequencers (mute and pitch)
 * - 8-64 step patterns
 * - Intelligent instrument detection (DrumRack vs other instruments)
 * - Three-tier pitch handling: DrumRack device transpose, MIDI note modification, audio clip parameters
 * - Works with MIDI and audio clips
 * - Bar.beat.tick timing format
 * - Auto-reset on transport stop
 * - Real-time pattern editing
 * - Reversible temperature transformation (v3.1)
 *
 * v3.0 Architecture:
 * - Direct clip modification (no layer system)
 * - Transport-scoped pristine state (captured on start, restored on stop)
 * - Simple batching queue (accumulates changes, applies in 1ms)
 * - Natural transformation composition (each reads current clip state)
 * - Temperature as separate path (triggered by loop_jump observer)
 * - Instrument strategy pattern for pitch transposition
 * - Value type system for validation
 * - ObserverRegistry (centralized observer management)
 * - CommandRegistry (cleaner message dispatch)
 *
 * v3.1 Temperature Enhancements (Issue #177):
 * - Note ID-based tracking for reversible temperature transformations
 * - Value-based enable/disable: temp > 0 captures, temp = 0 restores
 * - Handles overdubbing gracefully (new notes preserved on restore)
 * - Handles note deletion gracefully (missing IDs skipped)
 * - Proper interaction with pitch sequencer state
 *
 * @version 3.1
 * @author [Built interactively via Claude]
 * @requires Max4Live JavaScript API
 */

autowatch = 1;
inlets = 1;
outlets = 1; // UI feedback only

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

// ===== UTILITIES =====

var DEBUG_MODE = false; // Set to true for development

/**
 * Debug logging utility.
 * Only logs when DEBUG_MODE is enabled.
 *
 * @param {string} context - Context/location of the log
 * @param {string} message - Message to log
 * @param {*} data - Optional data to include
 */
function debug(context, message, data) {
    if (DEBUG_MODE) {
        var output = "[Sequencer DEBUG:" + context + "] " + message;
        if (data !== undefined) {
            output += " | Data: " + JSON.stringify(data);
        }
        post(output + "\n");
    }
}

/**
 * Handle errors consistently throughout the device.
 * Logs errors to the Max console based on DEBUG_MODE and criticality.
 *
 * @param {string} context - Where the error occurred (e.g., "parseNotesResponse", "init")
 * @param {Error|string} error - The error that occurred
 * @param {boolean} isCritical - If true, always log; if false, only log in DEBUG_MODE
 */
function handleError(context, error, isCritical) {
    if (DEBUG_MODE || isCritical) {
        var errorMsg = error.toString ? error.toString() : String(error);
        post("[Sequencer ERROR:" + context + "] " + errorMsg + "\n");
    }
}

function post_error(msg) {
    error("[Sequencer ERROR] " + msg + "\n");
}

/**
 * Parse notes response from Live API call.
 * Handles both string JSON format and array format.
 *
 * @param {*} notesJson - Response from get_all_notes_extended
 * @returns {Object|null} - Parsed notes object with {notes: [...]} or null
 */
function parseNotesResponse(notesJson) {
    if (!notesJson) return null;

    if (typeof notesJson === "string") {
        try {
            var parsed = JSON.parse(notesJson);
            if (parsed && parsed.notes && Array.isArray(parsed.notes)) {
                return parsed;
            } else if (Array.isArray(parsed)) {
                return { notes: parsed };
            }
        } catch (error) {
            handleError("parseNotesResponse", error, false);
        }
    } else if (Array.isArray(notesJson)) {
        return { notes: notesJson };
    }

    return null;
}

/**
 * Check if state change requires action.
 * Used by pitch sequencer to avoid unnecessary API calls.
 *
 * @param {boolean} shouldApply - Desired state
 * @param {boolean} currentState - Current state
 * @returns {boolean} - True if change is needed
 */
function needsStateChange(shouldApply, currentState) {
    return shouldApply !== currentState;
}

/**
 * Get cached parameter API reference for a device.
 * Creates a new LiveAPI object for the specified parameter.
 *
 * @param {LiveAPI} device - Device LiveAPI object
 * @param {number} paramIndex - Parameter index
 * @returns {LiveAPI} - Parameter LiveAPI object
 */
function getDeviceParameter(device, paramIndex) {
    var paramPath = device.path + " parameters " + paramIndex;
    return new LiveAPI(paramPath);
}

/**
 * Find transpose parameter by scanning device parameters for known names.
 * Returns the first match based on priority order from config.
 * V4.0: Name-based parameter detection (case-insensitive, exact match).
 *
 * Performance: Scans up to 17 parameters (typical rack macro count).
 * Called once per device load, not per-step.
 *
 * @param {LiveAPI} device - Device to scan
 * @returns {Object|null} - { index, param, shiftAmount, name } or null if not found
 */
function findTransposeParameterByName(device) {
    if (!device || device.id === INVALID_LIVE_API_ID) return null;

    try {
        var nameConfig = TRANSPOSE_CONFIG.parameterNames;
        if (!nameConfig || nameConfig.length === 0) return null;

        // Build lookup map (lowercase name -> config)
        var nameLookup = {};
        var priorityOrder = [];
        for (var i = 0; i < nameConfig.length; i++) {
            var entry = nameConfig[i];
            var lowerName = entry.name.toLowerCase();
            nameLookup[lowerName] = entry;
            priorityOrder.push(lowerName);
        }

        // Get parameter count - limit to 17 (typical rack macro count from constants.json)
        var params = device.get("parameters");
        if (!params) return null;
        var paramCount = Math.min(Math.floor(params.length / 2), 17);  // Live returns [id, id, id...]
        if (paramCount === 0) return null;

        // Scan parameters, collecting matches
        var matches = {};  // lowerName -> { index, param }
        for (var i = 0; i < paramCount; i++) {
            var param = getDeviceParameter(device, i);

            // Validate LiveAPI object before use
            if (!param || param.id === INVALID_LIVE_API_ID) continue;

            var nameResult = param.get("name");
            if (nameResult && nameResult[0]) {
                var paramName = nameResult[0].toLowerCase();
                if (nameLookup[paramName]) {
                    matches[paramName] = { index: i, param: param };
                }
            }
        }

        // Return highest priority match
        for (var i = 0; i < priorityOrder.length; i++) {
            var name = priorityOrder[i];
            if (matches[name]) {
                var config = nameLookup[name];
                debug("transpose", "Found '" + name + "' at param " + matches[name].index);
                return {
                    index: matches[name].index,
                    param: matches[name].param,
                    shiftAmount: config.shiftAmount,
                    name: name
                };
            }
        }

        return null;  // No matching parameter found
    } catch (error) {
        handleError("findTransposeParameterByName", error, false);
        return null;
    }
}

/**
 * Check if a device should use parameter-based transposition.
 * Only devices explicitly listed in TRANSPOSE_CONFIG.parameterTransposeDevices
 * are candidates for parameter transpose; all others default to note_transpose.
 *
 * @param {LiveAPI} device - Device to check
 * @returns {boolean}
 */
function isParameterTransposeDevice(device) {
    if (!device || device.id === INVALID_LIVE_API_ID) return false;
    try {
        var className = device.get("class_name");
        var list = TRANSPOSE_CONFIG.parameterTransposeDevices;
        for (var i = 0; i < list.length; i++) {
            if (list[i] === className) return true;
        }
        return false;
    } catch (error) {
        handleError("isParameterTransposeDevice", error, false);
        return false;
    }
}

/**
 * Create and configure a LiveAPI observer.
 * Centralizes the observer creation pattern used throughout the device.
 *
 * @param {string} path - LiveAPI path to observe
 * @param {string} property - Property to observe
 * @param {Function} callback - Callback function to execute on property change
 * @returns {LiveAPI} - Configured LiveAPI observer
 */
function createObserver(path, property, callback) {
    var observer = new LiveAPI(callback);
    observer.path = path;
    observer.property = property;
    return observer;
}

/**
 * Helper for deferred execution to break out of observer context.
 * Live API calls from within observers must be deferred to avoid
 * "Changes cannot be triggered by notifications" errors.
 *
 * @param {Function} callback - Function to execute on next tick
 */
function defer(callback) {
    // Use Task to break observer context if available
    if (typeof Task !== 'undefined') {
        var t = new Task(callback, this);
        t.schedule(TASK_SCHEDULE_DELAY); // Schedule for next tick
    } else {
        // Fallback to setTimeout-like behavior
        callback.apply(this);
    }
}

/**
 * Calculate ticks per step based on division and time signature.
 * @param {Array|string} division - Division format
 * @param {number} timeSignature - Time signature numerator
 * @returns {number} - Ticks per step
 */
function calculateTicksPerStep(division, timeSignature) {
    if (typeof division === "string") {
        // Legacy string format
        switch(division) {
            case "1/1":  return TICKS_PER_QUARTER_NOTE * 4;
            case "1/2":  return TICKS_PER_QUARTER_NOTE * 2;
            case "1/4":  return TICKS_PER_QUARTER_NOTE;
            case "1/8":  return TICKS_PER_QUARTER_NOTE / 2;
            case "1/16": return TICKS_PER_QUARTER_NOTE / 4;
            case "1/32": return TICKS_PER_QUARTER_NOTE / 8;
            case "1/64": return TICKS_PER_QUARTER_NOTE / 16;
            default: return TICKS_PER_QUARTER_NOTE / 4;
        }
    } else if (Array.isArray(division) && division.length === 3) {
        // Bar.beat.tick format
        var bars = division[0];
        var beats = division[1];
        var ticks = division[2];
        var beatsPerBar = timeSignature || DEFAULT_TIME_SIGNATURE;
        return (bars * beatsPerBar * TICKS_PER_QUARTER_NOTE) +
               (beats * TICKS_PER_QUARTER_NOTE) +
               ticks;
    }

    return TICKS_PER_QUARTER_NOTE / 4; // Default to 16th notes
}

// ===== V3.0 HELPER FUNCTIONS =====

/**
 * Fisher-Yates shuffle algorithm.
 * Used by temperature transformation for random pitch swapping.
 *
 * @param {Array} array - Array to shuffle
 * @returns {Array} - Shuffled copy
 */
function fisherYatesShuffle(array) {
    var shuffled = array.slice();
    for (var i = shuffled.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = temp;
    }
    return shuffled;
}

/**
 * Generate swap pattern for temperature transformation.
 * Creates shuffle groups based on temperature value (0.0-1.0).
 *
 * Temperature ranges:
 *   0.0-0.33: Pairs only (2 notes)
 *   0.34-0.66: Mix of pairs and triplets (2-3 notes)
 *   0.67-1.0: Larger groups (2-5 notes)
 *
 * @param {Array} notes - Array of note objects with start_time and pitch
 * @param {number} temperature - Temperature value (0.0-1.0)
 * @returns {Array} - Array of shuffle groups {indices: [...], shuffled: [...]}
 */
function generateSwapPattern(notes, temperature) {
    if (!notes || notes.length < 2) {
        return [];
    }

    // Create array of indices and sort by start_time (temporal adjacency)
    var sortedIndices = [];
    for (var i = 0; i < notes.length; i++) {
        sortedIndices.push({
            originalIndex: i,
            startTime: notes[i].start_time,
            pitch: notes[i].pitch
        });
    }

    sortedIndices.sort(function(a, b) {
        return a.startTime - b.startTime;
    });

    // Create non-overlapping shuffle groups
    var groups = [];
    var used = [];
    for (var i = 0; i < sortedIndices.length; i++) {
        used.push(false);
    }

    // V3.1: Track if we've created at least one group
    var hasCreatedGroup = false;

    for (var i = 0; i < sortedIndices.length; i++) {
        if (used[i]) continue;

        // Should we form a group starting here?
        var roll = Math.random();

        // V3.1: Guarantee at least one swap when temp > 0
        // On last available pair, force creation if no groups yet
        var isLastChance = !hasCreatedGroup && (i >= sortedIndices.length - 2);
        var shouldFormGroup = (roll < temperature) || isLastChance;

        if (!shouldFormGroup) {
            continue;
        }

        // Determine group size based on temperature
        var desiredSize;
        if (temperature < 0.34) {
            desiredSize = 2;
        } else if (temperature < 0.67) {
            desiredSize = Math.random() < 0.6 ? 2 : 3;
        } else {
            var sizes = [2, 3, 4, 5];
            var weights = [0.2, 0.3, 0.3, 0.2];
            var roll2 = Math.random();
            var cumulative = 0;
            desiredSize = 3;
            for (var k = 0; k < sizes.length; k++) {
                cumulative += weights[k];
                if (roll2 < cumulative) {
                    desiredSize = sizes[k];
                    break;
                }
            }
        }

        // Collect adjacent unused notes
        var group = [];
        for (var j = i; j < Math.min(i + desiredSize, sortedIndices.length); j++) {
            if (!used[j]) {
                group.push(sortedIndices[j].originalIndex);
                used[j] = true;
            }
            if (group.length >= desiredSize) break;
        }

        // Need at least 2 notes to shuffle
        if (group.length >= 2) {
            var shuffledIndices = fisherYatesShuffle(group);
            groups.push({
                indices: group,
                shuffled: shuffledIndices
            });
            hasCreatedGroup = true;  // V3.1: Mark that we've created a group
        }
    }

    debug("temperature", "Generated " + groups.length + " shuffle groups (guaranteed min 1 when temp > 0)");
    return groups;
}

/**
 * Apply swap pattern to notes.
 * Swaps pitches according to the shuffle groups.
 *
 * @param {Array} notes - Array of note objects (will be modified in place)
 * @param {Array} swapPattern - Array of shuffle groups from generateSwapPattern
 */
function applySwapPattern(notes, swapPattern) {
    if (!notes || !swapPattern || swapPattern.length === 0) return;

    // Capture current pitches
    var currentPitches = [];
    for (var i = 0; i < notes.length; i++) {
        currentPitches.push(notes[i].pitch);
    }

    // Apply swaps
    for (var i = 0; i < swapPattern.length; i++) {
        var group = swapPattern[i];
        for (var j = 0; j < group.indices.length; j++) {
            var targetIdx = group.indices[j];
            var sourceIdx = group.shuffled[j];

            // Validate indices before accessing
            if (targetIdx < notes.length && sourceIdx < currentPitches.length) {
                notes[targetIdx].pitch = currentPitches[sourceIdx];
            } else {
                debug("applySwapPattern", "Invalid index: targetIdx=" + targetIdx +
                      ", sourceIdx=" + sourceIdx + ", noteCount=" + notes.length);
            }
        }
    }
}

// ===== OBSERVER REGISTRY =====

/**
 * ObserverRegistry - Centralized observer management.
 * Tracks all active observers and guarantees cleanup on error/destruction.
 */
function ObserverRegistry() {
    this.observers = {}; // name -> observer
}

/**
 * Register an observer.
 * @param {string} name - Unique name for this observer
 * @param {LiveAPI} observer - Observer object
 */
ObserverRegistry.prototype.register = function(name, observer) {
    if (this.observers[name]) {
        this.unregister(name);
    }
    this.observers[name] = observer;
};

/**
 * Unregister an observer by name.
 * @param {string} name - Observer name
 */
ObserverRegistry.prototype.unregister = function(name) {
    if (this.observers[name]) {
        this.observers[name].property = "";
        delete this.observers[name];
    }
};

/**
 * Clear all observers.
 */
ObserverRegistry.prototype.clearAll = function() {
    for (var name in this.observers) {
        if (this.observers.hasOwnProperty(name)) {
            this.observers[name].property = "";
        }
    }
    this.observers = {};
};

/**
 * Get observer by name.
 * @param {string} name - Observer name
 * @returns {LiveAPI|null} - Observer or null
 */
ObserverRegistry.prototype.get = function(name) {
    return this.observers[name] || null;
};

// ===== STATE MANAGEMENT OBJECTS =====

/**
 * TrackState - Encapsulates track-related state.
 */
function TrackState() {
    this.ref = null;       // LiveAPI track reference
    this.id = null;        // Track ID
    this.type = 'unknown'; // 'midi', 'audio', or 'unknown'
    this.index = -1;       // Track index in session (for multi-track sequencer display)
}

TrackState.prototype.update = function(track) {
    this.ref = track;
    this.id = track ? track.id : null;
    if (track) {
        var hasMidiInput = track.get("has_midi_input");
        var hasAudioInput = track.get("has_audio_input");
        if (hasMidiInput && hasMidiInput[0] === 1) {
            this.type = 'midi';
        } else if (hasAudioInput && hasAudioInput[0] === 1) {
            this.type = 'audio';
        } else {
            this.type = 'unknown';
        }
    } else {
        this.type = 'unknown';
    }
};

TrackState.prototype.reset = function() {
    this.ref = null;
    this.id = null;
    this.type = 'unknown';
    this.index = -1;
};

/**
 * Extract track index from LiveAPI path.
 * Path format: "live_set tracks N" or similar
 * @param {string} path - LiveAPI path string
 * @returns {number} - Track index or -1 if not found
 */
TrackState.prototype.extractIndexFromPath = function(path) {
    if (!path) return -1;
    // Match "tracks N" in path like "live_set tracks 3"
    var match = path.match(/tracks\s+(\d+)/);
    if (match && match[1]) {
        return parseInt(match[1], 10);
    }
    return -1;
};

/**
 * ClipState - Encapsulates clip-related state.
 */
function ClipState() {
    this.currentId = null;
}

ClipState.prototype.update = function(clipId) {
    this.currentId = clipId;
};

ClipState.prototype.hasChanged = function(clipId) {
    return this.currentId !== clipId;
};

ClipState.prototype.reset = function() {
    this.currentId = null;
};

/**
 * TransportState - Encapsulates transport-related state.
 */
function TransportState() {
    this.isPlaying = false;
}

TransportState.prototype.setPlaying = function(playing) {
    this.isPlaying = playing;
};

TransportState.prototype.reset = function() {
    this.isPlaying = false;
};

// ===== INSTRUMENT DETECTOR HELPER =====

/**
 * InstrumentDetector - Shared helper for finding instrument devices.
 * V4.0: Simplified to just find the device, not classify it.
 */
function InstrumentDetector() {}

/**
 * Find the first instrument device on a track.
 * V4.0: No longer classifies device type - just finds it.
 *
 * @param {LiveAPI} track - Track to analyze
 * @returns {Object|null} - { device, deviceId } or null
 */
InstrumentDetector.findInstrumentDevice = function(track) {
    if (!track) return null;

    try {
        var devices = track.get("devices");
        if (!devices || devices.length === 0) return null;

        for (var i = 0; i < devices.length; i++) {
            var devicePath = track.path + " devices " + i;
            var device = new LiveAPI(devicePath);

            if (!device || device.id === INVALID_LIVE_API_ID) continue;

            var deviceType = device.get("type");
            var isInstrument = (deviceType && (deviceType[0] === "instrument" || deviceType[0] === 1));

            if (isInstrument) {
                return {
                    device: device,
                    deviceId: device.id
                };
            }
        }
    } catch (error) {
        handleError("InstrumentDetector.findInstrumentDevice", error, false);
    }

    return null;
};

// ===== INSTRUMENT STRATEGY PATTERN =====

/**
 * InstrumentStrategy - Base class for instrument-specific pitch handling.
 */
function InstrumentStrategy(device) {
    this.device = device;
    this.originalTranspose = null;
}

InstrumentStrategy.prototype.applyTranspose = function(value) {
    // Override in subclasses
};

InstrumentStrategy.prototype.revertTranspose = function() {
    // Override in subclasses
};

/**
 * TransposeStrategy - Unified parameter-based pitch transposition.
 * V4.0: Single strategy for all devices with named transpose parameters.
 * Works for drum racks, instrument racks, and any device with a transpose macro.
 *
 * @param {LiveAPI} device - Device containing the transpose parameter
 * @param {LiveAPI} transposeParam - The transpose parameter API object
 * @param {number} shiftAmount - Amount to shift for octave (16 or 21)
 * @param {string} paramName - Name of the parameter (for debugging)
 */
function TransposeStrategy(device, transposeParam, shiftAmount, paramName) {
    InstrumentStrategy.call(this, device);
    this.transposeParam = transposeParam;
    this.shiftAmount = shiftAmount;
    this.paramName = paramName;
}
TransposeStrategy.prototype = Object.create(InstrumentStrategy.prototype);
TransposeStrategy.prototype.constructor = TransposeStrategy;

TransposeStrategy.prototype.applyTranspose = function(shouldShiftUp) {
    debug("transpose", "applyTranspose(" + shouldShiftUp + ") called, originalTranspose=" + this.originalTranspose);

    if (!this.device || !this.transposeParam) {
        debug("transpose", "applyTranspose BAIL: missing device or param");
        return;
    }

    try {
        // Check if transposeParam is still valid
        if (this.transposeParam.id === INVALID_LIVE_API_ID) {
            debug("transpose", "applyTranspose BAIL: param id invalid");
            return;
        }

        var currentTranspose = this.transposeParam.get("value");
        var currentValue = currentTranspose ? currentTranspose[0] : DEFAULT_DRUM_RACK_TRANSPOSE;
        debug("transpose", "currentValue from param: " + currentValue);

        if (this.originalTranspose === null) {
            this.originalTranspose = currentValue;
            debug("transpose", "captured originalTranspose=" + currentValue);
        }

        var newValue;
        if (shouldShiftUp) {
            newValue = this.originalTranspose + this.shiftAmount;
        } else {
            newValue = this.originalTranspose;
        }

        newValue = Math.max(MIDI_MIN, Math.min(MIDI_MAX, newValue));
        debug("transpose", "setting param to " + newValue + " (original=" + this.originalTranspose + ", shift=" + this.shiftAmount + ")");
        this.transposeParam.set("value", newValue);

        debug("transpose", "Applied " + (shouldShiftUp ? "+" : "") +
              this.shiftAmount + " via '" + this.paramName + "' param");
    } catch (error) {
        handleError("TransposeStrategy.applyTranspose", error, false);
    }
};

TransposeStrategy.prototype.revertTranspose = function() {
    debug("transpose", "revertTranspose called, originalTranspose=" + this.originalTranspose);
    this.applyTranspose(false);
    debug("transpose", "revertTranspose complete");
    // Do not reset originalTranspose here - it must persist across transport
    // cycles to prevent octave jumping on stop/restart (issue #9).
    // It is naturally reset when a new strategy instance is created via
    // detectInstrumentType().
};

/**
 * DefaultInstrumentStrategy - Default (no device-based transpose).
 */
function DefaultInstrumentStrategy() {
    InstrumentStrategy.call(this, null);
}
DefaultInstrumentStrategy.prototype = Object.create(InstrumentStrategy.prototype);
DefaultInstrumentStrategy.prototype.constructor = DefaultInstrumentStrategy;

DefaultInstrumentStrategy.prototype.applyTranspose = function(value) {
    // No-op for default instruments
};

DefaultInstrumentStrategy.prototype.revertTranspose = function() {
    // No-op for default instruments
};

// ===== GENERIC SEQUENCER CLASS =====

/**
 * Generic sequencer that manages pattern, timing, and step progression.
 * Wraps a Transformation and adds step-based control.
 *
 * @param {string} name - Sequencer name (e.g., 'mute', 'pitch', 'velocity')
 * @param {Transformation} transformation - The transformation this sequencer controls
 * @param {string} valueType - Value type key from VALUE_TYPES
 * @param {number} patternLength - Initial pattern length (default 8)
 */
function Sequencer(name, transformation, valueType, patternLength) {
    this.name = name;
    this.transformation = transformation; // Reference to transformation
    this.valueType = VALUE_TYPES[valueType] || VALUE_TYPES.binary;
    this.patternLength = patternLength || 8;

    // Initialize pattern with default values
    this.pattern = [];
    for (var i = 0; i < this.patternLength; i++) {
        this.pattern.push(this.valueType.default);
    }

    // State
    this.currentStep = -1;
    this.lastState = null;

    // Default value for this sequencer (used by isActive)
    // Mute defaults to 1 (unmuted), pitch defaults to 0 (no shift)
    this.defaultValue = this.valueType.default;

    // Timing
    this.division = [1, 0, 0]; // Default 1 bar per step
    this.ticksPerStep = 1920;

    // Cache
    this.cacheValid = false;

    // Reference to device (set by SequencerDevice)
    this.device = null;
}

/**
 * Set pattern with validation.
 * V6.0: Triggers lazy observer activation if pattern becomes active.
 * @param {Array} pattern - New pattern values
 */
Sequencer.prototype.setPattern = function(pattern) {
    var validated = [];
    for (var i = 0; i < pattern.length; i++) {
        var value = pattern[i];
        if (this.valueType.validate(value)) {
            validated.push(value);
        } else {
            validated.push(this.valueType.default);
            debug("sequencer", "Invalid value " + value + " for " + this.name + ", using default");
        }
    }
    this.pattern = validated;
    this.patternLength = validated.length;

    // V6.0: Check if we need to activate playback observers
    if (this.device && this.device.checkAndActivateObservers) {
        this.device.checkAndActivateObservers();
    }
};

/**
 * Set individual step value.
 * V6.0: Triggers lazy observer activation if pattern becomes active.
 * @param {number} index - Step index
 * @param {*} value - Step value
 */
Sequencer.prototype.setStep = function(index, value) {
    if (index >= 0 && index < this.pattern.length) {
        if (this.valueType.validate(value)) {
            this.pattern[index] = value;

            // V6.0: Check if we need to activate playback observers
            if (this.device && this.device.checkAndActivateObservers) {
                this.device.checkAndActivateObservers();
            }
        } else {
            debug("sequencer", "Invalid value " + value + " for step " + index);
        }
    }
};

/**
 * Set pattern length, preserving existing values.
 * @param {number} length - New pattern length (1-64)
 */
Sequencer.prototype.setLength = function(length) {
    var newLength = Math.max(MIN_PATTERN_LENGTH, Math.min(MAX_PATTERN_LENGTH, length));

    // Preserve existing values, fill new slots with defaults
    while (this.pattern.length < newLength) {
        this.pattern.push(this.valueType.default);
    }

    // Truncate if needed
    if (this.pattern.length > newLength) {
        this.pattern = this.pattern.slice(0, newLength);
    }

    this.patternLength = newLength;

    // Reset step if out of bounds
    if (this.currentStep >= newLength) {
        this.currentStep = 0;
    }
};

/**
 * Set division timing.
 * @param {Array|string} division - Division in [bars, beats, ticks] or legacy string format
 * @param {number} timeSignature - Time signature numerator (for tick calculation)
 */
Sequencer.prototype.setDivision = function(division, timeSignature) {
    this.division = division;
    this.ticksPerStep = calculateTicksPerStep(division, timeSignature);
};

/**
 * Calculate current step based on tick position.
 * @param {number} ticks - Absolute tick position
 * @returns {number} - Current step number
 */
Sequencer.prototype.calculateStep = function(ticks) {
    return Math.floor(ticks / this.ticksPerStep) % this.patternLength;
};

/**
 * Get current pattern value.
 * @returns {*} - Value at current step
 */
Sequencer.prototype.getCurrentValue = function() {
    if (this.currentStep >= 0 && this.currentStep < this.pattern.length) {
        return this.pattern[this.currentStep];
    }
    return this.valueType.default;
};

/**
 * Reset sequencer to initial state.
 */
Sequencer.prototype.reset = function() {
    this.currentStep = -1;
    this.lastState = null;
};

/**
 * Check if sequencer is active (has non-default pattern values).
 * Replaces explicit 'enabled' flag with pattern-derived state.
 * - Mute: active if any step is 0 (muted)
 * - Pitch: active if any step is 1 (shifted)
 * @returns {boolean} - True if sequencer has active pattern
 */
Sequencer.prototype.isActive = function() {
    for (var i = 0; i < this.patternLength; i++) {
        if (this.pattern[i] !== this.defaultValue) {
            return true;
        }
    }
    return false;
};

/**
 * Invalidate cache.
 */
Sequencer.prototype.invalidateCache = function() {
    this.cacheValid = false;
};

// ===== COMMAND REGISTRY =====

/**
 * CommandRegistry - Maps message types to handler functions.
 * Replaces large switch statements with cleaner dispatch pattern.
 */
function CommandRegistry() {
    this.commands = {};
}

/**
 * Register a command handler.
 * @param {string} command - Command name
 * @param {Function} handler - Handler function
 */
CommandRegistry.prototype.register = function(command, handler) {
    this.commands[command] = handler;
};

/**
 * Execute a command.
 * @param {string} command - Command name
 * @param {Array} args - Command arguments
 * @param {Object} context - Context object (usually 'this')
 * @returns {boolean} - True if command was handled
 */
CommandRegistry.prototype.execute = function(command, args, context) {
    if (this.commands[command]) {
        this.commands[command].call(context, args);
        return true;
    }
    return false;
};

// ===== MAIN SEQUENCER DEVICE =====

function SequencerDevice() {
    // V3.0: Sequencers without transformation wrappers
    this.sequencers = {
        muteSequencer: new Sequencer('mute', null, 'binary', 8),
        pitchSequencer: new Sequencer('pitch', null, 'binary', 8)
    };

    // Initialize mute pattern to all unmuted (1 = play, 0 = mute)
    this.sequencers.muteSequencer.pattern = [1, 1, 1, 1, 1, 1, 1, 1];
    this.sequencers.muteSequencer.defaultValue = 1; // Override: mute default is unmuted (1)

    // Set device reference on sequencers
    for (var name in this.sequencers) {
        if (this.sequencers.hasOwnProperty(name)) {
            this.sequencers[name].device = this;
        }
    }

    // V3.0: Instrument detection for pitch transformation
    this.instrumentType = 'unknown';
    this.instrumentDevice = null;
    this.instrumentDeviceId = null;
    this.instrumentStrategy = new DefaultInstrumentStrategy();

    // V3.0: Temperature state (non-sequenced)
    this.temperatureValue = 0.0;
    this.temperatureSwapPattern = [];
    this.temperatureActive = false;
    this.temperatureLoopJumpObserver = null;

    // V3.1: Temperature note ID tracking for reversible transformations
    // Maps clipId -> { originalPitches: { noteId: pitch }, capturedWithPitchOn: boolean }
    this.temperatureState = {};

    // V3.0: Simple state tracking (no pristine needed)
    this.lastValues = {}; // clipId -> { pitch: 0/1, mute: 0/1 }

    // V3.0: Batching queue
    this.pendingApplies = {}; // clipId -> { mute, pitch, scheduled, task }

    // State management objects
    this.trackState = new TrackState();
    this.clipState = new ClipState();
    this.transportState = new TransportState();

    // Observer registry
    this.observerRegistry = new ObserverRegistry();

    // V6.0: Lazy observer activation flag
    // Transport and time signature observers only created when a sequencer becomes active
    this.playbackObserversActive = false;

    // Time signature tracking
    this.timeSignatureNumerator = 4; // Default to 4/4

    // Device identification
    this.deviceId = this.generateDeviceId();
    this.liveDeviceId = null;  // Cached Live API device ID for OSC command filtering

    // Command registry for message handling
    this.commandRegistry = new CommandRegistry();
    this.setupCommandHandlers();

    // Legacy compatibility - keep references for old code paths
    // FIXED: Renamed to avoid collision with mute() function
    this.muteSeq = this.sequencers.muteSequencer;
    this.pitchSeq = this.sequencers.pitchSequencer;
}

/**
 * Generate unique device ID for identification and state tracking.
 * @returns {string} - Unique device identifier
 */
SequencerDevice.prototype.generateDeviceId = function() {
    return "seq_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
};

/**
 * Setup command handlers for message dispatch.
 */
SequencerDevice.prototype.setupCommandHandlers = function() {
    var self = this;

    // Song time handler - single message drives both sequencers
    // Receives absolute tick position from Max transport every 16th note
    this.commandRegistry.register('song_time', function(args) {
        if (args.length >= 1) {
            var ticks = args[0];
            self.processWithSongTime(ticks);
        }
    });

    // Legacy sequencer commands (for backward compatibility during migration)
    this.commandRegistry.register('tick', function(args) {
        if (args.length > 1) {
            self.processSequencerTick(args.seqName, args[1]);
        }
    });

    this.commandRegistry.register('pattern', function(args) {
        var seq = args.seq;
        seq.pattern = args.slice(1);
        seq.patternLength = seq.pattern.length;
        self.sendSequencerFeedback(args.seqName);
    });

    this.commandRegistry.register('step', function(args) {
        if (args.length > 2) {
            var seq = args.seq;
            var index = args[1];
            var value = args[2];
            if (index >= 0 && index < seq.pattern.length) {
                seq.pattern[index] = value;
                self.sendSequencerFeedback(args.seqName);
            }
        }
    });

    // Note: 'enable' command removed - sequencers auto-activate based on pattern content

    this.commandRegistry.register('division', function(args) {
        var seq = args.seq;
        if (args.length === 4) {
            seq.division = [args[1], args[2], args[3]];
        } else if (args.length === 2) {
            seq.division = args[1];
        }
        seq.ticksPerStep = self.getTicksPerStep(seq.division);
    });

    this.commandRegistry.register('length', function(args) {
        var seq = args.seq;
        seq.patternLength = Math.max(MIN_PATTERN_LENGTH, Math.min(MAX_PATTERN_LENGTH, args[1]));
        if (seq.currentStep >= seq.patternLength) {
            seq.currentStep = 0;
        }
    });

    this.commandRegistry.register('reset', function(args) {
        var seq = args.seq;
        seq.currentStep = 0;
        self.sendSequencerFeedback(args.seqName);
    });

    this.commandRegistry.register('bypass', function(args) {
        if (args.seqName === 'mute') {
            args.seq.bypass = args[1] !== 0;
        }
    });

    // ===== OSC COMMAND HANDLERS (Phase 2) =====
    // These handlers receive commands from Svelte UI via OSC bridge
    // All commands include deviceId as first arg for filtering

    // Helper to check if command is for this device
    function isForThisDevice(deviceId) {
        return self.liveDeviceId !== null && parseInt(deviceId) === self.liveDeviceId;
    }

    // Mute sequencer commands
    this.commandRegistry.register('seq_mute_step', function(args) {
        // args: [deviceId, stepIndex, value]
        if (args.length < 3 || !isForThisDevice(args[0])) return;
        var stepIndex = parseInt(args[1]);
        var value = parseInt(args[2]);
        self.sequencers.muteSequencer.setStep(stepIndex, value);
        self.broadcastState('mute_step');
    });

    this.commandRegistry.register('seq_mute_length', function(args) {
        // args: [deviceId, length]
        if (args.length < 2 || !isForThisDevice(args[0])) return;
        var length = parseInt(args[1]);
        self.sequencers.muteSequencer.setLength(length);
        self.broadcastState('mute_length');
    });

    this.commandRegistry.register('seq_mute_rate', function(args) {
        // args: [deviceId, bars, beats, ticks]
        if (args.length < 4 || !isForThisDevice(args[0])) return;
        var bars = parseInt(args[1]);
        var beats = parseInt(args[2]);
        var ticks = parseInt(args[3]);
        self.sequencers.muteSequencer.setDivision([bars, beats, ticks], self.timeSignatureNumerator);
        self.broadcastState('mute_rate');
    });

    // Pitch sequencer commands
    this.commandRegistry.register('seq_pitch_step', function(args) {
        // args: [deviceId, stepIndex, value]
        if (args.length < 3 || !isForThisDevice(args[0])) return;
        var stepIndex = parseInt(args[1]);
        var value = parseInt(args[2]);
        self.sequencers.pitchSequencer.setStep(stepIndex, value);
        self.broadcastState('pitch_step');
    });

    this.commandRegistry.register('seq_pitch_length', function(args) {
        // args: [deviceId, length]
        if (args.length < 2 || !isForThisDevice(args[0])) return;
        var length = parseInt(args[1]);
        self.sequencers.pitchSequencer.setLength(length);
        self.broadcastState('pitch_length');
    });

    this.commandRegistry.register('seq_pitch_rate', function(args) {
        // args: [deviceId, bars, beats, ticks]
        if (args.length < 4 || !isForThisDevice(args[0])) return;
        var bars = parseInt(args[1]);
        var beats = parseInt(args[2]);
        var ticks = parseInt(args[3]);
        self.sequencers.pitchSequencer.setDivision([bars, beats, ticks], self.timeSignatureNumerator);
        self.broadcastState('pitch_rate');
    });

    // Temperature command
    this.commandRegistry.register('seq_temperature', function(args) {
        // args: [deviceId, value]
        if (args.length < 2 || !isForThisDevice(args[0])) return;
        var value = parseFloat(args[1]);
        // Reuse existing temperature logic
        self.setTemperatureValue(value);
        self.broadcastState('temperature');
    });

    // Complete state command (for ghost editing sync)
    this.commandRegistry.register('set_state', function(args) {
        // args: [deviceId, mutePattern[8], muteLength, muteBars, muteBeats, muteTicks,
        //        pitchPattern[8], pitchLength, pitchBars, pitchBeats, pitchTicks, temperature]
        // Total: 26 args (1 + 8 + 1 + 3 + 8 + 1 + 3 + 1)
        post('[set_state] Received ' + args.length + ' args, deviceId=' + args[0] + '\n');
        if (args.length < 24) {
            post('[set_state] REJECTED: not enough args\n');
            return;
        }
        if (!isForThisDevice(args[0])) {
            post('[set_state] REJECTED: not for this device (my id=' + new LiveAPI('this_device').id + ')\n');
            return;
        }
        post('[set_state] ACCEPTED for this device\n');

        var idx = 1;  // Skip deviceId

        // Mute pattern (8 steps)
        var mutePattern = [];
        for (var i = 0; i < 8; i++) {
            mutePattern.push(parseInt(args[idx++]));
        }
        post('[set_state] Mute pattern to set: ' + mutePattern.join(',') + '\n');
        self.sequencers.muteSequencer.setPattern(mutePattern);

        // Mute length and rate
        self.sequencers.muteSequencer.setLength(parseInt(args[idx++]));
        var muteBars = parseInt(args[idx++]);
        var muteBeats = parseInt(args[idx++]);
        var muteTicks = parseInt(args[idx++]);
        self.sequencers.muteSequencer.setDivision([muteBars, muteBeats, muteTicks], self.timeSignatureNumerator);

        // Pitch pattern (8 steps)
        var pitchPattern = [];
        for (var i = 0; i < 8; i++) {
            pitchPattern.push(parseInt(args[idx++]));
        }
        self.sequencers.pitchSequencer.setPattern(pitchPattern);

        // Pitch length and rate
        self.sequencers.pitchSequencer.setLength(parseInt(args[idx++]));
        var pitchBars = parseInt(args[idx++]);
        var pitchBeats = parseInt(args[idx++]);
        var pitchTicks = parseInt(args[idx++]);
        self.sequencers.pitchSequencer.setDivision([pitchBars, pitchBeats, pitchTicks], self.timeSignatureNumerator);

        // Temperature
        var temp = parseFloat(args[idx++]);
        self.setTemperatureValue(temp);

        self.broadcastState('set_state_ack');
    });
};

// ===== INITIALIZATION =====

/**
 * Initialize the sequencer device.
 * Establishes track reference, detects track/instrument types, and sets up observers.
 */
SequencerDevice.prototype.init = function() {
    debug("init", "Starting sequencer initialization");
    try {
        // Cache Live API device ID for OSC command filtering
        var thisDevice = new LiveAPI("this_device");
        if (thisDevice && thisDevice.id !== INVALID_LIVE_API_ID) {
            this.liveDeviceId = parseInt(thisDevice.id);
            debug("init", "Cached Live device ID: " + this.liveDeviceId);
        }

        // Try multiple ways to get track reference
        var track = new LiveAPI("this_device canonical_parent");

        if (!track || track.id === INVALID_LIVE_API_ID) {
            if (thisDevice && thisDevice.id !== INVALID_LIVE_API_ID) {
                var devicePath = thisDevice.path;
                var trackPath = devicePath.substring(0, devicePath.lastIndexOf(" devices"));
                track = new LiveAPI(trackPath);
            }
        }

        if (track && track.id !== INVALID_LIVE_API_ID) {
            this.trackState.update(track);

            // Extract and store track index for multi-track sequencer display
            this.trackState.index = this.trackState.extractIndexFromPath(track.path);
            debug("init", "Track index: " + this.trackState.index);

            // V3.0: Detect instrument type for pitch transformation
            this.detectInstrumentType();

            // Setup device observer only (for instrument detection)
            // Transport/time signature observers are lazy-created when sequencer becomes active
            this.setupDeviceObserver();
            // Note: Transport and time signature observers NOT created here
            // They are created lazily by ensurePlaybackObservers() when a sequencer is activated

            debug("init", "Initialization complete (dormant mode - no playback observers)", {
                trackType: this.trackState.type,
                instrumentType: this.instrumentType
            });

            // Send initial feedback for all sequencers (UI feedback only, no broadcast)
            for (var seqName in this.sequencers) {
                if (this.sequencers.hasOwnProperty(seqName)) {
                    var cleanName = seqName.replace('Sequencer', '');
                    this.sendSequencerFeedbackLocal(cleanName);
                }
            }

            // Send initial state broadcast with 'init' origin
            this.broadcastState('init');
        } else {
            handleError("init", "Could not find track reference", true);
        }
    } catch (error) {
        handleError("init", error, true);
    }
};

// ===== OBSERVER SETUP =====

/**
 * Setup device observer to detect instrument changes.
 */
SequencerDevice.prototype.setupDeviceObserver = function() {
    if (!this.trackState.ref) return;

    var self = this;

    var observer = createObserver(
        this.trackState.ref.path,
        "devices",
        function(args) {
            defer(function() {
                // V3.0: Re-detect instrument type on device changes
                self.detectInstrumentType();
            });
        }
    );

    this.observerRegistry.register('device', observer);
};

/**
 * Setup transport observer to detect play/stop.
 */
SequencerDevice.prototype.setupTransportObserver = function() {
    var self = this;

    var observer = createObserver(
        "live_set",
        "is_playing",
        function(args) {
            var playing = args[1];
            if (playing === 1 && !self.transportState.isPlaying) {
                defer(function() {
                    self.onTransportStart();
                });
            } else if (playing === 0 && self.transportState.isPlaying) {
                defer(function() {
                    self.onTransportStop();
                });
            }
        }
    );

    this.observerRegistry.register('transport', observer);
};

/**
 * Setup time signature observer.
 */
SequencerDevice.prototype.setupTimeSignatureObserver = function() {
    var self = this;

    var observer = createObserver(
        "live_set",
        "signature_numerator",
        function(args) {
            var numerator = args[1];
            if (numerator && numerator > 0) {
                self.timeSignatureNumerator = numerator;

                // Recalculate ticks per step for all sequencers
                for (var name in self.sequencers) {
                    if (self.sequencers.hasOwnProperty(name)) {
                        var seq = self.sequencers[name];
                        seq.ticksPerStep = self.getTicksPerStep(seq.division);
                    }
                }

                debug("timeSignature", "Updated to " + numerator + "/4");
            }
        }
    );

    this.observerRegistry.register('timeSignature', observer);
};

/**
 * V6.0: Ensure playback observers are active.
 * Lazily creates transport and time signature observers when first needed.
 * Called when a sequencer becomes active (pattern has non-default values).
 */
SequencerDevice.prototype.ensurePlaybackObservers = function() {
    if (this.playbackObserversActive) return;

    debug("lazy", "Activating playback observers (sequencer became active)");

    this.setupTransportObserver();
    this.setupTimeSignatureObserver();
    this.playbackObserversActive = true;

    debug("lazy", "Playback observers now active");
};

/**
 * V6.0: Check if any sequencer is active and ensure observers if so.
 * Called when pattern changes to potentially activate lazy observers.
 */
SequencerDevice.prototype.checkAndActivateObservers = function() {
    if (this.playbackObserversActive) return;

    // Check if either sequencer is now active
    var muteActive = this.sequencers.muteSequencer.isActive();
    var pitchActive = this.sequencers.pitchSequencer.isActive();

    if (muteActive || pitchActive) {
        this.ensurePlaybackObservers();
    }
};

/**
 * Setup observers for clip changes.
 * V3.0: Minimal observation - temperature loop_jump only.
 * Note: External note edits during playback are ignored by design.
 *
 * @param {LiveAPI} clip - Live API clip object to observe
 */
SequencerDevice.prototype.setupClipObservers = function(clip) {
    // Clear existing observers
    this.observerRegistry.unregister('notes');

    // Clear temperature loop_jump observer when clip changes
    this.clearTemperatureLoopJumpObserver();

    // V3.0: No note observation needed - transformations track their own state
};

// ===== TRANSPORT HANDLING =====

/**
 * Handle transport start.
 * V3.1: Detect instrument and capture temperature state if needed.
 *
 * Note: Temperature is reset to 0 on transport stop, so temperatureValue > 0
 * here means user set temperature before pressing play (preview workflow).
 */
SequencerDevice.prototype.onTransportStart = function() {
    debug("transport", "Transport started");
    this.transportState.setPlaying(true);

    // Detect instrument type for pitch transformation
    this.detectInstrumentType();

    // V3.1: If temperature was set before transport started, capture state now
    if (this.temperatureValue > 0) {
        var clip = this.getCurrentClip();
        if (clip) {
            var clipId = clip.id;
            // Only capture if we don't already have state for this clip
            if (!this.temperatureState[clipId]) {
                this.captureTemperatureState(clipId);
            }
        }
        this.setupTemperatureLoopJumpObserver();
    }
};

/**
 * Handle transport stop.
 * V3.1: Undo transformations with temperature state priority.
 *
 * If temperature state exists (temp was > 0):
 *   - Restore TRUE base pitches from temperature state (no pitch sequencer adjustment)
 *   - Skip pitch sequencer delta undo (temperature already handles it)
 *
 * If no temperature state:
 *   - Use existing delta-based pitch undo
 */
SequencerDevice.prototype.onTransportStop = function() {
    debug("transport", "Transport stopped");

    // V4.1: Always revert parameter_transpose on stop, even without a clip
    if (this.instrumentType === 'parameter_transpose') {
        this.instrumentStrategy.revertTranspose();
    }

    var clip = this.getCurrentClip();
    if (!clip) {
        this.transportState.setPlaying(false);
        // Still need to reset sequencers even without a clip
        for (var name in this.sequencers) {
            if (this.sequencers.hasOwnProperty(name)) {
                var seq = this.sequencers[name];
                seq.currentStep = -1;
                seq.lastAppliedValue = undefined;
                var cleanName = name.replace('Sequencer', '');
                this.sendSequencerFeedback(cleanName);
            }
        }
        return;
    }

    var clipId = clip.id;
    var trackType = this.trackState.type;

    // V3.1: Check if temperature state exists for this clip
    var hasTemperatureState = !!this.temperatureState[clipId];

    // Undo transformations based on last values
    if (this.lastValues[clipId] || hasTemperatureState) {
        try {
            if (trackType === 'midi') {
                var notesJson = clip.call("get_all_notes_extended");
                var notes = parseNotesResponse(notesJson);
                if (notes && notes.notes) {
                    var changed = false;

                    // V3.1: If temperature state exists, restore TRUE base pitches
                    if (hasTemperatureState) {
                        var tempState = this.temperatureState[clipId];
                        for (var i = 0; i < notes.notes.length; i++) {
                            var note = notes.notes[i];
                            var originalPitch = tempState.originalPitches[note.note_id];
                            if (originalPitch !== undefined) {
                                // Restore TRUE base pitch (no pitch sequencer adjustment)
                                note.pitch = originalPitch;
                                changed = true;
                            }
                            // Overdubbed notes keep current pitch
                        }
                        debug("onTransportStop", "Restored temperature state for " + notes.notes.length + " notes");

                        // Clear temperature state
                        delete this.temperatureState[clipId];
                        // V4.1: parameter_transpose revert handled at top of function
                    } else {
                        // No temperature state - use delta-based pitch undo for note_transpose
                        if (this.lastValues[clipId] && this.lastValues[clipId].pitch === 1) {
                            // V4.1: parameter_transpose revert handled at top of function
                            if (this.instrumentType !== 'parameter_transpose') {
                                // Shift notes down
                                for (var i = 0; i < notes.notes.length; i++) {
                                    notes.notes[i].pitch -= OCTAVE_SEMITONES;
                                }
                                changed = true;
                            }
                        }
                    }

                    // Undo mute if was on (always applies, independent of temperature)
                    if (this.lastValues[clipId] && this.lastValues[clipId].mute === 0) {
                        for (var i = 0; i < notes.notes.length; i++) {
                            notes.notes[i].mute = 0; // Unmute all
                        }
                        changed = true;
                    }

                    if (changed) {
                        clip.call("apply_note_modifications", notes);
                    }
                }
            } else if (trackType === 'audio') {
                // Audio clips don't support temperature (no note IDs)
                // Undo audio transformations normally
                if (this.lastValues[clipId]) {
                    if (this.lastValues[clipId].pitch === 1) {
                        clip.set("pitch_coarse", 0);
                    }
                    if (this.lastValues[clipId].mute === 0) {
                        clip.set("gain", DEFAULT_GAIN_VALUE);
                    }
                }
            }

            delete this.lastValues[clipId];
        } catch (error) {
            handleError("onTransportStop", error, false);
        }
    }

    // Reset all sequencers
    for (var name in this.sequencers) {
        if (this.sequencers.hasOwnProperty(name)) {
            var seq = this.sequencers[name];
            seq.currentStep = -1;
            seq.lastAppliedValue = undefined;  // V4.1: Reset for next transport start

            // Send updated feedback
            var cleanName = name.replace('Sequencer', '');
            this.sendSequencerFeedback(cleanName);
        }
    }

    // Clear temperature observer (will be re-setup on next transport start if temp > 0)
    this.clearTemperatureLoopJumpObserver();

    // V3.1: Clear temperatureActive flag but KEEP temperatureValue
    // This allows the user to keep their temperature setting across transport cycles
    // The state will be re-captured fresh on next transport start
    this.temperatureActive = false;

    // Cancel any pending batch applies
    for (var pendingClipId in this.pendingApplies) {
        if (this.pendingApplies.hasOwnProperty(pendingClipId)) {
            var pending = this.pendingApplies[pendingClipId];
            if (pending.task) {
                pending.task.cancel();
            }
        }
    }
    this.pendingApplies = {};

    this.transportState.setPlaying(false);
};

// ===== V3.0 BATCHING SYSTEM =====

/**
 * Schedule batch apply for a clip.
 * Accumulates multiple transformation changes and applies them in a single batch.
 *
 * @param {string} clipId - Clip ID
 * @param {string} transformName - Transformation name ('mute', 'pitch')
 * @param {*} value - Transformation value
 */
SequencerDevice.prototype.scheduleBatchApply = function(clipId, transformName, value) {
    // Initialize pending entry if doesn't exist
    if (!this.pendingApplies[clipId]) {
        this.pendingApplies[clipId] = { scheduled: false };
    }

    // Store pending value (last value wins)
    this.pendingApplies[clipId][transformName] = value;

    // Skip if already scheduled
    if (this.pendingApplies[clipId].scheduled) {
        debug("scheduleBatch", transformName + " added to existing batch for clip " + clipId);
        return;
    }

    // Mark as scheduled
    this.pendingApplies[clipId].scheduled = true;

    var self = this;

    // Create batch task
    var task = new Task(function() {
        self.executeBatchApply(clipId);
    });

    this.pendingApplies[clipId].task = task;
    task.schedule(1); // 1ms delay

    debug("scheduleBatch", "Scheduled batch for clip " + clipId + " with " + transformName);
};

/**
 * Execute batch apply for a clip.
 * Applies all pending transformations in a single operation.
 *
 * @param {string} clipId - Clip ID
 */
SequencerDevice.prototype.executeBatchApply = function(clipId) {
    var clip = this.getCurrentClip();
    if (!clip || clip.id !== clipId) {
        debug("executeBatch", "Clip changed or unavailable, skipping batch");
        delete this.pendingApplies[clipId];
        return;
    }

    var pending = this.pendingApplies[clipId];
    var trackType = this.trackState.type;

    debug("executeBatch", "Executing batch for clip " + clipId, pending);

    if (trackType === 'midi') {
        this.executeBatchMIDI(clip, clipId, pending);
    } else if (trackType === 'audio') {
        this.executeBatchAudio(clip, clipId, pending);
    }

    // Clear pending
    delete this.pendingApplies[clipId];
};

/**
 * Execute batch for MIDI clips.
 * V3.0: Apply deltas only on value change.
 *
 * @param {LiveAPI} clip - Clip object
 * @param {string} clipId - Clip ID
 * @param {Object} pending - Pending transformations
 */
SequencerDevice.prototype.executeBatchMIDI = function(clip, clipId, pending) {
    // 1. Read current clip state
    var notesJson = clip.call("get_all_notes_extended");
    var notes = parseNotesResponse(notesJson);
    if (!notes || !notes.notes) {
        handleError("executeBatchMIDI", "Failed to parse notes", false);
        return;
    }

    // 2. Initialize lastValues if needed
    if (!this.lastValues[clipId]) {
        this.lastValues[clipId] = {};
    }

    var changed = false;

    // 3a. Apply mute (only if changed)
    if ('mute' in pending) {
        if (pending.mute !== this.lastValues[clipId].mute) {
            var shouldMute = (pending.mute === 0); // 0 = mute, 1 = play
            for (var i = 0; i < notes.notes.length; i++) {
                notes.notes[i].mute = shouldMute ? 1 : 0; // Live API: 1=muted, 0=unmuted
            }
            this.lastValues[clipId].mute = pending.mute;
            changed = true;
        }
    }

    // 3b. Apply pitch (only if changed)
    if ('pitch' in pending) {
        var lastPitch = this.lastValues[clipId].pitch;

        if (pending.pitch !== lastPitch) {
            var shouldShiftUp = (pending.pitch === 1);

            // V4.0: Check if using parameter-based transpose
            if (this.instrumentType === 'parameter_transpose') {
                // Apply device parameter (absolute state)
                this.instrumentStrategy.applyTranspose(shouldShiftUp);
            } else {
                // Apply delta based on change
                var delta = 0;
                if (shouldShiftUp && lastPitch !== 1) {
                    // Going from off to on: shift up
                    delta = OCTAVE_SEMITONES;
                } else if (!shouldShiftUp && lastPitch === 1) {
                    // Going from on to off: shift down
                    delta = -OCTAVE_SEMITONES;
                }

                if (delta !== 0) {
                    for (var i = 0; i < notes.notes.length; i++) {
                        notes.notes[i].pitch += delta;
                    }
                    changed = true;
                }
            }

            this.lastValues[clipId].pitch = pending.pitch;
        }
    }

    // 4. Apply to clip (only if changed)
    if (changed) {
        try {
            clip.call("apply_note_modifications", notes);
        } catch (error) {
            handleError("executeBatchMIDI", error, false);
        }
    }
};

/**
 * Execute batch for audio clips.
 * V3.0: Apply absolute state to gain/pitch_coarse parameters.
 *
 * @param {LiveAPI} clip - Clip object
 * @param {string} clipId - Clip ID
 * @param {Object} pending - Pending transformations
 */
SequencerDevice.prototype.executeBatchAudio = function(clip, clipId, pending) {
    // Initialize lastValues if needed
    if (!this.lastValues[clipId]) {
        this.lastValues[clipId] = {};
        // Capture original gain on first access to this clip
        this.lastValues[clipId].originalGain = clip.get("gain");
    }

    try {
        // Apply mute (via gain) - absolute state
        if ('mute' in pending) {
            if (pending.mute !== this.lastValues[clipId].mute) {
                var shouldMute = (pending.mute === 0);
                // Restore original gain on unmute, not hardcoded value
                var gainValue = shouldMute ? MUTED_GAIN : this.lastValues[clipId].originalGain;
                clip.set("gain", gainValue);
                this.lastValues[clipId].mute = pending.mute;
            }
        }

        // Apply pitch (via pitch_coarse) - absolute state
        if ('pitch' in pending) {
            if (pending.pitch !== this.lastValues[clipId].pitch) {
                var shouldShiftUp = (pending.pitch === 1);
                var pitchValue = shouldShiftUp ? OCTAVE_SEMITONES : 0;
                clip.set("pitch_coarse", pitchValue);
                this.lastValues[clipId].pitch = pending.pitch;
            }
        }
    } catch (error) {
        handleError("executeBatchAudio", error, false);
    }
};

// ===== V3.0 TEMPERATURE TRANSFORMATION =====

/**
 * Setup temperature loop_jump observer.
 * Regenerates swap pattern on each loop.
 *
 * @param {LiveAPI} clip - Clip to observe
 */
SequencerDevice.prototype.setupTemperatureLoopJumpObserver = function() {
    this.clearTemperatureLoopJumpObserver();

    var clip = this.getCurrentClip();
    if (!clip) return;

    var self = this;

    this.temperatureLoopJumpObserver = createObserver(
        clip.path,
        "loop_jump",
        function(args) {
            defer(function() {
                self.onTemperatureLoopJump();
            });
        }
    );

    this.observerRegistry.register('temperature_loop_jump', this.temperatureLoopJumpObserver);
};

/**
 * Clear temperature loop_jump observer.
 */
SequencerDevice.prototype.clearTemperatureLoopJumpObserver = function() {
    this.observerRegistry.unregister('temperature_loop_jump');
    this.temperatureLoopJumpObserver = null;
};

/**
 * Set temperature value with state transitions.
 * V4.2: Extracted from temperature() function for use by OSC command handlers.
 *
 * @param {number} value - Temperature value (0.0-1.0)
 */
SequencerDevice.prototype.setTemperatureValue = function(value) {
    var newTemperatureValue = Math.max(0.0, Math.min(1.0, parseFloat(value)));

    // Detect transition type
    var wasActive = this.temperatureValue > 0;
    var willBeActive = newTemperatureValue > 0;

    // Get current clip for state operations
    var clip = this.getCurrentClip();
    var clipId = clip ? clip.id : null;

    // Handle state transitions
    if (!wasActive && willBeActive) {
        // Transition: 0 -> >0 (enable)
        if (clipId) {
            this.captureTemperatureState(clipId);
        }
        debug("temperature", "Enabled: captured original state");
    } else if (wasActive && !willBeActive) {
        // Transition: >0 -> 0 (disable)
        if (clipId) {
            this.restoreTemperatureState(clipId);
        }
        debug("temperature", "Disabled: restored original state");
    }

    // Update temperature value
    this.temperatureValue = newTemperatureValue;
    this.temperatureActive = willBeActive;

    // Setup or clear loop jump observer
    if (willBeActive) {
        this.setupTemperatureLoopJumpObserver();
    } else {
        this.clearTemperatureLoopJumpObserver();
    }

    debug("temperature", "Set temperature to " + newTemperatureValue);
};

/**
 * Capture original pitches by note ID for temperature transformation.
 * Called when temperature transitions from 0 to >0.
 *
 * V3.1: Uses Live API note_id for robust tracking that handles:
 * - Overdubbing (new notes simply won't exist in map)
 * - Note deletion (missing IDs gracefully skipped)
 * - Pitch sequencer interaction (accounts for current pitch state)
 *
 * @param {string} clipId - Clip ID to capture state for
 */
SequencerDevice.prototype.captureTemperatureState = function(clipId) {
    var clip = this.getCurrentClip();
    if (!clip || clip.id !== clipId) {
        debug("captureTemperatureState", "Clip unavailable or ID mismatch");
        return;
    }

    // Read current notes with note IDs
    var notesJson = clip.call("get_all_notes_extended");
    var notes = parseNotesResponse(notesJson);
    if (!notes || !notes.notes || notes.notes.length === 0) {
        debug("captureTemperatureState", "No notes to capture");
        return;
    }

    // Determine if pitch sequencer is currently shifting notes up
    var pitchWasOn = false;
    if (this.lastValues[clipId] && this.lastValues[clipId].pitch === 1) {
        pitchWasOn = true;
    }

    // Calculate offset to get TRUE base pitch (before pitch sequencer shift)
    // If pitch is on, notes are currently shifted +12, so subtract to get base
    var pitchOffset = 0;
    if (pitchWasOn) {
        // V4.0: Check if using note-based transpose
        // If using parameter-based, notes aren't shifted - the device parameter is
        if (this.instrumentType !== 'parameter_transpose') {
            pitchOffset = -OCTAVE_SEMITONES;
        }
    }

    // Build originalPitches map: noteId -> base pitch
    var originalPitches = {};
    for (var i = 0; i < notes.notes.length; i++) {
        var note = notes.notes[i];
        // Store the TRUE base pitch (accounting for any pitch sequencer shift)
        originalPitches[note.note_id] = note.pitch + pitchOffset;
    }

    // Store state
    this.temperatureState[clipId] = {
        originalPitches: originalPitches,
        capturedWithPitchOn: pitchWasOn
    };

    debug("captureTemperatureState", "Captured " + notes.notes.length + " notes for clip " + clipId, {
        pitchWasOn: pitchWasOn,
        sampleNoteIds: Object.keys(originalPitches).slice(0, 3)
    });
};

/**
 * Restore original pitches from note ID map.
 * Called when temperature transitions from >0 to 0.
 *
 * V3.1: Restores each note to its original pitch by note ID.
 * - Notes that were overdubbed (not in map) keep their current pitch
 * - Accounts for current pitch sequencer state when restoring
 *
 * @param {string} clipId - Clip ID to restore state for
 */
SequencerDevice.prototype.restoreTemperatureState = function(clipId) {
    var state = this.temperatureState[clipId];
    if (!state) {
        debug("restoreTemperatureState", "No state to restore for clip " + clipId);
        return;
    }

    var clip = this.getCurrentClip();
    if (!clip || clip.id !== clipId) {
        debug("restoreTemperatureState", "Clip unavailable or ID mismatch");
        delete this.temperatureState[clipId];
        return;
    }

    // Read current notes
    var notesJson = clip.call("get_all_notes_extended");
    var notes = parseNotesResponse(notesJson);
    if (!notes || !notes.notes) {
        debug("restoreTemperatureState", "No notes to restore");
        delete this.temperatureState[clipId];
        return;
    }

    // Determine current pitch sequencer state for adjustment
    var currentPitchOn = false;
    if (this.lastValues[clipId] && this.lastValues[clipId].pitch === 1) {
        currentPitchOn = true;
    }

    // Calculate pitch adjustment based on current pitch sequencer state
    // If pitch is currently on, we need to add the shift to the base pitch
    var pitchAdjustment = 0;
    if (currentPitchOn) {
        // V4.0: Check if using note-based transpose
        // If using parameter-based, don't adjust notes - device handles it
        if (this.instrumentType !== 'parameter_transpose') {
            pitchAdjustment = OCTAVE_SEMITONES;
        }
    }

    // Restore each note's pitch from the map
    var changed = false;
    var restoredCount = 0;
    var skippedCount = 0;

    for (var i = 0; i < notes.notes.length; i++) {
        var note = notes.notes[i];
        var originalPitch = state.originalPitches[note.note_id];

        if (originalPitch !== undefined) {
            // Known note - restore to original base pitch + current pitch adjustment
            note.pitch = originalPitch + pitchAdjustment;
            changed = true;
            restoredCount++;
        } else {
            // New note from overdub - keep current pitch
            skippedCount++;
        }
    }

    // Apply modifications if any changes were made
    if (changed) {
        try {
            clip.call("apply_note_modifications", notes);
            debug("restoreTemperatureState", "Restored " + restoredCount + " notes, skipped " + skippedCount + " (overdubs)");
        } catch (error) {
            handleError("restoreTemperatureState", error, false);
        }
    }

    // Clear state
    delete this.temperatureState[clipId];
};

/**
 * Handle temperature loop jump.
 * V3.1: Restores to original pitches first, then applies fresh random shuffle.
 *
 * This ensures temperature value directly controls "distance from original":
 * - temp = 0.1 → few swaps from original each loop
 * - temp = 0.9 → many swaps from original each loop
 *
 * Each loop is random but always based on the original pitches,
 * not cumulative scrambling on top of previous scrambles.
 */
SequencerDevice.prototype.onTemperatureLoopJump = function() {
    if (!this.temperatureActive || this.temperatureValue <= 0) return;

    var clip = this.getCurrentClip();
    if (!clip) return;

    var clipId = clip.id;
    var state = this.temperatureState[clipId];

    // Need temperature state to know original pitches
    if (!state) {
        debug("onTemperatureLoopJump", "No temperature state for clip " + clipId);
        return;
    }

    // 1. Read current notes
    var notesJson = clip.call("get_all_notes_extended");
    var notes = parseNotesResponse(notesJson);
    if (!notes || !notes.notes) return;

    // 2. Calculate pitch adjustment for current pitch sequencer state
    var currentPitchOn = false;
    if (this.lastValues[clipId] && this.lastValues[clipId].pitch === 1) {
        currentPitchOn = true;
    }
    var pitchAdjustment = 0;
    if (currentPitchOn) {
        // V4.0: Check if using note-based transpose
        if (this.instrumentType !== 'parameter_transpose') {
            pitchAdjustment = OCTAVE_SEMITONES;
        }
    }

    // 3. Restore all notes to original pitches first
    for (var i = 0; i < notes.notes.length; i++) {
        var note = notes.notes[i];
        var originalPitch = state.originalPitches[note.note_id];
        if (originalPitch !== undefined) {
            // Restore to original + current pitch sequencer adjustment
            note.pitch = originalPitch + pitchAdjustment;
        }
        // Overdubbed notes (not in map) keep their current pitch
    }

    // 4. Generate NEW random swap pattern based on temperature
    this.temperatureSwapPattern = generateSwapPattern(
        notes.notes,
        this.temperatureValue
    );

    debug("temperature", "Generated " + this.temperatureSwapPattern.length + " swap groups from original");

    // 5. Apply swaps to the restored original pitches
    applySwapPattern(notes.notes, this.temperatureSwapPattern);

    // 6. Apply to clip
    try {
        clip.call("apply_note_modifications", notes);
        debug("temperature", "Applied temperature transformation from original");
    } catch (error) {
        handleError("onTemperatureLoopJump", error, false);
    }
};

// ===== V4.0 INSTRUMENT DETECTION =====

/**
 * Detect instrument and configure transpose strategy.
 * V4.0: Name-based parameter detection.
 * Called on transport start and device changes.
 */
SequencerDevice.prototype.detectInstrumentType = function() {
    // Reset to defaults
    this.instrumentType = 'unknown';
    this.instrumentDevice = null;
    this.instrumentDeviceId = null;
    this.instrumentStrategy = new DefaultInstrumentStrategy();

    if (this.trackState.type !== 'midi') return;

    // Find instrument device on track
    var result = InstrumentDetector.findInstrumentDevice(this.trackState.ref);
    if (!result) {
        debug("instrument", "No instrument device found");
        return;
    }

    this.instrumentDevice = result.device;
    this.instrumentDeviceId = result.deviceId;

    // Default is note_transpose. Only devices in parameterTransposeDevices are
    // candidates for parameter-based transposition (with fallback to note_transpose
    // if no named param is found on those devices either).
    if (isParameterTransposeDevice(result.device)) {
        var transposeResult = findTransposeParameterByName(result.device);
        if (transposeResult) {
            this.instrumentType = 'parameter_transpose';
            this.instrumentStrategy = new TransposeStrategy(
                result.device,
                transposeResult.param,
                transposeResult.shiftAmount,
                transposeResult.name
            );
            debug("instrument", "Found transpose param '" + transposeResult.name +
                  "' at index " + transposeResult.index +
                  " (shift: " + transposeResult.shiftAmount + ")");
        } else {
            this.instrumentType = 'note_transpose';
            debug("instrument", "Listed device but no named param found, falling back to note-based shifting");
        }
    } else {
        this.instrumentType = 'note_transpose';
        debug("instrument", "Using note-based shifting (default)");
    }
};

// ===== CLIP MANAGEMENT =====

/**
 * Get the currently playing clip on the track.
 * Automatically sets up clip observers when clip changes.
 * @returns {LiveAPI|null} - Live API clip object or null if no clip playing
 */
SequencerDevice.prototype.getCurrentClip = function() {
    if (!this.trackState.ref) return null;

    try {
        // Try playing_slot_index first
        var slotIndex = this.trackState.ref.get("playing_slot_index");

        // If no playing slot, try fired_slot_index
        if (!slotIndex || slotIndex[0] < 0) {
            slotIndex = this.trackState.ref.get("fired_slot_index");
        }

        // Early exit if no slot found
        if (!slotIndex || slotIndex[0] < 0) return null;

        var clipPath = this.trackState.ref.path + " clip_slots " + slotIndex[0] + " clip";
        var clip = new LiveAPI(clipPath);

        if (clip && clip.id !== INVALID_LIVE_API_ID) {
            // Setup observers if clip changed
            if (this.clipState.hasChanged(clip.id)) {
                this.setupClipObservers(clip);
                this.clipState.update(clip.id);
            }
            return clip;
        }
        return null;
    } catch (error) {
        handleError("getCurrentClip", error, false);
        return null;
    }
};

// ===== SHARED SEQUENCER FUNCTIONALITY =====

/**
 * Generic handler for sequencer messages (used by both mute and pitch sequencers)
 * @param {Object} seq - The sequencer object
 * @param {String} seqName - Name of sequencer ('mute' or 'pitch')
 * @param {Array} args - Message arguments
 */
SequencerDevice.prototype.handleSequencerMessage = function(seq, seqName, args) {
    var parameter = args[0];

    // Augment args with context for command handlers
    args.seq = seq;
    args.seqName = seqName;

    // Use command registry
    if (!this.commandRegistry.execute(parameter, args, this)) {
        debug("handleSequencerMessage", "Unknown command: " + parameter);
    }
};

/**
 * Convert bar.beat.tick format to absolute tick count.
 * Uses actual time signature from Live set for accurate conversion.
 * @param {number} bars - Number of bars
 * @param {number} beats - Number of beats
 * @param {number} ticks - Number of ticks
 * @returns {number} - Total ticks
 */
SequencerDevice.prototype.barBeatTickToTicks = function(bars, beats, ticks) {
    var ticksPerBeat = TICKS_PER_QUARTER_NOTE;
    var beatsPerBar = this.timeSignatureNumerator;
    var totalTicks = (bars * beatsPerBar * ticksPerBeat) + (beats * ticksPerBeat) + ticks;
    return totalTicks;
};

/**
 * Calculate ticks per step based on division setting.
 * Supports both legacy string format ("1/16") and bar.beat.tick array format.
 * @param {string|Array} division - Division format
 * @returns {number} - Ticks per step
 */
SequencerDevice.prototype.getTicksPerStep = function(division) {
    if (typeof division === "string") {
        // Legacy string format
        switch(division) {
            case "1/1":  return TICKS_PER_QUARTER_NOTE * 4;
            case "1/2":  return TICKS_PER_QUARTER_NOTE * 2;
            case "1/4":  return TICKS_PER_QUARTER_NOTE;
            case "1/8":  return TICKS_PER_QUARTER_NOTE / 2;
            case "1/16": return TICKS_PER_QUARTER_NOTE / 4;
            case "1/32": return TICKS_PER_QUARTER_NOTE / 8;
            case "1/64": return TICKS_PER_QUARTER_NOTE / 16;
            default: return TICKS_PER_QUARTER_NOTE / 4;
        }
    } else if (Array.isArray(division) && division.length === 3) {
        return this.barBeatTickToTicks(division[0], division[1], division[2]);
    } else {
        return 120; // Default to 16th notes
    }
};

/**
 * Process both sequencers from a single song time message.
 * V4.2: Unified entry point - single song_time drives both mute and pitch.
 *
 * Called every 16th note (120 ticks) with absolute tick position from transport.
 * This replaces the old separate "mute ticks" / "pitch ticks" message paths.
 *
 * V4.3: Adds lookahead so transformations are applied before the audio actually
 * plays, compensating for processing latency.
 *
 * @param {number} ticks - Absolute tick position from transport
 */
SequencerDevice.prototype.processWithSongTime = function(ticks) {
    // Lookahead: process ahead so transformations apply before audio plays
    // 120 ticks = 1 full 16th note - compensates for Live API latency
    var lookaheadTicks = 120;
    var targetTicks = ticks + lookaheadTicks;

    // Process both sequencers from single time source with lookahead
    this.processSequencerTick('mute', targetTicks);
    this.processSequencerTick('pitch', targetTicks);
};

/**
 * Generic tick processor for any sequencer.
 * V3.0: Calculates current step and schedules batch apply.
 * V4.1: Pitch sequencer with parameter_transpose works without a playing clip.
 *
 * @param {string} seqName - Sequencer name ('mute', 'pitch', etc.)
 * @param {number} ticks - Absolute tick position
 */
SequencerDevice.prototype.processSequencerTick = function(seqName, ticks) {
    var seq = this.sequencers[seqName + 'Sequencer'];

    if (!seq || !seq.isActive()) return;

    var newStep = seq.calculateStep(ticks);

    if (newStep === seq.currentStep) return;

    seq.currentStep = newStep;

    try {
        var value = seq.getCurrentValue();
        var clip = this.getCurrentClip();

        // V4.1: For pitch sequencer with parameter_transpose, we can apply directly
        // without a clip since we're just adjusting a device parameter
        if (seqName === 'pitch' && this.instrumentType === 'parameter_transpose') {
            var shouldShiftUp = (value === 1);
            // Only apply if value changed from last applied
            if (value !== seq.lastAppliedValue) {
                this.instrumentStrategy.applyTranspose(shouldShiftUp);
                seq.lastAppliedValue = value;
            }
            this.sendSequencerFeedback(seqName);
            return;
        }

        // For other cases (mute, or pitch with note_transpose), we need a clip
        if (clip) {
            // V3.0: Add to batch queue
            this.scheduleBatchApply(clip.id, seqName, value);
        }

        this.sendSequencerFeedback(seqName);
    } catch (error) {
        handleError("processSequencerTick:" + seqName, error, false);
    }
};

/**
 * Send feedback to Max UI only (no OSC broadcast).
 * Used during init to avoid triggering 'position' origin broadcasts.
 *
 * @param {string} seqName - Sequencer name ('mute', 'pitch', etc.)
 */
SequencerDevice.prototype.sendSequencerFeedbackLocal = function(seqName) {
    var seq = this.sequencers[seqName + 'Sequencer'];
    if (!seq) return;

    // Update first 8 step toggles (Max UI displays 8 steps)
    for (var i = 0; i < 8; i++) {
        var value = (i < seq.pattern.length) ? seq.pattern[i] : seq.valueType.default;
        outlet(0, seqName + "_step_" + i, value);
    }

    // Current step indicator
    outlet(0, seqName + "_current", seq.currentStep);

    // Active state (derived from pattern content)
    outlet(0, seqName + "_active", seq.isActive() ? 1 : 0);
};

/**
 * Generic feedback sender for any sequencer.
 * Sends pattern, current step, and active state to Max UI.
 * Also broadcasts state for multi-track display (used during playback).
 *
 * @param {string} seqName - Sequencer name ('mute', 'pitch', etc.)
 */
SequencerDevice.prototype.sendSequencerFeedback = function(seqName) {
    // Send local feedback to Max UI
    this.sendSequencerFeedbackLocal(seqName);

    // Broadcast state for multi-track sequencer display
    // During playback, this is a position update
    this.broadcastState('position');
};

/**
 * Broadcast combined sequencer state for multi-track display.
 * Sends a single OSC message containing all sequencer state for this track.
 *
 * V6.0 Format (29 args - enabled flags removed, derived from pattern):
 *   trackIndex (0),
 *   origin (1),
 *   mutePattern[8] (2-9),
 *   muteLength (10), muteBars (11), muteBeats (12), muteTicks (13),
 *   mutePosition (14),
 *   pitchPattern[8] (15-22),
 *   pitchLength (23), pitchBars (24), pitchBeats (25), pitchTicks (26),
 *   pitchPosition (27),
 *   temperature (28)
 *
 * Origin values:
 *   'init'          - Device just initialized
 *   'set_state_ack' - Echo of set_state from UI
 *   'mute_step'     - Mute step toggled via OSC
 *   'pitch_step'    - Pitch step toggled via OSC
 *   'mute_length'   - Mute length changed via OSC
 *   'pitch_length'  - Pitch length changed via OSC
 *   'mute_rate'     - Mute rate changed via OSC
 *   'pitch_rate'    - Pitch rate changed via OSC
 *   'temperature'   - Temperature changed via OSC
 *   'position'      - Playhead moved (during playback)
 *   'pattr_restore' - Restored from Live Set / pattr
 *
 * This is routed by Max patch to: /looping/sequencer/state
 *
 * @param {string} origin - Why this broadcast is happening (default: 'unknown')
 */
SequencerDevice.prototype.broadcastState = function(origin) {
    origin = origin || 'unknown';
    var trackIndex = this.trackState.index;

    // Skip if track index not yet determined
    if (trackIndex < 0) return;

    var muteSeq = this.sequencers.muteSequencer;
    var pitchSeq = this.sequencers.pitchSequencer;

    // Skip if sequencers not initialized
    if (!muteSeq || !pitchSeq) return;

    var args = ["state_broadcast", trackIndex, origin];

    // Mute pattern (8 steps) - args 1-8
    for (var i = 0; i < 8; i++) {
        var value = (i < muteSeq.pattern.length) ? muteSeq.pattern[i] : muteSeq.valueType.default;
        args.push(value);
    }

    // Mute length - arg 9
    args.push(muteSeq.patternLength);

    // Mute rate as division (bars, beats, ticks) - args 10-12
    var muteDivision = muteSeq.division || [1, 0, 0];
    if (Array.isArray(muteDivision)) {
        args.push(muteDivision[0] || 0);  // bars
        args.push(muteDivision[1] || 0);  // beats
        args.push(muteDivision[2] || 0);  // ticks
    } else {
        // Legacy string format - convert to default
        args.push(1, 0, 0);  // default 1 bar
    }

    // Mute position - arg 13 (enabled removed - derived from pattern)
    args.push(muteSeq.currentStep);

    // Pitch pattern (8 steps) - args 14-21
    for (var i = 0; i < 8; i++) {
        var value = (i < pitchSeq.pattern.length) ? pitchSeq.pattern[i] : pitchSeq.valueType.default;
        args.push(value);
    }

    // Pitch length - arg 22
    args.push(pitchSeq.patternLength);

    // Pitch rate as division (bars, beats, ticks) - args 23-25
    var pitchDivision = pitchSeq.division || [1, 0, 0];
    if (Array.isArray(pitchDivision)) {
        args.push(pitchDivision[0] || 0);  // bars
        args.push(pitchDivision[1] || 0);  // beats
        args.push(pitchDivision[2] || 0);  // ticks
    } else {
        // Legacy string format - convert to default
        args.push(1, 0, 0);  // default 1 bar
    }

    // Pitch position - arg 26 (enabled removed - derived from pattern)
    args.push(pitchSeq.currentStep);

    // Temperature - arg 27
    args.push(this.temperatureValue || 0.0);

    // Send via outlet 0 - Max patch will route to OSC
    outlet.apply(null, [0].concat(args));

    // Also output for pattr storage (28-arg list WITHOUT origin)
    // pattr_state format: trackIndex, mutePattern[8], muteLength, muteBars, muteBeats, muteTicks,
    //                     mutePosition, pitchPattern[8], pitchLength, pitchBars,
    //                     pitchBeats, pitchTicks, pitchPosition, temperature
    // args is: ["state_broadcast", trackIndex, origin, data...]
    // We want: ["pattr_state", trackIndex, data...] (skip origin at index 2)
    // Skip for position updates - they happen constantly during playback and don't need persistence
    // Skip for pattr_restore - we just loaded from pattr, no need to save back (prevents feedback loop)
    if (origin !== 'position' && origin !== 'pattr_restore') {
        var pattrArgs = ["pattr_state", args[1]].concat(args.slice(3));
        outlet.apply(null, [0].concat(pattrArgs));
    }
};

/**
 * Handle clip change event - resets sequencer state.
 * V3.1: Also handles temperature state cleanup and re-capture.
 * Called when user switches to a different clip.
 */
SequencerDevice.prototype.onClipChanged = function() {
    // V3.1: Handle temperature state on clip change
    // Clear old clip's state to prevent memory accumulation
    // Re-capture for new clip if temperature is still active
    if (Object.keys(this.temperatureState).length > 0) {
        this.temperatureState = {};  // Clear all old clip states
        debug("onClipChanged", "Cleared temperature state for old clip");
    }

    // If temperature is active, capture state for the new clip
    if (this.temperatureValue > 0 && this.temperatureActive) {
        var clip = this.getCurrentClip();
        if (clip) {
            this.captureTemperatureState(clip.id);
            debug("onClipChanged", "Captured temperature state for new clip");
        }
    }

    // V3.0: lastValues are tracked per clipId, so no need to clear
    // Just clear sequencer caches
    for (var name in this.sequencers) {
        if (this.sequencers.hasOwnProperty(name)) {
            this.sequencers[name].invalidateCache();
            this.sequencers[name].lastState = null;
        }
    }
};

// ===== STATE PERSISTENCE =====

/**
 * Get current device state for saving/persistence (v3.0 format).
 * @returns {Object} - Device state including all sequencer patterns and settings
 */
SequencerDevice.prototype.getState = function() {
    var state = {
        version: '3.1',
        deviceId: this.deviceId,
        temperature: this.temperatureValue || 0.0,
        sequencers: {}
    };

    // Save state for all sequencers
    for (var name in this.sequencers) {
        if (this.sequencers.hasOwnProperty(name)) {
            var seq = this.sequencers[name];
            var cleanName = name.replace('Sequencer', '');
            state.sequencers[cleanName] = {
                pattern: seq.pattern,
                patternLength: seq.patternLength,
                division: seq.division
            };
        }
    }

    return state;
};

/**
 * Restore device state from saved data (supports v1.x, v2.0, v2.1, v3.0, and v3.1 formats).
 * @param {Object} state - Saved device state
 */
SequencerDevice.prototype.setState = function(state) {
    // Handle v3.1, v3.0, v2.1, and v2.0 formats
    if ((state.version === '3.1' || state.version === '3.0' || state.version === '2.1' || state.version === '2.0') && state.sequencers) {
        for (var name in state.sequencers) {
            if (state.sequencers.hasOwnProperty(name) && this.sequencers[name + 'Sequencer']) {
                var savedSeq = state.sequencers[name];
                var seq = this.sequencers[name + 'Sequencer'];

                if (savedSeq.pattern) seq.setPattern(savedSeq.pattern);
                if (savedSeq.patternLength) seq.setLength(savedSeq.patternLength);
                // Note: 'enabled' no longer restored - derived from pattern content
                if (savedSeq.division) seq.setDivision(savedSeq.division, this.timeSignatureNumerator);

                this.sendSequencerFeedback(name);
            }
        }

        // v3.1: Restore temperature
        if (state.temperature !== undefined) {
            this.setTemperatureValue(state.temperature);
        }
    }
    // Handle legacy v1.x format (backward compatibility)
    else {
        if (state.mute && this.sequencers.muteSequencer) {
            var muteSeq = this.sequencers.muteSequencer;
            if (state.mute.pattern) muteSeq.setPattern(state.mute.pattern);
            if (state.mute.patternLength) muteSeq.setLength(state.mute.patternLength);
            if (state.mute.division) muteSeq.setDivision(state.mute.division, this.timeSignatureNumerator);
            this.sendSequencerFeedback('mute');
        }

        if (state.pitch && this.sequencers.pitchSequencer) {
            var pitchSeq = this.sequencers.pitchSequencer;
            if (state.pitch.pattern) pitchSeq.setPattern(state.pitch.pattern);
            if (state.pitch.patternLength) pitchSeq.setLength(state.pitch.patternLength);
            if (state.pitch.division) pitchSeq.setDivision(state.pitch.division, this.timeSignatureNumerator);
            this.sendSequencerFeedback('pitch');
        }
    }
};

// ===== GLOBAL INSTANCE =====
var sequencer = new SequencerDevice();

// ===== MAX MESSAGE HANDLERS =====
// These functions handle incoming messages from Max

/**
 * Handle all mute sequencer messages.
 * Commands: pattern, step, enable, division, length, reset, bypass, tick
 */
function mute() {
    var args = arrayfromargs(arguments);
    sequencer.handleSequencerMessage(sequencer.muteSeq, 'mute', args);
}

/**
 * Handle all pitch sequencer messages.
 * Commands: pattern, step, enable, division, length, reset, tick
 */
function pitch() {
    var args = arrayfromargs(arguments);
    sequencer.handleSequencerMessage(sequencer.pitchSeq, 'pitch', args);
}

/**
 * Handle song time messages from Max transport.
 * V4.2: Single message drives both mute and pitch sequencers.
 *
 * Called every 16th note (120 ticks) with absolute tick position.
 * Max patch sends: song_time <ticks>
 *
 * Usage: song_time 480  (at beat 2)
 *        song_time 960  (at beat 3)
 */
function song_time() {
    var args = arrayfromargs(arguments);
    if (args.length >= 1) {
        sequencer.commandRegistry.execute('song_time', args, sequencer);
    }
}

// ===== OSC COMMAND HANDLERS (Phase 2) =====
// These functions handle OSC commands routed from Max patch
// Each command includes deviceId as first arg for multi-device filtering

function seq_mute_step() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_mute_step', args, sequencer);
}

function seq_mute_length() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_mute_length', args, sequencer);
}

function seq_mute_rate() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_mute_rate', args, sequencer);
}

function seq_pitch_step() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_pitch_step', args, sequencer);
}

function seq_pitch_length() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_pitch_length', args, sequencer);
}

function seq_pitch_rate() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_pitch_rate', args, sequencer);
}

function seq_temperature() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_temperature', args, sequencer);
}

function set_state() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('set_state', args, sequencer);
}

/**
 * Handle temperature transformation messages.
 * V3.1: Value-based enable/disable with note ID tracking for reversibility.
 *
 * Behavior:
 * - temperature 0 -> >0: Capture original pitches by note ID, start shuffling
 * - temperature >0 -> 0: Restore original pitches, stop shuffling
 * - temperature >0 -> >0: Just change intensity (no re-capture)
 *
 * Usage: temperature 0.7  (capture originals if first time, start shuffling)
 *        temperature 0.0  (restore originals, stop shuffling)
 */
function temperature() {
    var args = arrayfromargs(arguments);

    if (args.length < 1) {
        handleError("temperature", new Error("No temperature value provided"), false);
        return;
    }

    var rawValue = args[0];
    var newTemperatureValue = Math.max(0.0, Math.min(1.0, parseFloat(rawValue)));

    // Detect transition type
    var wasActive = sequencer.temperatureValue > 0;
    var willBeActive = newTemperatureValue > 0;

    // Get current clip for state operations
    var clip = sequencer.getCurrentClip();
    var clipId = clip ? clip.id : null;

    // V3.1: Handle state transitions
    if (!wasActive && willBeActive) {
        // Transition: 0 -> >0 (enable)
        // Capture original pitches before any shuffling
        if (clipId) {
            sequencer.captureTemperatureState(clipId);
        }
        debug("temperature", "Enabled: captured original state");
    } else if (wasActive && !willBeActive) {
        // Transition: >0 -> 0 (disable)
        // Restore original pitches
        if (clipId) {
            sequencer.restoreTemperatureState(clipId);
        }
        debug("temperature", "Disabled: restored original state");
    }
    // else: >0 -> >0 (intensity change only, no capture/restore)

    // Update temperature value
    sequencer.temperatureValue = newTemperatureValue;
    sequencer.temperatureActive = willBeActive;

    // Setup or clear loop jump observer
    if (willBeActive) {
        sequencer.setupTemperatureLoopJumpObserver();
    } else {
        sequencer.clearTemperatureLoopJumpObserver();
    }

    debug("temperature", "Set temperature to " + newTemperatureValue);
}

/**
 * Reset temperature to original state.
 * V3.1: Uses note ID tracking to restore original pitches.
 * Usage: temperature_reset
 */
function temperature_reset() {
    debug("temperature", "Reset requested");

    var clip = sequencer.getCurrentClip();
    var clipId = clip ? clip.id : null;

    // V3.1: Restore original pitches if we have temperature state
    if (clipId && sequencer.temperatureState[clipId]) {
        sequencer.restoreTemperatureState(clipId);
    }

    // Turn off temperature
    sequencer.temperatureValue = 0.0;
    sequencer.temperatureActive = false;
    sequencer.clearTemperatureLoopJumpObserver();
}

/**
 * Force new variation with current temperature.
 * V3.0: Manually triggers loop jump handler.
 * Usage: temperature_shuffle
 */
function temperature_shuffle() {
    if (!sequencer.temperatureActive || sequencer.temperatureValue <= 0) {
        debug("temperature", "Shuffle requested but temperature not active");
        return;
    }

    debug("temperature", "Manual shuffle requested");
    sequencer.onTemperatureLoopJump();
}

function init() {
    sequencer.init();
}

// Support bang message for initialization
function bang() {
    sequencer.init();
}

function clip_changed() {
    sequencer.onClipChanged();
}

function getState() {
    outlet(0, "state", JSON.stringify(sequencer.getState()));
}

function setState(stateJson) {
    try {
        var state = JSON.parse(stateJson);
        sequencer.setState(state);
    } catch (error) {
        handleError("setState", error, true);
    }
}

/**
 * Restore state from pattr (28-arg list format matching ADR-166).
 * Called on Live Set load via: [route pattr_state] -> [prepend restoreState] -> v8
 *
 * Args (28 total):
 *   trackIndex (0),
 *   mutePattern[8] (1-8), muteLength (9), muteBars (10), muteBeats (11), muteTicks (12),
 *   mutePosition (13),
 *   pitchPattern[8] (14-21), pitchLength (22), pitchBars (23), pitchBeats (24), pitchTicks (25),
 *   pitchPosition (26),
 *   temperature (27)
 *
 * Note: muteEnabled/pitchEnabled removed in ADR-166 - now derived from pattern content.
 */
function restoreState() {
    var args = arrayfromargs(arguments);
    post('[RESTORE] restoreState called with ' + args.length + ' args\n');

    if (args.length < 28) {
        post('[RESTORE] Not enough args (expected 28, got ' + args.length + '), skipping\n');
        return;
    }

    var idx = 1;  // Skip trackIndex (arg 0)

    // Mute pattern (8 steps)
    for (var i = 0; i < 8; i++) {
        sequencer.sequencers.muteSequencer.pattern[i] = parseInt(args[idx++]);
    }

    // Mute length and division
    sequencer.sequencers.muteSequencer.patternLength = parseInt(args[idx++]);
    var muteBars = parseInt(args[idx++]);
    var muteBeats = parseInt(args[idx++]);
    var muteTicks = parseInt(args[idx++]);
    sequencer.sequencers.muteSequencer.division = [muteBars, muteBeats, muteTicks];

    // Skip mute position (runtime state, not saved)
    idx += 1;

    // Pitch pattern (8 steps)
    for (var i = 0; i < 8; i++) {
        sequencer.sequencers.pitchSequencer.pattern[i] = parseInt(args[idx++]);
    }

    // Pitch length and division
    sequencer.sequencers.pitchSequencer.patternLength = parseInt(args[idx++]);
    var pitchBars = parseInt(args[idx++]);
    var pitchBeats = parseInt(args[idx++]);
    var pitchTicks = parseInt(args[idx++]);
    sequencer.sequencers.pitchSequencer.division = [pitchBars, pitchBeats, pitchTicks];

    // Skip pitch position (runtime state, not saved)
    idx += 1;

    // Temperature
    sequencer.temperatureValue = parseFloat(args[idx++]);

    post('[RESTORE] State restored, broadcasting...\n');
    sequencer.broadcastState('pattr_restore');
}

// Main message handler
function msg_int() {
}

function msg_float() {
}

// Handle all other messages - routes OSC addresses to command handlers
function anything() {
    var address = messagename;
    var args = arrayfromargs(arguments);

    // Log ALL incoming messages to see what's arriving
    post('anything() received: ' + address + ' args: ' + args.join(', ') + '\n');

    // Only handle /looping/sequencer/ messages
    if (address.indexOf('/looping/sequencer/') !== 0) {
        post('  -> ignoring (not /looping/sequencer/)\n');
        return;
    }

    // Strip prefix and convert to command name
    // /looping/sequencer/mute/step -> seq_mute_step
    // /looping/sequencer/set/state -> set_state
    var path = address.replace('/looping/sequencer/', '');
    var parts = path.split('/');
    var command;

    if (parts[0] === 'set' && parts[1] === 'state') {
        command = 'set_state';
    } else if (parts[0] === 'temperature') {
        command = 'seq_temperature';
    } else if (parts.length === 2) {
        // mute/step, mute/length, mute/rate, pitch/step, etc.
        command = 'seq_' + parts[0] + '_' + parts[1];
    } else {
        post('Unknown sequencer command: ' + address + '\n');
        return;
    }

    post('OSC -> ' + command + ' ' + args.join(' ') + '\n');
    sequencer.commandRegistry.execute(command, args, sequencer);
}

// Handle loadbang
function loadbang() {
}

// ===== STATE PERSISTENCE (pattrstorage) =====
// These functions are called by pattrstorage to save/restore state with Live Set

/**
 * Called by pattrstorage when Live saves the set.
 * Returns sequencer state as JSON string.
 */
function getvalueof() {
    // Debug: check if sequencer and its sequencers exist
    post('[STATE] getvalueof called\n');
    post('[STATE] sequencer exists: ' + (sequencer ? 'yes' : 'no') + '\n');
    post('[STATE] sequencer.sequencers exists: ' + (sequencer && sequencer.sequencers ? 'yes' : 'no') + '\n');
    post('[STATE] muteSequencer exists: ' + (sequencer && sequencer.sequencers && sequencer.sequencers.muteSequencer ? 'yes' : 'no') + '\n');

    // Direct read from the sequencer object
    if (sequencer && sequencer.sequencers && sequencer.sequencers.muteSequencer) {
        post('[STATE] DIRECT muteSequencer.pattern: ' + sequencer.sequencers.muteSequencer.pattern.join(',') + '\n');
    }

    var state = sequencer.getState();
    var json = JSON.stringify(state);
    post('[STATE] getState() returned mute pattern: ' + state.sequencers.mute.pattern.join(',') + '\n');
    post('[STATE] version: ' + state.version + ', temperature: ' + state.temperature + '\n');
    post('[STATE] pitch pattern: ' + state.sequencers.pitch.pattern.join(',') + '\n');
    return json;
}

/**
 * Called by pattrstorage when Live loads a set.
 * Restores sequencer state from JSON string.
 */
function setvalueof(v) {
    post('[STATE] setvalueof called with type: ' + typeof v + '\n');
    if (v) {
        post('[STATE] value: ' + (typeof v === 'string' ? v.substring(0, 100) : JSON.stringify(v).substring(0, 100)) + '...\n');
    }

    if (v && typeof v === 'string') {
        try {
            var state = JSON.parse(v);
            post('[STATE] Parsed state version: ' + state.version + '\n');
            post('[STATE] mute pattern: ' + (state.sequencers && state.sequencers.mute ? state.sequencers.mute.pattern.join(',') : 'N/A') + '\n');
            sequencer.setState(state);
            post('[STATE] setState complete, broadcasting...\n');
            // Broadcast restored state to UI
            sequencer.broadcastState('pattr_restore');
            post('[STATE] Restore complete\n');
        } catch (e) {
            post('[STATE] Error restoring state: ' + e + '\n');
        }
    } else {
        post('[STATE] Skipping - invalid value type or empty\n');
    }
}

// Handle notifydeleted
function notifydeleted() {
    // Use observer registry for cleanup
    sequencer.observerRegistry.clearAll();

    // Clear temperature loop_jump observer
    if (sequencer.transformations && sequencer.transformations.temperature) {
        sequencer.transformations.temperature.clearLoopJumpObserver();
    }
}
