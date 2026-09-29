# EdMira content library

A starter catalogue of courses, study notes and practice questions for every
department and level a student can pick at sign-up (see
`src/reference/academic-options.ts`).

> **Drafted with AI and NOT yet medically reviewed.** Everything loads into the
> review queue as “EdMira content library”. An admin or reviewer must check and
> approve each topic and question in the dashboard before students see it.

## How it is organised

- Courses follow the NUC **CCMAS** (2022) and the programme curricula of Nigerian
  universities: general studies and basic sciences at 100 Level; anatomy,
  physiology and biochemistry at 200–300 Level; pathology and pharmacology at
  400 Level; clinical postings at 500–600 Level, with the professional courses of
  each programme (pharmacy, nursing, MLS, radiography, physiotherapy, public
  health, dentistry, biomedical engineering) at their own levels.
- Postgraduate programmes are not covered yet — the app shows postgraduate
  students a “coming soon” note and lets them browse every course.
- One course serves every programme that studies it: e.g. *Gross Anatomy I* is
  “for” 200 Level MBBS, BDS, Nursing, Physiotherapy, Radiography, Anatomy …
  (audience rules, no school filter because the national curriculum is shared).

## Files

| Path | What |
|---|---|
| `src/*.json` | Compact sources, one course per file (format in `build.mjs`) |
| `build.mjs` | `node content-library/build.mjs [--coverage]` → checks every question and writes `import/` |
| `videos.mjs` | `node content-library/videos.mjs [200- 300-]` → finds recommended YouTube videos per topic (trusted education channels only, each checked to exist) and saves them in `videos.json`; `build.mjs` adds them to the import files, and they arrive in the review queue as topic study materials |
| `import-videos/videos-update.json` | Videos only (course → topic titles → videos), made by `build.mjs`. Import this to add videos to courses you've **already imported** — it never re-sends questions and never creates topics |
| `import/*.json` | Import files: `{ "courses": [ … ] }` — the dashboard’s Import page and `yarn content:load` read these |

## Loading it

Either:

1. **Dashboard** → *Import* → choose all files in `import/` → tick “library
   content I didn't write” → *Check* → *Import to review queue*; or
2. **Command line** against the database: `MONGODB_URI=… yarn content:load`
   (add `--dry-run` to check first).

Both are safe to repeat: courses and topics are matched by title and repeated
questions are skipped. New courses are published straight away but stay hidden
from students until at least one of their topics is approved.
