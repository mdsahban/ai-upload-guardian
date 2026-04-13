# AI Upload Guardian - ASAP Launch Backlog

This backlog is optimized for fastest credible launch while keeping security and admin control intact.

## Priority Legend

- P0: Blocker for pilot launch
- P1: Required in first 2-4 weeks after pilot start
- P2: Important hardening for production readiness

## Sprint 0 (3-5 days) - Stabilize Current System

### P0 Tasks

1. Freeze API behavior for existing request workflow.
2. Add smoke test checklist:
   - upload request approve/block,
   - autofix request complete,
   - chat request to admin.
3. Add runbook for local startup and common failures.

Acceptance:
- Team can run all 3 services and complete full flow without manual debugging.

## Sprint 1 (1 week) - Identity and Org Binding (Pilot Critical)

### P0 Tasks

1. DB migrations:
   - organizations
   - users
   - invites
   - add org_id and employee_id to requests
2. API:
   - POST /v1/invites
   - POST /v1/onboard
   - auth middleware (simple token/JWT)
3. Extension:
   - onboarding screen (invite code + connect)
   - save org/user/token in storage
   - send authenticated request payloads

Acceptance:
- Employee request appears in correct org queue.
- Cross-org access is blocked at API level.

## Sprint 2 (1 week) - Admin User Management

### P0 Tasks

1. Admin UI:
   - Users tab
   - Invites tab
2. User actions:
   - role change
   - suspend/reactivate
   - revoke invite
3. Backend RBAC checks for all admin actions.

Acceptance:
- Admin can identify and manage users end-to-end.
- Suspended users cannot create new requests.

## Sprint 3 (1 week) - Audit and Compliance Core

### P1 Tasks

1. Audit log table + middleware hooks.
2. Log events:
   - decision actions
   - role changes
   - invite create/revoke
3. History export CSV endpoint.

Acceptance:
- Every admin action appears in audit trail with actor and timestamp.

## Sprint 4 (1 week) - Pilot Distribution via GitHub

### P0 Tasks

1. Create pilot install docs (`INSTALL_PILOT.md`).
2. Create release checklist and versioning policy.
3. Package extension zip from `extension/`.
4. Publish GitHub release with clear install/update notes.

Acceptance:
- New employee can install from GitHub and connect via invite code in < 10 minutes.

## Sprint 5 (1-2 weeks) - Security and Reliability Hardening

### P1 Tasks

1. Token expiry + refresh path.
2. Rate limit auth/onboard/request endpoints.
3. Better upload replay fallback per host.
4. OCR diagnostics visibility (char count + mode).

### P2 Tasks

1. Move DB from SQLite to Postgres.
2. Add structured logging + error tracking.
3. Add staging environment.

Acceptance:
- Pilot can run reliably with 20-50 users and audit confidence.

## Engineering Task Breakdown by Area

### Backend (FastAPI)

- Add Alembic migrations.
- Add auth dependency and org scoping helper.
- Add invite issue/consume endpoints.
- Add user role/status management endpoints.
- Add audit logging utility and wrappers.

### Frontend (React)

- Add Users tab and Invites tab.
- Add org-aware filters and user identifiers in queue/history.
- Add admin action modals (change role, suspend, revoke).

### Extension

- Add onboarding UI in popup.
- Persist token/org/user in chrome storage.
- Attach auth header and org/user metadata.
- Add reconnect flow if token expires.

## Risks and Mitigations

1. Risk: org leakage due to missing backend checks.
   - Mitigation: mandatory org filter middleware + integration tests.
2. Risk: manual pilot install support burden.
   - Mitigation: short install guide with screenshots.
3. Risk: OCR variability.
   - Mitigation: diagnostics + fallback modes + known test set.

## Definition of Done (Pilot Launch)

1. Org-bound onboarding works for new employees.
2. Admin can identify and manage users.
3. All request decisions are audited.
4. GitHub pilot release process is documented and repeatable.
5. Security baseline (auth, RBAC, org isolation) is enforced.

## Recently shipped toward this backlog

- Admin **Organizations** tab + `GET /v1/orgs` (create was already `POST /v1/orgs`).
- Admin **Audit** tab (`GET /v1/audit`) plus **CSV exports**: `GET /v1/audit/export.csv`, `GET /v1/requests/export.csv`; History tab **Download CSV**.
- Pilot ops docs: `SMOKE_TEST_CHECKLIST.md`, `RUNBOOK_LOCAL.md`, `RELEASE_CHECKLIST.md` (see `INSTALL_PILOT.md`).
- **Sprint 4:** `admin-panel/scripts/package_extension.py` — builds `dist/ai-upload-guardian-extension-v*.zip` from `extension/`.
- **Sprint 5 (partial):** Rate limits via **slowapi** on `POST /v1/onboard` and `POST /v1/requests` (env-tunable / disable; see `RUNBOOK_LOCAL.md`).

