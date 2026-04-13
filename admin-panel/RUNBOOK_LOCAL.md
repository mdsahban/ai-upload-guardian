# Local runbook — AI Upload Guardian admin stack

**Full ordered setup (start here if you are new):** **`SETUP_GUIDE.md`**.

**Supabase + first admin details:** **`SUPABASE_FIRST_STEPS.md`**.

## Start (Windows / macOS / Linux)

From repository root `admin-panel/`:

1. **FastAPI** (Python venv recommended)

   ```bash
   cd fastapi
   python -m venv .venv
   .venv\Scripts\activate   # Windows
   pip install -r requirements.txt
   python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
   ```

   Set **`AIUG_DATABASE_URL`** for **Supabase** (or keep default SQLite for quick UI-only experiments). **Panel logins** must exist in **`panel_users`**: use **`AIUG_PANEL_ADMIN_*`** and/or **`scripts/add_panel_user.py`** — see **`SUPABASE_FIRST_STEPS.md`**.

2. **Gateway** (new terminal)

   ```bash
   cd admin-panel/node
   npm install
   npm run dev
   ```

   Listens on `http://localhost:8080`, proxies `/api` → FastAPI.

3. **Frontend** (new terminal)

   ```bash
   cd admin-panel/frontend
   npm install
   npm run dev
   ```

   Open `http://localhost:5173/` (landing page). Use **Admin sign in** → `/login`, then the console at `/panel`.

## Where the database lives (your control)

All admin data (requests, orgs, users, invites, audit, **panel_users**, etc.) lives in one SQLite file unless you change the URL.

- **Default file** (when you run uvicorn from the `fastapi/` folder):  
  `admin-panel/fastapi/aiug_admin.sqlite3`  
  That path is **relative to the process working directory**, so always start the API from `fastapi/` or set an explicit URL.

- **Put the file wherever you want** — set **`AIUG_DATABASE_URL`** to a full SQLAlchemy async SQLite URL, for example:
  - Windows: `AIUG_DATABASE_URL=sqlite+aiosqlite:///C:/Data/aiug/aiug_admin.sqlite3`
  - macOS / Linux: `AIUG_DATABASE_URL=sqlite+aiosqlite:////var/lib/aiug/aiug_admin.sqlite3`  
  Use forward slashes in the URL; create the parent folder first so SQLite can create the file.

Back up that file to keep reviews, orgs, and panel logins under your control; copying it copies the whole admin state.

## Cloud database (PostgreSQL) — shared admin logins

You can point the **same** app at a hosted Postgres database (Neon, Supabase, AWS RDS, Azure, Railway, etc.) so **you** control where data lives and **you** create admin accounts manually, then hand email/password to each operator. They use the normal **Admin sign in** page; nothing changes in the UI.

### 1. Create a Postgres database

In your provider’s console, create a database and a user with DDL permission (for first-time table creation). Copy the **async** connection details.

### 2. Connection string for FastAPI

Set **`AIUG_DATABASE_URL`** to SQLAlchemy’s **async** Postgres URL (requires `asyncpg`, already in `requirements.txt`):

```text
postgresql+asyncpg://USER:PASSWORD@HOST:5432/DATABASE?ssl=require
```

Many hosts require TLS: append **`?ssl=require`** or **`?ssl=true`** (check the provider’s docs). Passwords with special characters must be **URL-encoded**.

After setting the variable, install deps and start uvicorn as usual. On first startup the app runs **`create_all`** and creates tables including **`panel_users`**.

### 3. Add admin users manually (recommended flow)

**Option A — helper script (bcrypt matches the app exactly)**  

From `admin-panel/fastapi/` with venv active and `AIUG_DATABASE_URL` set:

```bash
python scripts/add_panel_user.py ops@yourcompany.com "choose-a-strong-password" "Ops Team"
```

Repeat for each admin. Share **email + password** with them out-of-band (1Password, IT ticket, etc.). They are **not** stored in git.

To **reset** a password:

```bash
python scripts/add_panel_user.py ops@yourcompany.com "new-password" --force
```

**Option B — provider SQL editor**  

Generate a bcrypt hash with the same cost as the app, then `INSERT` into `panel_users` (`email`, `password_hash`, `full_name`, `created_at`). Easiest is still Option A so you do not mismatch hashing.

**Option C — HTTP API**  

With **`AIUG_PANEL_SETUP_KEY`** set, `POST /v1/panel/users` with header **`X-Panel-Setup-Key`** (see *Panel admin login* below) also creates panel users.

### 4. Operations notes

- **Backups**: use your provider’s snapshots / PITR; your team owns retention and restore.
- **SQLite vs Postgres**: pilot/extension data and reviews live in the **same** database URL you configure — switching URL points the whole stack at that backend.
- **Local dev**: keep using default SQLite; use Postgres when you want a shared or production-like environment.

## Panel admin login (browser console)

Operators who use the React admin UI sign in against the **`panel_users`** table (separate from extension **pilot** users in **`users`**). With SQLite, both live in one file; with Postgres, both live in one **database** — still two tables/concepts.

