// R2 through its S3 API: presigned URLs for the launcher and the site, so world files never pass through this server.
import { createHash, createHmac } from "node:crypto";

export type Bucket = { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string };

export const bucketFromEnv = (bucket: string): Bucket => ({
  endpoint: process.env.R2_ENDPOINT!,
  bucket,
  region: process.env.R2_REGION ?? "auto",
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
});

export const client = (b: Bucket) => new Bun.S3Client({ endpoint: b.endpoint, bucket: b.bucket, region: b.region, accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey });

const hmac = (key: string | Buffer, text: string) => createHmac("sha256", key).update(text).digest();
const stamp = (at: Date) => at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * A SigV4 query-signed URL. A PUT also signs its content-length and content-type, so the upload must be exactly the size and type the server agreed to; Bun's own presign signs only the host.
 * GETs are signed from the start of the hour, so a world's picture keeps one URL, and stays cached, for the hour.
 */
export function presign(b: Bucket, key: string, put?: { type: string; length: number }, now = Date.now()) {
  const at = new Date(put ? now : now - (now % 3_600_000));
  const url = new URL(`${b.endpoint.replace(/\/$/, "")}/${b.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
  const date = stamp(at);
  const scope = `${date.slice(0, 8)}/${b.region}/s3/aws4_request`;
  const headers: [string, string][] = put ? [["content-length", String(put.length)], ["content-type", put.type], ["host", url.host]] : [["host", url.host]];
  const signed = headers.map(([k]) => k).join(";");
  const query = new URLSearchParams([
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${b.accessKeyId}/${scope}`],
    ["X-Amz-Date", date],
    ["X-Amz-Expires", String(put ? 3600 : 7200)],
    ["X-Amz-SignedHeaders", signed],
  ]);
  const canonicalQuery = [...query].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const canonical = [put ? "PUT" : "GET", url.pathname, canonicalQuery, headers.map(([k, v]) => `${k}:${v}\n`).join(""), signed, "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", date, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const key4 = [date.slice(0, 8), b.region, "s3", "aws4_request"].reduce<Buffer | string>((k, part) => hmac(k, part), `AWS4${b.secretAccessKey}`);
  return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${hmac(key4, toSign).toString("hex")}`;
}
