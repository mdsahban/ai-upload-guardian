import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AuditOut,
  completeAutofix,
  createInvite,
  createOrg,
  deleteUser,
  decideRequest,
  downloadAuditCsv,
  downloadRequestHistoryCsv,
  getCounts,
  InviteOut,
  listAudit,
  listOrgs,
  listRequests,
  listRequestsWithAutofix,
  listInvites,
  listUsers,
  OrgOut,
  RequestOut,
  RequestStatus,
  requestAutofix,
  revokeInvite,
  CountsOut,
  SanitizationType,
  updateUserRole,
  updateUserStatus,
  UserOut
} from "./api";
import { clearPanelToken } from "./auth";
import "./styles.css";

type TabKey =
  | "dashboard"
  | "review"
  | "autofix"
  | "history"
  | "users"
  | "invites"
  | "organizations"
  | "audit";

const EXTENSION_RELEASES_URL =
  (import.meta.env.VITE_EXTENSION_RELEASES_URL &&
    String(import.meta.env.VITE_EXTENSION_RELEASES_URL).trim()) ||
  "https://github.com/mdsahban/ai-upload-guardian/releases";

function fmtTime(ms?: number | null) {
  if (!ms) return "-";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "-";
  }
}

function badgeClass(status: RequestOut["status"]) {
  if (status === "approved") return "badge badge-green";
  if (status === "blocked") return "badge badge-red";
  return "badge badge-amber";
}

function requestUserLabelParts(r: RequestOut, emailById: Map<string, string>) {
  const id = String(r.employeeId || "").trim();
  const org = String(r.orgId || "").trim();
  if (!id || id === "anon") {
    return { line1: "—", line2: org || null };
  }
  const mail = emailById.get(id);
  if (mail) {
    const tail = [org, id].filter(Boolean).join(" · ");
    return { line1: mail, line2: tail || null };
  }
  return { line1: id, line2: org || null };
}

const REVOKED_PREFIX = "__revoked_by__:";

/** Usable now: not consumed and not past expiry. */
function isInviteActive(iv: InviteOut, now: number): boolean {
  if (iv.usedAt) return false;
  if (iv.expiresAt < now) return false;
  return true;
}

function partitionInvites(items: InviteOut[]) {
  const now = Date.now();
  const active: InviteOut[] = [];
  const inactive: InviteOut[] = [];
  for (const iv of items) {
    if (isInviteActive(iv, now)) active.push(iv);
    else inactive.push(iv);
  }
  active.sort((a, b) => b.createdAt - a.createdAt);
  inactive.sort((a, b) => {
    const ta = a.usedAt ?? a.expiresAt;
    const tb = b.usedAt ?? b.expiresAt;
    return tb - ta;
  });
  return { active, inactive };
}

function formatInviteUsedBy(iv: InviteOut): string {
  const e = iv.usedByEmail || "";
  if (e.startsWith(REVOKED_PREFIX)) {
    const who = e.slice(REVOKED_PREFIX.length).trim() || "admin";
    return `Revoked (${who})`;
  }
  return e || "-";
}

function auditDetailsPreview(details: Record<string, unknown> | null | undefined) {
  if (!details || typeof details !== "object") return "—";
  try {
    const s = JSON.stringify(details);
    return s.length > 140 ? `${s.slice(0, 137)}…` : s;
  } catch {
    return "—";
  }
}

function piiGroupsFromRequest(r: RequestOut | null) {
  const pii = (r?.pii || {}) as Record<string, unknown>;
  return (
    [
      { key: "emails", label: "Email Addresses" },
      { key: "phones", label: "Phone Numbers" },
      { key: "passwords", label: "Passwords / Secrets" },
      { key: "creditCards", label: "Credit Card Numbers" },
      { key: "apiKeys", label: "API Keys / Tokens" },
      { key: "aadhaarNumbers", label: "Aadhaar Numbers" },
      { key: "bankAccounts", label: "Bank Account Numbers" },
      { key: "fullNames", label: "Full Names" },
      { key: "addresses", label: "Addresses" }
    ] as const
  ).map((g) => ({
    ...g,
    values: Array.isArray(pii[g.key]) ? (pii[g.key] as unknown[]) : []
  }));
}

function ChatMessagePreview({ request }: { request: RequestOut | null }) {
  const prev = String(request?.chatTextPreview || "").trim();
  if (!prev) return null;
  return (
    <div className="chatPreviewBlock">
      <div className="chatPreviewLabel">Message text (preview)</div>
      <pre className="chatPreviewBody">{prev}</pre>
    </div>
  );
}

