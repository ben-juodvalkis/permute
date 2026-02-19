/**
 * permute-device.js - Dual mute/pitch sequencer for Max4Live
 *
 * Main device controller. Coordinates sequencers, observers, transport handling,
 * clip management, and state persistence.
 *
 * Modularized in v4.3: core logic split into focused CommonJS modules.
 *
 * @version 4.3
 * @requires Max4Live JavaScript API
 */

autowatch = 1;
inlets = 1;
outlets = 1; // UI feedback only

// ===== MODULE IMPORTS =====
var constants = require('permute-constants');
var TICKS_PER_QUARTER_NOTE = constants.TICKS_PER_QUARTER_NOTE;
var MIDI_MIN = constants.MIDI_MIN;
var MIDI_MAX = constants.MIDI_MAX;
var OCTAVE_SEMITONES = constants.OCTAVE_SEMITONES;
var DEFAULT_TIME_SIGNATURE = constants.DEFAULT_TIME_SIGNATURE;
var MAX_PATTERN_LENGTH = constants.MAX_PATTERN_LENGTH;
var MIN_PATTERN_LENGTH = constants.MIN_PATTERN_LENGTH;
var DEFAULT_GAIN_VALUE = constants.DEFAULT_GAIN_VALUE;
var MUTED_GAIN = constants.MUTED_GAIN;
var DEFAULT_DRUM_RACK_TRANSPOSE = constants.DEFAULT_DRUM_RACK_TRANSPOSE;
var INVALID_LIVE_API_ID = constants.INVALID_LIVE_API_ID;
var TASK_SCHEDULE_DELAY = constants.TASK_SCHEDULE_DELAY;

var utils = require('permute-utils');
var debug = utils.debug;
var handleError = utils.handleError;
var parseNotesResponse = utils.parseNotesResponse;
var findTransposeParameterByName = utils.findTransposeParameterByName;
var createObserver = utils.createObserver;
var defer = utils.defer;

