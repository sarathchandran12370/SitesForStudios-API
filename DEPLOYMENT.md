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

## Web app on S3 + CloudFront

Target layout for the test environment: users open **`https://app.thaaram.in`** (CloudFront). CloudFront serves the web app from S3 and forwards `/api/*` to the EC2 (`api.thaaram.in`, port 80, which only CloudFront may reach). HTTPS is handled by CloudFront, so the EC2 needs no certificate.

1. **AWS (console):**
   - S3 bucket for the web app (private, no website hosting).
   - ACM certificate for `app.thaaram.in` in **us-east-1** (DNS validation in GoDaddy).
   - CloudFront distribution: origin 1 = the S3 bucket (Origin Access Control); origin 2 = `api.thaaram.in`, **HTTP only, port 80**. Default behaviour → S3 with the SPA rewrite function; behaviour `/api/*` → EC2, all methods, cache policy *CachingDisabled*, origin request policy *AllViewerExceptHostHeader*. Alternate domain `app.thaaram.in` with the certificate.
   - EC2 security group: inbound **HTTP 80 from the managed prefix list `com.amazonaws.global.cloudfront.origin-facing`** (CloudFront only).
   - IAM OIDC role for GitHub (repo `SitesForStudios-UI`, environment `production`) allowed to sync the bucket and invalidate the distribution.
2. **DNS (GoDaddy):** `app` CNAME → the distribution's `dxxxx.cloudfront.net`.
3. **GitHub (SitesForStudios-UI → Settings):** environment `production`; variables `AWS_DEPLOY_ROLE_ARN`, `UI_BUCKET`, `CLOUDFRONT_DISTRIBUTION_ID` (optional `APP_HOSTS`, default `app.thaaram.in`). Pushes to `main` then deploy the web app.
4. **EC2 switch to API-only** (once CloudFront works):
   ```bash
   ssh -t $thaaral 'sudo APP_DOMAIN=app.thaaram.in bash ~/apps/sitesforstudios/server/deploy/ec2/use-cloudfront.sh'
   ```
   ```bash
   ssh $thaaral 'bash ~/apps/sitesforstudios/server/deploy/ec2/deploy.sh'
   ```
   nginx then only serves `/api` (other paths redirect to the app), `APP_URL` becomes `https://app.thaaram.in`, and the API trusts CloudFront + nginx for client IPs.

## Later

- **Photos on S3:** set `STORAGE_DRIVER=s3`, `S3_BUCKET_NAME`, `AWS_REGION=ap-south-1` and AWS credentials (better: attach an IAM role to the instance with access to that bucket and Rekognition). Give the bucket CORS for `PUT` from `https://api.thaaram.in`.
- **Face recognition:** `FACE_PROVIDER=rekognition` (needs the same AWS access).
- **Razorpay:** keys, seller details and the webhook `https://api.thaaram.in/api/billing/webhook` (see README).
- **Own server or bigger instance** before real customers: this one has 1 GB RAM and is shared.
- **Production domain:** when `sitesforstudios.in` is bought, point it here, add it to nginx and certbot, set `APP_URL` and rebuild the web app with `VITE_APP_HOSTS`.
- **Backups:** nightly `pg_dump` and `mongodump` of the `sitesforstudios` databases to S3.
