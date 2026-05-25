/**
 * permute-temperature.js - Temperature transformation mixin for SequencerDevice
 *
 * Applied as a mixin to SequencerDevice.prototype.
 * Depends on: permute-constants, permute-utils, permute-shuffle
 *
 * Model (ADR 015): the user's composition is the source of truth, held in an
 * in-memory base model per clip. Temperature is a pure function of the base
 * model: displayed = applySwap(baseModel, temp). The scrambled clip is NEVER
 * read back as truth. Return-to-0 rewrites the base model verbatim.
 *
 * User edits while temperature is hot are detected by a content diff: after
 * every write we record the exact pitches we wrote (`expected`). A notes-changed
 * notification whose contents differ from `expected` (added/removed/repitched
 * notes) means the user changed the clip -> we re-baseline to current notes.
 * This makes correctness independent of callback ordering.
 */

var constants = require('permute-constants');
var utils = require('permute-utils');
var shuffle = require('permute-shuffle');

var OCTAVE_SEMITONES = constants.OCTAVE_SEMITONES;
var debug = utils.debug;
var handleError = utils.handleError;
var parseNotesResponse = utils.parseNotesResponse;
var createObserver = utils.createObserver;
var defer = utils.defer;
var generateSwapPattern = shuffle.generateSwapPattern;
var applySwapPattern = shuffle.applySwapPattern;

// Note fields preserved in the base model so return-to-0 restores the full
// note, not just pitch.
var BASE_MODEL_FIELDS = [
    'pitch', 'start_time', 'duration', 'velocity', 'mute',
    'probability', 'velocity_deviation', 'release_velocity'
];

/**
 * Apply temperature methods to SequencerDevice.prototype.
 *
 * @param {Object} proto - SequencerDevice.prototype
 */
