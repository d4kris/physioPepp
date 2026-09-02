# System Design: PT Exercise App

## 1. Constraints

| Dimension | Decision |
|---|---|
| Users | Patients only, self-guided |
| Content | Illustrated steps + timers/reps counters |
| Scale | Small — single clinic, hundreds of patients |
| Connectivity | Fully offline, no accounts, no backend |
| Compliance | None — informal/wellness-tier data, not HIPAA |
| Team | Solo dev / small team, ship fast |

These constraints push this toward a **local-first app** — closer in shape
to a workout-timer app than a clinical platform. No server, no sync, no auth
surface.

## 2. Architecture

```
┌─────────────────────────────────────────────┐
│                 React Native App              │
│                                               │
│  ┌───────────────┐   ┌─────────────────────┐ │
│  │ Exercise Library│   │  Routine Builder    │ │
│  │ (bundled + custom)│─▶│  (patient assembles │ │
│  │                 │   │  exercises + sets/  │ │
│  │                 │   │  reps/duration)     │ │
│  └───────────────┘   └─────────┬───────────┘ │
│                                 │              │
│                                 ▼              │
│                     ┌─────────────────────┐   │
│                     │  Session Runner      │   │
│                     │  (timer, rep counter,│   │
│                     │  audio/haptic cues)   │   │
│                     └─────────┬───────────┘   │
│                                 │              │
│                                 ▼              │
│                     ┌─────────────────────┐   │
│                     │  Local Persistence   │   │
│                     │  (SQLite: routines,   │   │
│                     │   history, streaks)   │   │
│                     └─────────────────────┘   │
└─────────────────────────────────────────────┘
```

Exercises come from two sources merged into one library view:

- **Bundled** — shipped in the app binary as JSON + images, read-only,
  updated via app releases (or a lightweight static JSON fetch from a CDN
  if content needs to update without a store release).
- **Custom** — created by the patient, with a photo (camera or gallery),
  stored on-device.

## 3. Hard parts

1. **Timers/cues staying accurate when the patient isn't looking at the
   phone.** The riskiest piece — see §5.
2. **Local data durability** — routine history and streaks live only
   on-device; needs real persistence (not in-memory state) and a sane
   migration story as the data model evolves across app versions.
3. **Rep counting without sensors** — reps are patient-tapped or shown as a
   target, not camera-tracked.
4. **No backup/transfer story** — no accounts means losing the phone means
   losing history. Worth a manual export (share a JSON/file) even without
   full sync.
5. **Content updates without an account system** — fine at
   bundle-with-app-release cadence; gets awkward if the clinic wants to
   push new exercises frequently.
6. **Custom exercise images** — user-supplied photos need stable on-device
   storage, compression, and cleanup (see §6).

## 4. Data model

See `db/schema.sql` for the full SQLite DDL. Summary:

- **`exercises`** — unified shape for bundled and custom exercises
  (`source` discriminates). Custom exercises reference an on-device image
  file; bundled ones reference a bundle-relative asset key.
- **`routines`** — patient-assembled sequences of exercises.
- **`routine_steps`** — join table between routines and exercises, carrying
  the per-routine `sets`/`reps`/`duration_sec`/`rest_sec`. This is
  intentional: the exercise defines *what*, the step defines *how much* for
  that routine (seeded from the exercise's defaults but overridable).
- **`session_logs`** — thin log of routine runs (started/completed
  timestamps, steps completed vs. total) to drive streaks/adherence. No
  per-set granularity — there's no clinician consuming this data, so
  detailed logging isn't needed yet. Additive later if required.

Key constraint decisions:

- `routine_steps.exercise_id` references `exercises(id)` **by id, not by
  copy** — editing a custom exercise's instructions updates it everywhere
  it's used.
- `ON DELETE RESTRICT` on that same foreign key — deleting a custom
  exercise that's still used by a routine is blocked at the DB layer,
  forcing the app to handle it explicitly (warn the user, or offer to
  remove it from those routines first) rather than silently orphaning
  references.
- `ON DELETE CASCADE` on `routine_steps.routine_id` and
  `session_logs.routine_id` — deleting a routine cleans up its steps and
  history. **Open question:** if session history should survive routine
  deletion (e.g. an all-time history view), drop the cascade on
  `session_logs.routine_id` and make it nullable instead.

## 5. Riskiest piece: timer/cue reliability during a session

The whole app hinges on the patient being able to put the phone down,
do the exercise, and trust it to cue them — often with the screen locked
or the app backgrounded. React Native's JS-thread timers get throttled or
suspended when the app backgrounds or the screen locks, on both iOS and
Android.

### Approach A — Foreground-only, JS timers

Keep the screen awake (`expo-keep-awake`) for the duration of the session
and run the timer/cues in JS while guaranteed foregrounded.

- **Pros:** simple, fast to build, no native scheduling complexity, no
  platform divergence.
- **Cons:** forces the patient to keep the phone visible/awake the whole
  time — awkward for exercises where the phone is set down across the
  room. Battery drain from the always-on screen. If the app backgrounds
  anyway (call, notification tap), the timer desyncs and cues stop firing.

### Approach B — Precomputed local notifications as source of truth

Compute the full cue schedule up front (every interval boundary, rest
period, "switch exercise" moment) and schedule each as a local
notification with sound (`expo-notifications` / `notifee`). The in-app UI
just reflects that schedule visually — it doesn't drive the cues.

- **Pros:** robust to backgrounding and screen lock, which matches how
  patients actually use it. Free "workout finished" notification.
- **Cons:** more complex — pausing, skipping, or resuming mid-session
  means re-diffing scheduled notifications. iOS caps pending local
  notifications at 64. Notification sound behavior differs from in-app
  audio (discrete cue points only, no continuous countdown ticks).

### Decision

**Approach B, scoped down:** schedule only the next 2–3 cue notifications
at a time and reconcile as the session progresses, rather than scheduling
the entire session up front. This avoids the iOS pending-notification cap
and the full-reschedule complexity of pause/skip, while still surviving
backgrounding — the behavior that actually matters for how this app gets
used. Pure Approach A tends to feel broken the first time a patient's
screen locks mid-exercise.

## 6. Custom exercise images

- Copy picked/captured images into the app's persistent document
  directory (`.../custom-exercise-images/{uuid}.jpg`) rather than storing
  the transient picker URI, which can be invalidated by the OS.
- Resize/compress on save (e.g. `expo-image-manipulator`) before
  persisting — camera photos can be several MB each.
- Keep bundled-asset resolution and custom-file-path resolution as two
  distinct code paths (e.g. a `resolveExerciseImage(exercise)` helper) so
  an app update can't silently break custom image references.
- Delete the associated image file when a custom exercise is deleted, to
  avoid storage leaks.
- Store the image as a **file path in SQLite, not base64 in the row** —
  base64 bloats size ~33% and doesn't scale well once the exercise list
  renders more than a couple dozen custom entries with images.

## 7. Open questions / next steps

- Seed/migration strategy for reconciling bundled exercise updates into
  existing installs across app versions.
- "Add custom exercise" flow state machine (capture/pick → compress →
  save → appears in library).
- Whether `session_logs` should survive routine deletion (see §4).
- Manual export format for history/routines, given no backend sync exists.
