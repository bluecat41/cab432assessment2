// backend/server.js
import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import helmet from "helmet";
import morgan from "morgan";

import { hydrateEnvFromParameterStore } from "./aws/ssm-config.js";
import { hydrateEnvFromSecretsManager } from "./aws/secrets.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Make sure we have a region to talk to SSM first time
process.env.AWS_REGION ??= "ap-southeast-2";

// 1) SSM (via GetParameter per name)
await hydrateEnvFromParameterStore();

// 2) Secrets Manager (Cognito client secret)
await hydrateEnvFromSecretsManager();

// 3) Import routes AFTER hydration
const { ensureVideoMetadataTable } = await import("./aws/initDynamo.js");
const { default: s3UploadRoutes }  = await import("./aws/s3_uploads.js");
const authMod                      = await import("./routes/auth_cognito.js");
const authRouter                   = authMod.default;
const { authRequired }             = authMod;
const { default: transcodeRoutes } = await import("./routes/transcode.js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "connect-src": ["'self'", "https://*.s3.ap-southeast-2.amazonaws.com"],
      "img-src": ["'self'", "data:", "blob:", "https://*.s3.ap-southeast-2.amazonaws.com"],
      "media-src": ["'self'", "blob:", "https://*.s3.ap-southeast-2.amazonaws.com"],
    }
  }
}));
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("tiny"));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api", authRouter);
app.use("/api/s3",        authRequired(), s3UploadRoutes);
app.use("/api/transcode", authRequired(), transcodeRoutes);
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

await ensureVideoMetadataTable();
app.listen(PORT, () => console.log(`✅ Server listening on :${PORT}`));