var Sequencer = require('permute-sequencer').Sequencer;
var ObserverRegistry = require('permute-observer-registry').ObserverRegistry;
var stateClasses = require('permute-state');
var TrackState = stateClasses.TrackState;
var ClipState = stateClasses.ClipState;
var TransportState = stateClasses.TransportState;
var instruments = require('permute-instruments');
var InstrumentDetector = instruments.InstrumentDetector;
var TransposeStrategy = instruments.TransposeStrategy;
var DefaultInstrumentStrategy = instruments.DefaultInstrumentStrategy;
var CommandRegistry = require('permute-commands').CommandRegistry;
var temperature = require('permute-temperature');

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

    // Initialization lifecycle flag - prevents pattr_state output during init/restore window
    this.initialized = false;

    // Time signature tracking
    this.timeSignatureNumerator = 4; // Default to 4/4

    // Device identification
    this.deviceId = this.generateDeviceId();
    this.liveDeviceId = null;  // Cached Live API device ID for OSC command filtering

    // Command registry for message handling
    this.commandRegistry = new CommandRegistry();
    this.setupCommandHandlers();

    // Legacy compatibility - keep references for old code paths
    // FIXED: Renamed to avoid collision with mute() function
    this.muteSeq = this.sequencers.muteSequencer;
    this.pitchSeq = this.sequencers.pitchSequencer;
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

    // Song time handler - single message drives both sequencers
    // Receives absolute tick position from Max transport every 16th note
    this.commandRegistry.register('song_time', function(args) {
        if (args.length >= 1) {
            var ticks = args[0];
            self.processWithSongTime(ticks);
        }
    });

    // Legacy sequencer commands (for backward compatibility during migration)
    this.commandRegistry.register('tick', function(args) {
        if (args.length > 1) {
            self.processSequencerTick(args.seqName, args[1]);
        }
    });

    this.commandRegistry.register('pattern', function(args) {
        var seq = args.seq;
        seq.pattern = args.slice(1);
        seq.patternLength = seq.pattern.length;
        self.sendSequencerFeedback(args.seqName);
    });

    this.commandRegistry.register('step', function(args) {
        if (args.length > 2) {
            var seq = args.seq;
            var index = args[1];
            var value = args[2];
            if (index >= 0 && index < seq.pattern.length) {
                seq.pattern[index] = value;
                self.sendSequencerFeedback(args.seqName);
            }
        }
    });

    // Note: 'enable' command removed - sequencers auto-activate based on pattern content

    this.commandRegistry.register('division', function(args) {
        var seq = args.seq;
        if (args.length === 4) {
            seq.division = [args[1], args[2], args[3]];
        } else if (args.length === 2) {
            seq.division = args[1];
        }
        seq.ticksPerStep = self.getTicksPerStep(seq.division);
    });

    this.commandRegistry.register('length', function(args) {
        var seq = args.seq;
        seq.patternLength = Math.max(MIN_PATTERN_LENGTH, Math.min(MAX_PATTERN_LENGTH, args[1]));
        if (seq.currentStep >= seq.patternLength) {
            seq.currentStep = 0;
        }
    });

    this.commandRegistry.register('reset', function(args) {
        var seq = args.seq;
        seq.currentStep = 0;
        self.sendSequencerFeedback(args.seqName);
    });

    this.commandRegistry.register('bypass', function(args) {
        if (args.seqName === 'mute') {
            args.seq.bypass = args[1] !== 0;
        }
    });

    // ===== OSC COMMAND HANDLERS (Phase 2) =====
    // These handlers receive commands from Svelte UI via OSC bridge
    // All commands include deviceId as first arg for filtering

    // Helper to check if command is for this device
    function isForThisDevice(deviceId) {
        return self.liveDeviceId !== null && parseInt(deviceId) === self.liveDeviceId;
    }

    // Mute sequencer commands
    this.commandRegistry.register('seq_mute_step', function(args) {
        // args: [deviceId, stepIndex, value]
        if (args.length < 3 || !isForThisDevice(args[0])) return;
        var stepIndex = parseInt(args[1]);
        var value = parseInt(args[2]);
        self.sequencers.muteSequencer.setStep(stepIndex, value);
        self.broadcastState('mute_step');
    });

    this.commandRegistry.register('seq_mute_length', function(args) {
        // args: [deviceId, length]
        if (args.length < 2 || !isForThisDevice(args[0])) return;
        var length = parseInt(args[1]);
        self.sequencers.muteSequencer.setLength(length);
        self.broadcastState('mute_length');
    });

    this.commandRegistry.register('seq_mute_rate', function(args) {
        // args: [deviceId, bars, beats, ticks]
        if (args.length < 4 || !isForThisDevice(args[0])) return;
        var bars = parseInt(args[1]);
        var beats = parseInt(args[2]);
        var ticks = parseInt(args[3]);
        self.sequencers.muteSequencer.setDivision([bars, beats, ticks], self.timeSignatureNumerator);
        self.broadcastState('mute_rate');
    });

    // Pitch sequencer commands
    this.commandRegistry.register('seq_pitch_step', function(args) {
        // args: [deviceId, stepIndex, value]
        if (args.length < 3 || !isForThisDevice(args[0])) return;
        var stepIndex = parseInt(args[1]);
        var value = parseInt(args[2]);
        self.sequencers.pitchSequencer.setStep(stepIndex, value);
        self.broadcastState('pitch_step');
    });

    this.commandRegistry.register('seq_pitch_length', function(args) {
        // args: [deviceId, length]
        if (args.length < 2 || !isForThisDevice(args[0])) return;
        var length = parseInt(args[1]);
        self.sequencers.pitchSequencer.setLength(length);
        self.broadcastState('pitch_length');
    });

    this.commandRegistry.register('seq_pitch_rate', function(args) {
        // args: [deviceId, bars, beats, ticks]
        if (args.length < 4 || !isForThisDevice(args[0])) return;
        var bars = parseInt(args[1]);
        var beats = parseInt(args[2]);
        var ticks = parseInt(args[3]);
        self.sequencers.pitchSequencer.setDivision([bars, beats, ticks], self.timeSignatureNumerator);
        self.broadcastState('pitch_rate');
    });

    // Temperature command
    this.commandRegistry.register('seq_temperature', function(args) {
        // args: [deviceId, value]
        if (args.length < 2 || !isForThisDevice(args[0])) return;
        var value = parseFloat(args[1]);
        // Reuse existing temperature logic
        self.setTemperatureValue(value);
        self.broadcastState('temperature');
    });

    // Complete state command (for ghost editing sync)
    this.commandRegistry.register('set_state', function(args) {
        // args: [deviceId, mutePattern[8], muteLength, muteBars, muteBeats, muteTicks,
        //        pitchPattern[8], pitchLength, pitchBars, pitchBeats, pitchTicks, temperature]
        // Total: 26 args (1 + 8 + 1 + 3 + 8 + 1 + 3 + 1)
        post('[set_state] Received ' + args.length + ' args, deviceId=' + args[0] + '\n');
        if (args.length < 24) {
            post('[set_state] REJECTED: not enough args\n');
            return;
        }
        if (!isForThisDevice(args[0])) {
            post('[set_state] REJECTED: not for this device (my id=' + new LiveAPI('this_device').id + ')\n');
            return;
        }
        post('[set_state] ACCEPTED for this device\n');

        var idx = 1;  // Skip deviceId

        // Mute pattern (8 steps)
        var mutePattern = [];
        for (var i = 0; i < 8; i++) {
            mutePattern.push(parseInt(args[idx++]));
        }
        post('[set_state] Mute pattern to set: ' + mutePattern.join(',') + '\n');
        self.sequencers.muteSequencer.setPattern(mutePattern);

        // Mute length and rate
        self.sequencers.muteSequencer.setLength(parseInt(args[idx++]));
        var muteBars = parseInt(args[idx++]);
        var muteBeats = parseInt(args[idx++]);
        var muteTicks = parseInt(args[idx++]);
        self.sequencers.muteSequencer.setDivision([muteBars, muteBeats, muteTicks], self.timeSignatureNumerator);

        // Pitch pattern (8 steps)
        var pitchPattern = [];
        for (var i = 0; i < 8; i++) {
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

        self.broadcastState('set_state_ack');
    });
};

