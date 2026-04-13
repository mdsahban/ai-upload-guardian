from __future__ import annotations

from datetime import datetime, timezone
import csv
import hashlib
import hmac
import json
import os
import re
from io import StringIO
from typing import Any, Literal, Optional
from uuid import uuid4

import bcrypt
import jwt

from fastapi import FastAPI, HTTPException, Header, Response
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.requests import Request
from starlette.responses import JSONResponse
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy import JSON, DateTime, Integer, String, Text, text as sql_text
from sqlalchemy.ext.asyncio import AsyncAttrs, AsyncSession, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from sqlalchemy import delete, desc, select


def _resolve_database_url() -> str:
  """DB location: local SQLite file or cloud Postgres via AIUG_DATABASE_URL."""
  raw = (
    os.getenv("AIUG_DATABASE_URL")
    or os.getenv("DATABASE_URL")
    or ""
  ).strip()
  if raw:
    # Render/Supabase often provide postgres://; SQLAlchemy async needs dialect prefix.
    if raw.startswith("postgres://"):
      return "postgresql+asyncpg://" + raw[len("postgres://"):]
    if raw.startswith("postgresql://") and not raw.startswith("postgresql+asyncpg://"):
      return "postgresql+asyncpg://" + raw[len("postgresql://"):]
    return raw
  return "sqlite+aiosqlite:///./aiug_admin.sqlite3"


def _is_sqlite_url(url: str) -> bool:
  return url.strip().lower().startswith("sqlite")


DATABASE_URL = _resolve_database_url()

_engine_kwargs: dict[str, Any] = {"future": True}
if _is_sqlite_url(DATABASE_URL):
  _engine_kwargs["connect_args"] = {"check_same_thread": False}
else:
  # Cloud Postgres (Neon, Supabase, RDS, etc.): recover dropped connections.
  _engine_kwargs["pool_pre_ping"] = True
  # Supabase pooler / PgBouncer in transaction mode does not support
  # asyncpg prepared statements; disable statement cache to avoid
  # DuplicatePreparedStatementError during startup/queries.
  if (
    "pooler.supabase.com" in DATABASE_URL
    or os.getenv("AIUG_PGBOUNCER_MODE", "").lower() in ("1", "true", "yes")
  ):
    _engine_kwargs["connect_args"] = {"statement_cache_size": 0}

engine = create_async_engine(DATABASE_URL, **_engine_kwargs)


class Base(AsyncAttrs, DeclarativeBase):
  pass


class RequestRow(Base):
  __tablename__ = "requests"

  id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
  request_id: Mapped[str] = mapped_column(String(36), unique=True, index=True)

  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
  host: Mapped[str] = mapped_column(String(255))
  file_name: Mapped[str] = mapped_column(String(512))
  file_type: Mapped[str] = mapped_column(String(255))
  risk_score: Mapped[int] = mapped_column(Integer, default=0)
  pii: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

  status: Mapped[str] = mapped_column(String(32), default="pending")  # pending|approved|blocked
  decision_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
  decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

  # Auto-fix workflow (redaction/masking/sanitized output)
  autofix_status: Mapped[str] = mapped_column(String(32), default="none")  # none|requested|completed|failed
  autofix_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
  autofix_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
  autofix_result: Mapped[str | None] = mapped_column(Text, nullable=True)

  # Input extracted text for keyword replacement / redaction (provided by extension)
  autofix_input_text: Mapped[str | None] = mapped_column(Text, nullable=True)

  # Internal sanitization report (no original values, just techniques/confidence)
  sanitization_report: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True)

  # Request source: "upload" (file) or "chat" (typing/paste in chat box)
  request_kind: Mapped[str] = mapped_column(String(32), default="upload")
  org_id: Mapped[str] = mapped_column(String(64), default="default", index=True)
  employee_id: Mapped[str] = mapped_column(String(64), default="anon", index=True)


class OrganizationRow(Base):
  __tablename__ = "organizations"
  id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
  org_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
  name: Mapped[str] = mapped_column(String(255))
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class UserRow(Base):
  __tablename__ = "users"
  id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
  user_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
  org_id: Mapped[str] = mapped_column(String(64), index=True)
  email: Mapped[str] = mapped_column(String(255), index=True)
  role: Mapped[str] = mapped_column(String(32), default="employee")  # employee|reviewer|org_admin
  status: Mapped[str] = mapped_column(String(32), default="active")  # active|suspended|revoked
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
  last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class InviteRow(Base):
  __tablename__ = "invites"
  id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
  invite_code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
  org_id: Mapped[str] = mapped_column(String(64), index=True)
  role: Mapped[str] = mapped_column(String(32), default="employee")
  created_by: Mapped[str] = mapped_column(String(255), default="admin")
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
  expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
  used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
  used_by_email: Mapped[str | None] = mapped_column(String(255), nullable=True)


class AuditLogRow(Base):
  __tablename__ = "audit_logs"
  id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
  org_id: Mapped[str] = mapped_column(String(64), index=True)
  actor_user_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
  actor_email: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
  actor_role: Mapped[str | None] = mapped_column(String(32), nullable=True)
  action: Mapped[str] = mapped_column(String(128), index=True)
  target_type: Mapped[str] = mapped_column(String(64), index=True)
  target_id: Mapped[str] = mapped_column(String(128), index=True)
  details: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class PanelUserRow(Base):
  """Browser admin panel operators (separate from extension pilot users in users table)."""
  __tablename__ = "panel_users"
  id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
  email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
  password_hash: Mapped[str] = mapped_column(String(255))
  full_name: Mapped[str] = mapped_column(String(255), default="")
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class EntityMappingRow(Base):
  __tablename__ = "entity_mappings"

  id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
  entity_type: Mapped[str] = mapped_column(String(64), index=True)
  hmac_key: Mapped[str] = mapped_column(String(128), unique=True, index=True)
  pseudonym: Mapped[str] = mapped_column(String(255))
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


def _panel_auth_required() -> bool:
  raw = os.getenv("AIUG_PANEL_AUTH_REQUIRED")
  if raw is None or not str(raw).strip():
    return _is_production()
  return str(raw).strip().lower() in ("1", "true", "yes")


def _is_production() -> bool:
  env = (os.getenv("AIUG_ENV") or os.getenv("ENV") or "").strip().lower()
  if env in {"prod", "production"}:
    return True
  return bool((os.getenv("RENDER") or "").strip())


def _panel_jwt_secret() -> str:
  s = (os.getenv("AIUG_PANEL_JWT_SECRET") or "").strip()
  if s:
    return s
  if _is_production():
    raise RuntimeError("AIUG_PANEL_JWT_SECRET must be set in production.")
  return "aiug-dev-panel-jwt-secret-change-me"


def _sanitizer_secret() -> str:
  s = (os.getenv("AIUG_SANITIZER_SECRET") or "").strip()
  if s:
    return s
  if _is_production():
    raise RuntimeError("AIUG_SANITIZER_SECRET must be set in production.")
  return "aiug-dev-secret-change-me"


def _cors_origins() -> list[str]:
  raw = (os.getenv("AIUG_CORS_ORIGINS") or "").strip()
  if raw:
    return [x.strip() for x in raw.split(",") if x.strip()]
  if _is_production():
    return []
  return [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
  ]


def _extension_origin_regex() -> str | None:
  ids_raw = (os.getenv("AIUG_EXTENSION_IDS") or "").strip()
  if ids_raw:
    ids = [x.strip() for x in ids_raw.split(",") if x.strip()]
    if not ids:
      return None
    escaped = "|".join(re.escape(x) for x in ids)
    return rf"^chrome-extension://({escaped})$"
  if _is_production():
    return None
  return r"^chrome-extension://[\w\-]+$"


def _panel_jwt_exp_seconds() -> int:
  try:
    return max(60, int(os.getenv("AIUG_PANEL_JWT_EXP_SECONDS", "28800")))
  except ValueError:
    return 28800


