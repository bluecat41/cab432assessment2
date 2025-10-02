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

/** Always force the download name to the target extension (don’t use the original ext) */
function makeDownloadName(originalName, forcedExt = 'mp4') {
  const base = path.basename(originalName || 'video', path.extname(originalName || ''));
  const clean = (base || 'video').replace(/[^\w.-]+/g, '_').slice(0, 100) || 'video';
  return `${clean}.${String(forcedExt || 'mp4').toLowerCase()}`;
}

// --- Transcode helpers ---
function normalizeExt(fmt) {
  const e = String(fmt || 'mp4').toLowerCase();
  return ['mp4', 'webm', 'mov'].includes(e) ? e : 'mp4';
}
function buildFfmpegArgs(inputPath, ext, outPath) {
  if (ext === 'mp4') {
    return [
      '-y', '-hide_banner',
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '192k',
      '-f', 'mp4',
      outPath
    ];
  }
  if (ext === 'webm') {
    return [
      '-y', '-hide_banner',
      '-i', inputPath,
      '-c:v', 'libvpx-vp9',
      '-b:v', '0', '-crf', '30',
      '-c:a', 'libopus',
      '-f', 'webm',
      outPath
    ];
  }
  // MOV output
  return [
    '-y', '-hide_banner',
    '-i', inputPath,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-f', 'mov',
    outPath
  ];
}

// --- DDB helpers (PK fixed, SK = videoId composite) ---
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

// --- ffprobe helpers ---
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
    originalSizeBytes,
    uploadedAt
  } = req.body || {};
  if (!s3Key) return res.status(400).json({ error: 's3Key required' });

  const id        = newId();
  const ext       = normalizeExt(format || 'mp4');
  const inputPath = path.join(tmpDir, `${id}.src`);
  const outPath   = path.join(tmpDir, `${id}.out.${ext}`);

  const nowIso = new Date().toISOString();
  const uploadedAtIso = uploadedAt && !isNaN(new Date(uploadedAt))
    ? new Date(uploadedAt).toISOString()
    : nowIso;

  await putMeta(ownerKey, ownerEmail, id, {
    originalFilename: originalFilename || 'upload',
    sourceBucket: S3_BUCKET,
    sourceKey: s3Key,
    status: 'queued',
    progress: 0,
    outputFormat: ext,
    originalSizeBytes: Number.isFinite(Number(originalSizeBytes)) ? Number(originalSizeBytes) : null,
    uploadedAt: uploadedAtIso,
    createdAt: nowIso
  });

  try {
    // Download source
    await patchMeta(ownerKey, id, { status: 'downloading', progress: 5 });
    const srcObj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
    const s3Len = typeof srcObj.ContentLength === 'number' ? srcObj.ContentLength : null;
    const s3UploadedAt = srcObj.LastModified instanceof Date ? srcObj.LastModified.toISOString() : null;
    if (s3Len != null || s3UploadedAt) {
      await patchMeta(ownerKey, id, {
        inputSizeBytes: s3Len ?? null,
        ...(s3UploadedAt && uploadedAt == null ? { uploadedAt: s3UploadedAt } : {})
      });
    }
    await new Promise((resolve, reject) => {
      const w = fs.createWriteStream(inputPath);
      srcObj.Body.on('error', reject).pipe(w).on('error', reject).on('finish', resolve);
    });

    // Transcode (force container & flags)
    await patchMeta(ownerKey, id, { status: 'processing', progress: 20 });
    const ffmpegArgs = buildFfmpegArgs(inputPath, ext, outPath);
    console.log('🔧 ffmpeg args:', ffmpegArgs.join(' '));
    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', ffmpegArgs);
      p.on('error', reject);
      p.stderr.on('data', () => {});
      p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + code)));
    });

    // Probe output
    try {
      const probe = await ffprobeJSON(outPath);
      const meta  = extractVideoMeta(probe);
      if (ext === 'mp4' && probe?.format?.format_name && !/mp4|isom/i.test(probe.format.format_name)) {
        console.warn('⚠️ Expected MP4 container but got:', probe.format.format_name);
      }
      await patchMeta(ownerKey, id, { ...meta, progress: 80 });
    } catch (e) {
      console.warn('ffprobe failed:', e?.message || e);
    }

    // Upload output (force download filename to target ext)
    await patchMeta(ownerKey, id, { status: 'uploading', progress: 85 });
    const outKey = outKeyFor(ownerKey, id, ext);
    const stat   = fs.statSync(outPath);
    const downloadName = makeDownloadName(originalFilename, ext);
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: outKey,
      Body: fs.createReadStream(outPath),
      ContentType: ext === 'mp4' ? 'video/mp4'
        : ext === 'webm' ? 'video/webm'
        : ext === 'mov' ? 'video/quicktime'
        : 'application/octet-stream',
      ContentDisposition: `attachment; filename="${downloadName}"`,
      Metadata: { 'original-filename': originalFilename || 'upload' }
    }));

    await patchMeta(ownerKey, id, {
      status: 'done',
      progress: 100,
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
    const extFromKey = path.extname(item.s3Key || '').slice(1) || (item.outputFormat || 'mp4');
    const downloadName = makeDownloadName(item.originalFilename, extFromKey);

    const cmd = new GetObjectCommand({
      Bucket: item.s3Bucket,
      Key: item.s3Key,
      // Force correct filename extension on download
      ResponseContentDisposition: `attachment; filename="${downloadName}"`
    });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 600 }); // 10 mins
    res.json({ downloadUrl: url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