// ===== INITIALIZATION =====

/**
 * Initialize the sequencer device.
 * Establishes track reference, detects track/instrument types, and sets up observers.
 */
SequencerDevice.prototype.init = function() {
    post('[INIT-SEQUENCE] init() called at ' + Date.now() + '\n');
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

            // Send initial feedback for all sequencers (UI feedback only, no broadcast)
            for (var seqName in this.sequencers) {
                if (this.sequencers.hasOwnProperty(seqName)) {
                    var cleanName = seqName.replace('Sequencer', '');
                    this.sendSequencerFeedbackLocal(cleanName);
                }
            }

            // Send initial state broadcast with 'init' origin
            this.broadcastState('init');

            this.initialized = true;
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

    // Detect instrument type for pitch transformation
    this.detectInstrumentType();

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
                this.sendSequencerFeedback(cleanName);
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

            // Send updated feedback
            var cleanName = name.replace('Sequencer', '');
            this.sendSequencerFeedback(cleanName);
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

// Apply temperature methods mixin to SequencerDevice prototype
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

    // Scan for transpose parameter by name
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
        debug("instrument", "No transpose param found, using note-based shifting");
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
 * Generic handler for sequencer messages (used by both mute and pitch sequencers)
 * @param {Object} seq - The sequencer object
 * @param {String} seqName - Name of sequencer ('mute' or 'pitch')
 * @param {Array} args - Message arguments
 */
SequencerDevice.prototype.handleSequencerMessage = function(seq, seqName, args) {
    var parameter = args[0];

    // Augment args with context for command handlers
    args.seq = seq;
    args.seqName = seqName;

    // Use command registry
    if (!this.commandRegistry.execute(parameter, args, this)) {
        debug("handleSequencerMessage", "Unknown command: " + parameter);
    }
};

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
            this.sendSequencerFeedback(seqName);
            return;
        }

        // For other cases (mute, or pitch with note_transpose), we need a clip
        if (clip) {
            // V3.0: Add to batch queue
            this.scheduleBatchApply(clip.id, seqName, value);
        }

        this.sendSequencerFeedback(seqName);
    } catch (error) {
        handleError("processSequencerTick:" + seqName, error, false);
    }
};

