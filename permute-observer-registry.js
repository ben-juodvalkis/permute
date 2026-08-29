/**
 * permute-observer-registry.js - Centralized observer management
 *
 * Observers are ordinary LiveAPI handles: they are created through the owning
 * device's HandlePool, tracked in the same device-scoped
 * pool as every other handle, and released through that pool. There is one
 * lifetime system, not two.
 *
 * No dependencies — the pool is injected by the owning device.
 */

/**
 * ObserverRegistry - Centralized observer management.
 * Tracks all active observers and guarantees cleanup on error/destruction.
 *
 * @param {HandlePool} pool - The owning device's handle pool. Observers are
 *   released back through it, so registry teardown can only ever affect the
 *   device that owns this registry.
 */
function ObserverRegistry(pool) {
    this.observers = {}; // name -> observer
    this.pool = pool || null;
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
        if (this.pool) this.pool.release(this.observers[name]);
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
            if (this.pool) this.pool.release(this.observers[name]);
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
