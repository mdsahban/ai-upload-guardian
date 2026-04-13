import { getPanelToken } from "./auth";

export type RequestStatus = "pending" | "approved" | "blocked";

export type UserRole = "employee" | "reviewer" | "org_admin";
export type UserStatus = "active" | "suspended" | "revoked";

export type RequestOut = {
  requestId: string;
  status: RequestStatus;
  createdAt: number;
  decidedAt?: number | null;
  host: string;
  fileName: string;
  fileType: string;
  riskScore: number;
  pii?: Record<string, unknown> | null;
  decisionReason?: string | null;

  autofixStatus: "none" | "requested" | "completed" | "failed" | string;
  autofixRequestedAt?: number | null;
  autofixCompletedAt?: number | null;
  autofixResult?: string | null;
  /** "upload" | "chat" from API */
  requestKind?: string | null;
  /** Short preview of chat body for chat requests */
  chatTextPreview?: string | null;
  orgId?: string | null;
  employeeId?: string | null;
};

/** Local dev: Node gateway strips /api. In production you MUST set VITE_API_BASE. */
function resolveApiBase(): string {
  const configured = String(import.meta.env.VITE_API_BASE || "").trim();
  if (configured) return configured.replace(/\/$/, "");
  if (import.meta.env.DEV) return "http://localhost:8080/api";
  throw new Error("Missing VITE_API_BASE for production frontend build.");
}

const BASE = resolveApiBase();

/** Attaches panel JWT when present (session after login). */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const rel = path.startsWith("/") ? path : `/${path}`;
  const url = `${BASE}${rel}`;
  const headers = new Headers(init?.headers ?? undefined);
  const t = getPanelToken();
  if (t) {
    headers.set("Authorization", `Bearer ${t}`);
  }
  return fetch(url, { ...init, headers });
}

export async function panelLogin(
  email: string,
  password: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(`${BASE}/v1/panel/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) {
    let msg = `Sign-in failed (${res.status})`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (typeof j?.detail === "string") msg = j.detail;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return (await res.json()) as { accessToken: string; expiresIn: number };
}

export async function listRequests(status?: RequestStatus): Promise<RequestOut[]> {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  const qs = q.toString();
  const res = await apiFetch(`/v1/requests${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to list requests (${res.status})`);
  return await res.json();
}

export async function listRequestsWithAutofix(params: {
  status?: RequestStatus;
  autofixStatus?: "none" | "requested" | "completed" | "failed";
  limit?: number;
}): Promise<RequestOut[]> {
  const url = new URLSearchParams();
  if (params.status) url.set("status", params.status);
  if (params.autofixStatus) url.set("autofix_status", params.autofixStatus);
  if (params.limit) url.set("limit", String(params.limit));
  const qs = url.toString();
  const res = await apiFetch(`/v1/requests${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to list requests (${res.status})`);
  return await res.json();
}

export async function decideRequest(
  requestId: string,
  decision: "approved" | "blocked",
  reason?: string
): Promise<RequestOut> {
  const res = await apiFetch(`/v1/requests/${requestId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, reason })
  });
  if (!res.ok) throw new Error(`Failed to decide (${res.status})`);
  return await res.json();
}

export type CountsOut = {
  pending: number;
  approved: number;
  blocked: number;
  autofixRequested: number;
  total: number;
};

export async function getCounts(): Promise<CountsOut> {
  const res = await apiFetch("/v1/requests/counts");
  if (!res.ok) throw new Error(`Failed to fetch counts (${res.status})`);
  return await res.json();
}

export async function requestAutofix(requestId: string): Promise<RequestOut> {
  const res = await apiFetch(`/v1/requests/${requestId}/autofix-request`, {
    method: "POST"
  });
  if (!res.ok) throw new Error(`Failed to request autofix (${res.status})`);
  return await res.json();
}

export type SanitizationType =
  | "pseudonymization"
  | "tokenization"
  | "encryption"
  | "data_masking";

export async function completeAutofix(
  requestId: string,
  result: "fixed" | "failed",
  reason?: string,
  sanitizationType?: SanitizationType
): Promise<RequestOut> {
  const body: Record<string, unknown> = { result, reason };
  if (sanitizationType) body.sanitizationType = sanitizationType;
  const res = await apiFetch(`/v1/requests/${requestId}/autofix-complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Failed to complete autofix (${res.status})`);
  return await res.json();
}

export type InviteOut = {
  inviteCode: string;
  orgId: string;
  role: UserRole | string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number | null;
  usedByEmail?: string | null;
};

export type UserOut = {
  userId: string;
  orgId: string;
  email: string;
  role: UserRole | string;
  status: UserStatus | string;
  createdAt: number;
  lastSeenAt?: number | null;
};

