import fs from 'node:fs';
import pg from 'pg';
import { config } from '../config.js';

// DATE columns stay 'YYYY-MM-DD' strings (no timezone shift); BIGINT counts become numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  // RDS PostgreSQL 16 requires TLS; verify the server with the RDS CA bundle.
  ssl: config.databaseSslCa ? { ca: fs.readFileSync(config.databaseSslCa, 'utf8') } : undefined,
});

export async function q(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

export async function one(text, params) {
  const rows = await q(text, params);
  return rows[0] || null;
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
