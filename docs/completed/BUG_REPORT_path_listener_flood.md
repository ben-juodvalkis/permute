---
title: Permute `live.path` listener floods Live log after Simpler `replace_sample`, stalling the control thread
reporter: Ben Juodvalkis (ben.juodvalkis@gmail.com)
date: 2026-04-24
severity: high — causes multi-second audio-thread-adjacent stalls (~1–5s "control-thread hiccup")
status: **confirmed via isolated repro** — see "Controlled isolation" section below
affected_builds:
  - Ableton Live 12.4b16 (observed)
  - Permute.amxd at the commit currently checked out in /Users/Shared/DevWork/GitHub/permute
---

## Summary

When `Simpler.replace_sample` is called on a track that has `Permute.amxd` on it, `MxDCore._path_listener_callback` throws `RuntimeError: The Max function "SendMessage" returned with error 2: Bad parameter value` ~1,000 times within a few hundred milliseconds. The listener stays bound, so the errors continue to fire on subsequent LOM notifications too. Each error produces a full Python stack trace in Live's Log.txt.

Observed impact of a **single** `replace_sample` call in a clean set with only Permute on one track:

- **1,054** `MxDCore._path_listener_callback` tracebacks
- **9,486** `RemoteScriptError` lines in Log.txt
- **17** `control-thread hiccup` warnings (500 ms – 1.3 s each)
- All in a ~5 second window after a single OSC `replace_sample_onto_track` fire

Live becomes noticeably sluggish (UI lag, delayed clip arms, iPad surface falling out of sync). In a busier session we observed Log.txt grow to **470 MB** over a few hours of repeated captures. A full Live quit + relaunch clears the flood — until the next `replace_sample`.

## Controlled isolation (added 2026-04-24)

Earlier reports included circumstantial evidence and multiple M4L devices in scope (Permute, `looping-recorder.amxd`, `Track Key Controls.amxd`). We ran a controlled test that isolates Permute cleanly:

**Method.** Bypassed the Looping UI and bridge. Fired the OSC address directly at the Python Control Surface on `127.0.0.1:11020` using a stdlib Python one-liner, so no UI behavior, no auto-load of sequencer devices, and no other code paths were involved. Between tests, the Live set was manually prepared. Markers appended to `Log.txt` between tests for clean post-marker counting.

**OSC fire** (for reference by the Permute dev if they want to repro the same way):

```python
import socket
def pad(b):
    over = len(b) % 4
    return b if over == 0 else b + b"\x00" * (4 - over)
addr = pad(b"/looping/v3/simpler/replace_sample_onto_track\x00")
tags = pad(b",ss\x00")
a1   = pad(b"tracks/0\x00")
a2   = pad(b"/absolute/path/to/any/existing.wav\x00")
socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(
    addr + tags + a1 + a2, ("127.0.0.1", 11020))
```

**Test T1 (control).** Empty Live set. One track with an Empty Simpler. **No Max for Live devices anywhere** in the set (not on any track, not on any return, not on master). Single OSC fire at the Simpler track.

Result: sample swapped cleanly. **0 MxDCore errors, 0 RemoteScriptError lines, 0 control-thread hiccups.** This rules out Live 12.4b16 itself as a core bug, and rules out the Looping Control Surface's `replace_sample` path.

**Test T4 (Permute).** Same set as T1, with `Permute.amxd` added to the target track. No other M4L devices in the set. Single OSC fire at the Simpler track.

Result: sample swapped, **then the flood fired immediately**:

| Metric | T1 (no M4L) | T4 (only Permute) |
|---|---|---|
| MxDCore tracebacks | 0 | **1,054** |
| `_path_listener_callback` | 0 | **1,054** |
| `RemoteScriptError` | 0 | **9,486** |
| `control-thread hiccup` | 0 | **17** |
| `SendMessage "Bad parameter value"` | 0 | **1,054** |

Same OSC command, same target track (`tracks/0`), same sample file. The only variable was the presence of `Permute.amxd`. This is deterministic — we ran the cycle multiple times with consistent counts.

## Trigger (reproducible)

Sequence from a representative Log.txt window (T4, 2026-04-24T11:32):

