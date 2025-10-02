// backend/routes/transcode.js
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFile } from 'child_process';

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const router = express.Router();

const REGION       = process.env.AWS_REGION || 'ap-southeast-2';
const S3_BUCKET    = process.env.S3_BUCKET;
const S3_PREFIX    = (process.env.S3_PREFIX || 'videos').replace(/\/+$/,'');
const TABLE        = process.env.DDB_TABLE  || 'n8870349_VideoMetadata';
const FIXED_PK_VAL = process.env.QUT_USERNAME || 'n8870349@qut.edu.au';

const s3  = new S3Client({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const tmpDir = path.join(os.tmpdir(), 'transcoder');
fs.mkdirSync(tmpDir, { recursive: true });

function newId() { return String(Date.now()) + '-' + Math.floor(Math.random() * 1e6); }
function guessExt(fmt) { return (fmt || 'mp4').toLowerCase(); }
function ownerKeyFromReq(req) {
  const k = req.user?.identityKey || req.user?.email;
  if (!k) throw new Error('Missing identity in token');
  return k.toLowerCase();
}
function composeVideoId(ownerKey, id) { return `${ownerKey}#${id}`; }
function outKeyFor(ownerKey, id, ext) {
  const safe = encodeURIComponent(ownerKey);
  return `${S3_PREFIX}/${safe}/${id}/output.${ext}`;
}
function safeFilename(name, fallbackExt = 'mp4') {
  const ext = path.extname(name || '')?.slice(1) || fallbackExt;
  const base = path
    .basename(name || `video.${ext}`, '.' + ext)
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 100) || 'video';
  return `${base}.${ext}`;
}

// DDB helpers (PK fixed, SK = videoId composite)
async function putMeta(ownerKey, ownerEmail, id, item) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      'qut-username': FIXED_PK_VAL,
      videoId: composeVideoId(ownerKey, id),
      id,
      ownerKey,
      ...(ownerEmail ? { ownerEmail } : {}),
      ...item
    }
  }));
}
async function patchMeta(ownerKey, id, updates) {
  const names = {}, values = {}, sets = [];
  let i = 0;
  for (const [k, v] of Object.entries(updates)) {
    if (k === 'qut-username' || k === 'videoId') continue;
    const nk = `#k${i}`, nv = `:v${i}`;
    names[nk] = k; values[nv] = v; sets.push(`${nk} = ${nv}`); i++;
  }
  if (!sets.length) return;
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { 'qut-username': FIXED_PK_VAL, videoId: composeVideoId(ownerKey, id) },
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  }));
}
async function getMeta(ownerKey, id) {
  const r = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { 'qut-username': FIXED_PK_VAL, videoId: composeVideoId(ownerKey, id) }
  }));
  return r.Item;
}

// ffprobe helpers
function ffprobeJSON(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath
    ], (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}
function extractVideoMeta(json) {
  const video = (json.streams || []).find(s => s.codec_type === 'video') || {};
  const audio = (json.streams || []).find(s => s.codec_type === 'audio') || {};
  const fmt   = json.format || {};
  let fps = null;
  if (video.avg_frame_rate && video.avg_frame_rate !== '0/0') {
    const [n, d] = video.avg_frame_rate.split('/').map(Number);
    if (n && d) fps = n / d;
  }
  const duration = (fmt.duration ? Number(fmt.duration) : (video.duration ? Number(video.duration) : null));
  const bitrate  = fmt.bit_rate ? Number(fmt.bit_rate) : null;
  return {
    width: video.width || null,
    height: video.height || null,
    codec: video.codec_name || null,
    audioCodec: audio.codec_name || null,
    fps: fps || null,
    duration: (Number.isFinite(duration) ? duration : null),
    bitrate: (Number.isFinite(bitrate) ? bitrate : null),
  };
}

/**
 * POST /api/transcode/start
 * Body: { s3Key, originalFilename, format, originalSizeBytes?, uploadedAt? }
 */
