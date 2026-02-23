/**
 * permute-device.js - Dual mute/pitch sequencer for Max4Live
 *
 * Main device controller and Max message handlers.
 * Logic is modularized into CommonJS modules.
 *
 * @requires Max4Live JavaScript API
 */

autowatch = 1;
inlets = 3;  // 0: Transport (song_time), 1: OSC commands, 2: Max UI commands
outlets = 2; // 0: UI feedback, 1: OSC broadcasts

// ===== MODULE IMPORTS =====
var constants = require('permute-constants');
var utils = require('permute-utils');
var Sequencer = require('permute-sequencer').Sequencer;
var ObserverRegistry = require('permute-observer-registry').ObserverRegistry;
var stateClasses = require('permute-state');
var instruments = require('permute-instruments');
var CommandRegistry = require('permute-commands').CommandRegistry;
var temperature = require('permute-temperature');

var OCTAVE_SEMITONES = constants.OCTAVE_SEMITONES;
var DEFAULT_GAIN_VALUE = constants.DEFAULT_GAIN_VALUE;
var MUTED_GAIN = constants.MUTED_GAIN;
var INVALID_LIVE_API_ID = constants.INVALID_LIVE_API_ID;

var debug = utils.debug;
var handleError = utils.handleError;
var parseNotesResponse = utils.parseNotesResponse;
var findTransposeParameterByName = utils.findTransposeParameterByName;
var isParameterTransposeDevice = utils.isParameterTransposeDevice;
var createObserver = utils.createObserver;
var defer = utils.defer;
var calculateTicksPerStep = utils.calculateTicksPerStep;

var TrackState = stateClasses.TrackState;
var ClipState = stateClasses.ClipState;
var TransportState = stateClasses.TransportState;

var InstrumentDetector = instruments.InstrumentDetector;
var TransposeStrategy = instruments.TransposeStrategy;
var DefaultInstrumentStrategy = instruments.DefaultInstrumentStrategy;

// ===== MAIN SEQUENCER DEVICE =====

function SequencerDevice() {
    this.sequencers = {
        muteSequencer: new Sequencer('mute', 'binary', 8),
        pitchSequencer: new Sequencer('pitch', 'binary', 8)
    };

    // Initialize mute pattern to all unmuted (1 = play, 0 = mute)
    this.sequencers.muteSequencer.pattern = [1, 1, 1, 1, 1, 1, 1, 1];
    this.sequencers.muteSequencer.defaultValue = 1; // Override: mute default is unmuted (1)
    this.sequencers.muteSequencer._recomputeActive();

    // Set device reference on sequencers
    for (var name in this.sequencers) {
        if (this.sequencers.hasOwnProperty(name)) {
            this.sequencers[name].device = this;
        }
    }

    // Instrument detection for pitch transformation
    this.instrumentType = 'unknown';
    this.instrumentDevice = null;
    this.instrumentDeviceId = null;
    this.instrumentStrategy = new DefaultInstrumentStrategy();

    // Temperature state (non-sequenced)
    this.temperatureValue = 0.0;
    this.temperatureSwapPattern = [];
    this.temperatureActive = false;
    this.temperatureLoopJumpObserver = null;

    // Temperature note ID tracking for reversible transformations
    // Maps clipId -> { originalPitches: { noteId: pitch } }
    this.temperatureState = {};

    // Delta-based state tracking: clipId -> { pitch: 0/1, mute: 0/1 }
    this.lastValues = {};

    // Batching queue: clipId -> { mute, pitch, scheduled, task }
    this.pendingApplies = {};

    // State management objects
    this.trackState = new TrackState();
    this.clipState = new ClipState();
    this.transportState = new TransportState();

    // Observer registry
    this.observerRegistry = new ObserverRegistry();

    // Clip cache: avoids redundant LiveAPI IPC on every tick
    this._cachedClip = null;
    this._cachedClipId = null;
    this._clipCacheDirty = true;

    // Pre-allocated broadcast buffers (avoid per-tick array allocation)
    // State: [trackIndex, mutePattern x8, muteLen, muteDiv x3, mutePos, pitchPattern x8, pitchLen, pitchDiv x3, pitchPos, temp] = 28
    this._stateBuffer = new Array(28);
    // Outlet args: [outletNum, "state_broadcast", trackIndex, origin, ...27 data values] = 31
    this._outletBuffer = new Array(31);
    this._outletBuffer[0] = 1;
    this._outletBuffer[1] = "state_broadcast";

    // Lazy observer activation: transport/time-sig observers created on first active sequencer
    this.playbackObserversActive = false;

    // Time signature tracking
    this.timeSignatureNumerator = 4; // Default to 4/4

    // Device identification
    this.deviceId = this.generateDeviceId();
    this.liveDeviceId = null;  // Cached Live API device ID for OSC command filtering

    // Command registry for message handling
    this.commandRegistry = new CommandRegistry();
    this.setupCommandHandlers();

}

/**
 * Generate unique device ID for identification and state tracking.
 * @returns {string} - Unique device identifier
 */
SequencerDevice.prototype.generateDeviceId = function() {
    return "seq_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
};

/**
 * Setup command handlers for message dispatch.
 */
