# EdMira Backend

NestJS + MongoDB API for the EdMira mobile app (and, later, the admin dashboard).
All routes live under `/api/v1`. Interactive docs: `/api/docs` (Swagger).

## Run it

### Zero-setup (recommended for app development)

```bash
yarn install
yarn dev:memory
```

Starts the full API on `http://localhost:4000` with an **in-memory MongoDB**,
the sample courses / quizzes / news already loaded, and a demo student:

- **demo@edmira.com / Demo!2345**
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

Full request/response shapes: `EdMira-MobileApp/docs/BACKEND_INTEGRATION.md` §3.

**Rules the server enforces:** students only see `published` topics/questions
inside `published` courses; quiz answers and explanations never leave the
server before submission; attempts are only readable by their owner; sign-up
values must come from `src/reference/academic-options.ts`.

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
  seed/        sample content (`yarn seed`) — NOT medically reviewed
  app.setup.ts global config shared by main.ts and the e2e tests
test/
  app.e2e-spec.ts          the app's full journey against a real (in-memory) MongoDB
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
2. Environment: everything in `.env.example` with `NODE_ENV=production`.
3. **Content:** production starts with no courses. Sample content is for
   testing only and `yarn seed` refuses to run in production. Real content
   should be created and medically reviewed through the admin dashboard
   (its `/admin/*` endpoints are the next piece of backend work — contract in
   `EdMira-Admin/docs/ADMIN_API.md`). For a staging database, run
   `MONGODB_URI=<staging uri> yarn seed`.