def _hash_panel_password(plain: str) -> str:
  return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _verify_panel_password(plain: str, password_hash: str) -> bool:
  try:
    return bcrypt.checkpw(plain.encode("utf-8"), password_hash.encode("utf-8"))
  except Exception:
    return False


def _panel_admin_seed_specs() -> list[tuple[str, str, str]]:
  """
  Returns admin accounts to seed from env.
  Supports:
  - legacy single user: AIUG_PANEL_ADMIN_EMAIL / PASSWORD / NAME
  - explicit multi-user: AIUG_PANEL_ADMIN_1_*, AIUG_PANEL_ADMIN_2_*
  """
  out: list[tuple[str, str, str]] = []

  def add_from(prefix: str) -> None:
    email = (os.getenv(f"{prefix}_EMAIL") or "").strip().lower()
    password = os.getenv(f"{prefix}_PASSWORD") or ""
    name = (os.getenv(f"{prefix}_NAME") or "Administrator").strip() or "Administrator"
    if email and password:
      out.append((email, password, name))

  # Keep compatibility with prior deployments.
  legacy_email = (os.getenv("AIUG_PANEL_ADMIN_EMAIL") or "").strip().lower()
  legacy_password = os.getenv("AIUG_PANEL_ADMIN_PASSWORD") or ""
  legacy_name = (os.getenv("AIUG_PANEL_ADMIN_NAME") or "Administrator").strip() or "Administrator"
  if legacy_email and legacy_password:
    out.append((legacy_email, legacy_password, legacy_name))

  add_from("AIUG_PANEL_ADMIN_1")
  add_from("AIUG_PANEL_ADMIN_2")

  # Deduplicate by email while preserving order.
  seen: set[str] = set()
  deduped: list[tuple[str, str, str]] = []
  for email, password, name in out:
    if email in seen:
      continue
    seen.add(email)
    deduped.append((email, password, name))
  return deduped


def now_utc() -> datetime:
  return datetime.now(timezone.utc)


def as_utc_aware(dt: datetime) -> datetime:
  """SQLite may return naive datetimes; normalize for comparisons and timestamps."""
  if dt.tzinfo is None:
    return dt.replace(tzinfo=timezone.utc)
  return dt.astimezone(timezone.utc)


def _issue_panel_jwt(email: str) -> str:
  now = int(now_utc().timestamp())
  exp = now + _panel_jwt_exp_seconds()
  return jwt.encode(
    {"sub": email, "typ": "panel", "iat": now, "exp": exp},
    _panel_jwt_secret(),
    algorithm="HS256",
  )


def _verify_panel_jwt_payload(authorization: str | None) -> dict[str, Any] | None:
  if not authorization:
    return None
  val = str(authorization).strip()
  if not val.lower().startswith("bearer "):
    return None
  token = val.split(" ", 1)[1].strip()
  if token.startswith("pilot::"):
    return None
  try:
    payload = jwt.decode(token, _panel_jwt_secret(), algorithms=["HS256"])
    if payload.get("typ") != "panel":
      return None
    return payload
  except jwt.PyJWTError:
    return None


def _kind_to_token_prefix(kind: str) -> str:
  m = {
    "emails": "EMAIL",
    "phones": "PHONE",
    "passwords": "PASS",
    "creditCards": "CC",
    "apiKeys": "APIKEY",
    "aadhaarNumbers": "AADHAAR",
    "bankAccounts": "BANK",
    "fullNames": "NAME",
    "addresses": "ADDR",
  }
  return m.get(kind, "PII")