router.post('/start', async (req, res) => {
  let ownerKey, ownerEmail;
  try {
    ownerKey   = ownerKeyFromReq(req);
    ownerEmail = (req.user?.email || '').toLowerCase() || null;
  } catch (e) {
    return res.status(401).json({ error: e.message });
  }

  const {
    s3Key,
    originalFilename,
    format,
    originalSizeBytes,   // optional from client
    uploadedAt           // optional from client (ISO)
  } = req.body || {};
  if (!s3Key) return res.status(400).json({ error: 's3Key required' });

  const id        = newId();
  const ext       = guessExt(format || 'mp4');
  const inputPath = path.join(tmpDir, `${id}.src`);
  const outPath   = path.join(tmpDir, `${id}.out.${ext}`);

  // Normalize timestamps
  const nowIso = new Date().toISOString();
  const uploadedAtIso = uploadedAt && !isNaN(new Date(uploadedAt))
    ? new Date(uploadedAt).toISOString()
    : nowIso;

  // Initial metadata (queued state) with size & upload time if provided
  await putMeta(ownerKey, ownerEmail, id, {
    originalFilename: originalFilename || 'upload',
    sourceBucket: S3_BUCKET,
    sourceKey: s3Key,
    status: 'queued',
    progress: 0,
    outputFormat: ext,
    // NEW fields for the UI
    originalSizeBytes: Number.isFinite(Number(originalSizeBytes)) ? Number(originalSizeBytes) : null,
    uploadedAt: uploadedAtIso,
    createdAt: nowIso
  });

  try {
    // Download from S3
    await patchMeta(ownerKey, id, { status: 'downloading', progress: 5 });

    const srcObj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
    // If S3 gives us authoritative values, patch them in
    const s3Len = typeof srcObj.ContentLength === 'number' ? srcObj.ContentLength : null;
    const s3UploadedAt = srcObj.LastModified instanceof Date ? srcObj.LastModified.toISOString() : null;
    if (s3Len != null || s3UploadedAt) {
      await patchMeta(ownerKey, id, {
        inputSizeBytes: s3Len ?? null,
        // Only override if client did not provide
        ...(s3UploadedAt && uploadedAt == null ? { uploadedAt: s3UploadedAt } : {})
      });
    }

    await new Promise((resolve, reject) => {
      const w = fs.createWriteStream(inputPath);
      srcObj.Body.on('error', reject).pipe(w).on('error', reject).on('finish', resolve);
    });

    // Transcode
    await patchMeta(ownerKey, id, { status: 'processing', progress: 20 });
    const ffmpegArgs = ['-y','-i', inputPath, '-c:v', ext === 'webm' ? 'libvpx-vp9' : 'libx264', '-c:a', 'aac', outPath];
    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', ffmpegArgs);
      p.on('error', reject);
      p.stderr.on('data', () => {});
      p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + code)));
    });

    // Probe
    try {
      const probe = await ffprobeJSON(outPath);
      const meta  = extractVideoMeta(probe);
      await patchMeta(ownerKey, id, { ...meta, progress: 80 });
    } catch (e) {
      console.warn('ffprobe failed:', e?.message || e);
    }

    // Upload output
    await patchMeta(ownerKey, id, { status: 'uploading', progress: 85 });
    const outKey = outKeyFor(ownerKey, id, ext);
    const stat   = fs.statSync(outPath);
    const downloadName = safeFilename(originalFilename, ext); // <-- use original name for download
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: outKey,
      Body: fs.createReadStream(outPath),
      ContentType: ext === 'mp4' ? 'video/mp4'
        : ext === 'webm' ? 'video/webm'
        : ext === 'mov' ? 'video/quicktime'
        : 'application/octet-stream',
      ContentDisposition: `attachment; filename="${downloadName}"`, // <-- force download if hit directly
      Metadata: { 'original-filename': originalFilename || 'upload' }
    }));

    await patchMeta(ownerKey, id, {
      status: 'done',
      progress: 100,
      // Back-compat + clearer name
      fileSize: stat.size,
      outputSizeBytes: stat.size,
      s3Bucket: S3_BUCKET,
      s3Key: outKey,
      completedAt: new Date().toISOString()
    });

    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outPath); } catch {}

    res.json({ id, outputFormat: ext, ok: true });
  } catch (e) {
    await patchMeta(ownerKey, id, { status: 'error', progress: 0, error: e.message });
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outPath); } catch {}
    res.status(500).json({ error: 'Transcode failed', details: e.message, id });
  }
});

// STATUS
router.get('/status/:id', async (req, res) => {
  let ownerKey;
  try { ownerKey = ownerKeyFromReq(req); } catch (e) { return res.status(401).json({ error: e.message }); }
  const id = req.params.id;
  const item = await getMeta(ownerKey, id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({
    id,
    status: item.status || 'unknown',
    progress: item.progress || 0,
    outputFormat: item.outputFormat,
    error: item.error || null,
    // Extras (optional for your UI)
    uploadedAt: item.uploadedAt || null,
    originalSizeBytes: item.originalSizeBytes ?? item.inputSizeBytes ?? null,
    outputSizeBytes: item.outputSizeBytes ?? item.fileSize ?? null
  });
});

// LIST (user-scoped)
router.get('/list', async (req, res) => {
  try {
    const ownerKey = ownerKeyFromReq(req);
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: '#pk = :pk AND begins_with(#vid, :prefix)',
      ExpressionAttributeNames: { '#pk': 'qut-username', '#vid': 'videoId' },
      ExpressionAttributeValues: { ':pk': FIXED_PK_VAL, ':prefix': `${ownerKey}#` },
      ScanIndexForward: false
    }));
    // Return full items; front-end tolerates multiple name variants
    res.json(Array.isArray(r.Items) ? r.Items : []);
  } catch (err) {
    console.error('❌ list failed', err);
    res.status(500).json({ error: 'Failed to fetch transcode list', details: err.message });
  }
});

// PRESIGN download (GET)
router.get('/presign-download/:id', async (req, res) => {
  try {
    const ownerKey = ownerKeyFromReq(req);
    const id = req.params.id;
    const item = await getMeta(ownerKey, id);
    if (!item || item.status !== 'done' || !item.s3Bucket || !item.s3Key) {
      return res.status(404).json({ error: 'Not found or not ready' });
    }
    // Nice download name: prefer original filename + actual output ext
    const extFromKey = path.extname(item.s3Key || '').slice(1) || (item.outputFormat || 'mp4');
    const downloadName = safeFilename(item.originalFilename || `video.${extFromKey}`, extFromKey);

    const cmd = new GetObjectCommand({
      Bucket: item.s3Bucket,
      Key: item.s3Key,
      // Force download even if the object metadata lacked it
      ResponseContentDisposition: `attachment; filename="${downloadName}"`
    });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 600 }); // 10 mins
    res.json({ downloadUrl: url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
