// backend/server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import helmet from 'helmet';
import morgan from 'morgan';
import { fileURLToPath } from 'url';

import { ensureVideoMetadataTable } from './aws/initDynamo.js';
import s3UploadRoutes from './aws/s3_uploads.js';
import authRouter, { authRequired } from './routes/auth_cognito.js';
import transcodeRoutes from './routes/transcode.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('tiny'));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Auth and protected APIs
app.use('/api', authRouter);
app.use('/api/s3',        authRequired(), s3UploadRoutes);
app.use('/api/transcode', authRequired(), transcodeRoutes);

// JSON 404 for other /api/* paths
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Bootstraps
await ensureVideoMetadataTable();

app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
