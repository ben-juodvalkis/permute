/**
 * permute-chance.js - Note chance (probability) mixin for SequencerDevice
 *
 * Sets note.probability on all notes in the current clip.
 * Applied as a mixin to SequencerDevice.prototype.
 * Depends on: permute-utils
 */

var utils = require('permute-utils');

var debug = utils.debug;
var handleError = utils.handleError;
var parseNotesResponse = utils.parseNotesResponse;

/**
 * Apply chance methods to SequencerDevice.prototype.
 * This mixin pattern keeps chance logic in a separate file
 * while attaching methods to the main device class.
 *
 * @param {Object} proto - SequencerDevice.prototype
 */
function applyChanceMethods(proto) {

    /**
     * Set chance value and apply to current clip.
     *
     * @param {number} value - Chance value (0.0-1.0), where 1.0 = always play
     */
    proto.setChanceValue = function(value) {
        var newValue = Math.max(0.0, Math.min(1.0, parseFloat(value)));

        // Skip if unchanged
        if (newValue === this.chanceValue) return;

        this.chanceValue = newValue;

        // Activate playback observers if chance becomes non-default.
        // Needed so onTransportStop can restore probability to 1.0.
        if (newValue < 1.0) {
            this.checkAndActivateObservers();
        }

        // Apply to current clip immediately
        this.applyChanceToClip();

        debug("chance", "Set chance to " + newValue);
    };

    /**
     * Apply current chance value to all notes in the current clip.
     * Only applies to MIDI clips (audio clips have no notes).
     */
    proto.applyChanceToClip = function() {
        if (this.trackState.type !== 'midi') return;

        var clip = this.getCurrentClip();
        if (!clip) return;

        try {
            var notesJson = clip.call("get_all_notes_extended");
            var notes = parseNotesResponse(notesJson);
            if (!notes || !notes.notes || notes.notes.length === 0) return;

            for (var i = 0; i < notes.notes.length; i++) {
                notes.notes[i].probability = this.chanceValue;
            }

            clip.call("apply_note_modifications", notes);
            debug("chance", "Applied probability " + this.chanceValue + " to " + notes.notes.length + " notes");
        } catch (error) {
            handleError("applyChanceToClip", error, false);
        }
    };

    /**
     * Restore note probability to 1.0 (always play) for the current clip.
     * Called on transport stop to undo chance modifications.
     */
    proto.restoreChance = function() {
        if (this.trackState.type !== 'midi') return;
        if (this.chanceValue >= 1.0) return; // Nothing to restore

        var clip = this.getCurrentClip();
        if (!clip) return;

        try {
            var notesJson = clip.call("get_all_notes_extended");
            var notes = parseNotesResponse(notesJson);
            if (!notes || !notes.notes || notes.notes.length === 0) return;

            for (var i = 0; i < notes.notes.length; i++) {
                notes.notes[i].probability = 1.0;
            }

            clip.call("apply_note_modifications", notes);
            debug("chance", "Restored probability to 1.0 for " + notes.notes.length + " notes");
        } catch (error) {
            handleError("restoreChance", error, false);
        }
    };

    /**
     * Send chance value to Max UI (outlet 0).
     * Called when chance changes from OSC or on init/setState.
     */
    proto.sendChanceState = function() {
        outlet(0, "chance", this.chanceValue);
    };
}

module.exports = {
    applyChanceMethods: applyChanceMethods
};
