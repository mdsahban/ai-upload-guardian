// libraries/pdfParser.js
// Hybrid PDF text: pdf.js text layer first, then local Tesseract OCR for thin pages.
// No network calls — extraction stays in the extension.

async function getExtractionFlags() {
  if (globalThis.AIUploadGuardianExtraction?.getExtractionConfig) {
    return await globalThis.AIUploadGuardianExtraction.getExtractionConfig();
  }
  return { highAccuracy: true, localOnly: true };
}

function extractPageTextFromContent(content) {
  const line = (content.items || [])
    .map((it) => (typeof it?.str === 'string' ? it.str : ''))
    .filter(Boolean)
    .join(' ');
  return line;
}

async function extractTextFromPdf(file) {
  try {
    if (typeof pdfjsLib === 'undefined' || !pdfjsLib?.getDocument) {
      console.warn('[AI Upload Guardian] pdfjsLib missing; add libraries/pdfjs/pdf.min.js before pdfParser in manifest.');
      return '';
    }

    try {
      const workerSrc =
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.getURL === 'function'
          ? chrome.runtime.getURL('libraries/pdfjs/pdf.worker.min.js')
          : '';
      if (workerSrc && pdfjsLib.GlobalWorkerOptions) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
      }
    } catch (_) {}

    const bytes = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({
      data: bytes,
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true
    });
    const pdf = await loadingTask.promise;

    const { highAccuracy } = await getExtractionFlags();
    const maxPages = Math.min(pdf.numPages || 0, highAccuracy ? 35 : 25);

    const textByPage = [];
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      textByPage.push(extractPageTextFromContent(content));
    }

    const layerOnly = textByPage.join('\n');
    const needsHybrid =
      typeof globalThis.AIUploadGuardianOCR?.extractHybridPdfText === 'function';

    if (!needsHybrid) {
      return layerOnly;
    }

    return await globalThis.AIUploadGuardianOCR.extractHybridPdfText(pdf, textByPage, {
      highAccuracy,
      maxPages
    });
  } catch (e) {
    console.warn('[AI Upload Guardian] PDF extraction failed', e && e.message);
    return '';
  }
}
