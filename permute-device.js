/**
 * permute-device.js - Dual mute/pitch sequencer for Max4Live
 *
 * Main device controller and Max message handlers.
 * Logic is modularized into CommonJS modules (Phase 3 refactor).
 *
 * @version 3.1
 * @author [Built interactively via Claude]
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

// Unpack frequently used constants
var TICKS_PER_QUARTER_NOTE = constants.TICKS_PER_QUARTER_NOTE;
var OCTAVE_SEMITONES = constants.OCTAVE_SEMITONES;
var MAX_PATTERN_LENGTH = constants.MAX_PATTERN_LENGTH;
var MIN_PATTERN_LENGTH = constants.MIN_PATTERN_LENGTH;
var DEFAULT_GAIN_VALUE = constants.DEFAULT_GAIN_VALUE;
var MUTED_GAIN = constants.MUTED_GAIN;
var INVALID_LIVE_API_ID = constants.INVALID_LIVE_API_ID;

// Unpack frequently used utilities
var debug = utils.debug;
var handleError = utils.handleError;
var parseNotesResponse = utils.parseNotesResponse;
var findTransposeParameterByName = utils.findTransposeParameterByName;
var isParameterTransposeDevice = utils.isParameterTransposeDevice;
var createObserver = utils.createObserver;
var defer = utils.defer;

// Unpack state classes
var TrackState = stateClasses.TrackState;
var ClipState = stateClasses.ClipState;
var TransportState = stateClasses.TransportState;

// Unpack instrument classes
var InstrumentDetector = instruments.InstrumentDetector;
var TransposeStrategy = instruments.TransposeStrategy;
var DefaultInstrumentStrategy = instruments.DefaultInstrumentStrategy;

// ===== MAIN SEQUENCER DEVICE =====

function SequencerDevice() {
    // V3.0: Sequencers without transformation wrappers
    this.sequencers = {
        muteSequencer: new Sequencer('mute', null, 'binary', 8),
        pitchSequencer: new Sequencer('pitch', null, 'binary', 8)
    };

    // Initialize mute pattern to all unmuted (1 = play, 0 = mute)
    this.sequencers.muteSequencer.pattern = [1, 1, 1, 1, 1, 1, 1, 1];
    this.sequencers.muteSequencer.defaultValue = 1; // Override: mute default is unmuted (1)

    // Set device reference on sequencers
    for (var name in this.sequencers) {
        if (this.sequencers.hasOwnProperty(name)) {
            this.sequencers[name].device = this;
        }
    }

    // V3.0: Instrument detection for pitch transformation
    this.instrumentType = 'unknown';
    this.instrumentDevice = null;
    this.instrumentDeviceId = null;
    this.instrumentStrategy = new DefaultInstrumentStrategy();

    // V3.0: Temperature state (non-sequenced)
    this.temperatureValue = 0.0;
    this.temperatureSwapPattern = [];
    this.temperatureActive = false;
    this.temperatureLoopJumpObserver = null;

    // V3.1: Temperature note ID tracking for reversible transformations
    // Maps clipId -> { originalPitches: { noteId: pitch }, capturedWithPitchOn: boolean }
    this.temperatureState = {};

    // V3.0: Simple state tracking (no pristine needed)
    this.lastValues = {}; // clipId -> { pitch: 0/1, mute: 0/1 }

    // V3.0: Batching queue
    this.pendingApplies = {}; // clipId -> { mute, pitch, scheduled, task }



    // State management objects
    this.trackState = new TrackState();
    this.clipState = new ClipState();
    this.transportState = new TransportState();

    // Observer registry
    this.observerRegistry = new ObserverRegistry();

    // V6.0: Lazy observer activation flag
    // Transport and time signature observers only created when a sequencer becomes active
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

            // V3.0: Detect instrument type for pitch transformation
            this.detectInstrumentType();

            // Setup device observer only (for instrument detection)
            // Transport/time signature observers are lazy-created when sequencer becomes active
            this.setupDeviceObserver();
            // Note: Transport and time signature observers NOT created here
            // They are created lazily by ensurePlaybackObservers() when a sequencer is activated

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
                // V5.0: Revert current transpose before re-detecting, so we
                // don't capture a shifted value as the new "original".
                if (self.instrumentType === 'parameter_transpose') {
                    self.instrumentStrategy.revertTranspose();
                }
                // V3.0: Re-detect instrument type on device changes
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
                        seq.ticksPerStep = self.getTicksPerStep(seq.division);
                    }
                }

                debug("timeSignature", "Updated to " + numerator + "/4");
            }
        }
    );

    this.observerRegistry.register('timeSignature', observer);
};

/**
 * V6.0: Ensure playback observers are active.
 * Lazily creates transport and time signature observers when first needed.
 * Called when a sequencer becomes active (pattern has non-default values).
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
 * V6.0: Check if any sequencer is active and ensure observers if so.
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

/**
 * Setup observers for clip changes.
 * V3.0: Minimal observation - temperature loop_jump only.
 * Note: External note edits during playback are ignored by design.
 *
 * @param {LiveAPI} clip - Live API clip object to observe
 */
