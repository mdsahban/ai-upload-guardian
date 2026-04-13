"""
Build a distributable Chrome extension zip from the repo `extension/` folder.

Usage (from anywhere):
  python admin-panel/scripts/package_extension.py

Output: <repo-root>/dist/ai-upload-guardian-extension-v<manifest-version>.zip

Requires: Python 3.9+ (stdlib only).
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

# .../<repo>/admin-panel/scripts -> repo root is parents[1]
_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parents[1]
_EXT_DIR = _REPO_ROOT / "extension"
_DIST_DIR = _REPO_ROOT / "dist"

_SKIP_DIR_NAMES = {".git", "__pycache__", "node_modules", ".idea", ".vscode"}
_SKIP_SUFFIXES = {".pyc", ".pyo"}


def _should_skip(path: Path) -> bool:
  if any(part in _SKIP_DIR_NAMES for part in path.parts):
    return True
  return path.suffix.lower() in _SKIP_SUFFIXES


def main() -> int:
  if not _EXT_DIR.is_dir():
    print(f"ERROR: extension folder not found: {_EXT_DIR}", file=sys.stderr)
    return 1

  manifest_path = _EXT_DIR / "manifest.json"
  if not manifest_path.is_file():
    print(f"ERROR: missing {manifest_path}", file=sys.stderr)
    return 1

  version = json.loads(manifest_path.read_text(encoding="utf-8")).get("version", "0.0.0")
  _DIST_DIR.mkdir(parents=True, exist_ok=True)
  out_path = _DIST_DIR / f"ai-upload-guardian-extension-v{version}.zip"

  count = 0
  with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
    for path in sorted(_EXT_DIR.rglob("*")):
      if not path.is_file() or _should_skip(path.relative_to(_EXT_DIR)):
        continue
      arcname = path.relative_to(_EXT_DIR).as_posix()
      zf.write(path, arcname)
      count += 1

  print(f"Wrote {out_path} ({count} files)")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
