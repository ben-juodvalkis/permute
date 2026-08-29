# ADR-018: LiveAPI Handle Ownership — GC Re-entrancy Hazard

**Status:** Accepted
**Date:** 2026-08-28
**Refines:** the `hardDetach` helper introduced privately in `permute-observer-registry.js`
**Related:** ADR-012 (stale parameter handles in `MuteStrategy`), ADR-011 (observer-driven clip cache)

## Context

Ableton Live 12.4.5b11 hard-crashed while a clip was being triggered in a set
with three Permute instances loaded. The crash was a `SIGTRAP` /
`EXC_BREAKPOINT` from `V8_Fatal` → `v8::base::OS::Abort` — V8 deliberately
aborting the host process, not a segfault. Captured in
`~/Library/Logs/DiagnosticReports/Live-2026-08-28-131424.ips`.

### The crash stack (oldest frame first)

```
NSApplication run → CFRunLoop → juce::MessageQueue::runLoopCallback
  → sched_dequeue → defer_exec → v8_dequeue → v8_doanything
  → v8::platform::DefaultPlatform::PumpMessageLoop
  → v8::internal::ScavengeJob::Task::RunInternal          <-- minor GC starts
  → Heap::CollectGarbage → Heap::PerformGarbageCollection
  → GlobalHandles::InvokeFirstPassWeakCallbacks
  → v8_cleanup(v8::WeakCallbackInfo<max_object_class>)     <-- GC finalizer
  → max_object_class::~max_object_class → v8_peerhash_remove
  → object_free → freeobject
  → jsliveapi_free(_jsliveapi*)                            <-- LiveAPI destructor
  → jsliveapi_handlemessage(...)                           <-- sends detach INTO Live
  → [Live LOM frames, boost::python exception translators]
  → Wires::SendMessage(plug_DeviceRef*, ...)               <-- Live notifies back OUT
  → jsliveapi_sendmessage → jsliveapi_callback
  → jsfunction_call → v8::Function::Call
  → v8::internal::Execution::Call → Invoke
  → V8_Fatal → v8::base::OS::Abort                         <-- CRASH
```

### Root cause

A `LiveAPI` object became unreachable in JS and was left for V8's garbage
collector. When a scavenge collected it, its finalizer freed the underlying Max
object, which sent an unobserve/detach message into Live's LOM. Live answered
*synchronously* by dispatching a notification back into the v8 instance, which
tried to invoke a JS callback.

**Calling into JavaScript from inside a V8 GC weak callback is illegal.** V8
asserts and aborts the entire Live process. There is no recovery and no error
dialog — Live simply dies.

The load-bearing fact that makes this reachable from ordinary code:

> **Every `LiveAPI` object registers a path listener with Live, whether or not
> you passed it an observer callback.**

So *any* handle released to the GC instead of being detached explicitly is a
live grenade. The crash is intermittent only because it needs a scavenge to
land on a released handle; the set in question had been open about an hour
before it went off.

### Why triggering a clip set it off

`setupSlotObservers` observes `playing_slot_index` and `fired_slot_index`.
Every clip launch fires those, calling `_refreshClipFromSlots()`, which
constructed a fresh `LiveAPI` for the clip path and handed it to
`_setCachedClip()`, which overwrote `this._cachedClip` and dropped the previous
handle undetached. That was the highest-visibility handle-churn path, so it is
the one that eventually coincided with a GC.

It was the symptom, not the disease. `permute-observer-registry.js` already
knew about the hazard — its `hardDetach()` helper carried a comment describing
exactly this failure mode — but `hardDetach` was reachable only from inside
`ObserverRegistry`, and only observers registered by name went through it.
**Every other `LiveAPI` in the codebase was created with a bare
`new LiveAPI(...)` and dropped on the floor.** The codebase had one safe path
and a dozen unsafe ones, with nothing structural preventing the next one from
being unsafe too.

### Measured leak inventory (before)

