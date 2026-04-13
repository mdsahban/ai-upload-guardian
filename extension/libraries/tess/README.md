# Offline OCR (Tesseract.js) for AI Upload Guardian (User)

Image uploads are scanned for text via OCR. Only when that text contains **emails, phones, passwords, credit cards, API keys, etc.** does the extension show a risk warning. To run OCR fully **offline** (no CDN, no CSP issues), put the following files here.

## 1. Worker script

**Save as:** `worker.min.js` (in this folder: `extension-user/libraries/tess/`)

**Direct download:**
- https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js  
  → Right‑click → Save As… → `worker.min.js` in `libraries/tess/`

## 2. Core files (all 4 required)

**Save into:** `extension-user/libraries/tess/core/`

Create the `core` subfolder, then download each file into it:

| File | URL |
|------|-----|
| tesseract-core.wasm.js | https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core.wasm.js |
| tesseract-core-simd.wasm.js | https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd.wasm.js |
| tesseract-core-lstm.wasm.js | https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-lstm.wasm.js |
| tesseract-core-simd-lstm.wasm.js | https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js |

## 3. Language data (English)

**Save into:** `extension-user/libraries/tess/lang/`

Create the `lang` subfolder, then download:

- **File:** `eng.traineddata.gz`  
- **URL:** https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz  
  → Save as `eng.traineddata.gz` in `libraries/tess/lang/`

## Final layout

```
extension-user/libraries/tess/
├── README.md
├── worker.min.js
├── core/
│   ├── tesseract-core.wasm.js
│   ├── tesseract-core-simd.wasm.js
│   ├── tesseract-core-lstm.wasm.js
│   └── tesseract-core-simd-lstm.wasm.js
└── lang/
    └── eng.traineddata.gz
```

## After adding the files

1. Reload the extension in `chrome://extensions`.
2. Refresh ChatGPT (or Gemini / Claude).
3. Upload an image that contains visible text (e.g. a screenshot with an email or password).
4. The review modal should show **extracted text and risk** only when PII is detected in the OCR result.

All processing stays **local**; no data is sent to any server.
