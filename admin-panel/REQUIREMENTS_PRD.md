# AI Upload Guardian - Product Requirements (Launch MVP)

## 1) Objective

Build an industry-ready admin-controlled governance system for GenAI uploads/chat usage where:
- employees use the browser extension on ChatGPT/Gemini/Claude,
- risky requests are routed to the correct admin organization,
- admins can approve, block, or trigger AutoFix,
- all actions are auditable.

This PRD targets a fast but production-minded launch.

## 2) In-Scope MVP

- Extension onboarding by invite code (GitHub pilot flow).
- Multi-user and multi-admin support under organization boundaries.
- Admin queue: pending/approved/blocked/autofix workflow.
- History + audit trail.
- OCR and PDF extraction (local-first).
- Role-based access control in admin panel.
- Basic operational security controls.

Out of scope for MVP:
- full SCIM provisioning,
- advanced anomaly detection,
- mobile app.

## 3) Personas and Roles

- Employee
  - submits requests from extension,
  - sees waiting status and final decision.
- Reviewer
  - can approve/block/autofix requests.
- Org Admin
  - manages users/invites/policies for one organization.
- Super Admin
  - global control across organizations.
- Auditor (read-only)
  - access to history and audit exports.

## 4) Functional Requirements

### A. Organization and Identity

1. Admin can create organization.
2. Admin can generate employee invite codes.
3. Invite code is single-use and expires.
4. Employee extension onboarding binds user to org.
5. Backend enforces org isolation on every API.

### B. User Management (Admin Panel)

1. Users tab with search/filter by role/status.
2. Admin can:
   - invite user,
   - change role,
   - suspend/reactivate,
   - revoke access.
3. Last seen and basic activity visible per user.

### C. Request Governance

1. Extension creates request with org/user identity.
2. Admin queue supports:
   - approve,
   - block (optional reason),
   - AutoFix request/complete.
3. Extension receives decision in same modal flow and enforces outcome.
4. History page includes request status, timestamps, actor, reason.

### D. OCR/Text Extraction

1. PDF extraction via pdf.js text layer.
2. OCR fallback for scanned/sparse pages and images.
3. Local-first extraction, no user text sent to third-party OCR APIs.
4. Failure-safe behavior:
   - if extraction fails, request can still be sent for admin review with low confidence tag.

### E. Audit and Compliance

1. Immutable audit log for:
   - role changes,
   - invite create/revoke,
   - decision actions.
2. Export history/audit to CSV.

## 5) Non-Functional Requirements

- Availability target: 99.5% (MVP target).
- API p95 latency:
  - request create: < 1000ms,
  - list queue: < 1200ms.
- Secure transport: HTTPS in non-local environments.
- Data minimization:
  - do not store raw uploads by default.
- Observability:
  - structured logs + error tracking.

## 6) Security Requirements

1. Auth required on all admin and request endpoints.
2. Server-side RBAC and org checks mandatory.
3. Token expiry and rotation support.
4. Rate limiting for auth and request creation APIs.
5. No secrets in repo; environment-based configuration.
6. Audit records cannot be edited from UI.

## 7) Data Model Requirements (Minimum)

- organizations
- users
- invites
- requests
- audit_logs

Requests must include:
- org_id
- employee_id
- status
- created_at / decided_at
- decision_by / decision_reason

## 8) API Requirements (Minimum)

- POST /v1/onboard
- POST /v1/invites
- GET /v1/invites
- POST /v1/users/{id}/role
- POST /v1/users/{id}/suspend
- POST /v1/requests
- GET /v1/requests
- GET /v1/requests/{id}
- POST /v1/requests/{id}/decision
- POST /v1/requests/{id}/autofix-request
- POST /v1/requests/{id}/autofix-complete
- GET /v1/audit

## 9) Distribution Requirements (GitHub Pilot)

1. GitHub release contains extension zip.
2. Employee installs unpacked extension manually.
3. Employee enters invite code to connect to correct org/admin.
4. Update process is manual during pilot.

## 10) MVP Acceptance Criteria

1. 20 employees can onboard to correct org without cross-org leakage.
2. Admin queue receives requests with correct user identity.
3. Approve/block/autofix works end-to-end from extension.
4. User management actions (role/suspend/revoke) are effective immediately.
5. Audit export contains complete decision and actor details.
6. OCR path detects at least baseline sensitive patterns on test samples.

