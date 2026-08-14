import { z } from 'zod';

export const uploadRequestSchema = z.object({
  organizationId: z.uuid(),
  branchId: z.uuid().optional(),
  resourceType: z.string().trim().min(1).max(80),
  resourceId: z.uuid(),
  fileName: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(3).max(120),
  sizeBytes: z
    .int()
    .positive()
    .max(250 * 1024 * 1024),
  checksum: z.string().trim().min(32).max(128),
});

export type UploadRequest = z.infer<typeof uploadRequestSchema>;
export type PresignedUpload = {
  objectKey: string;
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: Record<string, string>;
};
export type PresignedDownload = { downloadUrl: string; expiresAt: string };

export interface ObjectStorageAdapter {
  presignUpload(input: UploadRequest): Promise<PresignedUpload>;
  presignDownload(input: { objectKey: string; downloadName?: string }): Promise<PresignedDownload>;
  headObject(
    objectKey: string,
  ): Promise<{ sizeBytes: number; mimeType: string; checksum?: string }>;
  deleteObject(objectKey: string): Promise<void>;
}

export const allowedDocumentTypes = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
]);
