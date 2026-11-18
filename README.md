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
| Home & study | `GET /home/summary` (greeting, streak, weekly goal, continue learning, focus area, QOTD, leaderboard line; cached 60 s), `PATCH /me/study-goal` `{weeklyDays: 1–7}`, `GET /qotd`, `POST /qotd/answer` `{questionId, selectedIndex}` (once a day; resending returns the stored result; 409 `QOTD_CHANGED`). `POST /quiz-attempts` now also returns `pointsResult` `{points, breakdown, capped, tooFast, studyDay, streak}` and `pointsAwarded` | ✓ |
| Privacy | `PATCH /auth/privacy` `{showOnLeaderboard, findability: everyone\|exact\|nobody, requestsFrom: everyone\|school\|nobody, shareProgress, shareScores, muteRequestNotifications}` → profile | ✓ |
| Classmates | `GET /people/search?q=` (3+ chars, ≤10, 30/min + 300/day per student), `GET /people/:username` (card; 404 for anyone you can't see), `POST /connections` `{username, note?}` (always `{ok:true}`), `GET /connections`, `GET /connections/requests`, `POST /connections/:id/accept\|decline\|cancel`, `DELETE /connections/:id`, `GET/POST /blocks`, `DELETE /blocks/:username`, `POST /reports/users`, `GET /notifications`, `POST /notifications/read-all`, `GET /me/social-summary` | ✓ |
| Invites | `GET /invites/:username` (public, for an invite page), `GET /me/referrals` → `{count}`; sign-up `referralCode` = the inviter's username | public / ✓ |
| Challenges | `POST /challenges` `{topicId, username?}` (connection, or a code to share), `GET /challenges`, `GET /challenges/:id`, `GET /challenges/link/:code`, `GET /challenges/public/:code` (public), `POST /challenges/:id/accept\|decline\|cancel\|start\|submit` | ✓ |
| Analytics | `POST /analytics/events` `{name: leaderboard_viewed\|progress_card_shared, detail?}` | ✓ |
| Admin | `PATCH /admin/students/:id/username`, `GET /admin/students/:id/usernames` (moderation), `/admin/courses`, `/admin/topics`, `/admin/questions` (+ `/:id/transitions` review workflow), `/admin/reports`, `/admin/feedback`, `/admin/students`, `/admin/quiz-attempts`, `/admin/audit-log`, `GET/PUT/DELETE /admin/qotd` (pin a Question of the Day) | staff role |

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

**Study activity, streaks and points** (`src/study/`, Part A of the Nov 2026 redesign).
All days and weeks are Lagos time; a week runs Monday 00:00 → Sunday 23:59.
- A **study day** = a completed quiz (≥ 5 questions answered, or all of a shorter
  quiz, not too fast) or a Question of the Day answer. Kept in `study_days`.
- **Streak** (`streak.ts`): consecutive study days up to today (or yesterday before
  studying today). One automatic **freeze** per calendar week covers a single missed
  day; two missed days in a row end it.
- **Weekly goal**: study days a week, default 3 (1–7), in `user_stats`.
- **Points** (`points-config.ts` has every value): +10 per correct answer (+2 once
  that question was answered correctly twice before; only the first 3 tries at a
  question per day count), +5 per completed quiz, +20 for the first completed quiz of
  a day, QOTD +15 right / +5 wrong (no +20), +25 when a Focus Area topic (average
  < 60%) reaches 60% (once per topic a week), max 400 a day. A quiz faster than
  2 s a question earns 0 and is flagged in `integrity_flags`.
- Every point is a row in the append-only `points_ledger` (unique
  `sourceType + sourceId`, so nothing is awarded twice). Quiz submission writes the
  attempt, ledger, study day, `topic_stats`, `question_stats`, weekly totals and
  streak in **one MongoDB transaction** (Atlas). If scoring ever fails, the attempt is
  still saved without `scoredAt` and the nightly job scores it.
- **Question of the Day** (`study/qotd/`): one published question per Lagos day per
  level + department, falling back to level, then everyone, when a group has fewer
  than 30 questions. Picked deterministically (date + group), no repeats within 30
  days, stored in `qotd_days`; one answer per student per day (`qotd_answers`).
  Staff with the `review` permission can pin a question for today or a future day.
- **Jobs** (`study-jobs.service.ts`, no cron dependency): every 10 min each server
  checks what's due; a `job_runs` row makes each run happen once. Nightly (from
  00:10 Lagos): score unscored attempts from the last 7 days, recount this and last
  week's totals from the ledger, refresh streaks. Off in tests and scripts
  (`STUDY_JOBS=off`).
- **Home** (`src/home/`): `GET /home/summary` returns everything the Home screen
  needs, cached 60 s per student and cleared when they submit a quiz, answer the QOTD
  or change their goal. A section that fails comes back `null` and is listed in `failed`.

**After deploying Part A, run once:** `yarn progress rebuild` (a dry run that reports
what it would do), then `yarn progress rebuild --yes`. It replays every quiz attempt
and QOTD answer in order through the same rules, so testers start with their real
streaks, study days and this week's points. Run it at a quiet time; it's safe to
re-run. Also `yarn progress repair` (score any unscored attempts) and
`yarn progress nightly` (run the nightly job now).

