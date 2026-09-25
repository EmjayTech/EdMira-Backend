# EdMira Backend

NestJS + MongoDB API for the EdMira mobile app and the admin dashboard
(`~/Desktop/EdMira-Admin`).
All routes live under `/api/v1`. Interactive docs: `/api/docs` (Swagger).

## Run it

### Zero-setup (recommended for app development)

```bash
yarn install
yarn dev:memory
```

Starts the full API on `http://localhost:4000` with an **in-memory MongoDB**,
the sample courses / quizzes / news already loaded, and a demo student:

- student: **demo@edmira.com / Demo!2345**
- dashboard staff: **admin@ / creator@ / reviewer@edmira.com**, password **Staff!2345**
- Emails are *not* sent — sign-up and password-reset codes are printed in the
  terminal (`✉️` lines).
- Data is lost when you stop the server.

### With your own MongoDB

```bash
cp .env.example .env      # fill in MONGODB_URI, JWT secrets, RESEND_API_KEY, MAIL_FROM
yarn start:dev
yarn seed                 # optional: sample content (refused when NODE_ENV=production)
```

Redis is optional; without it, caching (pending sign-ups, logout blacklist) is
in-process, which is fine for a single instance.

## Connect the mobile app

In `EdMira-MobileApp/src/config/backend.ts`:

| `API_TARGET` | Talks to |
|---|---|
| `'local'` (default in dev) | this server on your computer — Android emulator `10.0.2.2:4000`, iOS simulator `localhost:4000`; for a physical phone put this Mac's Wi-Fi IP in `API_URLS.local` |
| `'production'` (always in release builds) | the deployed server |
| `'mock'` | sample data on the phone, no server |

End-to-end check using the app's own code (with `yarn dev:memory` running):

```bash
cd ../../EdMira1.0/EdMira-MobileApp
LIVE_API_URL=http://localhost:4000 npx jest liveBackend
```

## Endpoints

| Area | Method & path | Auth |
|---|---|---|
| Auth | `POST /auth/signup` → emails a code (account created on verify) | public |
| | `POST /auth/verify` `{email, code}` → `{accessToken, refreshToken, user}` | public |
| | `POST /auth/resend-otp`, `POST /auth/forgot-password`, `POST /auth/reset-password` | public |
| | `POST /auth/login` → `{accessToken, refreshToken}` | public |
| | `POST /auth/refresh` — refresh token in `Authorization: Bearer` | refresh token |
| | `GET /auth/profile`, `PATCH /auth/profile`, `POST /auth/logout` | ✓ |
| Reference | `GET /reference/academic-options` — sign-up pick-lists | public |
| Content | `GET /courses`, `/courses/:id`, `/topics/:id`, `/topics/:id/questions`, `/search?q=` | ✓ |
| Quizzes | `POST /quiz-attempts` (graded here, safe to retry), `GET /quiz-attempts`, `GET /quiz-attempts/:id` (owner only) | ✓ |
| Feedback | `POST /questions/:id/reports`, `POST /feedback` | ✓ |
| News | `GET /news?limit=`, `GET /news/:id` | ✓ |
| Admin | `/admin/courses`, `/admin/topics`, `/admin/questions` (+ `/:id/transitions` review workflow), `/admin/reports`, `/admin/feedback`, `/admin/students`, `/admin/quiz-attempts`, `/admin/audit-log` | staff role |

Full request/response shapes: `EdMira-MobileApp/docs/BACKEND_INTEGRATION.md` §3.

**Rules the server enforces:** students only see `published` topics/questions
inside `published` courses; quiz answers and explanations never leave the
server before submission; attempts are only readable by their owner; sign-up
values must come from `src/reference/academic-options.ts`.

## Staff accounts (admin dashboard)

```bash
yarn staff ada@edmira.com admin --password 'S3cure!pass' --name "Ada Obi"   # create
yarn staff someone@uni.edu reviewer                                         # promote existing
yarn staff someone@uni.edu none                                             # remove access
```

Roles: **admin** (everything), **creator** (writes content, submits for
review), **reviewer** (approves / requests changes / rejects, handles reports).
Permissions: `src/admin/permissions.ts`; review rules: `src/admin/workflow.ts`
(nothing publishes without approval, no self-approval, editing live content
sends it back to review). Every staff change is written to the audit log.

## Project layout

```
src/
  auth/        sign-up, OTP, login, refresh, profile (JWT; access 15 min, refresh 7 days)
  users/       user model + repository
  reference/   academic-options.ts — the sign-up lists (source of truth)
  content/     courses, topics, questions (status: draft | in_review | published | archived)
  quiz/        quiz attempts + server-side grading
  feedback/    question reports + product feedback
  news/        campus news
  admin/       dashboard API: staff guard, permissions, review workflow, audit log
  seed/        sample content (`yarn seed`) — NOT medically reviewed
  scripts/     `yarn staff` — create / promote staff accounts
  app.setup.ts global config shared by main.ts and the e2e tests
test/
  app.e2e-spec.ts          the app's full journey against a real (in-memory) MongoDB
  admin.e2e-spec.ts        dashboard roles, review workflow, suspensions, audit log
  support/in-memory-app.ts boots the app for tests and `yarn dev:memory`
```

To offer a new institution / department / level: add it to the enum in
`src/common/enum/`, then list it in `src/reference/academic-options.ts`
(`reference.spec.ts` fails if the two disagree).

## Tests

```bash
yarn test       # unit tests
yarn test:e2e   # full API journey (downloads a MongoDB binary on first run)
```

## Deploying (Render)

1. Deploy this branch; build `yarn install && yarn build`, start `yarn start:prod`.
2. Environment: everything in `.env.example` with `NODE_ENV=production`, and
   `ALLOWED_ORIGINS=<admin dashboard URL>` so the browser dashboard can call it.
3. Create the first admin: `MONGODB_URI=<prod uri> yarn staff you@edmira.com admin --password '…'`.
4. **Content:** production starts with no courses. Staff create it in the
   dashboard and a reviewer approves it before students see it. `yarn seed`
   (unreviewed sample content) refuses to run in production; for a staging
   database use `MONGODB_URI=<staging uri> yarn seed`.
