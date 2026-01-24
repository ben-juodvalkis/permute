# Live Object Model (LOM) Reference

A comprehensive reference for the Ableton Live Object Model API, scraped from [Cycling74 documentation](https://docs.cycling74.com/apiref/lom/). This document refers to Ableton Live version 12.3.

## Table of Contents

- [Overview](#overview)
- [Canonical Paths](#canonical-paths)
- [Core Classes](#core-classes)
  - [Application](#application)
  - [Application.View](#applicationview)
  - [Song](#song)
  - [Song.View](#songview)
- [Track Classes](#track-classes)
  - [Track](#track)
  - [Track.View](#trackview)
  - [TakeLane](#takelane)
- [Clip Classes](#clip-classes)
  - [Clip](#clip)
  - [Clip.View](#clipview)
  - [ClipSlot](#clipslot)
  - [Sample](#sample)
- [Device Classes](#device-classes)
  - [Device](#device)
  - [Device.View](#deviceview)
  - [DeviceParameter](#deviceparameter)
  - [DeviceIO](#deviceio)
  - [MaxDevice](#maxdevice)
  - [PluginDevice](#plugindevice)
  - [RackDevice](#rackdevice)
  - [RackDevice.View](#rackdeviceview)
- [Chain Classes](#chain-classes)
  - [Chain](#chain)
  - [DrumChain](#drumchain)
  - [ChainMixerDevice](#chainmixerdevice)
- [Mixer Classes](#mixer-classes)
  - [MixerDevice](#mixerdevice)
- [Session Classes](#session-classes)
  - [Scene](#scene)
  - [CuePoint](#cuepoint)
- [Groove Classes](#groove-classes)
  - [Groove](#groove)
  - [GroovePool](#groovepool)
- [Control Classes](#control-classes)
  - [ControlSurface](#controlsurface)
  - [DrumPad](#drumpad)
  - [TuningSystem](#tuningsystem)
- [Device-Specific Classes](#device-specific-classes)
  - [SimplerDevice](#simplerdevice)
  - [SimplerDevice.View](#simplerdeviceview)
  - [Eq8Device](#eq8device)
  - [Eq8Device.View](#eq8deviceview)
  - [CompressorDevice](#compressordevice)
  - [WavetableDevice](#wavetabledevice)
  - [LooperDevice](#looperdevice)
  - [HybridReverbDevice](#hybridreverbdevice)
  - [DriftDevice](#driftdevice)
  - [MeldDevice](#melddevice)
  - [RoarDevice](#roardevice)
  - [ShifterDevice](#shifterdevice)
  - [SpectralResonatorDevice](#spectralresonatordevice)
  - [DrumCellDevice](#drumcelldevice)

---

## Overview

The Live Object Model (LOM) enables Max for Live developers to read and modify the state of Ableton Live from within a Max for Live device. The model is organized hierarchically with parent-child relationships forming an object tree.

### Access Types

- **read-only**: Property can only be read
- **observe**: Property can be observed for changes (sends notifications)
- **get/set**: Property can be read and written

---

## Canonical Paths

Common paths for accessing LOM objects:

| Path | Description |
|------|-------------|
| `live_app` | Application object |
| `live_app view` | Application view |
| `live_set` | Current Song (Live Set) |
| `live_set view` | Song view |
| `live_set tracks N` | Track at index N |
| `live_set tracks N clip_slots M` | Clip slot at index M on track N |
| `live_set tracks N clip_slots M clip` | Clip in slot |
| `live_set tracks N devices M` | Device at index M on track N |
| `live_set tracks N devices M parameters L` | Parameter L of device M |
| `live_set tracks N mixer_device` | Track's mixer device |
| `live_set master_track` | Master track |
| `live_set return_tracks N` | Return track at index N |
| `live_set scenes N` | Scene at index N |
| `control_surfaces N` | Control surface at index N |

---

## Core Classes

### Application

**Canonical Path:** `live_app`

#### Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| view | Application.View | read-only | View component for the application |
| control_surfaces | list of ControlSurface | read-only, observe | Control surfaces selected in Live's Preferences |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| current_dialog_button_count | int | read-only | Number of buttons in the current message box |
| current_dialog_message | symbol | read-only | Text of the current message box (empty if none shown) |
| open_dialog_count | int | read-only, observe | Number of dialog boxes shown |
| average_process_usage | float | read-only, observe | CPU load averaged over time |
| peak_process_usage | float | read-only, observe | Peak CPU load |

#### Functions

| Name | Parameters | Returns | Description |
|------|------------|---------|-------------|
| get_bugfix_version | — | int | The 2 in Live 9.1.2 |
| get_document | — | Song | The current Live Set |
| get_major_version | — | int | The 9 in Live 9.1.2 |
| get_minor_version | — | int | The 1 in Live 9.1.2 |
| get_version_string | — | string | The text "9.1.2" in Live 9.1.2 |
| press_current_dialog_button | index | void | Press button with given index in current dialog |

---

### Application.View

**Canonical Path:** `live_app view`

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| browse_mode | bool | read-only, observe | 1 = Hot-Swap Mode is active |
| focused_document_view | unicode | read-only, observe | Currently visible view ('Session' or 'Arranger') |

#### Functions

| Name | Parameters | Returns | Description |
|------|------------|---------|-------------|
| available_main_views | — | list | View names: Browser, Arranger, Session, Detail, Detail/Clip, Detail/DeviceChain |
| focus_view | view_name | — | Shows and focuses named view |
| hide_view | view_name | — | Hides the named view |
| is_view_visible | view_name | bool | Whether specified view is visible |
| scroll_view | direction, view_name, modifier_pressed | — | Scrolls view (0=up, 1=down, 2=left, 3=right) |
| show_view | view_name | — | Makes named view visible |
| toggle_browse | — | — | Toggles Hot-Swap Mode for selected device |
| zoom_view | direction, view_name, modifier_pressed | — | Zooms Arrangement or Session View |

---

### Song

**Canonical Path:** `live_set`

#### Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| cue_points | list of CuePoint | read-only, observe | Arrangement markers |
| return_tracks | list of Track | read-only, observe | Return tracks in the Live Set |
| scenes | list of Scene | read-only, observe | Scenes in the Live Set |
| tracks | list of Track | read-only, observe | Tracks in the Live Set |
| visible_tracks | list of Track | read-only, observe | Tracks not in folded groups |
| master_track | Track | read-only | The master track |
| view | Song.View | read-only | Song view object |
| groove_pool | GroovePool | read-only | Live's groove pool (Live 11.0+) |
| tuning_system | TuningSystem | read-only, observe | Currently active tuning system |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| appointed_device | Device | read-only, observe | Device selected by control surface (blue hand) |
| arrangement_overdub | bool | observe | MIDI Arrangement Overdub button state |
| back_to_arranger | bool | observe | Playback differs from Arrangement indicator |
| can_capture_midi | bool | read-only, observe | Recently played MIDI available for capture |
| can_jump_to_next_cue | bool | read-only, observe | Next cue point exists |
| can_jump_to_prev_cue | bool | read-only, observe | Previous cue point exists |
| can_redo | bool | read-only | Redo operation available |
| can_undo | bool | read-only | Undo operation available |
| clip_trigger_quantization | int | observe | Quantization setting (0-13 range) |
| count_in_duration | int | read-only, observe | 0=None, 1=1Bar, 2=2Bars, 3=4Bars |
| current_song_time | float | observe | Playing position in beats |
| exclusive_arm | bool | read-only | Exclusive Arm preference |
| exclusive_solo | bool | read-only | Exclusive Solo preference |
| file_path | symbol | read-only | Live Set file path |
| groove_amount | float | observe | Groove pool amount (0.0-1.0) |
| is_ableton_link_enabled | bool | observe | Ableton Link enabled |
| is_ableton_link_start_stop_sync_enabled | bool | observe | Link Start Stop Sync state |
| is_counting_in | bool | read-only, observe | Metronome counting in |
| is_playing | bool | observe | Transport running state |
| last_event_time | float | read-only | Beat time of final event in Arrangement |
| loop | bool | observe | Arrangement loop enabled |
| loop_length | float | observe | Arrangement loop length in beats |
| loop_start | float | observe | Arrangement loop start in beats |
| metronome | bool | observe | Metronome enabled |
| midi_recording_quantization | int | observe | Record Quantization value (0-8) |
| name | symbol | read-only | Current Live Set name |
| nudge_down | bool | observe | Tempo Nudge Down button state |
| nudge_up | bool | observe | Tempo Nudge Up button state |
| tempo_follower_enabled | bool | observe | Tempo Follower controls tempo |
| overdub | bool | observe | MIDI Arrangement Overdub enabled |
| punch_in | bool | observe | Punch-In enabled |
| punch_out | bool | observe | Punch-Out enabled |
| re_enable_automation_enabled | bool | read-only, observe | Re-Enable Automation button state |
| record_mode | bool | observe | Arrangement Record button state |
| root_note | int | observe | Scale root note (0=C to 11=B) |
| scale_intervals | list | read-only, observe | Scale degree intervals |
| scale_mode | bool | observe | Scale Mode highlighting enabled |
| scale_name | unicode | observe | Selected scale display name |
| select_on_launch | bool | read-only | Select on Launch preference |
| session_automation_record | bool | observe | Automation Arm button state |
| session_record | bool | observe | Session Overdub button state |
| session_record_status | int | read-only, observe | Session Record button state |
| signature_denominator | int | observe | Time signature denominator |
| signature_numerator | int | observe | Time signature numerator |
| song_length | float | read-only, observe | Total song length in beats |
| start_time | float | observe | Playback start position in beats |
| swing_amount | float | observe | Swing range (0.0-1.0) |
| tempo | float | observe | Current tempo (20.0-999.0 BPM) |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| capture_and_insert_scene | — | Capture playing clips as new scene |
| capture_midi | destination (0=auto, 1=session, 2=arrangement) | Capture recent MIDI |
| continue_playing | — | Resume from current position |
| create_audio_track | index (-1 adds at end) | Add audio track |
| create_midi_track | index (-1 adds at end) | Add MIDI track |
| create_return_track | — | Add return track |
| create_scene | index (-1 adds at end) | Create scene |
| delete_scene | index | Delete scene |
| delete_track | index | Delete track |
| delete_return_track | index | Delete return track |
| duplicate_scene | index | Duplicate scene |
| duplicate_track | index | Duplicate track |
| find_device_position | device, target, position | Find insertable position for device |
| force_link_beat_time | — | Force Link timeline to Live's beat time |
| get_beats_loop_length | — | Get loop length (bars.beats.sixteenths.ticks) |
| get_beats_loop_start | — | Get loop start |
| get_current_beats_song_time | — | Get current position |
| get_current_smpte_song_time | format (0-5) | Get position in timecode |
| is_cue_point_selected | — | Check if at cue point |
| jump_by | beats | Jump relative to current position |
| jump_to_next_cue | — | Jump to next cue point |
| jump_to_prev_cue | — | Jump to previous cue point |
| move_device | device, target, position | Move device to position |
| play_selection | — | Play Arrangement selection |
| re_enable_automation | — | Re-activate automation |
| redo | — | Redo last operation |
| scrub_by | beats | Scrub relative to position |
| set_or_delete_cue | — | Toggle cue point at position |
| start_playing | — | Start playback from insert marker |
| stop_all_clips | quantized (optional, default=1) | Stop all clips |
| stop_playing | — | Stop playback |
| tap_tempo | — | Calculate tempo from tap timing |
| trigger_session_record | record_length (optional) | Start/stop Session recording |
| undo | — | Undo last operation |

---

### Song.View

**Canonical Path:** `live_set view`

#### Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| detail_clip | Clip | observe | Clip in Detail View |
| highlighted_clip_slot | ClipSlot | read-only | Highlighted slot in Session View |
| selected_chain | Chain | observe | Highlighted chain, or id 0 |
| selected_parameter | DeviceParameter | read-only, observe | Selected parameter, or id 0 |
| selected_scene | Scene | observe | Currently selected scene |
| selected_track | Track | observe | Currently selected track |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| draw_mode | bool | observe | Draw Mode state (0=arrow, 1=pencil) |
| follow_song | bool | observe | Follow switch state |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| select_device | id NN | Selects device in its track |

---

## Track Classes

### Track

**Canonical Path:** `live_set tracks N`

#### Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| take_lanes | list of TakeLane | read-only, observe | Track's take lanes |
| clip_slots | list of ClipSlot | read-only, observe | Session view clip slots |
| arrangement_clips | list of Clip | read-only, observe | Arrangement View clips (Live 11.0+) |
| devices | list of Device | read-only, observe | Devices including mixer device |
| group_track | Track | read-only, observe | Parent group, or id 0 |
| mixer_device | MixerDevice | read-only | Track's mixer device |
| view | Track.View | read-only | Track view interface |

#### Properties (Observable, Read/Write)

| Name | Type | Description |
|------|------|-------------|
| arm | bool | 1 = track armed for recording (not return/master) |
| back_to_arranger | bool | Single Track button state |
| color | int | RGB value as 0x00rrggbb |
| color_index | long | Track color index |
| implicit_arm | bool | Secondary arm state (Push) |
| input_routing_channel | dict | Current source channel (MIDI/audio only) |
| input_routing_type | dict | Current source type (MIDI/audio only) |
| is_showing_chains | bool | Whether Rack displays chains in Session View |
| mute | bool | Track mute state (not on master) |
| name | symbol | Track header name |
| output_routing_channel | dict | Current target channel (not master) |
| output_routing_type | dict | Current target type (not master) |
| solo | bool | Solo state (not master) |

#### Properties (Observable, Read-Only)

| Name | Type | Description |
|------|------|-------------|
| available_input_routing_channels | dict | Available input channels |
| available_input_routing_types | dict | Available input types |
| available_output_routing_channels | dict | Available output channels (not master) |
| available_output_routing_types | dict | Available output types (not master) |
| can_be_armed | bool | 0 for return and master tracks |
| can_be_frozen | bool | Whether track supports freezing |
| can_show_chains | bool | Has Rack with chain display |
| fired_slot_index | int | Blinking clip slot (-1=none, -2=stop) |
| has_audio_input | bool | 1 for audio tracks |
| has_audio_output | bool | 1 for audio/MIDI-with-instruments |
| has_midi_input | bool | 1 for MIDI tracks |
| has_midi_output | bool | 1 for MIDI-without-instruments |
| input_meter_left | float | Left input peak (0.0-1.0) |
| input_meter_level | float | Input hold peak (0.0-1.0) |
| input_meter_right | float | Right input peak (0.0-1.0) |
| is_foldable | bool | Can hide/reveal contained tracks |
| is_frozen | bool | 1 = track frozen |
| is_grouped | bool | 1 = in Group Track |
| is_part_of_selection | bool | Selection state |
| is_visible | bool | 0 if hidden in folded group |
| muted_via_solo | bool | Muted due to other solo |
| output_meter_left | float | Left output peak (0.0-1.0) |
| output_meter_level | float | Output hold peak (0.0-1.0) |
| output_meter_right | float | Right output peak (0.0-1.0) |
| performance_impact | float | Track's CPU impact |
| playing_slot_index | int | Playing clip slot (-1=arrangement, -2=stop) |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| create_audio_clip | file_path, position | Creates audio clip at position |
| create_midi_clip | start_time, length | Creates empty MIDI clip in arrangement |
| create_take_lane | — | Creates take lane for track |
| delete_clip | clip | Delete the given clip |
| delete_device | index | Delete device at index |
| duplicate_clip_slot | index | Duplicate clip slot |
| duplicate_clip_to_arrangement | clip, destination_time | Copies clip to arrangement |
| insert_device | device_name, target_index (optional) | Insert native Live device (Live 12.3+) |
| jump_in_running_session_clip | beats | Modify playback position in Session clip |
| stop_all_clips | — | Stops all playing clips in track |

---

### Track.View

**Canonical Path:** `live_set tracks N view`

#### Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| selected_device | Device | read-only, observe | Selected device in track |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| device_insert_mode | int | observe | 0=end, 1=left, 2=right of selected |
| is_collapsed | bool | observe | 1 = track collapsed in Arrangement |

#### Functions

| Name | Returns | Description |
|------|---------|-------------|
| select_instrument | bool | Selects and focuses track's instrument |

---

### TakeLane

**Canonical Path:** `live_set tracks N take_lanes M`

#### Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| arrangement_clips | list of Clip | read-only, observe | Arrangement View clips |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| name | symbol | observe | Name in take lane header |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| create_audio_clip | file_path, start_time | Create audio clip at position |
| create_midi_clip | start_time, length | Create empty MIDI clip |

---

## Clip Classes

### Clip

**Canonical Path:** `live_set tracks N clip_slots M clip`

#### Children

| Name | Type | Access |
|------|------|--------|
| view | Clip.View | read-only |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| available_warp_modes | list | read-only | Available Warp Mode indexes |
| color | int | observe | RGB value (0x00rrggbb) |
| color_index | int | observe | Clip's color index |
| end_marker | float | observe | End marker in beats |
| end_time | float | read-only, observe | End position based on loop state |
| gain | float | observe | Audio clip gain (0.0-1.0) |
| gain_display_string | symbol | read-only | Gain as string (e.g., "1.3 dB") |
| file_path | symbol | read-only | Audio file location |
| groove | Groove | observe | Associated groove |
| has_envelopes | bool | read-only, observe | Contains automation |
| has_groove | bool | read-only | Has groove association |
| is_session_clip | bool | read-only | In Session view |
| is_arrangement_clip | bool | read-only | In Arrangement view |
| is_take_lane_clip | bool | read-only | On a Take Lane |
| is_audio_clip | bool | read-only | 1 = audio |
| is_midi_clip | bool | read-only | 1 = MIDI |
| is_overdubbing | bool | read-only, observe | Overdubbing state |
| is_playing | bool | read-only | Playing or recording |
| is_recording | bool | read-only, observe | Recording state |
| is_triggered | bool | read-only | Launch button blinking |
| launch_mode | int | observe | 0=Trigger, 1=Gate, 2=Toggle, 3=Repeat |
| launch_quantization | int | observe | Quantization (0-14) |
| legato | bool | observe | Legato Mode enabled |
| length | float | read-only | Loop length or start-to-end distance |
| loop_end | float | observe | Loop end position |
| loop_jump | bang | observe | Bangs when crossing loop start |
| loop_start | float | observe | Loop start position |
| looping | bool | observe | 1 = looped |
| muted | bool | observe | 1 = muted (Activator off) |
| name | symbol | observe | Clip name |
| notes | bang | observe | Bangs when notes change |
| warp_markers | dict/bang | read-only, observe | Warp Markers as dict |
| pitch_coarse | int | observe | Transpose (-48 to 48 semitones) |
| pitch_fine | float | observe | Detune (-50 to 49 cents) |
| playing_position | float | read-only, observe | Current playback position |
| playing_status | bang | observe | Bangs on play/trigger change |
| position | float | read-only, observe | Loop position (= loop_start) |
| ram_mode | bool | observe | Audio clip RAM switch |
| sample_length | int | read-only | Sample length in samples |
| sample_rate | float | read-only | Sample rate |
| signature_denominator | int | observe | Time signature denominator |
| signature_numerator | int | observe | Time signature numerator |
| start_marker | float | observe | Start marker in beats |
| start_time | float | read-only, observe | Start time in song |
| velocity_amount | float | observe | Velocity affects volume |
| warp_mode | int | observe | 0=Beats, 1=Tones, 2=Texture, 3=Re-Pitch, 4=Complex, 5=REX, 6=Complex Pro |
| warping | bool | observe | Warp switch (audio only) |
| will_record_on_start | bool | read-only | Recording state for triggered clips |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| add_new_notes | dict with "notes" | Add notes, returns note IDs (MIDI) |
| add_warp_marker | dict with beat_time, sample_time | Add warp marker (warped audio) |
| apply_note_modifications | dict with "notes" | Modify existing notes (MIDI) |
| clear_all_envelopes | — | Remove all automation |
| clear_envelope | device_parameter id | Remove parameter automation |
| crop | — | Crop clip to loop/markers |
| deselect_all_notes | — | Deselect notes (MIDI) |
| duplicate_loop | — | Double loop, duplicate notes/envelopes (MIDI) |
| duplicate_notes_by_id | list or dict | Duplicate notes with destination/transposition |
| duplicate_region | region_start, length, dest_time, pitch, transposition | Duplicate region (MIDI) |
| fire | — | Trigger clip (like Launch button) |
| get_all_notes_extended | optional dict | Get all notes as dicts |
| get_notes_by_id | list or dict | Get notes by IDs |
| get_notes_extended | from_pitch, span, from_time, span | Get notes in area |
| get_selected_notes_extended | optional dict | Get selected notes |
| move_playing_pos | beats | Jump unquantized |
| move_warp_marker | beat_time, distance | Move warp marker |
| quantize | grid, amount | Quantize all notes |
| quantize_pitch | pitch, grid, amount | Quantize specific pitch |
| remove_notes_by_id | list of IDs | Delete notes by ID |
| remove_notes_extended | from_pitch, span, from_time, span | Delete notes in area |
| remove_warp_marker | beat_time | Remove warp marker |
| scrub | beat_time | Scrub to time |
| select_all_notes | — | Select all notes (MIDI) |
| select_notes_by_id | list of IDs | Select notes by ID |
| set_fire_button_state | state | Simulate button press |
| stop | — | Stop clip |
| stop_scrub | — | Stop active scrub |

---

### Clip.View

**Canonical Path:** `live_set tracks N clip_slots M clip view`

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| grid_is_triplet | bool | get/set | Display triplet grid |
| grid_quantization | int | get/set | Grid quantization |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| hide_envelope | — | Hide Envelopes box |
| show_envelope | — | Show Envelopes box |
| select_envelope_parameter | DeviceParameter | Select parameter in Envelopes |
| show_loop | — | Make loop visible in Detail View |

---

### ClipSlot

**Canonical Path:** `live_set tracks N clip_slots M`

#### Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| clip | Clip | read-only | id 0 if empty |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| color | long | read-only, observe | First clip color in Group Track slot |
| color_index | long | read-only, observe | Color index for Group Track |
| controls_other_clips | bool | read-only, observe | Group slot contains active clips |
| has_clip | bool | read-only, observe | 1 = clip exists |
| has_stop_button | bool | observe | 1 = stops track |
| is_group_slot | bool | read-only | Belongs to Group Track |
| is_playing | bool | read-only | 1 = playing_status != 0 |
| is_recording | bool | read-only | 1 = playing_status == 2 |
| is_triggered | bool | read-only, observe | Button blinking |
| playing_status | int | read-only, observe | 0=stopped, 1=playing, 2=recording |
| will_record_on_start | bool | read-only | Will record on start |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| create_audio_clip | path | Create audio clip from file |
| create_clip | length | Create MIDI clip (length > 0.0) |
| delete_clip | — | Remove clip |
| duplicate_clip_to | target_clip_slot | Copy clip to slot |
| fire | record_length, launch_quantization (optional) | Launch clip or stop button |
| set_fire_button_state | state | Simulate button press |
| stop | — | Halt playback/recording |

---

### Sample

**Canonical Path:** `live_set tracks N devices M sample` (for SimplerDevice)

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| beats_granulation_resolution | int | observe | Division preservation (0-6) |
| beats_transient_envelope | float | observe | Fade duration (0-100) in Beats Mode |
| beats_transient_loop_mode | int | observe | 0=Off, 1=Forward, 2=Back-and-Forth |
| complex_pro_envelope | float | observe | Envelope in Complex Pro Mode |
| complex_pro_formants | float | observe | Formants in Complex Pro Mode |
| end_marker | int | observe | End marker position |
| file_path | unicode | read-only, observe | Sample file path |
| gain | float | observe | Sample gain |
| length | int | read-only | Sample length in frames |
| sample_rate | int | read-only | Sample rate (Live 11.0+) |
| slices | list of int | read-only, observe | Slice positions in frames (Live 11.0+) |
| slicing_sensitivity | float | observe | Sensitivity (0.0-1.0) |
| start_marker | int | observe | Start marker position |
| texture_flux | float | observe | Flux in Texture Mode |
| texture_grain_size | float | observe | Grain Size in Texture Mode |
| tones_grain_size | float | observe | Grain Size in Tones Mode |
| warp_markers | dict/bang | read-only, observe | Warp Markers as dict (Live 11.0+) |
| warp_mode | int | observe | 0=Beats, 1=Tones, 2=Texture, 3=Re-Pitch, 4=Complex, 6=Complex Pro |
| warping | bool | observe | 1 = warping enabled |
| slicing_style | int | observe | 0=Transient, 1=Beat, 2=Region, 3=Manual |
| slicing_beat_division | int | observe | 0=1/16 through 10=4 Bars |
| slicing_region_count | int | observe | Region count |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| gain_display_string | — | Gain as string (e.g., "0.0 dB") |
| insert_slice | slice_time | Insert slice at time |
| move_slice | source_time, destination_time | Move slice |
| remove_slice | slice_time | Remove slice at time |
| clear_slices | — | Clear Manual Mode slices |
| reset_slices | — | Reset to original positions |

---

## Device Classes

### Device

**Canonical Path:** `live_set tracks N devices M`

#### Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| parameters | list of DeviceParameter | read-only, observe | Automatable parameters |
| view | Device.View | read-only | Device view properties |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| can_have_chains | bool | read-only | 0=single, 1=rack |
| can_have_drum_pads | bool | read-only | 1 for drum racks |
| class_display_name | symbol | read-only | Original device name |
| class_name | symbol | read-only | Device type identifier |
| is_active | bool | read-only, observe | Device on/off state |
| name | symbol | observe | Title bar name |
| type | int | read-only | 0=undefined, 1=instrument, 2=audio_effect, 4=midi_effect |
| latency_in_samples | int | read-only, observe | Latency in samples |
| latency_in_ms | float | read-only, observe | Latency in milliseconds |
| can_compare_ab | bool | read-only | AB Compare available (Live 12.3+) |
| is_using_compare_preset_b | bool | observe | AB comparison state (Live 12.3+) |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| store_chosen_bank | script_index, bank_index | Control surface integration |
| save_preset_to_compare_ab_slot | — | Save to AB slot (Live 12.3+) |

---

### Device.View

**Canonical Path:** `live_set tracks N devices M view`

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| is_collapsed | bool | observe | 1 = collapsed in device chain |

---

### DeviceParameter

**Canonical Path:** `live_set tracks N devices M parameters L`

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| automation_state | int | read-only, observe | 0=none, 1=active, 2=overridden |
| default_value | float | read-only | Default value (non-quantized only) |
| is_enabled | bool | read-only | User can modify |
| is_quantized | bool | read-only | 1 for booleans/enums |
| max | float | read-only | Maximum value |
| min | float | read-only | Minimum value |
| name | symbol | read-only | Short parameter name |
| original_name | symbol | read-only | Macro name before assignment |
| state | int | read-only, observe | 0=active, 1=inactive, 2=locked |
| value | float | observe | Internal value (min to max) |
| display_value | float | observe | GUI-visible value |
| value_items | StringVector | read-only | Possible values (quantized only) |

#### Functions

| Name | Parameters | Returns | Description |
|------|------------|---------|-------------|
| re_enable_automation | — | void | Re-enable automation |
| str_for_value | value | symbol | String for value |
| __str__ | — | symbol | Current value as string |

---

### DeviceIO

Represents an input or output bus of a Live device.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| available_routing_channels | dict | read-only, observe | Available channels |
| available_routing_types | dict | read-only, observe | Available routing types |
| default_external_routing_channel_is_none | bool | read/write | Default External is none (Live 11.0+) |
| routing_channel | dict | observe | Current channel (display_name, identifier) |
| routing_type | dict | observe | Current type (display_name, identifier) |

---

### MaxDevice

Extends Device with Max for Live-specific members.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| audio_inputs | list of DeviceIO | read-only, observe | Audio inputs |
| audio_outputs | list of DeviceIO | read-only, observe | Audio outputs |
| midi_inputs | list of DeviceIO | read-only, observe | MIDI inputs (Live 11.0+) |
| midi_outputs | list of DeviceIO | read-only, observe | MIDI outputs (Live 11.0+) |

#### Functions

| Name | Parameters | Returns | Description |
|------|------------|---------|-------------|
| get_bank_count | — | int | Number of parameter banks |
| get_bank_name | bank_index | list | Bank name |
| get_bank_parameters | bank_index | list of ints | Parameter indices in bank |

---

### PluginDevice

Extends Device with plug-in-specific members.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| presets | StringVector | read-only, observe | List of presets |
| selected_preset_index | int | observe | Current preset index |

---

### RackDevice

Extends Device with Rack-specific members.

#### Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| chain_selector | DeviceParameter | read-only | Chain selector |
| chains | list of Chain | read-only, observe | Rack's chains |
| drum_pads | list of DrumPad | read-only, observe | All 128 Drum Pads (topmost only) |
| return_chains | list of Chain | read-only, observe | Return chains |
| visible_drum_pads | list of DrumPad | read-only, observe | 16 visible Drum Pads |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| can_show_chains | bool | read-only | Can show chains in Session |
| has_drum_pads | bool | read-only, observe | Is Drum Rack with pads |
| has_macro_mappings | bool | read-only, observe | Macros are mapped |
| is_showing_chains | bool | observe | Showing chains in Session |
| variation_count | int | read-only, observe | Stored variations (Live 11.0+) |
| selected_variation_index | int | read/write | Current variation (Live 11.0+) |
| visible_macro_count | int | read-only, observe | Visible macros |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| copy_pad | source_index, destination_index | Copy pad content |
| add_macro | — | Increase macro count (Live 11.0+) |
| insert_chain | index (optional) | Insert chain (Live 12.3+) |
| remove_macro | — | Decrease macro count (Live 11.0+) |
| randomize_macros | — | Randomize macros (Live 11.0+) |
| store_variation | — | Store macro snapshot (Live 11.0+) |
| recall_selected_variation | — | Recall variation (Live 11.0+) |
| recall_last_used_variation | — | Recall last variation (Live 11.0+) |
| delete_selected_variation | — | Delete variation (Live 11.0+) |

---

### RackDevice.View

Extends Device.View with Rack-specific view members.

#### Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| selected_drum_pad | DrumPad | observe | Selected Drum Rack pad |
| selected_chain | Chain | observe | Selected chain |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| drum_pads_scroll_position | int | observe | Lowest visible row (0-28, Drum Racks only) |
| is_showing_chain_devices | bool | observe | 1 = chain devices visible |

---

## Chain Classes

### Chain

**Canonical Path:** `live_set tracks N devices M chains L`

#### Children

| Name | Type | Access |
|------|------|--------|
| devices | Device | read-only, observe |
| mixer_device | ChainMixerDevice | read-only |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| color | int | observe | RGB (0x00rrggbb) |
| color_index | long | observe | Color index |
| is_auto_colored | bool | observe | Inherits track/chain color |
| has_audio_input | bool | read-only | Audio input capability |
| has_audio_output | bool | read-only | Audio output capability |
| has_midi_input | bool | read-only | MIDI input capability |
| has_midi_output | bool | read-only | MIDI output capability |
| mute | bool | observe | 1 = muted (Activator off) |
| muted_via_solo | bool | read-only, observe | Muted due to solo |
| name | unicode | observe | Chain name |
| solo | bool | observe | 1 = soloed |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| delete_device | index | Remove device at position |
| insert_device | device_name, target_index (optional) | Insert device (Live 12.3+) |

---

### DrumChain

Extends Chain with Drum Rack-specific properties.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| in_note | int | observe | Trigger MIDI note (-1=All Notes, Live 12.3+) |
| out_note | int | observe | Output MIDI note |
| choke_group | int | observe | Choke group |

---

### ChainMixerDevice

**Canonical Path:** `live_set tracks N devices M chains L mixer_device`

#### Properties/Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| sends | list of DeviceParameter | read-only, observe | Send controls (Audio/Instrument Racks) |
| chain_activator | DeviceParameter | read-only | Enable/disable chain |
| panning | DeviceParameter | read-only | Stereo position (Audio/Instrument Racks) |
| volume | DeviceParameter | read-only | Output level (Audio/Instrument Racks) |

---

## Mixer Classes

### MixerDevice

**Canonical Path:** `live_set tracks N mixer_device`

#### Children (Read-Only DeviceParameters)

| Name | Description | Notes |
|------|-------------|-------|
| sends | One send per return track | observe |
| cue_volume | Cue volume | master only |
| crossfader | Crossfader control | master only |
| left_split_stereo | Left Split Stereo Pan | — |
| panning | Standard panning | — |
| right_split_stereo | Right Split Stereo Pan | — |
| song_tempo | Tempo control | master only |
| track_activator | Track on/off | — |
| volume | Track volume | — |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| crossfade_assign | int | observe | 0=A, 1=none, 2=B (non-master) |
| panning_mode | int | observe | 0=Stereo, 1=Split Stereo |

---

## Session Classes

### Scene

**Canonical Path:** `live_set scenes N`

#### Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| clip_slots | list of ClipSlot | read-only, observe | Slots in scene |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| color | int | observe | RGB (0x00rrggbb) |
| color_index | long | observe | Color index |
| is_empty | bool | read-only | 1 = no clips |
| is_triggered | bool | read-only, observe | Scene blinking |
| name | symbol | observe | Scene name |
| tempo | float | observe | Tempo (-1 if disabled) |
| tempo_enabled | bool | observe | Uses custom tempo |
| time_signature_numerator | int | observe | Numerator (-1 if disabled) |
| time_signature_denominator | int | observe | Denominator (-1 if disabled) |
| time_signature_enabled | bool | observe | Uses custom time signature |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| fire | force_legato, can_select_scene_on_launch (optional) | Fire all clip slots |
| fire_as_selected | force_legato (optional) | Fire and select next scene |
| set_fire_button_state | state | Simulate button hold |

---

### CuePoint

**Canonical Path:** `live_set cue_points N`

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| name | symbol | observe | Marker identifier |
| time | float | read-only, observe | Position in beats |

#### Functions

| Name | Description |
|------|-------------|
| jump | Set playback to marker (quantized if playing) |

---

## Groove Classes

### Groove

**Canonical Path:** `live_set groove_pool grooves N`

Available since Live 11.0.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| base | int | get/set | 0=1/4, 1=1/8, 2=1/8T, 3=1/16, 4=1/16T, 5=1/32 |
| name | symbol | get/set/observe | Groove identifier |
| quantization_amount | float | get/set/observe | Quantization amount |
| random_amount | float | get/set/observe | Random amount |
| timing_amount | float | get/set/observe | Timing amount |
| velocity_amount | float | get/set/observe | Velocity amount |

---

### GroovePool

**Canonical Path:** `live_set groove_pool`

#### Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| grooves | list of Groove | read-only, observe | Grooves from top to bottom |

---

## Control Classes

### ControlSurface

**Canonical Path:** `control_surfaces N`

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| pad_layout | symbol | read-only, observe | Active pad layout (Push 2/3) |

#### Functions

| Name | Parameters | Returns | Description |
|------|------------|---------|-------------|
| get_control | name | control | Get control by name |
| get_control_names | — | list | List all control names |
| grab_control | control | — | Take control ownership |
| grab_midi | — | — | Forward MIDI to Max for Live |
| register_midi_control | name, status, number | LOM ID | Register custom MIDI (MaxForLive only) |
| release_control | control | — | Release control |
| release_midi | — | — | Stop forwarding MIDI |
| send_midi | midi_message | — | Send MIDI to surface |
| send_receive_sysex | sysex_message, timeout | response | Send sysex, await response |

---

### DrumPad

**Canonical Path:** `live_set tracks N devices M drum_pads L`

#### Children

| Name | Type | Access |
|------|------|--------|
| chains | Chain | read-only, observe |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| mute | bool | observe | 1 = muted |
| name | symbol | read-only, observe | Pad identifier |
| note | int | read-only | MIDI note |
| solo | bool | observe | 1 = soloed |

#### Functions

| Name | Description |
|------|-------------|
| delete_all_chains | Remove all chains |

---

### TuningSystem

**Canonical Path:** `live_set tuning_system`

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| name | symbol | observe | Active tuning system name |
| pseudo_octave_in_cents | float | read-only | Pseudo octave in cents |
| lowest_note | dict | observe | Lowest note (index, octave) |
| highest_note | dict | observe | Highest note (index, octave) |
| reference_pitch | dict | observe | Reference pitch |
| note_tunings | dict | observe | Relative tunings in cents |

---

## Device-Specific Classes

### SimplerDevice

Extends Device.

#### Children

| Name | Type | Access | Description |
|------|------|--------|-------------|
| sample | Sample | read-only, observe | Loaded sample |

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| can_warp_as | bool | read-only, observe | warp_as available |
| can_warp_double | bool | read-only, observe | warp_double available |
| can_warp_half | bool | read-only, observe | warp_half available |
| multi_sample_mode | bool | read-only, observe | In multisample mode |
| pad_slicing | bool | observe | Slice via note input |
| playback_mode | int | observe | 0=Classic, 1=One-Shot, 2=Slicing |
| playing_position | float | read-only, observe | Position (0.0-1.0) |
| playing_position_enabled | bool | read-only, observe | Active playback |
| retrigger | bool | observe | Retrigger enabled |
| slicing_playback_mode | int | observe | 0=Mono, 1=Poly, 2=Thru |
| voices | int | observe | Voice count |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| crop | — | Crop to markers |
| guess_playback_length | — | Estimate beat duration |
| reverse | — | Reverse sample |
| warp_as | beats | Warp as specified beats |
| warp_double | — | Double tempo |
| warp_half | — | Halve tempo |

---

### SimplerDevice.View

Extends Device.View.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| selected_slice | int | observe | Selected slice time |

---

### Eq8Device

Extends Device.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| edit_mode | bool | observe | Channel for editing (mode-dependent) |
| global_mode | int | observe | 0=Stereo, 1=L/R, 2=M/S |
| oversample | bool | observe | Oversampling on/off |

---

### Eq8Device.View

Extends Device.View.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| selected_band | int | observe | Selected filter band index |

---

### CompressorDevice

Extends Device with sidechain routing.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| available_input_routing_channels | dict | read-only, observe | Sidechain source channels |
| available_input_routing_types | dict | read-only, observe | Sidechain source types |
| input_routing_channel | dict | observe | Current sidechain channel |
| input_routing_type | dict | observe | Current sidechain type |

---

### WavetableDevice

Extends Device with wavetable synthesis controls.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| filter_routing | int | observe | 0=Serial, 1=Parallel, 2=Split |
| mono_poly | int | observe | 0=Mono, 1=Poly |
| oscillator_1_effect_mode | int | observe | 0=None, 1=FM, 2=Classic, 3=Modern |
| oscillator_2_effect_mode | int | observe | Osc2 effect mode |
| oscillator_1_wavetable_category | — | observe | Osc1 category |
| oscillator_2_wavetable_category | — | observe | Osc2 category |
| oscillator_1_wavetable_index | — | observe | Osc1 wavetable |
| oscillator_2_wavetable_index | — | observe | Osc2 wavetable |
| oscillator_1_wavetables | StringVector | read-only, observe | Osc1 wavetable names |
| oscillator_2_wavetables | StringVector | read-only, observe | Osc2 wavetable names |
| oscillator_wavetable_categories | StringVector | read-only | Category names |
| poly_voices | int | observe | Voice count |
| unison_mode | int | observe | 0-6 unison types |
| unison_voice_count | int | observe | Unison voices |
| visible_modulation_target_names | StringVector | read-only, observe | Mod target names |

#### Functions

| Name | Parameters | Description |
|------|------------|-------------|
| add_parameter_to_modulation_matrix | parameter | Add to mod matrix |
| get_modulation_target_parameter_name | index | Get target name |
| get_modulation_value | target_index, source_index | Get mod amount |
| is_parameter_modulatable | parameter | Check modulatable |
| set_modulation_value | target_index, source_index | Set mod amount |

---

### LooperDevice

Extends Device.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| loop_length | float | read-only, observe | Buffer length |
| overdub_after_record | bool | observe | Switch to overdub after record |
| record_length_index | int | observe | Record Length chooser |
| record_length_list | StringVector | read-only | Record Length options |
| tempo | float | read-only, observe | Buffer tempo |

#### Functions

| Name | Description |
|------|-------------|
| clear | Erase content |
| double_speed | Double playback speed |
| half_speed | Halve playback speed |
| double_length | Double buffer length |
| half_length | Halve buffer length |
| record | Start recording |
| overdub | Play + overdub |
| play | Play without overdub |
| stop | Stop playback |
| undo | Undo/redo last recording |
| export_to_clip_slot | Export to clip slot |

---

### HybridReverbDevice

Extends Device.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| ir_attack_time | float | observe | IR envelope attack (seconds) |
| ir_category_index | int | observe | Selected IR category |
| ir_category_list | StringVector | read-only | IR categories |
| ir_decay_time | float | observe | IR envelope decay (seconds) |
| ir_file_index | int | observe | Selected IR file |
| ir_file_list | StringVector | read-only, observe | IR files in category |
| ir_size_factor | float | observe | IR size (0.0-1.0) |
| ir_time_shaping_on | bool | observe | Time shaping enabled |

---

### DriftDevice

Extends Device with modulation matrix controls.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| mod_matrix_filter_source_1_index | int | observe | Filter mod source 1 |
| mod_matrix_filter_source_1_list | StringVector | read-only | Source options |
| mod_matrix_filter_source_2_index | int | observe | Filter mod source 2 |
| mod_matrix_filter_source_2_list | StringVector | read-only | Source options |
| mod_matrix_lfo_source_index | int | observe | LFO mod source |
| mod_matrix_lfo_source_list | StringVector | read-only | Source options |
| mod_matrix_pitch_source_1_index | int | observe | Pitch mod source 1 |
| mod_matrix_pitch_source_1_list | StringVector | read-only | Source options |
| mod_matrix_pitch_source_2_index | int | observe | Pitch mod source 2 |
| mod_matrix_pitch_source_2_list | StringVector | read-only | Source options |
| mod_matrix_shape_source_index | int | observe | Shape mod source |
| mod_matrix_shape_source_list | StringVector | read-only | Source options |
| mod_matrix_source_1_index | int | observe | Custom slot 1 source |
| mod_matrix_source_1_list | StringVector | read-only | Source options |
| mod_matrix_source_2_index | int | observe | Custom slot 2 source |
| mod_matrix_source_2_list | StringVector | read-only | Source options |
| mod_matrix_source_3_index | int | observe | Custom slot 3 source |
| mod_matrix_source_3_list | StringVector | read-only | Source options |
| mod_matrix_target_1_index | int | observe | Custom slot 1 target |
| mod_matrix_target_1_list | StringVector | read-only | Target options |
| mod_matrix_target_2_index | int | observe | Custom slot 2 target |
| mod_matrix_target_2_list | StringVector | read-only | Target options |
| mod_matrix_target_3_index | int | observe | Custom slot 3 target |
| mod_matrix_target_3_list | StringVector | read-only | Target options |
| pitch_bend_range | int | observe | Pitch bend range (semitones) |
| voice_count_index | int | observe | Voice count |
| voice_count_list | StringVector | read-only | Voice options |
| voice_mode_index | int | observe | Voice mode |
| voice_mode_list | StringVector | read-only | Mode options |

---

### MeldDevice

Extends Device.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| selected_engine | int | observe | 0=Engine A, 1=Engine B |
| unison_voices | int | observe | 0=off, 1=two, 2=three, 3=four |
| mono_poly | int | observe | 0=mono, 1=poly |
| poly_voices | int | observe | 0=two through 6=twelve |

---

### RoarDevice

Extends Device.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| routing_mode_index | int | observe | Routing mode |
| routing_mode_list | StringVector | read-only | Routing options |
| env_listen | bool | observe | Envelope Input Listen |

---

### ShifterDevice

Extends Device.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| pitch_bend_range | int | observe | MIDI Pitch Mode range |
| pitch_mode_index | int | observe | 0=Internal, 1=MIDI |

---

### SpectralResonatorDevice

Extends Device.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| frequency_dial_mode | int | observe | 0=Hertz, 1=MIDI |
| midi_gate | int | observe | 0=Off, 1=On |
| mod_mode | int | observe | 0=None, 1=Chorus, 2=Wander, 3=Granular |
| mono_poly | int | observe | 0=Mono, 1=Poly |
| pitch_mode | int | observe | 0=Internal, 1=MIDI |
| pitch_bend_range | int | observe | Pitch bend range |
| polyphony | int | observe | 0=2, 1=4, 2=8, 3=16 voices |

---

### DrumCellDevice

Extends Device.

#### Properties

| Name | Type | Access | Description |
|------|------|--------|-------------|
| gain | float | observe | Sample gain (normalized) |

---

## Quick Reference Tables

### Device Type Values

| Value | Type |
|-------|------|
| 0 | undefined |
| 1 | instrument |
| 2 | audio_effect |
| 4 | midi_effect |

### Launch Mode Values

| Value | Mode |
|-------|------|
| 0 | Trigger |
| 1 | Gate |
| 2 | Toggle |
| 3 | Repeat |

### Warp Mode Values

| Value | Mode |
|-------|------|
| 0 | Beats |
| 1 | Tones |
| 2 | Texture |
| 3 | Re-Pitch |
| 4 | Complex |
| 5 | REX |
| 6 | Complex Pro |

### Quantization Values (clip_trigger_quantization)

| Value | Quantization |
|-------|--------------|
| 0 | None |
| 1 | 8 Bars |
| 2 | 4 Bars |
| 3 | 2 Bars |
| 4 | 1 Bar |
| 5 | 1/2 |
| 6 | 1/2T |
| 7 | 1/4 |
| 8 | 1/4T |
| 9 | 1/8 |
| 10 | 1/8T |
| 11 | 1/16 |
| 12 | 1/16T |
| 13 | 1/32 |

### Recording Quantization Values (midi_recording_quantization)

| Value | Quantization |
|-------|--------------|
| 0 | None |
| 1 | 1/4 |
| 2 | 1/8 |
| 3 | 1/8T |
| 4 | 1/8 + 1/8T |
| 5 | 1/16 |
| 6 | 1/16T |
| 7 | 1/16 + 1/16T |
| 8 | 1/32 |

---

## Version Notes

- **Live 11.0+**: GroovePool, Groove, Sample.slices, Sample.sample_rate, Sample.warp_markers, RackDevice variations, MaxDevice MIDI I/O
- **Live 12.3+**: Device AB Compare, Track/Chain insert_device, RackDevice insert_chain, DrumChain.in_note

---

*Generated from [Cycling74 LOM Documentation](https://docs.cycling74.com/apiref/lom/) - January 2025*
