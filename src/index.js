import { config } from './config.js';
import { createApp } from './app.js';
import { connectMongo } from './db/mongo.js';
import { resumePending } from './services/processing.js';
import { startRetentionScheduler } from './services/retention.js';

await connectMongo();
await resumePending();
startRetentionScheduler();
createApp().listen(config.port, () => console.log(`SitesForStudios API on http://localhost:${config.port}`));
