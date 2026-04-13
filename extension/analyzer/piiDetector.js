// analyzer/piiDetector.js
// Regex-based PII detection using patterns from REGEX_PATTERNS.

function detectPII(text) {
  if (!text) {
    return {
      emails: [],
      phones: [],
      passwords: [],
      creditCards: [],
      apiKeys: [],
      aadhaarNumbers: [],
      bankAccounts: [],
      fullNames: [],
      addresses: []
    };
  }

  const emails = matchAllUnique(text, REGEX_PATTERNS.email);
  // Filter further to avoid random numeric tokens (e.g. "4" or "987")
  const phonesRaw = matchAllUnique(text, REGEX_PATTERNS.phone);
  const phones = phonesRaw.filter((p) => p.replace(/[^\d]/g, '').length >= 10);
  const passwords = matchAllUnique(text, REGEX_PATTERNS.passwordHint);

  const rawCreditCards = matchAllUnique(text, REGEX_PATTERNS.creditCard);
  const creditCards = rawCreditCards.filter((cc) =>
    luhnCheckDigits(cc.replace(/[^\d]/g, ''))
  );

  const apiKeys = matchAllUnique(text, REGEX_PATTERNS.apiKey);
  const aadhaarNumbers = matchAllUnique(text, REGEX_PATTERNS.aadhaar);
  const bankAccounts = matchAllUnique(text, REGEX_PATTERNS.bankAccount);

  const fullNames = matchAllUnique(text, REGEX_PATTERNS.fullName);
  const addresses = matchAllUnique(text, REGEX_PATTERNS.address);

  return {
    emails,
    phones,
    passwords,
    creditCards,
    apiKeys,
    aadhaarNumbers,
    bankAccounts,
    fullNames,
    addresses
  };
}

function matchAllUnique(text, regex) {
  const values = new Set();
  if (!regex) return [];

  const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
  const r = new RegExp(regex.source, flags);

  let m;
  while ((m = r.exec(text)) !== null) {
    // Prefer captured groups over the full match, but pick the *most informative*
    // one (longest non-empty group). This avoids cases where regexes have an
    // optional prefix group (e.g. country code) and we accidentally return that
    // short prefix instead of the full value.
    const groups = m
      .slice(1)
      .map((s) => (s || '').trim())
      .filter(Boolean);

    const value =
      (groups.length
        ? groups.sort((a, b) => b.length - a.length)[0]
        : (m[0] || '').trim()) || '';

    if (value) values.add(value);
  }

  return Array.from(values);
}

// Basic Luhn check for credit card-like numbers
function luhnCheckDigits(numStr) {
  if (!/^\d{12,19}$/.test(numStr)) return false;

  let sum = 0;
  let shouldDouble = false;

  for (let i = numStr.length - 1; i >= 0; i--) {
    let digit = parseInt(numStr[i], 10);
    if (Number.isNaN(digit)) return false;

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