```
11:32:24.969  SimplerLoadComponent: handle_replace_sample_onto_track args=['tracks/0', '.../capture_20260424_103822.wav']
11:32:24.970  DeviceLoadComponent:  handle_load args=('tracks/0', '', '.../Empty Simpler.adv')
11:32:24.970  DeviceLoadComponent:  resolved track=<Track.Track object at 0x33c39d9c0> name='Shaker'
11:32:25.024  DeviceLoadComponent:  load_item returned OK
11:32:25.027  SimplerLoadComponent: replace_sample OK — track idx=0, sample='.../capture_20260424_103822.wav'
11:32:25.0??  Exception: The Max function "SendMessage" returned with error 2: Bad parameter value.   ← flood begins
11:32:25.0??  RemoteScriptError: Traceback (most recent call last):
11:32:25.0??  RemoteScriptError:   File "output/Live/mac_universal_64_static/Release/python-bundle/MIDI Remote Scripts/_MxDCore/MxDCore.py", line 1087, in _path_listener_callback
11:32:25.0??  RemoteScriptError: RuntimeError
11:32:25.0??  RemoteScriptError: The Max function "SendMessage" returned with error 2: Bad parameter value.
...1,054 repeats over the next ~200ms, tailing off as stray listeners retry...
```

Exact exception (identical every time):

```
File "output/Live/mac_universal_64_static/Release/python-bundle/MIDI Remote Scripts/_MxDCore/MxDCore.py", line 1087, in _path_listener_callback
RuntimeError: The Max function "SendMessage" returned with error 2: Bad parameter value.
```

## Reproduction steps (minimal)

1. New Live 12.4 set. One audio or MIDI track with an Empty Simpler. No other devices anywhere. Confirm zero Max for Live devices in the set (check every track, every return, master).
2. Drag `Permute.amxd` onto the track. Do not add it anywhere else. Do not add any other M4L device.
3. Perform `Simpler.replace_sample` on the Simpler. Any path — UI, drag-drop a sample onto the Simpler's sample slot, or programmatically via the LOM.
4. Watch `~/Library/Preferences/Ableton/Live 12.4b16/Log.txt` (or the equivalent path for your Live version). The `_path_listener_callback` traceback begins firing within ~20 ms of `replace_sample` and produces ~1,000 errors.

Each subsequent `replace_sample` repeats the flood. Any other LOM notification in the session can re-trigger stale listeners that were logged during the first flood.

## Analysis / likely cause

`MxDCore.py:1087 _path_listener_callback` is Live's dispatcher for `live.path` / `live.observer` callbacks registered by Max for Live devices. `SendMessage ... Bad parameter value (error 2)` is what Max returns when the outlet destination is invalid — classically, the patcher is still wired up but the message it's trying to deliver references an id/path that no longer resolves to a live object.

`Simpler.replace_sample` swaps the `Sample` child object and (based on the structural `generation` advance we observe in the surface) replaces or invalidates some portion of the `SimplerDevice` identity. Any `live.path` in Permute that was resolved against the old device or sample id now holds a stale handle; the next tick of the listener fails, and the patcher does not unbind it, so every subsequent LOM notification retriggers the failure.

The isolation data (T4 shows 1,054 tracebacks from a single `replace_sample` fire on a clean set with only Permute present) strongly suggests Permute has multiple `live.path` / `live.observer` instances bound to objects inside the target track — likely scanning the device chain, or observing something per-device — and they all go stale at once when `replace_sample` mutates the tree.

## What we think Permute should do

One or more of the following, depending on what the patcher is actually binding:

1. **Guard every `live.path` with error routing.** Pipe the `live.path` right outlet (errors) through `route error` and, on error, send the followers `id 0` / `path ""` to detach. Today the bindings survive the first failure and keep re-erroring.
2. **Listen for `live.path`'s path-change notifications** and re-resolve rather than assuming the cached id is still valid. `live.path` emits `path` messages when the bound object is destroyed; if Permute is caching ids via `getid` / `live.observer` without listening, it will keep trying to SendMessage to a dead id.
3. **When the observed device is a Simpler/Sampler, expect `replace_sample` churn.** Either rebind on `sample` property change, or bind at a higher level (device id, not sample id) and re-read the sample lazily.
4. **De-dup listeners (`unique 1` on `live.path`)** so a repeated bind doesn't leave orphans behind.

If Permute is scanning all devices on the track (e.g. to offer them as parameter targets), consider only resolving paths for the currently-selected target and letting the rest go cold.

## What would help us diagnose faster next time

