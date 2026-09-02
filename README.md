# PT Exercise App

A React Native app for patients to manage and run their own physical therapy
exercise routines. Fully offline, no accounts, no backend.

## Scope

- **Users:** patients only, self-guided (no clinician-facing side)
- **Content:** illustrated steps + timers/reps counters (no video, no camera-based rep tracking)
- **Scale:** small — single clinic, hundreds of patients
- **Data:** informal/wellness-tier, not HIPAA — no special compliance handling required
- **Connectivity:** fully offline, no accounts or backend
- **Team:** solo dev / small team, ship fast

## Structure

```
docs/
  SYSTEM_DESIGN.md   — full architecture, schema, and key design decisions
db/
  schema.sql         — SQLite schema (exercises, routines, routine_steps, session_logs)
```

See `docs/SYSTEM_DESIGN.md` for the full design writeup, including the two
approaches considered for session timer/cue reliability (the riskiest piece)
and the reasoning behind the schema and storage choices.

## Status

Design phase — architecture and schema defined, not yet implemented.
