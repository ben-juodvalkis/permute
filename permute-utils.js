/**
 * permute-utils.js - Utility functions
 *
 * Depends on: permute-constants
 */

var constants = require('permute-constants');
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

// ===== LIVEAPI HANDLE LIFETIME =====
//
// INVARIANT
//   A LiveAPI object must never become garbage while it still holds a Live
//   path listener. Every handle Permute creates is either owned and reachable
//   (held by a HandlePool), or explicitly released — never merely dropped.
//
// WHY
//   Every LiveAPI object registers a path listener with Live, whether or not
//   an observer callback was passed. If V8 collects such an object, its weak
//   callback frees the underlying Max object, which sends an unobserve/detach
//   message into Live's LOM. Live answers synchronously by dispatching a
//   notification back into the v8 instance, which tries to invoke a JS
//   callback. Calling into JavaScript from inside a V8 GC weak callback is
//   illegal: V8 hits V8_Fatal and aborts the entire Live process.
//
//   The crash is intermittent because it needs a scavenge to land on a
//   released handle — it can take an hour of playing to go off.
//
// RULE
//   No bare `new LiveAPI(...)` anywhere outside this file. Check with:
//     grep -n "new LiveAPI" *.js | grep -v permute-utils.js
//   Any hit is a defect. See docs/adr/018-liveapi-handle-ownership.md.
//
// SCOPE
//   The pool is an INSTANCE, owned by the SequencerDevice and threaded to
//   everything that makes handles — deliberately not module-level state.
//   Permute is routinely loaded several times in one set (the crashing set had
//   three), and whether Max gives each `v8` object its own required-module
//   instance is not something to bet observation correctness on. With a
//   module-level pool, one device's teardown drain would hard-detach the other
//   devices' observers if that assumption were ever false: they would keep
//   sequencing while silently deaf to slot/transport changes. An instance pool
//   makes that structurally impossible instead of merely unlikely.

/**
 * Fully detach a LiveAPI object from Live's dispatcher.
 * Setting property alone only stops future notifications — path/id must also
 * be cleared so queued notifications against a stale path cannot fire
 * SendMessage errors into _path_listener_callback.
 *
 * This is the shared primitive: it is what makes a handle inert, and every
 * release path (observer unregister, pool drain, scoped borrow) goes through
 * it. Each step is individually guarded so an already-invalid handle can
 * never throw into a caller.
 *
 * @param {LiveAPI} obj
 */
function hardDetach(obj) {
    if (!obj) return;
    try { obj.property = ""; } catch (e) {}
    try { obj.path = ""; } catch (e) {}
    try { obj.id = 0; } catch (e) {}
}

/**
 * HandlePool - owns every LiveAPI handle one device creates.
 *
 * One pool per SequencerDevice, threaded to everything that makes handles.
 * The pool holds a strong reference to each live handle, so the GC only ever
 * sees objects that have already been made inert by hardDetach.
 */
function HandlePool() {
    this._handles = [];
}

HandlePool.prototype._add = function(obj) {
    if (obj) this._handles.push(obj);
    return obj;
};

HandlePool.prototype._remove = function(obj) {
    for (var i = 0; i < this._handles.length; i++) {
        if (this._handles[i] === obj) {
            this._handles.splice(i, 1);
            return true;
        }
    }
    return false;
};

/**
 * Create an owned handle for a path. The caller owns it and must eventually
 * pass it to release() (or leave it to the teardown drain).
 *
 * @param {string} path - LiveAPI path
 * @returns {LiveAPI}
 */
HandlePool.prototype.create = function(path) {
    return this._add(new LiveAPI(path));
};

/**
 * Create an owned, configured observer. An observer that is dropped without
 * being unregistered is exactly as dangerous as a plain handle, so it is
 * pooled like one; ObserverRegistry.unregister releases it through release().
 *
 * @param {string} path - LiveAPI path to observe
 * @param {string} property - Property to observe
 * @param {Function} callback - Callback to run on property change
 * @returns {LiveAPI}
 */
HandlePool.prototype.observer = function(path, property, callback) {
    // Pool before assigning path/property so a throwing assignment still
    // leaves the handle owned rather than orphaned.
    var observer = this._add(new LiveAPI(callback));
    observer.path = path;
    observer.property = property;
    return observer;
};

/**
 * Release a handle: hard-detach it and drop it from the pool.
 * Safe on null, safe to call twice, safe on an already-invalid handle.
 * Returns null so callers can write `this.x = pool.release(this.x);`.
 *
 * @param {LiveAPI|null} obj
 * @returns {null}
 */
HandlePool.prototype.release = function(obj) {
    if (!obj) return null;
    this._remove(obj);
    hardDetach(obj);
    return null;
};

/**
 * Re-point an existing owned handle at a new path instead of constructing a
 * new object. Assigning `path` re-resolves the handle exactly as constructing
 * a fresh LiveAPI would, and moves the path listener with it — so a role that
 * is queried repeatedly (the cached clip, this_device, a rack macro) keeps one
 * handle for its whole life and creates zero orphans in steady state.
 *
 * Creates and pools the handle on first use (obj === null).
 *
 * @param {LiveAPI|null} obj - Existing handle, or null to create one
 * @param {string} path - New path
 * @returns {LiveAPI|null}
 */
