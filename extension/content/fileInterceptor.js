// content/fileInterceptor.js — Admin edition: local review UI + admin queue events.

(() => {
  const SUPPORTED_SUFFIXES = [
    'chat.openai.com',
    'chatgpt.com',
    'gemini.google.com',
    'claude.ai'
  ];

  const host = window.location.hostname;
  const isSupported = SUPPORTED_SUFFIXES.some((suffix) =>
    host === suffix || host.endsWith(`.${suffix}`)
  );

  if (!isSupported) {
    return;
  }

  console.log('[AI Upload Guardian Admin] Content script active on', host);

  let bypassNextDropOnce = false;

  const directFixWaiters = new Map();

  function createFixedTextFile(originalFile, fixedText) {
    try {
      const name = originalFile?.name || 'fixed';
      const base = String(name).replace(/\.[^/.]+$/, '');
      const fixedName = `${base}_sanitized.txt`;
      return new File([fixedText || ''], fixedName, { type: 'text/plain' });
    } catch (_) {
      return null;
    }
  }

  function downloadTextAsFile(text, downloadName) {
    try {
      const blob = new Blob([text || ''], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName || 'sanitized.txt';
      a.rel = 'noopener';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      console.warn('[AI Upload Guardian Admin] download failed', e);
    }
  }

  const settingsDefaults = {
    aiug_enableImages: true,
    aiug_enablePdf: true,
    aiug_enableTextFiles: true
  };

  const CONNECT_FIRST_ALERT =
    'AI Upload Guardian\n\nFinish connecting before you can upload or send files for admin review.\n\n' +
    '1. Click the extension icon in your toolbar\n' +
    '2. Enter your work email and invite code\n' +
    '3. Click Connect\n\n' +
    'Then try your upload again.';

  function showConnectFirstPopup() {
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

  async function reportToAdminQueue(analysis, kind) {
    try {
      const requestKind = kind || 'upload_request';
      const shouldSendAutofixText = requestKind === 'autofix_request';
      const fullText = String(analysis?.fullExtractedText || '');
      const body = {
        host: window.location.hostname,
        fileName: analysis?.fileName || 'document',
        fileType: analysis?.fileType || '',
        riskScore: Number(analysis?.riskScore || 0),
        pii: analysis?.pii || null,
        createdAt: Date.now(),
        kind: requestKind,
        // Keep request->modal transition fast by avoiding huge payloads unless required.
        autofixInputText: shouldSendAutofixText ? fullText.slice(0, 300000) : ''
      };
      const resp = await sendAdminRequest(body);
      if (resp && resp.success === false && resp.code === 'NOT_ONBOARDED') {
        showConnectFirstPopup();
        return null;
      }
      return resp?.request || null;
    } catch (_) {}
    return null;
  }
  const settings = { ...settingsDefaults };

  if (chrome?.storage?.sync) {
    chrome.storage.sync.get(settingsDefaults, (items) => {
      Object.assign(settings, items || {});
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const key of Object.keys(settingsDefaults)) {
        if (key in changes) {
          settings[key] = changes[key].newValue;
        }
      }
    });
  }

  function isFileTypeEnabled(file) {
    const name = file?.name || '';
    const ext = getExtension(name);
    const mime = String(file?.type || '').toLowerCase();
    if (ext === 'pdf' || mime === 'application/pdf') return !!settings.aiug_enablePdf;
    if (
      ext === 'png' ||
      ext === 'jpg' ||
      ext === 'jpeg' ||
      ext === 'webp' ||
      mime.startsWith('image/')
    ) {
      return !!settings.aiug_enableImages;
    }
    return !!settings.aiug_enableTextFiles;
  }

  async function analyzeFilesLocally(files) {
    const file = files[0];
    if (!isFileTypeEnabled(file)) {
      return {
        fileName: file.name,
        fileType: file.type || guessMimeTypeFromName(file.name),
        textSample: '',
        fullExtractedText: '',
        pii: {
          emails: [],
          phones: [],
          passwords: [],
          creditCards: [],
          apiKeys: [],
          aadhaarNumbers: [],
          bankAccounts: []
        },
        riskScore: 0,
        disabledBySettings: true
      };
    }
    try {
      const text = await extractTextFromFile(file);
      const pii = detectPII(text);
      const riskScore = scoreRisk(pii);

      return {
        fileName: file.name,
        fileType: file.type || guessMimeTypeFromName(file.name),
        textSample: text.slice(0, 2000),
        fullExtractedText: text,
        pii,
        riskScore
      };
    } catch (err) {
      console.warn(
        '[AI Upload Guardian Admin] analyzeFilesLocally failed',
        err && err.name,
        err && err.message
      );

      return {
        fileName: file.name,
        fileType: file.type || guessMimeTypeFromName(file.name),
        textSample: '',
        fullExtractedText: '',
        pii: {
          emails: [],
          phones: [],
          passwords: [],
          creditCards: [],
          apiKeys: [],
          aadhaarNumbers: [],
          bankAccounts: []
        },
        riskScore: 0,
        error: err && (err.message || String(err))
      };
    }
  }

  async function reviewInTab(analysis) {
    if (!window.AIUploadGuardianReview?.open) {
      throw new Error('Inline review UI not available');
    }
    return await window.AIUploadGuardianReview.open(analysis, { mode: 'upload' });
  }

  async function awaitAdminDecisionInTab(request, analysis, kind) {
    if (!window.AIUploadGuardianReview?.awaitAdminDecision) {
      return { action: 'close' };
    }
    return await window.AIUploadGuardianReview.awaitAdminDecision({
      requestId: request?.requestId || '',
      fileName: analysis?.fileName || 'file',
      requestKind: kind || 'upload_request',
      pii: analysis?.pii ?? null
    });
  }

  function newSessionId() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return `s_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  async function beginDirectFixFromUpload(analysis, inputEl, files, source) {
    const sessionId = newSessionId();
    const fullText = analysis?.fullExtractedText || analysis?.textSample || '';

    await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'stashDirectFixSession',
            payload: {
              sessionId,
              fullText,
              pii: analysis?.pii || null,
              fileName: analysis?.fileName || 'document',
              source: source || 'input'
            }
          },
          () => resolve()
        );
      } catch (_) {
        resolve();
      }
    });

    directFixWaiters.set(sessionId, { inputEl, files, source: source || 'input' });

    try {
      chrome.runtime.sendMessage({ type: 'openDirectFixPopup', sessionId });
    } catch (e) {
      console.warn('[AI Upload Guardian Admin] openDirectFixPopup failed', e);
    }
  }

  function replayChangeEvent(input, files) {
    try {
      const dataTransfer = new DataTransfer();
      files.forEach((f) => dataTransfer.items.add(f));
      input.files = dataTransfer.files;
    } catch (e) {
      console.warn('Unable to reset files on input', e);
    }

    input.__aiUploadGuardianBypass = true;
    try {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_) {}
    const event = new Event('change', { bubbles: true });
    input.dispatchEvent(event);
  }

  function isVisibleElement(el) {
    if (!(el instanceof HTMLElement)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function pickLiveFileInput(originalInput) {
    if (originalInput && document.contains(originalInput)) return originalInput;
    const all = Array.from(document.querySelectorAll('input[type="file"]'));
    const available = all.filter((el) => !el.disabled && document.contains(el));
    if (!available.length) return null;
    if (!originalInput) {
      return available.find((el) => isVisibleElement(el)) || available[0];
    }
    const score = (el) => {
      let s = 0;
      if (el.id && originalInput.id && el.id === originalInput.id) s += 20;
      if (el.name && originalInput.name && el.name === originalInput.name) s += 12;
      if ((el.accept || '') === (originalInput.accept || '')) s += 8;
      if (!!el.multiple === !!originalInput.multiple) s += 4;
      if (isVisibleElement(el)) s += 2;
      return s;
    };
    let best = available[0];
    let bestScore = score(best);
    for (let i = 1; i < available.length; i++) {
      const sc = score(available[i]);
      if (sc > bestScore) {
        best = available[i];
        bestScore = sc;
      }
    }
    return best;
  }

  function clearFileInput(input) {
    try {
      input.value = '';
    } catch (e) {
      console.warn('Unable to clear file input', e);
    }
  }

  document.addEventListener(
    'change',
    async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.type !== 'file') return;

      if (target.__aiUploadGuardianBypass) {
        delete target.__aiUploadGuardianBypass;
        return;
      }

      const files = Array.from(target.files || []);
      if (!files.length) return;

      console.log(
        '[AI Upload Guardian Admin] Intercepted file input change, files:',
        files.map((f) => f.name)
      );

      event.stopImmediatePropagation();
      event.preventDefault();

      try {
        const analysis = await analyzeFilesLocally(files);
        const decision = await reviewInTab(analysis);

        if (decision === 'request_upload') {
          const req = await reportToAdminQueue(analysis, 'upload_request');
          if (!req) {
            clearFileInput(target);
            return;
          }
          const adminDecision = await awaitAdminDecisionInTab(
            req,
            analysis,
            'upload_request'
          );
          if (adminDecision?.action === 'allow') {
            const liveTarget = pickLiveFileInput(target);
            if (liveTarget) replayChangeEvent(liveTarget, files);
            else clearFileInput(target);
          } else {
            clearFileInput(target);
          }
        } else if (decision === 'request_autofix') {
          const req = await reportToAdminQueue(analysis, 'autofix_request');
          if (!req) {
            clearFileInput(target);
            return;
          }
          const adminDecision = await awaitAdminDecisionInTab(
            req,
            analysis,
            'autofix_request'
          );
          if (adminDecision?.action === 'allow') {
            const liveTarget = pickLiveFileInput(target);
            if (!liveTarget) {
              clearFileInput(target);
              return;
            }
            const text =
              typeof adminDecision.autofixResult === 'string'
                ? adminDecision.autofixResult
                : '';
            const fixed = createFixedTextFile(files[0], text);
            if (fixed) {
              replayChangeEvent(liveTarget, [fixed]);
              return;
            }
          }
          clearFileInput(target);
        } else {
          clearFileInput(target);
        }
      } catch (err) {
        console.error('AI Upload Guardian Admin analysis/review failed', err);
        clearFileInput(target);
      }
    },
    true
  );

  if (chrome?.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== 'directFixApply') return;

      const p = message.payload || {};
      const sessionId = p.sessionId;
      if (!sessionId) return;

      const entry = directFixWaiters.get(sessionId);
      directFixWaiters.delete(sessionId);

      const text = p.sanitizedText || '';
      const src = p.source || entry?.source || 'input';

      if (src === 'input' && entry?.inputEl) {
        const orig = entry.files?.[0];
        const fixed = createFixedTextFile(orig, text);
        if (fixed) {
          replayChangeEvent(entry.inputEl, [fixed]);
        }
        return;
      }

      if (src === 'drop') {
        const orig = entry?.files?.[0];
        const base = orig?.name
          ? String(orig.name).replace(/\.[^/.]+$/, '')
          : 'sanitized';
        downloadTextAsFile(text, `${base}_sanitized.txt`);
      }
    });
  }

  document.addEventListener(
    'drop',
    async (event) => {
      const dt = event.dataTransfer;
      if (!dt || !dt.files || dt.files.length === 0) return;

      if (bypassNextDropOnce) {
        bypassNextDropOnce = false;
        console.log(
          '[AI Upload Guardian Admin] Bypassing drop interception after user approval.'
        );
        return;
      }

      const files = Array.from(dt.files);
      console.log(
        '[AI Upload Guardian Admin] Intercepted file drop, files:',
        files.map((f) => f.name)
      );

      event.stopImmediatePropagation();
      event.preventDefault();

      try {
        const analysis = await analyzeFilesLocally(files);
        const decision = await reviewInTab(analysis);

        if (decision === 'request_upload') {
          const req = await reportToAdminQueue(analysis, 'upload_request');
          if (!req) return;
          const adminDecision = await awaitAdminDecisionInTab(
            req,
            analysis,
            'upload_request'
          );
          if (adminDecision?.action === 'allow') {
            bypassNextDropOnce = true;
            console.log(
              '[AI Upload Guardian Admin] Upload approved; drop file again to continue.'
            );
          }
        } else if (decision === 'request_autofix') {
          const req = await reportToAdminQueue(analysis, 'autofix_request');
          if (!req) return;
          const adminDecision = await awaitAdminDecisionInTab(
            req,
            analysis,
            'autofix_request'
          );
          if (adminDecision?.action === 'allow') {
            const text =
              typeof adminDecision.autofixResult === 'string'
                ? adminDecision.autofixResult
                : '';
            const orig = files[0];
            const base = orig?.name
              ? String(orig.name).replace(/\.[^/.]+$/, '')
              : 'sanitized';
            downloadTextAsFile(text, `${base}_sanitized.txt`);
          }
        }
      } catch (err) {
        console.error(
          '[AI Upload Guardian Admin] Drop analysis/review failed',
          err
        );
      }
    },
    true
  );
})();
