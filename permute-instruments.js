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

// Tolerance for "is this reported value the one we just wrote?". Live echoes a
// value-changed notification for our own parameter writes; anything within this
// distance of our last write is ours, anything further is the user's hand.
var PARAM_WRITE_EPSILON = 1e-3;

// ===== INSTRUMENT DETECTOR HELPER =====

/**
 * InstrumentDetector - Finds instrument devices on a track.
 */
function InstrumentDetector() {}

/**
 * Find the first instrument device on a track.
 *
 * @param {LiveAPI} track - Track to analyze
 * @param {HandlePool} pool - Pool that owns the scratch and result handles
 * @returns {Object|null} - { device, deviceId } or null
 */
InstrumentDetector.findInstrumentDevice = function(track, pool) {
    if (!track || !pool) return null;

    // One scratch handle walks the device list and is released in the finally
    // below; only the match is promoted to an owned handle. Constructing a
    // handle per device orphaned every non-instrument device it walked past.
    var scratch = null;

    try {
        var devices = track.get("devices");
        if (!devices || devices.length === 0) return null;

        var basePath = track.path + " devices ";
        for (var i = 0; i < devices.length; i++) {
            scratch = pool.repoint(scratch, basePath + i);

            if (!scratch || scratch.id === INVALID_LIVE_API_ID) continue;

            var deviceType = scratch.get("type");
            var isInstrument = (deviceType && (deviceType[0] === "instrument" || deviceType[0] === 1));

            if (isInstrument) {
                // Owned by the caller (SequencerDevice.instrumentDevice and the
                // strategies); released via _releaseInstrumentHandles.
                var device = pool.create(basePath + i);
                if (!device || device.id === INVALID_LIVE_API_ID) {
                    pool.release(device);
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
        scratch = pool.release(scratch);
    }

    return null;
};

// ===== INSTRUMENT STRATEGY PATTERN =====

/**
 * InstrumentStrategy - Base class for instrument-specific pitch handling.
 */
function InstrumentStrategy(device, pool) {
    this.device = device;
    this.pool = pool || null;
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
    if (this.pool) this.pool.release(this.device);
    this.device = null;
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
 * @param {HandlePool} pool - Pool owning device/transposeParam
 */
function TransposeStrategy(device, transposeParam, shiftAmount, paramName, cachedBaseline, pool) {
    InstrumentStrategy.call(this, device, pool);
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
    // The value the param should currently hold because we put it there, or
    // null if we have never written. Two jobs: it lets reconcileBaseline() tell
    // an unchanged param apart from a user knob move, and it makes the
    // re-baseline delta-based, which stays correct even when a shifted write
    // was clamped at a param rail.
    //
    // Seeded from cachedBaseline on a rebuilt strategy: the outgoing strategy
    // was reverted before this one was built, so the baseline is also what the
    // param should read right now.
    this._lastWritten = (this.originalTranspose === null) ? null : this.originalTranspose;
    // Guards the one reconcile where the param may still be showing the
    // OUTGOING strategy's shift because Live hasn't propagated its revert yet.
    // See reconcileBaseline. ADR-014.
    this._firstReconcile = true;
    // Set by the device: called with the new baseline whenever this strategy
    // adopts one, so the device-level baseline cache follows along.
    this.onBaselineChanged = null;
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

        // Read what is ACTUALLY on the param before writing over it, and fold
        // any user edit into the baseline. This is the whole fix for "the knob
        // I set gets thrown away": the baseline captured at instrument
        // detection goes stale the moment the user touches the knob, and
        // shifting from a stale baseline discards their edit on the first step.
        //
        // Deliberately a read-before-write and NOT a `value` observer on the
        // param. An observer would notice the edit sooner, but nothing acts on
        // a new baseline until the next write anyway, so it would buy no
        // behavior — while binding a listener inside the instrument's subtree,
        // which is the exact shape ADR-013 removed after it flooded Live with
        // `_path_listener_callback` errors during rack loads.
        //
        // Costs one get() per pitch on/off transition (not per tick — the
        // caller only reaches here when the step value actually changes).
        var liveValue = this.transposeParam.get("value");
        if (liveValue && liveValue[0] !== undefined) {
            this.reconcileBaseline(liveValue[0]);
        }

        // Fallback if the read above failed: capture once, avoiding IPC later
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
        // Record the write BEFORE issuing it: Live may dispatch the resulting
        // value-changed notification synchronously, and a value observer that
        // fires before _lastWritten is updated would read our own write as a
        // user edit and re-baseline to the shifted value. Roll back on throw so
        // "_lastWritten is what is actually on the param" always holds.
        var previousWritten = this._lastWritten;
        this._lastWritten = newValue;
        try {
            this.transposeParam.set("value", newValue);
        } catch (writeError) {
            this._lastWritten = previousWritten;
            throw writeError;
        }
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

/**
 * Fold the param's actual current value into the baseline, telling our own
 * last write (ignored) apart from a user knob move, automation, or undo
 * (adopted as the new home position).
 *
 * Called from applyTranspose immediately before it writes, so the write always
 * proceeds from what the user last left on the knob. Pure JS bookkeeping — no
 * Live API calls.
 *
 * @param {number} value - The value currently on the param
 */
TransposeStrategy.prototype.reconcileBaseline = function(value) {
    if (typeof value !== 'number' || !isFinite(value)) return;

    var wasFirst = this._firstReconcile;
    this._firstReconcile = false;

    // Unchanged since our own last write — nobody has touched it.
    if (this._lastWritten !== null &&
        Math.abs(value - this._lastWritten) <= PARAM_WRITE_EPSILON) {
        return;
    }

    // ADR-014's race, in the one window where it can still bite. A strategy
    // rebuilt by the `devices` observer is born unshifted, with _lastWritten
    // seeded to the baseline the outgoing strategy was just reverted to. If
    // Live hasn't propagated that revert yet, the param still reads exactly
    // baseline + shiftAmount — OUR value, not the user's. Adopting it would
    // make the next shift compound (+12 becomes +24), which is the bug ADR-014
    // exists to prevent. Ignore it and write the baseline, which re-issues the
    // revert as a side effect. Only the FIRST reconcile of a strategy can be
    // stale this way, so the guard costs nothing after that; the price is that
    // a user who parks the knob at exactly one shift above the baseline before
    // the first step-on has that particular edit ignored.
    if (wasFirst && !this.hasShifted && this._lastWritten !== null &&
        Math.abs(value - (this._lastWritten + this.shiftAmount)) <= PARAM_WRITE_EPSILON) {
        debug("transpose", "ignoring un-propagated revert: param still reads " + value);
        return;
    }

    if (this.hasShifted && this._lastWritten !== null) {
        // The user moved the knob while we were holding it shifted, so they are
        // adjusting what they hear right now. The same delta moves the home
        // position, which keeps the sequencer's shift a constant offset from
        // wherever the user puts the knob. Using the delta rather than
        // (value - shiftAmount) stays correct if our shifted write was clamped.
        this.originalTranspose = Math.max(this.paramMin, Math.min(this.paramMax,
            this.originalTranspose + (value - this._lastWritten)));
        debug("transpose", "external edit while shifted -> baseline " + this.originalTranspose);
    } else {
        // Not shifted: the param IS the home position, whatever it now reads.
        this.originalTranspose = value;
        debug("transpose", "external edit while unshifted -> baseline " + value);
    }

    this._lastWritten = value;
    this._notifyBaselineChanged();
};

/**
 * Tell the device a new baseline was adopted, so its per-device baseline cache
 * doesn't re-seed a rebuilt strategy with the stale value.
 */
TransposeStrategy.prototype._notifyBaselineChanged = function() {
    if (typeof this.onBaselineChanged === 'function') {
        try {
            this.onBaselineChanged(this.originalTranspose);
        } catch (e) {
            handleError("TransposeStrategy._notifyBaselineChanged", e, false);
        }
    }
};

TransposeStrategy.prototype.release = function() {
    this.onBaselineChanged = null;
    if (this.pool) this.pool.release(this.transposeParam);
    this.transposeParam = null;
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
 * @param {HandlePool} pool - Pool owning the re-pointed parameter handle
 */
function MuteStrategy(device, paramIndex, mutedValue, playingValue, pool) {
    InstrumentStrategy.call(this, device, pool);
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
        if (!this.pool) return;
        this._paramHandle = this.pool.repoint(
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
    if (this.pool) this.pool.release(this._paramHandle);
    this._paramHandle = null;
    InstrumentStrategy.prototype.release.call(this);
};

MuteStrategy.prototype.revertMute = function() {
    this.applyMute(false);
};

/**
 * DefaultInstrumentStrategy - Default (no device-based transpose or mute).
 */
function DefaultInstrumentStrategy() {
    InstrumentStrategy.call(this, null, null);
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