SequencerDevice.prototype.setupCommandHandlers = function() {
    var self = this;

    // ===== OSC COMMAND HANDLERS =====
    // These handlers receive commands from Svelte UI via OSC bridge
    // All commands include deviceId as first arg for filtering

    // Helper to check if command is for this device
    function isForThisDevice(deviceId) {
        return self.liveDeviceId !== null && parseInt(deviceId) === self.liveDeviceId;
    }

    // Mute sequencer commands
    this.commandRegistry.register('seq_mute_step', function(args) {
        if (args.length < 3 || !isForThisDevice(args[0])) return;
        self.sequencers.muteSequencer.setStep(parseInt(args[1]), parseInt(args[2]));
        self.sendSequencerState('mute');
        self.broadcastState('mute_step');
    });

    this.commandRegistry.register('seq_mute_length', function(args) {
        if (args.length < 2 || !isForThisDevice(args[0])) return;
        self.sequencers.muteSequencer.setLength(parseInt(args[1]));
        self.sendSequencerState('mute');
        self.broadcastState('mute_length');
    });

    this.commandRegistry.register('seq_mute_rate', function(args) {
        if (args.length < 4 || !isForThisDevice(args[0])) return;
        self.sequencers.muteSequencer.setDivision([parseInt(args[1]), parseInt(args[2]), parseInt(args[3])], self.timeSignatureNumerator);
        self.sendSequencerState('mute');
        self.broadcastState('mute_rate');
    });

    // Pitch sequencer commands
    this.commandRegistry.register('seq_pitch_step', function(args) {
        if (args.length < 3 || !isForThisDevice(args[0])) return;
        self.sequencers.pitchSequencer.setStep(parseInt(args[1]), parseInt(args[2]));
        self.sendSequencerState('pitch');
        self.broadcastState('pitch_step');
    });

    this.commandRegistry.register('seq_pitch_length', function(args) {
        if (args.length < 2 || !isForThisDevice(args[0])) return;
        self.sequencers.pitchSequencer.setLength(parseInt(args[1]));
        self.sendSequencerState('pitch');
        self.broadcastState('pitch_length');
    });

    this.commandRegistry.register('seq_pitch_rate', function(args) {
        if (args.length < 4 || !isForThisDevice(args[0])) return;
        self.sequencers.pitchSequencer.setDivision([parseInt(args[1]), parseInt(args[2]), parseInt(args[3])], self.timeSignatureNumerator);
        self.sendSequencerState('pitch');
        self.broadcastState('pitch_rate');
    });

    // Temperature command
    this.commandRegistry.register('seq_temperature', function(args) {
        // args: [deviceId, value]
        if (args.length < 2 || !isForThisDevice(args[0])) return;
        var value = parseFloat(args[1]);
        self.setTemperatureValue(value);
        self.sendTemperatureState();
        self.broadcastState('temperature');
    });

    // Complete state command (for ghost editing sync)
    this.commandRegistry.register('set_state', function(args) {
        // args: [deviceId, mutePattern[8], muteLength, muteBars, muteBeats, muteTicks,
        //        pitchPattern[8], pitchLength, pitchBars, pitchBeats, pitchTicks, temperature]
        // Total: 26 args (1 + 8 + 1 + 3 + 8 + 1 + 3 + 1)
        debug("set_state", "Received " + args.length + " args, deviceId=" + args[0]);
        if (args.length < 26) {
            debug("set_state", "REJECTED: not enough args");
            return;
        }
        if (!isForThisDevice(args[0])) {
            debug("set_state", "REJECTED: not for this device");
            return;
        }
        debug("set_state", "ACCEPTED for this device");

        var idx = 1;  // Skip deviceId

        // Mute pattern (8 steps)
        var mutePattern = [];
        for (var i = 0; i < 8; i++) {
            mutePattern.push(parseInt(args[idx++]));
        }
        debug("set_state", "Mute pattern: " + mutePattern.join(","));
        self.sequencers.muteSequencer.setPattern(mutePattern);

        // Mute length and rate
        self.sequencers.muteSequencer.setLength(parseInt(args[idx++]));
        var muteBars = parseInt(args[idx++]);
        var muteBeats = parseInt(args[idx++]);
        var muteTicks = parseInt(args[idx++]);
        self.sequencers.muteSequencer.setDivision([muteBars, muteBeats, muteTicks], self.timeSignatureNumerator);

        // Pitch pattern (8 steps)
        var pitchPattern = [];
        for (var j = 0; j < 8; j++) {
            pitchPattern.push(parseInt(args[idx++]));
        }
        self.sequencers.pitchSequencer.setPattern(pitchPattern);

        // Pitch length and rate
        self.sequencers.pitchSequencer.setLength(parseInt(args[idx++]));
        var pitchBars = parseInt(args[idx++]);
        var pitchBeats = parseInt(args[idx++]);
        var pitchTicks = parseInt(args[idx++]);
        self.sequencers.pitchSequencer.setDivision([pitchBars, pitchBeats, pitchTicks], self.timeSignatureNumerator);

        // Temperature
        var temp = parseFloat(args[idx++]);
        self.setTemperatureValue(temp);
        self.sendTemperatureState();

        // Send sequencer state to UI
        self.sendSequencerState('mute');
        self.sendSequencerState('pitch');

        self.broadcastState('set_state_ack');
    });
};

// ===== INITIALIZATION =====

/**
 * Initialize the sequencer device.
 * Establishes track reference, detects track/instrument types, and sets up observers.
 */
SequencerDevice.prototype.init = function() {
    debug("init", "Starting sequencer initialization");
    try {
        // Cache Live API device ID for OSC command filtering
        var thisDevice = new LiveAPI("this_device");
        if (thisDevice && thisDevice.id !== INVALID_LIVE_API_ID) {
            this.liveDeviceId = parseInt(thisDevice.id);
            debug("init", "Cached Live device ID: " + this.liveDeviceId);
        }

        // Try multiple ways to get track reference
        var track = new LiveAPI("this_device canonical_parent");

        if (!track || track.id === INVALID_LIVE_API_ID) {
            if (thisDevice && thisDevice.id !== INVALID_LIVE_API_ID) {
                var devicePath = thisDevice.path;
                var trackPath = devicePath.substring(0, devicePath.lastIndexOf(" devices"));
                track = new LiveAPI(trackPath);
            }
        }

        if (track && track.id !== INVALID_LIVE_API_ID) {
            this.trackState.update(track);

            // Extract and store track index for multi-track sequencer display
            this.trackState.index = this.trackState.extractIndexFromPath(track.path);
            debug("init", "Track index: " + this.trackState.index);

            this.detectInstrumentType();

            // Device observer for instrument re-detection
            // Transport/time-sig observers are lazy-created when a sequencer becomes active
            this.setupDeviceObserver();

            debug("init", "Initialization complete (dormant mode - no playback observers)", {
                trackType: this.trackState.type,
                instrumentType: this.instrumentType
            });

            // Request UI elements to re-emit their persisted values
            // UI elements are the source of truth — their values become the initial state
            outlet(0, "request_ui_values", 1);
        } else {
            handleError("init", "Could not find track reference", true);
        }
    } catch (error) {
        handleError("init", error, true);
    }
};