/**
 * Send feedback to Max UI only (no OSC broadcast).
 * Used during init to avoid triggering 'position' origin broadcasts.
 *
 * @param {string} seqName - Sequencer name ('mute', 'pitch', etc.)
 */
SequencerDevice.prototype.sendSequencerFeedbackLocal = function(seqName) {
    var seq = this.sequencers[seqName + 'Sequencer'];
    if (!seq) return;

    // Update first 8 step toggles (Max UI displays 8 steps)
    for (var i = 0; i < 8; i++) {
        var value = (i < seq.pattern.length) ? seq.pattern[i] : seq.valueType.default;
        outlet(0, seqName + "_step_" + i, value);
    }

    // Current step indicator
    outlet(0, seqName + "_current", seq.currentStep);

    // Active state (derived from pattern content)
    outlet(0, seqName + "_active", seq.isActive() ? 1 : 0);
};

/**
 * Generic feedback sender for any sequencer.
 * Sends pattern, current step, and active state to Max UI.
 * Also broadcasts state for multi-track display (used during playback).
 *
 * @param {string} seqName - Sequencer name ('mute', 'pitch', etc.)
 */
SequencerDevice.prototype.sendSequencerFeedback = function(seqName) {
    // Send local feedback to Max UI
    this.sendSequencerFeedbackLocal(seqName);

    // Broadcast state for multi-track sequencer display
    // During playback, this is a position update
    this.broadcastState('position');
};

/**
 * Broadcast combined sequencer state for multi-track display.
 * Sends a single OSC message containing all sequencer state for this track.
 *
 * V6.0 Format (29 args - enabled flags removed, derived from pattern):
 *   trackIndex (0),
 *   origin (1),
 *   mutePattern[8] (2-9),
 *   muteLength (10), muteBars (11), muteBeats (12), muteTicks (13),
 *   mutePosition (14),
 *   pitchPattern[8] (15-22),
 *   pitchLength (23), pitchBars (24), pitchBeats (25), pitchTicks (26),
 *   pitchPosition (27),
 *   temperature (28)
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
 *   'pattr_restore' - Restored from Live Set / pattr
 *
 * This is routed by Max patch to: /looping/sequencer/state
 *
 * @param {string} origin - Why this broadcast is happening (default: 'unknown')
 */
