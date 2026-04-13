"""
Create or update a browser admin panel user (panel_users table).

Uses the same DATABASE_URL / bcrypt rules as the FastAPI app.

Usage (from the fastapi/ directory, venv active):

  set AIUG_DATABASE_URL=postgresql+asyncpg://...
  python scripts/add_panel_user.py admin@company.com "your-secure-password" "Admin Name"

For local SQLite (default URL), omit AIUG_DATABASE_URL or point it at your sqlite file.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# fastapi/ on sys.path so `import app.main` works
_FASTAPI_ROOT = Path(__file__).resolve().parent.parent
if str(_FASTAPI_ROOT) not in sys.path:
  sys.path.insert(0, str(_FASTAPI_ROOT))


async def _run(email: str, password: str, full_name: str, force: bool) -> int:
  from app.main import (
    Base,
    PanelUserRow,
    SessionLocal,
    _hash_panel_password,
    engine,
    now_utc,
    select,
  )

  async with engine.begin() as conn:
    await conn.run_sync(Base.metadata.create_all)

  email_norm = email.strip().lower()
  if not email_norm or not password:
    print("Email and password are required.", file=sys.stderr)
    return 2

  async with SessionLocal() as db:
    row = (
      await db.execute(select(PanelUserRow).where(PanelUserRow.email == email_norm))
    ).scalars().first()
    if row:
      if not force:
        print(f"Already exists: {email_norm} (use --force to reset password)", file=sys.stderr)
        return 1
      row.password_hash = _hash_panel_password(password)
      if full_name:
        row.full_name = full_name.strip() or row.full_name
      await db.commit()
      print(f"Updated password for panel user: {email_norm}")
      return 0

    name = (full_name or "").strip() or email_norm
    db.add(
      PanelUserRow(
        email=email_norm,
        password_hash=_hash_panel_password(password),
        full_name=name,
        created_at=now_utc(),
      )
    )
    await db.commit()
    print(f"Created panel user: {email_norm}")
    return 0


def main() -> None:
  p = argparse.ArgumentParser(description="Add or update a panel_users admin login.")
  p.add_argument("email", help="Sign-in email (stored lowercase)")
  p.add_argument("password", help="Plain password (hashed with bcrypt before storage)")
  p.add_argument("full_name", nargs="?", default="", help="Display name (optional)")
  p.add_argument(
    "--force",
    action="store_true",
    help="If the user exists, replace password (and optional name) instead of failing",
  )
  args = p.parse_args()
  code = asyncio.run(_run(args.email, args.password, args.full_name, args.force))
  raise SystemExit(code)


if __name__ == "__main__":
  main()