// ===== OBSERVER SETUP =====

/**
 * Setup device observer to detect instrument changes.
 */
SequencerDevice.prototype.setupDeviceObserver = function() {
    if (!this.trackState.ref) return;

    var self = this;

    var observer = createObserver(
        this.trackState.ref.path,
        "devices",
        function(args) {
            defer(function() {
                // Revert current transpose before re-detecting, so we
                // don't capture a shifted value as the new "original".
                if (self.instrumentType === 'parameter_transpose') {
                    self.instrumentStrategy.revertTranspose();
                }
                self.detectInstrumentType();
            });
        }
    );

    this.observerRegistry.register('device', observer);
};

/**
 * Setup transport observer to detect play/stop.
 */
SequencerDevice.prototype.setupTransportObserver = function() {
    var self = this;

    var observer = createObserver(
        "live_set",
        "is_playing",
        function(args) {
            var playing = args[1];
            if (playing === 1 && !self.transportState.isPlaying) {
                defer(function() {
                    self.onTransportStart();
                });
            } else if (playing === 0 && self.transportState.isPlaying) {
                defer(function() {
                    self.onTransportStop();
                });
            }
        }
    );

    this.observerRegistry.register('transport', observer);
};

/**
 * Setup time signature observer.
 */
SequencerDevice.prototype.setupTimeSignatureObserver = function() {
    var self = this;

    var observer = createObserver(
        "live_set",
        "signature_numerator",
        function(args) {
            var numerator = args[1];
            if (numerator && numerator > 0) {
                self.timeSignatureNumerator = numerator;

                // Recalculate ticks per step for all sequencers
                for (var name in self.sequencers) {
                    if (self.sequencers.hasOwnProperty(name)) {
                        var seq = self.sequencers[name];
                        seq.ticksPerStep = calculateTicksPerStep(seq.division, numerator);
                    }
                }

                debug("timeSignature", "Updated to " + numerator + "/4");
            }
        }
    );

    this.observerRegistry.register('timeSignature', observer);
};

/**
 * Ensure playback observers are active.
 * Lazily creates transport and time signature observers when first needed.
 */
SequencerDevice.prototype.ensurePlaybackObservers = function() {
    if (this.playbackObserversActive) return;

    debug("lazy", "Activating playback observers (sequencer became active)");

    this.setupTransportObserver();
    this.setupTimeSignatureObserver();
    this.playbackObserversActive = true;

    debug("lazy", "Playback observers now active");
};

/**
 * Check if any sequencer is active and ensure observers if so.
 * Called when pattern changes to potentially activate lazy observers.
 */
SequencerDevice.prototype.checkAndActivateObservers = function() {
    if (this.playbackObserversActive) return;

    // Don't create observers before init() has established the track reference.
    // UI elements may send restored values before init(), but Live API isn't ready yet.
    // init() calls this again after setup.
    if (!this.trackState.ref) return;

    // Check if either sequencer is now active
    var muteActive = this.sequencers.muteSequencer.isActive();
    var pitchActive = this.sequencers.pitchSequencer.isActive();

    if (muteActive || pitchActive) {
        this.ensurePlaybackObservers();
    }
};

// ===== TRANSPORT HANDLING =====

/**
 * Handle transport start.
 * Captures temperature state if temperature was set before playback.
 */
SequencerDevice.prototype.onTransportStart = function() {
    debug("transport", "Transport started");
    this.invalidateClipCache();
    this.transportState.setPlaying(true);

    // If temperature was set before transport started, capture state now
    if (this.temperatureValue > 0) {
        var clip = this.getCurrentClip();
        if (clip) {
            var clipId = clip.id;
            // Only capture if we don't already have state for this clip
            if (!this.temperatureState[clipId]) {
                this.captureTemperatureState(clipId);
            }
        }
        this.setupTemperatureLoopJumpObserver();
    }
};

/**
 * Handle transport stop.
 * Reverts all transformations. Temperature state takes priority over
 * delta-based pitch undo when present.
 */
