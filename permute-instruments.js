/**
 * permute-instruments.js - Instrument detection and transpose strategies
 *
 * Depends on: permute-constants, permute-utils
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
 * InstrumentDetector - Finds instrument devices on a track.
 */
function InstrumentDetector() {}

/**
 * Find the first instrument device on a track.
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
 * TransposeStrategy - Parameter-based pitch transposition.
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
    // Read param bounds once. Simpler Transpose is -48..+48; rack macros
    // are 0..127. Using the param's own bounds means the clamp is always
    // correct without a per-device branch.
    this.paramMin = MIDI_MIN;
    this.paramMax = MIDI_MAX;
    try {
        if (transposeParam && transposeParam.id !== INVALID_LIVE_API_ID) {
            var minResult = transposeParam.get("min");
            var maxResult = transposeParam.get("max");
            if (minResult && minResult[0] !== undefined) this.paramMin = minResult[0];
            if (maxResult && maxResult[0] !== undefined) this.paramMax = maxResult[0];
        }
    } catch (e) {
        handleError("TransposeStrategy.ctor", e, false);
    }
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

        // Only read param value once to capture the original — avoids IPC on subsequent calls
        if (this.originalTranspose === null) {
            var currentTranspose = this.transposeParam.get("value");
            this.originalTranspose = currentTranspose ? currentTranspose[0] : DEFAULT_DRUM_RACK_TRANSPOSE;
            debug("transpose", "captured originalTranspose=" + this.originalTranspose);
        }

        var newValue;
        if (shouldShiftUp) {
            newValue = this.originalTranspose + this.shiftAmount;
        } else {
            newValue = this.originalTranspose;
        }

        newValue = Math.max(this.paramMin, Math.min(this.paramMax, newValue));
        debug("transpose", "setting param to " + newValue + " (original=" + this.originalTranspose + ", shift=" + this.shiftAmount + ", bounds=[" + this.paramMin + "," + this.paramMax + "])");
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
    // originalTranspose persists across transport cycles so applyTranspose()
    // uses the known-good baseline rather than re-reading the param (which
    // may still hold a shifted value if the revert hasn't propagated yet).
};

/**
 * MuteStrategy - Parameter-based mute via a rack macro.
 * Writes one of two values (muted / playing) to a device parameter.
 *
 * @param {LiveAPI} device - Device containing the mute parameter
 * @param {LiveAPI} muteParam - The mute parameter API object
 * @param {number} mutedValue - Value to write when muting
 * @param {number} playingValue - Value to write when unmuting
 */
function MuteStrategy(device, muteParam, mutedValue, playingValue) {
    InstrumentStrategy.call(this, device);
    this.muteParam = muteParam;
    this.mutedValue = mutedValue;
    this.playingValue = playingValue;
}
MuteStrategy.prototype = Object.create(InstrumentStrategy.prototype);
MuteStrategy.prototype.constructor = MuteStrategy;

MuteStrategy.prototype.applyMute = function(shouldMute) {
    debug("mute", "applyMute(" + shouldMute + ") device=" + (this.device && this.device.id) +
          " param=" + (this.muteParam && this.muteParam.id) +
          " paramPath=" + (this.muteParam && this.muteParam.path));
    if (!this.device || !this.muteParam) {
        debug("mute", "applyMute BAIL: missing device or muteParam");
        return;
    }
    if (this.muteParam.id === INVALID_LIVE_API_ID) {
        debug("mute", "applyMute BAIL: muteParam id invalid");
        return;
    }
    try {
        var newValue = shouldMute ? this.mutedValue : this.playingValue;
        this.muteParam.set("value", newValue);
        var readback = this.muteParam.get("value");
        debug("mute", "parameter_mute -> wrote " + newValue + ", readback=" +
              (readback && readback[0]));
    } catch (error) {
        handleError("MuteStrategy.applyMute", error, false);
    }
};

MuteStrategy.prototype.revertMute = function() {
    this.applyMute(false);
};

/**
 * DefaultInstrumentStrategy - Default (no device-based transpose or mute).
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

DefaultInstrumentStrategy.prototype.applyMute = function(value) {
    // No-op for default instruments
};

DefaultInstrumentStrategy.prototype.revertMute = function() {
    // No-op for default instruments
};

module.exports = {
    InstrumentDetector: InstrumentDetector,
    TransposeStrategy: TransposeStrategy,
    MuteStrategy: MuteStrategy,
    DefaultInstrumentStrategy: DefaultInstrumentStrategy
};
