/**
 * permute-state.js - State management objects
 *
 * Encapsulates track, clip, and transport state for the sequencer device.
 */

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

module.exports = {
    TrackState: TrackState,
    ClipState: ClipState,
    TransportState: TransportState
};
