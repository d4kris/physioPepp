// Routine export/share summary — pseudocode.
// See docs/SYSTEM_DESIGN.md §10 for the full writeup and approach comparison.
//
// Purpose: a human-readable, printable one-pager for a PT/doctor.
// NOT a backup/restore mechanism — see §3 (hard parts) for why that's an
// accepted limitation rather than something this feature solves.

type ExportInput = {
  routine: Routine;
  steps: Array<{ step: RoutineStep; exercise: Exercise }>;
  recentActivity: {
    windowDays: number;          // e.g. 30
    sessionsCompleted: number;
    currentStreakDays: number;
  };
};

async function exportRoutineSummary(input: ExportInput): Promise<void> {
  const html = buildSummaryHtml(input);

  // expo-print renders the HTML in a WebView and rasterizes to PDF.
  const { uri } = await Print.printToFileAsync({ html });

  // Hands off to the native share sheet (email, AirDrop, print, Files, etc).
  // No app-specific handling of the destination — once shared, it's the
  // patient's/clinician's PDF to do with as they like.
  await Sharing.shareAsync(uri, {
    mimeType: "application/pdf",
    dialogTitle: `${input.routine.name} — Exercise Summary`,
  });
}

function buildSummaryHtml(input: ExportInput): string {
  const rows = input.steps
    .sort((a, b) => a.step.order - b.step.order)
    .map(({ step, exercise }) => {
      const amount = step.durationSec
        ? `${step.durationSec}s hold`
        : `${step.reps} reps`;
      return `
        <tr>
          <td>${escapeHtml(exercise.name)}</td>
          <td>${step.sets} sets × ${amount}</td>
          <td>${step.restSec}s rest</td>
        </tr>`;
    })
    .join("");

  // Deliberately plain, print-friendly layout — no exercise images (see
  // §10 decision: images are a stretch enhancement, not day-one scope).
  return `
    <html>
      <body style="font-family: -apple-system, sans-serif; padding: 24px;">
        <h1>${escapeHtml(input.routine.name)}</h1>
        <table style="width:100%; border-collapse: collapse;" border="1" cellpadding="8">
          <thead><tr><th>Exercise</th><th>Sets / Amount</th><th>Rest</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top: 24px; color: #555;">
          Last ${input.recentActivity.windowDays} days:
          ${input.recentActivity.sessionsCompleted} sessions completed,
          current streak ${input.recentActivity.currentStreakDays} days.
        </p>
      </body>
    </html>`;
}

// recentActivity is computed from session_logs directly — this is a
// live-routine action (export is offered from the routine detail screen),
// so routine_id is guaranteed non-null here; no need to touch the
// routine_name_snapshot fallback used for deleted-routine history views.
// SELECT COUNT(*) FROM session_logs
//   WHERE routine_id = ? AND completed_at IS NOT NULL
//     AND started_at >= date('now', '-30 days')
