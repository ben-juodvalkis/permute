/**
 * permute-temperature.js - Temperature transformation mixin for SequencerDevice
 *
 * Applied as a mixin to SequencerDevice.prototype.
 * Depends on: permute-constants, permute-utils, permute-shuffle
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

/**
 * Apply temperature methods to SequencerDevice.prototype.
 * This mixin pattern keeps temperature logic in a separate file
 * while attaching methods to the main device class.
 *
 * @param {Object} proto - SequencerDevice.prototype
 */
function applyTemperatureMethods(proto) {

    /**
     * Get current pitch offset for temperature calculations.
     * Consolidates the duplicated pitch offset logic from capture, restore, and loop jump.
     *
     * Returns the semitone offset currently applied by the pitch sequencer via note modification.
     * Returns 0 if pitch sequencer is off or if using parameter-based transpose (where notes
     * aren't directly shifted).
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

    /**
     * Clear temperature loop_jump observer.
     */
    proto.clearTemperatureLoopJumpObserver = function() {
        this.observerRegistry.unregister('temperature_loop_jump');
        this.temperatureLoopJumpObserver = null;
    };

    /**
     * Set temperature value with state transitions.
     * Handles 0->active and active->0 transitions (capture/restore).
     *
     * @param {number} value - Temperature value (0.0-1.0)
     */
    proto.setTemperatureValue = function(value) {
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

        // Setup or clear loop jump observer only on actual transitions
        if (!wasActive && willBeActive) {
            this.setupTemperatureLoopJumpObserver();
        } else if (wasActive && !willBeActive) {
            this.clearTemperatureLoopJumpObserver();
        }

        debug("temperature", "Set temperature to " + newTemperatureValue);
    };

    /**
     * Capture original pitches by note ID for temperature transformation.
     * Called when temperature transitions from 0 to >0.
     * Handles overdubbing (new notes not in map) and note deletion (IDs skipped).
     *
     * @param {string} clipId - Clip ID to capture state for
     */
    proto.captureTemperatureState = function(clipId) {
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

        // Calculate offset to get TRUE base pitch (before pitch sequencer shift)
        // If pitch is on, notes are currently shifted +12, so subtract to get base
        var pitchOffset = -this._getCurrentPitchOffset(clipId);

        // Build originalPitches map: noteId -> base pitch
        var originalPitches = {};
        for (var i = 0; i < notes.notes.length; i++) {
            var note = notes.notes[i];
            // Store the TRUE base pitch (accounting for any pitch sequencer shift)
            originalPitches[note.note_id] = note.pitch + pitchOffset;
        }

        // Store state
        this.temperatureState[clipId] = {
            originalPitches: originalPitches
        };

        debug("captureTemperatureState", "Captured " + notes.notes.length + " notes for clip " + clipId, {
            sampleNoteIds: Object.keys(originalPitches).slice(0, 3)
        });
    };

    /**
     * Restore original pitches from note ID map.
     * Called when temperature transitions from >0 to 0.
     * Overdubbed notes (not in map) keep their current pitch.
     *
     * @param {string} clipId - Clip ID to restore state for
     */
    proto.restoreTemperatureState = function(clipId) {
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

        // Calculate pitch adjustment based on current pitch sequencer state
        // If pitch is currently on, we need to add the shift to the base pitch
        var pitchAdjustment = this._getCurrentPitchOffset(clipId);

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
     * Restores to original pitches first, then applies fresh random shuffle.
     * Each loop shuffles from the original—no cumulative scrambling.
     */
    proto.onTemperatureLoopJump = function() {
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
        var pitchAdjustment = this._getCurrentPitchOffset(clipId);

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
}

module.exports = {
    applyTemperatureMethods: applyTemperatureMethods
};
