# Smoke test checklist (pilot)

Run after changes to FastAPI, gateway, frontend, or extension. Services: FastAPI `:8000`, gateway `:8080`, admin UI `:5173`.

## 1. Services

- [ ] `http://127.0.0.1:8000/docs` loads.
- [ ] `http://localhost:8080/health` returns JSON with `ok: true`.
- [ ] Admin UI opens at `http://localhost:5173/`.

## 2. Organization and invites

- [ ] **Organizations**: create a test org (or use `default`).
- [ ] **Invites**: create invite for `employee`; copy code.

## 3. Extension onboarding

- [ ] Extension popup: work email + invite → **Connect** succeeds (connected state).
- [ ] Reload popup: still connected; optional “Change invite” works.

## 4. Upload request → Review

- [ ] Trigger a risky upload (or chat flow) so a **pending** row appears in **Review**.
- [ ] Row shows **User** column when onboarded.
- [ ] **Approve** and **Block** (with optional reason) update status; extension behavior matches decision.

## 5. AutoFix

- [ ] From Review, **Request AutoFix** for a pending item (or use flow that queues autofix).
- [ ] **AutoFix** tab shows item; **Mark completed** (or complete flow) succeeds.
- [ ] **History** reflects final states.

## 6. Users and audit

- [ ] **Users** lists onboarded user; suspend blocks new requests from that identity.
- [ ] **Audit** tab loads entries; **Download audit CSV** produces a file.
- [ ] **History** → **Download CSV** produces request summary (no raw PII columns).

## 7. Remove connection (optional)

- [ ] **Remove connection** on a test user removes them; extension reconnect with new invite works.

Record date, commit hash, and tester name when used for a release gate.
