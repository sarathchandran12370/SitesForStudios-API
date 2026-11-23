# Deploying SitesForStudios (EC2)

The test environment runs on one EC2 server (Ubuntu 24.04) that also hosts other apps. Everything for SitesForStudios is added alongside them, never in place of them.

| Part | Where | Notes |
| --- | --- | --- |
| Web app + studio websites | nginx serves `/var/www/sitesforstudios` | `https://api.thaaram.in` |
| API | Node 24 under PM2 as `sfs-api`, port 4000, nginx proxies `/api/` | Private Node in `~/apps/sitesforstudios/node`; the system Node is untouched |
| PostgreSQL | Local, its own role and database `sitesforstudios` | Listens on localhost only |
| MongoDB | The existing local MongoDB, separate database `sitesforstudios` | Other databases untouched |
| Photos | Server disk, `~/apps/sitesforstudios/shared/storage` | Switch to S3 later (below) |
| Secrets | `~/apps/sitesforstudios/shared/.env` (generated on first deploy, mode 600) | Never in git |
| HTTPS | Let's Encrypt via certbot, renewed automatically | |

## One-time setup

1. **DNS.** At your DNS provider (GoDaddy for thaaram.in), add an **A record**: host `api`, value = the server's public IP, TTL 600. Check it with `dig +short api.thaaram.in`.
2. **Get the code onto the server** (as the app user, no sudo):
   ```bash
   ssh $thaaral 'mkdir -p ~/apps/sitesforstudios && cd ~/apps/sitesforstudios && git clone -q git@github.com:sarathchandran12370/SitesForStudios-API.git server'
   ```
3. **Sudo setup** (PostgreSQL, web folder, nginx site, HTTPS). It asks for your sudo password:
   ```bash
   ssh -t $thaaral 'sudo bash ~/apps/sitesforstudios/server/deploy/ec2/setup-root.sh'
   ```
   If DNS wasn't ready, run it again later to get the HTTPS certificate.
4. **First deploy** (below). The Super Admin login is written to `~/apps/sitesforstudios/shared/initial-admin.txt`:
   ```bash
   ssh $thaaral 'cat ~/apps/sitesforstudios/shared/initial-admin.txt'
   ```

## Deploy (every time)

Push to `main` in both repos (GitHub Actions runs the tests), then:

```bash
ssh $thaaral 'bash ~/apps/sitesforstudios/server/deploy/ec2/deploy.sh'
```

It pulls both repos, installs dependencies, runs database migrations, builds the web app, publishes it, restarts `sfs-api` and checks its health. If the health check fails it prints the last logs.

## Day to day

- Logs: `ssh $thaaral 'pm2 logs sfs-api --lines 100'`
- Status: `ssh $thaaral 'pm2 status'`
- Settings: edit `~/apps/sitesforstudios/shared/.env`, then run the deploy command (or `pm2 reload sfs-api --update-env`).
- Emails are recorded, not sent, until Amazon SES is set up (`EMAIL_PROVIDER=ses`). Sign-up codes and invites appear in Super Admin → Sent messages.

## Later

- **Photos on S3:** set `STORAGE_DRIVER=s3`, `S3_BUCKET_NAME`, `AWS_REGION=ap-south-1` and AWS credentials (better: attach an IAM role to the instance with access to that bucket and Rekognition). Give the bucket CORS for `PUT` from `https://api.thaaram.in`.
- **Face recognition:** `FACE_PROVIDER=rekognition` (needs the same AWS access).
- **Razorpay:** keys, seller details and the webhook `https://api.thaaram.in/api/billing/webhook` (see README).
- **Own server or bigger instance** before real customers: this one has 1 GB RAM and is shared.
- **Production domain:** when `sitesforstudios.in` is bought, point it here, add it to nginx and certbot, set `APP_URL` and rebuild the web app with `VITE_APP_HOSTS`.
- **Backups:** nightly `pg_dump` and `mongodump` of the `sitesforstudios` databases to S3.