A stubbed-LiveAPI harness driving init → 200 clip launches → 2000 transport
ticks → 50 instrument re-detections → `notifydeleted`:

| Path | Handles created |
|------|-----------------|
| `_emitStepBroadcast` (`this_device`) | 1 per step broadcast — the fastest source in the device |
| `MuteStrategy.applyMute` (rack macro) | 1 per mute flip, i.e. at sequencer rate |
| `_refreshClipFromSlots` (clip) | 1.00 per clip launch |
| `findTransposeParameterByName` (params) | ~20 per detection, 19 discarded |
| `InstrumentDetector.findInstrumentDevice` | 1 per device walked past |
| `init` (`this_device`, track) | 1–2 per init |

**1826 handles were left attached to Live after teardown**, every one of them
unreachable from JS and waiting for a scavenge.

## Decision

Make it structurally impossible to create an undetached handle, rather than
auditing for them.

### The invariant

> A `LiveAPI` object must never become garbage while it still holds a Live path
> listener. Every handle Permute creates is either **owned and reachable**, or
> **explicitly detached** — never merely dropped.

### The ownership model

**1. Single chokepoint.** All creation and release lives in `permute-utils.js`,
behind a `HandlePool`. No bare `new LiveAPI(...)` anywhere else.

| Method | Role |
|--------|------|
| `pool.create(path)` | Create an owned, pooled handle |
| `pool.observer(path, property, cb)` | Create an owned, pooled observer |
| `pool.release(obj)` | Hard-detach + drop from pool; returns `null` |
| `pool.repoint(obj, path)` | Re-point an owned handle (creates on first use) |
| `pool.borrow(path, fn)` | Scoped borrow; releases in a `finally` |
| `pool.releaseAll()` | Drain this device's pool (teardown backstop) |
| `pool.size()` | Diagnostic: a count that climbs while playing means a per-tick creator |
| `hardDetach(obj)` | The shared primitive (`property=""`, `path=""`, `id=0`) |

The pool holds a strong reference to every live handle, so the GC only ever
sees objects that are already inert. `release` is safe on `null`, safe to call
twice, and safe on an already-invalid handle — each step of `hardDetach` is
individually guarded.

**The pool is an instance, owned by the `SequencerDevice`,** and threaded to
everything that makes handles (`ObserverRegistry`, the strategies, the two
detection scans). It is deliberately not module-level state. Permute is
routinely loaded several times in one set — the crashing set had three — and
whether Max gives each `v8` object its own required-module instance is not
something to bet observation correctness on. With a module-level pool, one
device's teardown drain would hard-detach the other devices' observers if that
assumption were ever false: they would keep sequencing off `song_time` while
silently deaf to slot and transport changes, writing to a frozen clip. That is
the "fails quietly" outcome this ADR is otherwise trying to avoid, so the pool
is scoped to make it structurally impossible rather than merely unlikely.

**`repoint` fails safe, not open.** If the `path` assignment throws, the handle
is still resolved to its *previous* target, and every caller validates with
`id !== INVALID_LIVE_API_ID` — which a stale-but-valid id passes. `repoint`
therefore calls `hardDetach` on a failed re-point so the handle reads as
invalid and the existing guards reject it, matching the fail-safe behavior of
the construct-a-new-handle form it replaced. Without this, a failed re-point
would silently write mutes and temperature to the clip that stopped playing,
set the mute macro on a replaced rack, or record the wrong parameter index
mid-scan.

**2. Re-point, don't churn.** Anything queried repeatedly in a stable role
keeps one long-lived handle and reassigns its `path`:

- `SequencerDevice._clipHandle` — the cached clip (`_refreshClipFromSlots`)
- `SequencerDevice._deviceHandle` — `this_device` (`_emitStepBroadcast`)
- `MuteStrategy._paramHandle` — the rack macro (`applyMute`)
- scan scratch handles in `findTransposeParameterByName` and
  `findInstrumentDevice`

