/**
 * permute-device.js - Dual mute/pitch sequencer for Max4Live
 *
 * Main device controller and Max message handlers.
 * Logic is modularized into CommonJS modules.
 *
 * @requires Max4Live JavaScript API
 */

autowatch = 1;
inlets = 2;  // 0: Transport (song_time), 1: Max UI messages
outlets = 1; // 0: Step position output (mute_current / pitch_current)

// ===== MODULE IMPORTS =====
var constants = require('permute-constants');
var utils = require('permute-utils');
var Sequencer = require('permute-sequencer').Sequencer;
var ObserverRegistry = require('permute-observer-registry').ObserverRegistry;
var stateClasses = require('permute-state');
var instruments = require('permute-instruments');
var temperature = require('permute-temperature');
var chance = require('permute-chance');

var OCTAVE_SEMITONES = constants.OCTAVE_SEMITONES;
var DEFAULT_GAIN_VALUE = constants.DEFAULT_GAIN_VALUE;
var MUTED_GAIN = constants.MUTED_GAIN;
var INVALID_LIVE_API_ID = constants.INVALID_LIVE_API_ID;
var ticksForRateEnum = constants.ticksForRateEnum;

var debug = utils.debug;
var handleError = utils.handleError;
var parseNotesResponse = utils.parseNotesResponse;
var findTransposeParameterByName = utils.findTransposeParameterByName;
var isParameterTransposeDevice = utils.isParameterTransposeDevice;
var createObserver = utils.createObserver;
var defer = utils.defer;

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

    // Chance (note probability) state (non-sequenced)
    this.chanceValue = 1.0;

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

    // Time signature tracking
    this.timeSignatureNumerator = 4; // Default to 4/4

    // Debounce handle for coalesced instrument re-detection
    this._pendingDetectionTask = null;
}

// ===== INITIALIZATION =====

/**
 * Initialize the sequencer device.
 * Establishes track reference, detects track/instrument types, and sets up observers.
 */
SequencerDevice.prototype.init = function() {
    debug("init", "Starting sequencer initialization");
    try {
        var thisDevice = new LiveAPI("this_device");

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
            this.trackState.index = this.trackState.extractIndexFromPath(track.path);

            this.detectInstrumentType();
            this.setupDeviceObserver();
            this.setupTransportObserver();
            this.setupTimeSignatureObserver();

            debug("init", "Initialization complete", {
                trackType: this.trackState.type,
                instrumentType: this.instrumentType
            });
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
            // Hard-detach the stale instrument_params observer SYNCHRONOUSLY,
            // before Live's dispatcher queues more notifications against it.
            // A Simpler.replace_sample fires a burst of ~20 devices notifications
            // in ~50ms; each one would otherwise find instrument_params still
            // bound to a stale path and SendMessage into _path_listener_callback.
            self.observerRegistry.unregister('instrument_params');
            self.instrumentDevice = null;
            self.instrumentDeviceId = null;
            if (self.instrumentStrategy && self.instrumentStrategy.transposeParam) {
                self.instrumentStrategy.transposeParam = null;
            }
            // Coalesce burst into a single detection after the tree settles.
            self._scheduleDetection();
        }
    );

    this.observerRegistry.register('device', observer);
};

/**
 * Debounced re-detection. A burst of 'devices' notifications (e.g. during
 * Simpler.replace_sample) collapses to one detectInstrumentType call after
 * the last notification + DETECTION_DEBOUNCE_MS. Last-wins semantics.
 */
var DETECTION_DEBOUNCE_MS = 75;

