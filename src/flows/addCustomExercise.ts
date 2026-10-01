// Add-custom-exercise flow — state machine pseudocode.
// See docs/SYSTEM_DESIGN.md §9 for the full writeup and state diagram.

type FlowState =
  | { step: "details"; draft: Draft; errors?: DetailsErrors }
  | { step: "image"; draft: Draft; imagePreviewUri?: string; permissionError?: boolean }
  | { step: "confirm"; draft: Draft }
  | { step: "saving"; draft: Draft }
  | { step: "error"; draft: Draft; message: string };

type Draft = {
  name: string;
  instructions: string;         // optional, may be ""
  defaultSets: number | null;   // defaults to 1 if left blank at validation
  defaultReps: number | null;
  defaultDurationSec: number | null;
  // Local-only reference until Save commits it — a cache/tmp file path,
  // NOT yet the final custom-exercise-images/{uuid}.jpg location.
  pendingImageUri: string | null;
};

type Action =
  | { type: "FIELD_CHANGED"; field: keyof Draft; value: string | number }
  | { type: "DETAILS_NEXT" }
  | { type: "DETAILS_CANCEL" }
  | { type: "IMAGE_SOURCE_CHOSEN"; source: "camera" | "gallery" }
  | { type: "IMAGE_PERMISSION_RESULT"; granted: boolean }
  | { type: "IMAGE_PICKED"; uri: string }
  | { type: "IMAGE_PICK_CANCELLED" }
  | { type: "IMAGE_COMPRESSED"; uri: string }
  | { type: "IMAGE_SKIP" }
  | { type: "IMAGE_NEXT" }
  | { type: "CONFIRM_EDIT_DETAILS" }
  | { type: "CONFIRM_EDIT_IMAGE" }
  | { type: "CONFIRM_SAVE" }
  | { type: "SAVE_SUCCEEDED" }
  | { type: "SAVE_FAILED"; message: string };

function validateDetails(draft: Draft): DetailsErrors | null {
  const errors: DetailsErrors = {};
  if (!draft.name.trim()) errors.name = "Name is required";
  if (draft.defaultReps == null && draft.defaultDurationSec == null) {
    errors.repsOrDuration = "Enter a rep count or a hold duration";
  }
  return Object.keys(errors).length ? errors : null;
}

// Reducer sketch — actual implementation likely React state + navigation,
// but the transition table below is the contract regardless of framework.
function reduce(state: FlowState, action: Action): FlowState {
  switch (state.step) {
    case "details":
      if (action.type === "DETAILS_NEXT") {
        const errors = validateDetails(state.draft);
        if (errors) return { ...state, errors };
        return { step: "image", draft: normalizeDefaults(state.draft) };
      }
      if (action.type === "DETAILS_CANCEL") {
        return { step: "details", draft: emptyDraft() }; // caller navigates back to LIBRARY
      }
      break;

    case "image":
      if (action.type === "IMAGE_PERMISSION_RESULT" && !action.granted) {
        return { ...state, permissionError: true };
      }
      if (action.type === "IMAGE_COMPRESSED") {
        return { step: "image", draft: { ...state.draft, pendingImageUri: action.uri }, imagePreviewUri: action.uri };
      }
      if (action.type === "IMAGE_SKIP" || action.type === "IMAGE_NEXT") {
        return { step: "confirm", draft: state.draft };
      }
      break;

    case "confirm":
      if (action.type === "CONFIRM_EDIT_DETAILS") return { step: "details", draft: state.draft };
      if (action.type === "CONFIRM_EDIT_IMAGE") return { step: "image", draft: state.draft };
      if (action.type === "CONFIRM_SAVE") return { step: "saving", draft: state.draft };
      break;

    case "saving":
      if (action.type === "SAVE_SUCCEEDED") return { step: "confirm", draft: emptyDraft() }; // caller navigates to LIBRARY
      if (action.type === "SAVE_FAILED") return { step: "confirm", draft: state.draft }; // + surface action.message
      break;
  }
  return state;
}

// Save — called on CONFIRM_SAVE. Order matters: write the file before the
// DB row, and compensate (delete the file) if the DB insert fails, so a
// failed save never orphans an image and a saved row never references a
// missing file.
async function saveCustomExercise(db: SQLiteDatabase, draft: Draft): Promise<void> {
  let finalImageRef = "placeholder"; // sentinel resolved to a default icon by resolveExerciseImage()

  if (draft.pendingImageUri) {
    const filename = `${uuid()}.jpg`;
    await moveFile(draft.pendingImageUri, `${documentDirectory}/custom-exercise-images/${filename}`);
    finalImageRef = filename;
  }

  try {
    await db.run(
      `INSERT INTO exercises
         (id, source, name, instructions, image_ref,
          default_sets, default_reps, default_duration_sec, created_at)
       VALUES (?, 'custom', ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), draft.name.trim(), draft.instructions.trim(), finalImageRef,
       draft.defaultSets ?? 1, draft.defaultReps, draft.defaultDurationSec, nowIso()]
    );
  } catch (err) {
    if (finalImageRef !== "placeholder") {
      await deleteFile(`${documentDirectory}/custom-exercise-images/${finalImageRef}`); // compensate
    }
    throw err;
  }
}
