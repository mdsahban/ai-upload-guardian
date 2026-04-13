// analyzer/analyzerWorker.js
// Web Worker: file -> text -> PII -> risk (off main thread).

importScripts(
  '../utils/fileUtils.js',
  '../utils/regexPatterns.js',
  './textExtractor.js',
  './piiDetector.js',
  './riskScorer.js',
  '../libraries/pdfParser.js',
  '../libraries/docxParser.js',
  '../libraries/ocrProcessor.js'
);

self.onmessage = async (e) => {
  const { type, files } = e.data || {};

  if (type !== 'analyzeFiles' || !files || !files.length) {
    self.postMessage({ success: false, error: 'Invalid worker message' });
    return;
  }

  try {
    const file = files[0];

    const text = await extractTextFromFile(file);
    const pii = detectPII(text);
    const riskScore = scoreRisk(pii);

    const analysis = {
      fileName: file.name,
      fileType: file.type || guessMimeTypeFromName(file.name),
      textSample: text.slice(0, 2000),
      pii,
      riskScore
    };

    self.postMessage({ success: true, analysis });
  } catch (err) {
    console.error('Analyzer worker error', err);
    self.postMessage({
      success: false,
      error: err && err.message ? err.message : String(err)
    });
  }
};