- A way to dump Permute's current set of `live.path` bindings (their source patcher location + resolved path) so we can tell at a glance which one has gone stale.
- A Permute-side log line when a `live.path` errors, including which internal feature owns it ("param observer", "track-select scan", etc.).

## Environment

- macOS Darwin 25.4.0 (Apple Silicon)
- Ableton Live **12.4b16** (`/Users/Music/Library/Preferences/Ableton/Live 12.4b16/Log.txt`)
- Looping Control Surface (Python, `ableton.v3.control_surface`) — repo: `github.com/ben-juodvalkis/Looping`
- Permute.amxd — repo: `github.com/ben-juodvalkis/permute` (local checkout `/Users/Shared/DevWork/GitHub/permute`)
- Ableton User Library is relocated to `/Users/Shared/Music/Soundbanks/Ableton/Live Libraries/User Library` (not `~/Music`)

## Mitigations we already know

- Full Live quit + relaunch clears the flood until the next `replace_sample`.
- Truncating the `Log.txt` file before relaunch prevents Live's own logger from becoming its own bottleneck on large accumulated logs.
- Removing Permute from the set eliminates the flood entirely (confirmed by T1 vs T4 above).

---

## Resolution (2026-04-24)

**Status: FIXED.** T4 re-run post-fix is clean — zero tracebacks, zero dispatcher errors.

