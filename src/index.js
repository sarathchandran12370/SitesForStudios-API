import { config } from './config.js';
import { createApp } from './app.js';
import { connectMongo } from './db/mongo.js';
import { resumePending } from './services/processing.js';
import { startRetentionScheduler } from './services/retention.js';
import { startTrialScheduler } from './services/trials.js';

await connectMongo();
await resumePending();
startRetentionScheduler();
startTrialScheduler();
createApp().listen(config.port, () => console.log(`SitesForStudios API on http://localhost:${config.port}`));
