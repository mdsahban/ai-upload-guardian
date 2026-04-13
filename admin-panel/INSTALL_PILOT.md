# Pilot Onboarding Runbook (GitHub + Manual Install)

## 1. Start services

1. FastAPI on `:8000`
2. Node gateway on `:8080`
3. Frontend on `:5173`

Verify:
- Admin panel opens
- `/docs` is reachable

## 2. Prepare org and admin

1. Open Admin panel.
2. Use **Organizations** to create a pilot org if you do not want the built-in `default` org.
3. Go to **Invites**; set **Organization ID** (e.g. `default` or your new org id).
4. Create invite for role `employee`.

## 3. Employee install (manual unpack)

1. Download extension zip from GitHub release.
2. Extract locally.
3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Click `Load unpacked` and choose extracted `extension` folder.

## 4. Employee onboarding in extension

1. Click extension icon.
2. In **User onboarding** section, enter:
   - work email
   - invite code
3. Click **Connect**.
4. Confirm status shows `Connected: <orgId> / <employeeId>`.

## 5. Verification checklist

1. Employee uploads a sample file with PII.
2. Request appears in admin `Review`.
3. Admin approve/block updates extension flow.
4. `History` shows stored request.
5. `Users` shows the onboarded employee.

## 6. Security checks before pilot

1. Ensure invite codes are not shared publicly.
2. Suspend test user and verify requests are blocked.
3. Revoke unused invite and verify it cannot be used.
4. Check `/v1/audit` returns audit entries for actions.

## Related docs

- `SMOKE_TEST_CHECKLIST.md` — repeatable QA before a pilot drop.
- `RUNBOOK_LOCAL.md` — start order and common failures.
- `RELEASE_CHECKLIST.md` — GitHub zip + versioning for pilot distribution.