SequencerDevice.prototype.onTransportStop = function() {
    debug("transport", "Transport stopped");
    this.invalidateClipCache();

    // Always revert parameter_transpose on stop, even without a clip
    if (this.instrumentType === 'parameter_transpose') {
        this.instrumentStrategy.revertTranspose();
    }

    var clip = this.getCurrentClip();
    if (!clip) {
        this.transportState.setPlaying(false);
        // Still need to reset sequencers even without a clip
        for (var name in this.sequencers) {
            if (this.sequencers.hasOwnProperty(name)) {
                var seq = this.sequencers[name];
                seq.currentStep = -1;
                seq.lastParameterValue = undefined;
                var cleanName = name.replace('Sequencer', '');
                this.sendSequencerPosition(cleanName);
            }
        }
        this.broadcastState('position');
        return;
    }

    var clipId = clip.id;
    var trackType = this.trackState.type;

    var hasTemperatureState = !!this.temperatureState[clipId];

    // Undo transformations based on last values
    if (this.lastValues[clipId] || hasTemperatureState) {
        try {
            if (trackType === 'midi') {
                var notesJson = clip.call("get_all_notes_extended");
                var notes = parseNotesResponse(notesJson);
                if (notes && notes.notes) {
                    var changed = false;

                    if (hasTemperatureState) {
                        var tempState = this.temperatureState[clipId];
                        for (var i = 0; i < notes.notes.length; i++) {
                            var note = notes.notes[i];
                            var originalPitch = tempState.originalPitches[note.note_id];
                            if (originalPitch !== undefined) {
                                // Restore TRUE base pitch (no pitch sequencer adjustment)
                                note.pitch = originalPitch;
                                changed = true;
                            }
                            // Overdubbed notes keep current pitch
                        }
                        debug("onTransportStop", "Restored temperature state for " + notes.notes.length + " notes");

                        // Clear temperature state
                        delete this.temperatureState[clipId];
                    } else {
                        // No temperature state - use delta-based pitch undo for note_transpose
                        if (this.lastValues[clipId] && this.lastValues[clipId].pitch === 1) {
                            if (this.instrumentType !== 'parameter_transpose') {
                                // Shift notes down
                                for (var i = 0; i < notes.notes.length; i++) {
                                    notes.notes[i].pitch -= OCTAVE_SEMITONES;
                                }
                                changed = true;
                            }
                        }
                    }

                    // Undo mute if was on (always applies, independent of temperature)
                    if (this.lastValues[clipId] && this.lastValues[clipId].mute === 0) {
                        for (var i = 0; i < notes.notes.length; i++) {
                            notes.notes[i].mute = 0; // Unmute all
                        }
                        changed = true;
                    }

                    if (changed) {
                        clip.call("apply_note_modifications", notes);
                    }
                }
            } else if (trackType === 'audio') {
                // Audio clips don't support temperature (no note IDs)
                // Undo audio transformations normally
                if (this.lastValues[clipId]) {
                    if (this.lastValues[clipId].pitch === 1) {
                        clip.set("pitch_coarse", 0);
                    }
                    if (this.lastValues[clipId].mute === 0) {
                        clip.set("gain", DEFAULT_GAIN_VALUE);
                    }
                }
            }

            delete this.lastValues[clipId];
        } catch (error) {
            handleError("onTransportStop", error, false);
        }
    }

    // Reset all sequencers
    for (var name in this.sequencers) {
        if (this.sequencers.hasOwnProperty(name)) {
            var seq = this.sequencers[name];
            seq.currentStep = -1;
            seq.lastParameterValue = undefined;

            var cleanName = name.replace('Sequencer', '');
            this.sendSequencerPosition(cleanName);
        }
    }
    // Broadcast reset positions to OSC
    this.broadcastState('position');

    // Clear temperature observer (will be re-setup on next transport start if temp > 0)
    this.clearTemperatureLoopJumpObserver();

    // Clear active flag but keep temperatureValue across transport cycles
    this.temperatureActive = false;

    // Cancel any pending batch applies
    for (var pendingClipId in this.pendingApplies) {
        if (this.pendingApplies.hasOwnProperty(pendingClipId)) {
            var pending = this.pendingApplies[pendingClipId];
            if (pending.task) {
                pending.task.cancel();
            }
        }
    }
    this.pendingApplies = {};

    this.transportState.setPlaying(false);
};

// ===== BATCHING SYSTEM =====

/**
 * Schedule batch apply for a clip.
 * Accumulates multiple transformation changes and applies them in a single batch.
 *
 * @param {string} clipId - Clip ID
 * @param {string} transformName - Transformation name ('mute', 'pitch')
 * @param {*} value - Transformation value
 */
SequencerDevice.prototype.scheduleBatchApply = function(clipId, transformName, value) {
    // Initialize pending entry if doesn't exist
    if (!this.pendingApplies[clipId]) {
        this.pendingApplies[clipId] = { scheduled: false };
    }

    // Store pending value (last value wins)
    this.pendingApplies[clipId][transformName] = value;

    // Skip if already scheduled
    if (this.pendingApplies[clipId].scheduled) {
        debug("scheduleBatch", transformName + " added to existing batch for clip " + clipId);
        return;
    }

    // Mark as scheduled
    this.pendingApplies[clipId].scheduled = true;

    var self = this;

    // Create batch task
    var task = new Task(function() {
        self.executeBatchApply(clipId);
    });

    this.pendingApplies[clipId].task = task;
    task.schedule(1); // 1ms delay

    debug("scheduleBatch", "Scheduled batch for clip " + clipId + " with " + transformName);
};

/**
 * Execute batch apply for a clip.
 * Applies all pending transformations in a single operation.
 *
 * @param {string} clipId - Clip ID
 */
SequencerDevice.prototype.executeBatchApply = function(clipId) {
    var clip = this.getCurrentClip();
    if (!clip || clip.id !== clipId) {
        debug("executeBatch", "Clip changed or unavailable, skipping batch");
        delete this.pendingApplies[clipId];
        return;
    }

    var pending = this.pendingApplies[clipId];
    var trackType = this.trackState.type;

    debug("executeBatch", "Executing batch for clip " + clipId, pending);

    if (trackType === 'midi') {
        this.executeBatchMIDI(clip, clipId, pending);
    } else if (trackType === 'audio') {
        this.executeBatchAudio(clip, clipId, pending);
    }

    // Clear pending
    delete this.pendingApplies[clipId];
};

/**
 * Execute batch for MIDI clips. Applies deltas only on value change.
 *
 * @param {LiveAPI} clip - Clip object
 * @param {string} clipId - Clip ID
 * @param {Object} pending - Pending transformations
 */
SequencerDevice.prototype.executeBatchMIDI = function(clip, clipId, pending) {
    // 1. Read current clip state
    var notesJson = clip.call("get_all_notes_extended");
    var notes = parseNotesResponse(notesJson);
    if (!notes || !notes.notes) {
        handleError("executeBatchMIDI", "Failed to parse notes", false);
        return;
    }

    // 2. Initialize lastValues if needed
    if (!this.lastValues[clipId]) {
        this.lastValues[clipId] = {};
    }

    var changed = false;

    // 3a. Apply mute (only if changed)
    if ('mute' in pending) {
        if (pending.mute !== this.lastValues[clipId].mute) {
            var shouldMute = (pending.mute === 0); // 0 = mute, 1 = play
            for (var i = 0; i < notes.notes.length; i++) {
                notes.notes[i].mute = shouldMute ? 1 : 0; // Live API: 1=muted, 0=unmuted
            }
            this.lastValues[clipId].mute = pending.mute;
            changed = true;
        }
    }

    // 3b. Apply pitch (only if changed)
    if ('pitch' in pending) {
        var lastPitch = this.lastValues[clipId].pitch;

        if (pending.pitch !== lastPitch) {
            var shouldShiftUp = (pending.pitch === 1);

            if (this.instrumentType === 'parameter_transpose') {
                // Apply device parameter (absolute state)
                this.instrumentStrategy.applyTranspose(shouldShiftUp);
            } else {
                // Apply delta based on change
                var delta = 0;
                if (shouldShiftUp && lastPitch !== 1) {
                    // Going from off to on: shift up
                    delta = OCTAVE_SEMITONES;
                } else if (!shouldShiftUp && lastPitch === 1) {
                    // Going from on to off: shift down
                    delta = -OCTAVE_SEMITONES;
                }

                if (delta !== 0) {
                    for (var i = 0; i < notes.notes.length; i++) {
                        notes.notes[i].pitch += delta;
                    }
                    changed = true;
                }
            }

            this.lastValues[clipId].pitch = pending.pitch;
        }
    }

    // 4. Apply to clip (only if changed)
    if (changed) {
        try {
            clip.call("apply_note_modifications", notes);
        } catch (error) {
            handleError("executeBatchMIDI", error, false);
        }
    }
};

