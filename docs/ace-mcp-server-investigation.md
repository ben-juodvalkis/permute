# ACE Studio MCP Server Investigation

## Overview

ACE Studio exposes an MCP (Model Context Protocol) server via **Streamable HTTP** transport at `localhost:21572/mcp`, using protocol version `2025-03-26`.

## Connection

### Handshake (3-step)

1. **Initialize** — `POST /mcp` with `method: "initialize"` → returns session ID in `mcp-session-id` response header
2. **Initialized notification** — `POST /mcp` with `method: "notifications/initialized"` and session ID header
3. **Ready** — subsequent tool calls use the session ID header

```bash
# Step 1: Initialize and capture session ID
RESPONSE=$(curl -s -D - http://localhost:21572/mcp \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}, "id": 1}')
SESSION_ID=$(echo "$RESPONSE" | grep -i 'mcp-session-id' | awk '{print $2}' | tr -d '\r')

# Step 2: Send initialized notification
curl -s http://localhost:21572/mcp \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc": "2.0", "method": "notifications/initialized"}'

# Step 3: Now ready for tool calls
curl -s http://localhost:21572/mcp \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "get_playback_status", "arguments": {}}, "id": 3}'
```

**Important:** Steps must be done in quick succession — sessions expire.

## Available Tools (59 total)

### Playback & Transport
| Tool | Description |
|------|-------------|
| `get_playback_status` | Status (stopped/playing/playing but interrupted) + position in seconds |
| `control_playback` | Start/stop/toggle playback |
| `get_metronome_on` | Metronome state |
| `set_metronome_on` | Enable/disable metronome |
| `get_synthesis_status` | Whether content synthesis is in progress |

### Tempo & Time Signature
| Tool | Description |
|------|-------------|
| `get_tempo_automation` | Tempo points (pos, value BPM, bend) |
| `set_tempo_automation` | Replace all tempo points |
| `get_timesignature_list` | Time signature entries (barPos, numerator, denominator) |
| `set_timesignature_list` | Replace all time signatures |

### Project
| Tool | Description |
|------|-------------|
| `get_project_status_info` | Project name, duration, save state |
| `get_color_palette` | Available hex colors for tracks/clips |
| `get_loop_info` | Loop range, active/valid state |
| `set_loop_active` | Enable/disable loop |
| `set_loop_range` | Set loop start/end in ticks |

### Marker Line (Cursor/Caret)
| Tool | Description |
|------|-------------|
| `get_marker_line_position` | Position in ticks + track index (global or editor scope) |
| `change_marker_line_position` | Set marker position (tick, track, scope) |
| `seek_marker_line_position` | Seek to time in seconds |
| `get_marker_line_focus` | Which view has focus (arrangement/editor) |

### Arrangement View Selection
| Tool | Description |
|------|-------------|
| `get_current_arrangement_view_selection_range` | Horizontal (ticks) + vertical (tracks) selection |
| `make_new_arrangement_view_selection_range` | Set selection range |
| `delete_arrangement_view_selection` | Delete clips in selection |
| `move_arrangement_selection` | Move selected region to new position |

### Pattern Editor
| Tool | Description |
|------|-------------|
| `get_is_editor_available` | Editor availability + type + clip context |
| `get_current_editor_tick_range` | Editor tick range (for local/global conversion) |
| `get_editor_current_clip_index` | Which clip is being edited |
| `add_notes_in_editor` | Add notes (per-note or sentence lyrics for Sing) |
| `ask_editor_to_open` | Open editor window |
| `get_content_in_editor` | Get notes/chords in range |
| `get_selection_in_editor` | Get selected notes/chords |
| `delete_editor_selection` | Delete selected content |
| `set_editor_selection_range` | Set time selection range |
| `modify_note_selection_in_editor` | Select/deselect notes by UUID |

### Tracks
| Tool | Description |
|------|-------------|
| `get_content_track_count` | Number of content tracks (excludes empty slots) |
| `get_content_track_basic_info_list` | All tracks: index, type, name, sound source, clip count |
| `get_content_track_meta_settings` | Full metadata: mixer, record input, sound source details |
| `get_sing_track_single_singer_recipe` | Voice blend/recipe for a singer |
| `rename_content_track` | Rename a track |
| `change_content_track_color` | Change track color |
| `get_selected_track_list` | Currently selected tracks |
| `set_selected_track_list` | Set track selection |
| `delete_selected_track` | Delete selected tracks |
| `set_content_track_mute_solo` | Mute/solo a track |
| `set_content_track_pan_gain` | Set pan/gain |
| `set_content_track_record_setting` | Configure record input (audio/MIDI) |

