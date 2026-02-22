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
 * Unregister an observer by name.
 * @param {string} name - Observer name
 */
ObserverRegistry.prototype.unregister = function(name) {
    if (this.observers[name]) {
        this.observers[name].property = "";
        delete this.observers[name];
    }
};

/**
 * Clear all observers.
 */
ObserverRegistry.prototype.clearAll = function() {
    for (var name in this.observers) {
        if (this.observers.hasOwnProperty(name)) {
            this.observers[name].property = "";
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
