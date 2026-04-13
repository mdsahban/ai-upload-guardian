import express from "express";
import cors from "cors";
import { createProxyMiddleware } from "http-proxy-middleware";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const FASTAPI_URL = process.env.FASTAPI_URL || "http://127.0.0.1:8000";

const app = express();
const allowedBrowserOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
]);
const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedBrowserOrigins.has(origin)) return callback(null, true);
    if (origin.startsWith("chrome-extension://")) return callback(null, true);
    callback(null, false);
  },
  credentials: true
};

app.use(cors(corsOptions));
// Ensure CORS headers are present for preflight requests (OPTIONS).
app.options("*", cors(corsOptions));

// Proxy all API calls to FastAPI
app.use(
  "/api",
  createProxyMiddleware({
    target: FASTAPI_URL,
    changeOrigin: true,
    pathRewrite: { "^/api": "" }
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, fastapi: FASTAPI_URL });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[aiug-admin-gateway] listening on http://localhost:${PORT}`);
});

