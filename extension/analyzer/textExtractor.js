// analyzer/textExtractor.js
// Converts supported file types into raw text for analysis (images: Tesseract.js in-page).

async function extractTextFromFile(file) {
  const extension = getExtension(file.name);
  const mime = String(file?.type || '').toLowerCase();
  const isPdf = extension === 'pdf' || mime === 'application/pdf';
  const isDocx =
    extension === 'docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const isImage =
    extension === 'png' ||
    extension === 'jpg' ||
    extension === 'jpeg' ||
    extension === 'webp' ||
    mime.startsWith('image/');

  if (extension === 'txt' || extension === 'csv' || extension === 'json') {
      return await file.text();
  }

  switch (true) {
    case isPdf:
      try {
        return await extractTextFromPdf(file);
      } catch (e) {
        console.warn('PDF extraction failed, falling back to raw text()', e);
        return await file.text().catch(() => '');
      }

    case isDocx:
      try {
        return await extractTextFromDocx(file);
      } catch (e) {
        console.warn('DOCX extraction failed, falling back to raw text()', e);
        return await file.text().catch(() => '');
      }

    case isImage:
      try {
        return await extractTextFromImage(file);
      } catch (e) {
        console.warn('Image OCR failed, returning empty text', e);
        return '';
      }

    default:
      return await file.text().catch(() => '');
  }
}
