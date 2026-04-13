// libraries/docxParser.js
// Thin wrapper around mammoth.js for DOCX extraction.
//
// IMPORTANT:
// - You must bundle mammoth.js into this file or include it before this wrapper runs,
//   exposing a global `mammoth` object.
// - This wrapper will gracefully fall back to file.text() if mammoth is not available.

async function extractTextFromDocx(file) {
  if (typeof mammoth === 'undefined') {
    console.warn('mammoth not available, using raw file.text() as fallback');
    return await file.text().catch(() => '');
  }

  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result && result.value ? result.value : '';
}