/**
 * Execute batch for audio clips. Sets gain/pitch_coarse as absolute state.
 *
 * @param {LiveAPI} clip - Clip object
 * @param {string} clipId - Clip ID
 * @param {Object} pending - Pending transformations
 */
SequencerDevice.prototype.executeBatchAudio = function(clip, clipId, pending) {
    // Initialize lastValues if needed
    if (!this.lastValues[clipId]) {
        this.lastValues[clipId] = {};
        // Capture original gain on first access to this clip
        this.lastValues[clipId].originalGain = clip.get("gain");
    }

    try {
        // Apply mute (via gain) - absolute state
        if ('mute' in pending) {
            if (pending.mute !== this.lastValues[clipId].mute) {
                var shouldMute = (pending.mute === 0);
                // Restore original gain on unmute, not hardcoded value
                var gainValue = shouldMute ? MUTED_GAIN : this.lastValues[clipId].originalGain;
                clip.set("gain", gainValue);
                this.lastValues[clipId].mute = pending.mute;
            }
        }

        // Apply pitch (via pitch_coarse) - absolute state
        if ('pitch' in pending) {
            if (pending.pitch !== this.lastValues[clipId].pitch) {
                var shouldShiftUp = (pending.pitch === 1);
                var pitchValue = shouldShiftUp ? OCTAVE_SEMITONES : 0;
                clip.set("pitch_coarse", pitchValue);
                this.lastValues[clipId].pitch = pending.pitch;
            }
        }
    } catch (error) {
        handleError("executeBatchAudio", error, false);
    }
};

// ===== TEMPERATURE MIXIN =====
// Apply temperature methods to SequencerDevice.prototype from permute-temperature.js
temperature.applyTemperatureMethods(SequencerDevice.prototype);

// ===== INSTRUMENT DETECTION =====

/**
 * Detect instrument and configure transpose strategy.
 * Scans for named transpose parameters on the track's instrument device.
 */
SequencerDevice.prototype.detectInstrumentType = function() {
    // Reset to defaults
    this.instrumentType = 'unknown';
    this.instrumentDevice = null;
    this.instrumentDeviceId = null;
    this.instrumentStrategy = new DefaultInstrumentStrategy();

    if (this.trackState.type !== 'midi') return;

    // Find instrument device on track
    var result = InstrumentDetector.findInstrumentDevice(this.trackState.ref);
    if (!result) {
        debug("instrument", "No instrument device found");
        return;
    }

    this.instrumentDevice = result.device;
    this.instrumentDeviceId = result.deviceId;

    var classNameResult = result.device.get("class_name");
    var detectedClassName = classNameResult && classNameResult[0] ? classNameResult[0] : String(classNameResult);
    debug("instrument", "Detected device class_name: '" + detectedClassName + "'");

    // Default is note_transpose. Only devices in parameterTransposeDevices are
    // candidates for parameter-based transposition (with fallback to note_transpose
    // if no named param is found on those devices either).
    if (isParameterTransposeDevice(result.device)) {
        var transposeResult = findTransposeParameterByName(result.device);
        if (transposeResult) {
            this.instrumentType = 'parameter_transpose';
            this.instrumentStrategy = new TransposeStrategy(
                result.device,
                transposeResult.param,
                transposeResult.shiftAmount,
                transposeResult.name
            );
            debug("instrument", "Found transpose param '" + transposeResult.name +
                  "' at index " + transposeResult.index +
                  " (shift: " + transposeResult.shiftAmount + ")");
        } else {
            this.instrumentType = 'note_transpose';
            debug("instrument", "Listed device but no named param found, falling back to note-based shifting");
        }
    } else {
        this.instrumentType = 'note_transpose';
        debug("instrument", "Using note-based shifting (default)");
    }
};

// ===== CLIP MANAGEMENT =====

/**
 * Invalidate the clip cache.
 * Called at the start of each tick, and on transport/clip change events.
 */
SequencerDevice.prototype.invalidateClipCache = function() {
    this._clipCacheDirty = true;
};

/**
 * Get the currently playing clip on the track.
 * Uses a per-tick cache to avoid redundant LiveAPI IPC calls.
 * Clears temperature observer when clip changes.
 * @returns {LiveAPI|null} - Live API clip object or null if no clip playing
 */
SequencerDevice.prototype.getCurrentClip = function() {
    // Return cached clip if cache is clean
    if (!this._clipCacheDirty && this._cachedClip) {
        return this._cachedClip;
    }
    if (!this._clipCacheDirty && this._cachedClip === null) {
        return null;
    }

    if (!this.trackState.ref) return null;

    try {
        // Try playing_slot_index first
        var slotIndex = this.trackState.ref.get("playing_slot_index");

        // If no playing slot, try fired_slot_index
        if (!slotIndex || slotIndex[0] < 0) {
            slotIndex = this.trackState.ref.get("fired_slot_index");
        }

        // Early exit if no slot found
        if (!slotIndex || slotIndex[0] < 0) {
            this._cachedClip = null;
            this._cachedClipId = null;
            this._clipCacheDirty = false;
            return null;
        }

        var clipPath = this.trackState.ref.path + " clip_slots " + slotIndex[0] + " clip";
        var clip = new LiveAPI(clipPath);

        if (clip && clip.id !== INVALID_LIVE_API_ID) {
            if (this.clipState.hasChanged(clip.id)) {
                this.clearTemperatureLoopJumpObserver();
                this.clipState.update(clip.id);
            }
            this._cachedClip = clip;
            this._cachedClipId = clip.id;
            this._clipCacheDirty = false;
            return clip;
        }

        this._cachedClip = null;
        this._cachedClipId = null;
        this._clipCacheDirty = false;
        return null;
    } catch (error) {
        handleError("getCurrentClip", error, false);
        this._cachedClip = null;
        this._cachedClipId = null;
        return null;
    }
};

