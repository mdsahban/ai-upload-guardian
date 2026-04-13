// content/inlineReview.js
// In-tab modal: file uploads + chat (detect risks, sanitize, or proceed).

(() => {
  if (window.AIUploadGuardianReview) return;

  const CONNECT_FIRST_ALERT =
    'AI Upload Guardian\n\nFinish connecting before you can send for admin review.\n\n' +
    '1. Click the extension icon in your toolbar\n' +
    '2. Enter your work email and invite code\n' +
    '3. Click Connect\n\n' +
    'Then try again.';

  function sumDetected(pii) {
    if (!pii) return 0;
    return (
      (pii.emails?.length || 0) +
      (pii.phones?.length || 0) +
      (pii.passwords?.length || 0) +
      (pii.creditCards?.length || 0) +
      (pii.apiKeys?.length || 0) +
      (pii.aadhaarNumbers?.length || 0) +
      (pii.bankAccounts?.length || 0) +
      (pii.fullNames?.length || 0) +
      (pii.addresses?.length || 0)
    );
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

  function groupsForPii(pii) {
    return [
      { key: 'emails', label: 'Email Addresses' },
      { key: 'phones', label: 'Phone Numbers' },
      { key: 'passwords', label: 'Passwords / Secrets' },
      { key: 'creditCards', label: 'Credit Card Numbers' },
      { key: 'apiKeys', label: 'API Keys / Tokens' },
      { key: 'aadhaarNumbers', label: 'Aadhaar Numbers' },
      { key: 'bankAccounts', label: 'Bank Account Numbers' },
      { key: 'fullNames', label: 'Full Names' },
      { key: 'addresses', label: 'Addresses' }
    ].map((g) => ({ ...g, values: pii?.[g.key] || [] }));
  }

  function fetchSanitizeSecret() {
    return new Promise((resolve) => {
      if (!chrome?.storage?.sync) {
        resolve('');
        return;
      }
      chrome.storage.sync.get({ aiug_sanitizeSecret: '' }, (items) => {
        resolve(String(items?.aiug_sanitizeSecret || '').trim());
      });
    });
  }

  function applyTextToElement(el, text) {
    if (!el) return;
    const t = text == null ? '' : String(text);
    if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text')) {
      el.value = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      el.focus();
      // Rich text chat inputs need both text replacement and input events.
      el.textContent = t;
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      } catch (_) {}
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function readTextFromElement(el) {
    if (!el) return '';
    if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text')) {
      return el.value || '';
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      return el.innerText || el.textContent || '';
    }
    return '';
  }

  function createHost() {
    const host = document.createElement('div');
    host.id = '__ai_upload_guardian_inline_review_host';
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = '2147483647';
    host.style.display = 'flex';
    host.style.alignItems = 'center';
    host.style.justifyContent = 'center';
    host.style.background = 'rgba(2, 6, 23, 0.60)';
    host.style.backdropFilter = 'blur(4px)';
    host.style.webkitBackdropFilter = 'blur(4px)';
    host.style.pointerEvents = 'auto';
    return host;
  }

  function renderModalUpload(shadowRoot) {
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .modal {
        width: 720px;
        max-width: calc(100vw - 28px);
        max-height: calc(100vh - 28px);
        border-radius: 18px;
        background: #ffffff;
        color: #0f172a;
        box-shadow: 0 24px 70px rgba(0,0,0,0.55);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        overflow: hidden;
      }
      header {
        background: #dc2626;
        color: #ffffff;
        padding: 18px 20px;
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      .shield {
        width: 34px;
        height: 34px;
        flex: 0 0 auto;
        border-radius: 10px;
        background: rgba(255,255,255,0.12);
        display: grid;
        place-items: center;
      }
      .header-title { margin: 0; font-size: 20px; font-weight: 800; line-height: 1.1; }
      .header-sub { margin-top: 4px; font-size: 13px; opacity: 0.92; }
      .file-name { margin-top: 4px; font-size: 13px; font-weight: 650; opacity: 0.95; word-break: break-word; }
      .content { padding: 18px 20px 16px; }
      .alert {
        border-radius: 14px;
        background: #fff1f2;
        border: 1px solid #fecdd3;
        padding: 14px;
        display: flex;
        gap: 10px;
        align-items: flex-start;
      }
      .alert-icon {
        width: 28px;
        height: 28px;
        border-radius: 10px;
        background: #ffe4e6;
        display: grid;
        place-items: center;
        flex: 0 0 auto;
      }
      .alert-title { margin: 0; font-size: 15px; font-weight: 800; color: #b91c1c; }
      .alert-desc { margin: 4px 0 0; font-size: 13px; color: #991b1b; line-height: 1.35; }
      .section-title {
        margin: 16px 0 10px;
        font-size: 12px;
        font-weight: 900;
        color: #64748b;
        letter-spacing: 0.08em;
      }
      .list {
        border-radius: 14px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        padding: 10px;
        max-height: 220px;
        overflow: auto;
      }
      .item {
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 14px;
        padding: 10px 12px;
        display: flex;
        align-items: flex-start;
        gap: 12px;
        margin-bottom: 10px;
      }
      .pill {
        padding: 7px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 800;
        border: 1px solid #e2e8f0;
        background: #eef2ff;
        color: #4338ca;
        flex: 0 0 auto;
        white-space: nowrap;
      }
      .pill.blue { background:#dbeafe; color:#1d4ed8; border-color:#bfdbfe; }
      .pill.cyan { background:#cffafe; color:#0e7490; border-color:#a5f3fc; }
      .pill.violet { background:#ede9fe; color:#6d28d9; border-color:#ddd6fe; }
      .pill.amber { background:#fef3c7; color:#92400e; border-color:#fde68a; }
      .pill.rose { background:#ffe4e6; color:#be123c; border-color:#fecdd3; }
      .item-main { min-width: 0; }
      .item-value { font-size: 14px; font-weight: 700; color: #0f172a; word-break: break-word; }
      .item-sub { margin-top: 3px; font-size: 12px; color: #94a3b8; }
      footer {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 12px;
        padding: 14px 20px 18px;
        border-top: 1px solid #e2e8f0;
      }
      button {
        cursor: pointer;
        border: none;
        border-radius: 14px;
        padding: 12px 14px;
        font-size: 14px;
        font-weight: 800;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
      }
      .btn-secondary { background: #ffffff; border: 1px solid #e2e8f0; color: #334155; }
      .btn-secondary:hover { background: #f8fafc; }
      .btn-mid { background: #fff1f2; color: #b91c1c; border: 1px solid #fecdd3; }
      .btn-mid:hover { background: #ffe4e6; }
      .btn-primary { background: #dc2626; color: #ffffff; }
      .btn-primary:hover { background: #b91c1c; }
    `;

    const root = document.createElement('div');
    root.className = 'modal';
    root.innerHTML = `
      <header>
        <div class="shield" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 2l7 4v6c0 5-3 9-7 10-4-1-7-5-7-10V6l7-4z" stroke="white" stroke-width="2" />
            <path d="M12 7v6" stroke="white" stroke-width="2" stroke-linecap="round"/>
            <path d="M12 17h.01" stroke="white" stroke-width="3" stroke-linecap="round"/>
          </svg>
        </div>
        <div>
          <div class="header-title">Upload paused</div>
          <div class="header-sub">Review sensitive data before uploading</div>
          <div class="file-name" id="fileNameTop">-</div>
        </div>
      </header>
      <div class="content">
        <div class="alert">
          <div class="alert-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M12 9v5" stroke="#dc2626" stroke-width="2" stroke-linecap="round"/>
              <path d="M12 17h.01" stroke="#dc2626" stroke-width="3" stroke-linecap="round"/>
              <path d="M10.3 4.3l-8 14A2 2 0 004 21h16a2 2 0 001.7-2.7l-8-14a2 2 0 00-3.4 0z" stroke="#dc2626" stroke-width="2"/>
            </svg>
          </div>
          <div>
            <div class="alert-title" id="alertTitle">Sensitive data detected</div>
            <div class="alert-desc" id="alertDesc">
              In admin mode, requests are sent to the Admin Panel for approval or autofix.
            </div>
          </div>
        </div>
        <div class="section-title">DETECTED SENSITIVE DATA</div>
        <div class="list" id="list"></div>
      </div>
      <footer>
        <button id="secondaryBtn" class="btn-secondary">Cancel</button>
        <button id="requestBtn" class="btn-mid">Request to Upload</button>
        <button id="primaryBtn" class="btn-primary">Request AutoFix</button>
      </footer>
    `;

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(root);
    return root;
  }

  function renderModalChat(shadowRoot) {
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .modal {
        width: 520px;
        max-width: calc(100vw - 28px);
        max-height: calc(100vh - 28px);
        border-radius: 16px;
        border: 1px solid #fecdd3;
        background: #ffffff;
        color: #0f172a;
        box-shadow: 0 18px 50px rgba(0,0,0,0.55);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        overflow: hidden;
      }
      header { padding: 14px 16px 10px; border-bottom: 1px solid #fecdd3; background:#dc2626; color:#fff; }
      .title { margin: 0; font-size: 18px; font-weight: 800; color: #ffffff; }
      .subtitle { margin: 4px 0 0; font-size: 12px; color: #ffe4e6; }
      .summary { display:flex; justify-content:space-between; gap:10px; padding: 12px 16px; }
      .label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; }
      .value { font-size:13px; color:#0f172a; word-break: break-word; }
      .risk { display:flex; flex-direction:column; align-items:flex-end; gap:6px; min-width:170px; }
      .badge { display:inline-block; padding:4px 10px; border-radius:999px; font-size:13px; font-weight:700; background:#fff1f2; border:1px solid #fecdd3; color:#b91c1c; }
      .risk-meter { width:170px; }
      .risk-meter-track { width:100%; height:7px; border-radius:999px; background:#fff1f2; overflow:hidden; border:1px solid #fecdd3; }
      .risk-meter-fill { height:100%; width:0%; border-radius:999px; background: linear-gradient(90deg,#22c55e,#eab308,#ef4444); transition: width .25s ease-out; }
      .risk-level { font-size:11px; color:#64748b; text-align:right; }
      .details { margin:0 16px 12px; padding:10px 12px; border-radius:12px; background:#f8fafc; border:1px solid #e2e8f0; max-height:280px; overflow:auto; }
      h2 { margin:0 0 8px; font-size:13px; font-weight:700; color:#0f172a; }
      .no-data{ font-size:12px; color:#64748b; }
      .group{ margin-top:10px; }
      .group-title{ font-size:12px; font-weight:700; color:#334155; margin-bottom:6px; }
      .chip{ display:block; font-size:11px; padding:4px 6px; margin-bottom:4px; border-radius:8px; background:#ffffff; border:1px dashed #cbd5e1; word-break:break-all; color:#0f172a; }
      footer { display:flex; flex-wrap: wrap; justify-content:flex-end; gap:8px; padding:12px 16px 14px; border-top:1px solid #e2e8f0; }
      button { cursor:pointer; border:none; border-radius:999px; padding:8px 14px; font-size:13px; font-weight:650; }
      .btn-primary{ background:#dc2626; color:#ffffff; }
      .btn-primary:hover{ filter:brightness(0.98); }
      .btn-secondary{ background:#ffffff; color:#334155; border:1px solid #e2e8f0; }
      .btn-secondary:hover{ background:#f8fafc; }
    `;

    const root = document.createElement('div');
    root.className = 'modal';
    root.innerHTML = `
      <header>
        <div class="title">AI Upload Guardian</div>
        <div class="subtitle" id="subtitle">Sensitive data in your message</div>
      </header>
      <section class="summary">
        <div>
          <span class="label">Message</span>
          <div id="nameValue" class="value">Chat text</div>
        </div>
        <div class="risk">
          <span class="label">Risk</span>
          <span id="scoreBadge" class="badge">0</span>
          <div class="risk-meter">
            <div class="risk-meter-track"><div id="meterFill" class="risk-meter-fill"></div></div>
            <div id="riskLevel" class="risk-level">Low risk</div>
          </div>
        </div>
      </section>
      <section class="details">
        <h2>Detected</h2>
        <div id="noData" class="no-data">No obvious sensitive data detected.</div>
        <div id="groups"></div>
      </section>
      <footer>
        <button id="secondaryBtn" class="btn-secondary">Edit myself</button>
        <button id="primaryBtn" class="btn-primary">Request to Send</button>
      </footer>
    `;
    shadowRoot.appendChild(style);
    shadowRoot.appendChild(root);
    return root;
  }

  async function open(analysis, options = {}) {
    const modalMode =
      options.mode || (analysis?.contextType === 'chatText' ? 'chat' : 'upload');
    const isChat = modalMode === 'chat';
    const textboxElement = options.textboxElement || null;

    try {
      const existing = document.getElementById('__ai_upload_guardian_inline_review_host');
      if (existing) existing.remove();
    } catch (_) {}

    const host = createHost();
    const shadow = host.attachShadow({ mode: 'open' });
    const modal = isChat ? renderModalChat(shadow) : renderModalUpload(shadow);
    document.documentElement.appendChild(host);

    const scoreBadge = shadow.getElementById('scoreBadge');
    const meterFill = shadow.getElementById('meterFill');
    const riskLevelEl = shadow.getElementById('riskLevel');
    const noData = shadow.getElementById('noData');
    const groupsEl = shadow.getElementById('groups');
    const listEl = shadow.getElementById('list');
    const primaryBtn = shadow.getElementById('primaryBtn');
    const secondaryBtn = shadow.getElementById('secondaryBtn');
    const requestBtn = shadow.getElementById('requestBtn');

    const score = clampScore(analysis?.riskScore);
    if (scoreBadge) scoreBadge.textContent = String(score);
    if (meterFill) meterFill.style.width = `${(score / 1000) * 100}%`;
    if (riskLevelEl) riskLevelEl.textContent = `${riskLevel(score)} risk`;

    let primaryDecision = isChat ? 'request_send' : 'request_autofix';
    let requestDecision = isChat ? '' : 'request_upload';
    let secondaryDecision = isChat ? 'rewrite' : 'cancel';
    let outsideDecision = secondaryDecision;

    if (!isChat) {
      const fileNameTop = shadow.getElementById('fileNameTop');
      if (fileNameTop) fileNameTop.textContent = analysis?.fileName || 'Unknown';
      const count = sumDetected(analysis?.pii);
      const alertDescEl = shadow.getElementById('alertDesc');
      if (alertDescEl) {
        alertDescEl.textContent =
          count > 0
            ? `Found ${count} sensitive item${count === 1 ? '' : 's'}. Submit a request to admin for upload approval or autofix.`
            : 'Review before uploading. Submit a request to admin to proceed.';
      }

      if (listEl) {
        listEl.innerHTML = '';
        const groups = groupsForPii(analysis?.pii);
        const items = [];
        for (const g of groups) {
          for (const v of g.values) items.push({ label: g.label, value: v, key: g.key });
        }
        const colorForKey = (k) => {
          if (k === 'emails') return 'blue';
          if (k === 'phones') return 'cyan';
          if (k === 'passwords') return 'rose';
          if (k === 'creditCards') return 'amber';
          if (k === 'apiKeys') return 'violet';
          return 'violet';
        };
        if (!items.length) {
          const empty = document.createElement('div');
          empty.style.color = '#64748b';
          empty.style.fontSize = '13px';
          empty.style.padding = '8px 6px';
          empty.textContent = 'No obvious sensitive data in extracted content.';
          listEl.appendChild(empty);
        } else {
          items.slice(0, 30).forEach((it) => {
            const row = document.createElement('div');
            row.className = 'item';
            const pill = document.createElement('div');
            pill.className = `pill ${colorForKey(it.key)}`;
            pill.textContent = it.label.replace('Addresses', '').trim();
            row.appendChild(pill);
            const main = document.createElement('div');
            main.className = 'item-main';
            const val = document.createElement('div');
            val.className = 'item-value';
            val.textContent = it.value;
            main.appendChild(val);
            const sub = document.createElement('div');
            sub.className = 'item-sub';
            sub.textContent = 'From file / OCR';
            main.appendChild(sub);
            row.appendChild(main);
            listEl.appendChild(row);
          });
        }
      }
    }

    if (isChat && groupsEl) {
      const nameValue = shadow.getElementById('nameValue');
      if (nameValue) {
        const preview = (analysis?.fullText || analysis?.textSample || '').slice(0, 120);
        nameValue.textContent = preview ? `${preview}${preview.length >= 120 ? '…' : ''}` : 'Chat text';
      }
      const groups = groupsForPii(analysis?.pii);
      groupsEl.innerHTML = '';
      let hasAny = false;
      for (const g of groups) {
        if (!g.values.length) continue;
        hasAny = true;
        const group = document.createElement('div');
        group.className = 'group';
        const title = document.createElement('div');
        title.className = 'group-title';
        title.textContent = `${g.label} (${g.values.length})`;
        group.appendChild(title);
        g.values.slice(0, 12).forEach((val) => {
          const chip = document.createElement('div');
          chip.className = 'chip';
          chip.textContent = val;
          group.appendChild(chip);
        });
        if (g.values.length > 12) {
          const more = document.createElement('div');
          more.className = 'chip';
          more.textContent = `+${g.values.length - 12} more…`;
          group.appendChild(more);
        }
        groupsEl.appendChild(group);
      }
      if (noData) noData.style.display = hasAny ? 'none' : 'block';
    }

    let chatPollTimer = null;

    function cleanup() {
      try {
        host.remove();
      } catch (_) {}
      if (chatPollTimer) {
        clearInterval(chatPollTimer);
        chatPollTimer = null;
      }
      document.removeEventListener('keydown', onKeyDown, true);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        cleanup();
        resolver(outsideDecision);
      }
    }

    document.addEventListener('keydown', onKeyDown, true);

    host.addEventListener('mousedown', (e) => {
      if (e.composedPath().includes(modal)) return;
      cleanup();
      resolver(outsideDecision);
    });

    let resolver;
    const resultPromise = new Promise((resolve) => {
      resolver = resolve;
    });

    if (primaryBtn) {
      primaryBtn.addEventListener('click', async () => {
        if (!primaryDecision) return;
        if (isChat && primaryDecision === 'request_send') {
          const titleEl = shadow.querySelector('.title');
          const subtitleEl = shadow.getElementById('subtitle');
          if (secondaryBtn) secondaryBtn.disabled = true;
          primaryBtn.disabled = true;
          primaryBtn.textContent = 'Requesting...';
          if (titleEl) titleEl.textContent = 'Request sent to admin';
          if (subtitleEl) subtitleEl.textContent = 'Waiting for admin approval...';

          const chatBody = String(analysis?.fullText || analysis?.textSample || '').slice(
            0,
            300000
          );
          const createResp = await createAdminRequest({
            host: window.location.hostname,
            fileName: 'Chat message text',
            fileType: 'text/plain',
            riskScore: Number(analysis?.riskScore || 0),
            pii: analysis?.pii || null,
            createdAt: Date.now(),
            kind: 'chat_message_request',
            autofixInputText: chatBody
          });

          if (createResp?.success === false && createResp?.code === 'NOT_ONBOARDED') {
            try {
              window.alert(CONNECT_FIRST_ALERT);
            } catch (_) {}
            if (titleEl) titleEl.textContent = 'Not connected';
            if (subtitleEl)
              subtitleEl.textContent =
                'Open the extension popup and connect with your invite code, then try again.';
            if (secondaryBtn) secondaryBtn.disabled = false;
            primaryBtn.disabled = false;
            primaryBtn.textContent = 'Request to Send';
            return;
          }

          const req = createResp?.request || null;
          const requestId = req?.requestId || '';
          if (!requestId) {
            if (subtitleEl) subtitleEl.textContent = 'Could not send request. Try again.';
            if (secondaryBtn) secondaryBtn.disabled = false;
            primaryBtn.disabled = false;
            primaryBtn.textContent = 'Request to Send';
            return;
          }

          primaryBtn.textContent = 'Waiting...';
          if (secondaryBtn) secondaryBtn.textContent = 'Close';
          outsideDecision = 'rewrite';

          const poll = async () => {
            const resp = await fetchAdminRequest(requestId);
            if (resp?.success === false && resp?.code === 'NOT_ONBOARDED') {
              if (chatPollTimer) {
                clearInterval(chatPollTimer);
                chatPollTimer = null;
              }
              try {
                window.alert(CONNECT_FIRST_ALERT);
              } catch (_) {}
              if (titleEl) titleEl.textContent = 'Not connected';
              if (subtitleEl)
                subtitleEl.textContent =
                  'Open the extension popup and connect with your invite code, then try again.';
              if (secondaryBtn) secondaryBtn.disabled = false;
              primaryBtn.disabled = false;
              primaryBtn.textContent = 'Request to Send';
              return true;
            }
            const r = resp?.request || null;
            if (!r || !r.status) return false;
            if (r.status === 'approved') {
              cleanup();
              resolver('approve');
              return true;
            }
            if (r.status === 'blocked') {
              if (titleEl) titleEl.textContent = 'Request blocked';
              if (subtitleEl) subtitleEl.textContent = 'Admin blocked this message. Please edit and resend.';
              primaryBtn.disabled = true;
              primaryBtn.textContent = 'Blocked';
              return true;
            }
            return false;
          };

          const doneNow = await poll();
          if (!doneNow) {
            chatPollTimer = setInterval(async () => {
              const done = await poll();
              if (done && chatPollTimer) {
                clearInterval(chatPollTimer);
                chatPollTimer = null;
              }
            }, 2000);
          }
          return;
        }
        cleanup();
        resolver(primaryDecision);
      });
    }

    if (requestBtn) {
      requestBtn.addEventListener('click', async () => {
        if (!requestDecision) return;
        cleanup();
        resolver(requestDecision);
      });
    }

    if (secondaryBtn) {
      secondaryBtn.addEventListener('click', () => {
        cleanup();
        resolver(secondaryDecision);
      });
    }

    return await resultPromise;
  }

  async function fetchAdminRequest(requestId) {
    return await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'adminGetRequest', requestId },
          (resp) => resolve(resp || null)
        );
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function createAdminRequest(payload) {
    return await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'adminCreateRequest', payload },
          (resp) => resolve(resp || null)
        );
      } catch (_) {
        resolve(null);
      }
    });
  }

  function colorForPillKey(k) {
    if (k === 'emails') return 'blue';
    if (k === 'phones') return 'cyan';
    if (k === 'passwords') return 'rose';
    if (k === 'creditCards') return 'amber';
    if (k === 'apiKeys') return 'violet';
    return 'violet';
  }

  function fillAdminModalPiiList(shadow, pii) {
    const listEl = shadow.getElementById('piiList');
    if (!listEl) return;
    listEl.innerHTML = '';
    const groups = groupsForPii(pii);
    const items = [];
    for (const g of groups) {
      for (const v of g.values) items.push({ label: g.label, value: v, key: g.key });
    }
    if (!items.length) {
      const empty = document.createElement('div');
      empty.style.color = '#64748b';
      empty.style.fontSize = '12px';
      empty.style.padding = '8px 6px';
      empty.textContent = 'No obvious sensitive data in extracted content.';
      listEl.appendChild(empty);
      return;
    }
    items.slice(0, 24).forEach((it) => {
      const row = document.createElement('div');
      row.className = 'item';
      const pill = document.createElement('div');
      pill.className = `pill ${colorForPillKey(it.key)}`;
      pill.textContent = it.label.replace('Addresses', '').trim();
      row.appendChild(pill);
      const main = document.createElement('div');
      main.className = 'item-main';
      const val = document.createElement('div');
      val.className = 'item-value';
      val.textContent = it.value;
      main.appendChild(val);
      const sub = document.createElement('div');
      sub.className = 'item-sub';
      sub.textContent = 'From file / OCR';
      main.appendChild(sub);
      row.appendChild(main);
      listEl.appendChild(row);
    });
    if (items.length > 24) {
      const more = document.createElement('div');
      more.style.cssText = 'font-size:12px;color:#64748b;padding:6px;';
      more.textContent = `+${items.length - 24} more…`;
      listEl.appendChild(more);
    }
  }

  async function awaitAdminDecision(options = {}) {
    const requestId = options.requestId;
    const fileName = options.fileName || 'file';
    const requestKind = options.requestKind || 'upload_request';
    const pii = options.pii || null;
    if (!requestId) return { action: 'close' };

    try {
      const existing = document.getElementById('__ai_upload_guardian_inline_review_host');
      if (existing) existing.remove();
    } catch (_) {}

    const host = createHost();
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; }
      .modal {
        width: 680px; max-width: calc(100vw - 28px);
        border-radius: 18px; overflow: hidden;
        background: #fff; color: #0f172a;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 24px 70px rgba(0,0,0,0.55);
      }
      .head { background:#dc2626; color:#fff; padding:16px 18px; }
      .headTitle { font-size:28px; font-weight:800; line-height:1.1; margin:0; }
      .headSub { margin-top:6px; font-size:14px; opacity:.95; }
      .headFile { margin-top:8px; font-size:16px; font-weight:700; }
      .body { padding:16px 18px 10px; }
      .alert { border-radius:14px; background:#fff1f2; border:1px solid #fecdd3; padding:12px 14px; }
      .alertTitle { margin:0; font-size:20px; font-weight:800; color:#b91c1c; }
      .alertDesc { margin-top:6px; font-size:14px; color:#991b1b; }
      .section { margin-top:12px; font-size:11px; letter-spacing:.08em; font-weight:900; color:#64748b; }
      .list {
        margin-top:8px; border-radius:14px; background:#f8fafc; border:1px solid #e2e8f0;
        padding:8px; max-height:160px; overflow:auto;
      }
      .item {
        background:#fff; border:1px solid #e2e8f0; border-radius:12px;
        padding:8px 10px; display:flex; align-items:flex-start; gap:10px; margin-bottom:8px;
      }
      .pill {
        padding:5px 10px; border-radius:999px; font-size:11px; font-weight:800;
        border:1px solid #e2e8f0; background:#eef2ff; color:#4338ca; flex:0 0 auto; white-space:nowrap;
      }
      .pill.blue { background:#dbeafe; color:#1d4ed8; border-color:#bfdbfe; }
      .pill.cyan { background:#cffafe; color:#0e7490; border-color:#a5f3fc; }
      .pill.violet { background:#ede9fe; color:#6d28d9; border-color:#ddd6fe; }
      .pill.amber { background:#fef3c7; color:#92400e; border-color:#fde68a; }
      .pill.rose { background:#ffe4e6; color:#be123c; border-color:#fecdd3; }
      .item-main { min-width:0; }
      .item-value { font-size:13px; font-weight:700; color:#0f172a; word-break:break-word; }
      .item-sub { margin-top:2px; font-size:11px; color:#94a3b8; }
      .footer { display:flex; gap:12px; padding:14px 18px 18px; border-top:1px solid #e2e8f0; }
      .btn { cursor:pointer; border:none; border-radius:14px; padding:12px 14px; font-size:14px; font-weight:800; min-width:200px; }
      .btn-secondary { background:#fff; border:1px solid #e2e8f0; color:#334155; }
      .btn-primary { background:#dc2626; color:#fff; }
      .btn-primary:hover { background:#b91c1c; }
    `;

    const root = document.createElement('div');
    root.className = 'modal';
    root.innerHTML = `
      <div class="head">
        <div id="headTitle" class="headTitle">Admin Review Pending</div>
        <div id="headSub" class="headSub">Your request is waiting for approval.</div>
        <div class="headFile">${fileName}</div>
      </div>
      <div class="body">
        <div class="alert">
          <div id="alertTitle" class="alertTitle">Waiting for admin...</div>
          <div id="alertDesc" class="alertDesc">We received your request. Please wait until the admin approves or blocks it.</div>
        </div>
        <div class="section">DETECTED SENSITIVE DATA</div>
        <div id="piiList" class="list"></div>
      </div>
      <div id="footer" class="footer">
        <button id="closeBtn" class="btn btn-secondary">Close</button>
      </div>
    `;
    shadow.appendChild(style);
    shadow.appendChild(root);
    document.documentElement.appendChild(host);
    fillAdminModalPiiList(shadow, pii);

    const headTitle = shadow.getElementById('headTitle');
    const headSub = shadow.getElementById('headSub');
    const alertTitle = shadow.getElementById('alertTitle');
    const alertDesc = shadow.getElementById('alertDesc');
    const footer = shadow.getElementById('footer');
    const closeBtn = shadow.getElementById('closeBtn');

    let status = 'pending';
    let latestAutofixResult = '';
    let pollTimer = null;
    let pollAborted = false;
    let resolver;

    function cleanup() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      try { host.remove(); } catch (_) {}
    }

    function setPending() {
      status = 'pending';
      headTitle.textContent = 'Admin Review Pending';
      headSub.textContent =
        requestKind === 'autofix_request'
          ? 'Your AutoFix request is waiting for admin.'
          : 'Your request is waiting for approval.';
      alertTitle.textContent = 'Waiting for admin...';
      alertDesc.textContent =
        requestKind === 'autofix_request'
          ? 'We sent this file to AutoFix. Wait until the admin completes it or blocks it.'
          : 'We received your request. Please wait until the admin approves or blocks it.';
      footer.innerHTML = '<button id="closeBtn" class="btn btn-secondary">Close</button>';
      shadow.getElementById('closeBtn').addEventListener('click', () => {
        cleanup();
        resolver({ action: 'close' });
      });
    }

    function setApproved(autofixResult) {
      status = 'approved';
      latestAutofixResult = String(autofixResult || '');
      headTitle.textContent = requestKind === 'autofix_request' ? 'AutoFix Accepted' : 'Upload Accepted';
      headSub.textContent =
        requestKind === 'autofix_request'
          ? 'Admin completed AutoFix for this file.'
          : 'Admin approved this upload.';
      alertTitle.textContent = requestKind === 'autofix_request' ? 'You can upload now' : 'You can upload now';
      alertDesc.textContent =
        requestKind === 'autofix_request'
          ? 'Admin fixed text is ready. Use Upload the file to send the sanitized copy.'
          : 'Choose the upload option below.';
      footer.innerHTML =
        '<button id="dismissBtn" class="btn btn-secondary">Dismiss upload</button><button id="uploadBtn" class="btn btn-primary">Upload the file</button>';
      shadow.getElementById('dismissBtn').addEventListener('click', () => {
        cleanup();
        resolver({ action: 'close' });
      });
      shadow.getElementById('uploadBtn').addEventListener('click', () => {
        cleanup();
        if (requestKind === 'autofix_request') {
          resolver({
            action: 'allow',
            autofixResult: latestAutofixResult
          });
        } else {
          resolver({ action: 'allow' });
        }
      });
    }

    function setBlocked() {
      status = 'blocked';
      headTitle.textContent = 'Request Blocked';
      headSub.textContent = 'Admin blocked this request.';
      alertTitle.textContent = 'Upload is blocked';
      alertDesc.textContent = 'You cannot proceed with this file upload.';
      footer.innerHTML = '<button id="closeBtn" class="btn btn-secondary">Close</button>';
      shadow.getElementById('closeBtn').addEventListener('click', () => {
        cleanup();
        resolver({ action: 'close' });
      });
    }

    const resultPromise = new Promise((resolve) => { resolver = resolve; });
    closeBtn.addEventListener('click', () => {
      cleanup();
      resolver({ action: 'close' });
    });

    async function pollOnce() {
      const resp = await fetchAdminRequest(requestId);
      if (resp?.success === false && resp?.code === 'NOT_ONBOARDED') {
        try {
          window.alert(CONNECT_FIRST_ALERT);
        } catch (_) {}
        pollAborted = true;
        cleanup();
        resolver({ action: 'close' });
        return;
      }
      const req = resp?.request || null;
      if (!req) return;
      if (requestKind === 'autofix_request') {
        if (req.status === 'blocked') {
          if (status !== 'blocked') setBlocked();
          return;
        }
        const af = String(req.autofixStatus || 'none');
        if (af === 'completed') {
          if (status !== 'approved') setApproved(req.autofixResult || '');
          return;
        }
        if (status !== 'pending') setPending();
        return;
      }
      if (!req.status) return;
      if (req.status === status) return;
      if (req.status === 'approved') setApproved();
      else if (req.status === 'blocked') setBlocked();
      else setPending();
    }

    await pollOnce();
    if (!pollAborted) {
      pollTimer = setInterval(pollOnce, 2000);
    }
    return await resultPromise;
  }

  window.AIUploadGuardianReview = { open, awaitAdminDecision };
})();
