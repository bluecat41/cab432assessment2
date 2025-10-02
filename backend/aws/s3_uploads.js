// backend/routes/s3_uploads.js
import express from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const router = express.Router();

const REGION    = process.env.AWS_REGION || 'ap-southeast-2';
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = (process.env.S3_PREFIX || 'videos').replace(/\/+$/, '');

const s3 = new S3Client({ region: REGION });

function ownerKeyFromReq(req) {
  const k = req.user?.identityKey || req.user?.email;
  if (!k) throw new Error('Missing identity in token');
  return k.toLowerCase();
}
function sanitizeName(name = 'upload.bin') {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '_');
}

/**
 * POST /api/s3/presign-upload
 * Body: { filename, contentType }
 * Returns: { uploadUrl, key, bucket, expiresIn }
 */
router.post('/presign-upload', async (req, res) => {
  try {
    const ownerKey = ownerKeyFromReq(req);
    const { filename, contentType } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const ts  = Date.now();
    const key = `${S3_PREFIX}/${encodeURIComponent(ownerKey)}/uploads/${ts}-${sanitizeName(filename)}`;

    const cmd = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: contentType || 'application/octet-stream',
      Metadata: { 'original-filename': filename }
    });

    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 600 }); // 10 mins
    res.json({ uploadUrl, key, bucket: S3_BUCKET, expiresIn: 600 });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
