// analyzer/riskScorer.js
// Computes an overall risk score from detected PII.

const RISK_WEIGHTS = {
  email: 10,
  phone: 10,
  password: 40,
  creditCard: 50,
  apiKey: 50,
  aadhaar: 40,
  bankAccount: 40,
  fullName: 20,
  address: 25
};

function scoreRisk(piiResult) {
  if (!piiResult) return 0;

  let score = 0;

  score += (piiResult.emails?.length || 0) * RISK_WEIGHTS.email;
  score += (piiResult.phones?.length || 0) * RISK_WEIGHTS.phone;
  score += (piiResult.passwords?.length || 0) * RISK_WEIGHTS.password;
  score += (piiResult.creditCards?.length || 0) * RISK_WEIGHTS.creditCard;
  score += (piiResult.apiKeys?.length || 0) * RISK_WEIGHTS.apiKey;
  score += (piiResult.aadhaarNumbers?.length || 0) * RISK_WEIGHTS.aadhaar;
  score += (piiResult.bankAccounts?.length || 0) * RISK_WEIGHTS.bankAccount;
  score += (piiResult.fullNames?.length || 0) * RISK_WEIGHTS.fullName;
  score += (piiResult.addresses?.length || 0) * RISK_WEIGHTS.address;

  return Math.min(score, 1000);
}

