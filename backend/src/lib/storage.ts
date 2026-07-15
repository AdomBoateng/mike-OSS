/**
 * S3-compatible object storage utilities for Mike document management.
 * Works with any S3-compatible backend (self-hosted MinIO / "surf", AWS S3,
 * Cloudflare R2) via @aws-sdk/client-s3.
 *
 * Config is read from S3_* env vars, falling back to the legacy R2_* names for
 * backward compatibility (see resolveStorageConfig):
 *   S3_ENDPOINT_URL      — e.g. https://s3.example.internal (or an R2 endpoint)
 *   S3_ACCESS_KEY_ID     — access key id
 *   S3_SECRET_ACCESS_KEY — secret access key
 *   S3_BUCKET_NAME       — bucket name (default: "mike")
 *   S3_REGION            — region (default: "auto")
 *   S3_FORCE_PATH_STYLE  — "false" for virtual-hosted style (default: path-style)
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import * as S3Commands from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";

const GetObjectCommand = (S3Commands as any).GetObjectCommand;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Return the first non-empty, trimmed env var among `names`. */
function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return undefined;
}

export interface StorageConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  forcePathStyle: boolean;
}

/**
 * Resolve storage configuration from the environment. Prefers S3_* names and
 * falls back to the legacy R2_* names. Returns null when any required field is
 * missing (i.e. storage is not configured). Read lazily so config changes and
 * tests take effect without re-importing the module.
 */
export function resolveStorageConfig(): StorageConfig | null {
  const endpoint = envValue("S3_ENDPOINT_URL", "R2_ENDPOINT_URL");
  const accessKeyId = envValue("S3_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID");
  const secretAccessKey = envValue(
    "S3_SECRET_ACCESS_KEY",
    "R2_SECRET_ACCESS_KEY",
  );
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket: envValue("S3_BUCKET_NAME", "R2_BUCKET_NAME") ?? "mike",
    region: envValue("S3_REGION", "R2_REGION") ?? "auto",
    forcePathStyle:
      (envValue("S3_FORCE_PATH_STYLE", "R2_FORCE_PATH_STYLE") ?? "true") !==
      "false",
  };
}

export function isStorageEnabled(): boolean {
  return resolveStorageConfig() !== null;
}

function bucketName(): string {
  return resolveStorageConfig()?.bucket ?? "mike";
}

let cachedClient: S3Client | undefined;

function getClient(): S3Client {
  if (!cachedClient) {
    const config = resolveStorageConfig();
    if (!config) {
      throw new Error(
        "Storage is not configured: set S3_ENDPOINT_URL, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY (legacy R2_* names also accepted)",
      );
    }
    cachedClient = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }
  return cachedClient;
}

/** Reset the cached S3 client so the next call rebuilds it from current env. */
export function resetStorageClient(): void {
  cachedClient = undefined;
}

function requireStorageConfig(): void {
  if (!isStorageEnabled()) {
    throw new Error(
      "Storage is not configured: set S3_ENDPOINT_URL, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY (legacy R2_* names also accepted)",
    );
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadFile(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  requireStorageConfig();
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: Buffer.from(content),
      ContentType: contentType,
    }),
  );
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  if (!isStorageEnabled()) return null;
  try {
    const client = getClient();
    const response = (await client.send(
      new GetObjectCommand({ Bucket: bucketName(), Key: key }),
    )) as any;
    if (!response.Body) return null;
    const bytes = await response.Body.transformToByteArray();
    return bytes.buffer as ArrayBuffer;
  } catch {
    return null;
  }
}

export async function listFiles(prefix: string): Promise<string[]> {
  if (!isStorageEnabled()) return [];
  const client = getClient();
  const keys: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName(),
        Prefix: prefix,
        ContinuationToken,
      }),
    );
    for (const item of response.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
    }
    ContinuationToken = response.NextContinuationToken;
  } while (ContinuationToken);
  return keys;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteFile(key: string): Promise<void> {
  if (!isStorageEnabled()) return;
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
}

// ---------------------------------------------------------------------------
// Signed URL (pre-signed for temporary direct access)
// ---------------------------------------------------------------------------

export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string,
): Promise<string | null> {
  if (!isStorageEnabled()) return null;
  try {
    const client = getClient();
    // Override the response Content-Disposition so the browser uses this
    // filename on download, instead of the last path segment of the R2 key
    // (which includes the document UUID). The `download` attribute on <a>
    // is ignored for cross-origin URLs, so we have to set it server-side.
    const responseContentDisposition = downloadFilename
      ? buildContentDisposition("attachment", downloadFilename)
      : undefined;
    const command = new GetObjectCommand({
      Bucket: bucketName(),
      Key: key,
      ResponseContentDisposition: responseContentDisposition,
    }) as any;
    return await awsGetSignedUrl(client, command, { expiresIn });
  } catch {
    return null;
  }
}

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

export function sanitizeDispositionFilename(name: string): string {
  return normalizeDownloadFilename(name)
    .replace(/["\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");
}

export function encodeRFC5987(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function buildContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"; filename*=UTF-8''${encodeRFC5987(normalized)}`;
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

export function storageKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/source${storageExtension(filename, ".bin")}`;
}

export function pdfStorageKey(
  userId: string,
  docId: string,
  stem: string,
): string {
  return `documents/${userId}/${docId}/${stem}.pdf`;
}

export function generatedDocKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `generated/${userId}/${docId}/generated${storageExtension(filename, ".docx")}`;
}

export function versionStorageKey(
  userId: string,
  docId: string,
  versionSlug: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/versions/${versionSlug}${storageExtension(filename, ".bin")}`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}