SequencerDevice.prototype.broadcastState = function(origin) {
    origin = origin || 'unknown';
    var trackIndex = this.trackState.index;

    // Skip if track index not yet determined
    if (trackIndex < 0) return;

    var muteSeq = this.sequencers.muteSequencer;
    var pitchSeq = this.sequencers.pitchSequencer;

    // Skip if sequencers not initialized
    if (!muteSeq || !pitchSeq) return;

    var args = ["state_broadcast", trackIndex, origin];

    // Mute pattern (8 steps) - args 1-8
    for (var i = 0; i < 8; i++) {
        var value = (i < muteSeq.pattern.length) ? muteSeq.pattern[i] : muteSeq.valueType.default;
        args.push(value);
    }

    // Mute length - arg 9
    args.push(muteSeq.patternLength);

    // Mute rate as division (bars, beats, ticks) - args 10-12
    var muteDivision = muteSeq.division || [1, 0, 0];
    if (Array.isArray(muteDivision)) {
        args.push(muteDivision[0] || 0);  // bars
        args.push(muteDivision[1] || 0);  // beats
        args.push(muteDivision[2] || 0);  // ticks
    } else {
        // Legacy string format - convert to default
        args.push(1, 0, 0);  // default 1 bar
    }

    // Mute position - arg 13 (enabled removed - derived from pattern)
    args.push(muteSeq.currentStep);

    // Pitch pattern (8 steps) - args 14-21
    for (var i = 0; i < 8; i++) {
        var value = (i < pitchSeq.pattern.length) ? pitchSeq.pattern[i] : pitchSeq.valueType.default;
        args.push(value);
    }

    // Pitch length - arg 22
    args.push(pitchSeq.patternLength);

    // Pitch rate as division (bars, beats, ticks) - args 23-25
    var pitchDivision = pitchSeq.division || [1, 0, 0];
    if (Array.isArray(pitchDivision)) {
        args.push(pitchDivision[0] || 0);  // bars
        args.push(pitchDivision[1] || 0);  // beats
        args.push(pitchDivision[2] || 0);  // ticks
    } else {
        // Legacy string format - convert to default
        args.push(1, 0, 0);  // default 1 bar
    }

    // Pitch position - arg 26 (enabled removed - derived from pattern)
    args.push(pitchSeq.currentStep);

    // Temperature - arg 27
    args.push(this.temperatureValue || 0.0);

    // Send via outlet 0 - Max patch will route to OSC
    outlet.apply(null, [0].concat(args));

    // Also output for pattr storage (28-arg list WITHOUT origin)
    // pattr_state format: trackIndex, mutePattern[8], muteLength, muteBars, muteBeats, muteTicks,
    //                     mutePosition, pitchPattern[8], pitchLength, pitchBars,
    //                     pitchBeats, pitchTicks, pitchPosition, temperature
    // args is: ["state_broadcast", trackIndex, origin, data...]
    // We want: ["pattr_state", trackIndex, data...] (skip origin at index 2)
    // Skip for position updates - they happen constantly during playback and don't need persistence
    // Skip for pattr_restore - we just loaded from pattr, no need to save back (prevents feedback loop)
    if (this.initialized && origin !== 'position' && origin !== 'pattr_restore' && origin !== 'init') {
        var pattrArgs = ["pattr_state", args[1]].concat(args.slice(3));
        outlet.apply(null, [0].concat(pattrArgs));
    }
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

                this.sendSequencerFeedback(name);
            }
        }

        // v3.1: Restore temperature
        if (state.temperature !== undefined) {
            this.setTemperatureValue(state.temperature);
        }
    }
    // Handle legacy v1.x format (backward compatibility)
    else {
        if (state.mute && this.sequencers.muteSequencer) {
            var muteSeq = this.sequencers.muteSequencer;
            if (state.mute.pattern) muteSeq.setPattern(state.mute.pattern);
            if (state.mute.patternLength) muteSeq.setLength(state.mute.patternLength);
            if (state.mute.division) muteSeq.setDivision(state.mute.division, this.timeSignatureNumerator);
            this.sendSequencerFeedback('mute');
        }

        if (state.pitch && this.sequencers.pitchSequencer) {
            var pitchSeq = this.sequencers.pitchSequencer;
            if (state.pitch.pattern) pitchSeq.setPattern(state.pitch.pattern);
            if (state.pitch.patternLength) pitchSeq.setLength(state.pitch.patternLength);
            if (state.pitch.division) pitchSeq.setDivision(state.pitch.division, this.timeSignatureNumerator);
            this.sendSequencerFeedback('pitch');
        }
    }
};

// ===== GLOBAL INSTANCE =====
var sequencer = new SequencerDevice();

// ===== MAX MESSAGE HANDLERS =====
// These functions handle incoming messages from Max

/**
 * Handle all mute sequencer messages.
 * Commands: pattern, step, enable, division, length, reset, bypass, tick
 */
function mute() {
    var args = arrayfromargs(arguments);
    sequencer.handleSequencerMessage(sequencer.muteSeq, 'mute', args);
}

/**
 * Handle all pitch sequencer messages.
 * Commands: pattern, step, enable, division, length, reset, tick
 */
function pitch() {
    var args = arrayfromargs(arguments);
    sequencer.handleSequencerMessage(sequencer.pitchSeq, 'pitch', args);
}

/**
 * Handle song time messages from Max transport.
 * V4.2: Single message drives both mute and pitch sequencers.
 *
 * Called every 16th note (120 ticks) with absolute tick position.
 * Max patch sends: song_time <ticks>
 *
 * Usage: song_time 480  (at beat 2)
 *        song_time 960  (at beat 3)
 */
function song_time() {
    var args = arrayfromargs(arguments);
    if (args.length >= 1) {
        sequencer.commandRegistry.execute('song_time', args, sequencer);
    }
}

// ===== OSC COMMAND HANDLERS (Phase 2) =====
// These functions handle OSC commands routed from Max patch
// Each command includes deviceId as first arg for multi-device filtering

function seq_mute_step() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_mute_step', args, sequencer);
}

function seq_mute_length() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_mute_length', args, sequencer);
}

