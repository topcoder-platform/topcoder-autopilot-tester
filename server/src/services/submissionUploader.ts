import { promises as fs } from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { RunnerLogger } from '../utils/logger.js';
import type { StepRequestLogInput } from '../utils/stepRequestRecorder.js';
import { recordStepRequest } from '../utils/stepRequestRecorder.js';

export type SubmissionArtifact = {
  absolutePath: string;
  buffer: Buffer;
  size: number;
  contentType: string;
};

const BUCKET_NAME = 'topcoder-dev-submissions-dmz';
const PUBLIC_BASE_URL = `https://s3.amazonaws.com/${BUCKET_NAME}`;
const DEFAULT_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

const s3Client = new S3Client({ region: DEFAULT_REGION });

export async function loadSubmissionArtifact(sourcePath: string): Promise<SubmissionArtifact> {
  const resolvedPath = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.resolve(process.cwd(), sourcePath);

  const stats = await fs.stat(resolvedPath).catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ENOENT') {
      throw new Error(`Submission zip file not found at ${resolvedPath}`);
    }
    throw error;
  });

  if (!stats.isFile()) {
    throw new Error(`Submission zip path ${resolvedPath} is not a file`);
  }

  const buffer = await fs.readFile(resolvedPath);
  return {
    absolutePath: resolvedPath,
    buffer,
    size: buffer.length,
    contentType: 'application/zip'
  };
}

export async function uploadSubmissionArtifact(
  log: RunnerLogger,
  artifact: SubmissionArtifact
): Promise<{ key: string; url: string; etag?: string }>
{
  const objectKey = `${nanoid(24)}.zip`;
  const endpoint = `s3://${BUCKET_NAME}/${objectKey}`;
  const start = Date.now();

  log.info('Uploading submission artifact to S3', {
    bucket: BUCKET_NAME,
    key: objectKey,
    region: DEFAULT_REGION,
    size: artifact.size,
    file: artifact.absolutePath
  });

  const baseRequest: StepRequestLogInput = {
    id: `s3-upload-${objectKey}`,
    method: 'PUT',
    endpoint,
    requestBody: {
      path: artifact.absolutePath,
      size: artifact.size,
      bucket: BUCKET_NAME,
      region: DEFAULT_REGION
    },
    timestamp: new Date().toISOString()
  };

  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: objectKey,
      Body: artifact.buffer,
      ContentType: artifact.contentType,
      ContentLength: artifact.size
    });
    const response = await s3Client.send(command);

    const duration = Date.now() - start;
    const status = response.$metadata?.httpStatusCode ?? 200;
    recordStepRequest({
      ...baseRequest,
      status,
      responseHeaders: response.ETag ? { etag: response.ETag } : undefined,
      durationMs: duration,
      outcome: 'success'
    });

    const etag = typeof response.ETag === 'string' ? response.ETag : undefined;
    const url = `${PUBLIC_BASE_URL}/${objectKey}`;
    log.info('Submission artifact uploaded', { url, etag, duration });
    return { key: objectKey, url, etag };
  } catch (error: any) {
    const status = error?.$metadata?.httpStatusCode;
    const message = typeof error?.message === 'string' ? error.message : 'Unknown error';
    recordStepRequest({
      ...baseRequest,
      status,
      responseBody: {
        name: error?.name,
        fault: error?.$fault
      },
      message,
      durationMs: Date.now() - start,
      outcome: 'failure'
    });

    if (error && typeof error === 'object') {
      (error as any).__stepRequestId = baseRequest.id;
    }

    log.error('Failed to upload submission artifact', { endpoint, status, message });
    throw error;
  }
}
