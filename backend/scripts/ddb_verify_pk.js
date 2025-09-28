// backend/scripts/ddb_verify_pk.js
import 'dotenv/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  BatchWriteCommand
} from '@aws-sdk/lib-dynamodb';

const REGION       = process.env.AWS_REGION || 'ap-southeast-2';
const TABLE        = process.env.DDB_TABLE  || 'VideoMetadata';
const QUT_USERNAME = process.env.QUT_USERNAME || 'n8870349@qut.edu.au';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ---------- helpers ----------
async function queryAllForUser() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: '#pk = :pkval',
      ExpressionAttributeNames: { '#pk': 'qut-username' },
      ExpressionAttributeValues: { ':pkval': QUT_USERNAME },
      ExclusiveStartKey,
      ScanIndexForward: false
    }));
    items.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function batchDelete(items) {
  // DynamoDB BatchWrite supports up to 25 actions per call
  let deleted = 0;
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    const RequestItems = {
      [TABLE]: chunk.map(it => ({
        DeleteRequest: {
          Key: { 'qut-username': QUT_USERNAME, videoId: String(it.videoId) }
        }
      }))
    };
    const resp = await ddb.send(new BatchWriteCommand({ RequestItems }));
    // retry unprocessed (basic backoff)
    let unprocessed = resp.UnprocessedItems?.[TABLE] || [];
    let attempt = 0;
    while (unprocessed.length && attempt < 5) {
      await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
      const retryReq = { [TABLE]: unprocessed };
      const retryResp = await ddb.send(new BatchWriteCommand({ RequestItems: retryReq }));
      unprocessed = retryResp.UnprocessedItems?.[TABLE] || [];
      attempt++;
    }
    deleted += chunk.length - (unprocessed.length || 0);
  }
  return deleted;
}

function newVideoId() {
  return `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

// ---------- commands ----------
async function cmdSeed() {
  const videoId = newVideoId();
  const sample = {
    'qut-username': QUT_USERNAME,
    videoId,
    originalFilename: 'sample.mov',
    fileSize: 1234567,
    duration: 10.5,
    codec: 'h264',
    width: 1280,
    height: 720,
    outputFormat: 'mp4',
    status: 'done',
    progress: 100,
    storageProvider: 's3',
    s3Bucket: process.env.S3_BUCKET || 'n8870349',
    s3Key: `users/${encodeURIComponent(QUT_USERNAME)}/outputs/${videoId}.mp4`,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString()
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: sample }));
  console.log('✅ PutItem OK:', videoId);
}

async function cmdList() {
  const items = await queryAllForUser();
  console.log(`📄 Items for ${QUT_USERNAME}: ${items.length}`);
  for (const it of items.slice(0, 50)) {
    console.log(`- ${it.videoId}  ${it.status || ''}  ${it.originalFilename || ''}`);
  }
  if (items.length > 50) console.log(`...and ${items.length - 50} more`);
}

async function cmdGet(videoId) {
  if (!videoId) {
    console.error('Usage: npm run verify:ddb -- get <videoId>');
    process.exit(1);
  }
  const r = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { 'qut-username': QUT_USERNAME, videoId: String(videoId) }
  }));
  if (!r.Item) {
    console.log('❓ Not found:', videoId);
  } else {
    console.log('🔎 Item:', JSON.stringify(r.Item, null, 2));
  }
}

async function cmdWipe({ yes = false } = {}) {
  const items = await queryAllForUser();
  if (!items.length) {
    console.log(`✅ Nothing to delete for ${QUT_USERNAME}`);
    return;
  }
  if (!yes) {
    console.log(`⚠️  This will DELETE ${items.length} items for ${QUT_USERNAME} in table ${TABLE}.`);
    console.log('Run with "--yes" to proceed: npm run verify:ddb -- wipe --yes');
    process.exit(0);
  }
  const deleted = await batchDelete(items);
  console.log(`🧹 Deleted ${deleted}/${items.length} items for ${QUT_USERNAME}`);
}

// ---------- entrypoint ----------
async function main() {
  const [, , cmd, ...rest] = process.argv;

  switch (cmd) {
    case 'seed':
      await cmdSeed();
      break;
    case 'list':
      await cmdList();
      break;
    case 'get':
      await cmdGet(rest[0]);
      break;
    case 'wipe': {
      const yes = rest.includes('--yes');
      await cmdWipe({ yes });
      break;
    }
    default:
      console.log(`Usage:
  npm run verify:ddb -- seed          # Put a sample item
  npm run verify:ddb -- list          # List items for ${QUT_USERNAME}
  npm run verify:ddb -- get <videoId> # Fetch one item
  npm run verify:ddb -- wipe [--yes]  # Delete ALL items for ${QUT_USERNAME}
`);
  }
}

main().catch(err => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