function seq_mute_rate() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_mute_rate', args, sequencer);
}

function seq_pitch_step() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_pitch_step', args, sequencer);
}

function seq_pitch_length() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_pitch_length', args, sequencer);
}

function seq_pitch_rate() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_pitch_rate', args, sequencer);
}

function seq_temperature() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('seq_temperature', args, sequencer);
}

function set_state() {
    var args = arrayfromargs(arguments);
    sequencer.commandRegistry.execute('set_state', args, sequencer);
}

/**
 * Handle temperature transformation messages.
 * V3.1: Value-based enable/disable with note ID tracking for reversibility.
 *
 * Behavior:
 * - temperature 0 -> >0: Capture original pitches by note ID, start shuffling
 * - temperature >0 -> 0: Restore original pitches, stop shuffling
 * - temperature >0 -> >0: Just change intensity (no re-capture)
 *
 * Usage: temperature 0.7  (capture originals if first time, start shuffling)
 *        temperature 0.0  (restore originals, stop shuffling)
 */
function temperature() {
    var args = arrayfromargs(arguments);

    if (args.length < 1) {
        handleError("temperature", new Error("No temperature value provided"), false);
        return;
    }

    var rawValue = args[0];
    var newTemperatureValue = Math.max(0.0, Math.min(1.0, parseFloat(rawValue)));

    // Detect transition type
    var wasActive = sequencer.temperatureValue > 0;
    var willBeActive = newTemperatureValue > 0;

    // Get current clip for state operations
    var clip = sequencer.getCurrentClip();
    var clipId = clip ? clip.id : null;

    // V3.1: Handle state transitions
    if (!wasActive && willBeActive) {
        // Transition: 0 -> >0 (enable)
        // Capture original pitches before any shuffling
        if (clipId) {
            sequencer.captureTemperatureState(clipId);
        }
        debug("temperature", "Enabled: captured original state");
    } else if (wasActive && !willBeActive) {
        // Transition: >0 -> 0 (disable)
        // Restore original pitches
        if (clipId) {
            sequencer.restoreTemperatureState(clipId);
        }
        debug("temperature", "Disabled: restored original state");
    }
    // else: >0 -> >0 (intensity change only, no capture/restore)

    // Update temperature value
    sequencer.temperatureValue = newTemperatureValue;
    sequencer.temperatureActive = willBeActive;

    // Setup or clear loop jump observer
    if (willBeActive) {
        sequencer.setupTemperatureLoopJumpObserver();
    } else {
        sequencer.clearTemperatureLoopJumpObserver();
    }

    debug("temperature", "Set temperature to " + newTemperatureValue);
}

/**
 * Reset temperature to original state.
 * V3.1: Uses note ID tracking to restore original pitches.
 * Usage: temperature_reset
 */
function temperature_reset() {
    debug("temperature", "Reset requested");

    var clip = sequencer.getCurrentClip();
    var clipId = clip ? clip.id : null;

    // V3.1: Restore original pitches if we have temperature state
    if (clipId && sequencer.temperatureState[clipId]) {
        sequencer.restoreTemperatureState(clipId);
    }

    // Turn off temperature
    sequencer.temperatureValue = 0.0;
    sequencer.temperatureActive = false;
    sequencer.clearTemperatureLoopJumpObserver();
}

/**
 * Force new variation with current temperature.
 * V3.0: Manually triggers loop jump handler.
 * Usage: temperature_shuffle
 */
function temperature_shuffle() {
    if (!sequencer.temperatureActive || sequencer.temperatureValue <= 0) {
        debug("temperature", "Shuffle requested but temperature not active");
        return;
    }

    debug("temperature", "Manual shuffle requested");
    sequencer.onTemperatureLoopJump();
}

function init() {
    sequencer.init();
}

