// The Express app without starting it, so tests can run it on a random port.
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db/pg.js';
import { loadUser, blockInactiveOrg, blockExpiredWrites } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import orgRoutes from './routes/orgs.js';
import studioRoutes from './routes/studios.js';
import eventRoutes from './routes/events.js';
import portalRoutes from './routes/portal.js';
import publicRoutes from './routes/public.js';
import billingRoutes, { webhook } from './routes/billing.js';
import signupRoutes from './routes/signup.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxyHops);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' }, contentSecurityPolicy: false }));

  // In production the API is only reachable through CloudFront, which adds a secret header.
  // Requests without it (someone hitting the server directly) are refused. Localhost is allowed
  // so the deploy script can health-check the server on the instance.
  if (config.originVerifySecret) {
    app.use((req, res, next) => {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (local || req.get('x-origin-verify') === config.originVerifySecret) return next();
      res.status(403).json({ error: 'Forbidden' });
    });
  }

  // Webhook needs the raw body, so it is mounted before the JSON parser.
  app.post('/api/billing/webhook', ...webhook);

  // Local uploads stream the raw request body; mount public routes before JSON parsing.
  app.use(cookieParser());
  app.use('/api', publicRoutes);
  app.use(express.json({ limit: '1mb' }));
  app.use(loadUser);
  app.use(blockInactiveOrg);
  app.use(blockExpiredWrites);

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });
  app.use('/api/auth', authRoutes);
  app.use('/api/signup', signupRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/org', orgRoutes);
  app.use('/api/studios', studioRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api/portal', portalRoutes);
  app.use('/api/billing', billingRoutes);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && config.isProd ? 'Something went wrong' : err.message });
  });
  return app;
}