SequencerDevice.prototype._scheduleDetection = function() {
    var self = this;
    if (this._pendingDetectionTask) {
        try { this._pendingDetectionTask.cancel(); } catch (e) {}
    }
    if (typeof Task === 'undefined') {
        // Fallback: run inline if Task isn't available (non-Max test env).
        try {
            if (self.instrumentType === 'parameter_transpose' && self.instrumentStrategy) {
                self.instrumentStrategy.revertTranspose();
            }
            self.detectInstrumentType();
        } catch (error) {
            handleError("_scheduleDetection", error, false);
        }
        return;
    }
    this._pendingDetectionTask = new Task(function() {
        self._pendingDetectionTask = null;
        if (!self.trackState.ref || self.trackState.ref.id === INVALID_LIVE_API_ID) {
            return;
        }
        try {
            if (self.instrumentType === 'parameter_transpose' &&
                self.instrumentStrategy &&
                typeof self.instrumentStrategy.revertTranspose === 'function') {
                self.instrumentStrategy.revertTranspose();
            }
            self.detectInstrumentType();
        } catch (error) {
            handleError("_scheduleDetection", error, false);
        }
    }, this);
    this._pendingDetectionTask.schedule(DETECTION_DEBOUNCE_MS);
};

/**
 * Setup observer on the current instrument device's parameters list.
 * Fires when macros are added/renamed/remapped — covers the case where
 * detection ran before the rack had named its transpose macro, and the
 * case where the user renames a macro after initial detection.
 */
SequencerDevice.prototype.setupInstrumentParamsObserver = function() {
    if (!this.instrumentDevice || this.instrumentDevice.id === INVALID_LIVE_API_ID) {
        this.observerRegistry.unregister('instrument_params');
        return;
    }

    var self = this;
    var observer = createObserver(
        this.instrumentDevice.path,
        "parameters",
        function(args) {
            // Only re-detect if we're not already on parameter_transpose —
            // if we're already mapped, a macro list change might just be
            // a user tweak and shouldn't blow away our strategy. This guard
            // runs synchronously (not inside defer) so that a burst of
            // parameter-list mutations from Simpler.replace_sample is a no-op
            // once we've already landed on parameter_transpose.
            if (self.instrumentType === 'parameter_transpose') return;

            // Coalesce bursts (Simpler.replace_sample fires many parameter
            // notifications) into one debounced detection via _scheduleDetection.
            self._scheduleDetection();
        }
    );

    this.observerRegistry.register('instrument_params', observer);
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
                        self.sequencers[name].refreshTicksPerStep(numerator);
                    }
                }

                debug("timeSignature", "Updated to " + numerator + "/4");
            }
        }
    );

    this.observerRegistry.register('timeSignature', observer);
};

// ===== TRANSPORT HANDLING =====

/**
 * Handle transport start.
 * Captures temperature state if temperature was set before playback.
 * Re-applies chance to clip (in case notes were added while stopped).
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

    // Apply chance to clip if active
    if (this.chanceValue < 1.0) {
        this.applyChanceToClip();
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
        for (var name in this.sequencers) {
            if (this.sequencers.hasOwnProperty(name)) {
                var seq = this.sequencers[name];
                seq.currentStep = -1;
                seq.lastParameterValue = undefined;
                outlet(0, name.replace('Sequencer', '') + "_current", -1);
            }
        }
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
                        clip.set("gain", this.lastValues[clipId].originalGain || DEFAULT_GAIN_VALUE);
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
            outlet(0, name.replace('Sequencer', '') + "_current", -1);
        }
    }

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

// ===== CHANCE MIXIN =====
// Apply chance methods to SequencerDevice.prototype from permute-chance.js
chance.applyChanceMethods(SequencerDevice.prototype);

// ===== INSTRUMENT DETECTION =====

// Retry delays (ms) when a listed rack is detected but its macros aren't
// named yet — covers the race where the devices observer fires before Live
// has populated the rack's parameter list.
var DETECT_RETRY_DELAYS_MS = [50, 200, 500, 1200];

/**
 * Detect instrument and configure transpose strategy.
 * Scans for named transpose parameters on the track's instrument device.
 * Retries on a listed rack if no named param is found, in case the rack's
 * macro list is still being populated.
 */
