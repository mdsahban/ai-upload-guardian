// utils/regexPatterns.js
// Centralized regex patterns for PII detection.

const REGEX_PATTERNS = {
  email: /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,

  phone: /(\+?\d{1,3}[-\s]?)?(\d{3,5}[-\s]?\d{4,8})/g,

  passwordHint: /\b(password|passwd|pwd|secret|pin)\s*[:=]\s*([^\s,;]+)/gi,

  apiKey: /\b([A-Za-z0-9_\-]{20,})\b/g,

  creditCard: /\b(?:\d[ -]*?){13,19}\b/g,

  aadhaar: /\b(\d{4}\s?\d{4}\s?\d{4})\b/g,

  bankAccount: /\b(\d{9,18})\b/g,


  // These two are based on common document label patterns used in exports/tests,
  // e.g. "Name: Rahul Sharma" and "Address: New Delhi, India".
  // They can be extended later with stronger NLP/ML if needed.
  fullName: /\b(?:full\s*name|employee\s*name|name)\s*[:=]\s*([A-Za-z]+(?:\s+[A-Za-z]+){1,3})/gi,
  address: /\b(?:address|addr\s*ess|addres)\s*[:=]\s*([^\n]{6,120})/gi
};