| Metric | Baseline (T4) | Post-fix (T4) |
|---|---|---|
| `_path_listener_callback` tracebacks | 1,054 | **0** |
| `RemoteScriptError` lines | 9,486 | **0** |
| `SendMessage "Bad parameter value"` | 1,054 | **0** |
| `control-thread hiccup` warnings | 17 | 3 (all unrelated to Permute — 2 startup, 1 during Live's own sample-load I/O) |

### What was wrong (confirmed)

Permute does all its Live API binding programmatically in JS — `Permute.maxpat` contains zero `live.path` / `live.observer` objects, so the bug report's suggestion #1 ("guard `live.path` right outlet with `route error`") does not apply. Five observers are registered via `createObserver(path, property, callback)`. Two of them were the flood source, compounded by two bugs in Permute's observer lifecycle:

1. **Soft detach in `ObserverRegistry.unregister`.** The original code cleared only `observer.property = ""`. That tells Live to stop *future* property notifications, but it does **not** sever the path/id resolution — notifications already queued against the stale binding still fire `SendMessage` into `_path_listener_callback` and throw "Bad parameter value" on each.
2. **No debounce on observer fires during structural bursts.** Every `'device'` notification scheduled a full `detectInstrumentType()`; every `'instrument_params'` notification did the same. `Simpler.replace_sample` produces ~20 `devices` and dozens of `parameters` notifications in ~50ms. Twenty+ bind/unbind cycles each opened a fresh micro-window for Live to queue notifications against a path we were about to invalidate. The flood count of 1,054 is consistent with Live's dispatcher fanning out across all those intermediate stale bindings.

The `RuntimeError` stack trace (`_MxDCore/MxDCore.py:1087 _path_listener_callback`) originates in Live's Python dispatcher, *above* any JS callback. A try/catch inside the JS callback cannot catch it — the fix has to prevent the observer from being bound to a stale path in the first place.

### Fix (landed — JS only, 4 commits)

1. **`6eac67e` — Hard-detach in `ObserverRegistry`** (`permute-observer-registry.js`). Replaced the single `property = ""` assignment in both `unregister` and `clearAll` with the full Max4Live detach sequence (`property=""`, `path=""`, `id=0`, drop strong ref), each wrapped in its own try/catch. Severs Live's ability to reach a dying binding — queued notifications resolve to a no-op instead of erroring.

2. **`076e9f5` — Sync-detach + debounce on the `'device'` observer** (`permute-device.js`). The `'device'` callback now synchronously unregisters `'instrument_params'` and nulls `instrumentDevice` / `instrumentDeviceId` / `instrumentStrategy.transposeParam` **before** returning to Live's dispatcher. The deferred re-detection was replaced by a 75ms last-wins debounced `_scheduleDetection` Task — a burst of 20 notifications collapses into one `detectInstrumentType` after the device tree settles. The pending Task is cancelled in `notifydeleted` so it cannot fire against a dead device.

3. **`1512fd1` — Debounce `'instrument_params'` observer** (`permute-device.js`). After landing fix #2, the remaining flood was the `'instrument_params'` observer firing on every parameter-list mutation during `replace_sample` (playback position, filter state, sample name, loop markers — Simpler exposes all of these as live parameters). The fix: hoist the `parameter_transpose` short-circuit out of `defer()` so it's a synchronous early-return, and route the rare re-detection path through the same `_scheduleDetection` debounce.

4. **`32f9b78` — Use Simpler's Transpose param for parameter-based shifting** (`permute-constants.js`, `permute-instruments.js`, `permute-utils.js`). Not strictly required for the flood fix, but complementary: once Permute lands on `parameter_transpose` for Simpler (Transpose at param index 11, range −48..+48 semitones), subsequent `parameters` notifications short-circuit in the sync guard from fix #3. Also: octave shift is now one parameter write instead of a note rewrite, which plays better with overdubs and is trivially reversible.
    - Added `OriginalSimpler` to `parameterTransposeDevices`.
    - Changed `"transpose"` / `"octave"` `shiftAmount` from 16 to 12. The old value was right for rack macros (0–127 mapped to transpose internally); for semitone-native params, 12 is one octave.
    - `TransposeStrategy` now reads `min`/`max` from the param itself at construction time instead of hardcoding `MIDI_MIN..MIDI_MAX`. Simpler Transpose goes negative; the old clamp would have silently rejected downshifts from a negative baseline.
    - Removed the 17-param cap in `findTransposeParameterByName`. The cap was correct for rack macros; it excluded non-rack params at higher indices.

### Verification trace (Max Console, post-fix T4)

```
[Sequencer DEBUG:instrument] Detected device class_name: 'OriginalSimpler'
[Sequencer DEBUG:transpose] Found 'transpose' at param 11
[Sequencer DEBUG:instrument] Found transpose param 'transpose' at index 11 (shift: 12)
```

Exactly one detection, exactly one param scan, lands on `parameter_transpose`. Subsequent `replace_sample` notifications are silent — the sync guard in `'instrument_params'` short-circuits before any scheduling happens.

### What this means for the reporter's side

- **Looping Control Surface is fine.** T1 proved this before the fix; T4 confirms the Permute fix didn't regress anything on that path.
- **The 3 residual hiccups** in the post-fix T4 log are unrelated to Permute: 2 are startup-time (`StartLibraryRescan`, Move boot sequence), 1 is during Live's own sample-swap I/O (no `_path_listener_callback`, no `Bad parameter value`, just a 595ms stall while Live loads the waveform). None of these are addressable from the M4L side.
- **No action needed on the Looping repo.** Control surface code and OSC path were never the problem.

### Commits (permute repo, branch main)

```
32f9b78 feat(transpose): use Simpler's Transpose param for parameter-based shifting
1512fd1 fix(observers): debounce instrument_params to stop Simpler param-burst flood
076e9f5 fix(observers): sync-detach and debounce device observer to kill flood
6eac67e fix(observers): hard-detach on unregister to prevent stale path flood
```

---

## Fix in progress (2026-04-24)

### Root cause (confirmed by code walk)

Permute does all its Live API binding programmatically in JS — `Permute.maxpat` contains zero `live.path` / `live.observer` objects, so the bug report's suggestion #1 ("guard `live.path` right outlet with `route error`") does not apply. Five observers are registered via a small `createObserver(path, property, callback)` helper, and two of them are the flood source:

- **`'device'`** (permute-device.js, `setupDeviceObserver`) — bound to `trackState.ref.path` on property `"devices"`. Fires on every structural mutation to the track's device chain. `Simpler.replace_sample` produces a burst of ~20 of these in ~50ms.
- **`'instrument_params'`** (permute-device.js, `setupInstrumentParamsObserver`) — bound to `instrumentDevice.path` on property `"parameters"`. When `replace_sample` advances the Simpler's generation / mutates its child identity, this observer's cached path becomes stale in Live's dispatcher.

Two compounding problems turned a stale binding into a 1,054-count flood:

1. **Soft detach in `ObserverRegistry.unregister`.** The original code cleared only `observer.property = ""`. That tells Live to stop *future* property notifications, but it does **not** sever the path/id resolution — so notifications already queued against the stale binding still fire `SendMessage` into `_path_listener_callback` and throw "Bad parameter value" on each.
2. **No debounce on `'device'` fires.** Every notification in the ~20-wide burst scheduled a full `detectInstrumentType()` via `defer()`. Twenty bind/unbind cycles each opened a fresh micro-window for Live to queue notifications against a path we were about to invalidate — the flood count of 1,054 is consistent with Live's dispatcher fanning out across all those intermediate stale bindings.

The `RuntimeError` stack trace (`_MxDCore/MxDCore.py:1087 _path_listener_callback`) originates in Live's Python dispatcher, *above* our JS callback. Try/catch inside the JS callback cannot catch it — the fix has to prevent the observer from being bound to a stale path in the first place.

### Changes landed (MVP — 2 commits, JS only)

1. **`6eac67e` — Hard-detach in `ObserverRegistry`.** `permute-observer-registry.js`. Replaced the single `property = ""` assignment in both `unregister` and `clearAll` with the full Max4Live detach sequence (`property=""`, `path=""`, `id=0`, drop strong ref), each wrapped in its own try/catch. This severs the dispatcher's ability to reach a dying binding — queued notifications resolve to a no-op instead of erroring.

2. **`076e9f5` — Sync-detach + debounce on the `'device'` observer.** `permute-device.js`. The `'device'` callback now synchronously unregisters `'instrument_params'` and nulls `instrumentDevice` / `instrumentDeviceId` / `instrumentStrategy.transposeParam` **before** returning to Live's dispatcher. The deferred re-detection was replaced by a 75ms last-wins debounced `_scheduleDetection` Task — a burst of 20 notifications collapses into one `detectInstrumentType` after the device tree settles. The pending Task is cancelled in `notifydeleted` so it cannot fire against a dead device.

Debug mode is enabled (`permute-utils.js` `DEBUG_MODE = true`) for verification; to be flipped back off once the fix is confirmed.

### Diagnostic / verification plan

**Primary (T4 re-run).** Same setup as T4 above: new Live 12.4 set, one track, Empty Simpler, `Permute.amxd` on the track, no other M4L anywhere. Fire the OSC one-liner once. Expected:

| Metric | Baseline (T4) | Target (post-fix) |
|---|---|---|
| `_path_listener_callback` tracebacks | 1,054 | **0** |
| `RemoteScriptError` lines | 9,486 | **0** |
| `control-thread hiccup` warnings | 17 | **0** |
| `SendMessage "Bad parameter value"` | 1,054 | **0** |

**What the Max Console should show** (with `DEBUG_MODE = true`): at most **one** `[Sequencer DEBUG:instrument]` line per `replace_sample` fire (from the debounced detection 75ms after the burst settles), not 20+. If multiple `instrument` lines appear per fire, the debounce isn't coalescing — report the count.

**Secondary repros** (exercise adjacent paths; run only if T4 primary passes):

1. **Rapid consecutive `replace_sample`.** Fire the OSC three times in ~50ms. Debounce should still collapse to one detection.
2. **Drum Rack swap-in.** Track with a Drum Rack (`parameter_transpose` active via `Custom E` macro) — swap the whole rack for a different Drum Rack. Exercises the `revertTranspose()` path inside `_scheduleDetection`.
3. **Delete `Permute.amxd` during/after `replace_sample`.** Exercises `notifydeleted → clearAll` under the hardened detach, and the pending-task cancellation.
4. **Soak.** 50 `replace_sample` fires over 60 seconds. Log.txt growth should stay under 100KB, zero hiccups.

**If T4 is not clean post-fix**, the remaining noise points at which defense-in-depth change to land next:
- Residual tracebacks during rack loading → Change 5 (retry-race fix in `scheduleDetectionRetries`).
- Tracebacks on step ticks after a swap (not at `replace_sample` time) → Change 4 (`isLiveAPIFresh` guard in `TransposeStrategy.applyTranspose`).
- Any new uncaught-exception errors sourced from Permute JS → Change 6 (try/catch in `createObserver`).

These three defense-in-depth changes are designed and captured in `/Users/Music/.claude/plans/fizzy-crafting-flute.md`. They are **not** landed yet — we are gating their inclusion on the T4 result, to keep the bisectable surface small and avoid changing paths the MVP didn't need to touch.

### Files changed in the MVP

- `permute-observer-registry.js` — hard detach (Change 1)
- `permute-device.js` — sync detach + debounce (Changes 2 + 3)
- `permute-utils.js` — `DEBUG_MODE = true` for verification (revert before merge)