1. **First admin (recommended)** — set env vars before starting FastAPI; on startup the server creates the row if it does not exist:
   - `AIUG_PANEL_ADMIN_EMAIL` — e.g. `admin@yourcompany.com`
   - `AIUG_PANEL_ADMIN_PASSWORD` — strong password
   - Optional: `AIUG_PANEL_ADMIN_NAME` — display name (default `Administrator`)

2. **Extra panel accounts** — with FastAPI running, set `AIUG_PANEL_SETUP_KEY` to a long random secret, restart, then:

   ```bash
   curl -s -X POST http://127.0.0.1:8000/v1/panel/users ^
     -H "Content-Type: application/json" ^
     -H "X-Panel-Setup-Key: YOUR_SETUP_KEY" ^
     -d "{\"email\":\"ops@yourcompany.com\",\"password\":\"...\",\"fullName\":\"Ops\"}"
   ```

   (On macOS/Linux use `\` line continuations instead of `^`.)

3. **Lock down the API in production** — set `AIUG_PANEL_AUTH_REQUIRED=1` (or `true` / `yes`) so `/v1/*` requires either a **panel JWT** (from login) or an **extension pilot** token. Onboarding and `POST /v1/requests` stay open for the extension.

4. **Secrets** — set `AIUG_PANEL_JWT_SECRET` to a strong random string in production (defaults to a dev placeholder). Optional: `AIUG_PANEL_JWT_EXP_SECONDS` (default `28800` = 8h).

## Common failures

| Symptom | Likely cause | Fix |
|--------|----------------|-----|
| Login returns 401 (`Invalid email or password`) | Wrong DB, missing `dev@localhost`, or bad hash on that row | **SQLite:** restart FastAPI — it creates `dev@localhost` if missing (`SETUP_GUIDE` smoke test). If the row exists but password was changed, run `python scripts/add_panel_user.py dev@localhost "temp-panel-change-me" --force`. **Postgres:** use `AIUG_PANEL_ADMIN_*` or `add_panel_user.py` — smoke user is not auto-created. |
| API 401 after enabling `AIUG_PANEL_AUTH_REQUIRED` | Browser not sending panel token | Sign in via `/login` so the UI stores the JWT; extension calls must still send `Authorization: Bearer pilot::…`. |
| UI shows fetch errors / empty data | Gateway not running or wrong port | Start `node` on 8080; `api.ts` uses `http://localhost:8080/api`. |
| Extension “Admin API not reachable” | FastAPI down or blocked host | Start FastAPI; extension manifest must allow `localhost:8080` / `127.0.0.1:8080` (and optional `:8000` fallbacks). |
| Connect / onboard 500 | Server bug or DB issue | Check FastAPI terminal traceback; ensure SQLite file writable under `fastapi/`, or Postgres URL/ssl/user permissions if using cloud DB. |
| Postgres “connection refused” / SSL | Wrong URL or TLS required | Use `postgresql+asyncpg://...` and add `?ssl=require` (or provider-specific params). |
| Connect 410 / 409 | Invite expired or used | Create a new invite in admin. |
| Audit tab 403 | Pilot token is `employee` | Open admin without employee token header, or use `org_admin` / `reviewer` user for API calls when auth is enforced. |
| CORS errors in browser | Origin not allowed | FastAPI allows `localhost:5173` and `chrome-extension://`; use gateway for admin UI. |

## Optional env

- `AIUG_DATABASE_URL` — SQLite file URL **or** `postgresql+asyncpg://...` for Supabase/Postgres (see **`SUPABASE_FIRST_STEPS.md`**).
- `AIUG_PANEL_ADMIN_EMAIL`, `AIUG_PANEL_ADMIN_PASSWORD`, `AIUG_PANEL_ADMIN_NAME` — bootstrap first admin on startup if missing.
- `AIUG_SANITIZER_SECRET` — set for production-like sanitization (see FastAPI code).
- `AIUG_DISABLE_RATE_LIMIT` — set to `1` / `true` / `yes` to turn off API rate limits (load tests only).
- `AIUG_ONBOARD_RATE_LIMIT` — default `30/minute` for `POST /v1/onboard` (per client IP as seen by uvicorn).
- `AIUG_REQUEST_CREATE_RATE_LIMIT` — default `180/minute` for `POST /v1/requests`.

Behind the Node gateway, the client IP is often `127.0.0.1`, so all local traffic shares one bucket; raise limits if needed for multi-tester pilots.

## Data

- Default SQLite path: `admin-panel/fastapi/aiug_admin.sqlite3` (relative to process cwd when running uvicorn from `fastapi/`). Override with **`AIUG_DATABASE_URL`** — SQLite or Postgres (see sections above).

## Extension

- Load unpacked `extension/` in Chrome; complete onboarding per `INSTALL_PILOT.md`.

## Production (Render + Supabase + Vercel)

See **`DEPLOY_RENDER_SUPABASE.md`** for a step-by-step launch plan (API on Render, database on Supabase, admin UI on Vercel, extension on GitHub).
