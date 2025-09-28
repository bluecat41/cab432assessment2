// backend/aws/s3BucketTags.js
import {
    S3Client,
    HeadBucketCommand,
    CreateBucketCommand,
    PutBucketTaggingCommand
  } from '@aws-sdk/client-s3';
  
  const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-southeast-2';
  const BUCKET = process.env.S3_BUCKET;
  
  const TAG_USERNAME = process.env.BUCKET_TAG_USERNAME || 'n8870349@qut.edu.au';
  const TAG_PURPOSE = process.env.BUCKET_TAG_PURPOSE || 'VideoTranscoder';
  
  const s3 = new S3Client({ region: REGION });
  
  // Create bucket if missing (optional). Comment out creation if you prefer to fail instead.
  async function ensureBucketExists(bucket) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch (err) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
        // Outside us-east-1 you must set LocationConstraint
        const cfg = REGION === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: REGION } };
        await s3.send(new CreateBucketCommand({ Bucket: bucket, ...cfg }));
        return true;
      }
      throw err; // other errors (like BucketAlreadyOwnedByYou/NotOwnedByYou) surface
    }
  }
  
  export async function ensureBucketTags() {
    if (!BUCKET) throw new Error('S3_BUCKET not set');
  
    // Optional create-if-missing
    await ensureBucketExists(BUCKET);
  
    // Apply/overwrite tags
    const TagSet = [
      { Key: 'qut-username', Value: TAG_USERNAME },
      { Key: 'purpose',      Value: TAG_PURPOSE }
    ];
  
    await s3.send(new PutBucketTaggingCommand({
      Bucket: BUCKET,
      Tagging: { TagSet }
    }));
  
    return { bucket: BUCKET, tags: TagSet };
  }
  