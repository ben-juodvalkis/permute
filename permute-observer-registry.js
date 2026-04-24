/**
 * permute-observer-registry.js - Centralized observer management
 *
 * No dependencies.
 */

/**
 * ObserverRegistry - Centralized observer management.
 * Tracks all active observers and guarantees cleanup on error/destruction.
 */
function ObserverRegistry() {
    this.observers = {}; // name -> observer
}

/**
 * Register an observer.
 * @param {string} name - Unique name for this observer
 * @param {LiveAPI} observer - Observer object
 */
ObserverRegistry.prototype.register = function(name, observer) {
    if (this.observers[name]) {
        this.unregister(name);
    }
    this.observers[name] = observer;
};

/**
 * Fully detach a LiveAPI observer from Live's dispatcher.
 * Setting property alone only stops future notifications — path/id must also
 * be cleared so queued notifications against a stale path cannot fire
 * SendMessage errors into _path_listener_callback.
 */
function hardDetach(obs) {
    if (!obs) return;
    try { obs.property = ""; } catch (e) {}
    try { obs.path = ""; } catch (e) {}
    try { obs.id = 0; } catch (e) {}
}

/**
 * Unregister an observer by name.
 * @param {string} name - Observer name
 */
ObserverRegistry.prototype.unregister = function(name) {
    if (this.observers[name]) {
        hardDetach(this.observers[name]);
        this.observers[name] = null;
        delete this.observers[name];
    }
};

/**
 * Clear all observers.
 */
ObserverRegistry.prototype.clearAll = function() {
    for (var name in this.observers) {
        if (this.observers.hasOwnProperty(name)) {
            hardDetach(this.observers[name]);
            this.observers[name] = null;
        }
    }
    this.observers = {};
};

/**
 * Get observer by name.
 * @param {string} name - Observer name
 * @returns {LiveAPI|null} - Observer or null
 */
ObserverRegistry.prototype.get = function(name) {
    return this.observers[name] || null;
};

module.exports = {
    ObserverRegistry: ObserverRegistry
};
