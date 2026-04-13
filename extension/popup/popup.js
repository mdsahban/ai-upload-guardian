// popup/popup.js — Settings + Direct fix window.

(function () {
  const params = new URLSearchParams(window.location.search || '');
  const fixSession = params.get('fixSession');

  const settingsRoot = document.getElementById('settingsRoot');
  const fixRoot = document.getElementById('fixRoot');

  const DEFAULTS = {
    aiug_enableImages: true,
    aiug_enablePdf: true,
    aiug_enableTextFiles: true,
    aiug_highAccuracyExtraction: true,
    aiug_localExtractionOnly: true
  };

  const SECRET_DEFAULTS = {
    aiug_sanitizeSecret: ''
  };
  const IDENTITY_DEFAULTS = {
    aiug_orgId: '',
    aiug_employeeId: '',
    aiug_authToken: '',
    aiug_role: 'employee',
    aiug_email: ''
  };
  const API_DEFAULTS = {
    aiug_apiBases: ['https://ai-upload-guardian.onrender.com'],
    aiug_allowLocalApiFallback: true
  };

  function storageKeyForFixSession(id) {
    return `aiug_fix_${id}`;
  }

  function clampScore(score) {
    const n = Number(score);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(n, 1000));
  }

  function riskLevel(score) {
    const s = clampScore(score);
    if (s >= 700) return 'High';
    if (s >= 400) return 'Medium';
    return 'Low';
  }

  function scoreFromPii(pii) {
    if (typeof globalThis.scoreRisk === 'function' && pii) {
      try {
        return globalThis.scoreRisk(pii);
      } catch (_) {}
    }
    return 0;
  }

  // ---------- Settings mode ----------
  function initSettings() {
    if (settingsRoot) settingsRoot.hidden = false;
    if (fixRoot) fixRoot.hidden = true;
    document.body.classList.remove('fix-window');

    const enableImagesEl = document.getElementById('enableImages');
    const enablePdfEl = document.getElementById('enablePdf');
    const enableTextFilesEl = document.getElementById('enableTextFiles');
    const highAccuracyEl = document.getElementById('highAccuracyExtraction');
    const sanitizeSecretEl = document.getElementById('sanitizeSecret');
    const saveSanitizeSecretBtn = document.getElementById('saveSanitizeSecret');
    const pilotEmailEl = document.getElementById('pilotEmail');
    const apiBaseUrlEl = document.getElementById('apiBaseUrl');
    const inviteCodeEl = document.getElementById('inviteCode');
    const connectInviteEl = document.getElementById('connectInvite');
    const pilotStatusEl = document.getElementById('pilotStatus');
    const onboardingProgressEl = document.getElementById('onboardingProgress');
    const onboardingAlert = document.getElementById('onboardingAlert');
    const onboardingConnected = document.getElementById('onboardingConnected');
    const connectedSummary = document.getElementById('connectedSummary');
    const onboardingFormWrap = document.getElementById('onboardingFormWrap');
    const onboardingFormHint = document.getElementById('onboardingFormHint');
    const toggleReconnectBtn = document.getElementById('toggleReconnect');
    const collapseReconnectBtn = document.getElementById('collapseReconnect');

    let reconnectFormOpen = false;
    let onboardingPollTimer = null;

    function normalizeConnectError(err) {
      const msg = String(err || '').trim();
      if (!msg) return 'Unknown error';
      if (msg.includes('No admin API base is configured')) {
        return 'No server is configured. Ask your admin to configure the extension API base.';
      }
      if (msg.includes('Failed to fetch') || msg.includes('not reachable')) {
        return 'Cannot reach server. Check internet or ask admin to verify backend URL is configured.';
      }
      return msg;
    }

    async function getOnboardingState() {
      return await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'getOnboardingState' }, (resp) => {
            resolve(resp?.state || null);
          });
        } catch (_) {
          resolve(null);
        }
      });
    }

    async function clearOnboardingState() {
      return await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'clearOnboardingState' }, () => resolve());
        } catch (_) {
          resolve();
        }
      });
    }

    function startOnboardingPolling() {
      if (onboardingPollTimer) clearInterval(onboardingPollTimer);
      onboardingPollTimer = setInterval(async () => {
        const st = await getOnboardingState();
        if (!st || st.status === 'in_progress') {
          if (pilotStatusEl) pilotStatusEl.textContent = 'Connecting...';
          if (onboardingProgressEl) onboardingProgressEl.hidden = false;
          if (connectInviteEl) connectInviteEl.setAttribute('disabled', 'true');
          return;
        }
        if (onboardingPollTimer) {
          clearInterval(onboardingPollTimer);
          onboardingPollTimer = null;
        }
        if (connectInviteEl) connectInviteEl.removeAttribute('disabled');
        if (onboardingProgressEl) onboardingProgressEl.hidden = true;
        if (st.status === 'success') {
          reconnectFormOpen = false;
          if (inviteCodeEl) inviteCodeEl.value = '';
          if (collapseReconnectBtn) collapseReconnectBtn.hidden = true;
          if (pilotStatusEl) {
            pilotStatusEl.textContent = `Connected as ${st.email || ''}`.trim();
          }
          await clearOnboardingState();
          loadSettings();
          return;
        }
        if (st.status === 'error') {
          if (pilotStatusEl) {
            pilotStatusEl.textContent = `Connect failed: ${normalizeConnectError(st.error)}`;
          }
          await clearOnboardingState();
          return;
        }
      }, 1000);
    }

    function isPilotConnected(items) {
      const orgId = String(items.aiug_orgId || '').trim();
      const emp = String(items.aiug_employeeId || '').trim();
      const tok = String(items.aiug_authToken || '').trim();
      return !!(orgId && emp && tok);
    }

    function normalizeApiBase(input) {
      const raw = String(input || '').trim();
      if (!raw) return '';
      return raw.replace(/\/+$/, '');
    }

    function applyOnboardingLayout(items) {
      const connected = isPilotConnected(items);
      const orgId = String(items.aiug_orgId || '').trim();
      const emp = String(items.aiug_employeeId || '').trim();
      const email = String(items.aiug_email || '').trim();

      if (onboardingAlert) onboardingAlert.hidden = connected;
      if (onboardingConnected) onboardingConnected.hidden = !connected;

      if (connected && connectedSummary) {
        const lines = [
          `<strong>Organization:</strong> ${orgId}`,
          `<strong>User ID:</strong> ${emp}`
        ];
        if (email) lines.push(`<strong>Work email:</strong> ${email}`);
        connectedSummary.innerHTML = lines.join('<br/>');
      }

      if (connected && !reconnectFormOpen) {
        if (onboardingFormWrap) onboardingFormWrap.hidden = true;
        if (toggleReconnectBtn) toggleReconnectBtn.hidden = false;
        if (collapseReconnectBtn) collapseReconnectBtn.hidden = true;
        if (onboardingFormHint) {
          onboardingFormHint.textContent =
            'Use “Change invite or reconnect” only if you need a new invite or account.';
        }
      } else {
        if (onboardingFormWrap) onboardingFormWrap.hidden = false;
        if (toggleReconnectBtn) toggleReconnectBtn.hidden = !connected;
        if (collapseReconnectBtn) {
          collapseReconnectBtn.hidden = !(connected && reconnectFormOpen);
        }
        if (onboardingFormHint) {
          onboardingFormHint.textContent = connected
            ? 'Enter a new invite code (and email if it changed), then Connect.'
            : 'Connect this extension to your admin organization using invite code.';
        }
      }

      if (pilotStatusEl) {
        if (connected) {
          pilotStatusEl.textContent = reconnectFormOpen
            ? 'Reconnecting will replace this device’s link to the admin panel.'
            : 'You are connected. Requests will be attributed to your account.';
        } else {
          pilotStatusEl.textContent = 'Not connected — complete the form above.';
        }
      }
    }

    function loadSettings() {
      if (!chrome?.storage?.sync) return;
      chrome.storage.sync.get(
        { ...DEFAULTS, ...SECRET_DEFAULTS, ...IDENTITY_DEFAULTS, ...API_DEFAULTS },
        (items) => {
          if (enableImagesEl) enableImagesEl.checked = !!items.aiug_enableImages;
          if (enablePdfEl) enablePdfEl.checked = !!items.aiug_enablePdf;
          if (enableTextFilesEl)
            enableTextFilesEl.checked = !!items.aiug_enableTextFiles;
          if (highAccuracyEl)
            highAccuracyEl.checked = !!items.aiug_highAccuracyExtraction;
          if (sanitizeSecretEl)
            sanitizeSecretEl.value = items.aiug_sanitizeSecret || '';
          if (pilotEmailEl) pilotEmailEl.value = items.aiug_email || '';
          if (apiBaseUrlEl) {
            const firstBase = Array.isArray(items.aiug_apiBases)
              ? String(items.aiug_apiBases[0] || '').trim()
              : '';
            apiBaseUrlEl.value = firstBase || API_DEFAULTS.aiug_apiBases[0];
          }
          if (inviteCodeEl && isPilotConnected(items) && !reconnectFormOpen) {
            inviteCodeEl.value = '';
          }
          applyOnboardingLayout(items);
        }
      );
    }

    function save(key, value) {
      if (!chrome?.storage?.sync) return;
      const payload = {};
      payload[key] = value;
      chrome.storage.sync.set(payload);
    }

    if (enableImagesEl) {
      enableImagesEl.addEventListener('change', () => {
        save('aiug_enableImages', enableImagesEl.checked);
      });
    }
    if (enablePdfEl) {
      enablePdfEl.addEventListener('change', () => {
        save('aiug_enablePdf', enablePdfEl.checked);
      });
    }
    if (enableTextFilesEl) {
      enableTextFilesEl.addEventListener('change', () => {
        save('aiug_enableTextFiles', enableTextFilesEl.checked);
      });
    }
    if (highAccuracyEl) {
      highAccuracyEl.addEventListener('change', () => {
        save('aiug_highAccuracyExtraction', highAccuracyEl.checked);
      });
    }

    if (saveSanitizeSecretBtn && sanitizeSecretEl) {
      saveSanitizeSecretBtn.addEventListener('click', () => {
        save(
          'aiug_sanitizeSecret',
          String(sanitizeSecretEl.value || '').trim()
        );
      });
    }

    if (toggleReconnectBtn) {
      toggleReconnectBtn.addEventListener('click', () => {
        reconnectFormOpen = true;
        if (inviteCodeEl) inviteCodeEl.value = '';
        if (collapseReconnectBtn) collapseReconnectBtn.hidden = false;
        loadSettings();
        if (inviteCodeEl) inviteCodeEl.focus();
      });
    }

    if (collapseReconnectBtn) {
      collapseReconnectBtn.addEventListener('click', () => {
        reconnectFormOpen = false;
        if (collapseReconnectBtn) collapseReconnectBtn.hidden = true;
        loadSettings();
      });
    }

    if (connectInviteEl && inviteCodeEl && pilotEmailEl) {
      connectInviteEl.addEventListener('click', async () => {
        const inviteCode = String(inviteCodeEl.value || '').trim();
        const email = String(pilotEmailEl.value || '').trim().toLowerCase();
        const apiBase = normalizeApiBase(apiBaseUrlEl?.value || '');
        if (!inviteCode || !email) {
          if (pilotStatusEl) pilotStatusEl.textContent = 'Enter work email and invite code.';
          return;
        }
        if (!apiBase) {
          if (pilotStatusEl) pilotStatusEl.textContent = 'Enter backend API URL first.';
          return;
        }
        connectInviteEl.setAttribute('disabled', 'true');
        if (onboardingProgressEl) onboardingProgressEl.hidden = false;
        if (pilotStatusEl) pilotStatusEl.textContent = 'Connecting...';
        try {
          await new Promise((resolve, reject) => {
            chrome.storage.sync.set(
              {
                aiug_apiBases: [apiBase],
                aiug_allowLocalApiFallback: false
              },
              () => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                } else {
                  resolve();
                }
              }
            );
          });
          const resp = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              {
                type: 'startOnboardEmployee',
                payload: { inviteCode, email }
              },
              (r) => resolve(r || null)
            );
          });
          if (!resp || !resp.success) {
            throw new Error(resp?.error || 'Onboarding could not start');
          }
          startOnboardingPolling();
        } catch (e) {
          if (pilotStatusEl) {
            pilotStatusEl.textContent = `Connect failed: ${normalizeConnectError(e?.message || e)}`;
          }
          if (onboardingProgressEl) onboardingProgressEl.hidden = true;
          connectInviteEl.removeAttribute('disabled');
        } finally {
          // kept disabled while polling in-progress state
        }
      });
    }

    loadSettings();
    void (async () => {
      const st = await getOnboardingState();
      if (st && st.status === 'in_progress') {
        startOnboardingPolling();
      }
    })();
    window.addEventListener('beforeunload', () => {
      if (onboardingPollTimer) clearInterval(onboardingPollTimer);
    });
  }

  // ---------- Direct fix mode ----------
  async function getSanitizeSecret() {
    return await new Promise((resolve) => {
      if (!chrome?.storage?.sync) {
        resolve('');
        return;
      }
      chrome.storage.sync.get(SECRET_DEFAULTS, (items) => {
        resolve(String(items?.aiug_sanitizeSecret || '').trim());
      });
    });
  }

  async function runFixPreview(session, mode) {
    const secret = await getSanitizeSecret();
    const out = await sanitizeTextWithPii(
      session.fullText || '',
      session.pii,
      mode,
      secret || undefined
    );
    return out;
  }

  async function initFix(sessionId) {
    if (!sessionId || !fixRoot || !settingsRoot) {
      initSettings();
      return;
    }

    settingsRoot.hidden = true;
    fixRoot.hidden = false;
    document.body.classList.add('fix-window');

    const key = storageKeyForFixSession(sessionId);
    const got = await chrome.storage.local.get(key);
    const session = got[key];

    if (!session) {
      const prev = document.getElementById('fixPreview');
      if (prev) prev.value = 'Session expired or missing. Close this window.';
      document.getElementById('fixApply')?.setAttribute('disabled', 'true');
      return;
    }

    const fileLabel = document.getElementById('fixFileLabel');
    const fixScore = document.getElementById('fixScore');
    const fixRiskBadge = document.getElementById('fixRiskBadge');
    const fixMeter = document.getElementById('fixMeter');
    const fixRiskSub = document.getElementById('fixRiskSub');
    const fixMode = document.getElementById('fixMode');
    const fixPreview = document.getElementById('fixPreview');
    const fixRefresh = document.getElementById('fixRefresh');
    const fixApply = document.getElementById('fixApply');
    const fixCancel = document.getElementById('fixCancel');
    const fixSourceHint = document.getElementById('fixSourceHint');

    const score = scoreFromPii(session.pii);
    if (fileLabel) fileLabel.textContent = session.fileName || 'File';
    if (fixScore) fixScore.textContent = String(score);
    if (fixRiskBadge) fixRiskBadge.textContent = `${riskLevel(score)} risk`;
    if (fixMeter) fixMeter.style.width = `${(clampScore(score) / 1000) * 100}%`;
    if (fixRiskSub) fixRiskSub.textContent = `${riskLevel(score)} risk`;

    if (fixSourceHint) {
      fixSourceHint.textContent =
        session.source === 'drop'
          ? 'After Apply, a sanitized .txt file will download (drag-and-drop uploads cannot be auto-replaced).'
          : 'After Apply, the file input on the chat tab will receive a sanitized .txt upload.';
    }

    async function refresh() {
      const mode = fixMode?.value || 'data_masking';
      const { sanitized } = await runFixPreview(session, mode);
      if (fixPreview) fixPreview.value = sanitized || '';
    }

    if (fixRefresh) fixRefresh.addEventListener('click', () => refresh());
    if (fixMode) fixMode.addEventListener('change', () => refresh());

    await refresh();

    if (fixCancel) {
      fixCancel.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'directFixCancel',
          sessionId
        });
        window.close();
      });
    }

    if (fixApply) {
      fixApply.addEventListener('click', async () => {
        const mode = fixMode?.value || 'data_masking';
        const { sanitized } = await runFixPreview(session, mode);
        const base = String(session.fileName || 'document').replace(
          /\.[^/.]+$/,
          ''
        );
        const outName = `${base}_sanitized.txt`;

        chrome.runtime.sendMessage(
          {
            type: 'directFixApplyComplete',
            payload: {
              sessionId,
              sanitizedText: sanitized || '',
              fileName: outName
            }
          },
          () => window.close()
        );
      });
    }
  }

  if (fixSession) {
    initFix(fixSession);
  } else {
    initSettings();
  }
})();