async def sanitize_text_with_pii(
  db: AsyncSession,
  text: str,
  pii: dict[str, Any] | None,
  sanitization_type: SanitizationType = "data_masking",
) -> tuple[str, list[dict[str, Any]]]:
  """
  Universal sanitization for extracted text used by the extension AutoFix flow.

  sanitization_type controls the technique:
  - pseudonymization: identity → fake values, numeric → mask
  - tokenization: all → [TYPE_N] tokens
  - encryption: all → [ENCRYPTED] placeholder
  - data_masking: all → partial mask (format-preserving)
  """
  if not text:
    return "", []

  import re

  sanitizer_secret = _sanitizer_secret()

  def normalize_for_key(v: str) -> str:
    # Collapse whitespace + lowercase to make matching stable.
    return re.sub(r"\s+", " ", v.strip()).lower()

  def hmac_key(entity_type: str, raw_value: str) -> str:
    msg = f"{entity_type}|{normalize_for_key(raw_value)}".encode("utf-8")
    return hmac.new(sanitizer_secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()

  def pseudonym_from_hmac(hkey: str) -> str:
    # Deterministic number (bounded) to keep output compact.
    n = int(hkey[:10], 16) % 1000000
    return f"{n:06d}"

  def parse_email_domain(email: str) -> str:
    parts = email.split("@", 1)
    if len(parts) != 2:
      return "anon.com"
    return parts[1]

  def to_flexible_ws_pattern(s: str) -> str:
    norm = re.sub(r"\s+", " ", s.strip())
    if not norm:
      return ""
    parts = norm.split(" ")
    return r"\s+".join(re.escape(p) for p in parts if p)

  async def get_or_create_pseudonym(
    entity_type: str,
    raw_value: str,
    pseudonym_value: str,
  ) -> str:
    key = hmac_key(entity_type, raw_value)
    stmt = select(EntityMappingRow).where(EntityMappingRow.hmac_key == key)
    row = (await db.execute(stmt)).scalars().first()
    if not row:
      db.add(
        EntityMappingRow(
          entity_type=entity_type,
          hmac_key=key,
          pseudonym=pseudonym_value,
          created_at=now_utc(),
        )
      )
      await db.commit()
    return pseudonym_value

  def mask_digits_preserve_separators(
    raw: str,
    keep_first: int,
    keep_last: int,
    mask_char: str = "*",
  ) -> str:
    digits = re.sub(r"\D", "", raw)
    if not digits:
      return raw

    total = len(digits)
    # If too short, mask everything except what we can.
    kf = max(0, min(keep_first, total))
    kl = max(0, min(keep_last, total - kf))

    # Replace digit-by-digit while preserving original separators.
    digit_i = 0
    out = []
    for ch in raw:
      if ch.isdigit():
        # Decide masked/kept by position in digit-only string.
        pos = digit_i
        if pos < kf or pos >= total - kl:
          out.append(ch)
        else:
          out.append(mask_char * 1)
        digit_i += 1
      else:
        out.append(ch)
    return "".join(out)

  def mask_last4_like(raw: str, mask_char: str = "X") -> str:
    return mask_digits_preserve_separators(raw, keep_first=0, keep_last=4, mask_char=mask_char)

  def mask_aadhaar_like(raw: str) -> str:
    # Keep last 4, mask the rest; preserve separators and length.
    return mask_digits_preserve_separators(raw, keep_first=0, keep_last=4, mask_char="X")

  def mask_phone_like(raw: str) -> str:
    # Keep +country/first2 and last2 when possible; otherwise mask mostly.
    digits = re.sub(r"\D", "", raw)
    if len(digits) < 8:
      return mask_last4_like(raw, mask_char="*")
    return mask_digits_preserve_separators(raw, keep_first=2, keep_last=2, mask_char="*")

  def mask_password_like(raw: str) -> str:
    # Preserve trailing punctuation, redact body.
    m = re.search(r"([^A-Za-z0-9])\s*$", raw)
    suffix = m.group(1) if m else ""
    return f"PASSWORD_REDACTED{suffix}"

  def mask_api_key_like(raw: str) -> str:
    # Preserve trailing punctuation, redact body.
    m = re.search(r"([^A-Za-z0-9])\s*$", raw)
    suffix = m.group(1) if m else ""
    return f"API_KEY_REDACTED{suffix}"

  def mask_pii_value(kind: str, raw: str) -> str:
    if kind == "phones":
      return mask_phone_like(raw)
    if kind == "creditCards":
      return mask_last4_like(raw, mask_char="*")
    if kind == "aadhaarNumbers":
      return mask_aadhaar_like(raw)
    if kind == "bankAccounts":
      return mask_last4_like(raw, mask_char="X")
    if kind == "passwords":
      return mask_password_like(raw)
    if kind == "apiKeys":
      return mask_api_key_like(raw)
    # Default numeric-like mask: mask all digits.
    return re.sub(r"\d", "X", raw)

  async def pseudonym_pii_value(kind: str, raw: str) -> str:
    # Emails: MUST pseudonymize and preserve domain.
    if kind == "emails":
      domain = parse_email_domain(raw)
      num = pseudonym_from_hmac(hmac_key("email", raw))
      alias = f"user{num[:3]}"
      pseudo = f"{alias}@{domain}"
      return await get_or_create_pseudonym("email", raw, pseudo)

    if kind == "fullNames":
      num = pseudonym_from_hmac(hmac_key("name", raw))
      pseudo = f"User_{num[:3]}"
      return await get_or_create_pseudonym("name", raw, pseudo)

    if kind == "addresses":
      num = pseudonym_from_hmac(hmac_key("address", raw))
      pseudo = f"Address_{num[:3]}"
      return await get_or_create_pseudonym("address", raw, pseudo)

    # Fallback to stable masking if we don't recognize identity kind.
    return mask_pii_value(kind, raw)

  # Flatten detected entities with their pii key-name.
  entries: list[tuple[str, str]] = []
  if pii:
    for k, arr in pii.items():
      if isinstance(arr, list):
        for v in arr:
          if isinstance(v, str) and v.strip():
            entries.append((k, v.strip()))

  # Replace longer strings first to reduce partial-match overlap.
  entries_sorted = sorted(entries, key=lambda kv: len(kv[1]), reverse=True)[:500]

  token_counters: dict[str, int] = {}

  async def get_replacement(kind: str, raw_value: str) -> tuple[str, str]:
    if sanitization_type == "encryption":
      return "[ENCRYPTED]", "encryption"
    if sanitization_type == "tokenization":
      prefix = _kind_to_token_prefix(kind)
      token_counters[kind] = token_counters.get(kind, 0) + 1
      n = token_counters[kind]
      return f"[{prefix}_{n}]", "tokenization"
    if sanitization_type == "data_masking":
      return mask_pii_value(kind, raw_value), "masking"
    # pseudonymization: identity → pseudo, numeric → mask
    if kind in {"emails", "fullNames", "addresses"}:
      r = await pseudonym_pii_value(kind, raw_value)
      return r, "pseudonymization"
    return mask_pii_value(kind, raw_value), "masking"

  sanitized = text
  report: list[dict[str, Any]] = []
  for kind, raw_value in entries_sorted:
    pattern = to_flexible_ws_pattern(raw_value)
    if not pattern:
      continue

    replacement, technique = await get_replacement(kind, raw_value)
    report.append(
      {"entityType": kind, "technique": technique, "confidence": 0.9}
    )
    sanitized = re.sub(pattern, replacement, sanitized, flags=re.IGNORECASE)

  return sanitized, report


class PiiPayload(BaseModel):
  model_config = ConfigDict(extra="ignore")
  emails: list[str] = Field(default_factory=list)
  phones: list[str] = Field(default_factory=list)
  passwords: list[str] = Field(default_factory=list)
  creditCards: list[str] = Field(default_factory=list)
  apiKeys: list[str] = Field(default_factory=list)
  aadhaarNumbers: list[str] = Field(default_factory=list)
  bankAccounts: list[str] = Field(default_factory=list)
  fullNames: list[str] = Field(default_factory=list)
  addresses: list[str] = Field(default_factory=list)


class CreateRequestBody(BaseModel):
  host: str
  fileName: str
  fileType: str = ""
  riskScore: int = 0
  pii: Optional[PiiPayload] = None
  createdAt: Optional[int] = None  # epoch ms (optional)
  kind: Literal["upload_request", "autofix_request", "chat_message_request"] = "upload_request"
  autofixInputText: Optional[str] = None
  orgId: Optional[str] = None
  employeeId: Optional[str] = None


class RequestOut(BaseModel):
  requestId: str
  status: Literal["pending", "approved", "blocked"]
  createdAt: int
  decidedAt: Optional[int] = None
  host: str
  fileName: str
  fileType: str
  riskScore: int
  pii: Optional[dict[str, Any]] = None
  decisionReason: Optional[str] = None

  autofixStatus: str = "none"
  autofixRequestedAt: Optional[int] = None
  autofixCompletedAt: Optional[int] = None
  autofixResult: Optional[str] = None
  sanitizationReport: Optional[list[dict[str, Any]]] = None
  requestKind: Optional[str] = None
  # First ~800 chars of stored chat text (for chat_message_request); helps admins review before AutoFix.
  chatTextPreview: Optional[str] = None
  orgId: Optional[str] = None
  employeeId: Optional[str] = None


class OrgCreateBody(BaseModel):
  name: str
  orgId: Optional[str] = None
  adminEmail: Optional[str] = None


class OrgOut(BaseModel):
  orgId: str
  name: str
  createdAt: int


class InviteCreateBody(BaseModel):
  orgId: str
  role: Literal["employee", "reviewer", "org_admin"] = "employee"
  expiresInHours: int = 24
  createdBy: Optional[str] = None


class InviteOut(BaseModel):
  inviteCode: str
  orgId: str
  role: str
  createdBy: str
  createdAt: int
  expiresAt: int
  usedAt: Optional[int] = None
  usedByEmail: Optional[str] = None


class InviteRevokeBody(BaseModel):
  revokedBy: Optional[str] = None


class OnboardBody(BaseModel):
  inviteCode: str
  email: str
  name: Optional[str] = None


class OnboardOut(BaseModel):
  orgId: str
  employeeId: str
  role: str
  token: str


class UserOut(BaseModel):
  userId: str
  orgId: str
  email: str
  role: str
  status: str
  createdAt: int
  lastSeenAt: Optional[int] = None


class UserStatusBody(BaseModel):
  status: Literal["active", "suspended", "revoked"]


class UserRoleBody(BaseModel):
  role: Literal["employee", "reviewer", "org_admin"]


class AuditOut(BaseModel):
  id: int
  orgId: str
  actorUserId: Optional[str] = None
  actorEmail: Optional[str] = None
  actorRole: Optional[str] = None
  action: str
  targetType: str
  targetId: str
  details: Optional[dict[str, Any]] = None
  createdAt: int


class PanelLoginBody(BaseModel):
  email: str
  password: str


class PanelLoginOut(BaseModel):
  accessToken: str
  tokenType: str = "bearer"
  expiresIn: int


class PanelMeOut(BaseModel):
  email: str
  fullName: str


class PanelUserCreateBody(BaseModel):
  email: str
  password: str
  fullName: Optional[str] = None


class DecisionBody(BaseModel):
  decision: Literal["approved", "blocked"]
  reason: Optional[str] = None


SanitizationType = Literal[
  "pseudonymization", "tokenization", "encryption", "data_masking"
]


class AutofixCompleteBody(BaseModel):
  model_config = ConfigDict(populate_by_name=True)

  result: Literal["fixed", "failed"]
  reason: Optional[str] = None
  sanitizationType: Optional[SanitizationType] = Field(
    default="data_masking", alias="sanitizationType"
  )


limiter = Limiter(key_func=get_remote_address)


def rate_limit_if_enabled(limit: str):
  """Set AIUG_DISABLE_RATE_LIMIT=1 to skip limits (e.g. load tests)."""
  if os.getenv("AIUG_DISABLE_RATE_LIMIT", "").lower() in ("1", "true", "yes"):
    def _noop(endpoint):
      return endpoint
    return _noop
  return limiter.limit(limit)


app = FastAPI(title="AI Upload Guardian Admin API", version="0.1.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

_allowed_origins = _cors_origins()
_extension_origin_re = _extension_origin_regex()
if _is_production() and not _allowed_origins and not _extension_origin_re:
  raise RuntimeError(
    "Set AIUG_CORS_ORIGINS and/or AIUG_EXTENSION_IDS in production."
  )

app.add_middleware(
  CORSMiddleware,
  allow_origins=_allowed_origins,
  # Browser extensions call with Origin: chrome-extension://<id>
  allow_origin_regex=_extension_origin_re,
  allow_credentials=True,
  allow_methods=["*"],
  allow_headers=["*"],
)


@app.middleware("http")
async def panel_access_guard(request: Request, call_next):
  if request.method == "OPTIONS":
    return await call_next(request)
  if not _panel_auth_required():
    return await call_next(request)
  path = request.url.path
  if path.startswith(("/docs", "/openapi", "/redoc")):
    return await call_next(request)
  if not path.startswith("/v1/"):
    return await call_next(request)
  if path == "/v1/panel/auth/login" and request.method == "POST":
    return await call_next(request)
  if path == "/v1/panel/users" and request.method == "POST":
    return await call_next(request)

  auth = request.headers.get("authorization")
  if _parse_pilot_token(auth):
    return await call_next(request)
  if request.method == "POST" and path == "/v1/onboard":
    return await call_next(request)
  if request.method == "POST" and path == "/v1/requests":
    return await call_next(request)
  if _verify_panel_jwt_payload(auth):
    return await call_next(request)
  return JSONResponse(
    status_code=401,
    content={"detail": "Admin API requires a panel token or extension pilot token."},
  )


@app.on_event("startup")
async def on_startup() -> None:
  async with engine.begin() as conn:
    await conn.run_sync(Base.metadata.create_all)

  # SQLite-only legacy column patches (Postgres gets a fresh schema from create_all).
  if _is_sqlite_url(DATABASE_URL):
    async with engine.begin() as conn:
      try:
        await conn.execute(
          sql_text(
            "ALTER TABLE requests ADD COLUMN autofix_status VARCHAR(32) DEFAULT 'none'"
          )
        )
      except Exception:
        pass

      for stmt in [
        "ALTER TABLE requests ADD COLUMN autofix_requested_at DATETIME",
        "ALTER TABLE requests ADD COLUMN autofix_completed_at DATETIME",
        "ALTER TABLE requests ADD COLUMN autofix_result TEXT",
        "ALTER TABLE requests ADD COLUMN autofix_input_text TEXT",
        "ALTER TABLE requests ADD COLUMN sanitization_report JSON",
        "ALTER TABLE requests ADD COLUMN request_kind VARCHAR(32) DEFAULT 'upload'",
        "ALTER TABLE requests ADD COLUMN org_id VARCHAR(64) DEFAULT 'default'",
        "ALTER TABLE requests ADD COLUMN employee_id VARCHAR(64) DEFAULT 'anon'",
      ]:
        try:
          await conn.execute(sql_text(stmt))
        except Exception:
          pass

  # Ensure pilot has a default organization so invite creation works out-of-box.
  async with SessionLocal() as db:
    existing_default = (
      await db.execute(
        select(OrganizationRow).where(OrganizationRow.org_id == "default")
      )
    ).scalars().first()
    if not existing_default:
      db.add(
        OrganizationRow(
          org_id="default",
          name="Default Organization",
          created_at=now_utc(),
        )
      )
      await db.commit()

  # Seed configured panel admins from env. No temporary auto-users are created.
  seed_specs = _panel_admin_seed_specs()
  if seed_specs:
    async with SessionLocal() as db:
      changed = False
      for seed_email, seed_password, seed_name in seed_specs:
        existing = (
          await db.execute(select(PanelUserRow).where(PanelUserRow.email == seed_email))
        ).scalars().first()
        if existing:
          continue
        db.add(
          PanelUserRow(
            email=seed_email,
            password_hash=_hash_panel_password(seed_password),
            full_name=seed_name,
            created_at=now_utc(),
          )
        )
        changed = True
      if changed:
        await db.commit()


async def to_out(row: RequestRow) -> RequestOut:
  created_ms = int(as_utc_aware(row.created_at).timestamp() * 1000)
  decided_ms = (
    int(as_utc_aware(row.decided_at).timestamp() * 1000) if row.decided_at else None
  )
  autofix_requested_ms = (
    int(as_utc_aware(row.autofix_requested_at).timestamp() * 1000)
    if row.autofix_requested_at
    else None
  )
  autofix_completed_ms = (
    int(as_utc_aware(row.autofix_completed_at).timestamp() * 1000)
    if row.autofix_completed_at
    else None
  )
  rk = getattr(row, "request_kind", "upload") or "upload"
  chat_preview = None
  if rk == "chat":
    raw = (row.autofix_input_text or "").strip()
    if raw:
      chat_preview = raw[:800] + ("…" if len(raw) > 800 else "")
  return RequestOut(
    requestId=row.request_id,
    status=row.status,  # type: ignore[arg-type]
    createdAt=created_ms,
    decidedAt=decided_ms,
    host=row.host,
    fileName=row.file_name,
    fileType=row.file_type,
    riskScore=row.risk_score,
    pii=row.pii,
    decisionReason=row.decision_reason,
    autofixStatus=row.autofix_status,
    autofixRequestedAt=autofix_requested_ms,
    autofixCompletedAt=autofix_completed_ms,
    autofixResult=row.autofix_result,
    sanitizationReport=row.sanitization_report,
    requestKind=rk,
    chatTextPreview=chat_preview,
    orgId=getattr(row, "org_id", "default"),
    employeeId=getattr(row, "employee_id", "anon"),
  )


def _ms(dt: datetime | None) -> int | None:
  if not dt:
    return None
  return int(as_utc_aware(dt).timestamp() * 1000)


def _new_org_id() -> str:
  return f"org_{uuid4().hex[:10]}"


def _new_user_id() -> str:
  return f"usr_{uuid4().hex[:12]}"


def _new_invite_code() -> str:
  return f"AIUG-{uuid4().hex[:8].upper()}"


async def _org_exists(db: AsyncSession, org_id: str) -> bool:
  row = (
    await db.execute(select(OrganizationRow).where(OrganizationRow.org_id == org_id))
  ).scalars().first()
  return row is not None


def _parse_pilot_token(authorization: str | None) -> tuple[str, str] | None:
  if not authorization:
    return None
  val = str(authorization).strip()
  if not val.lower().startswith("bearer "):
    return None
  token = val.split(" ", 1)[1].strip()
  parts = token.split("::")
  if len(parts) != 3 or parts[0] != "pilot":
    return None
  org_id = parts[1].strip()
  user_id = parts[2].strip()
  if not org_id or not user_id:
    return None
  return org_id, user_id


async def _assert_active_user(
  db: AsyncSession,
  org_id: str,
  user_id: str,
) -> UserRow:
  row = (
    await db.execute(
      select(UserRow).where(UserRow.org_id == org_id, UserRow.user_id == user_id)
    )
  ).scalars().first()
  if not row:
    raise HTTPException(status_code=401, detail="Unknown user")
  if row.status != "active":
    raise HTTPException(status_code=403, detail="User is not active")
  row.last_seen_at = now_utc()
  return row


async def _actor_from_auth(
  db: AsyncSession,
  authorization: str | None,
) -> UserRow | None:
  parsed = _parse_pilot_token(authorization)
  if not parsed:
    return None
  org_id, user_id = parsed
  row = (
    await db.execute(
      select(UserRow).where(UserRow.org_id == org_id, UserRow.user_id == user_id)
    )
  ).scalars().first()
  if not row:
    raise HTTPException(status_code=401, detail="Unknown user")
  if row.status != "active":
    raise HTTPException(status_code=403, detail="User is not active")
  row.last_seen_at = now_utc()
  return row


def _require_roles(actor: UserRow | None, allowed_roles: set[str]) -> None:
  if not actor:
    return  # legacy/dev mode without auth
  if actor.role not in allowed_roles:
    raise HTTPException(status_code=403, detail="Insufficient role")


def _audit_out(row: AuditLogRow) -> AuditOut:
  return AuditOut(
    id=row.id,
    orgId=row.org_id,
    actorUserId=row.actor_user_id,
    actorEmail=row.actor_email,
    actorRole=row.actor_role,
    action=row.action,
    targetType=row.target_type,
    targetId=row.target_id,
    details=row.details,
    createdAt=int(as_utc_aware(row.created_at).timestamp() * 1000),
  )


def _write_audit(
  db: AsyncSession,
  *,
  org_id: str,
  actor: UserRow | None,
  action: str,
  target_type: str,
  target_id: str,
  details: dict[str, Any] | None = None,
) -> None:
  db.add(
    AuditLogRow(
      org_id=org_id,
      actor_user_id=actor.user_id if actor else None,
      actor_email=actor.email if actor else None,
      actor_role=actor.role if actor else None,
      action=action,
      target_type=target_type,
      target_id=target_id,
      details=details,
      created_at=now_utc(),
    )
  )


@app.post("/v1/panel/auth/login", response_model=PanelLoginOut)
async def panel_auth_login(body: PanelLoginBody) -> PanelLoginOut:
  email = body.email.strip().lower()
  if not email:
    raise HTTPException(status_code=400, detail="Email required")
  async with SessionLocal() as db:
    row = (
      await db.execute(select(PanelUserRow).where(PanelUserRow.email == email))
    ).scalars().first()
    if not row or not _verify_panel_password(body.password, row.password_hash):
      raise HTTPException(status_code=401, detail="Invalid email or password")
  return PanelLoginOut(
    accessToken=_issue_panel_jwt(email),
    expiresIn=_panel_jwt_exp_seconds(),
  )


@app.get("/v1/panel/auth/me", response_model=PanelMeOut)
async def panel_auth_me(authorization: str | None = Header(None)) -> PanelMeOut:
  payload = _verify_panel_jwt_payload(authorization)
  if not payload or not payload.get("sub"):
    raise HTTPException(status_code=401, detail="Not authenticated")
  email = str(payload["sub"])
  async with SessionLocal() as db:
    row = (
      await db.execute(select(PanelUserRow).where(PanelUserRow.email == email))
    ).scalars().first()
    if not row:
      raise HTTPException(status_code=401, detail="Not authenticated")
    return PanelMeOut(email=row.email, fullName=row.full_name or row.email)


@app.post("/v1/panel/users", status_code=201)
async def panel_create_user_dev(
  body: PanelUserCreateBody,
  x_panel_setup_key: str | None = Header(None, alias="X-Panel-Setup-Key"),
) -> PanelMeOut:
  if _is_production() and os.getenv("AIUG_ENABLE_PANEL_SETUP", "").lower() not in (
    "1",
    "true",
    "yes",
  ):
    raise HTTPException(status_code=403, detail="Panel setup endpoint is disabled")
  expected = (os.getenv("AIUG_PANEL_SETUP_KEY") or "").strip()
  if not expected or not x_panel_setup_key or x_panel_setup_key != expected:
    raise HTTPException(status_code=403, detail="Invalid or missing setup key")
  email = body.email.strip().lower()
  if not email or not body.password:
    raise HTTPException(status_code=400, detail="Email and password required")
  async with SessionLocal() as db:
    dup = (
      await db.execute(select(PanelUserRow).where(PanelUserRow.email == email))
    ).scalars().first()
    if dup:
      raise HTTPException(status_code=409, detail="User already exists")
    name = (body.fullName or "").strip() or email
    db.add(
      PanelUserRow(
        email=email,
        password_hash=_hash_panel_password(body.password),
        full_name=name,
        created_at=now_utc(),
      )
    )
    await db.commit()
  return PanelMeOut(email=email, fullName=name)


@app.post("/v1/orgs", response_model=OrgOut)
async def create_org(
  body: OrgCreateBody,
  authorization: str | None = Header(default=None),
) -> OrgOut:
  org_id = body.orgId or _new_org_id()
  created = now_utc()
  async with SessionLocal() as db:
    actor = await _actor_from_auth(db, authorization)
    _require_roles(actor, {"org_admin"})
    if await _org_exists(db, org_id):
      raise HTTPException(status_code=409, detail="orgId already exists")
    row = OrganizationRow(org_id=org_id, name=body.name.strip(), created_at=created)
    db.add(row)
    _write_audit(
      db,
      org_id=org_id,
      actor=actor,
      action="org.create",
      target_type="organization",
      target_id=org_id,
      details={"name": body.name.strip()},
    )
    if body.adminEmail:
      db.add(
        UserRow(
          user_id=_new_user_id(),
          org_id=org_id,
          email=body.adminEmail.strip().lower(),
          role="org_admin",
          status="active",
          created_at=created,
          last_seen_at=created,
        )
      )
    await db.commit()
  return OrgOut(orgId=org_id, name=body.name.strip(), createdAt=int(created.timestamp() * 1000))


@app.get("/v1/orgs", response_model=list[OrgOut])
async def list_orgs(
  authorization: str | None = Header(default=None),
) -> list[OrgOut]:
  async with SessionLocal() as db:
    actor = await _actor_from_auth(db, authorization)
    _require_roles(actor, {"org_admin", "reviewer"})
    stmt = select(OrganizationRow).order_by(desc(OrganizationRow.created_at)).limit(500)
    if actor:
      stmt = stmt.where(OrganizationRow.org_id == actor.org_id)
    rows = (await db.execute(stmt)).scalars().all()
    return [
      OrgOut(
        orgId=r.org_id,
        name=r.name,
        createdAt=int(as_utc_aware(r.created_at).timestamp() * 1000),
      )
      for r in rows
    ]


@app.post("/v1/invites", response_model=InviteOut)
async def create_invite(
  body: InviteCreateBody,
  authorization: str | None = Header(default=None),
) -> InviteOut:
  created = now_utc()
  expires = datetime.fromtimestamp(
    int(created.timestamp()) + max(1, min(body.expiresInHours, 24 * 14)) * 3600,
    tz=timezone.utc,
  )
  code = _new_invite_code()
  async with SessionLocal() as db:
    actor = await _actor_from_auth(db, authorization)
    _require_roles(actor, {"org_admin"})
    if actor and actor.org_id != body.orgId:
      raise HTTPException(status_code=403, detail="Forbidden org")
    if not await _org_exists(db, body.orgId):
      raise HTTPException(status_code=404, detail="Organization not found")
    row = InviteRow(
      invite_code=code,
      org_id=body.orgId,
      role=body.role,
      created_by=(body.createdBy or "admin").strip(),
      created_at=created,
      expires_at=expires,
    )
    db.add(row)
    _write_audit(
      db,
      org_id=body.orgId,
      actor=actor,
      action="invite.create",
      target_type="invite",
      target_id=code,
      details={"role": body.role, "expiresInHours": body.expiresInHours},
    )
    await db.commit()
  return InviteOut(
    inviteCode=code,
    orgId=body.orgId,
    role=body.role,
    createdBy=(body.createdBy or "admin").strip(),
    createdAt=int(created.timestamp() * 1000),
    expiresAt=int(expires.timestamp() * 1000),
  )


@app.get("/v1/invites", response_model=list[InviteOut])
async def list_invites(
  orgId: Optional[str] = None,
  includeUsed: bool = False,
  authorization: str | None = Header(default=None),
) -> list[InviteOut]:
  async with SessionLocal() as db:
    actor = await _actor_from_auth(db, authorization)
    _require_roles(actor, {"org_admin", "reviewer"})
    stmt = select(InviteRow).order_by(desc(InviteRow.created_at)).limit(300)
    if actor:
      stmt = stmt.where(InviteRow.org_id == actor.org_id)
    if orgId:
      if actor and actor.org_id != orgId:
        raise HTTPException(status_code=403, detail="Forbidden org")
      stmt = stmt.where(InviteRow.org_id == orgId)
    if not includeUsed:
      stmt = stmt.where(InviteRow.used_at.is_(None))
    rows = (await db.execute(stmt)).scalars().all()
    return [
      InviteOut(
        inviteCode=r.invite_code,
        orgId=r.org_id,
        role=r.role,
        createdBy=r.created_by,
        createdAt=int(as_utc_aware(r.created_at).timestamp() * 1000),
        expiresAt=int(as_utc_aware(r.expires_at).timestamp() * 1000),
        usedAt=_ms(r.used_at),
        usedByEmail=r.used_by_email,
      )
      for r in rows
    ]


@app.post("/v1/invites/{invite_code}/revoke", response_model=InviteOut)
async def revoke_invite(
  invite_code: str,
  body: InviteRevokeBody,
  authorization: str | None = Header(default=None),
) -> InviteOut:
  now = now_utc()
  async with SessionLocal() as db:
    actor_user = await _actor_from_auth(db, authorization)
    _require_roles(actor_user, {"org_admin"})
    row = (
      await db.execute(select(InviteRow).where(InviteRow.invite_code == invite_code))
    ).scalars().first()
    if not row:
      raise HTTPException(status_code=404, detail="Invite not found")
    if actor_user and row.org_id != actor_user.org_id:
      raise HTTPException(status_code=403, detail="Forbidden org")
    if row.used_at:
      raise HTTPException(status_code=409, detail="Invite already used/revoked")
    revoked_by = (body.revokedBy or "admin").strip() or "admin"
    row.used_at = now
    row.used_by_email = f"__revoked_by__:{revoked_by}"
    _write_audit(
      db,
      org_id=row.org_id,
      actor=actor_user,
      action="invite.revoke",
      target_type="invite",
      target_id=row.invite_code,
      details={"revokedBy": revoked_by},
    )
    await db.commit()
    await db.refresh(row)
    return InviteOut(
      inviteCode=row.invite_code,
      orgId=row.org_id,
      role=row.role,
      createdBy=row.created_by,
      createdAt=int(as_utc_aware(row.created_at).timestamp() * 1000),
      expiresAt=int(as_utc_aware(row.expires_at).timestamp() * 1000),
      usedAt=_ms(row.used_at),
      usedByEmail=row.used_by_email,
    )


@app.post("/v1/onboard", response_model=OnboardOut)
@rate_limit_if_enabled(os.getenv("AIUG_ONBOARD_RATE_LIMIT", "30/minute"))
async def onboard_employee(request: Request, body: OnboardBody) -> OnboardOut:
  now = now_utc()
  email = body.email.strip().lower()
  code = body.inviteCode.strip()
  async with SessionLocal() as db:
    invite = (
      await db.execute(select(InviteRow).where(InviteRow.invite_code == code))
    ).scalars().first()
    if not invite:
      raise HTTPException(status_code=404, detail="Invite not found")
    if invite.used_at:
      raise HTTPException(status_code=409, detail="Invite already used")
    if as_utc_aware(invite.expires_at) < now:
      raise HTTPException(status_code=410, detail="Invite expired")

    existing = (
      await db.execute(
        select(UserRow).where(UserRow.org_id == invite.org_id, UserRow.email == email)
      )
    ).scalars().first()
    if existing:
      existing.last_seen_at = now
      existing.status = "active"
      user_id = existing.user_id
      role = existing.role
    else:
      user_id = _new_user_id()
      role = invite.role
      db.add(
        UserRow(
          user_id=user_id,
          org_id=invite.org_id,
          email=email,
          role=role,
          status="active",
          created_at=now,
          last_seen_at=now,
        )
      )
    invite.used_at = now
    invite.used_by_email = email
    _write_audit(
      db,
      org_id=invite.org_id,
      actor=None,
      action="user.onboard",
      target_type="user",
      target_id=user_id,
      details={"email": email, "role": role},
    )
    await db.commit()
    return OnboardOut(
      orgId=invite.org_id,
      employeeId=user_id,
      role=role,
      token=f"pilot::{invite.org_id}::{user_id}",
    )


@app.get("/v1/users", response_model=list[UserOut])
async def list_users(
  orgId: Optional[str] = None,
  status: Optional[str] = None,
  authorization: str | None = Header(default=None),
) -> list[UserOut]:
  async with SessionLocal() as db:
    actor = await _actor_from_auth(db, authorization)
    _require_roles(actor, {"org_admin", "reviewer"})
    stmt = select(UserRow).order_by(desc(UserRow.created_at)).limit(500)
    if actor:
      stmt = stmt.where(UserRow.org_id == actor.org_id)
    if orgId:
      if actor and actor.org_id != orgId:
        raise HTTPException(status_code=403, detail="Forbidden org")
      stmt = stmt.where(UserRow.org_id == orgId)
    if status in {"active", "suspended", "revoked"}:
      stmt = stmt.where(UserRow.status == status)
    rows = (await db.execute(stmt)).scalars().all()
    return [
      UserOut(
        userId=r.user_id,
        orgId=r.org_id,
        email=r.email,
        role=r.role,
        status=r.status,
        createdAt=int(r.created_at.timestamp() * 1000),
        lastSeenAt=_ms(r.last_seen_at),
      )
      for r in rows
    ]


@app.post("/v1/users/{user_id}/status", response_model=UserOut)
async def set_user_status(
  user_id: str,
  body: UserStatusBody,
  authorization: str | None = Header(default=None),
) -> UserOut:
  async with SessionLocal() as db:
    actor = await _actor_from_auth(db, authorization)
    _require_roles(actor, {"org_admin"})
    row = (
      await db.execute(select(UserRow).where(UserRow.user_id == user_id))
    ).scalars().first()
    if not row:
      raise HTTPException(status_code=404, detail="User not found")
    if actor and row.org_id != actor.org_id:
      raise HTTPException(status_code=403, detail="Forbidden org")
    row.status = body.status
    row.last_seen_at = now_utc()
    _write_audit(
      db,
      org_id=row.org_id,
      actor=actor,
      action="user.status.update",
      target_type="user",
      target_id=row.user_id,
      details={"status": body.status},
    )
    await db.commit()
    await db.refresh(row)
    return UserOut(
      userId=row.user_id,
      orgId=row.org_id,
      email=row.email,
      role=row.role,
      status=row.status,
      createdAt=int(row.created_at.timestamp() * 1000),
      lastSeenAt=_ms(row.last_seen_at),
    )


@app.post("/v1/users/{user_id}/role", response_model=UserOut)
async def set_user_role(
  user_id: str,
  body: UserRoleBody,
  authorization: str | None = Header(default=None),
) -> UserOut:
  async with SessionLocal() as db:
    actor = await _actor_from_auth(db, authorization)
    _require_roles(actor, {"org_admin"})
    row = (
      await db.execute(select(UserRow).where(UserRow.user_id == user_id))
    ).scalars().first()
    if not row:
      raise HTTPException(status_code=404, detail="User not found")
    if actor and row.org_id != actor.org_id:
      raise HTTPException(status_code=403, detail="Forbidden org")
    row.role = body.role
    row.last_seen_at = now_utc()
    _write_audit(
      db,
      org_id=row.org_id,
      actor=actor,
      action="user.role.update",
      target_type="user",
      target_id=row.user_id,
      details={"role": body.role},
    )
    await db.commit()
    await db.refresh(row)
    return UserOut(
      userId=row.user_id,
      orgId=row.org_id,
      email=row.email,
      role=row.role,
      status=row.status,
      createdAt=int(row.created_at.timestamp() * 1000),
      lastSeenAt=_ms(row.last_seen_at),
    )


@app.delete("/v1/users/{user_id}", status_code=204)
async def delete_user(
  user_id: str,
  authorization: str | None = Header(default=None),
) -> Response:
  """
  Permanently remove a user record. Extension pilot tokens for that user_id
  will fail until they onboard again with a new invite.
  """
  async with SessionLocal() as db:
    actor = await _actor_from_auth(db, authorization)
    _require_roles(actor, {"org_admin"})
    row = (
      await db.execute(select(UserRow).where(UserRow.user_id == user_id))
    ).scalars().first()
    if not row:
      raise HTTPException(status_code=404, detail="User not found")
    if actor and row.org_id != actor.org_id:
      raise HTTPException(status_code=403, detail="Forbidden org")
    if actor and actor.user_id == user_id:
      raise HTTPException(
        status_code=400,
        detail="Cannot remove your own user record while authenticated as that user",
      )
    org_id = row.org_id
    email = row.email
    uid = row.user_id
    _write_audit(
      db,
      org_id=org_id,
      actor=actor,
      action="user.delete",
      target_type="user",
      target_id=uid,
      details={"email": email},
    )
    await db.execute(delete(UserRow).where(UserRow.user_id == uid))
    await db.commit()
  return Response(status_code=204)


@app.post("/v1/requests", response_model=RequestOut)
@rate_limit_if_enabled(os.getenv("AIUG_REQUEST_CREATE_RATE_LIMIT", "180/minute"))
async def create_request(
  request: Request,
  body: CreateRequestBody,
  authorization: str | None = Header(default=None),
) -> RequestOut:
  req_id = str(uuid4())
  created = now_utc()
  if body.createdAt:
    try:
      created = datetime.fromtimestamp(body.createdAt / 1000, tz=timezone.utc)
    except Exception:
      created = now_utc()

  async with SessionLocal() as db:
    actor = _parse_pilot_token(authorization)
    if not actor:
      raise HTTPException(
        status_code=401,
        detail=(
          "Not connected: open the AI Upload Guardian extension popup and complete "
          "invite onboarding (email + invite code) before uploading or requesting review."
        ),
      )
    token_org, token_user = actor
    if body.orgId and body.orgId != token_org:
      raise HTTPException(status_code=403, detail="orgId mismatch")
    if body.employeeId and body.employeeId != token_user:
      raise HTTPException(status_code=403, detail="employeeId mismatch")
    await _assert_active_user(db, token_org, token_user)
    resolved_org = token_org
    resolved_emp = token_user
    row = RequestRow(
      request_id=req_id,
      created_at=created,
      host=body.host,
      file_name=body.fileName,
      file_type=body.fileType or "",
      risk_score=int(body.riskScore or 0),
      pii=body.pii.model_dump() if body.pii else None,
      status="pending",
      request_kind="chat" if body.kind == "chat_message_request" else "upload",
      org_id=resolved_org,
      employee_id=resolved_emp,
    )
    if body.kind == "autofix_request":
      row.autofix_status = "requested"
      row.autofix_requested_at = created
      row.autofix_result = None
      row.autofix_input_text = body.autofixInputText or ""
    elif body.kind == "chat_message_request":
      # Same column as file AutoFix: full message for sanitization when admin runs AutoFix.
      chat_in = body.autofixInputText or ""
      if len(chat_in) > 300_000:
        chat_in = chat_in[:300_000]
      row.autofix_input_text = chat_in or None

    db.add(row)
    _write_audit(
      db,
      org_id=resolved_org,
      actor=None,
      action="request.create",
      target_type="request",
      target_id=req_id,
      details={"kind": body.kind, "host": body.host},
    )
    await db.commit()
    await db.refresh(row)
    return await to_out(row)


@app.get("/v1/requests", response_model=list[RequestOut])
async def list_requests(
  status: Optional[str] = None,
  autofix_status: Optional[str] = None,
  org_id: Optional[str] = None,
  employee_id: Optional[str] = None,
  limit: int = 100,
  authorization: str | None = Header(default=None),
) -> list[RequestOut]:
  limit = max(1, min(limit, 500))
  async with SessionLocal() as db:
    actor = _parse_pilot_token(authorization)
    stmt = select(RequestRow).order_by(desc(RequestRow.created_at)).limit(limit)
    if status in {"pending", "approved", "blocked"}:
      stmt = stmt.where(RequestRow.status == status)
    if autofix_status in {"none", "requested", "completed", "failed"}:
      stmt = stmt.where(RequestRow.autofix_status == autofix_status)
    if actor:
      stmt = stmt.where(RequestRow.org_id == actor[0])
      stmt = stmt.where(RequestRow.employee_id == actor[1])
    elif org_id:
      stmt = stmt.where(RequestRow.org_id == org_id)
    if employee_id:
      stmt = stmt.where(RequestRow.employee_id == employee_id)
    rows = (await db.execute(stmt)).scalars().all()
    return [await to_out(r) for r in rows]


@app.get("/v1/requests/export.csv")
async def export_requests_csv(
  status: Optional[str] = None,
  autofix_status: Optional[str] = None,
  org_id: Optional[str] = None,
  employee_id: Optional[str] = None,
  limit: int = 2000,
  authorization: str | None = Header(default=None),
) -> Response:
  """Request history for spreadsheets (no raw PII columns)."""
  limit = max(1, min(limit, 10000))
  async with SessionLocal() as db:
    actor = _parse_pilot_token(authorization)
    stmt = select(RequestRow).order_by(desc(RequestRow.created_at)).limit(limit)
    if status in {"pending", "approved", "blocked"}:
      stmt = stmt.where(RequestRow.status == status)
    if autofix_status in {"none", "requested", "completed", "failed"}:
      stmt = stmt.where(RequestRow.autofix_status == autofix_status)
    if actor:
      stmt = stmt.where(RequestRow.org_id == actor[0])
      stmt = stmt.where(RequestRow.employee_id == actor[1])
    elif org_id:
      stmt = stmt.where(RequestRow.org_id == org_id)
    if employee_id:
      stmt = stmt.where(RequestRow.employee_id == employee_id)
    rows = (await db.execute(stmt)).scalars().all()

  buf = StringIO()
  w = csv.writer(buf)
  w.writerow(
    [
      "requestId",
      "orgId",
      "employeeId",
      "host",
      "fileName",
      "fileType",
      "status",
      "riskScore",
      "requestKind",
      "autofixStatus",
      "hasPii",
      "createdAtMs",
      "decidedAtMs",
      "decisionReason",
    ]
  )
  for r in rows:
    has_pii = bool(r.pii and isinstance(r.pii, dict) and any(r.pii.values()))
    w.writerow(
      [
        r.request_id,
        r.org_id,
        r.employee_id,
        r.host,
        r.file_name,
        r.file_type,
        r.status,
        r.risk_score,
        getattr(r, "request_kind", "upload"),
        r.autofix_status,
        "yes" if has_pii else "no",
        int(as_utc_aware(r.created_at).timestamp() * 1000),
        int(as_utc_aware(r.decided_at).timestamp() * 1000) if r.decided_at else "",
        (r.decision_reason or "").replace("\r\n", " ").replace("\n", " ")[:500],
      ]
    )
  body = ("\ufeff" + buf.getvalue()).encode("utf-8")
  return Response(
    content=body,
    media_type="text/csv; charset=utf-8",
    headers={
      "Content-Disposition": 'attachment; filename="request-history.csv"',
    },
  )


@app.get("/v1/requests/counts")
async def request_counts(
  authorization: str | None = Header(default=None),
) -> dict[str, Any]:
  async with SessionLocal() as db:
    # In protected mode, require either a panel JWT (admin UI) or pilot token.
    if _panel_auth_required():
      if _verify_panel_jwt_payload(authorization):
        pass
      elif not _parse_pilot_token(authorization):
        raise HTTPException(status_code=401, detail="Not authenticated")

    pending_q = select(RequestRow).where(RequestRow.status == "pending")
    approved_q = select(RequestRow).where(RequestRow.status == "approved")
    blocked_q = select(RequestRow).where(RequestRow.status == "blocked")
    autofix_q = select(RequestRow).where(RequestRow.autofix_status == "requested")

    pending_n = (await db.execute(pending_q)).scalars().all()
    approved_n = (await db.execute(approved_q)).scalars().all()
    blocked_n = (await db.execute(blocked_q)).scalars().all()
    autofix_n = (await db.execute(autofix_q)).scalars().all()

    return {
      "pending": len(pending_n),
      "approved": len(approved_n),
      "blocked": len(blocked_n),
      "autofixRequested": len(autofix_n),
      "total": len(pending_n) + len(approved_n) + len(blocked_n),
    }


@app.get("/v1/requests/{request_id}", response_model=RequestOut)
async def get_request(
  request_id: str,
  authorization: str | None = Header(default=None),
) -> RequestOut:
  async with SessionLocal() as db:
    actor = _parse_pilot_token(authorization)
    if not actor:
      raise HTTPException(
        status_code=401,
        detail=(
          "Not connected: open the extension popup and connect with your invite code "
          "to load this request."
        ),
      )
    await _assert_active_user(db, actor[0], actor[1])
    stmt = select(RequestRow).where(RequestRow.request_id == request_id)
    row = (await db.execute(stmt)).scalars().first()
    if not row:
      raise HTTPException(status_code=404, detail="Not found")
    if row.org_id != actor[0] or row.employee_id != actor[1]:
      raise HTTPException(status_code=403, detail="Forbidden")
    return await to_out(row)


@app.post("/v1/requests/{request_id}/decision", response_model=RequestOut)
async def decide_request(
  request_id: str,
  body: DecisionBody,
  authorization: str | None = Header(default=None),
) -> RequestOut:
  async with SessionLocal() as db:
    actor = _parse_pilot_token(authorization)
    stmt = select(RequestRow).where(RequestRow.request_id == request_id)
    row = (await db.execute(stmt)).scalars().first()
    if not row:
      raise HTTPException(status_code=404, detail="Not found")
    if actor and row.org_id != actor[0]:
      raise HTTPException(status_code=403, detail="Forbidden")
    row.status = body.decision
    row.decision_reason = body.reason
    row.decided_at = now_utc()
    _write_audit(
      db,
      org_id=row.org_id,
      actor=actor,
      action="request.decision",
      target_type="request",
      target_id=row.request_id,
      details={"decision": body.decision, "reason": body.reason},
    )
    await db.commit()
    await db.refresh(row)
    return await to_out(row)


@app.post("/v1/requests/{request_id}/autofix-request", response_model=RequestOut)
async def autofix_request(
  request_id: str,
  authorization: str | None = Header(default=None),
) -> RequestOut:
  async with SessionLocal() as db:
    actor = _parse_pilot_token(authorization)
    stmt = select(RequestRow).where(RequestRow.request_id == request_id)
    row = (await db.execute(stmt)).scalars().first()
    if not row:
      raise HTTPException(status_code=404, detail="Not found")
    if actor and row.org_id != actor[0]:
      raise HTTPException(status_code=403, detail="Forbidden")

    row.autofix_status = "requested"
    row.autofix_requested_at = now_utc()
    row.autofix_result = None
    row.autofix_completed_at = None
    _write_audit(
      db,
      org_id=row.org_id,
      actor=actor,
      action="request.autofix.request",
      target_type="request",
      target_id=row.request_id,
      details={},
    )
    await db.commit()
    await db.refresh(row)
    return await to_out(row)


@app.post("/v1/requests/{request_id}/autofix-complete", response_model=RequestOut)
async def autofix_complete(
  request_id: str,
  body: AutofixCompleteBody,
  authorization: str | None = Header(default=None),
) -> RequestOut:
  async with SessionLocal() as db:
    actor = _parse_pilot_token(authorization)
    stmt = select(RequestRow).where(RequestRow.request_id == request_id)
    row = (await db.execute(stmt)).scalars().first()
    if not row:
      raise HTTPException(status_code=404, detail="Not found")
    if actor and row.org_id != actor[0]:
      raise HTTPException(status_code=403, detail="Forbidden")

    row.autofix_status = "completed"
    row.autofix_completed_at = now_utc()
    if body.result == "fixed":
      stype = body.sanitizationType or "data_masking"
      sanitized, report = await sanitize_text_with_pii(
        db,
        row.autofix_input_text or "",
        row.pii or None,
        sanitization_type=stype,
      )
      row.autofix_result = sanitized
      row.sanitization_report = report
    else:
      row.autofix_result = None
      row.sanitization_report = None

    # Store reason
    row.decision_reason = body.reason or row.decision_reason
    _write_audit(
      db,
      org_id=row.org_id,
      actor=actor,
      action="request.autofix.complete",
      target_type="request",
      target_id=row.request_id,
      details={"result": body.result, "reason": body.reason},
    )

    await db.commit()
    await db.refresh(row)
    return await to_out(row)


@app.get("/v1/audit", response_model=list[AuditOut])
async def list_audit(
  orgId: Optional[str] = None,
  action: Optional[str] = None,
  limit: int = 200,
  authorization: str | None = Header(default=None),
) -> list[AuditOut]:
  limit = max(1, min(limit, 1000))
  async with SessionLocal() as db:
    actor = await _actor_from_auth(db, authorization)
    _require_roles(actor, {"org_admin", "reviewer"})
    stmt = select(AuditLogRow).order_by(desc(AuditLogRow.created_at)).limit(limit)
    if actor:
      stmt = stmt.where(AuditLogRow.org_id == actor.org_id)
    if orgId:
      if actor and actor.org_id != orgId:
        raise HTTPException(status_code=403, detail="Forbidden org")
      stmt = stmt.where(AuditLogRow.org_id == orgId)
    if action:
      stmt = stmt.where(AuditLogRow.action == action)
    rows = (await db.execute(stmt)).scalars().all()
    return [_audit_out(r) for r in rows]


@app.get("/v1/audit/export.csv")
async def export_audit_csv(
  orgId: Optional[str] = None,
  action: Optional[str] = None,
  limit: int = 5000,
  authorization: str | None = Header(default=None),
) -> Response:
  limit = max(1, min(limit, 20000))
  async with SessionLocal() as db:
    actor = await _actor_from_auth(db, authorization)
    _require_roles(actor, {"org_admin", "reviewer"})
    stmt = select(AuditLogRow).order_by(desc(AuditLogRow.created_at)).limit(limit)
    if actor:
      stmt = stmt.where(AuditLogRow.org_id == actor.org_id)
    if orgId:
      if actor and actor.org_id != orgId:
        raise HTTPException(status_code=403, detail="Forbidden org")
      stmt = stmt.where(AuditLogRow.org_id == orgId)
    if action:
      stmt = stmt.where(AuditLogRow.action == action)
    rows = (await db.execute(stmt)).scalars().all()

  buf = StringIO()
  w = csv.writer(buf)
  w.writerow(
    [
      "id",
      "orgId",
      "createdAtMs",
      "action",
      "actorUserId",
      "actorEmail",
      "actorRole",
      "targetType",
      "targetId",
      "detailsJson",
    ]
  )
  for r in rows:
    details = r.details
    if details is None:
      details_s = ""
    elif isinstance(details, (dict, list)):
      details_s = json.dumps(details, ensure_ascii=False)
    else:
      details_s = str(details)
    w.writerow(
      [
        r.id,
        r.org_id,
        int(as_utc_aware(r.created_at).timestamp() * 1000),
        r.action,
        r.actor_user_id or "",
        r.actor_email or "",
        r.actor_role or "",
        r.target_type,
        r.target_id,
        details_s,
      ]
    )
  body = ("\ufeff" + buf.getvalue()).encode("utf-8")
  return Response(
    content=body,
    media_type="text/csv; charset=utf-8",
    headers={"Content-Disposition": 'attachment; filename="audit-log.csv"'},
  )

