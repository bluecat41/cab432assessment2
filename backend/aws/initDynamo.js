// backend/aws/initDynamo.js
import {
    DynamoDBClient,
    CreateTableCommand,
    DescribeTableCommand,
    DeleteTableCommand
  } from '@aws-sdk/client-dynamodb';
  
  const REGION = process.env.AWS_REGION || 'ap-southeast-2';
  const TABLE  = process.env.DDB_TABLE  || 'n8870349_VideoMetadata';
  const RECREATE = String(process.env.ALLOW_TABLE_RECREATE || '').toLowerCase() === 'true';
  
  const EXPECTED_KEYS = [
    { AttributeName: 'qut-username', KeyType: 'HASH' },
    { AttributeName: 'videoId',      KeyType: 'RANGE' }
  ];
  
  const ddb = new DynamoDBClient({ region: REGION });
  
  function sameKeySchema(a = [], b = []) {
    if (a.length !== b.length) return false;
    return a.every((k, i) => k.AttributeName === b[i].AttributeName && k.KeyType === b[i].KeyType);
  }
  
  async function createTable() {
    const cmd = new CreateTableCommand({
      TableName: TABLE,
      AttributeDefinitions: [
        { AttributeName: 'qut-username', AttributeType: 'S' },
        { AttributeName: 'videoId',      AttributeType: 'S' }
      ],
      KeySchema: EXPECTED_KEYS,
      BillingMode: 'PAY_PER_REQUEST'
    });
    const r = await ddb.send(cmd);
    console.log(`✅ Created table "${TABLE}" with PK=qut-username, SK=videoId (status: ${r.TableDescription?.TableStatus})`);
  }
  
  export async function ensureVideoMetadataTable() {
    try {
      const r = await ddb.send(new DescribeTableCommand({ TableName: TABLE }));
      const live = r.Table?.KeySchema || [];
      if (sameKeySchema(live, EXPECTED_KEYS)) {
        console.log(`✅ Table "${TABLE}" exists with expected key schema.`);
        return;
      }
      console.warn(`⚠️ Table "${TABLE}" exists with DIFFERENT key schema:`, live);
      if (!RECREATE) {
        console.warn('Set ALLOW_TABLE_RECREATE=true to drop and recreate with the expected schema.');
        return;
      }
      console.warn(`🗑  Deleting "${TABLE}" to recreate with expected schema...`);
      await ddb.send(new DeleteTableCommand({ TableName: TABLE }));
      // Wait for deletion to propagate (simple backoff)
      await new Promise(r => setTimeout(r, 4000));
      await createTable();
    } catch (err) {
      if (err.name === 'ResourceNotFoundException') {
        console.log(`ℹ️  Table "${TABLE}" not found; creating...`);
        await createTable();
      } else {
        console.error('❌ Failed to ensure table:', err);
        throw err;
      }
    }
  }
  