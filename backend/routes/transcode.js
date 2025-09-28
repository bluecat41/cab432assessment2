// backend/routes/transcode.js
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFile } from 'child_process';

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const router = express.Router();

const REGION       = process.env.AWS_REGION || 'ap-southeast-2';
const S3_BUCKET    = process.env.S3_BUCKET;
const S3_PREFIX    = (process.env.S3_PREFIX || 'videos').replace(/\/+$/,'');
const TABLE        = process.env.DDB_TABLE  || 'n8870349_VideoMetadata';
const FIXED_PK_VAL = process.env.QUT_USERNAME || 'n8870349@qut.edu.au'; // fixed PK

const s3  = new S3Client({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// multer temp
const tmpDir = path.join(os.tmpdir(), 'transcoder');
fs.mkdirSync(tmpDir, { recursive: true });
const upload = multer({ dest: tmpDir, limits: { fileSize: 1 * 1024 * 1024 * 1024 } });

// helpers
function newId() { return String(Date.now()) + '-' + Math.floor(Math.random() * 1e6); }
function guessExt(fmt) { return (fmt || 'mp4').toLowerCase(); }
function ownerKeyFromReq(req) {
  const k = req.user?.identityKey || req.user?.email;
  if (!k) throw new Error('Missing identity in token');
  return k.toLowerCase();
}
function composeVideoId(ownerKey, id) {
  return `${ownerKey}#${id}`;
}
function outKeyFor(ownerKey, id, ext) {
  const safe = encodeURIComponent(ownerKey);
  return `${S3_PREFIX}/${safe}/${id}/output.${ext}`;
}

// ddb helpers (PK fixed, SK=videoId composite)
async function putMeta(ownerKey, ownerEmail, id, item) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      'qut-username': FIXED_PK_VAL,              // PK (constant)
      videoId: composeVideoId(ownerKey, id),     // SK (composite)
      id,                                        // raw id for UI
      ownerKey,
      ...(ownerEmail ? { ownerEmail } : {}),
      createdAt: new Date().toISOString(),
      ...item
    }
  }));
}

async function patchMeta(ownerKey, id, updates) {
  const names = {}, values = {}, sets = [];
  let i = 0;
  for (const [k, v] of Object.entries(updates)) {
    if (k === 'qut-username' || k === 'videoId') continue; // never overwrite keys
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

// POST /api/transcode
router.post('/', upload.single('video'), async (req, res) => {
  let ownerKey, ownerEmail;
  try {
    ownerKey   = ownerKeyFromReq(req);          // e.g., email | username | sub
    ownerEmail = (req.user?.email || '').toLowerCase() || null;
  } catch (e) {
    return res.status(401).json({ error: e.message });
  }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const desiredFmt = (req.body?.format || 'mp4').toLowerCase();
  const id         = newId();

  // Define the variables that were previously missing:
  const inputPath  = req.file.path;
  const inputName  = req.file.originalname || 'upload';
  const ext        = guessExt(desiredFmt);
  const outPath    = path.join(tmpDir, `${id}.out.${ext}`);

  // seed metadata
  await putMeta(ownerKey, ownerEmail, id, {
    originalFilename: inputName,
    status: 'queued',
    progress: 0,
    outputFormat: ext,
    startedAt: new Date().toISOString()
  });

  const ffmpegArgs = [
    '-y',
    '-i', inputPath,
    '-c:v', ext === 'webm' ? 'libvpx-vp9' : 'libx264',
    '-c:a', 'aac',
    outPath
  ];

  try {
    await patchMeta(ownerKey, id, { status: 'processing', progress: 10 });

    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', ffmpegArgs);
      p.on('error', reject);
      p.stderr.on('data', () => {}); // parse progress here if desired
      p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + code)));
    });

    // Probe the output file to capture metadata
    try {
      const probe = await ffprobeJSON(outPath);
      const meta  = extractVideoMeta(probe);
      await patchMeta(ownerKey, id, { ...meta, outputFormat: ext, progress: 80 });
    } catch (probeErr) {
      console.warn('ffprobe failed:', probeErr?.message || probeErr);
    }

    await patchMeta(ownerKey, id, { status: 'uploading', progress: 85 });

    const key  = outKeyFor(ownerKey, id, ext);
    const stat = fs.statSync(outPath);
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: fs.createReadStream(outPath),
      ContentType: ext === 'mp4' ? 'video/mp4'
        : ext === 'webm' ? 'video/webm'
        : ext === 'mov' ? 'video/quicktime'
        : 'application/octet-stream',
      Metadata: { 'original-filename': inputName }
    }));

    await patchMeta(ownerKey, id, {
      status: 'done',
      progress: 100,
      fileSize: stat.size,
      s3Bucket: S3_BUCKET,
      s3Key: key,
      finishedAt: new Date().toISOString()
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

// GET /api/transcode/status/:id
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
    error: item.error || null
  });
});

// GET /api/transcode/download/:id
router.get('/download/:id', async (req, res) => {
  let ownerKey;
  try { ownerKey = ownerKeyFromReq(req); } catch (e) { return res.status(401).json({ error: e.message }); }
  const id = req.params.id;
  const item = await getMeta(ownerKey, id);
  if (!item || item.status !== 'done' || !item.s3Bucket || !item.s3Key) {
    return res.status(404).json({ error: 'Not found or not ready' });
  }

  const ext = item.outputFormat || 'mp4';
  const filename = (item.originalFilename || `video-${id}.${ext}`).replace(/[/\\]/g, '_').replace(/\s+/g,'_');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', ext === 'mp4' ? 'video/mp4'
    : ext === 'webm' ? 'video/webm'
    : ext === 'mov' ? 'video/quicktime'
    : 'application/octet-stream');

  const r = await s3.send(new GetObjectCommand({ Bucket: item.s3Bucket, Key: item.s3Key }));
  r.Body.pipe(res);
});

// GET /api/transcode/list (user-scoped; fixed PK + begins_with on composite videoId)
router.get('/list', async (req, res) => {
  try {
    const ownerKey = ownerKeyFromReq(req);
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: '#pk = :pk AND begins_with(#vid, :prefix)',
      ExpressionAttributeNames: { '#pk': 'qut-username', '#vid': 'videoId' },
      ExpressionAttributeValues: {
        ':pk': FIXED_PK_VAL,
        ':prefix': `${ownerKey}#`
      },
      ScanIndexForward: false
    }));
    res.json(Array.isArray(r.Items) ? r.Items : []);
  } catch (err) {
    console.error('❌ list failed', err);
    res.status(500).json({ error: 'Failed to fetch transcode list', details: err.message });
  }
});

export default router;