SequencerDevice.prototype.detectInstrumentType = function() {
    // Reset to defaults
    this.instrumentType = 'unknown';
    this.instrumentDevice = null;
    this.instrumentDeviceId = null;
    this.instrumentStrategy = new DefaultInstrumentStrategy();
    this.observerRegistry.unregister('instrument_params');

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
            // Schedule retries — the rack's macros may not be populated yet.
            this.scheduleDetectionRetries(0);
        }
    } else {
        this.instrumentType = 'note_transpose';
        debug("instrument", "Using note-based shifting (default)");
    }

    // Always re-arm the params observer on the (possibly new) instrument device,
    // so later renames/remaps trigger a re-detect.
    this.setupInstrumentParamsObserver();
};

/**
 * Schedule a retry of detectInstrumentType using a backoff schedule.
 * Stops as soon as we land on parameter_transpose or exhaust retries.
 * @param {number} attemptIndex - Index into DETECT_RETRY_DELAYS_MS
 */
SequencerDevice.prototype.scheduleDetectionRetries = function(attemptIndex) {
    if (attemptIndex >= DETECT_RETRY_DELAYS_MS.length) {
        debug("instrument", "Detection retries exhausted, staying on note_transpose");
        return;
    }

    var self = this;
    var delayMs = DETECT_RETRY_DELAYS_MS[attemptIndex];

    if (typeof Task === 'undefined') return;

    var t = new Task(function() {
        // Bail if we've already landed on parameter_transpose (e.g. params
        // observer beat us to it).
        if (self.instrumentType === 'parameter_transpose') {
            debug("instrument", "Retry " + attemptIndex + " skipped — already on parameter_transpose");
            return;
        }

        // Only retry if the instrument device is still a listed rack with
        // no named param — otherwise there's nothing to wait for.
        if (!self.instrumentDevice || self.instrumentDevice.id === INVALID_LIVE_API_ID) {
            debug("instrument", "Retry " + attemptIndex + " aborted — instrument device gone");
            return;
        }
        if (!isParameterTransposeDevice(self.instrumentDevice)) return;

        var transposeResult = findTransposeParameterByName(self.instrumentDevice);
        if (transposeResult) {
            self.instrumentType = 'parameter_transpose';
            self.instrumentStrategy = new TransposeStrategy(
                self.instrumentDevice,
                transposeResult.param,
                transposeResult.shiftAmount,
                transposeResult.name
            );
            debug("instrument", "Retry " + attemptIndex + " succeeded — found '" +
                  transposeResult.name + "' after " + delayMs + "ms");
        } else {
            debug("instrument", "Retry " + attemptIndex + " at " + delayMs + "ms: still no named param");
            self.scheduleDetectionRetries(attemptIndex + 1);
        }
    }, this);
    t.schedule(delayMs);
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

    if (!this.trackState.ref) {
        this._cachedClip = null;
        this._cachedClipId = null;
        this._clipCacheDirty = false;
        return null;
    }

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
        this._clipCacheDirty = false;
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

    this.invalidateClipCache();

    this.processSequencerTick('mute', this.sequencers.muteSequencer, targetTicks);
    this.processSequencerTick('pitch', this.sequencers.pitchSequencer, targetTicks);
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
    if (!seq) return;

    var newStep = seq.calculateStep(ticks);

    if (newStep === seq.currentStep) return;

    seq.currentStep = newStep;

    try {
        var value = seq.getCurrentValue();
        var clip = this.getCurrentClip();

        // parameter_transpose applies directly without a clip (device parameter only)
        if (seqName === 'pitch' && this.instrumentType === 'parameter_transpose') {
            var shouldShiftUp = (value === 1);
            if (value !== seq.lastParameterValue) {
                this.instrumentStrategy.applyTranspose(shouldShiftUp);
                seq.lastParameterValue = value;
            }
            outlet(0, seqName + "_current", newStep);
            return;
        }

        if (clip) {
            this.scheduleBatchApply(clip.id, seqName, value);
        }

        outlet(0, seqName + "_current", newStep);
    } catch (error) {
        handleError("processSequencerTick:" + seqName, error, false);
    }
};

