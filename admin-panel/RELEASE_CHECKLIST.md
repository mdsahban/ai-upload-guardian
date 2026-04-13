# Pilot release checklist (GitHub + extension zip)

Use for internal pilot drops. Adjust version strings and repo URLs to match your fork.

## Pre-release

- [ ] All items in `SMOKE_TEST_CHECKLIST.md` pass on a clean machine.
- [ ] `RUNBOOK_LOCAL.md` verified by a second person.
- [ ] Version bumped in `extension/manifest.json` (`version`).
- [ ] `INSTALL_PILOT.md` matches current ports and folder names.

## Build extension zip

- [ ] Run the packaging script (writes `dist/ai-upload-guardian-extension-v<version>.zip` at repo root):

  ```bash
  python admin-panel/scripts/package_extension.py
  ```

  (Use any Python 3.9+; stdlib only. Or manually zip the **`extension/`** folder so `manifest.json` sits at the root of the archive.)

- [ ] Confirm the artifact name matches manifest `version`.

## GitHub release

- [ ] Tag: `vX.Y.Z` aligned with manifest.
- [ ] Release notes: install steps (Developer Mode → Load unpacked **or** unzip then load), minimum Chrome version, link to `INSTALL_PILOT.md`.
- [ ] Attach extension zip.
- [ ] Note compatibility: admin API base URLs (`localhost:8080` pilot).

## Post-release

- [ ] Announce invite-only distribution; remind admins not to post invite codes publicly.
- [ ] Track feedback: failed onboardings, OCR gaps, false positives.

## Versioning policy (suggested)

- **PATCH**: bugfixes, copy, manifest permissions without behavior change.
- **MINOR**: new admin or extension features, backwards-compatible API.
- **MAJOR**: breaking API or onboarding changes; document migration for pilots.
