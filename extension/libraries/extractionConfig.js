// libraries/extractionConfig.js
// Local-only extraction settings (no network; all processing stays in the extension).
// - High accuracy: slower, stronger preprocessing + OCR fallback for sparse PDFs.

(function initExtractionConfig() {
  const DEFAULTS = {
    aiug_highAccuracyExtraction: true,
    /** When true, extraction never calls third-party OCR APIs (enforced in code). */
    aiug_localExtractionOnly: true
  };

  function getExtractionConfig() {
    return new Promise((resolve) => {
      if (!chrome?.storage?.sync) {
        resolve({
          highAccuracy: DEFAULTS.aiug_highAccuracyExtraction,
          localOnly: DEFAULTS.aiug_localExtractionOnly
        });
        return;
      }
      chrome.storage.sync.get(DEFAULTS, (items) => {
        resolve({
          highAccuracy: !!items?.aiug_highAccuracyExtraction,
          localOnly: !!items?.aiug_localExtractionOnly
        });
      });
    });
  }

  globalThis.AIUploadGuardianExtraction = {
    getExtractionConfig,
    DEFAULTS
  };
})();