function applyTemperatureMethods(proto) {

    /**
     * Get current pitch offset for temperature calculations.
     *
     * Returns the semitone offset currently applied by the pitch sequencer via
     * note modification. Returns 0 if pitch sequencer is off or if using
     * parameter-based transpose (where notes aren't directly shifted).
     *
     * @param {string} clipId - Clip ID to check pitch state for
     * @returns {number} - Current pitch offset in semitones (0 or OCTAVE_SEMITONES)
     */
    proto._getCurrentPitchOffset = function(clipId) {
        if (this.lastValues[clipId] && this.lastValues[clipId].pitch === 1
            && this.instrumentType !== 'parameter_transpose') {
            return OCTAVE_SEMITONES;
        }
        return 0;
    };

    // ===== OBSERVERS =====

    proto.setupTemperatureLoopJumpObserver = function() {
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

    proto.clearTemperatureLoopJumpObserver = function() {
        this.observerRegistry.unregister('temperature_loop_jump');
        this.temperatureLoopJumpObserver = null;
    };

    /**
     * Observe the clip's notes so user edits made while temperature is hot can
     * be detected and folded into the base model (re-baseline). Live fires the
     * "notes" notification for our own writes too; the content diff in
     * onTemperatureNotesChanged distinguishes them.
     */
    proto.setupTemperatureNotesObserver = function() {
        this.clearTemperatureNotesObserver();

        var clip = this.getCurrentClip();
        if (!clip) return;

        var self = this;

        this.temperatureNotesObserver = createObserver(
            clip.path,
            "notes",
            function(args) {
                defer(function() {
                    self.onTemperatureNotesChanged();
                });
            }
        );

        this.observerRegistry.register('temperature_notes', this.temperatureNotesObserver);
    };

    proto.clearTemperatureNotesObserver = function() {
        this.observerRegistry.unregister('temperature_notes');
        this.temperatureNotesObserver = null;
    };

    // ===== BASE MODEL HELPERS =====

    /**
     * Build a base model (noteId -> full note dict) from a notes array.
     * Pitches are stored as TRUE base pitch (pitch sequencer shift removed).
     *
     * @param {Array} notes - notes from get_all_notes_extended
     * @param {number} pitchShift - current pitch sequencer offset to subtract
     * @returns {Object} - baseModel keyed by note_id
     */
    proto._buildBaseModel = function(notes, pitchShift) {
        var baseModel = {};
        for (var i = 0; i < notes.length; i++) {
            var note = notes[i];
            var entry = {};
            for (var f = 0; f < BASE_MODEL_FIELDS.length; f++) {
                var field = BASE_MODEL_FIELDS[f];
                if (note[field] !== undefined) entry[field] = note[field];
            }
            // Store TRUE base pitch (before any pitch sequencer shift)
            entry.pitch = note.pitch - pitchShift;
            entry.note_id = note.note_id;
            baseModel[note.note_id] = entry;
        }
        return baseModel;
    };

    /**
     * Read current clip notes. Returns parsed {notes:[...]} or null.
     */
    proto._readClipNotes = function(clip) {
        var notesJson = clip.call("get_all_notes_extended");
        return parseNotesResponse(notesJson);
    };

    /**
     * Record the pitches we just wrote so the notes observer can recognise our
     * own write and not mistake it for a user edit.
     *
     * @param {Array} notes - notes as written to the clip
     * @param {string} clipId
     */
    proto._recordExpected = function(notes, clipId) {
        var state = this.temperatureState[clipId];
        if (!state) return;
        var expected = {};
        for (var i = 0; i < notes.length; i++) {
            expected[notes[i].note_id] = notes[i].pitch;
        }
        state.expected = expected;
    };

    /**
     * Decide whether the current clip notes are an external (user) change vs.
     * our own last write. Returns true if the user changed the clip.
     *
     * A swap only permutes pitches among existing note ids. So:
     *   - a different id-set (add/remove)      -> user change
     *   - a note repitched away from expected  -> user change
     *   - exact match to expected              -> our own write
     *
     * @param {Array} notes - current clip notes
     * @param {Object} expected - { noteId: pitch } we last wrote
     * @returns {boolean}
     */
    proto._isExternalChange = function(notes, expected) {
        if (!expected) return true;

        // id-set size differs -> add/remove
        var expectedCount = 0;
        for (var k in expected) {
            if (expected.hasOwnProperty(k)) expectedCount++;
        }
        if (notes.length !== expectedCount) return true;

        for (var i = 0; i < notes.length; i++) {
            var note = notes[i];
            if (!expected.hasOwnProperty(note.note_id)) {
                return true; // unknown id -> added (and something removed)
            }
            if (expected[note.note_id] !== note.pitch) {
                return true; // existing note repitched by the user
            }
        }
        return false;
    };

    // ===== TEMPERATURE VALUE / TRANSITIONS =====

    /**
     * Set temperature value with state transitions.
     * 0->active: capture base model + start observers + apply first variation.
     * active->0: restore base model verbatim + stop observers.
     *
     * @param {number} value - Temperature value (0.0-1.0)
     */
    proto.setTemperatureValue = function(value) {
        var newTemperatureValue = Math.max(0.0, Math.min(1.0, parseFloat(value)));

        var wasActive = this.temperatureValue > 0;
        var willBeActive = newTemperatureValue > 0;

        var clip = this.getCurrentClip();
        var clipId = clip ? clip.id : null;

        // Update value first so writes derive from the new temperature.
        this.temperatureValue = newTemperatureValue;
        this.temperatureActive = willBeActive;

        if (!wasActive && willBeActive) {
            // 0 -> >0 (enable)
            if (clipId) {
                this.captureBaseModel(clipId);
                this.setupTemperatureLoopJumpObserver();
                this.setupTemperatureNotesObserver();
                // Apply an immediate variation so the effect is audible without
                // waiting for the first loop jump.
                this.applyTemperatureVariation(clipId);
            }
            debug("temperature", "Enabled: captured base model");
        } else if (wasActive && !willBeActive) {
            // >0 -> 0 (disable): restore the base model verbatim.
            this.clearTemperatureLoopJumpObserver();
            this.clearTemperatureNotesObserver();
            if (clipId) {
                this.restoreBaseModel(clipId);
            }
            debug("temperature", "Disabled: restored base model");
        }

        debug("temperature", "Set temperature to " + newTemperatureValue);
    };

    /**
     * Capture the base model (true original) for a clip. Called once when
     * temperature goes hot, on transport start if missing, and on clip change.
     * Never overwrites an existing base model except via re-baseline.
     *
     * @param {string} clipId
     */
    proto.captureBaseModel = function(clipId) {
        // Self-enforce the no-overwrite contract. Re-baseline assigns
        // temperatureState directly; capture must never clobber an existing
        // base model, even if a future caller forgets to guard.
        if (this.temperatureState[clipId]) {
            debug("captureBaseModel", "Base model already exists for " + clipId + ", skipping");
            return;
        }

        var clip = this.getCurrentClip();
        if (!clip || clip.id !== clipId) {
            debug("captureBaseModel", "Clip unavailable or ID mismatch");
            return;
        }

        var notes = this._readClipNotes(clip);
        if (!notes || !notes.notes || notes.notes.length === 0) {
            debug("captureBaseModel", "No notes to capture");
            return;
        }

        var pitchShift = this._getCurrentPitchOffset(clipId);
        var baseModel = this._buildBaseModel(notes.notes, pitchShift);

        this.temperatureState[clipId] = {
            baseModel: baseModel,
            expected: null
        };

        debug("captureBaseModel", "Captured " + notes.notes.length + " notes for clip " + clipId);
    };

    /**
     * Restore base-model pitches to the clip (pitch only — the swap only ever
     * changes pitch, so other fields are already at their base values), then
     * clear temperature state. Notes known in the base model are set to
     * base.pitch + current pitch-sequencer offset. Overdubbed notes not yet
     * folded in via re-baseline are left at their current clip pitch (which,
     * thanks to applyTemperatureVariation never swapping non-base notes, is the
     * pitch the user recorded — not a scramble).
     *
     * @param {string} clipId
     */
    proto.restoreBaseModel = function(clipId) {
        var state = this.temperatureState[clipId];
        if (!state) {
            debug("restoreBaseModel", "No state to restore for clip " + clipId);
            return;
        }

        var clip = this.getCurrentClip();
        if (!clip || clip.id !== clipId) {
            debug("restoreBaseModel", "Clip unavailable or ID mismatch");
            delete this.temperatureState[clipId];
            return;
        }

        var notes = this._readClipNotes(clip);
        if (!notes || !notes.notes) {
            delete this.temperatureState[clipId];
            return;
        }

        var pitchAdjustment = this._getCurrentPitchOffset(clipId);

        var changed = false;
        for (var i = 0; i < notes.notes.length; i++) {
            var note = notes.notes[i];
            var base = state.baseModel[note.note_id];
            if (base) {
                note.pitch = base.pitch + pitchAdjustment;
                changed = true;
            }
            // Notes not in the base model are user overdubs that were not yet
            // re-baselined; leave them untouched.
        }

        if (changed) {
            try {
                clip.call("apply_note_modifications", notes);
            } catch (error) {
                handleError("restoreBaseModel", error, false);
            }
        }

        delete this.temperatureState[clipId];
    };

    // ===== VARIATION =====

    /**
     * Apply a fresh variation derived from the base model.
     * Always: load base pitches (+ current pitch shift) -> new swap -> write.
     * Records `expected` so the notes observer recognises this write.
     *
     * @param {string} clipId
     */
    proto.applyTemperatureVariation = function(clipId) {
        if (!this.temperatureActive || this.temperatureValue <= 0) return;

        var clip = this.getCurrentClip();
        if (!clip || clip.id !== clipId) return;

        var state = this.temperatureState[clipId];
        if (!state) {
            debug("applyTemperatureVariation", "No base model for clip " + clipId);
            return;
        }

        var notes = this._readClipNotes(clip);
        if (!notes || !notes.notes) return;

        var pitchAdjustment = this._getCurrentPitchOffset(clipId);

        // 1. Reset every known note to its base pitch (+ current pitch shift),
        //    and collect only base-model notes as the swap pool. Notes absent
        //    from the base model are overdubs not yet re-baselined: we must
        //    NEVER swap them, otherwise returning to 0 before the notes observer
        //    fires would leave them at a scrambled pitch (restoreBaseModel only
        //    restores base-model notes). Excluding them keeps their pitch stable
        //    until a re-baseline folds them in.
        var baseNotes = [];
        for (var i = 0; i < notes.notes.length; i++) {
            var note = notes.notes[i];
            var base = state.baseModel[note.note_id];
            if (base) {
                note.pitch = base.pitch + pitchAdjustment;
                baseNotes.push(note);
            }
        }

        // 2. Generate a new swap pattern from the (now base) pitches.
        this.temperatureSwapPattern = generateSwapPattern(
            baseNotes,
            this.temperatureValue
        );

        // 3. Apply the swap to the base-note subset (references into notes.notes,
        //    so the mutations propagate to the full array we write below).
        applySwapPattern(baseNotes, this.temperatureSwapPattern);

        // 4. Record expected BEFORE writing. apply_note_modifications queues a
        //    "notes" notification synchronously; recording after the write would
        //    race that notification and our own write could be misread as a user
        //    edit. Setting expected first makes the diff correct regardless of
        //    notification timing. Record over the full written set so overdub
        //    pitches are part of `expected` and don't read as external changes.
        this._recordExpected(notes.notes, clipId);

        // 5. Write.
        try {
            clip.call("apply_note_modifications", notes);
            debug("temperature", "Applied variation from base model (" +
                this.temperatureSwapPattern.length + " groups)");
        } catch (error) {
            handleError("applyTemperatureVariation", error, false);
        }
    };

    /**
     * Loop jump -> apply a fresh variation from the base model.
     */
    proto.onTemperatureLoopJump = function() {
        if (!this.temperatureActive || this.temperatureValue <= 0) return;
        var clip = this.getCurrentClip();
        if (!clip) return;
        this.applyTemperatureVariation(clip.id);
    };

    /**
     * Notes-changed -> distinguish our own write from a user edit.
     * On a user edit, re-baseline: the current notes become the new base model,
     * accepting that the prior original is intentionally superseded.
     */
    proto.onTemperatureNotesChanged = function() {
        if (!this.temperatureActive || this.temperatureValue <= 0) return;

        var clip = this.getCurrentClip();
        if (!clip) return;

        var clipId = clip.id;
        var state = this.temperatureState[clipId];
        if (!state) return;

        var notes = this._readClipNotes(clip);
        if (!notes || !notes.notes) return;

        if (!this._isExternalChange(notes.notes, state.expected)) {
            return; // our own swap write; ignore
        }

        // User edited the clip while hot. The edited notes currently include
        // our last swap, so first undo the swap on known notes to recover the
        // user's intended base pitches, then re-baseline to that.
        var pitchShift = this._getCurrentPitchOffset(clipId);

        // Re-baseline directly from current notes. New/edited notes define the
        // new composition; we cannot un-swap notes we don't recognise, and
        // recognised notes that the user did NOT touch still hold our swap, so
        // we reverse our last swap on them before snapshotting.
        // NOTE: _reverseExpectedSwap mutates only the in-memory notes array so
        // the _buildBaseModel below captures the user's intended composition,
        // not our scramble. It does NOT write to the clip; the write is done by
        // applyTemperatureVariation at the end of this function.
        this._reverseExpectedSwap(notes.notes, state, pitchShift);

        this.temperatureState[clipId] = {
            baseModel: this._buildBaseModel(notes.notes, pitchShift),
            expected: null
        };

        debug("temperature", "Re-baselined from user edit (" +
            notes.notes.length + " notes)");

        // Immediately apply a fresh variation from the new base so playback
        // stays hot and consistent.
        this.applyTemperatureVariation(clipId);
    };

    /**
     * Reverse our last swap on notes that still match `expected`, restoring
     * them to their base pitch, so the re-baseline snapshot reflects the user's
     * composition rather than our scramble. Notes the user touched (pitch !=
     * expected, or unknown id) are left as-is — that's their new intent.
     *
     * @param {Array} notes - current clip notes (mutated in place)
     * @param {Object} state - temperatureState entry with baseModel + expected
     * @param {number} pitchShift - current pitch sequencer offset
     */
    proto._reverseExpectedSwap = function(notes, state, pitchShift) {
        if (!state.expected || !state.baseModel) return;
        for (var i = 0; i < notes.length; i++) {
            var note = notes[i];
            var expectedPitch = state.expected[note.note_id];
            var base = state.baseModel[note.note_id];
            // Only revert notes that are exactly where our swap left them AND
            // that we have a base pitch for. A user-edited note (pitch differs
            // from expected) is preserved as the new intent.
            if (base && expectedPitch !== undefined && note.pitch === expectedPitch) {
                note.pitch = base.pitch + pitchShift;
            }
        }
    };
}

module.exports = {
    applyTemperatureMethods: applyTemperatureMethods
};
