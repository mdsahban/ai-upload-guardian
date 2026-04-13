// background/background.js — Admin edition: direct-fix popup + admin API relay.

// Production-first API base configuration.
// Set aiug_apiBases (array) in chrome.storage.sync for release environments.
const DEFAULT_REMOTE_API_BASES = [];
const LOCAL_DEV_API_BASES = [
  'http://localhost:8080/api',
  'http://127.0.0.1:8080/api',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

async function getAdminApiBases() {
  try {
    const got = await chrome.storage.sync.get({
      aiug_apiBases: [],
      aiug_allowLocalApiFallback: true,
      aiug_requireConfiguredApi: false
    });
    const configured = Array.isArray(got?.aiug_apiBases)
      ? got.aiug_apiBases.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const allowLocal = Boolean(got?.aiug_allowLocalApiFallback);
    const requireConfigured = Boolean(got?.aiug_requireConfiguredApi);
    const bases = configured.length ? configured : DEFAULT_REMOTE_API_BASES;
    if (bases.length) {
      return allowLocal ? [...bases, ...LOCAL_DEV_API_BASES] : bases;
    }
    if (requireConfigured) {
      return [];
    }
    return LOCAL_DEV_API_BASES;
  } catch (_) {
    return LOCAL_DEV_API_BASES;
  }
}

async function adminApiErrorMessage(res, base) {
  let detail = '';
  try {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const j = await res.json();
      if (typeof j?.detail === 'string') detail = `: ${j.detail}`;
      else if (Array.isArray(j?.detail)) {
        const parts = j.detail.map((x) => x?.msg || x?.message).filter(Boolean);
        if (parts.length) detail = `: ${parts.join('; ')}`;
      }
    } else {
      const t = (await res.text()).trim();
      if (t) detail = `: ${t.slice(0, 200)}`;
    }
  } catch (_) {
    // ignore
  }
  return `Admin API ${res.status} (${base})${detail}`;
}

async function postJsonWithFallback(path, payload, headers = {}) {
  const apiBases = await getAdminApiBases();
  if (!apiBases.length) {
    throw new Error('No admin API base is configured in extension settings.');
  }
  let lastError = null;
  for (const base of apiBases) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload || {})
      });
      if (!res.ok) {
        throw new Error(await adminApiErrorMessage(res, base));
      }
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Admin API not reachable');
}