export async function listInvites(orgId?: string, includeUsed = false): Promise<InviteOut[]> {
  const q = new URLSearchParams();
  if (orgId) q.set("orgId", orgId);
  if (includeUsed) q.set("includeUsed", "true");
  const qs = q.toString();
  const res = await apiFetch(`/v1/invites${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to list invites (${res.status})`);
  return await res.json();
}

export async function createInvite(payload: {
  orgId: string;
  role?: UserRole;
  expiresInHours?: number;
  createdBy?: string;
}): Promise<InviteOut> {
  const res = await apiFetch("/v1/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Failed to create invite (${res.status})`);
  return await res.json();
}

export async function revokeInvite(
  inviteCode: string,
  revokedBy?: string
): Promise<InviteOut> {
  const res = await apiFetch(`/v1/invites/${encodeURIComponent(inviteCode)}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revokedBy })
  });
  if (!res.ok) throw new Error(`Failed to revoke invite (${res.status})`);
  return await res.json();
}

export async function listUsers(orgId?: string, status?: UserStatus): Promise<UserOut[]> {
  const q = new URLSearchParams();
  if (orgId) q.set("orgId", orgId);
  if (status) q.set("status", status);
  const qs = q.toString();
  const res = await apiFetch(`/v1/users${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to list users (${res.status})`);
  return await res.json();
}

export async function updateUserStatus(
  userId: string,
  status: UserStatus
): Promise<UserOut> {
  const res = await apiFetch(`/v1/users/${encodeURIComponent(userId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status })
  });
  if (!res.ok) throw new Error(`Failed to update user status (${res.status})`);
  return await res.json();
}

export async function updateUserRole(userId: string, role: UserRole): Promise<UserOut> {
  const res = await apiFetch(`/v1/users/${encodeURIComponent(userId)}/role`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role })
  });
  if (!res.ok) throw new Error(`Failed to update user role (${res.status})`);
  return await res.json();
}

/** Permanently removes the user; extension tokens for that user stop working until they onboard again. */
export async function deleteUser(userId: string): Promise<void> {
  const res = await apiFetch(`/v1/users/${encodeURIComponent(userId)}`, {
    method: "DELETE"
  });
  if (!res.ok) {
    let msg = `Failed to remove user (${res.status})`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (typeof j?.detail === "string") msg = j.detail;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
}

export type OrgOut = {
  orgId: string;
  name: string;
  createdAt: number;
};

export async function listOrgs(): Promise<OrgOut[]> {
  const res = await apiFetch("/v1/orgs");
  if (!res.ok) throw new Error(`Failed to list organizations (${res.status})`);
  return await res.json();
}

export async function createOrg(payload: {
  name: string;
  orgId?: string;
  adminEmail?: string;
}): Promise<OrgOut> {
  const res = await apiFetch("/v1/orgs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Failed to create organization (${res.status})`);
  return await res.json();
}

export type AuditOut = {
  id: number;
  orgId: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, unknown> | null;
  createdAt: number;
};

export async function listAudit(params?: {
  orgId?: string;
  action?: string;
  limit?: number;
}): Promise<AuditOut[]> {
  const q = new URLSearchParams();
  if (params?.orgId) q.set("orgId", params.orgId);
  if (params?.action) q.set("action", params.action);
  if (params?.limit) q.set("limit", String(params.limit));
  const qs = q.toString();
  const res = await apiFetch(`/v1/audit${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Failed to load audit log (${res.status})`);
  return await res.json();
}

function triggerCsvDownload(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

export async function downloadAuditCsv(params?: {
  orgId?: string;
  action?: string;
  limit?: number;
}): Promise<void> {
  const q = new URLSearchParams();
  if (params?.orgId) q.set("orgId", params.orgId);
  if (params?.action) q.set("action", params.action);
  if (params?.limit) q.set("limit", String(params.limit ?? 5000));
  const qs = q.toString();
  const res = await apiFetch(`/v1/audit/export.csv${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Audit export failed (${res.status})`);
  triggerCsvDownload(await res.blob(), "audit-log.csv");
}

export async function downloadRequestHistoryCsv(params?: {
  status?: RequestStatus | "all";
  orgId?: string;
  employeeId?: string;
  limit?: number;
}): Promise<void> {
  const q = new URLSearchParams();
  if (params?.status && params.status !== "all") {
    q.set("status", params.status);
  }
  if (params?.orgId) q.set("org_id", params.orgId);
  if (params?.employeeId) q.set("employee_id", params.employeeId);
  if (params?.limit) q.set("limit", String(params.limit));
  const qs = q.toString();
  const res = await apiFetch(`/v1/requests/export.csv${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Request history export failed (${res.status})`);
  triggerCsvDownload(await res.blob(), "request-history.csv");
}
