# Launch plan: Render (API) + Supabase (database) + Vercel (admin UI)

**Before this:** complete local setup in **`SETUP_GUIDE.md`** (Supabase + admins + login working).

Use this when you want the **admin API** on **Render**, **all data** (including **`panel_users`**) in **Supabase Postgres**, and the **static admin site** on **Vercel** (or any static host).

---

## Architecture

| Layer | Service | Role |
|--------|---------|------|
| Database | **Supabase** (Postgres) | You control backups, access, and rows in **`panel_users`**. Same DB holds requests, orgs, pilot `users`, etc. |
| Backend | **Render** Web Service | Runs **FastAPI** (`uvicorn`). Reads/writes Supabase via **`AIUG_DATABASE_URL`**. |
| Admin UI | **Vercel** | Hosts the built React app. Calls Render using **`VITE_API_BASE`** at build time. |
| Extension | **GitHub Releases** | Manifest points to your **public Render API URL** (not localhost). |

**Important:** On Render you usually expose **FastAPI only** (no Node `/api` gateway). The UI must call `https://YOUR-RENDER-SERVICE.onrender.com/v1/...`, so **`VITE_API_BASE`** is the Render URL **without** a trailing `/api` (see `frontend/src/api.ts`).

---

## Phase 1 — Supabase

Follow the detailed checklist in **`SUPABASE_FIRST_STEPS.md`** (create project, build `AIUG_DATABASE_URL`, first API start to create tables, then **`AIUG_PANEL_ADMIN_*`** and/or **`scripts/add_panel_user.py`** for each admin email/password).

Summary:

1. Supabase project + async URL: `postgresql+asyncpg://...?ssl=require`
2. Start FastAPI once with `AIUG_DATABASE_URL` → tables including **`panel_users`**
3. Provision admins with env bootstrap and/or `add_panel_user.py` (see that doc)

---

## Phase 2 — Render (FastAPI)

1. **New → Web Service**, connect your Git repo (or deploy from manual settings).
2. **Root directory:** `admin-panel/fastapi` (or your repo path to the FastAPI app).
3. **Runtime:** Python 3.11+ (match your local version).
4. **Build command:**  
   `pip install -r requirements.txt`
5. **Start command:**  
   `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
6. **Environment variables** (Render dashboard):

   | Variable | Purpose |
   |----------|---------|
   | `AIUG_DATABASE_URL` | Supabase async Postgres URL (see Phase 1). |
   | `AIUG_PANEL_JWT_SECRET` | Long random string (production). |
   | `AIUG_PANEL_AUTH_REQUIRED` | `1` for production (panel JWT or pilot token on `/v1/*`). |
   | `AIUG_SANITIZER_SECRET` | Random string for production-like sanitization. |
   | Optional | `AIUG_PANEL_ADMIN_*`, `AIUG_PANEL_SETUP_KEY`, rate limits—see `RUNBOOK_LOCAL.md`. |

7. After first deploy, open your service URL and confirm **`GET /docs`** or a simple **`GET`** to a known route works.
8. **CORS:** In `fastapi/app/main.py`, add your **Vercel origin** (e.g. `https://your-app.vercel.app`) to **`CORSMiddleware`** `allow_origins` before going live.

**Note:** Render free tier sleeps after idle; first request can be slow. Paid tier stays warm.

---

## Phase 3 — Vercel (admin UI)

1. **Build command:** `cd admin-panel/frontend && npm ci && npm run build`  
   (adjust path if your repo root differs.)
2. **Output directory:** `admin-panel/frontend/dist`
3. **Environment variable at build time:**

   | Variable | Example |
   |----------|---------|
   | `VITE_API_BASE` | `https://your-service.onrender.com` |

   No trailing slash; **no** `/api` suffix when using FastAPI directly on Render.

4. Deploy; open the Vercel URL → **Admin sign in** → should hit Render + Supabase.

---

## Phase 4 — Extension (GitHub)

1. In the extension config / manifest, set the **Admin API base URL** to your **Render** URL (same host as `VITE_API_BASE`).
2. Ensure **host permissions** include that origin.
3. Publish **Releases** (zip or tags); pilots install from GitHub.

---

## Phase 5 — Pre-launch checklist

- [ ] Supabase: `panel_users` populated; you can log in on staging Vercel + Render.
- [ ] Render: `AIUG_DATABASE_URL` and `AIUG_PANEL_JWT_SECRET` set; no secrets in git.
- [ ] FastAPI CORS includes production Vercel URL (and localhost only for dev if needed).
- [ ] `AIUG_PANEL_AUTH_REQUIRED=1` in production.
- [ ] Extension manifest uses production API URL.
- [ ] Supabase backups / RLS policies reviewed if you use the Supabase API for anything else (this app uses Postgres via SQLAlchemy only).

---

## Local development (three processes)

From **`admin-panel/`**:

1. **FastAPI:** `cd fastapi` → venv → `python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`
2. **Gateway:** `cd node` → `npm run dev` (port **8080**; proxies `/api` → FastAPI)
3. **Frontend:** `cd frontend` → `npm run dev` (port **5173**)

Default **`VITE_API_BASE`** is unset → UI uses **`http://localhost:8080/api`** (gateway).  
To test **against Render** from local Vite:  
`set VITE_API_BASE=https://your-service.onrender.com` then `npm run dev`.

On Windows, if `npm` fails in PowerShell, use **`npm.cmd run dev`**.

Open **http://localhost:5173/**.