HandlePool.prototype.repoint = function(obj, path) {
    if (!obj) {
        try {
            return this.create(path);
        } catch (error) {
            handleError("HandlePool.repoint:create", error, false);
            return null;
        }
    }
    try {
        obj.path = path;
    } catch (error) {
        // Fail SAFE, not open. A handle whose re-point threw is still resolved
        // to its PREVIOUS target, and every caller validates with
        // `id !== INVALID_LIVE_API_ID` — which a stale-but-valid id passes. The
        // caller would then silently operate on the wrong object: writing mutes
        // and temperature to the clip that stopped playing, setting the mute
        // macro on a replaced rack, or recording the wrong parameter index
        // mid-scan. Make it inert so those guards reject it, matching the
        // fail-safe behavior of the construct-a-new-handle form this replaced.
        hardDetach(obj);
        handleError("HandlePool.repoint", error, false);
    }
    return obj;
};

/**
 * Borrow a transient handle for the duration of fn, then release it — even if
 * fn throws. Use this for genuine one-shot lookups so a transient handle can
 * never escape to the GC. Anything queried repeatedly in a stable role should
 * use repoint() on a long-lived handle instead.
 *
 * @param {string} path - LiveAPI path
 * @param {Function} fn - Receives the handle; its return value is passed through
 * @returns {*}
 */
HandlePool.prototype.borrow = function(path, fn) {
    var obj = null;
    try {
        obj = this.create(path);
        return fn(obj);
    } finally {
        this.release(obj);
    }
};

/**
 * Drain the pool: hard-detach every handle this device still owns.
 * Called on device teardown so a device removed from a track leaves no
 * listeners behind, and on re-init so a script reload doesn't strand the
 * previous run's handles. Only ever touches this device's handles.
 */
HandlePool.prototype.releaseAll = function() {
    var handles = this._handles;
    this._handles = [];
    for (var i = 0; i < handles.length; i++) {
        hardDetach(handles[i]);
        handles[i] = null;
    }
    debug("liveapi", "Released " + handles.length + " pooled handles");
};

/**
 * Number of handles currently owned. Diagnostic only — a steady-state count
 * that climbs while playing means something is creating handles per tick.
 *
 * @returns {number}
 */
HandlePool.prototype.size = function() {
    return this._handles.length;
};

/**
 * Find transpose parameter by scanning device parameters for known names.
 * Returns the first match based on priority order from config.
 * Case-insensitive exact match, scans up to 17 parameters (typical rack macro count).
 * Called once per device load, not per-step.
 *
 * @param {LiveAPI} device - Device to scan
 * @param {HandlePool} pool - Pool that owns the scratch and result handles
 * @returns {Object|null} - { index, param, shiftAmount, name } or null if not found
 */
function findTransposeParameterByName(device, pool) {
    if (!device || device.id === INVALID_LIVE_API_ID) return null;
    if (!pool) return null;

    // One scratch handle is re-pointed across the whole scan and released in
    // the finally below. Constructing a handle per parameter (as this used to)
    // orphaned paramCount-1 attached handles on every detection.
    var scratch = null;

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

        // Scan the full parameter list. Racks are typically 17 macros;
        // Simpler's Transpose is at index 11; other instruments can expose
        // a Transpose parameter at higher indices. We early-exit on the
        // first priority match, so scanning more is cheap when the param
        // is near the top.
        var params = device.get("parameters");
        if (!params) return null;
        var paramCount = Math.floor(params.length / 2);  // Live returns [id, id, id...]
        if (paramCount === 0) return null;

        // Scan parameters, collecting matches. Also note macros 1 & 2 by name
        // so we can apply a wider shift on racks tagged FX1/FX2 (those map
        // Transpose to a narrower range internally).
        // Only the index is recorded during the scan; the winning parameter is
        // promoted to its own owned handle at return time. Nothing but that one
        // handle survives the scan.
        var matches = {};  // lowerName -> index
        var macro1Name = null;
        var macro2Name = null;
        var basePath = device.path + " parameters ";
        for (var i = 0; i < paramCount; i++) {
            scratch = pool.repoint(scratch, basePath + i);

            // Validate LiveAPI object before use
            if (!scratch || scratch.id === INVALID_LIVE_API_ID) continue;

            var nameResult = scratch.get("name");
            if (nameResult && nameResult[0]) {
                var paramName = nameResult[0].toLowerCase();
                if (nameLookup[paramName]) {
                    matches[paramName] = i;
                }
                if (i === 1) macro1Name = paramName;
                else if (i === 2) macro2Name = paramName;
            }
        }

        // Return highest priority match. Index 0 is a legitimate match, so
        // test against undefined rather than truthiness.
        for (var i = 0; i < priorityOrder.length; i++) {
            var name = priorityOrder[i];
            if (matches[name] !== undefined) {
                var config = nameLookup[name];
                var shiftAmount = config.shiftAmount;
                if (name === "transpose" && macro1Name === "fx1" && macro2Name === "fx2") {
                    shiftAmount = 16;
                    debug("transpose", "FX1/FX2 macros detected — using shift 16");
                }
                debug("transpose", "Found '" + name + "' at param " + matches[name]);
                return {
                    index: matches[name],
                    // Owned by the caller (TransposeStrategy), released via
                    // TransposeStrategy.release().
                    param: pool.create(basePath + matches[name]),
                    shiftAmount: shiftAmount,
                    name: name
                };
            }
        }

        return null;  // No matching parameter found
    } catch (error) {
        handleError("findTransposeParameterByName", error, false);
        return null;
    } finally {
        scratch = pool.release(scratch);
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
    // LiveAPI handle lifetime — the single chokepoint. See the invariant above.
    // HandlePool is the ONLY way to make a handle: there is no module-level
    // factory, so a caller cannot accidentally create one outside a device's
    // ownership.
    HandlePool: HandlePool,
    hardDetach: hardDetach,
    findTransposeParameterByName: findTransposeParameterByName,
    isParameterTransposeDevice: isParameterTransposeDevice,
    defer: defer,
    setDebugMode: setDebugMode
};
