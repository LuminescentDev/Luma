import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Config } from "./config.js";

const CONTENT_TYPE = "application/vnd.luma.encrypted-room-snapshot";

export class SnapshotStorage {
  private readonly client: S3Client;

  constructor(private readonly config: Config) {
    this.client = new S3Client({
      endpoint: config.r2Endpoint,
      region: config.r2Region,
      credentials: {
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
      },
    });
  }

  async get(roomId: string) {
    return await this.client.send(
      new GetObjectCommand({ Bucket: this.config.r2Bucket, Key: this.key(roomId) }),
    );
  }

  async put(roomId: string, bytes: Buffer, ifMatch?: string, createOnly = false): Promise<string> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.r2Bucket,
        Key: this.key(roomId),
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: CONTENT_TYPE,
        IfMatch: ifMatch,
        IfNoneMatch: createOnly ? "*" : undefined,
      }),
    );
    return result.ETag ?? "";
  }

  async delete(roomId: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.r2Bucket, Key: this.key(roomId) }),
    );
  }

  private key(roomId: string): string {
    return `rooms/${roomId}/snapshot.luma`;
  }
}

export { CONTENT_TYPE as SNAPSHOT_CONTENT_TYPE };
