# Step-by-step setup (correct order)

Follow these steps **in order**. Skipping ahead (e.g. opening the UI before the API can reach the database) usually causes confusing errors.

**Deep dives:** Supabase URL and admin rows → **`SUPABASE_FIRST_STEPS.md`**. Production deploy → **`DEPLOY_RENDER_SUPABASE.md`**. Day-to-day commands → **`RUNBOOK_LOCAL.md`**.

---

## Quick smoke test (before Supabase)

Use **default local SQLite** (do **not** set `AIUG_DATABASE_URL`). Start the API once with an **empty** `panel_users` table; the server creates a test row automatically.

| | |
|--|--|
| **Email** | `dev@localhost` |
| **Password** | `temp-panel-change-me` |

Then run the three local servers (Part E) and sign in at `http://localhost:5173/login`. If login fails, delete `fastapi/aiug_admin.sqlite3`, restart FastAPI, and try again (or your DB already had other `panel_users` rows).

---

## Part A — Prerequisites (once per machine)

1. **Install [Python 3.11+](https://www.python.org/downloads/)** and confirm: `python --version`
2. **Install [Node.js 18+](https://nodejs.org/)** and confirm: `node --version`
3. **Clone or copy** this repo so you have the `admin-panel/` folder.
4. **Create a [Supabase](https://supabase.com) account** (free tier is fine) — you will create the project in Part B.

**Windows PowerShell:** if `npm` errors on “execution policy”, use `npm.cmd` instead (e.g. `npm.cmd install`).

---

## Part B — Supabase project and connection string

Do this **before** you rely on the admin login.

1. In Supabase: **New project** → save the **database password** somewhere safe → wait until the project is ready.
2. Open **Project Settings → Database → Connection string** (URI or pooler URI).
3. Build **`AIUG_DATABASE_URL`**:
   - Replace `postgresql://` with **`postgresql+asyncpg://`**
   - Ensure **`?ssl=require`** is present (add if missing).
   - **URL-encode** special characters in the password (`@` → `%40`, etc.).

Exact screenshots and examples: **`SUPABASE_FIRST_STEPS.md`** sections 1–2.

---

## Part C — Backend environment (FastAPI)

All commands below assume you start from **`admin-panel/fastapi`**.

1. Create and activate a virtual environment:

   **Windows (PowerShell):**
   ```powershell
   cd admin-panel\fastapi
   python -m venv .venv
   .\.venv\Scripts\activate
   ```

   **macOS / Linux:**
   ```bash
   cd admin-panel/fastapi
   python -m venv .venv
   source .venv/bin/activate
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Configure environment variables (pick **one** approach):

   - **Recommended:** Copy **`fastapi/.env.example`** to **`fastapi/.env`**, edit values, then load them in your shell *or* use a tool that reads `.env` before starting uvicorn.  
   - **Or** set variables manually each session:

   **Windows (PowerShell):**
   ```powershell
   $env:AIUG_DATABASE_URL = "postgresql+asyncpg://YOUR_FULL_URL_HERE"
   $env:AIUG_PANEL_ADMIN_EMAIL = "admin@yourcompany.com"
   $env:AIUG_PANEL_ADMIN_PASSWORD = "your-strong-password"
   ```

   **macOS / Linux:**
   ```bash
   export AIUG_DATABASE_URL="postgresql+asyncpg://YOUR_FULL_URL_HERE"
   export AIUG_PANEL_ADMIN_EMAIL="admin@yourcompany.com"
   export AIUG_PANEL_ADMIN_PASSWORD="your-strong-password"
   ```

   **`AIUG_DATABASE_URL`** → Supabase (Part B).  
   **`AIUG_PANEL_ADMIN_*`** → first admin row is created on startup **if that email is not already in `panel_users`**.

4. **First API start (creates all tables)** — still in `fastapi/` with venv active:

   ```bash
   python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
   ```

   Wait until you see the server running with **no database connection errors**. This run executes **`create_all`** and creates **`panel_users`**, etc.

5. **Stop uvicorn** (Ctrl+C) when finished, or leave it running if you are continuing straight to Part E (then you only need one FastAPI terminal).

**Optional (SQLite instead of Supabase for quick experiments):** omit `AIUG_DATABASE_URL` → uses local `aiug_admin.sqlite3`. You must still create **`panel_users`** rows via **`AIUG_PANEL_ADMIN_*`** or **`scripts/add_panel_user.py`**.

---

## Part D — Admin accounts in `panel_users`

After Part C, you should have at least **one** admin if **`AIUG_PANEL_ADMIN_EMAIL`** / **`AIUG_PANEL_ADMIN_PASSWORD`** were set before the first successful start.

**Verify or add more:**

```bash
cd admin-panel/fastapi
# venv active; AIUG_DATABASE_URL set same as Part C

python scripts/add_panel_user.py ops@yourcompany.com "TheirPassword!" "Ops Name"
```

Reset a password:

```bash
python scripts/add_panel_user.py ops@yourcompany.com "NewPassword!" --force
```

More detail: **`SUPABASE_FIRST_STEPS.md`** sections 4–5.

---

## Part E — Run the full local stack (three processes)

Use **three terminals**. **Part C step 4** already started FastAPI on port **8000** — if you stopped it, start it again first.

| Order | Folder | Command | URL |
|-------|--------|---------|-----|
| 1 | `admin-panel/fastapi` | `python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000` | API: `http://127.0.0.1:8000` |
| 2 | `admin-panel/node` | `npm install` then `npm run dev` (or `npm.cmd run dev` on Windows) | Gateway: `http://localhost:8080` |
| 3 | `admin-panel/frontend` | `npm install` then `npm run dev` | UI: `http://localhost:5173` |

The **browser UI talks to the gateway** (`8080`), which proxies **`/api`** → FastAPI. Do **not** skip the gateway for default local dev unless you change **`VITE_API_BASE`** in the frontend.

**Important:** In every terminal where FastAPI runs, **`AIUG_DATABASE_URL`** (and admin env vars if you use them) must be set the same way as in Part C.

---

## Part F — Sign in and quick checks

1. Open **`http://localhost:5173/`**
2. **Admin sign in** → use the email and password from Part D (`AIUG_PANEL_ADMIN_*` or `add_panel_user.py`).
3. You should land on **`/panel`** after a successful login.

If login fails with **401**, see **`RUNBOOK_LOCAL.md`** → *Common failures* (usually missing row in **`panel_users`** or wrong password).

---

## Part G — Browser extension (optional, same machine)

Do this **after** the API is reachable at the URL the extension expects (see **`INSTALL_PILOT.md`** / extension manifest).

1. Load the unpacked **`extension/`** folder in Chrome.
2. Ensure the extension is allowed to call **`http://localhost:8080`** (or your configured API host).
3. Complete onboarding with a valid invite from the admin panel.

---

## Part H — Production (after local works)

Do **not** start here first.

1. **Supabase** — same project; production **`AIUG_DATABASE_URL`** on the host (Render, etc.).
2. **API on Render** — set env vars (`AIUG_DATABASE_URL`, `AIUG_PANEL_JWT_SECRET`, `AIUG_PANEL_AUTH_REQUIRED=1`, etc.).  
3. **Add CORS** for your real admin UI origin in **`fastapi/app/main.py`**.  
4. **Admin UI on Vercel** — build with **`VITE_API_BASE=https://your-render-service.onrender.com`** (no `/api`; direct FastAPI).  
5. **Extension** — point manifest / config to the **public** API URL; ship via **GitHub Releases**.

Full checklist: **`DEPLOY_RENDER_SUPABASE.md`**.

---

## Order checklist (copy/paste)

- [ ] **A** — Python, Node, repo, Supabase account  
- [ ] **B** — Supabase project + `AIUG_DATABASE_URL` (`postgresql+asyncpg://…?ssl=require`)  
- [ ] **C** — venv, `pip install`, env vars, first `uvicorn` start (tables created)  
- [ ] **D** — At least one row in **`panel_users`** (env bootstrap and/or `add_panel_user.py`)  
- [ ] **E** — FastAPI :8000 + gateway :8080 + Vite :5173  
- [ ] **F** — Login at :5173 works  
- [ ] **G** — Extension (optional)  
- [ ] **H** — Render + Vercel + CORS + extension URL when you go live  