// ===== SHARED SEQUENCER FUNCTIONALITY =====

/**
 * Process both sequencers from a single song time message.
 * Applies lookahead so transformations land before the audio plays.
 *
 * @param {number} ticks - Absolute tick position from transport
 */
SequencerDevice.prototype.processWithSongTime = function(ticks) {
    // Lookahead: process ahead so transformations apply before audio plays
    // 120 ticks = 1 full 16th note - compensates for Live API latency
    var lookaheadTicks = 120;
    var targetTicks = ticks + lookaheadTicks;

    // Invalidate clip cache once per tick; first sequencer re-fetches, second reuses cache
    this.invalidateClipCache();

    // Snapshot positions before processing
    var muteStep = this.sequencers.muteSequencer.currentStep;
    var pitchStep = this.sequencers.pitchSequencer.currentStep;

    // Process both sequencers from single time source with lookahead
    this.processSequencerTick('mute', this.sequencers.muteSequencer, targetTicks);
    this.processSequencerTick('pitch', this.sequencers.pitchSequencer, targetTicks);

    // Single broadcast if either position changed
    if (this.sequencers.muteSequencer.currentStep !== muteStep ||
        this.sequencers.pitchSequencer.currentStep !== pitchStep) {
        this.broadcastState('position');
    }
};

/**
 * Generic tick processor for any sequencer.
 * Calculates current step and schedules batch apply.
 * Pitch sequencer with parameter_transpose works without a playing clip.
 *
 * @param {string} seqName - Sequencer name ('mute', 'pitch')
 * @param {Sequencer} seq - Sequencer instance
 * @param {number} ticks - Absolute tick position
 */
SequencerDevice.prototype.processSequencerTick = function(seqName, seq, ticks) {
    if (!seq || !seq.isActive()) return;

    var newStep = seq.calculateStep(ticks);

    if (newStep === seq.currentStep) return;

    seq.currentStep = newStep;

    try {
        var value = seq.getCurrentValue();
        var clip = this.getCurrentClip();

        // parameter_transpose applies directly without a clip (device parameter only)
        if (seqName === 'pitch' && this.instrumentType === 'parameter_transpose') {
            var shouldShiftUp = (value === 1);
            // Only apply if value changed from last applied
            if (value !== seq.lastParameterValue) {
                this.instrumentStrategy.applyTranspose(shouldShiftUp);
                seq.lastParameterValue = value;
            }
            this.sendSequencerPosition(seqName);
            return;
        }

        // For other cases (mute, or pitch with note_transpose), we need a clip
        if (clip) {
            this.scheduleBatchApply(clip.id, seqName, value);
        }

        this.sendSequencerPosition(seqName);
    } catch (error) {
        handleError("processSequencerTick:" + seqName, error, false);
    }
};

/**
 * Send full sequencer state to Max UI (outlet 0).
 * Called only when state actually changes (init, setState, UI command).
 *
 * @param {string} seqName - Sequencer name ('mute', 'pitch', etc.)
 */
SequencerDevice.prototype.sendSequencerState = function(seqName) {
    var seq = this.sequencers[seqName + 'Sequencer'];
    if (!seq) return;

    // Step values (8 individual messages)
    for (var i = 0; i < 8; i++) {
        var value = (i < seq.pattern.length) ? seq.pattern[i] : seq.valueType.default;
        outlet(0, seqName + "_step_" + i, value);
    }

    // Length
    outlet(0, seqName + "_length", seq.patternLength);

    // Division (bars, beats, ticks)
    outlet(0, seqName + "_division", seq.division[0], seq.division[1], seq.division[2]);

    // Current step and active state
    outlet(0, seqName + "_current", seq.currentStep);
    outlet(0, seqName + "_active", seq.isActive() ? 1 : 0);
};

/**
 * Send only the current step position to Max UI (outlet 0).
 * OSC broadcast is handled once per tick by processWithSongTime.
 *
 * @param {string} seqName - Sequencer name ('mute', 'pitch', etc.)
 */
SequencerDevice.prototype.sendSequencerPosition = function(seqName) {
    var seq = this.sequencers[seqName + 'Sequencer'];
    if (!seq) return;

    outlet(0, seqName + "_current", seq.currentStep);
};

/**
 * Send temperature value to Max UI (outlet 0).
 * Called when temperature changes from OSC or on init/setState.
 */
SequencerDevice.prototype.sendTemperatureState = function() {
    outlet(0, "temperature", this.temperatureValue || 0.0);
};

/**
 * Build state data array for OSC broadcasts.
 * Returns the raw data (without message selector or origin).
 *
 * Format (27 values):
 *   trackIndex,
 *   mutePattern[8], muteLength, muteBars, muteBeats, muteTicks, mutePosition,
 *   pitchPattern[8], pitchLength, pitchBars, pitchBeats, pitchTicks, pitchPosition,
 *   temperature
 *
 * @returns {Array|null} - State data array, or null if not ready
 */