Assigning `path` re-resolves the handle exactly as constructing a new one does,
and moves the path listener with it. This **preserves ADR-012's contract**:
`MuteStrategy` still re-resolves the parameter path on every write (which is
required — rack mutations invalidate parameter handles), it just stops
allocating a new object to do it.

Identity semantics are preserved: `_refreshClipFromSlots` still short-circuits
on an unchanged path before reaching `_setCachedClip`, so the temperature-
observer teardown and `clipState.update` still fire exactly when the underlying
clip actually changes — not on every re-point. When there is no clip,
`_cachedClip` is `null` as before and the owned handle is parked on an empty
path.

**3. Borrow for genuine one-shots.** `pool.borrow(path, fn)` detaches in a
`finally`, so a transient handle cannot escape even if the body throws. After
the re-pointing work there are no remaining one-shot sites in the device; it is
provided and tested as the sanctioned pattern for future ones.

**4. Complete teardown.** `SequencerDevice.releaseAllHandles()` detaches
observers, instrument/strategy handles, the clip handle, the `this_device`
handle and the track ref, then drains the pool as a backstop. It runs from
`notifydeleted` (a device removed from a track must leave no listeners behind)
and at the top of `init` (so a script reload does not strand the previous run's
handles).

**5. One lifetime system, not two.** `ObserverRegistry` no longer owns a
private `hardDetach`. It is constructed with the owning device's pool, its
observers come from `pool.observer()`, and it releases them through
`pool.release()`; `hardDetach` is now the shared primitive in
`permute-utils.js`.

### Enforcement

The rule is stated in `CLAUDE.md` with the grep that checks it:

```bash
grep -n "new LiveAPI" *.js | grep -v permute-utils.js
```

Any hit is a defect. A rule nobody can check is a rule that decays.

## Consequences

### Measured (stubbed-LiveAPI harness, identical scenario)

| Metric | Before | After |
|--------|--------|-------|
| Handles per transport tick | 0.251 | **0.000** |
| Handles per clip launch | 1.00 | **0.01** (one-time handle, amortized) |
| Handles per instrument re-detection | 22.00 | 4.00 (all released; attached count flat) |
| **Attached handles after teardown** | **1826** | **0** |

Two further properties are covered by the harness: a `repoint` whose `path`
assignment throws leaves the handle reading invalid (`id` 0) rather than
resolved to its previous target, and draining one device's pool leaves a second
device's handles attached and owned.

In steady state the device now creates **zero** handles: 200 clip launches plus
2000 transport ticks constructed nothing at all and left the pool size flat.

### No behavior change

A scenario driving sequencing, temperature (capture → variation → loop jump →
restore), chance, parameter transpose, note mute, solo override, clip switching,
time-signature change, instrument churn and transport start/stop was traced at
the Live API boundary on both trees. **All 234 traced operations — `set`,
`call`, and `outlet` — are byte-identical between HEAD and this change.**

One deliberate difference, in a teardown path only: a batch-apply Task still
queued when `notifydeleted` fires now no-ops (the clip cache is cleared) instead
of writing through a handle Live is about to invalidate. This is unobservable
musically and strictly safer.

### Load-bearing assumption

The fix rests on `LiveAPI`'s `path` property being writable and re-resolving
the handle — standard, documented Max behavior, and already relied upon by
`hardDetach` (`path = ""`) and observer setup. The verification harness stubs
`LiveAPI`, so this specific semantic is assumed rather than measured.

### Testing note

**`Permute.amxd` still embeds the previous JS.** `autowatch` only watches the
main file (`permute-device.js`), not the modules — and this change touches
`permute-utils.js`, `permute-instruments.js` and
`permute-observer-registry.js`. **The device must be deleted and re-added in
Live to pick this up.** A reloaded main file running against stale module
bytecode will not have the fix.

The real proof is a long session with heavy clip triggering and no abort; that
cannot be observed from here.