### Clips
| Tool | Description |
|------|-------------|
| `get_content_track_clip_basic_info_list` | All clips on a track |
| `get_clip_meta_info` | Full clip metadata (geometry, color, name) |
| `get_audio_clip_content_info` | Audio file info |
| `get_note_clip_content` | Notes in a clip (pos, dur, pitch, lyric, articulation) |
| `get_note_clip_lyrics` | Sentence-level lyrics for Sing clips |
| `add_new_clip` | Create empty clip on track |
| `move_clip_edges` | Resize clip boundaries |

### Sound Sources
| Tool | Description |
|------|-------------|
| `get_available_sound_source_list` | Official/custom voices, instruments, choirs, ensembles |
| `get_suggested_sound_source_tag_list` | Filter suggestions (languages, categories) |
| `get_available_community_voice_list_page_count` | Community voice page count |
| `get_available_community_voice_list` | Browse community voices by page |
| `collect_community_voice` | Add community voice to library |
| `load_new_sound_source_on_track` | Load singer/instrument onto track |
| `unload_sound_source_on_track` | Remove sound source (downgrades to GenericMidi) |

### Audio/MIDI Devices
| Tool | Description |
|------|-------------|
| `get_current_audio_device_info` | Current audio device, channels, sample rate, buffer |
| `get_available_audio_device_list` | All available audio devices |
| `get_available_midi_device_list` | Available MIDI input devices |

### UI Panels
| Tool | Description |
|------|-------------|
| `get_mixer_visibility_status` | Mixer panel visibility |
| `set_mixer_visibility` | Show/hide mixer |
| `get_special_tracks_visibility_status` | Chord/tempo track visibility |
| `set_special_track_visibility` | Show/hide special tracks |

### Tick/Time Conversion
| Tool | Description |
|------|-------------|
| `tick_to_time` | Ticks → seconds |
| `time_to_tick` | Seconds → ticks |
| `tick_to_measure_pos` | Ticks → bar/beat position |
| `measure_pos_to_tick` | Bar/beat position → ticks |
| `editor_tick_to_global_tick` | Editor-local → global ticks |
| `global_tick_to_editor_tick` | Global → editor-local ticks |

## Key Concepts

### Tick System
- **480 ticks per quarter note** (standard MIDI resolution)
- Tempo automation affects tick-to-time conversion

### MIDI Pitch
- Range: 0–127
- Middle C = 60 (C4), A4 = 69
- Matches Reaper octave naming convention

### Track Types
- **Sing** — AI vocal synthesis tracks
- **Instrument** — AI instrument tracks
- **GenericMidi** — MIDI tracks without sound source
- **Audio** — Audio file tracks
- **Empty** — Placeholder slots (100 pre-allocated)

### Clip Types
- **Sing/Instrument/GenericMidi** — Note-based clips
- **Audio** — Audio file clips
- **Chord** — Chord progression clips

### Clip Geometry
```
Canvas:  [pos .................. pos+dur]
Visible:     [clipPos .. clipPos+clipDur]
Global:      [clipBegin ........ clipEnd]
```
- `clipBegin = pos + clipPos`
- `clipEnd = pos + clipPos + clipDur`

### Lyrics (Sing clips)
- **Per-note**: Each note gets individual lyric
- **Sentence mode** (recommended): Auto-distributes across notes
- **Syllable format**: `word#index` (e.g., `happy#1`, `happy#2`)
- **Tenuto**: `-` extends previous syllable across multiple notes
- Supported languages: CHN, JPN, ENG, SPA, KOR

## Relevance to Permute

ACE Studio's MCP server provides programmatic control over an AI vocal/instrument production application. Potential integration points with Permute:

1. **Mute sequencing** could control ACE Studio track mute/solo via `set_content_track_mute_solo`
2. **Pitch sequencing** could interact with note content via `add_notes_in_editor` or `get_note_clip_content`
3. **Transport sync** — ACE Studio has its own transport (`control_playback`) separate from Ableton
4. **Note manipulation** — Temperature-based variation could be applied to ACE Studio note data

The MCP server uses JSON-RPC 2.0 over HTTP, which could be accessed from Max/MSP via `maxurl` or a Node.js bridge.