SequencerDevice.prototype.buildStateData = function() {
    var trackIndex = this.trackState.index;

    // Skip if track index not yet determined
    if (trackIndex < 0) return null;

    var muteSeq = this.sequencers.muteSequencer;
    var pitchSeq = this.sequencers.pitchSequencer;

    // Skip if sequencers not initialized
    if (!muteSeq || !pitchSeq) return null;

    // Fill pre-allocated buffer in-place
    var buf = this._stateBuffer;
    buf[0] = trackIndex;

    // Mute pattern (8 steps) — indices 1-8
    for (var i = 0; i < 8; i++) {
        buf[1 + i] = (i < muteSeq.pattern.length) ? muteSeq.pattern[i] : muteSeq.valueType.default;
    }

    // Mute length, division, position — indices 9-13
    buf[9] = muteSeq.patternLength;
    var md = muteSeq.division;
    buf[10] = md[0]; buf[11] = md[1]; buf[12] = md[2];
    buf[13] = muteSeq.currentStep;

    // Pitch pattern (8 steps) — indices 14-21
    for (var i = 0; i < 8; i++) {
        buf[14 + i] = (i < pitchSeq.pattern.length) ? pitchSeq.pattern[i] : pitchSeq.valueType.default;
    }

    // Pitch length, division, position — indices 22-26
    buf[22] = pitchSeq.patternLength;
    var pd = pitchSeq.division;
    buf[23] = pd[0]; buf[24] = pd[1]; buf[25] = pd[2];
    buf[26] = pitchSeq.currentStep;

    // Temperature — index 27
    buf[27] = this.temperatureValue || 0.0;

    return buf;
};

/**
 * Broadcast state to OSC output (outlet 1).
 * Sends state_broadcast with origin tag for external listeners.
 *
 * Format (29 args):
 *   state_broadcast, trackIndex, origin, mutePattern[8], muteLength,
 *   muteBars, muteBeats, muteTicks, mutePosition, pitchPattern[8],
 *   pitchLength, pitchBars, pitchBeats, pitchTicks, pitchPosition, temperature
 *
 * Origin values:
 *   'init'          - Device just initialized
 *   'set_state_ack' - Echo of set_state from UI
 *   'mute_step'     - Mute step toggled via OSC
 *   'pitch_step'    - Pitch step toggled via OSC
 *   'mute_length'   - Mute length changed via OSC
 *   'pitch_length'  - Pitch length changed via OSC
 *   'mute_rate'     - Mute rate changed via OSC
 *   'pitch_rate'    - Pitch rate changed via OSC
 *   'temperature'   - Temperature changed via OSC
 *   'position'      - Playhead moved (during playback)
 *
 * @param {string} origin - Why this broadcast is happening
 * @param {Array} [stateData] - Pre-built state data (optional, builds if not provided)
 */
SequencerDevice.prototype.broadcastToOSC = function(origin, stateData) {
    var data = stateData || this.buildStateData();
    if (!data) return;

    // Fill pre-allocated outlet buffer in-place: [1, "state_broadcast", trackIndex, origin, data[1]..data[27]]
    var out = this._outletBuffer;
    out[2] = data[0]; // trackIndex
    out[3] = origin;
    for (var i = 1; i < 28; i++) {
        out[3 + i] = data[i];
    }
    outlet.apply(null, out);
};

/**
 * Broadcast combined sequencer state for multi-track display.
 *
 * @param {string} origin - Why this broadcast is happening (default: 'unknown')
 */
SequencerDevice.prototype.broadcastState = function(origin) {
    origin = origin || 'unknown';
    var data = this.buildStateData();
    if (!data) return;
    this.broadcastToOSC(origin, data);
};

// ===== INLET-AWARE MESSAGE HANDLERS =====

/**
 * Handle transport messages from inlet 0.
 * Processes song_time messages to drive sequencer playback.
 *
 * @param {string} messageName - Message name (e.g., 'song_time')
 * @param {Array} args - Message arguments
 */
SequencerDevice.prototype.handleTransport = function(messageName, args) {
    if (messageName === 'song_time' && args.length >= 1) {
        this.processWithSongTime(args[0]);
    }
};

/**
 * Handle OSC commands from inlet 1.
 * Parses /looping/sequencer/ addresses and routes to command handlers.
 * OSC commands update state and broadcast to OSC.
 *
 * @param {string} address - OSC address (e.g., '/looping/sequencer/mute/step')
 * @param {Array} args - Message arguments
 */
SequencerDevice.prototype.handleOSCCommand = function(address, args) {
    // Only handle /looping/sequencer/ messages
    if (address.indexOf('/looping/sequencer/') !== 0) {
        debug("handleOSCCommand", "Ignoring non-sequencer address: " + address);
        return;
    }

    // Strip prefix and convert to command name
    var path = address.replace('/looping/sequencer/', '');
    var parts = path.split('/');
    var command;

    if (parts[0] === 'set' && parts[1] === 'state') {
        command = 'set_state';
    } else if (parts[0] === 'temperature') {
        command = 'seq_temperature';
    } else if (parts.length === 2) {
        // mute/step, mute/length, mute/rate, pitch/step, etc.
        command = 'seq_' + parts[0] + '_' + parts[1];
    } else {
        debug("handleOSCCommand", "Unknown OSC command: " + address);
        return;
    }

    debug("handleOSCCommand", "OSC -> " + command + " " + args.join(" "));
    this.commandRegistry.execute(command, args, this);
};

/**
 * Handle Max UI commands from inlet 2.
 * Message names are symmetrical with outlet 0 feedback (e.g., mute_steps in, mute_step_N out).
 *
 * @param {string} messageName - Message name (e.g., 'mute_steps', 'mute_length')
 * @param {Array} args - Message arguments
 */
