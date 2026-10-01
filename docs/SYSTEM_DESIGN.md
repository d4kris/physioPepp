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
5. **Content updates without an account system** — solved by the seed
   strategy in §8.
6. **Custom exercise images** — user-supplied photos need stable on-device
   storage, compression, and cleanup (see §6).

## 4. Data model

See `db/schema.sql` for the full SQLite DDL. Summary:

- **`exercises`** — unified shape for bundled and custom exercises
  (`source` discriminates). Custom exercises reference an on-device image
  file; bundled ones reference a bundle-relative asset key. A `deprecated`
  flag marks bundled exercises retired from the library (see §8).
- **`routines`** — patient-assembled sequences of exercises.
- **`routine_steps`** — join table between routines and exercises, carrying
  the per-routine `sets`/`reps`/`duration_sec`/`rest_sec`. This is
  intentional: the exercise defines *what*, the step defines *how much* for
  that routine (seeded from the exercise's defaults but overridable).
- **`session_logs`** — thin log of routine runs (started/completed
  timestamps, steps completed vs. total) to drive streaks/adherence. No
  per-set granularity — there's no clinician consuming this data, so
  detailed logging isn't needed yet. Additive later if required.
- **`app_meta`** — single-row-per-key store for app-level metadata, used to
  track the currently-applied bundled content version (see §8). Distinct
  from schema migrations.

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

## 7. (reserved — see §6 for image handling, previously listed here)

## 8. Seed & content-update strategy

Bundled exercises ship as a versioned JSON asset
(`bundled-exercises.json`: `{ contentVersion, exercises: [...] }`), where
each exercise has a **stable id slug** (e.g. `"wall-sit"`) that must never
be reused for a different exercise once shipped.

Two version concepts are kept deliberately separate:

- **`PRAGMA user_version`** — tracks *schema* migrations (new tables/
  columns as the app's own data model evolves).
- **`app_meta.bundled_content_version`** — tracks *content* seed version
  (which version of the bundled exercise list has been applied).

Bumping one doesn't require touching the other.

**On app launch:**

1. Compare `app_meta.bundled_content_version` to the bundled asset's
   `contentVersion` constant. If equal, skip — no DB writes on the common
   path.
2. If the bundled version is newer, run a single transaction that:
   - **Upserts** every exercise in the new bundle by id (`source =
     'bundled'` rows only — custom rows are never touched). Un-deprecates
     on upsert, in case a previously retired exercise is reintroduced.
   - **Soft-deletes** any existing bundled row whose id is no longer in
     the new bundle, by setting `deprecated = 1` — chosen over hard delete
     so that patients with the retired exercise in an existing routine
     don't hit the `ON DELETE RESTRICT` constraint or lose routine data.
     Retired exercises drop out of library browse queries
     (`WHERE deprecated = 0`) but remain directly resolvable by id, so old
     routines keep working; the UI can optionally show a "retired" badge.
   - Writes the new `contentVersion` into `app_meta`, in the same
     transaction as the data changes, so a crash mid-seed can't leave the
     version and data out of sync.

See `db/seed.ts` for the pseudocode implementation.

## 9. Add-custom-exercise flow

Decisions: photo is **optional** (placeholder icon allowed, added later),
and the form is **multi-step** — Details → Image → Confirm — rather than
one screen, since compress/permission handling for the image step benefits
from being isolated from field validation.

### States

```
LIBRARY
   │ tap "Add exercise"
   ▼
DETAILS ──(Cancel)──▶ LIBRARY (draft discarded)
   │ Next (valid: name required; sets + one of reps/duration required)
   ▼
IMAGE ──(Skip)────────────────────────────▶ CONFIRM (no image)
   │ Camera / Gallery
   ▼
PERMISSION_CHECK ──(denied)──▶ IMAGE (inline error + link to Settings)
   │ granted
   ▼
CAPTURE_OR_PICK ──(user cancels)──▶ IMAGE (unchanged)
   │ image selected
   ▼
COMPRESSING ──▶ IMAGE (shows preview; Retake/Change or Next)
                   │ Next
                   ▼
                CONFIRM
   │
   ├─(Edit details)──▶ DETAILS  (draft preserved, incl. any image)
   ├─(Edit image)────▶ IMAGE
   └─(Save)
        ▼
     SAVING ──(failure)──▶ CONFIRM (error shown, retry)
        │ success
        ▼
     SUCCESS ──▶ LIBRARY (new exercise visible, confirmation toast)
```

### Notes

- **Draft is in-memory only**, not persisted to SQLite until Save. If the
  app is killed mid-flow, the draft is lost — an acceptable v1 tradeoff
  given this is a quick add-an-exercise form, not a long-form editor.
  Revisit if backgrounding-during-flow turns out to be common in practice.
- **Save ordering avoids orphaned files:** on Save, the (already-compressed)
  image is moved from its temp/cache location into
  `custom-exercise-images/{uuid}.jpg` *first*, then the `exercises` row is
  inserted referencing that filename. If the DB insert fails, the copied
  file is deleted as a compensating action — so a failed save never leaves
  an orphaned image file, and a successful DB row never references a
  missing file.
- **Validation on Details:** name is required; at least one of
  `defaultReps` / `defaultDurationSec` is required (mirrors the
  `RoutineStep` constraint from §4 — an exercise needs a rep count or a
  hold duration, not neither). `defaultSets` defaults to 1 if left blank.
  `instructions` is optional — some patients may rely on the image alone.
- **Permission denial** is handled inline in the IMAGE step rather than
  blocking the whole flow — the patient can still Skip and save with a
  placeholder, then add a photo later from the exercise's edit screen
  (same IMAGE sub-flow, entered from a different jumping-off point).

See `src/flows/addCustomExercise.ts` for the state/action pseudocode.

## 10. Open questions / next steps

- Whether `session_logs` should survive routine deletion (see §4).
- Manual export format for history/routines, given no backend sync exists.
- Edit-existing-custom-exercise flow (likely reuses the IMAGE/CONFIRM
  sub-states from §9, entered from a different starting point).
