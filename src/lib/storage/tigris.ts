import 'server-only';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  ObjectStorageAdapter,
  PresignedDownload,
  PresignedUpload,
  UploadRequest,
} from './contracts';

const expiresInSeconds = 5 * 60;

export class TigrisStorageAdapter implements ObjectStorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(environment = process.env) {
    const {
      TIGRIS_ENDPOINT,
      TIGRIS_REGION = 'auto',
      TIGRIS_BUCKET,
      TIGRIS_ACCESS_KEY_ID,
      TIGRIS_SECRET_ACCESS_KEY,
    } = environment;
    if (!TIGRIS_ENDPOINT || !TIGRIS_BUCKET || !TIGRIS_ACCESS_KEY_ID || !TIGRIS_SECRET_ACCESS_KEY)
      throw new Error('TIGRIS_CONFIGURATION_MISSING');
    this.bucket = TIGRIS_BUCKET;
    this.client = new S3Client({
      endpoint: TIGRIS_ENDPOINT,
      region: TIGRIS_REGION,
      credentials: { accessKeyId: TIGRIS_ACCESS_KEY_ID, secretAccessKey: TIGRIS_SECRET_ACCESS_KEY },
    });
  }

  async presignUpload(input: UploadRequest): Promise<PresignedUpload> {
    const safeName = input.fileName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .slice(-120);
    const objectKey = `${input.organizationId}/${input.resourceType}/${input.resourceId}/${crypto.randomUUID()}-${safeName}`;
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ContentType: input.mimeType,
        ContentLength: input.sizeBytes,
        ChecksumSHA256: input.checksum,
      }),
      { expiresIn: expiresInSeconds },
    );
    return {
      objectKey,
      uploadUrl,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      requiredHeaders: { 'content-type': input.mimeType, 'x-amz-checksum-sha256': input.checksum },
    };
  }

  async presignDownload({
    objectKey,
    downloadName,
  }: {
    objectKey: string;
    downloadName?: string;
  }): Promise<PresignedDownload> {
    const downloadUrl = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ResponseContentDisposition: downloadName
          ? `attachment; filename="${downloadName.replace(/["\\]/g, '')}"`
          : undefined,
      }),
      { expiresIn: expiresInSeconds },
    );
    return { downloadUrl, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() };
  }

  async headObject(objectKey: string) {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
    return {
      sizeBytes: result.ContentLength ?? 0,
      mimeType: result.ContentType ?? 'application/octet-stream',
      checksum: result.ChecksumSHA256,
    };
  }

  async deleteObject(objectKey: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }
}