// ===== INLET-AWARE MESSAGE HANDLERS =====

/**
 * Handle transport messages from inlet 0.
 * @param {string} messageName - Message name (e.g., 'song_time')
 * @param {Array} args - Message arguments
 */
SequencerDevice.prototype.handleTransport = function(messageName, args) {
    if (messageName === 'song_time' && args.length >= 1) {
        this.processWithSongTime(args[0]);
    }
};

/**
 * Handle Max UI messages from inlet 1.
 * Each live.* UI object emits a prepended message; JS updates state directly.
 * No echo back to UI — the UI object already holds the value.
 *
 * Protocol:
 *   mute_step <i> <v>       i=0..7, v=0/1
 *   mute_length <v>         1..8
 *   mute_rate <enum_index>  0..7 (ENUM_RATES)
 *   pitch_step <i> <v>
 *   pitch_length <v>
 *   pitch_rate <enum_index>  0..7
 *   temperature <v>         0.0..1.0
 *   chance <v>              0.0..1.0
 */
SequencerDevice.prototype.handleMaxUICommand = function(messageName, args) {
    debug("handleMaxUICommand", messageName + " " + args.join(" "));

    // Per-step toggles
    if (messageName === 'mute_step' || messageName === 'pitch_step') {
        if (args.length < 2) return;
        var seqName = (messageName === 'mute_step') ? 'mute' : 'pitch';
        this.sequencers[seqName + 'Sequencer'].setStep(parseInt(args[0]), parseInt(args[1]));
        return;
    }

    // Length menus
    if (messageName === 'mute_length' || messageName === 'pitch_length') {
        if (args.length < 1) return;
        var seqName = (messageName === 'mute_length') ? 'mute' : 'pitch';
        this.sequencers[seqName + 'Sequencer'].setLength(parseInt(args[0]));
        return;
    }

    // Rate menus (ENUM_RATES index)
    if (messageName === 'mute_rate' || messageName === 'pitch_rate') {
        if (args.length < 1) return;
        var seqName = (messageName === 'mute_rate') ? 'mute' : 'pitch';
        this.sequencers[seqName + 'Sequencer'].setRateEnum(parseInt(args[0]), this.timeSignatureNumerator);
        return;
    }

    if (messageName === 'temperature') {
        if (args.length < 1) return;
        this.setTemperatureValue(parseFloat(args[0]));
        return;
    }

    if (messageName === 'chance') {
        if (args.length < 1) return;
        this.setChanceValue(parseFloat(args[0]));
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

    // Re-apply chance to new clip if chance is active
    if (this.chanceValue < 1.0) {
        this.applyChanceToClip();
        debug("onClipChanged", "Re-applied chance to new clip");
    }

    // lastValues are tracked per clipId, so no need to clear on clip change
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

/**
 * Inlet-aware message router.
 *   Inlet 0: Transport (song_time)
 *   Inlet 1: Max UI messages (mute_step N v, mute_length v, mute_rate i,
 *            pitch_step N v, pitch_length v, pitch_rate i, temperature v, chance v)
 */
function anything() {
    var msg = messagename;
    var args = arrayfromargs(arguments);

    switch (inlet) {
        case 0:
            sequencer.handleTransport(msg, args);
            break;
        case 1:
            sequencer.handleMaxUICommand(msg, args);
            break;
        default:
            debug("anything", "Unknown inlet: " + inlet);
    }
}

// Handle notifydeleted
function notifydeleted() {
    // Cancel any pending debounced detection before its Task fires against
    // a dead device reference.
    if (sequencer._pendingDetectionTask) {
        try { sequencer._pendingDetectionTask.cancel(); } catch (e) {}
        sequencer._pendingDetectionTask = null;
    }
    // Use observer registry for cleanup (includes temperature loop_jump observer)
    sequencer.observerRegistry.clearAll();
}
