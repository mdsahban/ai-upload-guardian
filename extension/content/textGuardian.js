// content/textGuardian.js
// Watches chat input typing/paste and notifies on sensitive data.

(() => {
  const SUPPORTED_SUFFIXES = [
    'chat.openai.com',
    'chatgpt.com',
    'gemini.google.com',
    'claude.ai'
  ];

  const host = window.location.hostname;
  const isSupported = SUPPORTED_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
  if (!isSupported) return;

  if (typeof detectPII !== 'function' || typeof scoreRisk !== 'function') {
    console.warn('[AI Upload Guardian] PII modules not available for text guard.');
    return;
  }

  const MIN_TEXT_LEN = 20;
  const DEBOUNCE_MS = 800;
  const NOTIFY_COOLDOWN_MS = 1500;
  const APPROVAL_TTL_MS = 2 * 60 * 1000; // 2 minutes

  let lastText = '';
  let lastNotifyAt = 0;
  let debounceTimer = null;
  let lastAnalysis = null; // last computed analysis for click-to-open
  let lastTextboxEl = null;
  let lastTextHash = null;
  const approvedHashes = new Map(); // textHash -> expiresAt
  const reportedChatHashes = new Map(); // textHash -> reportedAt
  const REPORT_CHAT_TTL_MS = 60 * 1000;
  let lastConnectAlertAt = 0;

  const CONNECT_FIRST_ALERT =
    'AI Upload Guardian\n\nFinish connecting before chat can be sent for admin review.\n\n' +
    '1. Click the extension icon\n' +
    '2. Enter your work email and invite code\n' +
    '3. Click Connect';

  function maybeShowConnectAlert() {
    const now = Date.now();
    if (now - lastConnectAlertAt < 120000) return;
    lastConnectAlertAt = now;
    try {
      window.alert(CONNECT_FIRST_ALERT);
    } catch (_) {}
  }

  async function sendAdminRequest(payload) {
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

  async function reportChatToAdmin(analysis) {
    try {
      const text = analysis?.fullText || '';
      if (!text) return;
      const hash = hashText(text);
      const lastReportedAt = reportedChatHashes.get(hash) || 0;
      if (Date.now() - lastReportedAt < REPORT_CHAT_TTL_MS) return;

      const full = String(text || '');
      const resp = await sendAdminRequest({
        host: window.location.hostname,
        fileName: 'Chat message text',
        fileType: 'text/plain',
        riskScore: Number(analysis?.riskScore || 0),
        pii: analysis?.pii || null,
        createdAt: Date.now(),
        kind: 'chat_message_request',
        autofixInputText: full.slice(0, 300000)
      });
      if (resp && resp.success === false && resp.code === 'NOT_ONBOARDED') {
        maybeShowConnectAlert();
        return;
      }
      if (!resp || resp.success === false) return;
      reportedChatHashes.set(hash, Date.now());
    } catch (_) {}
  }

  function hashText(str) {
    // djb2
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h) ^ str.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }

  function isApprovedForText(text) {
    const hash = hashText(text);
    const expiresAt = approvedHashes.get(hash);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      approvedHashes.delete(hash);
      return false;
    }
    return true;
  }

  function getTextboxText(el) {
    if (!el) return '';
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      return el.value || '';
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      return el.innerText || '';
    }
    return '';
  }

  function isTextboxElement(el) {
    if (!(el instanceof Element)) return false;
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement && el.type === 'text') return true;
    if (el instanceof HTMLElement && el.isContentEditable) {
      // Avoid catching random contenteditable regions.
      const role = el.getAttribute('role');
      if (role === 'textbox' || role === 'combobox' || role === 'searchbox') return true;
      const testId = el.getAttribute('data-testid') || '';
      const id = el.id || '';
      return (
        testId.toLowerCase().includes('prompt') ||
        id.toLowerCase().includes('prompt') ||
        el.getAttribute('aria-multiline') === 'true'
      );
    }
    return false;
  }

  function computeTextAnalysis(text) {
    const pii = detectPII(text);
    const riskScore = scoreRisk(pii);

    return {
      contextType: 'chatText',
      fileName: 'Chat message text',
      fileType: 'text/plain',
      textSample: text.slice(0, 2000),
      fullText: text,
      pii,
      riskScore
    };
  }

  function shouldNotify(analysis) {
    if (!analysis) return false;
    const pii = analysis.pii || {};
    const any =
      (pii.emails?.length || 0) +
        (pii.phones?.length || 0) +
        (pii.passwords?.length || 0) +
        (pii.creditCards?.length || 0) +
        (pii.apiKeys?.length || 0) +
        (pii.aadhaarNumbers?.length || 0) +
      (pii.bankAccounts?.length || 0) +
      (pii.fullNames?.length || 0) +
      (pii.addresses?.length || 0) >
      0;
    return any && (analysis.riskScore || 0) > 0;
  }

  function riskLabel(score) {
    const s = Math.max(0, Math.min(Number(score) || 0, 1000));
    if (s >= 700) return 'High';
    if (s >= 400) return 'Medium';
    return 'Low';
  }

  // ---------- In-page notification (toast) ----------
  let toastRoot = null;
  let toastHost = null;

  function ensureToast() {
    if (toastRoot) return;

    toastHost = document.createElement('div');
    toastHost.id = '__ai_upload_guardian_toast_host';
    toastHost.style.position = 'fixed';
    toastHost.style.right = '14px';
    toastHost.style.top = '14px';
    toastHost.style.zIndex = '2147483647';
    toastHost.style.pointerEvents = 'none';

    const shadow = toastHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .toast {
        pointer-events: auto;
        width: 320px;
        border-radius: 14px;
        border: 1px solid #fecdd3;
        background: #ffffff;
        color: #0f172a;
        box-shadow: 0 10px 30px rgba(0,0,0,0.45);
        padding: 10px 12px;
        transform: translateY(-10px);
        opacity: 0;
        transition: opacity 160ms ease, transform 160ms ease;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .toast.show {
        opacity: 1;
        transform: translateY(0);
      }
      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .title {
        font-size: 13px;
        font-weight: 800;
        color: #b91c1c;
        margin: 0;
      }
      .meta {
        font-size: 11px;
        color: #991b1b;
        margin-top: 2px;
      }
      .badge {
        font-size: 11px;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid #fecdd3;
        background: #fff1f2;
        color: #b91c1c;
        white-space: nowrap;
      }
      .actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      button {
        cursor: pointer;
        border: none;
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 600;
      }
      .btn-primary {
        background: #dc2626;
        color: #ffffff;
      }
      .btn-ghost {
        background: #ffffff;
        color: #334155;
        border: 1px solid #e2e8f0;
      }
      .btn-ghost:hover { background: #f8fafc; }
    `;

    toastRoot = document.createElement('div');
    toastRoot.className = 'toast';
    toastRoot.innerHTML = `
      <div class="row">
        <div>
          <div class="title">Sensitive data detected</div>
          <div class="meta" id="meta">Sending is blocked until you review and approve.</div>
        </div>
        <div id="badge" class="badge">Low risk</div>
      </div>
      <div class="actions">
        <button id="reviewBtn" class="btn-primary">Review</button>
        <button id="dismissBtn" class="btn-ghost">Dismiss</button>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(toastRoot);
    document.documentElement.appendChild(toastHost);

    const reviewBtn = shadow.getElementById('reviewBtn');
    const dismissBtn = shadow.getElementById('dismissBtn');

    reviewBtn.addEventListener('click', () => {
      openInlineReviewForCurrentText();
    });
    dismissBtn.addEventListener('click', hideToast);
  }

  function showToast(levelText, metaText) {
    ensureToast();
    const badge = toastHost.shadowRoot.getElementById('badge');
    if (badge) badge.textContent = `${levelText} risk`;
    const meta = toastHost.shadowRoot.getElementById('meta');
    if (meta && metaText) meta.textContent = metaText;
    toastRoot.classList.add('show');
  }

  function hideToast() {
    if (!toastRoot) return;
    toastRoot.classList.remove('show');
  }

  async function openInlineReviewForCurrentText() {
    if (!lastAnalysis) return;
    if (!window.AIUploadGuardianReview?.open) return;

    hideToast();
    const el = getActiveTextbox();
    const decision = await window.AIUploadGuardianReview.open(lastAnalysis, {
      mode: 'chat',
      textboxElement: el
    });

    if (decision === 'approve') {
      const text = el ? getTextboxText(el) : lastText;
      const hash = hashText(text || '');
      approvedHashes.set(hash, Date.now() + APPROVAL_TTL_MS);
      showToast('Low', 'Approved. Press Send/Enter again to send your message.');
      setTimeout(() => hideToast(), 1800);
      return;
    }

    if (decision === 'sanitize_applied') {
      const newText = el ? getTextboxText(el) : '';
      lastText = newText;
      lastAnalysis = computeTextAnalysis(newText);
      showToast('Low', 'Message sanitized. Review and send when ready.');
      setTimeout(() => hideToast(), 2200);
    }
  }

  // ---------- Event handling ----------
  function scheduleAnalyze(el) {
    lastTextboxEl = el;
    const text = getTextboxText(el);
    if (text === lastText) return;
    lastText = text;
    lastTextHash = hashText(text || '');

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (lastText.length < MIN_TEXT_LEN) {
        hideToast();
        lastAnalysis = null;
        return;
      }

      const analysis = computeTextAnalysis(lastText);
      lastAnalysis = analysis;

      if (!shouldNotify(analysis)) {
        hideToast();
        return;
      }

      const now = Date.now();
      if (now - lastNotifyAt < NOTIFY_COOLDOWN_MS) return;
      lastNotifyAt = now;

      showToast(riskLabel(analysis.riskScore));
    }, DEBOUNCE_MS);
  }

  function getActiveTextbox() {
    const active = document.activeElement;
    if (isTextboxElement(active)) return active;
    if (lastTextboxEl && document.contains(lastTextboxEl)) return lastTextboxEl;
    return null;
  }

  function maybeBlockSend(reason, event) {
    const el = getActiveTextbox();
    if (!el) return false;

    const text = getTextboxText(el);
    if (!text || text.length < MIN_TEXT_LEN) return false;

    const analysis = computeTextAnalysis(text);
    lastAnalysis = analysis;
    lastTextboxEl = el;
    lastText = text;
    lastTextHash = hashText(text);

    if (!shouldNotify(analysis)) return false;
    if (isApprovedForText(text)) return false;

    try {
      event?.stopImmediatePropagation?.();
      event?.preventDefault?.();
    } catch (_) {}

    showToast(
      riskLabel(analysis.riskScore),
      `Sending blocked (${reason}). Review and approve before sending.`
    );
    // Immediately open inline review so the user sees details without extra click.
    openInlineReviewForCurrentText();
    return true;
  }

  // Intercept Enter-to-send
  document.addEventListener(
    'keydown',
    (event) => {
      // Typical chat send behavior is Enter (without Shift).
      if (event.key !== 'Enter') return;
      if (event.shiftKey) return;
      if (event.isComposing) return;
      maybeBlockSend('Enter', event);
    },
    true
  );

  // Intercept submit events (some UIs submit a form)
  document.addEventListener(
    'submit',
    (event) => {
      maybeBlockSend('submit', event);
    },
    true
  );

  // Intercept clicks on "Send" buttons
  document.addEventListener(
    'click',
    (event) => {
      const btn = event.target?.closest?.('button');
      if (!btn) return;
      const label =
        (btn.getAttribute('aria-label') ||
          btn.getAttribute('title') ||
          btn.textContent ||
          '')
          .trim()
          .toLowerCase();

      const looksLikeSend =
        btn.type === 'submit' ||
        label === 'send' ||
        label.includes('send message') ||
        label.includes('send');

      if (!looksLikeSend) return;
      maybeBlockSend('Send click', event);
    },
    true
  );

  // Receive approval from popup via background
  // (approval is handled by the in-tab review modal)

  document.addEventListener(
    'input',
    (event) => {
      const el = event.target;
      if (!isTextboxElement(el)) return;
      scheduleAnalyze(el);
    },
    true
  );

  document.addEventListener(
    'paste',
    (event) => {
      const el = event.target;
      if (!isTextboxElement(el)) return;
      // Analyze after paste is applied to the element.
      setTimeout(() => scheduleAnalyze(el), 0);
    },
    true
  );
})();