SequencerDevice.prototype.handleMaxUICommand = function(messageName, args) {
    debug("handleMaxUICommand", messageName + " " + args.join(" "));

    // Mute/pitch step grids — full 8-value row
    if (messageName === 'mute_steps' || messageName === 'pitch_steps') {
        var seqName = (messageName === 'mute_steps') ? 'mute' : 'pitch';
        var seq = this.sequencers[seqName + 'Sequencer'];
        var pattern = [];
        for (var i = 0; i < args.length; i++) {
            pattern.push(parseInt(args[i]));
        }
        // Skip if unchanged (break feedback loop)
        var unchanged = (pattern.length === seq.pattern.length);
        if (unchanged) {
            for (var i = 0; i < pattern.length; i++) {
                if (pattern[i] !== seq.pattern[i]) { unchanged = false; break; }
            }
        }
        if (unchanged) return;
        seq.setPattern(pattern);
        this.broadcastToOSC(seqName + '_pattern');
        return;
    }

    // Mute/pitch length
    if (messageName === 'mute_length' || messageName === 'pitch_length') {
        var seqName = (messageName === 'mute_length') ? 'mute' : 'pitch';
        var seq = this.sequencers[seqName + 'Sequencer'];
        if (args.length >= 1) {
            var newLength = parseInt(args[0]);
            if (newLength === seq.patternLength) return;  // Skip if unchanged
            seq.setLength(newLength);
            this.broadcastToOSC(seqName + '_length');
        }
        return;
    }

    // Mute/pitch division (rate)
    if (messageName === 'mute_division' || messageName === 'pitch_division') {
        var seqName = (messageName === 'mute_division') ? 'mute' : 'pitch';
        var seq = this.sequencers[seqName + 'Sequencer'];
        if (args.length >= 3) {
            var newDiv = [parseInt(args[0]), parseInt(args[1]), parseInt(args[2])];
            // Skip if unchanged
            if (seq.division[0] === newDiv[0] && seq.division[1] === newDiv[1] && seq.division[2] === newDiv[2]) return;
            seq.setDivision(newDiv, this.timeSignatureNumerator);
            this.broadcastToOSC(seqName + '_rate');
        }
        return;
    }

    // Temperature dial
    if (messageName === 'temperature') {
        if (args.length >= 1) {
            this.setTemperatureValue(parseFloat(args[0]));
            this.broadcastToOSC('temperature');
        }
        return;
    }

    // Temperature reset button
    if (messageName === 'temperature_reset') {
        var clip = this.getCurrentClip();
        var clipId = clip ? clip.id : null;
        if (clipId && this.temperatureState[clipId]) {
            this.restoreTemperatureState(clipId);
        }
        this.temperatureValue = 0.0;
        this.temperatureActive = false;
        this.clearTemperatureLoopJumpObserver();
        this.sendTemperatureState();
        this.broadcastToOSC('temperature');
        return;
    }

    // Temperature shuffle button
    if (messageName === 'temperature_shuffle') {
        if (this.temperatureActive && this.temperatureValue > 0) {
            this.onTemperatureLoopJump();
        }
        return;
    }

    debug("handleMaxUICommand", "Unknown UI message: " + messageName);
};

/**
 * Handle clip change event.
 * Cleans up temperature state for old clip, re-captures for new clip if active.
 */
SequencerDevice.prototype.onClipChanged = function() {
    this.invalidateClipCache();
    var hasTemperatureState = false;
    for (var k in this.temperatureState) {
        if (this.temperatureState.hasOwnProperty(k)) {
            hasTemperatureState = true;
            break;
        }
    }
    if (hasTemperatureState) {
        this.temperatureState = {};
        debug("onClipChanged", "Cleared temperature state for old clip");
    }

    // If temperature is active, capture state for the new clip
    if (this.temperatureValue > 0 && this.temperatureActive) {
        var clip = this.getCurrentClip();
        if (clip) {
            this.captureTemperatureState(clip.id);
            debug("onClipChanged", "Captured temperature state for new clip");
        }
    }

    // lastValues are tracked per clipId, so no need to clear on clip change
};

// ===== STATE PERSISTENCE =====

/**
 * Get current device state for saving/persistence.
 * @returns {Object} - Device state including all sequencer patterns and settings
 */
SequencerDevice.prototype.getState = function() {
    var state = {
        version: '3.1',
        deviceId: this.deviceId,
        temperature: this.temperatureValue || 0.0,
        sequencers: {}
    };

    // Save state for all sequencers
    for (var name in this.sequencers) {
        if (this.sequencers.hasOwnProperty(name)) {
            var seq = this.sequencers[name];
            var cleanName = name.replace('Sequencer', '');
            state.sequencers[cleanName] = {
                pattern: seq.pattern,
                patternLength: seq.patternLength,
                division: seq.division
            };
        }
    }

    return state;
};

/**
 * Restore device state from saved data.
 * @param {Object} state - Saved device state
 */
SequencerDevice.prototype.setState = function(state) {
    if (!state.sequencers) return;

    for (var name in state.sequencers) {
        if (state.sequencers.hasOwnProperty(name) && this.sequencers[name + 'Sequencer']) {
            var savedSeq = state.sequencers[name];
            var seq = this.sequencers[name + 'Sequencer'];

            if (savedSeq.pattern) seq.setPattern(savedSeq.pattern);
            if (savedSeq.patternLength) seq.setLength(savedSeq.patternLength);
            if (savedSeq.division) seq.setDivision(savedSeq.division, this.timeSignatureNumerator);

            this.sendSequencerState(name);
        }
    }

    if (state.temperature !== undefined) {
        this.setTemperatureValue(state.temperature);
        this.sendTemperatureState();
    }
};

// ===== GLOBAL INSTANCE =====
var sequencer = new SequencerDevice();

// ===== MAX MESSAGE HANDLERS =====
// Global functions exposed to Max. Most messages route through anything()
// which delegates by inlet. init/clip_changed/notifydeleted are called directly.

function init() {
    sequencer.init();
}

function clip_changed() {
    sequencer.onClipChanged();
}

function getState() {
    outlet(0, "state", JSON.stringify(sequencer.getState()));
}

function setState(stateJson) {
    try {
        var state = JSON.parse(stateJson);
        sequencer.setState(state);
    } catch (error) {
        handleError("setState", error, true);
    }
}

/**
 * Inlet-aware message router.
 * Routes messages to the appropriate handler based on which inlet they arrive on.
 *
 * Inlet 0: Transport messages (song_time)
 * Inlet 1: OSC commands (/looping/sequencer/*)
 * Inlet 2: Max UI commands (mute_steps, mute_length, mute_division, temperature, etc.)
 */
function anything() {
    var msg = messagename;
    var args = arrayfromargs(arguments);
    var inletNum = inlet;

    switch (inletNum) {
        case 0:
            sequencer.handleTransport(msg, args);
            break;
        case 1:
            sequencer.handleOSCCommand(msg, args);
            break;
        case 2:
            sequencer.handleMaxUICommand(msg, args);
            break;
        default:
            debug("anything", "Unknown inlet: " + inletNum);
    }
}

// Handle notifydeleted
function notifydeleted() {
    // Use observer registry for cleanup (includes temperature loop_jump observer)
    sequencer.observerRegistry.clearAll();
}
