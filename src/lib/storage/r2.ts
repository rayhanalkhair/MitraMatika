import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  assertContentLength,
  assertSafeKey,
  assertSafePrefix,
  attachmentDisposition,
  clampSeconds,
  type ObjectStore,
} from "./types";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** DeleteObjects accepts at most 1000 keys, and a ListObjectsV2 page holds at most 1000. */
const DELETE_BATCH = 1000;

export function createR2Store(config: R2Config): ObjectStore {
  const base = {
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  };
  // Requests (put/get/delete/list) keep the SDK's default integrity checks. Every request is
  // bounded (10 s to connect, 30 s in all, then a TimeoutError), so a hung R2 call fails its caller
  // instead of holding a transaction, an advisory lock or the daily jobs run open.
  const client = new S3Client({
    ...base,
    requestHandler: {
      connectionTimeout: 10_000,
      requestTimeout: 30_000,
      throwOnRequestTimeout: true,
    },
  });
  // Presigning only: the SDK default would embed a CRC32 of the EMPTY body in the signed URL
  // (x-amz-checksum-crc32=AAAAAA==), so any real upload to it fails. A URL is signed before
  // the body exists, hence checksums are computed only when an operation requires them. A
  // signed GET is fetched by a browser that never validates a checksum, so it asks for none
  // (otherwise the URL carries x-amz-checksum-mode=ENABLED).
  const presigner = new S3Client({
    ...base,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const Bucket = config.bucket;

  return {
    async put(key, body, contentType) {
      assertSafeKey(key);
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },

    async get(key) {
      assertSafeKey(key);
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return (await res.Body?.transformToByteArray()) ?? null;
      } catch (error) {
        if (error instanceof Error && error.name === "NoSuchKey") return null;
        throw error;
      }
    },

    async delete(key) {
      assertSafeKey(key);
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    async deletePrefix(prefix) {
      assertSafePrefix(prefix);
      let deleted = 0;
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket,
            Prefix: prefix,
            MaxKeys: DELETE_BATCH,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : []));
        if (keys.length > 0) {
          const res = await client.send(
            new DeleteObjectsCommand({
              Bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
            }),
          );
          if (res.Errors && res.Errors.length > 0) {
            const failed = res.Errors.map((e) => `${e.Key ?? "?"} (${e.Code ?? "?"})`);
            throw new Error(`Gagal menghapus objek: ${failed.join(", ")}`);
          }
          deleted += keys.length;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return deleted;
    },

    async signedGetUrl(key, seconds, options) {
      assertSafeKey(key);
      const disposition =
        options?.downloadName === undefined
          ? undefined
          : attachmentDisposition(options.downloadName);
      return await getSignedUrl(
        presigner,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ...(disposition ? { ResponseContentDisposition: disposition } : {}),
        }),
        { expiresIn: clampSeconds(seconds) },
      );
    },

    async signedPutUrl(key, contentType, contentLength, seconds) {
      assertContentLength(contentLength);
      assertSafeKey(key);
      // Content type and length are signed, so an upload with another type or size is refused.
      return await getSignedUrl(
        presigner,
        new PutObjectCommand({
          Bucket,
          Key: key,
          ContentType: contentType,
          ContentLength: contentLength,
        }),
        {
          expiresIn: clampSeconds(seconds),
          signableHeaders: new Set(["content-type", "content-length"]),
        },
      );
    },
  };
}
