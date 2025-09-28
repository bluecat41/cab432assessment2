import { S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketTaggingCommand } from '@aws-sdk/client-s3';

const REGION       = process.env.AWS_REGION || 'ap-southeast-2';
const BUCKET       = process.env.S3_BUCKET;                 // e.g. n8870349
const QUT_USERNAME = process.env.QUT_USERNAME || 'n8870349@qut.edu.au';

export async function ensureBucket() {
  if (!BUCKET) throw new Error('S3_BUCKET is not set');

  const s3 = new S3Client({ region: REGION });

  // 1) Check if bucket exists
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`✅ S3 bucket "${BUCKET}" exists`);
    return;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode !== 404 && e?.name !== 'NotFound' && e?.$metadata?.httpStatusCode !== 301) {
      console.warn(`ℹ️ HeadBucket error (continuing to create): ${e.message}`);
    }
  }

  // 2) Create the bucket in the right region
  const params = { Bucket: BUCKET };
  // For regions other than us-east-1, you must specify LocationConstraint
  if (REGION !== 'us-east-1') {
    params.CreateBucketConfiguration = { LocationConstraint: REGION };
  }

  await s3.send(new CreateBucketCommand(params));
  console.log(`✅ Created bucket "${BUCKET}" in ${REGION}`);

  // 3) Tag it
  try {
    await s3.send(new PutBucketTaggingCommand({
      Bucket: BUCKET,
      Tagging: {
        TagSet: [
          { Key: 'qut-username', Value: QUT_USERNAME },
          { Key: 'purpose', Value: 'assessment-2' }
        ]
      }
    }));
    console.log('🏷️  Tagged bucket with qut-username and purpose');
  } catch (tagErr) {
    console.warn('⚠️ Could not tag bucket:', tagErr.message);
  }
}
