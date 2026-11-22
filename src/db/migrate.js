import { pool } from './pg.js';
import { migrate } from './migrations.js';

try {
  await migrate(pool);
  console.log('migrations up to date');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