async function getJsonWithFallback(path, headers = {}) {
  const apiBases = await getAdminApiBases();
  if (!apiBases.length) {
    throw new Error('No admin API base is configured in extension settings.');
  }
  let lastError = null;
  for (const base of apiBases) {
    try {
      const res = await fetch(`${base}${path}`, { method: 'GET', headers: { ...headers } });
      if (!res.ok) {
        throw new Error(await adminApiErrorMessage(res, base));
      }
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Admin API not reachable');
}

function isPilotFullyOnboarded(ident) {
  const org = String(ident.orgId || '').trim();
  const emp = String(ident.employeeId || '').trim();
  const tok = String(ident.authToken || '').trim();
  if (!org || !emp || !tok) return false;
  const parts = tok.split('::');
  return (
    parts.length === 3 &&
    parts[0] === 'pilot' &&
    parts[1].trim() &&
    parts[2].trim()
  );
}

function storageKeyForFixSession(sessionId) {
  return `aiug_fix_${sessionId}`;
}

async function getPilotIdentity() {
  try {
    const got = await chrome.storage.sync.get({
      aiug_orgId: '',
      aiug_employeeId: '',
      aiug_authToken: ''
    });
    return {
      orgId: String(got?.aiug_orgId || '').trim(),
      employeeId: String(got?.aiug_employeeId || '').trim(),
      authToken: String(got?.aiug_authToken || '').trim()
    };
  } catch (_) {
    return { orgId: '', employeeId: '', authToken: '' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  switch (message.type) {
    case 'stashDirectFixSession': {
      (async () => {
        const tabId = sender.tab?.id;
        const p = message.payload || {};
        const sessionId = p.sessionId;
        if (!sessionId || tabId == null) {
          sendResponse({ success: false });
          return;
        }

        await chrome.storage.local.set({
          [storageKeyForFixSession(sessionId)]: {
            fullText: p.fullText || '',
            pii: p.pii || null,
            fileName: p.fileName || 'document',
            source: p.source || 'input',
            tabId,
            ts: Date.now()
          }
        });

        sendResponse({ success: true });
      })();
      return true;
    }

    case 'openDirectFixPopup': {
      (async () => {
        const sessionId = message.sessionId;
        if (!sessionId) {
          sendResponse({ success: false });
          return;
        }

        const url = chrome.runtime.getURL(
          `popup/popup.html?fixSession=${encodeURIComponent(sessionId)}`
        );

        await chrome.windows.create({
          url,
          type: 'popup',
          width: 480,
          height: 720,
          focused: true
        });

        sendResponse({ success: true });
      })();
      return true;
    }

    case 'directFixApplyComplete': {
      (async () => {
        const { sessionId, sanitizedText, fileName } = message.payload || {};
        if (!sessionId) {
          sendResponse({ success: false });
          return;
        }

        const key = storageKeyForFixSession(sessionId);
        const got = await chrome.storage.local.get(key);
        const rec = got[key];
        const tabId = rec?.tabId;

        await chrome.storage.local.remove(key);

        if (tabId == null) {
          sendResponse({ success: false });
          return;
        }

        chrome.tabs.sendMessage(tabId, {
          type: 'directFixApply',
          payload: {
            sessionId,
            sanitizedText: sanitizedText || '',
            fileName: fileName || 'sanitized.txt',
            source: rec.source || 'input'
          }
        });

        sendResponse({ success: true });
      })();
      return true;
    }

    case 'directFixCancel': {
      (async () => {
        const sessionId = message.sessionId;
        if (sessionId) {
          await chrome.storage.local.remove(storageKeyForFixSession(sessionId));
        }
        sendResponse({ success: true });
      })();
      return true;
    }

    case 'checkPilotOnboarded': {
      (async () => {
        const ident = await getPilotIdentity();
        sendResponse({ ok: isPilotFullyOnboarded(ident) });
      })();
      return true;
    }

    case 'adminCreateRequest': {
      (async () => {
        try {
          const payload = message.payload || {};
          const ident = await getPilotIdentity();
          if (!isPilotFullyOnboarded(ident)) {
            sendResponse({
              success: false,
              code: 'NOT_ONBOARDED',
              error:
                'Connect with a valid invite code in the extension popup before uploading or sending for review.'
            });
            return;
          }
          const body = {
            ...payload,
            orgId: ident.orgId,
            employeeId: ident.employeeId
          };
          const headers = { Authorization: `Bearer ${ident.authToken}` };
          const created = await postJsonWithFallback('/v1/requests', body, headers);
          sendResponse({ success: true, request: created || null });
        } catch (err) {
          sendResponse({
            success: false,
            error: err && (err.message || String(err))
          });
        }
      })();
      return true;
    }

    case 'onboardEmployee': {
      (async () => {
        try {
          const payload = message.payload || {};
          const out = await postJsonWithFallback('/v1/onboard', payload);
          const orgId = String(out?.orgId || '').trim();
          const employeeId = String(out?.employeeId || '').trim();
          const token = String(out?.token || '').trim();
          const role = String(out?.role || 'employee').trim();
          if (orgId && employeeId) {
            await chrome.storage.sync.set({
              aiug_orgId: orgId,
              aiug_employeeId: employeeId,
              aiug_authToken: token,
              aiug_role: role
            });
          }
          sendResponse({ success: true, onboard: out || null });
        } catch (err) {
          sendResponse({
            success: false,
            error: err && (err.message || String(err))
          });
        }
      })();
      return true;
    }

    case 'adminGetRequest': {
      (async () => {
        try {
          const requestId = message.requestId;
          if (!requestId) {
            sendResponse({ success: false, error: 'Missing requestId' });
            return;
          }
          const ident = await getPilotIdentity();
          if (!isPilotFullyOnboarded(ident)) {
            sendResponse({
              success: false,
              code: 'NOT_ONBOARDED',
              error: 'Not connected'
            });
            return;
          }
          const headers = { Authorization: `Bearer ${ident.authToken}` };
          const request = await getJsonWithFallback(
            `/v1/requests/${encodeURIComponent(requestId)}`,
            headers
          );
          sendResponse({ success: true, request: request || null });
        } catch (err) {
          sendResponse({
            success: false,
            error: err && (err.message || String(err))
          });
        }
      })();
      return true;
    }

    default:
      break;
  }
});

async function refreshOnboardingBadge() {
  try {
    const ident = await getPilotIdentity();
    const ok = isPilotFullyOnboarded(ident);
    await chrome.action.setBadgeText({ text: ok ? '' : '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
    await chrome.action.setTitle({
      title: ok
        ? 'AI Upload Guardian'
        : 'AI Upload Guardian — complete onboarding (open popup)'
    });
  } catch (_) {
    // ignore
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void refreshOnboardingBadge();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  const keys = ['aiug_orgId', 'aiug_employeeId', 'aiug_authToken'];
  if (!keys.some((k) => Object.prototype.hasOwnProperty.call(changes, k))) {
    return;
  }
  void refreshOnboardingBadge();
});

void refreshOnboardingBadge();
