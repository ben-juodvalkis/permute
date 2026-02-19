/**
 * permute-temperature.js - Temperature transformation mixin
 *
 * Temperature methods that are applied to SequencerDevice.prototype.
 * Uses a mixin pattern since these methods operate on the device instance.
 *
 * @requires permute-constants
 * @requires permute-utils
 * @requires permute-shuffle
 */

var constants = require('permute-constants');
var OCTAVE_SEMITONES = constants.OCTAVE_SEMITONES;

var utils = require('permute-utils');
var debug = utils.debug;
var handleError = utils.handleError;
var parseNotesResponse = utils.parseNotesResponse;
var createObserver = utils.createObserver;
var defer = utils.defer;

var shuffle = require('permute-shuffle');
var generateSwapPattern = shuffle.generateSwapPattern;
var applySwapPattern = shuffle.applySwapPattern;

/**
 * Apply temperature methods to a prototype (mixin pattern).
 * @param {Object} proto - The prototype to extend (SequencerDevice.prototype)
 */
function applyTemperatureMethods(proto) {

    /**
     * Get the current pitch offset for a clip based on pitch sequencer state.
     * Consolidates the duplicated pitch offset calculation used in capture, restore,
     * and loop jump operations.
     *
     * Returns OCTAVE_SEMITONES if pitch sequencer is currently shifting notes and
     * using note-based transpose (not parameter-based). Returns 0 otherwise.
     *
     * @param {string} clipId - Clip ID to check
     * @returns {number} - Pitch offset (0 or OCTAVE_SEMITONES)
     */
    proto._getCurrentPitchOffset = function(clipId) {
        if (this.lastValues[clipId] && this.lastValues[clipId].pitch === 1
            && this.instrumentType !== 'parameter_transpose') {
            return OCTAVE_SEMITONES;
        }
        return 0;
    };

    /**
     * Setup temperature loop_jump observer.
     * Regenerates swap pattern on each loop.
     */
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
     * V4.2: Extracted from temperature() function for use by OSC command handlers.
     *
     * Handles three transition types:
     *   0 -> >0: Enable (capture original state)
     *   >0 -> 0: Disable (restore original state)
     *   >0 -> >0: Update (just change the value)
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

        var pitchWasOn = this.lastValues[clipId] && this.lastValues[clipId].pitch === 1;

        // Build originalPitches map: noteId -> base pitch
        var originalPitches = {};
        for (var i = 0; i < notes.notes.length; i++) {
            var note = notes.notes[i];
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
        var pitchAdjustment = this._getCurrentPitchOffset(clipId);

        // Restore each note's pitch from the map
        var changed = false;
        var restoredCount = 0;
        var skippedCount = 0;

        for (var i = 0; i < notes.notes.length; i++) {
            var note = notes.notes[i];
            var originalPitch = state.originalPitches[note.note_id];

            if (originalPitch !== undefined) {
                note.pitch = originalPitch + pitchAdjustment;
                changed = true;
                restoredCount++;
            } else {
                skippedCount++;
            }
        }

        // Apply modifications if any changes were made
        if (changed) {
            try {
                clip.call("apply_note_modifications", notes);
                debug("restoreTemperatureState", "Restored " + restoredCount + " notes, skipped " + skippedCount + " (overdubs)");
            } catch (err) {
                handleError("restoreTemperatureState", err, false);
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
     * - temp = 0.1: few swaps from original each loop
     * - temp = 0.9: many swaps from original each loop
     *
     * Each loop is random but always based on the original pitches,
     * not cumulative scrambling on top of previous scrambles.
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
        } catch (err) {
            handleError("onTemperatureLoopJump", err, false);
        }
    };
}

module.exports = {
    applyTemperatureMethods: applyTemperatureMethods
};
