/**
 * permute-commands.js - Command registry for message dispatch
 *
 * No dependencies.
 */

/**
 * CommandRegistry - Maps message types to handler functions.
 * Replaces large switch statements with cleaner dispatch pattern.
 */
function CommandRegistry() {
    this.commands = {};
}

/**
 * Register a command handler.
 * @param {string} command - Command name
 * @param {Function} handler - Handler function
 */
CommandRegistry.prototype.register = function(command, handler) {
    this.commands[command] = handler;
};

/**
 * Execute a command.
 * @param {string} command - Command name
 * @param {Array} args - Command arguments
 * @param {Object} context - Context object (usually 'this')
 * @returns {boolean} - True if command was handled
 */
CommandRegistry.prototype.execute = function(command, args, context) {
    if (this.commands[command]) {
        this.commands[command].call(context, args);
        return true;
    }
    return false;
};

module.exports = {
    CommandRegistry: CommandRegistry
};
