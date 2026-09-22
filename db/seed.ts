// Bundled-content seed/reconciliation strategy (pseudocode).
// See docs/SYSTEM_DESIGN.md §8 for the full writeup.
//
// Two separate version concepts, deliberately kept apart:
//   - PRAGMA user_version  -> tracks *schema* migrations (new tables/columns)
//   - app_meta.bundled_content_version -> tracks *content* seed version
// Bumping the app's schema does not require re-seeding content, and vice versa.

import bundledExercises from "./bundled-exercises.json";
// Shape: { contentVersion: number, exercises: BundledExerciseDTO[] }
// Each BundledExerciseDTO has a stable `id` slug (e.g. "wall-sit", "heel-slide")
// that must never be reused for a different exercise once shipped.

async function runContentSeedIfNeeded(db: SQLiteDatabase) {
  const stored = await getAppMeta(db, "bundled_content_version");
  const storedVersion = stored ? parseInt(stored, 10) : 0;

  if (storedVersion === bundledExercises.contentVersion) {
    return; // fast path — nothing to do on most launches
  }

  await db.transaction(async (tx) => {
    const incomingIds = new Set(bundledExercises.exercises.map((e) => e.id));

    // 1. Upsert every exercise currently in the bundle.
    //    Un-deprecate on upsert too, in case something previously retired
    //    gets reintroduced in a later content version.
    for (const ex of bundledExercises.exercises) {
      await tx.run(
        `INSERT INTO exercises
           (id, source, name, instructions, image_ref,
            default_sets, default_reps, default_duration_sec, deprecated)
         VALUES (?, 'bundled', ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           instructions = excluded.instructions,
           image_ref = excluded.image_ref,
           default_sets = excluded.default_sets,
           default_reps = excluded.default_reps,
           default_duration_sec = excluded.default_duration_sec,
           deprecated = 0`,
        [ex.id, ex.name, ex.instructions, ex.imageRef,
         ex.defaultSets, ex.defaultReps, ex.defaultDurationSec]
      );
    }

    // 2. Soft-delete any bundled row no longer present in the new bundle.
    //    Never touch source='custom' rows here.
    const existingBundledIds = await tx.all(
      `SELECT id FROM exercises WHERE source = 'bundled'`
    );
    for (const row of existingBundledIds) {
      if (!incomingIds.has(row.id)) {
        await tx.run(`UPDATE exercises SET deprecated = 1 WHERE id = ?`, [row.id]);
      }
    }

    // 3. Record the new content version, in the same transaction as the
    //    data changes so a crash mid-seed can't leave version/data out of sync.
    await setAppMeta(tx, "bundled_content_version", String(bundledExercises.contentVersion));
  });
}

// Library browse query — excludes retired bundled exercises, includes all custom ones.
// SELECT * FROM exercises WHERE source = 'custom' OR (source = 'bundled' AND deprecated = 0)

// Routine step resolution (e.g. rendering an existing routine) — always resolves
// by id directly, no deprecated filter, so old routines keep working. UI layer
// can optionally show a "retired" badge when exercises.deprecated = 1.
// SELECT * FROM exercises WHERE id = ?
