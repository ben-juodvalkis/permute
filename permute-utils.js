/**
 * permute-utils.js - Utility functions
 *
 * Depends on: permute-constants
 */

var constants = require('permute-constants');
var TICKS_PER_QUARTER_NOTE = constants.TICKS_PER_QUARTER_NOTE;
var DEFAULT_TIME_SIGNATURE = constants.DEFAULT_TIME_SIGNATURE;
var INVALID_LIVE_API_ID = constants.INVALID_LIVE_API_ID;
var TASK_SCHEDULE_DELAY = constants.TASK_SCHEDULE_DELAY;

var DEBUG_MODE = false; // Set to true for development

/**
 * Debug logging utility.
 * Only logs when DEBUG_MODE is enabled.
 *
 * @param {string} context - Context/location of the log
 * @param {string} message - Message to log
 * @param {*} data - Optional data to include
 */
function debug(context, message, data) {
    if (DEBUG_MODE) {
        var output = "[Sequencer DEBUG:" + context + "] " + message;
        if (data !== undefined) {
            output += " | Data: " + JSON.stringify(data);
        }
        post(output + "\n");
    }
}

/**
 * Handle errors consistently throughout the device.
 * Logs errors to the Max console based on DEBUG_MODE and criticality.
 *
 * @param {string} context - Where the error occurred (e.g., "parseNotesResponse", "init")
 * @param {Error|string} error - The error that occurred
 * @param {boolean} isCritical - If true, always log; if false, only log in DEBUG_MODE
 */
function handleError(context, error, isCritical) {
    if (DEBUG_MODE || isCritical) {
        var errorMsg = error.toString ? error.toString() : String(error);
        post("[Sequencer ERROR:" + context + "] " + errorMsg + "\n");
    }
}

/**
 * Parse notes response from Live API call.
 * Handles both string JSON format and array format.
 *
 * @param {*} notesJson - Response from get_all_notes_extended
 * @returns {Object|null} - Parsed notes object with {notes: [...]} or null
 */
function parseNotesResponse(notesJson) {
    if (!notesJson) return null;

    if (typeof notesJson === "string") {
        try {
            var parsed = JSON.parse(notesJson);
            if (parsed && parsed.notes && Array.isArray(parsed.notes)) {
                return parsed;
            } else if (Array.isArray(parsed)) {
                return { notes: parsed };
            }
        } catch (error) {
            handleError("parseNotesResponse", error, false);
        }
    } else if (Array.isArray(notesJson)) {
        return { notes: notesJson };
    }

    return null;
}

/**
 * Get LiveAPI reference for a device parameter.
 *
 * @param {LiveAPI} device - Device LiveAPI object
 * @param {number} paramIndex - Parameter index
 * @returns {LiveAPI} - Parameter LiveAPI object
 */
function getDeviceParameter(device, paramIndex) {
    var paramPath = device.path + " parameters " + paramIndex;
    return new LiveAPI(paramPath);
}

/**
 * Find transpose parameter by scanning device parameters for known names.
 * Returns the first match based on priority order from config.
 * Case-insensitive exact match, scans up to 17 parameters (typical rack macro count).
 * Called once per device load, not per-step.
 *
 * @param {LiveAPI} device - Device to scan
 * @returns {Object|null} - { index, param, shiftAmount, name } or null if not found
 */