// Support bang message for initialization
function bang() {
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
 * Restore state from pattr (28-arg list format matching ADR-166).
 * Called on Live Set load via: [route pattr_state] -> [prepend restoreState] -> v8
 *
 * Args (28 total):
 *   trackIndex (0),
 *   mutePattern[8] (1-8), muteLength (9), muteBars (10), muteBeats (11), muteTicks (12),
 *   mutePosition (13),
 *   pitchPattern[8] (14-21), pitchLength (22), pitchBars (23), pitchBeats (24), pitchTicks (25),
 *   pitchPosition (26),
 *   temperature (27)
 *
 * Note: muteEnabled/pitchEnabled removed in ADR-166 - now derived from pattern content.
 */
function restoreState() {
    var args = arrayfromargs(arguments);
    post('[INIT-SEQUENCE] restoreState() called at ' + Date.now() + ' with ' + args.length + ' args\n');

    if (args.length < 28) {
        post('[RESTORE] Not enough args (expected 28, got ' + args.length + '), skipping\n');
        return;
    }

    // Parse flat 28-arg format into JSON state object and delegate to setState()
    var idx = 1;  // Skip trackIndex (arg 0)

    var mutePattern = [];
    for (var i = 0; i < 8; i++) mutePattern.push(parseInt(args[idx++]));
    var muteLength = parseInt(args[idx++]);
    var muteDivision = [parseInt(args[idx++]), parseInt(args[idx++]), parseInt(args[idx++])];
    idx++; // skip mute position (runtime state)

    var pitchPattern = [];
    for (var i = 0; i < 8; i++) pitchPattern.push(parseInt(args[idx++]));
    var pitchLength = parseInt(args[idx++]);
    var pitchDivision = [parseInt(args[idx++]), parseInt(args[idx++]), parseInt(args[idx++])];
    idx++; // skip pitch position (runtime state)

    var temp = parseFloat(args[idx++]);

    // Delegate to setState() which uses proper setters (setPattern, setLength, setDivision, setTemperatureValue)
    sequencer.setState({
        version: '3.1',
        sequencers: {
            mute: { pattern: mutePattern, patternLength: muteLength, division: muteDivision },
            pitch: { pattern: pitchPattern, patternLength: pitchLength, division: pitchDivision }
        },
        temperature: temp
    });

    sequencer.initialized = true;
    post('[RESTORE] State restored via setState(), broadcasting...\n');
    sequencer.broadcastState('pattr_restore');
}

// Main message handler
function msg_int() {
}

function msg_float() {
}

// Handle all other messages - routes OSC addresses to command handlers
function anything() {
    var address = messagename;
    var args = arrayfromargs(arguments);

    // Log ALL incoming messages to see what's arriving
    post('anything() received: ' + address + ' args: ' + args.join(', ') + '\n');

    // Only handle /looping/sequencer/ messages
    if (address.indexOf('/looping/sequencer/') !== 0) {
        post('  -> ignoring (not /looping/sequencer/)\n');
        return;
    }

    // Strip prefix and convert to command name
    // /looping/sequencer/mute/step -> seq_mute_step
    // /looping/sequencer/set/state -> set_state
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
        post('Unknown sequencer command: ' + address + '\n');
        return;
    }

    post('OSC -> ' + command + ' ' + args.join(' ') + '\n');
    sequencer.commandRegistry.execute(command, args, sequencer);
}

// Handle loadbang
function loadbang() {
}

// ===== STATE PERSISTENCE (pattrstorage) =====
// These functions are called by pattrstorage to save/restore state with Live Set

/**
 * Called by pattrstorage when Live saves the set.
 * Returns sequencer state as JSON string.
 */
function getvalueof() {
    var state = sequencer.getState();
    var json = JSON.stringify(state);
    debug("getvalueof", "Saving state", { version: state.version, temperature: state.temperature });
    return json;
}

/**
 * Called by pattrstorage when Live loads a set.
 * Restores sequencer state from JSON string.
 */
function setvalueof(v) {
    post('[INIT-SEQUENCE] setvalueof() called at ' + Date.now() + '\n');
    if (v && typeof v === 'string') {
        try {
            var state = JSON.parse(v);
            debug("setvalueof", "Restoring state", { version: state.version });
            sequencer.setState(state);
            sequencer.initialized = true;
            sequencer.broadcastState('pattr_restore');
        } catch (e) {
            handleError("setvalueof", e, true);
        }
    }
}

// Handle notifydeleted
function notifydeleted() {
    // Use observer registry for cleanup (includes temperature_loop_jump)
    sequencer.observerRegistry.clearAll();
    sequencer.temperatureLoopJumpObserver = null;
}
