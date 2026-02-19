/**
 * permute-shuffle.js - Pure shuffle/swap functions for temperature transformation
 *
 * Contains Fisher-Yates shuffle, swap pattern generation, and application.
 * These are pure functions with no device coupling, making them independently testable.
 *
 * @requires permute-constants
 */

var constants = require('permute-constants');

// Import debug from utils for logging
var utils = require('permute-utils');
var debug = utils.debug;

/**
 * Fisher-Yates shuffle algorithm.
 * Used by temperature transformation for random pitch swapping.
 *
 * @param {Array} array - Array to shuffle
 * @returns {Array} - Shuffled copy
 */
function fisherYatesShuffle(array) {
    var shuffled = array.slice();
    for (var i = shuffled.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = temp;
    }
    return shuffled;
}

/**
 * Generate swap pattern for temperature transformation.
 * Creates shuffle groups based on temperature value (0.0-1.0).
 *
 * Temperature ranges:
 *   0.0-0.33: Pairs only (2 notes)
 *   0.34-0.66: Mix of pairs and triplets (2-3 notes)
 *   0.67-1.0: Larger groups (2-5 notes)
 *
 * @param {Array} notes - Array of note objects with start_time and pitch
 * @param {number} temperature - Temperature value (0.0-1.0)
 * @returns {Array} - Array of shuffle groups {indices: [...], shuffled: [...]}
 */
function generateSwapPattern(notes, temperature) {
    if (!notes || notes.length < 2) {
        return [];
    }

    // Create array of indices and sort by start_time (temporal adjacency)
    var sortedIndices = [];
    for (var i = 0; i < notes.length; i++) {
        sortedIndices.push({
            originalIndex: i,
            startTime: notes[i].start_time,
            pitch: notes[i].pitch
        });
    }

    sortedIndices.sort(function(a, b) {
        return a.startTime - b.startTime;
    });

    // Create non-overlapping shuffle groups
    var groups = [];
    var used = [];
    for (var i = 0; i < sortedIndices.length; i++) {
        used.push(false);
    }

    // V3.1: Track if we've created at least one group
    var hasCreatedGroup = false;

    for (var i = 0; i < sortedIndices.length; i++) {
        if (used[i]) continue;

        // Should we form a group starting here?
        var roll = Math.random();

        // V3.1: Guarantee at least one swap when temp > 0
        // On last available pair, force creation if no groups yet
        var isLastChance = !hasCreatedGroup && (i >= sortedIndices.length - 2);
        var shouldFormGroup = (roll < temperature) || isLastChance;

        if (!shouldFormGroup) {
            continue;
        }

        // Determine group size based on temperature
        var desiredSize;
        if (temperature < 0.34) {
            desiredSize = 2;
        } else if (temperature < 0.67) {
            desiredSize = Math.random() < 0.6 ? 2 : 3;
        } else {
            var sizes = [2, 3, 4, 5];
            var weights = [0.2, 0.3, 0.3, 0.2];
            var roll2 = Math.random();
            var cumulative = 0;
            desiredSize = 3;
            for (var k = 0; k < sizes.length; k++) {
                cumulative += weights[k];
                if (roll2 < cumulative) {
                    desiredSize = sizes[k];
                    break;
                }
            }
        }

        // Collect adjacent unused notes
        var group = [];
        for (var j = i; j < Math.min(i + desiredSize, sortedIndices.length); j++) {
            if (!used[j]) {
                group.push(sortedIndices[j].originalIndex);
                used[j] = true;
            }
            if (group.length >= desiredSize) break;
        }

        // Need at least 2 notes to shuffle
        if (group.length >= 2) {
            var shuffledIndices = fisherYatesShuffle(group);
            groups.push({
                indices: group,
                shuffled: shuffledIndices
            });
            hasCreatedGroup = true;  // V3.1: Mark that we've created a group
        }
    }

    debug("temperature", "Generated " + groups.length + " shuffle groups (guaranteed min 1 when temp > 0)");
    return groups;
}

/**
 * Apply swap pattern to notes.
 * Swaps pitches according to the shuffle groups.
 *
 * @param {Array} notes - Array of note objects (will be modified in place)
 * @param {Array} swapPattern - Array of shuffle groups from generateSwapPattern
 */
function applySwapPattern(notes, swapPattern) {
    if (!notes || !swapPattern || swapPattern.length === 0) return;

    // Capture current pitches
    var currentPitches = [];
    for (var i = 0; i < notes.length; i++) {
        currentPitches.push(notes[i].pitch);
    }

    // Apply swaps
    for (var i = 0; i < swapPattern.length; i++) {
        var group = swapPattern[i];
        for (var j = 0; j < group.indices.length; j++) {
            var targetIdx = group.indices[j];
            var sourceIdx = group.shuffled[j];

            if (targetIdx < notes.length && sourceIdx < currentPitches.length) {
                notes[targetIdx].pitch = currentPitches[sourceIdx];
            } else {
                debug("applySwapPattern", "Invalid index: targetIdx=" + targetIdx +
                      ", sourceIdx=" + sourceIdx + ", noteCount=" + notes.length);
            }
        }
    }
}

module.exports = {
    fisherYatesShuffle: fisherYatesShuffle,
    generateSwapPattern: generateSwapPattern,
    applySwapPattern: applySwapPattern
};
