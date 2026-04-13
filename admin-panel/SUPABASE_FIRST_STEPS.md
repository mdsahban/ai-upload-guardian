# Step 1 — Supabase + admin accounts (`panel_users`)

**Where this fits:** Part B–D of **`SETUP_GUIDE.md`**. Read that file for the full ordered checklist.

This is the first launch step: put your database on **Supabase** and create **real** admin logins (email + password you control). The admin UI `/login` checks the **`panel_users`** table in that same database.

---

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in.
2. **New project** → choose org, name, database password (save it somewhere safe), region.
3. Wait until the project finishes provisioning.

---

## 2. Build `AIUG_DATABASE_URL` (async Postgres)

1. Open **Project Settings** (gear) → **Database**.
2. Under **Connection string**, choose **URI** (or **Transaction pooler** if Supabase shows it for server apps).
3. Copy the string. It usually looks like:
   `postgresql://postgres.[REF]:[YOUR-PASSWORD]@aws-0-....pooler.supabase.com:6543/postgres`
4. Convert it for this app:
   - Change the scheme from `postgresql://` to **`postgresql+asyncpg://`** (required for FastAPI async SQLAlchemy).
   - Append **`?ssl=require`** if it is not already in the query string (Supabase expects TLS).
5. If your password contains `@`, `#`, `%`, spaces, etc., **URL-encode** it in the URL (e.g. `@` → `%40`).

**Example (shape only — use your real host and password):**

```text
postgresql+asyncpg://postgres.abcdefghijk:ENCODED_PASSWORD@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?ssl=require
```

6. **Do not commit** this URL to git. Use Render / local `.env` / host secrets only.

---

## 3. Point the API at Supabase (creates tables)

From your machine (once), with venv active:

```bash
cd admin-panel/fastapi
pip install -r requirements.txt
set AIUG_DATABASE_URL=postgresql+asyncpg://...your full URL...
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

On first startup, FastAPI runs **`create_all`** and creates tables, including **`panel_users`**.

macOS/Linux: `export AIUG_DATABASE_URL=...` instead of `set`.

You can stop uvicorn after you confirm it starts without DB errors.

---

## 4. Create admin emails and passwords (two options)

Admins sign in with **email + password** you define. Passwords are stored as **bcrypt hashes** in **`panel_users`**; only you know the plain password until you share it securely.

### Option A — Env bootstrap (good for first admin)

Set before starting the API (Render or local):

| Variable | Example |
|----------|---------|
| `AIUG_PANEL_ADMIN_EMAIL` | `admin@yourcompany.com` |
| `AIUG_PANEL_ADMIN_PASSWORD` | Strong password you choose |
| `AIUG_PANEL_ADMIN_NAME` | `Administrator` (optional) |

On startup, if that email is **not** already in **`panel_users`**, the server inserts one row.

Use this for the **first** account, then remove or rotate these env vars so the password is not left in hosting config longer than needed.

### Option B — Script (any number of admins)

With `AIUG_DATABASE_URL` set:

```bash
cd admin-panel/fastapi
python scripts/add_panel_user.py finance@yourcompany.com "TheirInitialPassword!" "Finance Admin"
```

Repeat for each person. To reset a password:

```bash
python scripts/add_panel_user.py finance@yourcompany.com "NewPassword!" --force
```

---

## 5. Quick verification

1. Ensure **`panel_users`** has at least one row (Supabase **Table Editor** → `panel_users`, or run a SQL `SELECT` in the SQL editor).
2. Start the API with **`AIUG_DATABASE_URL`** set.
3. Open the admin UI → **Admin sign in** → use the email and password you provisioned.

---

## 6. Next launch steps

After Supabase and admins work locally (or on Render), continue with **`DEPLOY_RENDER_SUPABASE.md`** (host API on Render, UI on Vercel, extension URL, CORS, secrets).

---

## Optional: keep `.env` local only

Copy `fastapi/.env.example` to **`fastapi/.env`**, fill in values, and load them in your shell or use a tool that reads `.env` before `uvicorn`. Never commit `.env`.
