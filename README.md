# Tasks API: Zeynep Sudem Aktaş, 2025502009

MIS 233 Web Based Application Programming, Assignment 5. A backend for tasks, written in
TypeScript on Deno 2 with Hono, Drizzle (libSQL/SQLite) and Zod. Users register and log
in, every user manages only their own tasks, every input is validated, every failure has
one shape, and 88 tests prove it. I did Bonuses 1 to 17 completely; Bonuses 18 to 20 need
accounts, so they are prepared but not claimed yet (last section).

## Run it

    cp .env.example .env
    deno task dev        # API on http://localhost:8000, restarts when a file changes
    deno task test       # all tests
    deno task check      # type-check
    deno fmt --check && deno lint

The given UI works with it: `deno task ui:install` once, then `deno task ui:dev`
(http://localhost:5173), start the API first.

Other tasks: `deno task seed` (demo data), `deno task db:generate` (new migration from
`schema.ts`), `deno task bench:n-plus-one`, `deno task bench:index`, `deno task demo:ws`.
There is no `npm install` and no Node.js. `deno.json` has `"unstable": ["kv", "cron"]`
because Deno KV and `Deno.cron` are unstable APIs.

Settings come from environment variables (read once in `src/config.ts`; see
`.env.example`):

| Variable                | Meaning                                           | Default                 |
| ----------------------- | ------------------------------------------------- | ----------------------- |
| `PORT`                  | port of the server                                | `8000`                  |
| `DATABASE_URL`          | `file:./tasks.db`, or a hosted `libsql://...` URL | `file:./tasks.db`       |
| `DATABASE_AUTH_TOKEN`   | token for a hosted libSQL database (Turso)        | none                    |
| `JWT_SECRET`            | secret that signs the tokens                      | `dev-secret` (dev)      |
| `APP_ENV`               | `development`, `test` or `production`             | `development`           |
| `ADMIN_EMAIL`           | registering with this email makes an admin        | none                    |
| `DB_POOL_SIZE`          | connections in the pool                           | `4`                     |
| `KV_PATH`, `UPLOAD_DIR` | where Deno KV and uploaded images are kept        | KV default, `./uploads` |
| `PURGE_CRON`            | schedule of the purge job                         | `0 3 * * *`             |

## Design decisions (R8)

### Tables

`users`: `id`, `email` (unique, always stored in lower case), `password_hash` (bcrypt),
`role` (`user` or `admin`), `created_at`.

`tasks`: `id`, `user_id` (references `users.id`), `title`, `status` (`todo`,
`in-progress`, `done`), `priority` (`low`, `medium`, `high`), `created_at` (a SQL default,
so every row gets its own time), and my own extra fields: `description` (max 500
characters), `due_date` (`YYYY-MM-DD`), `completed_at` (set when the status becomes
`done`, used by the purge job), `deleted_at` (soft delete) and `attachment` (name of the
uploaded image). There is an index on `(user_id, status)` because the list query always
filters by both.

The Drizzle tables in `src/schema.ts` and the SQL in `drizzle/` describe the same tables:
the SQL is generated from `schema.ts` by Drizzle Kit (Bonus 1), and the test
`schema.ts and the migrations describe the same columns` compares them column by column.
The `sessions` table of the starter is gone: tokens are JWTs now (Bonus 7). The database
does not enforce the status values itself (the Drizzle `enum` is only a TypeScript type);
the Zod schemas are what keeps a wrong status out.

### Routes

| Method and path                        | Token        | Success                                     | Failures                |
| -------------------------------------- | ------------ | ------------------------------------------- | ----------------------- |
| `GET /health`, `/healthz`, `/readyz`   | no           | 200 (`/readyz` 503 if the database is down) |                         |
| `POST /auth/register`                  | no           | 201 `{ id, email, role }`                   | 400, 409                |
| `POST /auth/login`                     | no           | 200 `{ token }`                             | 400, 401, 429           |
| `GET /api/tasks`                       | yes          | 200 `{ items, page, limit, total }`         | 400, 401                |
| `POST /api/tasks`                      | yes          | 201 the task                                | 400, 401                |
| `GET /api/tasks/:id`                   | yes          | 200 the task                                | 401, 404                |
| `PUT /api/tasks/:id`                   | yes          | 200 the task                                | 400, 401, 404           |
| `DELETE /api/tasks/:id`                | yes          | 200 `{ ok: true }`                          | 401, 404                |
| `POST /api/tasks/:id/restore`          | yes          | 200 the task                                | 401, 404                |
| `POST`/`GET /api/tasks/:id/attachment` | yes          | 200                                         | 400, 401, 404, 413, 415 |
| `GET /api/me/summary`                  | yes          | 200 counts per status                       | 401                     |
| `GET /api/admin/users`                 | admin        | 200 users with task counts                  | 401, 403                |
| `GET /ws?token=...`                    | in the query | 101 WebSocket                               | 401, 426                |
| `GET /openapi.json`, `/docs`           | no           | the OpenAPI document and a docs page        |                         |

### Decisions and why

- **404, not 403, for another user's task.** A 403 would tell a stranger that the id
  exists. Every task query goes through one function, `own(id, userId)` in
  `src/queries.ts` (`id` AND `user_id` AND not deleted), so a route cannot forget the
  owner. There is no SQL built from strings anywhere: only Drizzle's `eq`, `and`,
  `isNull`, `count` and `sql` placeholders. A test sends `x'); DROP TABLE tasks; --` as a
  title and as an id.
- **One error shape.**
  `{ "error": "...", "issues": [{ "path", "message" }], "requestId": "..." }`. It comes
  from the Zod hook (400), `app.notFound` (404), `app.onError` (500, and also malformed
  JSON), and the two middlewares (401, 403). A 500 never shows the real error to the
  client; it goes to the log together with the request id.
- **A non-numeric id (`/api/tasks/abc`) is a 404**, not a 400: the task "does not exist".
  The Zod hook checks which part failed (`param`) and answers 404 for it.
- **Login only requires that a password is present.** The 8-character rule is for
  registration. Otherwise a short wrong password would be a 400 instead of the 401 that
  the handout's own example test expects, and a login form would reveal the password rule.
- **Same 401 for a wrong email and a wrong password**, and for an unknown email I still
  run one bcrypt comparison against a dummy hash, so the answer takes about as long and
  the timing does not show which emails exist.
- **`PUT` is a full replacement** (same body as `POST`): fields the body leaves out go
  back to their defaults (`status` `todo`, `priority` `medium`, `description` and
  `due_date` empty). The given UI sends only `title` and `status`, so advancing a task
  there resets its priority.
- **`DELETE` is a soft delete.** The row stays with a `deleted_at` time; lists and lookups
  skip it; `POST /api/tasks/:id/restore` brings it back. A deleted task is a 404 for
  everything else.
- **Registering creates a welcome task** in the same transaction as the user. So a new
  user's list is not empty: `total` is 1 right after registering.
- **The token is a JWT with the role inside.** `requireAuth` needs no database lookup, and
  a request borrows a database connection only after the token was accepted.
- **Pagination** is `LIMIT/OFFSET` ordered by `id`, plus a second `count()` query with the
  same filter. A bad `page`, `limit` or `status` is a 400.

## API with curl (R8)

All outputs below are copied from a real run against `deno task dev` on a fresh database
(the long token is shortened with `...`, and `$TOKEN` is the token from the login). The
admin examples ran with `ADMIN_EMAIL=admin@example.com`.

### Health

```sh
$ curl -s localhost:8000/health
{"ok":true}

$ curl -s localhost:8000/healthz
{"ok":true}

$ curl -s localhost:8000/readyz
{"ready":true}

$ curl -si localhost:8000/health | head -n 8
HTTP/1.1 200 OK
content-type: application/json
x-request-id: f4c661b9-e8e0-4dc3-b6b5-79301f617d75
content-length: 11
date: Fri, 20 Nov 2026 11:48:05 GMT

{"ok":true}
```

### Register

```sh
$ curl -s -X POST localhost:8000/auth/register -H 'content-type: application/json' -d '{"email":"zeynep@example.com","password":"secret123"}'
{"id":1,"email":"zeynep@example.com","role":"user"}

$ curl -s -X POST localhost:8000/auth/register -H 'content-type: application/json' -d '{"email":"zeynep@example.com","password":"secret123"}'
{"error":"email already registered","requestId":"61956368-0d24-4b0e-bde4-044de88d4d48"}

$ curl -s -X POST localhost:8000/auth/register -H 'content-type: application/json' -d '{"email":"nope","password":"short"}'
{"error":"validation failed","issues":[{"path":["email"],"message":"Invalid email address"},{"path":["password"],"message":"Too small: expected string to have >=8 characters"}],"requestId":"577f7bc1-687a-46e7-aec2-6bf5744aa4ce"}
```

### Login

```sh
$ curl -s -X POST localhost:8000/auth/login -H 'content-type: application/json' -d '{"email":"zeynep@example.com","password":"secret123"}'
{"token":"eyJhbGciOiJI..."}


$ curl -s -X POST localhost:8000/auth/login -H 'content-type: application/json' -d '{"email":"zeynep@example.com","password":"wrong"}'
{"error":"invalid email or password","requestId":"8b19ecd1-8b1c-4cee-b59a-9cd13a9fffa2"}

$ curl -s -X POST localhost:8000/auth/login -H 'content-type: application/json' -d '{"email":"nobody@example.com","password":"secret123"}'
{"error":"invalid email or password","requestId":"d79a8c1d-fa80-42f6-841c-bb450bbc921c"}
```

### Tasks

```sh
$ curl -s localhost:8000/api/tasks
{"error":"unauthorized","requestId":"fba2eb2d-7c07-416c-8f6a-5ad4c512e4e4"}

$ curl -s localhost:8000/api/tasks -H "Authorization: Bearer $TOKEN"
{"items":[{"id":1,"title":"Welcome! This is your first task","status":"todo","priority":"low","description":null,"dueDate":null,"createdAt":1795175285,"completedAt":null,"hasAttachment":false}],"page":1,"limit":20,"total":1}

$ curl -s -X POST localhost:8000/api/tasks -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"title":"Write the README","priority":"high","dueDate":"2026-12-01"}'
{"id":2,"title":"Write the README","status":"todo","priority":"high","description":null,"dueDate":"2026-12-01","createdAt":1795175286,"completedAt":null,"hasAttachment":false}

$ curl -s -X POST localhost:8000/api/tasks -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"title":"","status":"finished"}'
{"error":"validation failed","issues":[{"path":["title"],"message":"Too small: expected string to have >=1 characters"},{"path":["status"],"message":"Invalid option: expected one of \"todo\"|\"in-progress\"|\"done\""}],"requestId":"da86e61f-f159-43f0-9875-17d2de451764"}

$ curl -s localhost:8000/api/tasks/2 -H "Authorization: Bearer $TOKEN"
{"id":2,"title":"Write the README","status":"todo","priority":"high","description":null,"dueDate":"2026-12-01","createdAt":1795175286,"completedAt":null,"hasAttachment":false}

$ curl -s -X PUT localhost:8000/api/tasks/2 -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"title":"Write the README","status":"done","priority":"high"}'
{"id":2,"title":"Write the README","status":"done","priority":"high","description":null,"dueDate":null,"createdAt":1795175286,"completedAt":1795175286,"hasAttachment":false}

$ curl -s 'localhost:8000/api/tasks?page=1&limit=1&status=done' -H "Authorization: Bearer $TOKEN"
{"items":[{"id":2,"title":"Write the README","status":"done","priority":"high","description":null,"dueDate":null,"createdAt":1795175286,"completedAt":1795175286,"hasAttachment":false}],"page":1,"limit":1,"total":1}

$ curl -s 'localhost:8000/api/tasks?page=abc&limit=1000' -H "Authorization: Bearer $TOKEN"
{"error":"validation failed","issues":[{"path":["page"],"message":"Invalid input: expected number, received NaN"},{"path":["limit"],"message":"Too big: expected number to be <=100"}],"requestId":"3ab5aed5-2977-4e73-8fae-782e6d7655a3"}

$ curl -s localhost:8000/api/me/summary -H "Authorization: Bearer $TOKEN"
{"todo":1,"in-progress":0,"done":1,"total":2}

$ curl -s -X DELETE localhost:8000/api/tasks/2 -H "Authorization: Bearer $TOKEN"
{"ok":true}

$ curl -s localhost:8000/api/tasks/2 -H "Authorization: Bearer $TOKEN"
{"error":"not found","requestId":"2aa5849c-392c-4251-a99e-fda0be67ae96"}

$ curl -s -X POST localhost:8000/api/tasks/2/restore -H "Authorization: Bearer $TOKEN"
{"id":2,"title":"Write the README","status":"done","priority":"high","description":null,"dueDate":null,"createdAt":1795175286,"completedAt":1795175286,"hasAttachment":false}
```

### Another user's task is a 404

```sh
$ curl -s localhost:8000/api/tasks/2 -H "Authorization: Bearer $OTHER_TOKEN"
{"error":"not found","requestId":"4d6c7d53-69c4-4d4a-a986-88d1a0ba0017"}
```

### Errors, in the same shape

```sh
$ curl -s localhost:8000/no/such/route
{"error":"not found","requestId":"04901c0a-3e29-486a-96bc-b9b016eb2264"}

$ curl -s -X POST localhost:8000/auth/login -H 'content-type: application/json' -d '{oops'
{"error":"malformed JSON in request body","requestId":"ca5bfcd3-808c-496a-8881-db95128c5c4a"}
```

## Tests (R7)

`deno task test` runs **88 tests** in `tests/`; they call `app.request(...)`, so no server
and no port are needed, and `freshApp()` gives each test an empty database in a temporary
file.

| File             | What it covers                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth_test.ts`   | register (201, 409, 400), bcrypt hash, login (token, one 401 message), missing, garbage, tampered, expired and foreign tokens, the welcome transaction and its rollback, the login rate limit |
| `tasks_test.ts`  | create, validation (400), ownership (404 for read, change, delete, restore), pagination (page 2), filter, bad queries, PUT, soft delete and restore, SQL injection, the summary               |
| `db_test.ts`     | tasks table through Drizzle, SQL defaults, schema and migrations agree, N+1 query counts, the pool, the purge job                                                                             |
| `rbac_test.ts`   | no token 401, user 403, admin 200                                                                                                                                                             |
| `ops_test.ts`    | `/healthz`, `/readyz` 200 and 503, the 500 shape, request ids, log lines without secrets, configuration                                                                                       |
| `upload_test.ts` | upload and download, 400, 413, 415, generated file names, owner only                                                                                                                          |
| `cache_test.ts`  | cache hit, invalidation, the user id in the key                                                                                                                                               |
| `ws_test.ts`     | 401 and 426 before the upgrade, the hub, and a real server with three sockets                                                                                                                 |

The seven tests that the handout asks for are there: duplicate email (409), wrong password
(401), missing token (401), bad body (400), another user's task (404), invalid status
(400) and pagination.

```text
$ deno task test
...
ok | 88 passed | 0 failed (17s)
```

## My own log (R8)

Things that went wrong or surprised me while building this, with the exact messages.

1. **`deno lint` failed on the given starter.** Six times:
   `error[jsx-button-has-type]: button elements must have a type attribute` in
   `ui/src/App.tsx`. The UI is given and not graded, so I excluded it in `deno.json`
   (`"lint": { "exclude": ["ui", "drizzle"] }`) instead of editing it. Now `deno lint`
   reports nothing.
2. **The handout contradicts itself about login.** Step 4 says "validate the body with the
   same schema" (password at least 8 characters), but the example test logs in with the
   password `"wrong"` (5 characters) and expects 401. With the same schema that request is
   a 400. I made a separate `LoginBody` with `password: z.string().min(1)`.
3. **`TypeError: Deno.cron is not a function`.** Deno KV and `Deno.cron` are unstable.
   Instead of adding `--unstable-kv --unstable-cron` to every task I put
   `"unstable": ["kv", "cron"]` in `deno.json`, which also fixes the types for
   `deno check`, the tests and the Dockerfile.
4. **The starter's `dev` task never read `.env`**, although the handout says to copy it. I
   added `--env-file=.env`. When the file does not exist Deno only warns:
   ``Warning The `--env-file` flag was used, but the environment file specified '...' was not found.``
5. **A transaction silently switched my lock timeout off.** I set
   `PRAGMA busy_timeout=5000` on every connection. I measured it after `db.transaction()`:
   `busy_timeout after migrate: 5000`, then `busy_timeout after a transaction: 0`. The
   libSQL client opens a fresh connection behind the scenes after a transaction. So
   `createUserWithWelcomeTask` calls `tuneConn()` again in a `finally`.
6. **My first N+1 example was not an N+1.** The summary with "load the tasks, then one
   count per status" always sends 4 queries (there are always 3 statuses), so it does not
   grow with the data. The real N+1 is the admin list: 11 queries for 10 users, 51 for 50.
   I measure both (Bonus 3).
7. **The first index benchmark showed no speed-up at all.** `SELECT *` for one user and
   one status returns about 333 rows; BEFORE 3.745 ms, AFTER 3.815 ms: copying the rows
   costs more than finding them. I changed the benchmark to the two queries the API really
   runs (one page of 20 rows, and the `count(*)` for `total`). Then the plan changed from
   `SCAN tasks` to `SEARCH ... USING INDEX`.
8. **`deno task seed` with `APP_ENV=production` gave the wrong message.** It stopped in
   the configuration check: `Invalid configuration: - JWT_SECRET: required in production`,
   before my own refusal. I now look at `APP_ENV` first:
   `Refusing to seed: APP_ENV is production.`
9. **The welcome task broke my first pagination test.** I expected `total` 3 after
   creating 3 tasks and got 4, because registering already made one. I changed the test to
   expect the welcome task (and wrote it down in the design section above).
10. **An invalid path id is validated by Zod, but must be a 404.** Zod's default answer is
    a 400. Hono's `defaultHook` receives `result.target` (`param`, `query`, `json`), so
    the hook answers 404 only for `param`.

## Bonuses claimed

I claim Bonuses 1 to 17 with their proof. Bonuses 18 to 20 are at the end: the files are
in the project, but the proof needs accounts that I still have to set up.

### Bonus 1: Migrations with Drizzle Kit

`migrate()` in `src/db.ts` no longer contains SQL. It calls Drizzle's migrator on the
`drizzle/` folder; applied files are recorded in `__drizzle_migrations` and skipped, so it
is safe at every start. The files are generated from `src/schema.ts`:

    deno task db:generate --name=initial

| File                                          | What it does                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `0000_initial.sql`                            | `CREATE TABLE` users, sessions, tasks                                                      |
| `0001_add_due_date.sql`                       | `ALTER TABLE tasks ADD due_date text;`                                                     |
| `0002_roles_soft_delete_attachment_index.sql` | four `ALTER TABLE ... ADD` (completed_at, deleted_at, attachment, role) and `CREATE INDEX` |
| `0003_drop_sessions_for_jwt.sql`              | `DROP TABLE sessions;`                                                                     |

**How I made the second change:** I added one line, `dueDate: text("due_date")`, to the
`tasks` table in `schema.ts` and ran
`deno run -A npm:drizzle-kit generate --name=add_due_date`. Drizzle Kit compared
`schema.ts` with the snapshot of the first migration (`drizzle/meta/0000_snapshot.json`)
and wrote only the difference. I read the file before committing it: it is an
`ALTER TABLE`, not a second `CREATE TABLE`. The later columns and dropping `sessions` were
generated the same way. `deno task db:migrate` (`drizzle-kit migrate`) on an empty
`tasks.db` also works and makes `users`, `tasks` and `__drizzle_migrations`. A test checks
that `migrate()` can run three times.

### Bonus 2: Soft delete, restore and a transaction

`deleted_at` is set by `DELETE`; `own()` adds `isNull(tasks.deletedAt)` to every lookup
and the list; `POST /api/tasks/:id/restore` clears it (404 when the task is not deleted).
`createUserWithWelcomeTask` in `src/users.ts` puts the user insert and the welcome task
insert in `db.transaction(async (tx) => ...)` and uses `tx` inside. Tests:
`DELETE is a soft delete: gone from
the list and the lookup, then restorable`,
`restoring a task that is not deleted ... is 404`,
`a failing welcome task rolls the user back too (transaction)` (a hook throws between the
two inserts, afterwards the `users` table is empty) and the same through the API (500,
then the email can be registered).

### Bonus 3: Joins and the N+1 problem

`GET /api/me/summary` returns the tasks per status with one `GROUP BY` query.
`deno task bench:n-plus-one` logs the SQL (a logger that counts, the same idea as
`drizzle(client, { logger: true })`) for a naive and a good version of two endpoints:

```text
Data: 10 users with 30 tasks each

summary, NAIVE (load all tasks, then a count per status): 4 queries
  select "id", "user_id", "title", "description", "due_date", "status", "priority", "created_at", "completed_at", "deleted_at", "attachment" from "tasks" where ("tasks"."user_id" = ? and "tasks"."deleted_at" is null)
  select count(*) from "tasks" where ("tasks"."user_id" = ? and "tasks"."deleted_at" is null and "tasks"."status" = ?)
  select count(*) from "tasks" where ("tasks"."user_id" = ? and "tasks"."deleted_at" is null and "tasks"."status" = ?)
  ... and 1 more

summary, GOOD  (one GROUP BY): 1 queries
  select "status", count(*) from "tasks" where ("tasks"."user_id" = ? and "tasks"."deleted_at" is null) group by "tasks"."status"

admin list, NAIVE (1 for the users + 1 per user): 11 queries
  select "id", "email", "password_hash", "role", "created_at" from "users" order by "users"."id"
  select count(*) from "tasks" where ("tasks"."user_id" = ? and "tasks"."deleted_at" is null)
  select count(*) from "tasks" where ("tasks"."user_id" = ? and "tasks"."deleted_at" is null)
  ... and 8 more

admin list, GOOD  (one LEFT JOIN + GROUP BY): 1 queries
  select "users"."id", "users"."email", "users"."role", "users"."created_at", count("tasks"."id") from "users" left join "tasks" on ("tasks"."user_id" = "users"."id" and "tasks"."deleted_at" is null) group by "users"."id" order by "users"."id"

After adding 40 more users (50 in total):

admin list, NAIVE: 51 queries
  select "id", "email", "password_hash", "role", "created_at" from "users" order by "users"."id"
  select count(*) from "tasks" where ("tasks"."user_id" = ? and "tasks"."deleted_at" is null)
  select count(*) from "tasks" where ("tasks"."user_id" = ? and "tasks"."deleted_at" is null)
  ... and 48 more

admin list, GOOD : 1 queries
  select "users"."id", "users"."email", "users"."role", "users"."created_at", count("tasks"."id") from "users" left join "tasks" on ("tasks"."user_id" = "users"."id" and "tasks"."deleted_at" is null) group by "users"."id" order by "users"."id"
```

The summary is the easy case: the naive version needs 4 queries and loads every task row
just to count them, the good one needs 1. The admin list is the real N+1: one query for
the users and then one more for **each** user, so 11 queries for 10 users and 51 for 50
users. The number of queries grows with the data. The `LEFT JOIN ... GROUP BY` version
sends one query whatever the number of users. Tests count the queries (`db_test.ts`) and
compare the results.

### Bonus 4: Indexes and EXPLAIN

The index is in `schema.ts` (`index("idx_tasks_user_status").on(t.userId, t.status)`) and
so in the migration `0002`. `deno task bench:index` fills a database with 20,000 tasks for
20 users, drops the index to show "before", and creates it again:

```text
20000 tasks for 20 users inserted

--- page of tasks: SELECT * FROM tasks WHERE user_id = ? AND status = ? ORDER BY id LIMIT 20 OFFSET 200
BEFORE plan : SCAN tasks
BEFORE time : 0.714 ms per query (average of 300 runs)
--- total (count): SELECT count(*) FROM tasks WHERE user_id = ? AND status = ?
BEFORE plan : SCAN tasks
BEFORE time : 0.720 ms per query (average of 300 runs)

CREATE INDEX idx_tasks_user_status ON tasks(user_id, status)

--- page of tasks
AFTER  plan : SEARCH tasks USING INDEX idx_tasks_user_status (user_id=? AND status=?)
AFTER  time : 0.369 ms per query (average of 300 runs)
speed-up: 1.9x
--- total (count)
AFTER  plan : SEARCH tasks USING COVERING INDEX idx_tasks_user_status (user_id=? AND status=?)
AFTER  time : 0.037 ms per query (average of 300 runs)
speed-up: 19.3x
```

(The times change a little on every run; the plans do not.) The count query becomes a
covering index search: SQLite answers it from the index alone and never reads the table.
An index costs disk space and makes every `INSERT`, `UPDATE` of an indexed column and
`DELETE` a little slower, because the index has to be changed too.

### Bonus 5: Seed data

```text
Seeded 2 users and 20 tasks.
Log in as demo@example.com or admin@example.com (admin), password: demo12345
Nothing to do: the demo users already have 20 tasks.
Log in as demo@example.com or admin@example.com (admin), password: demo12345
```

`scripts/seed.ts` runs the migrations, inserts 2 users with `onConflictDoNothing()` and 20
tasks, but only when these users have no tasks yet, so the second run does nothing. With
`APP_ENV=production` it refuses (`Refusing to seed: APP_ENV is production.`, exit code 1).
**To log in as a demo user:** register is not needed; `POST /auth/login` with
`demo@example.com` or `admin@example.com` (the admin; the role is stored in the database),
password `demo12345`. Three of the done demo tasks finished 34 to 46 days ago, on purpose,
so the purge job of Bonus 14 has something to delete.

### Bonus 6: A connection pool (Postgres or SQLite)

**I did option B: a pool of my own on SQLite.** `src/pool.ts` is a generic `Pool<T>`:
`acquire()` gives an idle item or waits in a queue, `release()` gives it to the next
waiter, and `use(fn)` always releases in a `finally`. `createDb()` opens `DB_POOL_SIZE`
libSQL clients on the same file; `migrate()` turns on `PRAGMA journal_mode=WAL` (readers
do not block the writer; it is stored in the file) and every connection gets
`PRAGMA busy_timeout=5000` (wait up to 5 seconds for a lock instead of failing). A
middleware in `createApp` borrows one connection per request for `/auth/*` and `/api/*`
(after `requireAuth`, so a request without a token never takes one) and gives it back when
the response is ready; the routes use `c.get("conn")`.

Tests: 20 concurrent jobs on a pool of 3 never ran more than 3 at once and all 20
finished; a job that throws gives its connection back; waiting callers are served in
order; and 30 `POST /api/tasks` at the same moment on 3 real SQLite connections all
answer 201.

- **Pool size.** The default is 4 (`DB_POOL_SIZE`). SQLite in WAL mode allows many readers
  but one writer at a time, so a few connections are enough; more would only queue up on
  the write lock.
- **When all connections are busy,** the request waits in the pool's queue and is served
  in order (first come, first served). My queue has no time limit and no maximum length; a
  production pool would add both.
- **Why SQLite gains little from a pool compared with Postgres.** SQLite runs inside my
  process: there is no network and no login to hide, so a connection is cheap to open
  anyway, and all writers still take turns on one file lock. Postgres is a separate
  server: opening a connection costs a TCP connection and a login, and the server can only
  hold a limited number of them, so a pool saves that cost and protects the server.

### Bonus 7: JWT instead of sessions

`signToken(userId, role, secret)` and `verifyToken(token, secret)` in `src/auth.ts` use
`jose` (HS256). The user id is the `sub` claim, the role is a `role` claim, the token
expires after one hour. `verifyToken` returns `null` for a bad, tampered, expired or
foreign token, and `requireAuth` turns that into the 401. The `sessions` table and
`createSession` are gone (migration `0003`). The secret comes from `JWT_SECRET`;
`loadConfig` refuses to start in production with `dev-secret`, with a placeholder starting
with `change-me`, or with a secret shorter than 16 characters. Tests: tampered (one
character changed), expired and signed with another secret all give 401.

|                 | Sessions (table)                  | JWT                                                    |
| --------------- | --------------------------------- | ------------------------------------------------------ |
| Each request    | one database lookup               | only a signature check, no lookup                      |
| Several servers | all need the same database        | all need only the same secret                          |
| Log out / ban   | delete the row, effective at once | **cannot be taken back** before it expires             |
| Changed role    | read fresh from the table         | the old role stays in the token until it expires (1 h) |

So a JWT saves the lookup and works across servers, and it costs the ability to revoke
one. For this API one hour is a short enough window; a refresh-token or a small deny list
would be the next step.

### Bonus 8: OpenAPI and a docs page

The app is an `OpenAPIHono`. Every route is described once with `createRoute`
(`src/routes.ts`: method, path, request schema, and the 400, 401, 404 and other responses)
and registered with `app.openapi`. The Zod schemas in `src/schemas.ts` validate the
requests **and** make the document, so the two cannot disagree. `/openapi.json` lists
every route (output in the curl section below); the two upload routes and the health
routes are registered the same way, the upload ones with `registerPath` because a `File`
is not JSON. `/docs` is a Swagger UI page that loads `/openapi.json`; a `Bearer` security
scheme is registered and the task routes use it, so the page has an **Authorize** button:
log in with `POST /auth/login` on the page, paste the token into Authorize, then try
`GET /api/tasks`. The page loads Swagger UI from `unpkg.com`, so it needs internet.

```sh
$ curl -s localhost:8000/openapi.json | jq -c '{openapi, title: .info.title, paths: (.paths | keys)}'
{"openapi":"3.0.0","title":"Tasks API","paths":["/api/admin/users","/api/me/summary","/api/tasks","/api/tasks/{id}","/api/tasks/{id}/attachment","/api/tasks/{id}/restore","/auth/login","/auth/register","/health","/healthz","/readyz"]}


$ curl -s -o /dev/null -w '%{http_code} %{content_type}\n' localhost:8000/docs
200 text/html; charset=UTF-8
```

### Bonus 9: Roles (RBAC)

`users.role` is `user` by default or `admin`. The role travels in the JWT (`role` claim),
and `requireAuth` puts it in the context next to `userId`. `requireRole(...roles)` answers
401 when nobody is logged in and 403 when the role is not allowed; it protects
`GET /api/admin/users` (every user with the number of their tasks, from one `LEFT JOIN`).
**How an admin comes to exist:** the user who registers with the email in the
`ADMIN_EMAIL` setting gets `role = admin` (and the seed script makes `admin@example.com`).
Nobody else can become an admin through the API. Tests: no token 401, normal user 403,
admin 200, and that without `ADMIN_EMAIL` nobody becomes an admin.

```sh
$ curl -s localhost:8000/api/admin/users -H "Authorization: Bearer $TOKEN"
{"error":"forbidden","requestId":"298793d1-8519-4e9a-96df-1cbf99ed89a3"}

$ curl -s localhost:8000/api/admin/users -H "Authorization: Bearer $ADMIN_TOKEN"
[{"id":1,"email":"zeynep@example.com","role":"user","createdAt":1795175285,"taskCount":2},{"id":2,"email":"other@example.com","role":"user","createdAt":1795175286,"taskCount":1},{"id":3,"email":"admin@example.com","role":"admin","createdAt":1795175286,"taskCount":1}]
```

**401 versus 403.** 401 means "I do not know who you are" (no token, a bad token): logging
in can fix it. 403 means "I know who you are and you are not allowed": logging in again
changes nothing, only another role would. That is why a normal user gets 403 on the admin
route, not 401. (For another user's _task_ I use 404 on purpose, see above: there the
right answer is "it does not exist for you".)

### Bonus 10: Logging and request ids

The first middleware of the app makes `crypto.randomUUID()`, sets the `x-request-id`
response header, awaits `next()` and then logs one JSON line
`{ time, requestId, method, path, status, ms }`. The id is also in the body of every error
(404, 401, 400, 500), so a user can quote it. An excerpt of the real log of the curl run
above:

```text
{"time":"2026-11-20T11:48:05.777Z","requestId":"789186f4-13ef-40ef-8822-56de54db7ef0","method":"GET","path":"/health","status":200,"ms":1}
{"time":"2026-11-20T11:48:05.785Z","requestId":"d72faa48-a34c-45c2-b441-07d253d004ed","method":"GET","path":"/healthz","status":200,"ms":0}
{"time":"2026-11-20T11:48:05.791Z","requestId":"21e463e2-8cc4-4332-bff8-19207bba6f49","method":"GET","path":"/readyz","status":200,"ms":1}
{"time":"2026-11-20T11:48:05.797Z","requestId":"f4c661b9-e8e0-4dc3-b6b5-79301f617d75","method":"GET","path":"/health","status":200,"ms":0}
{"time":"2026-11-20T11:48:05.891Z","requestId":"66e625a9-7026-48bb-9bab-3b6fb7916b6c","method":"POST","path":"/auth/register","status":201,"ms":88}
{"time":"2026-11-20T11:48:05.899Z","requestId":"61956368-0d24-4b0e-bde4-044de88d4d48","method":"POST","path":"/auth/register","status":409,"ms":1}
{"time":"2026-11-20T11:48:05.905Z","requestId":"577f7bc1-687a-46e7-aec2-6bf5744aa4ce","method":"POST","path":"/auth/register","status":400,"ms":1}
{"time":"2026-11-20T11:48:06.064Z","requestId":"0c0a7f3c-1a93-4ca6-b6b3-6c4c87f4c1c1","method":"POST","path":"/auth/login","status":200,"ms":153}
{"time":"2026-11-20T11:48:06.157Z","requestId":"8b19ecd1-8b1c-4cee-b59a-9cd13a9fffa2","method":"POST","path":"/auth/login","status":401,"ms":79}
{"time":"2026-11-20T11:48:06.247Z","requestId":"d79a8c1d-fa80-42f6-841c-bb450bbc921c","method":"POST","path":"/auth/login","status":401,"ms":81}
```

**How I checked that no line contains a password or a token:** the middleware only logs
those six fields, never a body, a header or a query string (`/ws?token=...` is logged as
`/ws`). Then (1) a test sends a register, a login and a `/ws?token=<token>` request and
asserts that no log line contains the password or the token, and (2) after the whole curl
session I ran `grep -c -e secret123 -e eyJ server.log` on the real log: the answer was
`0`. There is also a test that the header is present on 200, 401 and 404 answers and that
a new id is made for every request.

### Bonus 11: Health, readiness and configuration

`GET /healthz` is 200 while the process is up; `GET /readyz` runs `SELECT 1` on a pooled
connection and is 503 when that fails (a test closes the database and checks the 503).
`src/config.ts` reads `PORT`, `DATABASE_URL`, `JWT_SECRET`, `APP_ENV` (and the other
settings of the table at the top) **once**, validates them with Zod and `main.ts` stops at
start-up with a message such as
`Invalid configuration: - PORT: Invalid input: expected number, received NaN`. Production
refuses a missing `DATABASE_URL`, a missing, default, placeholder or short `JWT_SECRET`.
Environment files: `.env` (development), `.env.test` (used by `deno task test`) and
`.env.production` (placeholders only; `deno task start:prod` refuses to start until
`JWT_SECRET` is replaced). Tests for both routes and for bad configuration are in
`ops_test.ts`.

### Bonus 12: File upload

`POST /api/tasks/:id/attachment` reads the form with `c.req.parseBody()` and checks: a
`File` (400), at most 1 MB (413), `image/png` or `image/jpeg` (415). Because the type a
client sends can lie, I also look at the first bytes of the file (the PNG and JPEG
signatures) and answer 415 when they do not match. The file is saved with `Deno.writeFile`
under `crypto.randomUUID()` plus an extension, never under the user's name (a test uploads
a file called `../../etc/passwd.png`); a new upload replaces the old file; `uploads/` is
in `.gitignore`. `GET .../attachment` returns the bytes with the right `content-type` to
the owner only (404 for anyone else). Tests: success and download, 400, 413 (and exactly 1
MB is fine), 415 (also the lying cases), the generated name, other users.

```sh
$ curl -s -X POST localhost:8000/api/tasks/2/attachment -H "Authorization: Bearer $TOKEN" -F 'file=@pixel.png;type=image/png'
{"id":2,"title":"Write the README","status":"done","priority":"high","description":null,"dueDate":null,"createdAt":1795175286,"completedAt":1795175286,"hasAttachment":true}

$ curl -s -X POST localhost:8000/api/tasks/2/attachment -H "Authorization: Bearer $TOKEN" -F 'file=@/etc/hostname;type=text/plain'
{"error":"type not allowed (png or jpeg only)","requestId":"bf9d1756-6fd8-4824-8164-689d455bc091"}

$ curl -s -o downloaded.png -D - localhost:8000/api/tasks/2/attachment -H "Authorization: Bearer $TOKEN" | head -n 5; cmp pixel.png downloaded.png && echo 'downloaded.png is identical to pixel.png'
HTTP/1.1 200 OK
content-type: image/png
x-request-id: 0436753f-6acd-4fdf-9d0a-8ec3deb1803d
content-length: 69
date: Fri, 20 Nov 2026 11:48:05 GMT
downloaded.png is identical to pixel.png
```

### Bonus 13: WebSocket live updates

`GET /ws?token=...` checks the token **before** `Deno.upgradeWebSocket` (401 otherwise; a
browser cannot set headers on a WebSocket, so the token is in the query; the log shows
only `/ws`). `src/hub.ts` keeps a `Map<userId, Set<socket>>`: sockets are added on
`onopen` and removed on `onclose`. After a create, update, delete or restore (and an
upload), `{ type, task }` goes to the sockets of that user only. `deno task demo:ws`
starts a real server and opens two sockets of user A and one of user B. User A changes a
task; this is what I observed:

```text
User A creates, advances and deletes a task from a third place (curl-like):
  [A tab 1] task.created: "Buy milk" (todo)
  [A tab 2] task.created: "Buy milk" (todo)
  [A tab 1] task.updated: "Buy milk" (done)
  [A tab 2] task.updated: "Buy milk" (done)
  [A tab 1] task.deleted: "Buy milk" (done)
  [A tab 2] task.deleted: "Buy milk" (done)
A WebSocket with a bad token gets: 401 {"error":"unauthorized","requestId":"f0281420-743e-41a8-93e5-d3286f94aba2"}
```

Both tabs of A saw every change at once, B saw nothing, and a bad token was refused
with 401. There is also a test with a real server and three real sockets. (The WebSocket
does not check the expiry again after it is open; a socket stays until it is closed.)

### Bonus 14: A background job with Deno.cron

`purgeOldDone(db, days, uploadDir?)` in `src/queries.ts` deletes the tasks with
`status = done` and `completed_at` older than `days` days, removes their uploaded files,
and returns how many rows it removed. `main.ts` registers it with
`Deno.cron("purge old done tasks", config.purgeCron, ...)` (default `0 3 * * *`) and logs
`{"job":"purge","removed":n}`. The unit test inserts tasks done 40, 31, 29 and 0 days ago
and an old task that is not done: only the first two go, and a second run removes 0. To
watch it run I seeded a database (3 done tasks older than 30 days) and started the server
with `PURGE_CRON="* * * * *"`:

```text
{"msg":"listening","port":8100,"env":"development"}
{"job":"purge","removed":3}
{"job":"purge","removed":0}
```

The first minute removed 3 rows, the next minute 0: the job is idempotent.

### Bonus 15: Rate limit on login

`src/limiter.ts`: a `Map` from email to `{ n, reset }`. A failed login is counted; before
the password is checked, 5 or more failures inside the open 60-second window give `429`
with a `Retry-After` header; a successful login clears the counter; an old window starts
again from 0 (the limiter takes a clock, so the test can move time). Tests: five failures,
then the sixth is 429 **even with the right password**; another email is not affected;
success clears; the window resets. Real output:

```sh
$ curl -si -X POST localhost:8000/auth/login -H 'content-type: application/json' -d '{"email":"victim@example.com","password":"wrong"}' | head -n 12
HTTP/1.1 429 Too Many Requests
content-type: application/json
retry-after: 60
x-request-id: 0d9debc8-e58a-44f5-aa15-e5f7a678f291
content-length: 102
date: Fri, 20 Nov 2026 11:48:06 GMT

{"error":"too many failed logins, try again later","requestId":"0d9debc8-e58a-44f5-aa15-e5f7a678f291"}
```

**What this does not protect against:** the counter lives in the memory of one process, so
several servers each have their own count and a restart forgets it (Deno KV would survive
a restart). It is per email, so an attacker who tries _one_ password on _many_ emails is
never blocked, and an attacker can lock a victim out of logging in for a minute by sending
wrong passwords for the victim's email.

### Bonus 16: A cache with Deno KV

`GET /api/tasks/:id` looks in Deno KV first (`src/cache.ts`), key `["task", userId, id]`,
expiry 60 seconds. A miss reads the database and fills the cache. `PUT`, `DELETE`, restore
and upload delete the key. The user id is in the key, so one user can never be served
another user's cached task. `main.ts` opens KV once (`KV_PATH`). Tests count the real
`SELECT ... FROM "tasks"` statements with a logger: the first read is 1, the next two
reads stay at 1 (hits); after a `PUT` the next read goes to the database again and shows
the new title; after a `DELETE` the answer is 404 at once; a different user's request for
the same id does its own lookup and gets 404; nothing is cached for a missing task.

## Bonuses 17 to 20

Bonus 17 is done and proven below. Bonuses 18 to 20 need GitHub or GitLab and a Deno
Deploy / Turso account. I prepared the files; the lines marked **TODO** are the proof I
still have to paste from my real runs. I do not claim a bonus until its TODO is filled in.

### Bonus 17: Docker

Files: `Dockerfile`, `.dockerignore`. The image copies `deno.json`, `src/` and `drizzle/`
(the migrations!), caches the dependencies with `deno cache`, runs as the non-root user
`deno`, and keeps the database, the KV file and the uploads on the volume `/data`.

    docker build -t tasks-api .
    docker volume create tasksdata
    docker run -d --rm --name tasks -p 8000:8000 -v tasksdata:/data tasks-api
    # register, then: docker stop tasks, docker run ... again, register the same email: 409
    docker images tasks-api

For real use add `-e APP_ENV=production -e JWT_SECRET=<a long random string>`. The
permission flags in `CMD` (I checked that the server runs and registers a user with
exactly these and not with `-A`):

| Flag            | Why                                                                     |
| --------------- | ----------------------------------------------------------------------- |
| `--allow-net`   | listen on the port (and reach a hosted libSQL database)                 |
| `--allow-env`   | read `PORT`, `DATABASE_URL`, `JWT_SECRET` ...                           |
| `--allow-read`  | read the `drizzle/` migration files, the database file, uploaded images |
| `--allow-write` | write the database, the KV file and uploaded images (all in `/data`)    |
| `--allow-ffi`   | the libSQL client is a native library                                   |
| `--allow-sys`   | the native library asks the system for information about the OS         |

To make the image smaller: the image already leaves out `ui`, `tests`, `scripts` and the
databases (`.dockerignore`); I could also use `denoland/deno:distroless` as the base
image.

**My run (macOS, Docker Desktop).** The build finished without errors (12 of 12 steps):

```text
$ docker build -t tasks-api .
[+] Building 23.0s (12/12) FINISHED                        docker:desktop-linux
 => [3/7] COPY deno.json deno.lock* ./
 => [4/7] COPY src ./src
 => [5/7] COPY drizzle ./drizzle
 => [6/7] RUN deno cache src/main.ts
 => [7/7] RUN mkdir /data && chown deno:deno /data
 => => naming to docker.io/library/tasks-api:latest
```

First run: the server answers and a user is registered.

```text
$ docker volume create tasksdata
tasksdata
$ docker run -d --rm --name tasks -p 8000:8000 -v tasksdata:/data tasks-api
ca8b7eb3dc9c0b7e01e72010b4873c475f57af3e67d7d5b1634feaf3c428a88d
$ curl -i http://localhost:8000/health
HTTP/1.1 200 OK
{"ok":true}
$ curl -i -X POST http://localhost:8000/auth/register -H "Content-Type: application/json" \
    -d '{"email":"docker@example.com","password":"secret123"}'
HTTP/1.1 201 Created
{"id":1,"email":"docker@example.com","role":"user"}
```

Then I stopped the container (`--rm` deletes it), started a **new** container on the same
volume and registered the same email. It answers `409`, so the data survived the
container:

```text
$ docker stop tasks
tasks
$ docker run -d --rm --name tasks -p 8000:8000 -v tasksdata:/data tasks-api
46e3e4859f47fc9d6d9c249d480e2ccc74bc6123e6e8f6f1bf8b794310e0e1da
$ curl -i -X POST http://localhost:8000/auth/register -H "Content-Type: application/json" \
    -d '{"email":"docker@example.com","password":"secret123"}'
HTTP/1.1 409 Conflict
{"error":"email already registered","requestId":"2e796d70-564a-45e3-9cef-fe94d3185055"}
$ docker stop tasks
$ docker images tasks-api
IMAGE              ID             DISK USAGE   CONTENT SIZE
tasks-api:latest   f4f3f813d207        372MB         91.1MB
```

The image is 372 MB on disk (91.1 MB compressed content).

### Bonus 18: Continuous integration

Files: `.github/workflows/ci.yml` (and the same four commands for GitLab in
`.gitlab-ci.yml`): `deno fmt --check`, `deno lint`, `deno task check`, `deno task test`. I
ran these four commands locally and all pass (see "Run it").

**TODO (my own run):** the link to a green run, the link to a red run (a test that I broke
on purpose in a branch), and a few lines in the log above about what I did.

### Bonus 19: Deploy

The code is ready for a hosted database: `DATABASE_URL=libsql://...` and
`DATABASE_AUTH_TOKEN` go to `createClient({ url, authToken })` (`createDb` in
`src/db.ts`); the file-only settings (WAL, busy timeout) are skipped for a remote
database. On Deno Deploy the disk is not kept, so uploaded images will not survive there,
and `KV_PATH` stays unset (Deno KV is built in). Steps: create a Turso database and token,
`deno deploy create`, set `APP_ENV=production`, `JWT_SECRET`, `DATABASE_URL`,
`DATABASE_AUTH_TOKEN` in the dashboard, `deno deploy --prod`. I did not test this part (it
needs an account).

**TODO (my own run):** the public URL that answers `/health`, the register and login with
curl, and in the log what went wrong.

### Bonus 20: Git repository

`.gitignore` leaves out `.env`, `*.db`, `node_modules`, `uploads/`.

**TODO (my own run):** create the repository, commit in steps over several days (at least
five commits), give the instructor access as announced in Moodle, and put the link here:
`<link>`.