SequencerDevice.prototype.setupClipObservers = function(clip) {
    // Clear existing observers
    this.observerRegistry.unregister('notes');

    // Clear temperature loop_jump observer when clip changes
    this.clearTemperatureLoopJumpObserver();

    // V3.0: No note observation needed - transformations track their own state
};

// ===== TRANSPORT HANDLING =====

/**
 * Handle transport start.
 * V3.1: Detect instrument and capture temperature state if needed.
 *
 * Note: Temperature is reset to 0 on transport stop, so temperatureValue > 0
 * here means user set temperature before pressing play (preview workflow).
 */
SequencerDevice.prototype.onTransportStart = function() {
    debug("transport", "Transport started");
    this.transportState.setPlaying(true);

    // V5.0: Do NOT call detectInstrumentType() here.
    // It creates a new TransposeStrategy instance, discarding the preserved
    // originalTranspose value and causing runaway octave shifting on quick
    // stop/start cycles (the deferred revert may not have landed yet when
    // the new strategy reads the param). Instrument detection is already
    // handled by init() and the device observer (setupDeviceObserver).

    // V3.1: If temperature was set before transport started, capture state now
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
 * V3.1: Undo transformations with temperature state priority.
 *
 * If temperature state exists (temp was > 0):
 *   - Restore TRUE base pitches from temperature state (no pitch sequencer adjustment)
 *   - Skip pitch sequencer delta undo (temperature already handles it)
 *
 * If no temperature state:
 *   - Use existing delta-based pitch undo
 */
SequencerDevice.prototype.onTransportStop = function() {
    debug("transport", "Transport stopped");

    // V4.1: Always revert parameter_transpose on stop, even without a clip
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
        return;
    }

    var clipId = clip.id;
    var trackType = this.trackState.type;

    // V3.1: Check if temperature state exists for this clip
    var hasTemperatureState = !!this.temperatureState[clipId];

    // Undo transformations based on last values
    if (this.lastValues[clipId] || hasTemperatureState) {
        try {
            if (trackType === 'midi') {
                var notesJson = clip.call("get_all_notes_extended");
                var notes = parseNotesResponse(notesJson);
                if (notes && notes.notes) {
                    var changed = false;

                    // V3.1: If temperature state exists, restore TRUE base pitches
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
                        // V4.1: parameter_transpose revert handled at top of function
                    } else {
                        // No temperature state - use delta-based pitch undo for note_transpose
                        if (this.lastValues[clipId] && this.lastValues[clipId].pitch === 1) {
                            // V4.1: parameter_transpose revert handled at top of function
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
            seq.lastParameterValue = undefined;  // V4.1: Reset for next transport start

            var cleanName = name.replace('Sequencer', '');
            this.sendSequencerPosition(cleanName);
        }
    }

    // Clear temperature observer (will be re-setup on next transport start if temp > 0)
    this.clearTemperatureLoopJumpObserver();

    // V3.1: Clear temperatureActive flag but KEEP temperatureValue
    // This allows the user to keep their temperature setting across transport cycles
    // The state will be re-captured fresh on next transport start
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

// ===== V3.0 BATCHING SYSTEM =====

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
 * Execute batch for MIDI clips.
 * V3.0: Apply deltas only on value change.
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

            // V4.0: Check if using parameter-based transpose
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
 * Execute batch for audio clips.
 * V3.0: Apply absolute state to gain/pitch_coarse parameters.
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

// ===== V4.0 INSTRUMENT DETECTION =====

/**
 * Detect instrument and configure transpose strategy.
 * V4.0: Name-based parameter detection.
 * Called on transport start and device changes.
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
 * Get the currently playing clip on the track.
 * Automatically sets up clip observers when clip changes.
 * @returns {LiveAPI|null} - Live API clip object or null if no clip playing
 */
SequencerDevice.prototype.getCurrentClip = function() {
    if (!this.trackState.ref) return null;

    try {
        // Try playing_slot_index first
        var slotIndex = this.trackState.ref.get("playing_slot_index");

        // If no playing slot, try fired_slot_index
        if (!slotIndex || slotIndex[0] < 0) {
            slotIndex = this.trackState.ref.get("fired_slot_index");
        }

        // Early exit if no slot found
        if (!slotIndex || slotIndex[0] < 0) return null;

        var clipPath = this.trackState.ref.path + " clip_slots " + slotIndex[0] + " clip";
        var clip = new LiveAPI(clipPath);

        if (clip && clip.id !== INVALID_LIVE_API_ID) {
            // Setup observers if clip changed
            if (this.clipState.hasChanged(clip.id)) {
                this.setupClipObservers(clip);
                this.clipState.update(clip.id);
            }
            return clip;
        }
        return null;
    } catch (error) {
        handleError("getCurrentClip", error, false);
        return null;
    }
};

// ===== SHARED SEQUENCER FUNCTIONALITY =====

/**
 * Convert bar.beat.tick format to absolute tick count.
 * Uses actual time signature from Live set for accurate conversion.
 * @param {number} bars - Number of bars
 * @param {number} beats - Number of beats
 * @param {number} ticks - Number of ticks
 * @returns {number} - Total ticks
 */
SequencerDevice.prototype.barBeatTickToTicks = function(bars, beats, ticks) {
    var ticksPerBeat = TICKS_PER_QUARTER_NOTE;
    var beatsPerBar = this.timeSignatureNumerator;
    var totalTicks = (bars * beatsPerBar * ticksPerBeat) + (beats * ticksPerBeat) + ticks;
    return totalTicks;
};

/**
 * Calculate ticks per step based on division setting.
 * Supports both legacy string format ("1/16") and bar.beat.tick array format.
 * @param {string|Array} division - Division format
 * @returns {number} - Ticks per step
 */
SequencerDevice.prototype.getTicksPerStep = function(division) {
    if (typeof division === "string") {
        // Legacy string format
        switch(division) {
            case "1/1":  return TICKS_PER_QUARTER_NOTE * 4;
            case "1/2":  return TICKS_PER_QUARTER_NOTE * 2;
            case "1/4":  return TICKS_PER_QUARTER_NOTE;
            case "1/8":  return TICKS_PER_QUARTER_NOTE / 2;
            case "1/16": return TICKS_PER_QUARTER_NOTE / 4;
            case "1/32": return TICKS_PER_QUARTER_NOTE / 8;
            case "1/64": return TICKS_PER_QUARTER_NOTE / 16;
            default: return TICKS_PER_QUARTER_NOTE / 4;
        }
    } else if (Array.isArray(division) && division.length === 3) {
        return this.barBeatTickToTicks(division[0], division[1], division[2]);
    } else {
        return 120; // Default to 16th notes
    }
};

/**
 * Process both sequencers from a single song time message.
 * V4.2: Unified entry point - single song_time drives both mute and pitch.
 *
 * Called every 16th note (120 ticks) with absolute tick position from transport.
 * This replaces the old separate "mute ticks" / "pitch ticks" message paths.
 *
 * V4.3: Adds lookahead so transformations are applied before the audio actually
 * plays, compensating for processing latency.
 *
 * @param {number} ticks - Absolute tick position from transport
 */
SequencerDevice.prototype.processWithSongTime = function(ticks) {
    // Lookahead: process ahead so transformations apply before audio plays
    // 120 ticks = 1 full 16th note - compensates for Live API latency
    var lookaheadTicks = 120;
    var targetTicks = ticks + lookaheadTicks;

    // Process both sequencers from single time source with lookahead
    this.processSequencerTick('mute', targetTicks);
    this.processSequencerTick('pitch', targetTicks);
};

/**
 * Generic tick processor for any sequencer.
 * V3.0: Calculates current step and schedules batch apply.
 * V4.1: Pitch sequencer with parameter_transpose works without a playing clip.
 *
 * @param {string} seqName - Sequencer name ('mute', 'pitch', etc.)
 * @param {number} ticks - Absolute tick position
 */
SequencerDevice.prototype.processSequencerTick = function(seqName, ticks) {
    var seq = this.sequencers[seqName + 'Sequencer'];

    if (!seq || !seq.isActive()) return;

    var newStep = seq.calculateStep(ticks);

    if (newStep === seq.currentStep) return;

    seq.currentStep = newStep;

    try {
        var value = seq.getCurrentValue();
        var clip = this.getCurrentClip();

        // V4.1: For pitch sequencer with parameter_transpose, we can apply directly
        // without a clip since we're just adjusting a device parameter
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
            // V3.0: Add to batch queue
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
 * Send only the current step position to Max UI (outlet 0) and OSC.
 * Called on every sequencer tick during playback — kept minimal for efficiency.
 *
 * @param {string} seqName - Sequencer name ('mute', 'pitch', etc.)
 */
SequencerDevice.prototype.sendSequencerPosition = function(seqName) {
    var seq = this.sequencers[seqName + 'Sequencer'];
    if (!seq) return;

    outlet(0, seqName + "_current", seq.currentStep);
    this.broadcastState('position');
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

    var data = [trackIndex];

    // Mute pattern (8 steps)
    for (var i = 0; i < 8; i++) {
        var value = (i < muteSeq.pattern.length) ? muteSeq.pattern[i] : muteSeq.valueType.default;
        data.push(value);
    }

    // Mute length
    data.push(muteSeq.patternLength);

    // Mute rate as division (bars, beats, ticks)
    var muteDivision = muteSeq.division || [1, 0, 0];
    if (Array.isArray(muteDivision)) {
        data.push(muteDivision[0] || 0);
        data.push(muteDivision[1] || 0);
        data.push(muteDivision[2] || 0);
    } else {
        data.push(1, 0, 0);
    }

    // Mute position
    data.push(muteSeq.currentStep);

    // Pitch pattern (8 steps)
    for (var i = 0; i < 8; i++) {
        var value = (i < pitchSeq.pattern.length) ? pitchSeq.pattern[i] : pitchSeq.valueType.default;
        data.push(value);
    }

    // Pitch length
    data.push(pitchSeq.patternLength);

    // Pitch rate as division (bars, beats, ticks)
    var pitchDivision = pitchSeq.division || [1, 0, 0];
    if (Array.isArray(pitchDivision)) {
        data.push(pitchDivision[0] || 0);
        data.push(pitchDivision[1] || 0);
        data.push(pitchDivision[2] || 0);
    } else {
        data.push(1, 0, 0);
    }

    // Pitch position
    data.push(pitchSeq.currentStep);

    // Temperature
    data.push(this.temperatureValue || 0.0);

    return data;
};

/**
 * Broadcast state to OSC output (outlet 1).
 * Sends state_broadcast with origin tag for external listeners.
 *
 * V6.0 Format (29 args):
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

    // Insert origin after trackIndex: [state_broadcast, trackIndex, origin, ...data]
    var args = ["state_broadcast", data[0], origin].concat(data.slice(1));
    outlet.apply(null, [1].concat(args));
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

// ===== INLET-AWARE MESSAGE HANDLERS (Phase 3) =====

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
 * Handle clip change event - resets sequencer state.
 * V3.1: Also handles temperature state cleanup and re-capture.
 * Called when user switches to a different clip.
 */
SequencerDevice.prototype.onClipChanged = function() {
    // V3.1: Handle temperature state on clip change
    // Clear old clip's state to prevent memory accumulation
    // Re-capture for new clip if temperature is still active
    if (Object.keys(this.temperatureState).length > 0) {
        this.temperatureState = {};  // Clear all old clip states
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

    // V3.0: lastValues are tracked per clipId, so no need to clear
    // Just clear sequencer caches
    for (var name in this.sequencers) {
        if (this.sequencers.hasOwnProperty(name)) {
            this.sequencers[name].invalidateCache();
            this.sequencers[name].lastState = null;
        }
    }
};

// ===== STATE PERSISTENCE =====

/**
 * Get current device state for saving/persistence (v3.0 format).
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
 * Restore device state from saved data (supports v1.x, v2.0, v2.1, v3.0, and v3.1 formats).
 * @param {Object} state - Saved device state
 */
SequencerDevice.prototype.setState = function(state) {
    // Handle v3.1, v3.0, v2.1, and v2.0 formats
    if ((state.version === '3.1' || state.version === '3.0' || state.version === '2.1' || state.version === '2.0') && state.sequencers) {
        for (var name in state.sequencers) {
            if (state.sequencers.hasOwnProperty(name) && this.sequencers[name + 'Sequencer']) {
                var savedSeq = state.sequencers[name];
                var seq = this.sequencers[name + 'Sequencer'];

                if (savedSeq.pattern) seq.setPattern(savedSeq.pattern);
                if (savedSeq.patternLength) seq.setLength(savedSeq.patternLength);
                // Note: 'enabled' no longer restored - derived from pattern content
                if (savedSeq.division) seq.setDivision(savedSeq.division, this.timeSignatureNumerator);

                // UI feedback only — caller handles broadcast
                this.sendSequencerState(name);
            }
        }

        // v3.1: Restore temperature
        if (state.temperature !== undefined) {
            this.setTemperatureValue(state.temperature);
            this.sendTemperatureState();
        }
    }
    // Handle legacy v1.x format (backward compatibility)
    else {
        if (state.mute && this.sequencers.muteSequencer) {
            var muteSeq = this.sequencers.muteSequencer;
            if (state.mute.pattern) muteSeq.setPattern(state.mute.pattern);
            if (state.mute.patternLength) muteSeq.setLength(state.mute.patternLength);
            if (state.mute.division) muteSeq.setDivision(state.mute.division, this.timeSignatureNumerator);
            this.sendSequencerState('mute');
        }

        if (state.pitch && this.sequencers.pitchSequencer) {
            var pitchSeq = this.sequencers.pitchSequencer;
            if (state.pitch.pattern) pitchSeq.setPattern(state.pitch.pattern);
            if (state.pitch.patternLength) pitchSeq.setLength(state.pitch.patternLength);
            if (state.pitch.division) pitchSeq.setDivision(state.pitch.division, this.timeSignatureNumerator);
            this.sendSequencerState('pitch');
        }
    }
};

// ===== GLOBAL INSTANCE =====
var sequencer = new SequencerDevice();

// ===== MAX MESSAGE HANDLERS =====
// Named global functions exposed to Max for message handling.
// With Phase 3 inlet separation, most messages route through anything() which
// delegates to handleTransport(), handleOSCCommand(), or handleMaxUICommand()
// based on the inlet global. init/bang/clip_changed/notifydeleted remain as
// named globals called directly by Max, not via inlet routing.

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


// Main message handler
function msg_int() {
}

function msg_float() {
}

/**
 * Inlet-aware message router (Phase 3).
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
