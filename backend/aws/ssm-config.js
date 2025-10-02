// backend/aws/ssm-config.js
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import "dotenv/config";

const ROOT = "/n8870349/video-transcoder";
const REGION = process.env.AWS_REGION || "ap-southeast-2";

const PARAMS = {
  // App & region
  AWS_REGION: `${ROOT}/AWS/REGION`,
  PORT:       `${ROOT}/PORT`,

  // S3 & tags
  S3_BUCKET:            `${ROOT}/S3/BUCKET`,
  S3_PREFIX:            `${ROOT}/S3/PREFIX`,
  BUCKET_TAG_USERNAME:  `${ROOT}/BUCKET/TAG/USERNAME`,
  BUCKET_TAG_PURPOSE:   `${ROOT}/BUCKET/TAG/PURPOSE`,

  // DynamoDB
  DDB_TABLE: `${ROOT}/DDB/TABLE`,

  // Cognito (non-secret)
  COGNITO_REGION:       `${ROOT}/COGNITO/REGION`,
  COGNITO_USER_POOL_ID: `${ROOT}/COGNITO/USER/POOL/ID`,
  COGNITO_CLIENT_ID:    `${ROOT}/COGNITO/CLIENT/ID`,
};

async function getParameter(client, name) {
  const resp = await client.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  return resp?.Parameter?.Value ?? "";
}

/**
 * Fetches each named parameter via GetParameter and sets process.env[KEY].
 * Returns a map of { KEY: true|false } indicating which were loaded.
 */
export async function hydrateEnvFromParameterStore() {
  const client = new SSMClient({ region: REGION });

  const entries = Object.entries(PARAMS);
  const results = await Promise.all(
    entries.map(async ([envKey, ssmName]) => {
      try {
        const val = await getParameter(client, ssmName);
        if (val !== "") process.env[envKey] = val;
        return [envKey, true];
      } catch (e) {
        console.warn(`SSM GetParameter miss: ${ssmName} -> ${e.name || e.message}`);
        return [envKey, false];
      }
    })
  );

  // Ensure region/port exists even if SSM misses
  process.env.AWS_REGION ??= REGION;
  process.env.PORT ??= process.env.PORT || "3000";

  const loaded = Object.fromEntries(results);
  const okCount = Object.values(loaded).filter(Boolean).length;
  console.log(`✅ SSM(GetParameter): loaded ${okCount}/${entries.length} params from ${ROOT}`);
  return loaded;
}
