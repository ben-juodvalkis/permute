/**
 * permute-observer-registry.js - Centralized observer management
 *
 * Observers are ordinary LiveAPI handles: they are created through
 * permute-utils' factory (createObserver), tracked in the same device-scoped
 * pool as every other handle, and released through the same releaseLiveAPI
 * chokepoint. There is one lifetime system, not two.
 *
 * Depends on: permute-utils
 */

var utils = require('permute-utils');

var releaseLiveAPI = utils.releaseLiveAPI;

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
 * Unregister an observer by name. Releases the handle (hard-detach + drop
 * from the pool) rather than leaving it for the garbage collector — a
 * dropped-but-attached observer is what aborts Live from a GC weak callback.
 *
 * @param {string} name - Observer name
 */
ObserverRegistry.prototype.unregister = function(name) {
    if (this.observers[name]) {
        releaseLiveAPI(this.observers[name]);
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
            releaseLiveAPI(this.observers[name]);
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