function findTransposeParameterByName(device) {
    if (!device || device.id === INVALID_LIVE_API_ID) return null;

    try {
        var nameConfig = constants.TRANSPOSE_CONFIG.parameterNames;
        if (!nameConfig || nameConfig.length === 0) return null;

        // Build lookup map (lowercase name -> config)
        var nameLookup = {};
        var priorityOrder = [];
        for (var i = 0; i < nameConfig.length; i++) {
            var entry = nameConfig[i];
            var lowerName = entry.name.toLowerCase();
            nameLookup[lowerName] = entry;
            priorityOrder.push(lowerName);
        }

        // Get parameter count - limit to 17 (typical rack macro count from constants.json)
        var params = device.get("parameters");
        if (!params) return null;
        var paramCount = Math.min(Math.floor(params.length / 2), 17);  // Live returns [id, id, id...]
        if (paramCount === 0) return null;

        // Scan parameters, collecting matches
        var matches = {};  // lowerName -> { index, param }
        for (var i = 0; i < paramCount; i++) {
            var param = getDeviceParameter(device, i);

            // Validate LiveAPI object before use
            if (!param || param.id === INVALID_LIVE_API_ID) continue;

            var nameResult = param.get("name");
            if (nameResult && nameResult[0]) {
                var paramName = nameResult[0].toLowerCase();
                if (nameLookup[paramName]) {
                    matches[paramName] = { index: i, param: param };
                }
            }
        }

        // Return highest priority match
        for (var i = 0; i < priorityOrder.length; i++) {
            var name = priorityOrder[i];
            if (matches[name]) {
                var config = nameLookup[name];
                debug("transpose", "Found '" + name + "' at param " + matches[name].index);
                return {
                    index: matches[name].index,
                    param: matches[name].param,
                    shiftAmount: config.shiftAmount,
                    name: name
                };
            }
        }

        return null;  // No matching parameter found
    } catch (error) {
        handleError("findTransposeParameterByName", error, false);
        return null;
    }
}

/**
 * Check if a device should use parameter-based transposition.
 * Only devices explicitly listed in TRANSPOSE_CONFIG.parameterTransposeDevices
 * are candidates for parameter transpose; all others default to note_transpose.
 *
 * @param {LiveAPI} device - Device to check
 * @returns {boolean}
 */
function isParameterTransposeDevice(device) {
    if (!device || device.id === INVALID_LIVE_API_ID) return false;
    try {
        var classNameResult = device.get("class_name");
        var className = classNameResult && classNameResult[0] ? classNameResult[0] : classNameResult;
        var list = constants.TRANSPOSE_CONFIG.parameterTransposeDevices;
        for (var i = 0; i < list.length; i++) {
            if (list[i] === className) return true;
        }
        return false;
    } catch (error) {
        handleError("isParameterTransposeDevice", error, false);
        return false;
    }
}

/**
 * Create and configure a LiveAPI observer.
 * Centralizes the observer creation pattern used throughout the device.
 *
 * @param {string} path - LiveAPI path to observe
 * @param {string} property - Property to observe
 * @param {Function} callback - Callback function to execute on property change
 * @returns {LiveAPI} - Configured LiveAPI observer
 */
function createObserver(path, property, callback) {
    var observer = new LiveAPI(callback);
    observer.path = path;
    observer.property = property;
    return observer;
}

/**
 * Helper for deferred execution to break out of observer context.
 * Live API calls from within observers must be deferred to avoid
 * "Changes cannot be triggered by notifications" errors.
 *
 * @param {Function} callback - Function to execute on next tick
 */
function defer(callback) {
    // Use Task to break observer context if available
    if (typeof Task !== 'undefined') {
        var t = new Task(callback, this);
        t.schedule(TASK_SCHEDULE_DELAY); // Schedule for next tick
    } else {
        // Fallback to setTimeout-like behavior
        callback.apply(this);
    }
}

/**
 * Calculate ticks per step from [bars, beats, ticks] division and time signature.
 * @param {Array} division - Division as [bars, beats, ticks]
 * @param {number} timeSignature - Time signature numerator
 * @returns {number} - Ticks per step
 */
function calculateTicksPerStep(division, timeSignature) {
    if (Array.isArray(division) && division.length === 3) {
        var bars = division[0];
        var beats = division[1];
        var ticks = division[2];
        var beatsPerBar = timeSignature || DEFAULT_TIME_SIGNATURE;
        return (bars * beatsPerBar * TICKS_PER_QUARTER_NOTE) +
               (beats * TICKS_PER_QUARTER_NOTE) +
               ticks;
    }
    return TICKS_PER_QUARTER_NOTE / 4; // Default to 16th notes
}

/**
 * Set DEBUG_MODE at runtime.
 * @param {boolean} enabled
 */
function setDebugMode(enabled) {
    DEBUG_MODE = enabled;
}

module.exports = {
    debug: debug,
    handleError: handleError,
    parseNotesResponse: parseNotesResponse,
    findTransposeParameterByName: findTransposeParameterByName,
    isParameterTransposeDevice: isParameterTransposeDevice,
    createObserver: createObserver,
    defer: defer,
    calculateTicksPerStep: calculateTicksPerStep,
    setDebugMode: setDebugMode
};
