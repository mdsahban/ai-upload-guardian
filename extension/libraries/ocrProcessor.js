// libraries/ocrProcessor.js
// Offline OCR (Tesseract) bundled with the extension — no third‑party OCR APIs.
// Optional high‑accuracy mode: stronger preprocessing + higher render scale for PDF pages.

function getTessBaseUrl() {
  try {
    const rt =
      (typeof globalThis !== 'undefined' && globalThis.chrome && globalThis.chrome.runtime) ||
      (typeof globalThis !== 'undefined' && globalThis.browser && globalThis.browser.runtime) ||
      (typeof chrome !== 'undefined' && chrome.runtime) ||
      (typeof browser !== 'undefined' && browser.runtime);

    if (rt && typeof rt.getURL === 'function') {
      const u = rt.getURL('/');
      return u.endsWith('/') ? u : u + '/';
    }
  } catch (e) {}
  return '';
}

async function getExtractionFlags() {
  if (globalThis.AIUploadGuardianExtraction?.getExtractionConfig) {
    return await globalThis.AIUploadGuardianExtraction.getExtractionConfig();
  }
  return { highAccuracy: true, localOnly: true };
}

function preprocessCanvasForOcr(canvas, highAccuracy) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  try {
    const imageData = ctx.getImageData(0, 0, width, height);
    const d = imageData.data;
    const gamma = highAccuracy ? 0.85 : 0.9;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i];
      let g = d[i + 1];
      let b = d[i + 2];
      if (highAccuracy) {
        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        const n = gray / 255;
        const boosted = Math.pow(n, gamma);
        const v = Math.max(0, Math.min(255, Math.round(boosted * 255)));
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
      } else {
        d[i] = adjustChannel(r, gamma);
        d[i + 1] = adjustChannel(g, gamma);
        d[i + 2] = adjustChannel(b, gamma);
      }
      d[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  } catch (_) {}
}

function adjustChannel(v, gamma) {
  const norm = v / 255;
  const boosted = Math.pow(norm, gamma);
  return Math.max(0, Math.min(255, Math.round(boosted * 255)));
}

async function createTesseractWorker() {
  if (typeof Tesseract === 'undefined') {
    console.warn('[AI Upload Guardian] Tesseract not loaded; OCR disabled.');
    return null;
  }
  const base = getTessBaseUrl();
  if (!base) {
    console.warn('[AI Upload Guardian] Extension URL not available for OCR.');
    return null;
  }
  const workerPath = base + 'libraries/tess/worker-proxy.js';
  const workerPathDirect = base + 'libraries/tess/worker.min.js';
  const corePath = base + 'libraries/tess/core/';
  const langPath = base + 'libraries/tess/lang/';
  try {
    return await Tesseract.createWorker('eng', 3, {
      workerPath,
      corePath,
      langPath,
      workerBlobURL: true
    });
  } catch (err) {
    console.warn('[AI Upload Guardian] OCR init via worker-proxy failed, trying worker.min.js', err && err.message);
    try {
      return await Tesseract.createWorker('eng', 3, {
        workerPath: workerPathDirect,
        corePath,
        langPath,
        workerBlobURL: true
      });
    } catch (err2) {
      console.warn('[AI Upload Guardian] OCR local init failed, retrying fallback lang source.', err2 && err2.message);
      try {
        // Last fallback: local worker/core, default langPath resolution.
        return await Tesseract.createWorker('eng', 3, {
          workerPath: workerPathDirect,
          corePath,
          workerBlobURL: true
        });
      } catch (err3) {
        console.warn(
          '[AI Upload Guardian] OCR worker failed after fallback (missing tess files?). See libraries/tess/README.md.',
          err3 && err3.message
        );
        return null;
      }
    }
  }
}

async function recognizeCanvas(worker, canvas, highAccuracy) {
  preprocessCanvasForOcr(canvas, highAccuracy);
  const psm = Tesseract.PSM ? Tesseract.PSM.AUTO : undefined;
  const opts = {};
  if (psm !== undefined) opts.tessedit_pageseg_mode = psm;
  const { data } = await worker.recognize(canvas, opts);
  return data && data.text ? String(data.text) : '';
}

async function recognizeCanvasRaw(worker, canvas, sparse) {
  const opts = {};
  if (Tesseract.PSM) {
    opts.tessedit_pageseg_mode = sparse ? Tesseract.PSM.SPARSE_TEXT : Tesseract.PSM.AUTO;
  }
  const { data } = await worker.recognize(canvas, opts);
  return data && data.text ? String(data.text) : '';
}

