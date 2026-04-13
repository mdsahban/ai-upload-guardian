// libraries/tess/worker-proxy.js
// Patch fetch() inside the Tesseract worker to avoid CSP failures on sites
// that block connect-src to data: URLs.
//
// The bundled `tesseract-core-*.wasm.js` files may call:
//   fetch("data:application/octet-stream;base64,...")
// which triggers page CSP in some environments. We intercept those calls and
// return a Response built from decoded bytes instead of calling native fetch.

(function () {
  const NativeResponse = self.Response;
  const nativeFetch = self.fetch ? self.fetch.bind(self) : null;

  function isBase64WasmDataUrl(url) {
    return (
      typeof url === 'string' &&
      url.startsWith('data:application/octet-stream;base64,')
    );
  }

  function decodeBase64ToBytes(b64) {
    // atob() is available in WorkerGlobalScope in Chromium
    const bin = self.atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  if (nativeFetch && NativeResponse) {
    self.fetch = function patchedFetch(input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      if (isBase64WasmDataUrl(url)) {
        try {
          const b64 = url.split(',', 2)[1] || '';
          const bytes = decodeBase64ToBytes(b64);
          return Promise.resolve(
            new NativeResponse(bytes, {
              status: 200,
              headers: { 'Content-Type': 'application/wasm' }
            })
          );
        } catch (e) {
          // Fall through to native fetch (will likely fail, but preserves behavior)
        }
      }
      return nativeFetch(input, init);
    };
  }

  // Load the official Tesseract worker after patching.
  // This file lives next to worker.min.js, so relative import works.
  importScripts('./worker.min.js');
})();

