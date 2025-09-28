// backend/aws/dynamo.js
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
  QueryCommand
} from '@aws-sdk/lib-dynamodb';

const REGION       = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-southeast-2';
const TABLE        = process.env.DDB_TABLE || 'n8870349_VideoMetadata';
const QUT_USERNAME = process.env.QUT_USERNAME || 'n8870349@qut.edu.au'; // fixed PK

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// Compose sort key as "<ownerEmail>#<videoId>"
function skOf(ownerEmail, videoId) {
  if (!ownerEmail) throw new Error('skOf: ownerEmail is required');
  if (!videoId)    throw new Error('skOf: videoId is required');
  return `${ownerEmail}#${videoId}`;
}

/**
 * Create a new video item under fixed PK and SK = ownerEmail#videoId.
 * Persists ownerEmail and createdAt for convenience.
 */
export async function putVideoItem(ownerEmail, videoId, item = {}) {
  const sk = skOf(ownerEmail, videoId);
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      'qut-username': QUT_USERNAME,  // fixed partition key (PK)
      sk,                            // sort key (SK)
      videoId: String(videoId),
      ownerEmail,
      createdAt: new Date().toISOString(),
      ...item
    }
  }));
}

/**
 * Update attributes on an existing item (scoped by ownerEmail + videoId).
 */
export async function updateVideoItem(ownerEmail, videoId, updates = {}) {
  const sk = skOf(ownerEmail, videoId);

  const names = {};
  const values = {};
  const sets = [];
  let i = 0;
  for (const [k, v] of Object.entries(updates)) {
    // prevent accidental overwrite of PK/SK
    if (k === 'qut-username' || k === 'sk') continue;
    const nk = `#k${i}`;
    const nv = `:v${i}`;
    names[nk] = k;
    values[nv] = v;
    sets.push(`${nk} = ${nv}`);
    i++;
  }
  if (!sets.length) return;

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { 'qut-username': QUT_USERNAME, sk },
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  }));
}

/**
 * Get a single video by (ownerEmail, videoId).
 */
export async function getVideo(ownerEmail, videoId) {
  const sk = skOf(ownerEmail, videoId);
  const r = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { 'qut-username': QUT_USERNAME, sk }
  }));
  return r.Item;
}

/**
 * List all videos for a given ownerEmail (uses begins_with on SK).
 */
export async function listVideos(ownerEmail) {
  if (!ownerEmail) throw new Error('listVideos: ownerEmail is required');
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
    ExpressionAttributeNames: { '#pk': 'qut-username', '#sk': 'sk' },
    ExpressionAttributeValues: {
      ':pk': QUT_USERNAME,
      ':prefix': `${ownerEmail}#`
    },
    ScanIndexForward: false
  }));
  return r.Items || [];
}
