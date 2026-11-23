// PM2 process for the SitesForStudios API on the EC2 (used by deploy.sh).
// Runs with the private Node 24 in ~/apps/sitesforstudios/node, so the system Node used by other apps is untouched.
const path = require('node:path');

const base = path.resolve(__dirname, '../../..'); // ~/apps/sitesforstudios

module.exports = {
  apps: [
    {
      name: 'sfs-api',
      cwd: path.join(base, 'server'),
      script: 'src/index.js',
      interpreter: path.join(base, 'node/bin/node'),
      node_args: `--env-file=${path.join(base, 'shared/.env')}`,
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '450M', // small server: restart instead of starving other apps
      kill_timeout: 10000,
      time: true,
    },
  ],
};