/**
 * Renders one pdf.js page to canvas and runs OCR (local only).
 */
async function ocrPdfJsPage(pdfPage, worker, highAccuracy) {
  const baseScale = highAccuracy ? 2.0 : 1.6;
  let viewport = pdfPage.getViewport({ scale: baseScale });
  const maxDim = highAccuracy ? 2800 : 2200;
  const maxSide = Math.max(viewport.width, viewport.height);
  if (maxSide > maxDim) {
    const fit = maxDim / maxSide;
    viewport = pdfPage.getViewport({ scale: baseScale * fit });
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const renderTask = pdfPage.render({ canvasContext: ctx, viewport });
  if (renderTask && typeof renderTask.promise !== 'undefined') {
    await renderTask.promise;
  } else if (renderTask && typeof renderTask.then === 'function') {
    await renderTask;
  }
  return await recognizeCanvas(worker, canvas, highAccuracy);
}

async function loadImageFromFile(file) {
  if (typeof createImageBitmap === 'function') {
    const blob = file instanceof Blob ? file : new Blob([await file.arrayBuffer()]);
    return await createImageBitmap(blob);
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

async function extractTextFromImage(file) {
  if (typeof Tesseract === 'undefined') {
    console.warn('[AI Upload Guardian] Tesseract not loaded; image OCR disabled.');
    return '';
  }

  const { highAccuracy } = await getExtractionFlags();
  const maxDim = highAccuracy ? 2400 : 1600;

  const worker = await createTesseractWorker();
  if (!worker) return '';

  try {
    const image = await loadImageFromFile(file);
    const canvas = document.createElement('canvas');
    let { width, height } = image;
    if (width > maxDim || height > maxDim) {
      const s = Math.min(maxDim / width, maxDim / height);
      width = Math.round(width * s);
      height = Math.round(height * s);
    } else if (highAccuracy && Math.max(width, height) < 1200) {
      // Upscale small screenshots to improve OCR readability.
      const s = 1200 / Math.max(width, height);
      width = Math.round(width * s);
      height = Math.round(height * s);
    }
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      await worker.terminate();
      return '';
    }
    ctx.drawImage(image, 0, 0, width, height);

    // Pass 1: raw pixels (best for already clean screenshots).
    let text = await recognizeCanvasRaw(worker, canvas, false);

    // Pass 2: preprocessed pixels if raw pass is too short.
    if ((text || '').trim().length < 20) {
      text = await recognizeCanvas(worker, canvas, highAccuracy);
    }

    // Pass 3: sparse mode for scattered UI text.
    if ((text || '').trim().length < 20) {
      text = await recognizeCanvasRaw(worker, canvas, true);
    }

    await worker.terminate();
    return text;
  } catch (err) {
    try {
      await worker.terminate();
    } catch (_) {}
    console.warn('[AI Upload Guardian] Image OCR failed', err && err.message);
    return '';
  }
}

/**
 * Hybrid PDF: merge text layer + OCR only for pages where the text layer is thin.
 * All work stays in the extension process (local).
 */
async function extractHybridPdfText(pdfDocument, textByPage, options) {
  const { highAccuracy, maxPages } = options;
  const threshold = highAccuracy ? 48 : 28;

  const n = Math.min(textByPage.length, maxPages);
  let needsOcr = false;
  for (let i = 0; i < n; i++) {
    if ((textByPage[i] || '').trim().length < threshold) {
      needsOcr = true;
      break;
    }
  }
  if (!needsOcr) {
    return textByPage.slice(0, n).join('\n');
  }

  const worker = await createTesseractWorker();
  if (!worker) {
    return textByPage.slice(0, n).join('\n');
  }

  const out = [];
  try {
    for (let i = 0; i < n; i++) {
      const layer = (textByPage[i] || '').trim();
      if (layer.length >= threshold) {
        out.push(textByPage[i]);
        continue;
      }
      try {
        const page = await pdfDocument.getPage(i + 1);
        const ocr = await ocrPdfJsPage(page, worker, highAccuracy);
        const use =
          ocr && ocr.trim().length > layer.length ? ocr : textByPage[i] || '';
        out.push(use);
      } catch (e) {
        out.push(textByPage[i] || '');
      }
    }
    return out.join('\n');
  } finally {
    try {
      await worker.terminate();
    } catch (_) {}
  }
}

globalThis.AIUploadGuardianOCR = {
  extractTextFromImage,
  extractHybridPdfText,
  ocrPdfJsPage
};
