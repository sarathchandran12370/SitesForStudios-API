// Storage abstraction: "local" writes under server/storage (dev); "s3" uses Amazon S3.
// URLs handed to browsers are always short-lived and signed.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const LOCAL_ROOT = path.resolve(process.env.LOCAL_STORAGE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../storage'));

function sign(value) {
  return crypto.createHmac('sha256', config.mediaSecret).update(value).digest('base64url');
}

export function verifySignature(value, sig) {
  const expected = Buffer.from(sign(value));
  const given = Buffer.from(String(sig || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function safeLocalPath(key) {
  const p = path.resolve(LOCAL_ROOT, key);
  if (!p.startsWith(LOCAL_ROOT + path.sep)) throw new Error('Bad key');
  return p;
}

let s3 = null;
async function s3client() {
  if (!s3) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    s3 = new S3Client({ region: config.awsRegion });
  }
  return s3;
}

const local = {
  async put(key, body, contentType) {
    const p = safeLocalPath(key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, body);
    return { key, contentType };
  },
  async putStream(key, stream) {
    const p = safeLocalPath(key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(p);
      stream.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      stream.on('error', reject);
    });
    const st = await fsp.stat(p);
    return { key, bytes: st.size };
  },
  async getBuffer(key) {
    return fsp.readFile(safeLocalPath(key));
  },
  async getStream(key) {
    return fs.createReadStream(safeLocalPath(key));
  },
  async size(key) {
    return (await fsp.stat(safeLocalPath(key))).size;
  },
  async remove(key) {
    await fsp.rm(safeLocalPath(key), { force: true });
  },
  localPath: safeLocalPath,
  // Signed URL served by GET /api/media/*
  async url(key, { expiresIn = 900, download } = {}) {
    const exp = Math.floor(Date.now() / 1000) + expiresIn;
    const dl = download ? encodeURIComponent(download) : '';
    const sig = sign(`get:${key}:${exp}:${dl}`);
    return `/api/media/${key}?exp=${exp}&sig=${sig}${dl ? `&dl=${dl}` : ''}`;
  },
  // Browser PUTs the file to this signed URL (handled by PUT /api/uploads/*)
  async uploadUrl(key, { expiresIn = 3600, contentType } = {}) {
    const exp = Math.floor(Date.now() / 1000) + expiresIn;
    const sig = sign(`put:${key}:${exp}`);
    return { url: `/api/uploads/${key}?exp=${exp}&sig=${sig}`, method: 'PUT', headers: { 'Content-Type': contentType } };
  },
  // Archiving only exists on S3. Locally files stay where they are and restores are instant.
  async archive() {},
  async requestRestore() {},
  async isRestored() {
    return true;
  },
  async unarchive() {},
  verifyGet(key, exp, sig, dl = '') {
    return Number(exp) > Date.now() / 1000 && verifySignature(`get:${key}:${exp}:${dl ? encodeURIComponent(dl) : ''}`, sig);
  },
  verifyPut(key, exp, sig) {
    return Number(exp) > Date.now() / 1000 && verifySignature(`put:${key}:${exp}`, sig);
  },
};

const s3driver = {
  async put(key, body, contentType) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await s3client()).send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: body, ContentType: contentType }));
    return { key };
  },
  async getBuffer(key) {
    const stream = await this.getStream(key);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
  },
  async getStream(key) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const out = await (await s3client()).send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    return out.Body;
  },
  async size(key) {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const out = await (await s3client()).send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    return out.ContentLength;
  },
  async remove(key) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await (await s3client()).send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: key }));
  },
  // Retention: move an object to Glacier Deep Archive in place (same key, tags kept).
  async archive(key) {
    const { CopyObjectCommand } = await import('@aws-sdk/client-s3');
    await (await s3client()).send(
      new CopyObjectCommand({
        Bucket: config.s3Bucket,
        Key: key,
        CopySource: encodeURI(`${config.s3Bucket}/${key}`),
        StorageClass: 'DEEP_ARCHIVE',
        MetadataDirective: 'COPY',
        TaggingDirective: 'COPY',
      })
    );
  },
  // Ask S3 to bring an archived object back (Standard tier: within ~12 hours).
  async requestRestore(key) {
    const { RestoreObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      await (await s3client()).send(
        new RestoreObjectCommand({ Bucket: config.s3Bucket, Key: key, RestoreRequest: { Days: 7, GlacierJobParameters: { Tier: 'Standard' } } })
      );
    } catch (e) {
      if (e.name !== 'RestoreAlreadyInProgress') throw e;
    }
  },
  async isRestored(key) {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const head = await (await s3client()).send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    if (head.StorageClass !== 'DEEP_ARCHIVE' && head.StorageClass !== 'GLACIER') return true;
    return /ongoing-request="false"/.test(head.Restore || '');
  },
  // After a restore finishes, copy it back to a normal storage class so it stays available.
  async unarchive(key, storageClass = 'STANDARD_IA') {
    const { CopyObjectCommand } = await import('@aws-sdk/client-s3');
    await (await s3client()).send(
      new CopyObjectCommand({
        Bucket: config.s3Bucket,
        Key: key,
        CopySource: encodeURI(`${config.s3Bucket}/${key}`),
        StorageClass: storageClass,
        MetadataDirective: 'COPY',
        TaggingDirective: 'COPY',
      })
    );
  },
  async url(key, { expiresIn = 900, download } = {}) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const cmd = new GetObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      ResponseContentDisposition: download ? `attachment; filename="${download.replace(/"/g, '')}"` : undefined,
    });
    return getSignedUrl(await s3client(), cmd, { expiresIn });
  },
  // `storageClass` becomes an object tag ("class=raw" / "class=original"); S3 lifecycle rules
  // use it to move RAW to Glacier Instant Retrieval and originals to Standard-IA.
  async uploadUrl(key, { expiresIn = 3600, contentType, storageClass } = {}) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const tagging = storageClass ? `class=${storageClass}` : undefined;
    const cmd = new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, ContentType: contentType, Tagging: tagging });
    const headers = { 'Content-Type': contentType };
    if (tagging) headers['x-amz-tagging'] = tagging;
    const url = await getSignedUrl(await s3client(), cmd, { expiresIn, unhoistableHeaders: new Set(tagging ? ['x-amz-tagging'] : []) });
    return { url, method: 'PUT', headers };
  },
};

export const storage = config.storageDriver === 's3' ? s3driver : local;
export const localStorage = local;