**Referral rewards** (`src/social/referrals.service.ts`, `StudyService.awardReferral`).
A student who signs up with a classmate's code (their username, typed in "Invited by"
or filled in from the Play Store invite link) is a *pending* referral. Their first
completed quiz (5+ answered, not too fast, not a retry) gives the inviter **+10**
(`referral` in Points & rules), in the quiz's own transaction: once per invited
student, ever (ledger key = their id). Only the first **5 a week**
(`referralLeaderboardPerWeek`) count on the weekly leaderboard; the rest are
lifetime points (`leaderboard: false` on the ledger row). Referral rewards sit
outside the 400-a-day study cap and aren't a study day. Abuse rules: no
self-referral (email, phone or the same app install); 20 a day per inviter; 2+
sign-ups from one app install or 5+ from one network in 24 h are *held* (a
`referral_cluster` flag in Leaderboards → Flags; approve / reject on the Referrals
page). Admins can take a reward back (duplicate / fake account), and banning an
invited student does it automatically: a −10 adjustment in the same week. Sign-ups
store only keyed hashes of the network and the app's random install id
(`X-Install-Id` on `/auth/verify`). `GET /me/referrals` → joined · pending ·
rewarded · points earned · lifetime points · the latest 20 (usernames only).

**After deploying referral rewards, run once:** `yarn progress referrals` (dry run),
then `yarn progress referrals --yes`: referrals from before this feature get their
+10 if the invited student already completed a quiz, as lifetime points only (this
week's leaderboard isn't reshuffled). Safe to re-run.

**Leaderboards** (`src/leaderboard/`, Part C). Weekly boards ranked by points, then
study days, then correct answers, then whoever got there first. Totals live in
`leaderboard_weeks` (kept up to date by StudyService as points are earned).
- `GET /leaderboard?scope=school|course|level|department|all|friends&period=this_week|last_week&limit=50&cursor=`
  → entries (username, initials, school short name, level, points, study days — never
  names, emails, phones or ids) and `me` (rank, points to the next place, percentile).
  "course" = classmates (same school, programme and level); "friends" = accepted
  connections. All scoping is decided on the server from the student's own profile.
  `GET /leaderboard/schools` (average points per active student, schools with 5+ active
  students), `GET /leaderboard/history?weeks=8`. Pages are cached for 60 s (cleared
  whenever anyone earns points). The original `GET /leaderboards` + `/leaderboards/schools`
  stay for installed app builds.
- Hidden from other students' boards: "Show me on leaderboards" off, excluded by an
  admin, suspended or banned. They still see their own rank ("You'd be #12"). Blocked
  students appear to each other as "Anonymous student" (and never in Friends).
- Jobs: Monday 00:00 Lagos the week closes (`leaderboard_winners`: top 10 of every
  board, once); Monday 09:00 every ranked student gets an inbox message with their
  school rank; when someone passes a student in their school's top 10 they get one
  message (max 1 a day). "Mute leaderboard notifications" in Privacy turns both off.
- Anti-cheat flags (`integrity_flags`, for admin review, never automatic bans):
  too-fast quizzes, 300+ points in an hour, 95%+ correct on 200+ questions in a day, and
  3+ accounts on one network in the same school's top 20 (quiz attempts store a keyed
  hash of the network address, never the address; `IP_HASH_SECRET` optional). Quiz
  submission is limited to 30 a minute.
- Admin (`manageLeaderboards`, admins only): `/admin/leaderboards` (+ `q` username
  search, department), `/admin/leaderboards/saved-winners`, `/admin/leaderboards/insights`,
  `/admin/leaderboards/flags` (+ `POST /:id` dismiss · exclude · reset),
  `PATCH /admin/students/:id/leaderboard` (exclude with a reason / return),
  `POST /admin/students/:id/leaderboard/reset`, `GET/PUT /admin/settings` (points values,
  daily cap, minimum active students — `app_settings`, no code change needed).
- Local testing: `SEED_LEADERBOARD=1 yarn dev:memory` (or `yarn seed:leaderboard`, never in
  production) adds 60 fake students with this and last week's activity.

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

## Free / Pro and payments

- `src/plans`: who has what.
  - Plan state and the 3-day trial (one per person).
  - The Founding Tester month for accounts from before go-live.
  - The daily MCQ limit and feature locks.
  - The modals' once-only flags and plan emails, sent by an hourly job.
- Everything is admin-editable under Admin → Plans & payments (stored as the `plans` setting): on/off, limits, locks and prices.
- **Plans are off until an admin switches them on.** Switching on is go-live, and every account created before it becomes a Founding Tester.
- `src/billing`: Google Play Billing verification (purchase checks, Play notifications, restore) and Paystack (start a payment, signed webhook).
- **Setup steps for Play Console, the service account, Pub/Sub and Paystack are in [docs/PAYMENTS.md](docs/PAYMENTS.md).**
- **Local demo:** `PLANS=founding|trial|free yarn dev:memory` puts the demo student in that state. `PLAY_FAKE=1` / `PAYSTACK_FAKE=1` stand in for the stores; never use them in production.

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
