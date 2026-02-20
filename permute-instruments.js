/**
 * permute-instruments.js - Instrument detection and strategy pattern
 *
 * Extracted from permute-device.js during Phase 3 modularization.
 * Depends on: permute-constants, permute-utils
 *
 * @version 3.1
 */

var constants = require('permute-constants');
var utils = require('permute-utils');

var INVALID_LIVE_API_ID = constants.INVALID_LIVE_API_ID;
var MIDI_MIN = constants.MIDI_MIN;
var MIDI_MAX = constants.MIDI_MAX;
var DEFAULT_DRUM_RACK_TRANSPOSE = constants.DEFAULT_DRUM_RACK_TRANSPOSE;
var debug = utils.debug;
var handleError = utils.handleError;

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

module.exports = {
    InstrumentDetector: InstrumentDetector,
    InstrumentStrategy: InstrumentStrategy,
    TransposeStrategy: TransposeStrategy,
    DefaultInstrumentStrategy: DefaultInstrumentStrategy
};