function SensitiveKeywordsPanel({ request }: { request: RequestOut | null }) {
  const groups = piiGroupsFromRequest(request);
  return (
    <div className="keywordGroups">
      {groups.map((g) => {
        if (!g.values.length) return null;
        return (
          <div key={g.key} className="keywordGroup">
            <div className="keywordGroupTitle">
              {g.label} ({g.values.length})
            </div>
            <div className="keywordChips">
              {g.values.slice(0, 20).map((v: unknown, idx: number) => (
                <span key={`${g.key}-${idx}`} className="keywordChip">
                  {String(v)}
                </span>
              ))}
              {g.values.length > 20 ? (
                <span className="keywordChip keywordChipMore">
                  +{g.values.length - 20} more
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
      {groups.every((g) => !g.values.length) ? (
        <div className="keywordEmpty">No sensitive data detected.</div>
      ) : null}
    </div>
  );
}

/** Chat uses a direct “AutoFix” action; uploads use “Request AutoFix” (queue before upload). */
function reviewAutofixButtonLabel(requestKind: string | null | undefined) {
  return requestKind === "chat" ? "AutoFix" : "Request AutoFix";
}

function reviewAutofixButtonTitle(requestKind: string | null | undefined) {
  return requestKind === "chat"
    ? "Send this chat message to the AutoFix queue to sanitize sensitive text"
    : "Add this upload to the AutoFix queue for sanitization before the user can upload";
}

function SectionHeader({
  title,
  subtitle
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="sectionHeader">
      <div className="sectionTitle">{title}</div>
      {subtitle ? <div className="sectionSubtitle">{subtitle}</div> : null}
    </div>
  );
}

function ManagementTree({
  onNavigate
}: {
  onNavigate: (tab: TabKey) => void;
}) {
  const items: { label: string; tab: TabKey }[] = [
    { label: "Review Queue", tab: "review" },
    { label: "AutoFix Queue", tab: "autofix" },
    { label: "History", tab: "history" },
    { label: "Organizations", tab: "organizations" },
    { label: "Users", tab: "users" },
    { label: "Invites", tab: "invites" },
    { label: "Audit log", tab: "audit" }
  ];
  return (
    <div className="treeCard">
      <div className="treeTitle">Management</div>
      <div className="treeList">
        {items.map((it) => (
          <button
            key={it.label}
            className="treeNode"
            onClick={() => onNavigate(it.tab)}
            type="button"
          >
            <span className="treeBullet" aria-hidden="true">
              ●
            </span>
            <span className="treeText">{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function App() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("dashboard");
  const [counts, setCounts] = useState<CountsOut | null>(null);
  const [countsErr, setCountsErr] = useState<string | null>(null);

  const [reviewStatus, setReviewStatus] = useState<RequestStatus | "all">(
    "pending"
  );
  const [reviewItems, setReviewItems] = useState<RequestOut[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewErr, setReviewErr] = useState<string | null>(null);

  const [autofixItems, setAutofixItems] = useState<RequestOut[]>([]);
  const [autofixLoading, setAutofixLoading] = useState(false);
  const [autofixErr, setAutofixErr] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);

  // On small screens we hide the Pipeline sidebar by default and allow toggling it.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [selectedRequest, setSelectedRequest] =
    useState<RequestOut | null>(null);

  const [historyStatus, setHistoryStatus] = useState<
    RequestStatus | "all"
  >("all");
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyItems, setHistoryItems] = useState<RequestOut[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [usersItems, setUsersItems] = useState<UserOut[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersErr, setUsersErr] = useState<string | null>(null);
  const [usersOrgId, setUsersOrgId] = useState("default");
  const [usersQuery, setUsersQuery] = useState("");
  const [usersStatus, setUsersStatus] = useState<"all" | "active" | "suspended" | "revoked">("all");
  const [invitesFilterOrgId, setInvitesFilterOrgId] = useState("default");
  const [inviteModalOrgId, setInviteModalOrgId] = useState("default");
  const [inviteModalRole, setInviteModalRole] = useState<
    "employee" | "reviewer" | "org_admin"
  >("employee");
  const [inviteModalHours, setInviteModalHours] = useState("24");
  const [inviteModalCreatedBy, setInviteModalCreatedBy] = useState("admin");
  const [inviteCreateErr, setInviteCreateErr] = useState<string | null>(null);
  const [inviteCreateOk, setInviteCreateOk] = useState<string | null>(null);
  const [inviteCreateModalOpen, setInviteCreateModalOpen] = useState(false);
  const [inviteCreating, setInviteCreating] = useState(false);
  const [invitesItems, setInvitesItems] = useState<InviteOut[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [invitesErr, setInvitesErr] = useState<string | null>(null);

  const [orgsItems, setOrgsItems] = useState<OrgOut[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [orgsErr, setOrgsErr] = useState<string | null>(null);
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgId, setNewOrgId] = useState("");
  const [newOrgAdminEmail, setNewOrgAdminEmail] = useState("");
  const [orgCreating, setOrgCreating] = useState(false);

  const [auditItems, setAuditItems] = useState<AuditOut[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditErr, setAuditErr] = useState<string | null>(null);
  const [auditOrgFilter, setAuditOrgFilter] = useState("");
  const [auditActionFilter, setAuditActionFilter] = useState("");
  const [auditLimit, setAuditLimit] = useState(500);

  /** Used to show work email on request rows (merged with Users tab refreshes). */
  const [userDirectory, setUserDirectory] = useState<UserOut[]>([]);

  const invitePartitions = useMemo(
    () => partitionInvites(invitesItems),
    [invitesItems]
  );

  const [autofixModalRequestId, setAutofixModalRequestId] = useState<
    string | null
  >(null);
  const [autofixModalSanitizationType, setAutofixModalSanitizationType] =
    useState<SanitizationType>("data_masking");
  const [autofixModalReason, setAutofixModalReason] = useState("");

  const autofixModalRequest = useMemo(
    () =>
      autofixModalRequestId
        ? autofixItems.find((x) => x.requestId === autofixModalRequestId) ??
          null
        : null,
    [autofixModalRequestId, autofixItems]
  );

  const effectiveReviewStatus = useMemo(() => {
    return reviewStatus === "all" ? undefined : reviewStatus;
  }, [reviewStatus]);

  const userEmailById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of userDirectory) {
      if (u.userId) m.set(u.userId, u.email);
    }
    for (const u of usersItems) {
      if (u.userId) m.set(u.userId, u.email);
    }
    return m;
  }, [userDirectory, usersItems]);

  useEffect(() => {
    let cancelled = false;
    listUsers(undefined, undefined)
      .then((rows) => {
        if (!cancelled) setUserDirectory(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshCounts() {
    try {
      setCountsErr(null);
      const c = await getCounts();
      setCounts(c);
    } catch (e: any) {
      setCountsErr(e?.message || String(e));
    }
  }

  async function refreshReview() {
    setReviewLoading(true);
    setReviewErr(null);
    try {
      const data = await listRequestsWithAutofix({
        status: effectiveReviewStatus,
        autofixStatus: "none",
        limit: 200
      });
      setReviewItems(data);
    } catch (e: any) {
      setReviewErr(e?.message || String(e));
    } finally {
      setReviewLoading(false);
    }
  }

  async function refreshAutofixQueue() {
    setAutofixLoading(true);
    setAutofixErr(null);
    try {
      const data = await listRequestsWithAutofix({
        autofixStatus: "requested",
        limit: 200
      });
      setAutofixItems(data);
    } catch (e: any) {
      setAutofixErr(e?.message || String(e));
    } finally {
      setAutofixLoading(false);
    }
  }

  useEffect(() => {
    refreshCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === "review") refreshReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, effectiveReviewStatus]);

  useEffect(() => {
    if (tab === "autofix") refreshAutofixQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function refreshHistory() {
    setHistoryLoading(true);
    setHistoryErr(null);
    try {
      const data = await listRequests(
        historyStatus === "all" ? undefined : historyStatus
      );
      const q = historyQuery.trim().toLowerCase();
      const filtered = q
        ? data.filter((r) => {
            const fn = (r.fileName || "").toLowerCase();
            const id = (r.employeeId || "").toLowerCase();
            const org = (r.orgId || "").toLowerCase();
            const mail = (
              userEmailById.get(String(r.employeeId || "").trim()) || ""
            ).toLowerCase();
            return (
              fn.includes(q) ||
              id.includes(q) ||
              org.includes(q) ||
              mail.includes(q)
            );
          })
        : data;
      setHistoryItems(filtered);
    } catch (e: any) {
      setHistoryErr(e?.message || String(e));
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    if (tab === "history") refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, historyStatus, historyQuery, userEmailById]);

  async function refreshUsers() {
    setUsersLoading(true);
    setUsersErr(null);
    try {
      const data = await listUsers(
        usersOrgId || undefined,
        usersStatus === "all" ? undefined : usersStatus
      );
      setUsersItems(data);
      setUserDirectory((prev) => {
        const byId = new Map(prev.map((u) => [u.userId, u]));
        for (const u of data) {
          byId.set(u.userId, u);
        }
        return Array.from(byId.values());
      });
    } catch (e: any) {
      setUsersErr(e?.message || String(e));
    } finally {
      setUsersLoading(false);
    }
  }

  async function refreshInvites() {
    setInvitesLoading(true);
    setInvitesErr(null);
    try {
      const data = await listInvites(invitesFilterOrgId || undefined, true);
      setInvitesItems(data);
    } catch (e: any) {
      setInvitesErr(e?.message || String(e));
    } finally {
      setInvitesLoading(false);
    }
  }

  useEffect(() => {
    if (tab === "users") refreshUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, usersOrgId, usersStatus]);

  useEffect(() => {
    if (tab === "invites") refreshInvites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, invitesFilterOrgId]);

  async function refreshOrgs() {
    setOrgsLoading(true);
    setOrgsErr(null);
    try {
      const data = await listOrgs();
      setOrgsItems(data);
    } catch (e: any) {
      setOrgsErr(e?.message || String(e));
    } finally {
      setOrgsLoading(false);
    }
  }

  async function submitCreateOrg() {
    const name = newOrgName.trim();
    if (!name) {
      alert("Organization name is required.");
      return;
    }
    setOrgCreating(true);
    try {
      await createOrg({
        name,
        orgId: newOrgId.trim() || undefined,
        adminEmail: newOrgAdminEmail.trim() || undefined
      });
      setNewOrgName("");
      setNewOrgId("");
      setNewOrgAdminEmail("");
      await refreshOrgs();
    } catch (e: any) {
      alert(e?.message || String(e));
    } finally {
      setOrgCreating(false);
    }
  }

  async function refreshAudit() {
    setAuditLoading(true);
    setAuditErr(null);
    try {
      const data = await listAudit({
        orgId: auditOrgFilter.trim() || undefined,
        action: auditActionFilter.trim() || undefined,
        limit: auditLimit
      });
      setAuditItems(data);
    } catch (e: any) {
      setAuditErr(e?.message || String(e));
    } finally {
      setAuditLoading(false);
    }
  }

  useEffect(() => {
    if (tab === "organizations") refreshOrgs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (tab === "audit") refreshAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, auditLimit]);

  async function approve(id: string): Promise<boolean> {
    setBusyId(id);
    try {
      await decideRequest(id, "approved");
      await refreshCounts();
      await refreshReview();
      await refreshAutofixQueue();
      return true;
    } catch (e: any) {
      alert(e?.message || String(e));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function block(id: string): Promise<boolean> {
    setBusyId(id);
    try {
      const reason = prompt("Reason (optional):") || undefined;
      await decideRequest(id, "blocked", reason);
      await refreshCounts();
      await refreshReview();
      return true;
    } catch (e: any) {
      alert(e?.message || String(e));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function doAutofixRequest(id: string): Promise<boolean> {
    setBusyId(id);
    try {
      await requestAutofix(id);
      await refreshCounts();
      await refreshAutofixQueue();
      await refreshReview();
      return true;
    } catch (e: any) {
      alert(e?.message || String(e));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  function openAutofixModal(id: string) {
    setAutofixModalRequestId(id);
    setAutofixModalSanitizationType("data_masking");
    setAutofixModalReason("");
  }

  function closeAutofixModal() {
    setAutofixModalRequestId(null);
  }

  async function confirmAutofixComplete() {
    const id = autofixModalRequestId;
    if (!id) return;
    setBusyId(id);
    closeAutofixModal();
    try {
      await completeAutofix(
        id,
        "fixed",
        autofixModalReason.trim() || undefined,
        autofixModalSanitizationType
      );
      await refreshCounts();
      await refreshAutofixQueue();
      await refreshReview();
    } catch (e: any) {
      alert(e?.message || String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function changeUserStatus(userId: string, status: "active" | "suspended" | "revoked") {
    setBusyId(userId);
    try {
      await updateUserStatus(userId, status);
      await refreshUsers();
    } catch (e: any) {
      alert(e?.message || String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function changeUserRole(userId: string, role: "employee" | "reviewer" | "org_admin") {
    setBusyId(userId);
    try {
      await updateUserRole(userId, role);
      await refreshUsers();
    } catch (e: any) {
      alert(e?.message || String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function removeUserConnection(userId: string, email: string) {
    const ok = window.confirm(
      `Remove "${email}" from the organization?\n\nThis deletes their user record. Their browser extension will get "Unknown user" until they complete onboarding again with a new invite.`
    );
    if (!ok) return;
    setBusyId(userId);
    try {
      await deleteUser(userId);
      setUserDirectory((prev) => prev.filter((u) => u.userId !== userId));
      await refreshUsers();
    } catch (e: any) {
      alert(e?.message || String(e));
    } finally {
      setBusyId(null);
    }
  }

  function openInviteCreateModal() {
    setInviteCreateErr(null);
    setInviteModalOrgId((invitesFilterOrgId || "").trim() || "default");
    setInviteCreateModalOpen(true);
  }

  function closeInviteCreateModal() {
    setInviteCreateModalOpen(false);
    setInviteCreating(false);
  }

  async function submitInviteCreate() {
    setInviteCreateErr(null);
    setInviteCreateOk(null);
    const org = String(inviteModalOrgId || "").trim();
    if (!org) {
      setInviteCreateErr("Organization ID is required.");
      return;
    }
    setInviteCreating(true);
    try {
      const h = Number(inviteModalHours || "24");
      const out = await createInvite({
        orgId: org,
        role: inviteModalRole,
        expiresInHours: Number.isFinite(h) && h > 0 ? h : 24,
        createdBy: String(inviteModalCreatedBy || "").trim() || "admin"
      });
      setInviteCreateOk(`Invite created: ${out.inviteCode}`);
      setInvitesFilterOrgId(org);
      closeInviteCreateModal();
      await refreshInvites();
    } catch (e: any) {
      setInviteCreateErr(e?.message || String(e));
    } finally {
      setInviteCreating(false);
    }
  }

  async function revokeInviteNow(inviteCode: string) {
    setBusyId(inviteCode);
    try {
      await revokeInvite(inviteCode, "admin");
      await refreshInvites();
    } catch (e: any) {
      alert(e?.message || String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function copyInviteCode(inviteCode: string) {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteCode);
      } else {
        const tmp = document.createElement("textarea");
        tmp.value = inviteCode;
        document.body.appendChild(tmp);
        tmp.select();
        document.execCommand("copy");
        tmp.remove();
      }
      setInviteCreateOk(`Copied: ${inviteCode}`);
    } catch (e: any) {
      setInviteCreateErr(e?.message || "Failed to copy invite code");
    }
  }

  const dashboardCards = useMemo(() => {
    const c = counts;
    return {
      scanned: c?.total ?? 0,
      blocked: c?.blocked ?? 0,
      approved: c?.approved ?? 0,
      autofixRequested: c?.autofixRequested ?? 0
    };
  }, [counts]);

  return (
    <div className="adminLayout">
      <div className="adminTop">
        <div className="adminTopBar">
          <div className="adminTopLeft">
            <div className="adminBrand">
              <div className="adminBrandTitle">AI Upload Guardian</div>
              <div className="adminBrandSub">Admin panel</div>
            </div>
          </div>

          <nav className="adminNavMain" aria-label="Main sections">
            <button
              className={`navBtn ${tab === "dashboard" ? "navBtnActive" : ""}`}
              onClick={() => setTab("dashboard")}
              type="button"
            >
              Dashboard
            </button>
            <button
              className={`navBtn ${tab === "review" ? "navBtnActive" : ""}`}
              onClick={() => setTab("review")}
              type="button"
            >
              Review
            </button>
            <button
              className={`navBtn ${tab === "autofix" ? "navBtnActive" : ""}`}
              onClick={() => setTab("autofix")}
              type="button"
            >
              AutoFix
            </button>
            <button
              className={`navBtn ${tab === "history" ? "navBtnActive" : ""}`}
              onClick={() => setTab("history")}
              type="button"
            >
              History
            </button>
          </nav>

          <div className="adminTopRight">
            <a
              className="topReleaseLinkBtn"
              href={EXTENSION_RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Extension Release
            </a>
            <button
              className="sidebarToggle"
              onClick={() => setSidebarOpen((v) => !v)}
              type="button"
            >
              {sidebarOpen ? "Hide Management" : "Show Management"}
            </button>
            <button
              type="button"
              className="adminLogoutCorner"
              onClick={() => {
                clearPanelToken();
                navigate("/login", { replace: true });
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>

      <div className="adminBody">
        <div className={`adminSidebar ${sidebarOpen ? "sidebarOpen" : ""}`}>
          <ManagementTree onNavigate={(next) => setTab(next)} />

          <div className="treeCard">
            <div className="treeTitle">Team Status</div>
            <div className="statusGrid">
              <div className="statusPill">
                <div className="statusValue">{dashboardCards.scanned}</div>
                <div className="statusLabel">Scanned</div>
              </div>
              <div className="statusPill statusPillBlocked">
                <div className="statusValue">{dashboardCards.blocked}</div>
                <div className="statusLabel">Blocked</div>
              </div>
              <div className="statusPill statusPillApproved">
                <div className="statusValue">{dashboardCards.approved}</div>
                <div className="statusLabel">Approved</div>
              </div>
              <div className="statusPill statusPillAutofix">
                <div className="statusValue">{dashboardCards.autofixRequested}</div>
                <div className="statusLabel">AutoFix Requested</div>
              </div>
            </div>

            <div className="stepNote">
              Create orgs in <span className="stepStrong">Organizations</span>, then use{" "}
              <span className="stepStrong">Users</span>, <span className="stepStrong">Invites</span>, and{" "}
              <span className="stepStrong">Audit</span> for compliance.
            </div>
          </div>
        </div>

        <div className="adminContent">
          {tab === "dashboard" ? (
            <div className="contentCard">
              <SectionHeader
                title="GenAI Governance Command Center"
                subtitle="Overview, pipeline progress, and quick stats."
              />

              {countsErr ? <div className="error">{countsErr}</div> : null}

              <div className="dashGrid">
                <div className="dashTile">
                  <div className="dashTileTitle">Total Files Scanned</div>
                  <div className="dashTileValue">{dashboardCards.scanned}</div>
                </div>
                <div className="dashTile dashTileBlocked">
                  <div className="dashTileTitle">Blocked for AI Use</div>
                  <div className="dashTileValue">{dashboardCards.blocked}</div>
                </div>
                <div className="dashTile dashTileApproved">
                  <div className="dashTileTitle">Approved for AI Use</div>
                  <div className="dashTileValue">{dashboardCards.approved}</div>
                </div>
                <div className="dashTile dashTileAutofix">
                  <div className="dashTileTitle">AutoFix Queue</div>
                  <div className="dashTileValue">{dashboardCards.autofixRequested}</div>
                </div>
              </div>

              <div className="dashHint">
                Use the left tree to navigate pipeline steps, then open <b>Review</b> or{" "}
                <b>AutoFix</b> to take actions.
              </div>

              <div className="adminManualCard">
                <div className="adminManualTitle">Admin Manual (Quick Start)</div>
                <ol className="adminManualList">
                  <li>
                    Create an org in <b>Organizations</b> and verify it appears in the list.
                  </li>
                  <li>
                    Go to <b>Invites</b>, choose org/role, create an invite, then share the code with users.
                  </li>
                  <li>
                    Ask users to open extension popup, enter email + invite code, and click Connect.
                  </li>
                  <li>
                    Use <b>Review</b> to approve/block pending uploads and chat requests.
                  </li>
                  <li>
                    Use <b>AutoFix</b> to sanitize queued content and complete requests.
                  </li>
                  <li>
                    Use <b>Users</b> to suspend/revoke access and <b>Audit</b> for compliance trails.
                  </li>
                </ol>
              </div>
            </div>
          ) : null}

          {tab === "review" ? (
            <div className="contentCard">
              <SectionHeader
                title="Review Section"
                subtitle="Approve, block, or send to AutoFix for pending file uploads and chat send requests."
              />

              <div className="reviewControls">
                <label className="reviewLabel">
                  Filter:
                  <select
                    className="select"
                    value={reviewStatus}
                    onChange={(e) => setReviewStatus(e.target.value as any)}
                  >
                    <option value="pending">Pending</option>
                    <option value="approved">Approved</option>
                    <option value="blocked">Blocked</option>
                    <option value="all">All</option>
                  </select>
                </label>
                <button
                  className="btn"
                  onClick={refreshReview}
                  disabled={reviewLoading}
                  type="button"
                >
                  Refresh
                </button>
              </div>

              {reviewErr ? <div className="error">{reviewErr}</div> : null}

              <div className="table table-review">
                <div className="row row-head">
                  <div>Item</div>
                  <div>User</div>
                  <div>Host</div>
                  <div>Risk</div>
                  <div>Status</div>
                  <div>Created</div>
                  <div>Actions</div>
                </div>
                {reviewItems.map((r) => {
                  const who = requestUserLabelParts(r, userEmailById);
                  return (
                  <div key={r.requestId} className="row">
                    <div className="file">
                      <div className="file-name-row">
                        {r.requestKind === "chat" ? (
                          <span className="requestKindPill requestKindPillChat">Chat</span>
                        ) : (
                          <span className="requestKindPill requestKindPillUpload">Upload</span>
                        )}
                        <span className="file-name">{r.fileName}</span>
                      </div>
                      <div className="file-sub">{r.fileType || "unknown type"}</div>
                    </div>
                    <div className="user-cell">
                      <div className="file-name">{who.line1}</div>
                      {who.line2 ? (
                        <div className="file-sub">{who.line2}</div>
                      ) : null}
                    </div>
                    <div className="muted">{r.host}</div>
                    <div className="risk">{r.riskScore}</div>
                    <div>
                      <span className={badgeClass(r.status)}>{r.status}</span>
                    </div>
                    <div className="muted">{fmtTime(r.createdAt)}</div>
                    <div className="btns">
                      <button
                        className="btn btn-green"
                        disabled={busyId === r.requestId || r.status !== "pending"}
                        onClick={() => void approve(r.requestId)}
                        type="button"
                      >
                        Approve
                      </button>
                      <button
                        className="btn btn-red"
                        disabled={busyId === r.requestId || r.status !== "pending"}
                        onClick={() => void block(r.requestId)}
                        type="button"
                      >
                        Block
                      </button>
                      <button
                        className="btn btn-blue"
                        disabled={
                          busyId === r.requestId || r.autofixStatus === "requested"
                        }
                        onClick={() => void doAutofixRequest(r.requestId)}
                        type="button"
                        title={reviewAutofixButtonTitle(r.requestKind)}
                      >
                        {reviewAutofixButtonLabel(r.requestKind)}
                      </button>
                      <button
                        className="btn btn-pii"
                        disabled={busyId === r.requestId}
                        onClick={() => setSelectedRequest(r)}
                        type="button"
                        title="View sensitive data detected"
                      >
                        Sensitive Data Detected
                      </button>
                    </div>
                  </div>
                );
                })}
                {!reviewLoading && reviewItems.length === 0 ? (
                  <div className="empty">No requests found.</div>
                ) : null}
              </div>
            </div>
          ) : null}

          {tab === "autofix" ? (
            <div className="contentCard">
              <SectionHeader
                title="AutoFix Related Work"
                subtitle="Review sensitive keywords, choose a sanitization mode, then apply AutoFix to complete the queue item."
              />

              {autofixErr ? <div className="error">{autofixErr}</div> : null}

              <div className="table table-autofix">
                <div className="row row-head">
                  <div>Item</div>
                  <div>User</div>
                  <div>Host</div>
                  <div>Risk</div>
                  <div>AutoFix</div>
                  <div>Created</div>
                  <div>Actions</div>
                </div>
                {autofixItems.map((r) => {
                  const who = requestUserLabelParts(r, userEmailById);
                  return (
                  <div key={r.requestId} className="row">
                    <div className="file">
                      <div className="file-name-row">
                        {r.requestKind === "chat" ? (
                          <span className="requestKindPill requestKindPillChat">Chat</span>
                        ) : (
                          <span className="requestKindPill requestKindPillUpload">Upload</span>
                        )}
                        <span className="file-name">{r.fileName}</span>
                      </div>
                      <div className="file-sub">{r.fileType || "unknown type"}</div>
                    </div>
                    <div className="user-cell">
                      <div className="file-name">{who.line1}</div>
                      {who.line2 ? (
                        <div className="file-sub">{who.line2}</div>
                      ) : null}
                    </div>
                    <div className="muted">{r.host}</div>
                    <div className="risk">{r.riskScore}</div>
                    <div>
                      <span className="badge badge-amber">{r.autofixStatus}</span>
                    </div>
                    <div className="muted">{fmtTime(r.createdAt)}</div>
                    <div className="btns">
                      <button
                        className="btn btn-pii"
                        disabled={busyId === r.requestId}
                        onClick={() => setSelectedRequest(r)}
                        type="button"
                        title="View sensitive keywords and categories detected"
                      >
                        Sensitive keywords
                      </button>
                      <button
                        className="btn btn-green"
                        disabled={busyId === r.requestId || r.autofixStatus !== "requested"}
                        onClick={() => openAutofixModal(r.requestId)}
                        type="button"
                      >
                        Apply AutoFix
                      </button>
                    </div>
                  </div>
                );
                })}
                {!autofixLoading && autofixItems.length === 0 ? (
                  <div className="empty">AutoFix queue is empty.</div>
                ) : null}
              </div>

              <div className="autofixHint">
                If AutoFix isn’t requested yet, use the Review section and later we can wire the “Request to Upload” flow to auto-fill this queue.
              </div>
            </div>
          ) : null}

          {tab === "history" ? (
            <div className="contentCard">
              <SectionHeader
                title="History"
                subtitle="All requests with decisions (for audit)."
              />

              <div className="historyControls">
                <label className="reviewLabel">
                  Status:
                  <select
                    className="select"
                    value={historyStatus}
                    onChange={(e) =>
                      setHistoryStatus(e.target.value as any)
                    }
                  >
                    <option value="all">All</option>
                    <option value="pending">Pending</option>
                    <option value="approved">Approved</option>
                    <option value="blocked">Blocked</option>
                  </select>
                </label>

                <input
                  className="historyInput"
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  placeholder="Search by file name…"
                />

                <button
                  className="btn"
                  onClick={refreshHistory}
                  disabled={historyLoading}
                  type="button"
                >
                  Refresh
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={historyLoading}
                  onClick={async () => {
                    try {
                      await downloadRequestHistoryCsv({
                        status: historyStatus,
                        limit: 8000
                      });
                    } catch (e: any) {
                      alert(e?.message || String(e));
                    }
                  }}
                >
                  Download CSV
                </button>
              </div>

              {historyErr ? <div className="error">{historyErr}</div> : null}

              <div className="table historyTable table-history">
                <div className="row row-head">
                  <div>File</div>
                  <div>User</div>
                  <div>Host</div>
                  <div>Risk</div>
                  <div>Status</div>
                  <div>Sensitive Data Detected</div>
                  <div>Created</div>
                  <div>Decided</div>
                </div>
                {historyItems.map((r) => {
                  const who = requestUserLabelParts(r, userEmailById);
                  return (
                  <div key={r.requestId} className="row">
                    <div className="file">
                      <div className="file-name">{r.fileName}</div>
                      <div className="file-sub">{r.fileType || "unknown type"}</div>
                    </div>
                    <div className="user-cell">
                      <div className="file-name">{who.line1}</div>
                      {who.line2 ? (
                        <div className="file-sub">{who.line2}</div>
                      ) : null}
                    </div>
                    <div className="muted">{r.host}</div>
                    <div className="risk">{r.riskScore}</div>
                    <div>
                      <span className={badgeClass(r.status)}>{r.status}</span>
                    </div>
                    <div className="historyPiiCell">
                      <button
                        className="btn btn-pii"
                        disabled={busyId === r.requestId}
                        onClick={() => setSelectedRequest(r)}
                        type="button"
                        title="View sensitive data detected"
                      >
                        Sensitive Data Detected
                      </button>
                    </div>
                    <div className="muted">{fmtTime(r.createdAt)}</div>
                    <div className="muted">
                      {r.decidedAt ? fmtTime(r.decidedAt) : "-"}
                    </div>
                  </div>
                );
                })}

                {!historyLoading && historyItems.length === 0 ? (
                  <div className="empty">
                    No history items found.
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {tab === "users" ? (
            <div className="contentCard">
              <SectionHeader
                title="Users"
                subtitle="Identify and manage access. Use Remove connection to delete a user so their extension must onboard again."
              />
              <div className="historyControls">
                <input
                  className="historyInput"
                  value={usersOrgId}
                  onChange={(e) => setUsersOrgId(e.target.value)}
                  placeholder="org id (e.g. default)"
                />
                <input
                  className="historyInput"
                  value={usersQuery}
                  onChange={(e) => setUsersQuery(e.target.value)}
                  placeholder="search email or user id"
                />
                <select
                  className="select"
                  value={usersStatus}
                  onChange={(e) => setUsersStatus(e.target.value as any)}
                >
                  <option value="all">all</option>
                  <option value="active">active</option>
                  <option value="suspended">suspended</option>
                  <option value="revoked">revoked</option>
                </select>
                <button className="btn" onClick={refreshUsers} disabled={usersLoading} type="button">
                  Refresh
                </button>
              </div>
              {usersErr ? <div className="error">{usersErr}</div> : null}
              <div className="table table-users">
                <div className="row row-head">
                  <div>Email</div>
                  <div>Organization</div>
                  <div>User ID</div>
                  <div>Role</div>
                  <div>Status</div>
                  <div>Last Seen</div>
                  <div>Actions</div>
                </div>
                {usersItems
                  .filter((u) => {
                    const q = usersQuery.trim().toLowerCase();
                    if (!q) return true;
                    return (
                      (u.email || "").toLowerCase().includes(q) ||
                      (u.userId || "").toLowerCase().includes(q) ||
                      (u.orgId || "").toLowerCase().includes(q)
                    );
                  })
                  .map((u) => (
                  <div key={u.userId} className="row">
                    <div className="file-name">{u.email}</div>
                    <div className="muted">{u.orgId || "—"}</div>
                    <div className="muted">{u.userId}</div>
                    <div>
                      <select
                        className="select"
                        value={u.role}
                        onChange={(e) =>
                          changeUserRole(
                            u.userId,
                            e.target.value as "employee" | "reviewer" | "org_admin"
                          )
                        }
                        disabled={busyId === u.userId}
                      >
                        <option value="employee">employee</option>
                        <option value="reviewer">reviewer</option>
                        <option value="org_admin">org_admin</option>
                      </select>
                    </div>
                    <div className="muted">{u.status}</div>
                    <div className="muted">{fmtTime(u.lastSeenAt)}</div>
                    <div className="btns">
                      <button
                        className="btn btn-red"
                        disabled={busyId === u.userId}
                        onClick={() =>
                          changeUserStatus(
                            u.userId,
                            u.status === "suspended" ? "active" : "suspended"
                          )
                        }
                        type="button"
                      >
                        {u.status === "suspended" ? "Activate" : "Suspend"}
                      </button>
                      <button
                        className="btn btn-red"
                        disabled={busyId === u.userId}
                        onClick={() => removeUserConnection(u.userId, u.email)}
                        type="button"
                        title="Permanently delete this user; extension must reconnect with a new invite"
                      >
                        Remove connection
                      </button>
                    </div>
                  </div>
                ))}
                {!usersLoading && usersItems.length === 0 ? (
                  <div className="empty">No users found.</div>
                ) : null}
              </div>
            </div>
          ) : null}

          {tab === "invites" ? (
            <div className="contentCard">
              <SectionHeader
                title="Invites"
                subtitle="Create and track onboarding invite codes."
              />
              <div className="inviteToolbar">
                <div className="inviteToolbarField">
                  <label className="inviteFieldLabel" htmlFor="invitesListOrgId">
                    Organization (list filter)
                  </label>
                  <input
                    id="invitesListOrgId"
                    className="historyInput inviteToolbarInput"
                    value={invitesFilterOrgId}
                    onChange={(e) => setInvitesFilterOrgId(e.target.value)}
                    placeholder="e.g. default"
                    autoComplete="off"
                  />
                </div>
                <div className="inviteToolbarActions">
                  <button
                    className="btn"
                    onClick={refreshInvites}
                    disabled={invitesLoading}
                    type="button"
                  >
                    Refresh
                  </button>
                  <button
                    className="btn btn-green"
                    onClick={openInviteCreateModal}
                    type="button"
                  >
                    Create invite
                  </button>
                </div>
              </div>
              {inviteCreateOk ? <div className="dashHint">{inviteCreateOk}</div> : null}
              {invitesErr ? <div className="error">{invitesErr}</div> : null}
              <div className="table table-invites">
                <div className="row row-head">
                  <div>Invite Code</div>
                  <div>Role</div>
                  <div>Created By</div>
                  <div>Created</div>
                  <div>Expires</div>
                  <div>Used By</div>
                  <div>Actions</div>
                </div>
                {invitePartitions.active.length > 0 ? (
                  <>
                    <div className="inviteSectionLabel">Active — usable now</div>
                    {invitePartitions.active.map((iv) => (
                      <div key={iv.inviteCode} className="row">
                        <div className="file-name">{iv.inviteCode}</div>
                        <div className="muted">{iv.role}</div>
                        <div className="muted">{iv.createdBy}</div>
                        <div className="muted">{fmtTime(iv.createdAt)}</div>
                        <div className="muted">{fmtTime(iv.expiresAt)}</div>
                        <div className="muted">{formatInviteUsedBy(iv)}</div>
                        <div className="btns">
                          <button
                            className="btn"
                            onClick={() => copyInviteCode(iv.inviteCode)}
                            type="button"
                          >
                            Copy
                          </button>
                          <button
                            className="btn btn-red"
                            disabled={!!iv.usedAt || busyId === iv.inviteCode}
                            onClick={() => revokeInviteNow(iv.inviteCode)}
                            type="button"
                          >
                            Revoke
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                ) : !invitesLoading && invitesItems.length > 0 ? (
                  <>
                    <div className="inviteSectionLabel">Active — usable now</div>
                    <div className="empty">
                      No active invites — all are used, revoked, or expired.
                    </div>
                  </>
                ) : null}
                {invitePartitions.inactive.length > 0 ? (
                  <>
                    <div className="inviteSectionLabel inviteSectionLabelInactive">
                      Inactive — used, revoked, or expired
                    </div>
                    {invitePartitions.inactive.map((iv) => (
                      <div key={iv.inviteCode} className="row row-inactive">
                        <div className="file-name">{iv.inviteCode}</div>
                        <div className="muted">{iv.role}</div>
                        <div className="muted">{iv.createdBy}</div>
                        <div className="muted">{fmtTime(iv.createdAt)}</div>
                        <div className="muted">{fmtTime(iv.expiresAt)}</div>
                        <div className="muted">{formatInviteUsedBy(iv)}</div>
                        <div className="btns">
                          <button
                            className="btn"
                            onClick={() => copyInviteCode(iv.inviteCode)}
                            type="button"
                          >
                            Copy
                          </button>
                          <button
                            className="btn btn-red"
                            disabled={!!iv.usedAt || busyId === iv.inviteCode}
                            onClick={() => revokeInviteNow(iv.inviteCode)}
                            type="button"
                          >
                            Revoke
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                ) : null}
                {!invitesLoading && invitesItems.length === 0 ? (
                  <div className="empty">No invites found.</div>
                ) : null}
              </div>
            </div>
          ) : null}

          {tab === "organizations" ? (
            <div className="contentCard">
              <SectionHeader
                title="Organizations"
                subtitle="Create pilot orgs, then issue invites scoped to an organization ID."
              />
              <div className="historyControls" style={{ flexWrap: "wrap" }}>
                <input
                  className="historyInput"
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  placeholder="Organization display name (required)"
                />
                <input
                  className="historyInput"
                  value={newOrgId}
                  onChange={(e) => setNewOrgId(e.target.value)}
                  placeholder="Custom org id (optional — auto if empty)"
                />
                <input
                  className="historyInput"
                  value={newOrgAdminEmail}
                  onChange={(e) => setNewOrgAdminEmail(e.target.value)}
                  placeholder="Bootstrap org_admin email (optional)"
                />
                <button
                  className="btn btn-green"
                  type="button"
                  disabled={orgCreating}
                  onClick={() => void submitCreateOrg()}
                >
                  Create organization
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={orgsLoading}
                  onClick={() => void refreshOrgs()}
                >
                  Refresh list
                </button>
              </div>
              {orgsErr ? <div className="error">{orgsErr}</div> : null}
              <div className="table table-orgs">
                <div className="row row-head">
                  <div>Org ID</div>
                  <div>Name</div>
                  <div>Created</div>
                </div>
                {orgsItems.map((o) => (
                  <div key={o.orgId} className="row">
                    <div className="file-name">{o.orgId}</div>
                    <div className="muted">{o.name}</div>
                    <div className="muted">{fmtTime(o.createdAt)}</div>
                  </div>
                ))}
                {!orgsLoading && orgsItems.length === 0 ? (
                  <div className="empty">No organizations yet.</div>
                ) : null}
              </div>
            </div>
          ) : null}

          {tab === "audit" ? (
            <div className="contentCard">
              <SectionHeader
                title="Audit log"
                subtitle="Admin and system actions. Export CSV for reviewers (no raw upload content)."
              />
              <div className="historyControls" style={{ flexWrap: "wrap" }}>
                <input
                  className="historyInput"
                  value={auditOrgFilter}
                  onChange={(e) => setAuditOrgFilter(e.target.value)}
                  placeholder="Filter by org id (optional)"
                />
                <input
                  className="historyInput"
                  value={auditActionFilter}
                  onChange={(e) => setAuditActionFilter(e.target.value)}
                  placeholder="Filter by action e.g. user.delete (optional)"
                />
                <label className="reviewLabel">
                  Rows:
                  <select
                    className="select"
                    value={auditLimit}
                    onChange={(e) => setAuditLimit(Number(e.target.value))}
                  >
                    <option value={200}>200</option>
                    <option value={500}>500</option>
                    <option value={1000}>1000</option>
                  </select>
                </label>
                <button
                  className="btn"
                  type="button"
                  disabled={auditLoading}
                  onClick={() => void refreshAudit()}
                >
                  Refresh
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={auditLoading}
                  onClick={async () => {
                    try {
                      await downloadAuditCsv({
                        orgId: auditOrgFilter.trim() || undefined,
                        action: auditActionFilter.trim() || undefined,
                        limit: 10000
                      });
                    } catch (e: any) {
                      alert(e?.message || String(e));
                    }
                  }}
                >
                  Download audit CSV
                </button>
              </div>
              {auditErr ? <div className="error">{auditErr}</div> : null}
              <div className="table table-audit">
                <div className="row row-head">
                  <div>Time</div>
                  <div>Org</div>
                  <div>Action</div>
                  <div>Actor</div>
                  <div>Target</div>
                  <div>Details</div>
                </div>
                {auditItems.map((a) => (
                  <div key={a.id} className="row">
                    <div className="muted">{fmtTime(a.createdAt)}</div>
                    <div className="muted">{a.orgId}</div>
                    <div className="file-name">{a.action}</div>
                    <div className="muted">
                      {a.actorEmail || a.actorUserId || "—"}
                    </div>
                    <div className="muted">
                      {a.targetType}: {a.targetId}
                    </div>
                    <div className="file-sub auditDetailsCell">
                      {auditDetailsPreview(
                        a.details as Record<string, unknown> | null | undefined
                      )}
                    </div>
                  </div>
                ))}
                {!auditLoading && auditItems.length === 0 ? (
                  <div className="empty">No audit entries match the current filters.</div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {selectedRequest ? (
        <div
          className="modalOverlay"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSelectedRequest(null);
          }}
        >
          <div className="keywordModal">
            <div className="keywordHead">
              <div>
                <div className="keywordTitle">
                  {selectedRequest.requestKind === "chat"
                    ? selectedRequest.status === "blocked"
                      ? "Chat send blocked"
                      : selectedRequest.status === "approved"
                        ? "Chat send approved"
                        : "Chat send request"
                    : selectedRequest.status === "blocked"
                      ? "Upload blocked"
                      : selectedRequest.status === "approved"
                        ? "Upload approved"
                        : "Upload request"}
                </div>
                <div className="keywordSub">
                  {selectedRequest.fileName} • Host: {selectedRequest.host}
                  {(() => {
                    const who = requestUserLabelParts(
                      selectedRequest,
                      userEmailById
                    );
                    if (who.line1 === "—") return null;
                    return (
                      <>
                        <br />
                        User: {who.line1}
                        {who.line2 ? ` (${who.line2})` : ""}
                      </>
                    );
                  })()}
                </div>
              </div>
              <button
                className="keywordClose"
                onClick={() => setSelectedRequest(null)}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="keywordBody">
              <div className="keywordRisk">
                Risk Score: <b>{selectedRequest.riskScore}</b>
              </div>

              <ChatMessagePreview request={selectedRequest} />

              <SensitiveKeywordsPanel request={selectedRequest} />
            </div>

            {selectedRequest.status === "pending" ? (
              <div className="keywordModalFooter">
                <button
                  className="btn btn-green"
                  type="button"
                  disabled={busyId === selectedRequest.requestId}
                  onClick={async () => {
                    const id = selectedRequest.requestId;
                    if (await approve(id)) setSelectedRequest(null);
                  }}
                >
                  Approve
                </button>
                <button
                  className="btn btn-red"
                  type="button"
                  disabled={busyId === selectedRequest.requestId}
                  onClick={async () => {
                    const id = selectedRequest.requestId;
                    if (await block(id)) setSelectedRequest(null);
                  }}
                >
                  Block
                </button>
                <button
                  className="btn btn-blue"
                  type="button"
                  disabled={
                    busyId === selectedRequest.requestId ||
                    selectedRequest.autofixStatus === "requested"
                  }
                  title={reviewAutofixButtonTitle(selectedRequest.requestKind)}
                  onClick={async () => {
                    const id = selectedRequest.requestId;
                    if (await doAutofixRequest(id)) setSelectedRequest(null);
                  }}
                >
                  {reviewAutofixButtonLabel(selectedRequest.requestKind)}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {autofixModalRequestId ? (
        <div
          className="modalOverlay"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeAutofixModal();
          }}
        >
          <div className="sanitizationModal">
            <div className="keywordHead">
              <div>
                <div className="keywordTitle">Apply AutoFix</div>
                <div className="keywordSub">
                  {autofixModalRequest ? (
                    <>
                      {autofixModalRequest.fileName} • Risk{" "}
                      <b>{autofixModalRequest.riskScore}</b>
                    </>
                  ) : (
                    "Choose how sensitive data should be replaced, then apply."
                  )}
                </div>
              </div>
              <button
                className="keywordClose"
                onClick={closeAutofixModal}
                type="button"
              >
                Cancel
              </button>
            </div>

            <div className="keywordBody">
              <ChatMessagePreview request={autofixModalRequest} />
              <div className="autofixModalSectionTitle">Sensitive keywords detected</div>
              <SensitiveKeywordsPanel request={autofixModalRequest} />

              <div className="autofixModalSectionTitle">Sanitization mode</div>
              <div className="sanitizationOptions">
                {(
                  [
                    {
                      value: "pseudonymization" as SanitizationType,
                      label: "Pseudonymization",
                      desc: "Replace identity data with consistent fake values (e.g. user001@domain.com)"
                    },
                    {
                      value: "tokenization" as SanitizationType,
                      label: "Tokenization",
                      desc: "Replace with type tokens (e.g. [EMAIL_1], [PHONE_1])"
                    },
                    {
                      value: "encryption" as SanitizationType,
                      label: "Encryption",
                      desc: "Replace with [ENCRYPTED] placeholder (irreversible without key)"
                    },
                    {
                      value: "data_masking" as SanitizationType,
                      label: "Data Masking",
                      desc: "Partially hide values (e.g. 98******10, ****1234)"
                    }
                  ] as const
                ).map((opt) => (
                  <label key={opt.value} className="sanitizationOption">
                    <input
                      type="radio"
                      name="sanitizationType"
                      value={opt.value}
                      checked={autofixModalSanitizationType === opt.value}
                      onChange={() =>
                        setAutofixModalSanitizationType(opt.value)
                      }
                    />
                    <div>
                      <strong>{opt.label}</strong>
                      <div className="sanitizationOptionDesc">{opt.desc}</div>
                    </div>
                  </label>
                ))}
              </div>

              <label className="sanitizationReasonLabel">
                Reason (optional):
                <input
                  className="sanitizationReasonInput"
                  type="text"
                  value={autofixModalReason}
                  onChange={(e) => setAutofixModalReason(e.target.value)}
                  placeholder="e.g. Compliance review"
                />
              </label>

              <div className="sanitizationActions">
                <button
                  className="btn"
                  onClick={closeAutofixModal}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="btn btn-green"
                  onClick={confirmAutofixComplete}
                  type="button"
                >
                  Apply AutoFix
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {inviteCreateModalOpen ? (
        <div
          className="modalOverlay"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeInviteCreateModal();
          }}
        >
          <div className="inviteCreateModal">
            <div className="keywordHead">
              <div>
                <div className="keywordTitle">Create invite</div>
                <div className="keywordSub">
                  Employees enter this code with their work email in the extension to join your
                  organization.
                </div>
              </div>
              <button
                className="keywordClose"
                onClick={closeInviteCreateModal}
                type="button"
                disabled={inviteCreating}
              >
                Close
              </button>
            </div>

            <div className="keywordBody inviteCreateBody">
              <div className="inviteFormField">
                <label htmlFor="inviteModalOrgId">Organization ID</label>
                <input
                  id="inviteModalOrgId"
                  className="inviteFormInput"
                  value={inviteModalOrgId}
                  onChange={(e) => setInviteModalOrgId(e.target.value)}
                  placeholder="e.g. default"
                  autoComplete="off"
                />
                <p className="inviteFormHint">
                  Invites are created for this organization. The list filter starts with this value when
                  you open the dialog.
                </p>
              </div>
              <div className="inviteFormField">
                <label htmlFor="inviteModalRole">Role for the new user</label>
                <select
                  id="inviteModalRole"
                  className="select inviteFormSelect"
                  value={inviteModalRole}
                  onChange={(e) =>
                    setInviteModalRole(
                      e.target.value as "employee" | "reviewer" | "org_admin"
                    )
                  }
                >
                  <option value="employee">Employee</option>
                  <option value="reviewer">Reviewer</option>
                  <option value="org_admin">Organization admin</option>
                </select>
              </div>
              <div className="inviteFormField">
                <label htmlFor="inviteModalHours">Expires in (hours)</label>
                <input
                  id="inviteModalHours"
                  className="inviteFormInput"
                  type="number"
                  min={1}
                  max={8760}
                  value={inviteModalHours}
                  onChange={(e) => setInviteModalHours(e.target.value)}
                />
              </div>
              <div className="inviteFormField">
                <label htmlFor="inviteModalCreatedBy">Created by (for audit log)</label>
                <input
                  id="inviteModalCreatedBy"
                  className="inviteFormInput"
                  value={inviteModalCreatedBy}
                  onChange={(e) => setInviteModalCreatedBy(e.target.value)}
                  placeholder="e.g. your name or admin@company.com"
                  autoComplete="off"
                />
              </div>
              {inviteCreateErr ? (
                <div className="error inviteFormError">{inviteCreateErr}</div>
              ) : null}
              <div className="sanitizationActions">
                <button
                  className="btn"
                  onClick={closeInviteCreateModal}
                  type="button"
                  disabled={inviteCreating}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-green"
                  onClick={submitInviteCreate}
                  type="button"
                  disabled={inviteCreating}
                >
                  {inviteCreating ? "Creating…" : "Create invite"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

