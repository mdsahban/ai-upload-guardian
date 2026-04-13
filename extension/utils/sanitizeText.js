// utils/sanitizeText.js
// Client-side PII masking (mask / pseudonymize / tokenize) for chat and popup preview.

function toFlexibleWsPattern(s) {
  const norm = String(s || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!norm) return '';
  const parts = norm.split(' ');
  return parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
}

function maskDigitsPreserveSeparators(raw, keepFirst, keepLast, maskChar) {
  const mc = maskChar || '*';
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return raw;

  const total = digits.length;
  const kf = Math.max(0, Math.min(keepFirst, total));
  const kl = Math.max(0, Math.min(keepLast, total - kf));

  let digitI = 0;
  const out = [];
  for (const ch of String(raw)) {
    if (/\d/.test(ch)) {
      const pos = digitI;
      if (pos < kf || pos >= total - kl) out.push(ch);
      else out.push(mc);
      digitI += 1;
    } else {
      out.push(ch);
    }
  }
  return out.join('');
}

function maskLast4Like(raw, maskChar) {
  return maskDigitsPreserveSeparators(raw, 0, 4, maskChar || 'X');
}

function maskPhoneLike(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 8) return maskLast4Like(raw, '*');
  return maskDigitsPreserveSeparators(raw, 2, 2, '*');
}

function maskPasswordLike(raw) {
  const m = String(raw || '').match(/([^A-Za-z0-9])\s*$/);
  const suffix = m ? m[1] : '';
  return `PASSWORD_REDACTED${suffix}`;
}

function maskApiKeyLike(raw) {
  const m = String(raw || '').match(/([^A-Za-z0-9])\s*$/);
  const suffix = m ? m[1] : '';
  return `API_KEY_REDACTED${suffix}`;
}

function maskPiiValue(kind, raw) {
  if (kind === 'phones') return maskPhoneLike(raw);
  if (kind === 'creditCards') return maskLast4Like(raw, '*');
  if (kind === 'aadhaarNumbers')
    return maskDigitsPreserveSeparators(raw, 0, 4, 'X');
  if (kind === 'bankAccounts') return maskLast4Like(raw, 'X');
  if (kind === 'passwords') return maskPasswordLike(raw);
  if (kind === 'apiKeys') return maskApiKeyLike(raw);
  return String(raw || '').replace(/\d/g, 'X');
}

function parseEmailDomain(email) {
  const parts = String(email || '').split('@', 2);
  return parts.length === 2 ? parts[1] : 'anon.com';
}

function pseudonymFromHex(hkey) {
  const n = parseInt(String(hkey || '').slice(0, 10), 16) % 1000000;
  return String(n).padStart(6, '0');
}

function kindToTokenPrefix(kind) {
  const m = {
    emails: 'EMAIL',
    phones: 'PHONE',
    passwords: 'PASS',
    creditCards: 'CC',
    apiKeys: 'APIKEY',
    aadhaarNumbers: 'AADHAAR',
    bankAccounts: 'BANK',
    fullNames: 'NAME',
    addresses: 'ADDR'
  };
  return m[kind] || 'PII';
}

/**
 * @param {string} text
 * @param {Record<string, string[]>|null} pii
 * @param {'data_masking'|'pseudonymization'|'tokenization'|'encryption'} mode
 * @param {string} [secret] - optional salt for deterministic pseudonyms
 * @returns {Promise<{ sanitized: string, report: Array<{entityType:string,technique:string,confidence:number}> }>}
 */
async function sanitizeTextWithPii(text, pii, mode, secret) {
  if (!text) return { sanitized: '', report: [] };

  const sanitizationType = mode || 'data_masking';
  const entries = [];
  if (pii && typeof pii === 'object') {
    for (const [k, arr] of Object.entries(pii)) {
      if (!Array.isArray(arr)) continue;
      for (const v of arr) {
        if (typeof v === 'string' && v.trim()) entries.push([k, v.trim()]);
      }
    }
  }

  const entriesSorted = entries
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 500);

  const tokenCounters = {};

  async function hmacHex(entityType, rawValue) {
    const sec = String(secret || 'aiug-admin-extension-local');
    const norm = String(rawValue)
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
    const msg = `${entityType}|${norm}`;
    const enc = new TextEncoder();
    const keyRaw = enc.encode(sec);
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyRaw,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      enc.encode(msg)
    );
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async function pseudonymPiiValue(kind, raw) {
    const h = await hmacHex(kind, raw);
    const num = pseudonymFromHex(h);
    if (kind === 'emails') {
      const domain = parseEmailDomain(raw);
      const alias = `user${num.slice(0, 3)}`;
      return `${alias}@${domain}`;
    }
    if (kind === 'fullNames') return `User_${num.slice(0, 3)}`;
    if (kind === 'addresses') return `Address_${num.slice(0, 3)}`;
    return maskPiiValue(kind, raw);
  }

  async function getReplacement(kind, rawValue) {
    if (sanitizationType === 'encryption') {
      return { text: '[ENCRYPTED]', technique: 'encryption' };
    }
    if (sanitizationType === 'tokenization') {
      const prefix = kindToTokenPrefix(kind);
      tokenCounters[kind] = (tokenCounters[kind] || 0) + 1;
      const n = tokenCounters[kind];
      return { text: `[${prefix}_${n}]`, technique: 'tokenization' };
    }
    if (sanitizationType === 'data_masking') {
      return { text: maskPiiValue(kind, rawValue), technique: 'masking' };
    }
    if (['emails', 'fullNames', 'addresses'].includes(kind)) {
      const r = await pseudonymPiiValue(kind, rawValue);
      return { text: r, technique: 'pseudonymization' };
    }
    return { text: maskPiiValue(kind, rawValue), technique: 'masking' };
  }

  let sanitized = text;
  const report = [];

  for (const [kind, rawValue] of entriesSorted) {
    const pattern = toFlexibleWsPattern(rawValue);
    if (!pattern) continue;
    const { text: replacement, technique } = await getReplacement(
      kind,
      rawValue
    );
    report.push({
      entityType: kind,
      technique,
      confidence: 0.9
    });
    const re = new RegExp(pattern, 'gi');
    sanitized = sanitized.replace(re, replacement);
  }

  return { sanitized, report };
}
