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
| | `POST /auth/resend-otp`, `POST /auth/forgot-password`, `POST /auth/reset-password` — forgot/reset take `{email}` or `{identifier}` (username); the reply never says whether an account exists | public |
| | `POST /auth/login` `{email, password}` or `{identifier, password}` (email or username, any case) → `{accessToken, refreshToken}`. Errors: 401 `INVALID_CREDENTIALS` (always the same), 429 `LOGIN_LOCKED` | public |
| | `GET /auth/username-available?username=` → `{available}` or `{available:false, reason: invalid\|reserved\|offensive\|taken}` (20/min per IP) | public |
| | `PATCH /auth/username` `{username}` → profile (once every 30 days; `USERNAME_CHANGE_TOO_SOON` with `nextChangeAt`) | ✓ |
| | `POST /auth/refresh` — refresh token in `Authorization: Bearer` | refresh token |
| | `GET /auth/profile`, `PATCH /auth/profile`, `POST /auth/logout` | ✓ |
| Reference | `GET /reference/academic-options` — sign-up pick-lists | public |
| Content | `GET /courses`, `/courses/:id`, `/topics/:id`, `/topics/:id/questions`, `/search?q=` | ✓ |
| Quizzes | `POST /quiz-attempts` (graded here, safe to retry), `GET /quiz-attempts`, `GET /quiz-attempts/:id` (owner only) | ✓ |
| Feedback | `POST /questions/:id/reports`, `POST /feedback` | ✓ |
| News | `GET /news?limit=`, `GET /news/:id` | ✓ |
| Leaderboards | `GET /leaderboards?scope=course\|level\|school\|all` (top 20 + your rank + gap to the next tier), `GET /leaderboards/schools`, `GET /me/progress-summary` (streak, topics mastered, week points / rank) | ✓ |
| Privacy | `PATCH /auth/privacy` `{showOnLeaderboard, findability: everyone\|exact\|nobody, requestsFrom: everyone\|school\|nobody, shareProgress, shareScores, muteRequestNotifications}` → profile | ✓ |
| Classmates | `GET /people/search?q=` (3+ chars, ≤10, 30/min + 300/day per student), `GET /people/:username` (card; 404 for anyone you can't see), `POST /connections` `{username, note?}` (always `{ok:true}`), `GET /connections`, `GET /connections/requests`, `POST /connections/:id/accept\|decline\|cancel`, `DELETE /connections/:id`, `GET/POST /blocks`, `DELETE /blocks/:username`, `POST /reports/users`, `GET /notifications`, `POST /notifications/read-all`, `GET /me/social-summary` | ✓ |
| Invites | `GET /invites/:username` (public, for an invite page), `GET /me/referrals` → `{count}`; sign-up `referralCode` = the inviter's username | public / ✓ |
| Challenges | `POST /challenges` `{topicId, username?}` (connection, or a code to share), `GET /challenges`, `GET /challenges/:id`, `GET /challenges/link/:code`, `GET /challenges/public/:code` (public), `POST /challenges/:id/accept\|decline\|cancel\|start\|submit` | ✓ |
| Analytics | `POST /analytics/events` `{name: leaderboard_viewed\|progress_card_shared, detail?}` | ✓ |
| Admin | `PATCH /admin/students/:id/username`, `GET /admin/students/:id/usernames` (moderation), `/admin/courses`, `/admin/topics`, `/admin/questions` (+ `/:id/transitions` review workflow), `/admin/reports`, `/admin/feedback`, `/admin/students`, `/admin/quiz-attempts`, `/admin/audit-log` | staff role |

Full request/response shapes: `EdMira-MobileApp/docs/BACKEND_INTEGRATION.md` §3.

**Usernames** are a student's public identity and a login name. Rules live in
`src/users/username-policy.ts`: 3–20 letters, numbers, `_` and `.` (not first or
last), unique ignoring case, not reserved (`admin`, `support`, anything starting
with `edmira`…) and not offensive (the word lists are in the same file). Students
can change theirs once every 30 days; a released name stays reserved for 30 days
(`username_history`). Admins can change any student's username (Students page),
which is audit-logged. Accounts from before Nov 2026 may break the rules or share
a username: they still log in, and login picks the account the password opens.

**Login protection:** one generic error for any wrong email/username/password,
the same response time whether or not the account exists, and a 15-minute
lockout after 5 failures per identifier + IP (`src/auth/login-attempts.service.ts`;
in-memory unless Redis is configured). `trust proxy` is on so `req.ip` is the
student's address behind Render's proxy.

**Getting existing accounts ready** (`yarn usernames`, see `src/scripts/usernames.ts`):
`audit` (read-only report) → resolve shared usernames → `backfill` → `index`
(unique index; refuses while duplicates exist). `backfill --undo` and
`index --drop` reverse them.

**Leaderboards** (`src/leaderboard/`): weeks run Monday–Sunday, Lagos time.
The score formula lives in `scoring.ts` (+1 per question answered correctly —
once per question per week; +2 per completed quiz, max 5 a day; +3 per topic
improved by 10+ points; +2 per practice day, +5 for all 7; quizzes under 3 s a
question earn nothing). Totals are kept per student per week in
`leaderboard_weeks`, recounted after every quiz submission, so boards never scan
attempts. "My course" = same school, programme and level. Responses carry only
username, school short name (`src/reference/school-short-names.ts`), level and
points; students who turn "Show me on leaderboards" off appear as "Anonymous
student". After a first deploy or a formula change: `yarn leaderboard rebuild
[--week YYYY-MM-DD]`. Admins: `/admin/leaderboards`, `/admin/leaderboards/winners`,
`/admin/leaderboards/schools` (names included, for prizes).

**Find classmates & connections** (`src/social/`, safety-critical): rules and
limits live in `social-policy.ts`, including the connection state machine. Everything is
enforced on the server and every "can't do that" reply is neutral:
- Unknown, hidden, blocked, suspended and staff accounts all look the same:
  cards return 404 and requests return `{ok:true}` with nothing created.
- A request to someone who declined you in the last 30 days, or who doesn't take
  requests from you, becomes a silent "shadow" request that only you can see.
- Declines and blocks are never notified. Blocks end requests and connections
  both ways and hide the two students from each other everywhere.
- Responses only ever carry username, initials, school short name and level.

Auto-flags (5+ reporters, 70%+ of 20+ requests declined, repeated rate-limit hits)
pause the account's requests until an admin reviews it. Admin API:
`/admin/moderation/reports` (+ `/:id/action` dismiss · warn · rename · suspend N days · ban),
`/admin/moderation/flagged` (+ `/:id/clear`), `/admin/moderation/security-events`
(permission `moderateStudents`, admins only). Later phases should use
`PeopleService.areConnected()` / `canSee()` so the same consent and block rules apply.

**Invites & challenges** (`src/social/referrals.service.ts`, `challenges.service.ts`):
- **Invites:** an invite ("Invited by" = the inviter's username) credits the
  inviter once the new student verifies, and creates a connection request from
  the inviter. It never connects them automatically.
- **Invite limits:** self-referrals, the same phone number, staff inviters and
  more than 20 a day per inviter aren't credited.
- **Who can be challenged:** only accepted connections, or anyone who opens a
  shared code. They get a connection request first and claim the challenge
  after accepting.
- **Same questions, server-timed:** both students get the same snapshot of up
  to 10 questions, and the server records the times.
- **Scores:** the other student's score is hidden until both finish. Higher
  score wins; a tie goes to the faster time. A challenge run also counts as a
  normal quiz.
- **Limits:** challenges expire after 48 h; 10 sent a day, 20 open at once.
- **Ending a connection:** removing a connection or blocking cancels open
  challenges between the two.
- **Admin:** `/admin/referrals`, `/admin/challenges/stats`.

**Profiles, badges & study groups** (`src/social/badges*.ts`, `groups.service.ts`):

- **Profiles:** `GET /me/profile` (my badges + what others see). Privacy has
  `publicProfile` and `showRealName` (both off by default). A public profile
  shows badges, streak and topics mastered to every signed-in student on the
  student card; non-public profiles show badges only to connections.
  `GET /profiles/:username` is **public (no login)** for a future web page and
  404s unless the profile is public. Email and phone are never returned.
- **Badges:** automatic — `streak_7`, `streak_30`, `mastered_10`,
  `weekly_top3` (ever), `challenge_wins_5`; manual — `founding_tester`
  (automatic for accounts created before `FOUNDING_TESTER_CUTOFF`, default
  2026-12-14 Lagos time) and `campus_ambassador`. Admins give/take away with
  `PATCH /admin/students/:id/badges {badge, give}`; staff get none.
- **Groups:** `POST/GET /groups`, `GET /groups/:id` (members, this week's
  points, last 7 days of topics practised — never scores),
  `POST /groups/:id/invites {username}` (accepted connections only; they must
  accept), `.../invites/accept|decline`, `GET /groups/code/:code` +
  `POST /groups/code/:code/join` (owner can turn the code off or reset it with
  `POST /groups/:id/code`), `DELETE /groups/:id/members/:username` (owner),
  `POST /groups/:id/leave` (ownership passes to the longest member; an empty
  group is deleted). Limits: 30 members, 5 owned, 20 invites a day, names
  3–40 characters and filtered. Students who blocked each other can't be in
  the same group; non-members get 404.
- **Admin:** `/admin/groups` (search, members, delete — `moderateStudents`).

**Analytics:** product events go to the `analytics_events` collection (kept 180
days, no personal data) via `AnalyticsService.track`. So far: `login_with_username`, `referral_signup`, `challenge_sent`, `challenge_completed`, `user_search`, `connection_request_sent`, `connection_request_accepted`, `user_blocked`, `user_reported`, and from the app `leaderboard_viewed`, `progress_card_shared`.

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
