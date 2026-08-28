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
var debug = utils.debug;
var handleError = utils.handleError;
var createLiveAPI = utils.createLiveAPI;
var releaseLiveAPI = utils.releaseLiveAPI;
var repointLiveAPI = utils.repointLiveAPI;

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

    // One scratch handle walks the device list and is released in the finally
    // below; only the match is promoted to an owned handle. Constructing a
    // handle per device orphaned every non-instrument device it walked past.
    var scratch = null;

    try {
        var devices = track.get("devices");
        if (!devices || devices.length === 0) return null;

        var basePath = track.path + " devices ";
        for (var i = 0; i < devices.length; i++) {
            scratch = repointLiveAPI(scratch, basePath + i);

            if (!scratch || scratch.id === INVALID_LIVE_API_ID) continue;

            var deviceType = scratch.get("type");
            var isInstrument = (deviceType && (deviceType[0] === "instrument" || deviceType[0] === 1));

            if (isInstrument) {
                // Owned by the caller (SequencerDevice.instrumentDevice and the
                // strategies); released via _releaseInstrumentHandles.
                var device = createLiveAPI(basePath + i);
                if (!device || device.id === INVALID_LIVE_API_ID) {
                    releaseLiveAPI(device);
                    return null;
                }
                return {
                    device: device,
                    deviceId: device.id
                };
            }
        }
    } catch (error) {
        handleError("InstrumentDetector.findInstrumentDevice", error, false);
    } finally {
        scratch = releaseLiveAPI(scratch);
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
 * Release every LiveAPI handle this strategy owns.
 * Strategies are replaced wholesale on re-detection; without this, the
 * outgoing strategy's device/param handles become unreachable with their
 * path listeners still registered. Idempotent and safe on null handles.
 */
InstrumentStrategy.prototype.release = function() {
    this.device = releaseLiveAPI(this.device);
};

/**
 * TransposeStrategy - Parameter-based pitch transposition.
 * Works for drum racks, instrument racks, and any device with a transpose macro.
 *
 * @param {LiveAPI} device - Device containing the transpose parameter
 * @param {LiveAPI} transposeParam - The transpose parameter API object
 * @param {number} shiftAmount - Amount to shift for octave (16 or 21)
 * @param {string} paramName - Name of the parameter (for debugging)
 * @param {number|null} cachedBaseline - Previously captured baseline; if
 *   provided, the strategy uses it instead of reading the live param value.
 *   Used when a strategy is rebuilt (e.g. after track devices change) while
 *   the param may still hold a shifted value from the prior strategy.
 */
function TransposeStrategy(device, transposeParam, shiftAmount, paramName, cachedBaseline) {
    InstrumentStrategy.call(this, device);
    this.transposeParam = transposeParam;
    this.shiftAmount = shiftAmount;
    this.paramName = paramName;
    if (cachedBaseline !== undefined && cachedBaseline !== null) {
        this.originalTranspose = cachedBaseline;
    }
    // Track whether we've ever actually shifted the param up. revertTranspose()
    // is called unconditionally on transport stop and on `devices` observer
    // fires; if we never shifted, there is nothing to revert and writing the
    // param is always wrong (and can rail it to min/max via a bad baseline).
    this.hasShifted = false;
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

    // Asked to return to baseline but we never shifted up — there is nothing to
    // restore, so writing the param is always wrong. This is the core fix for
    // the intermittent "transpose snaps to a rail" bug: the per-tick pitch path
    // calls applyTranspose(false) on the first tick after transport start (when
    // lastParameterValue is undefined and the step value is 0), and the stop
    // handler calls it again via revertTranspose — both touch the param even
    // when no pitch step is active. Gate every down-write on a real prior shift.
    if (!shouldShiftUp && !this.hasShifted) {
        debug("transpose", "applyTranspose no-op: shift-down with nothing shifted");
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
            // A falsy/empty read means a stale handle or device mid-rebuild —
            // we have no trustworthy baseline. Bail without writing rather than
            // falling back to a hardcoded value that rails params with a
            // narrower range (e.g. Simpler Transpose -48..+48).
            if (!currentTranspose || currentTranspose[0] === undefined) {
                debug("transpose", "applyTranspose BAIL: no baseline and param read failed");
                return;
            }
            this.originalTranspose = currentTranspose[0];
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
        // Mark shifted only after the write succeeds, so the invariant
        // "hasShifted iff the param was actually shifted" holds even if set()
        // throws on an invalid handle.
        if (shouldShiftUp) {
            this.hasShifted = true;
        }

        debug("transpose", "Applied " + (shouldShiftUp ? "+" : "") +
              this.shiftAmount + " via '" + this.paramName + "' param");
    } catch (error) {
        handleError("TransposeStrategy.applyTranspose", error, false);
    }
};

TransposeStrategy.prototype.revertTranspose = function() {
    debug("transpose", "revertTranspose called, originalTranspose=" + this.originalTranspose + ", hasShifted=" + this.hasShifted);
    // Nothing to revert if we never shifted up. Writing the param here is the
    // root cause of the intermittent "transpose snaps to min" bug: stop/devices
    // callbacks fire revert even when no pitch step was ever active.
    if (!this.hasShifted) {
        debug("transpose", "revertTranspose no-op: never shifted");
        return;
    }
    this.applyTranspose(false);
    this.hasShifted = false;
    debug("transpose", "revertTranspose complete");
    // originalTranspose persists across transport cycles so applyTranspose()
    // uses the known-good baseline rather than re-reading the param (which
    // may still hold a shifted value if the revert hasn't propagated yet).
};

TransposeStrategy.prototype.release = function() {
    this.transposeParam = releaseLiveAPI(this.transposeParam);
    InstrumentStrategy.prototype.release.call(this);
};

/**
 * MuteStrategy - Parameter-based mute via a rack macro.
 * Writes one of two values (muted / playing) to a device parameter.
 *
 * Holds the device path + param index rather than a resolved-once LiveAPI
 * handle. The path is re-resolved on each write because rack mutations (chain
 * changes, device add/remove) can invalidate cached parameter handles, and
 * dereferencing a stale handle from the audio thread crashes Live's
 * parameter cache (EXC_BAD_ACCESS at 0x58 on com.apple.audio.IOThread).
 *
 * The re-resolve re-points ONE owned handle rather than constructing a new
 * one. Semantics are identical — assigning `path` resolves afresh — but the
 * old form orphaned an attached handle on every mute flip, i.e. at sequencer
 * rate, which is the fastest way there is to hand V8's GC a live grenade.
 *
 * @param {LiveAPI} device - Device containing the mute parameter
 * @param {number} paramIndex - Index of the mute parameter on the device
 * @param {number} mutedValue - Value to write when muting
 * @param {number} playingValue - Value to write when unmuting
 */
function MuteStrategy(device, paramIndex, mutedValue, playingValue) {
    InstrumentStrategy.call(this, device);
    this.devicePath = device ? device.path : null;
    this.paramIndex = paramIndex;
    this.mutedValue = mutedValue;
    this.playingValue = playingValue;
    this._paramHandle = null;  // owned; re-pointed per write, released in release()
}
MuteStrategy.prototype = Object.create(InstrumentStrategy.prototype);
MuteStrategy.prototype.constructor = MuteStrategy;

MuteStrategy.prototype.applyMute = function(shouldMute) {
    if (!this.devicePath) return;
    try {
        this._paramHandle = repointLiveAPI(
            this._paramHandle,
            this.devicePath + " parameters " + this.paramIndex
        );
        var paramApi = this._paramHandle;
        if (!paramApi || paramApi.id === INVALID_LIVE_API_ID) return;
        var newValue = shouldMute ? this.mutedValue : this.playingValue;
        paramApi.set("value", newValue);
        debug("mute", "parameter_mute -> " + newValue);
    } catch (error) {
        handleError("MuteStrategy.applyMute", error, false);
    }
};

MuteStrategy.prototype.release = function() {
    this._paramHandle = releaseLiveAPI(this._paramHandle);
    InstrumentStrategy.prototype.release.call(this);
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
