/**
 * permute-sequencer.js - Generic Sequencer class
 *
 * Extracted from permute-device.js during Phase 3 modularization.
 * Depends on: permute-constants
 *
 * @version 3.1
 */

var constants = require('permute-constants');
var VALUE_TYPES = constants.VALUE_TYPES;
var MAX_PATTERN_LENGTH = constants.MAX_PATTERN_LENGTH;
var MIN_PATTERN_LENGTH = constants.MIN_PATTERN_LENGTH;

// Import utils for debug and calculateTicksPerStep
var utils = require('permute-utils');
var debug = utils.debug;
var calculateTicksPerStep = utils.calculateTicksPerStep;

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

    // V3.0: Last value applied via parameter-based transpose (clip-independent).
    // Distinct from SequencerDevice.lastValues[clipId] which tracks per-clip note-based deltas.
    this.lastParameterValue = null;
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

module.exports = {
    Sequencer: Sequencer
};
