import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Parse req.body (or other input) with a zod schema; 400 on failure. */
export function parse(schema, input) {
  const r = schema.safeParse(input);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(400, `${first.path.join('.') || 'input'}: ${first.message}`);
  }
  return r.data;
}

export function tempPassword() {
  // 12 chars, no ambiguous characters
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
}

export const hashPassword = (pw) => bcrypt.hash(pw, 12);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function publicAccount(a) {
  if (!a) return null;
  const { password_hash, token_version, ...rest } = a;
  return rest;
}
