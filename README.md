# SitesForStudios API

Backend for SitesForStudios, the website builder and client photo delivery platform for wedding studios. The web app lives in [SitesForStudios-UI](https://github.com/sarathchandran12370/SitesForStudios-UI).

Node.js 24 · Express 5 · PostgreSQL 16 · MongoDB · Amazon S3 · Amazon Rekognition · Razorpay

## Run locally

Requires Node 24+, PostgreSQL 16 and MongoDB running locally.

```bash
npm install
```

```bash
createdb sitesforstudios
```

```bash
cp .env.example .env
```

```bash
npm run migrate
```

```bash
npm run seed -- --demo
```

```bash
npm run dev
```

The API runs on http://localhost:4000. Check it with `GET /api/health`.

### Demo logins (after `npm run seed -- --demo`)

| Role | Email | Password |
| --- | --- | --- |
| Super Admin | admin@sitesforstudios.local | ChangeMe!2026 |
| Organization owner | owner@demo.local | Demo!2026 |
| Studio admin | studio@demo.local | Demo!2026 |
| Client (couple) | couple@demo.local | Demo!2026 |

These are local test values only.

## Tests

```bash
npm test
```

Runs the API test suite (Node's built-in test runner) against a separate test database: PostgreSQL `sitesforstudios_test` (created automatically) and MongoDB `sitesforstudios_test`, with local file storage in a temp folder. Your dev data, S3 and AWS are never touched. Override the databases with `TEST_DATABASE_URL` and `TEST_MONGO_URL`. Set `TEST_VERBOSE=1` to see server logs.

Covered: login and passwords, role checks, suspended organizations, plan editing and limits, notifications, retention (warnings, archive, restore), uploads incl. HEIC, ZIP and RAW downloads.

## Notifications and retention

- **Email:** `EMAIL_PROVIDER=log` (development) records messages in the `notifications` table, visible to the Super Admin under **Sent messages**. `EMAIL_PROVIDER=ses` sends through Amazon SES (verify the `EMAIL_FROM` domain in SES first).
- **WhatsApp:** `WHATSAPP_PROVIDER=meta` with a WhatsApp Business Cloud API token, phone number ID and approved template names (`WHATSAPP_TEMPLATE_*`). Template parameters in order: invite `{{1}} name, {{2}} studio, {{3}} login URL, {{4}} email, {{5}} temporary password`; photos ready `{{1}} name, {{2}} event, {{3}} studio, {{4}} link`; enquiry `{{1}} name, {{2}} phone, {{3}} date, {{4}} link`; retention `{{1}} name, {{2}} event, {{3}} archive date, {{4}} link`.
- **Retention:** every `RETENTION_CHECK_HOURS` the API warns the studio and couple 30 and 7 days before an event expires, archives expired events (originals and RAW to S3 Glacier Deep Archive, clients lose access) and completes restores. A restore (₹499 by default) takes up to ~12 hours on S3 and keeps the event online for 6 more months. Deep Archive bills a minimum of 180 days per object.

## Onboarding: self sign-up and trials

- **Self sign-up** at `/signup` (turn off with `SIGNUP_ENABLED=false`): "I run a studio" or "I run several studios". Details → 6-digit email code (10 minutes, 5 attempts, resend after 60 s) → organization, first studio and owner account are created on a free trial and the owner is logged in. Outside production with `EMAIL_PROVIDER=log`, the code is also shown on screen for testing. Clients (couples, guests) still cannot sign up.
- **Single-studio mode:** when the plan allows one studio, the owner only sees their Studio dashboard (plus Plan & billing); the organization works in the background. When the plan allows more studios (Organization plan), the Organization dashboard appears automatically.
- **Trials** (`TRIAL_DAYS`, default 14): reminder emails 7, 3 and 1 days before the end. At the end the organization becomes **expired**: studio dashboards are read-only except billing, uploads are paused, websites and client galleries stay online for `TRIAL_GRACE_DAYS` (default 14), then the organization is **suspended**. Paying sets it to active. The Super Admin can add 14 days from the Platform page.
- **Getting-started checklist** on the Studio and Organization dashboards (customise and publish the website, first event, photos, client, notify, billing details, plan).

## Billing (Razorpay + GST invoices)

Organization owners manage their plan under **Plan & billing**: choose or upgrade a plan (monthly or yearly), pay with Razorpay Checkout, enter billing details (GSTIN optional) and download invoices.

Setup:
1. In the Razorpay dashboard (test mode first), create a subscription **plan for each plan and cycle** with the amount **including GST** (e.g. Starter monthly ₹3,499 + 18% = ₹4,128.82). Paste the plan IDs into Super Admin → Plans → Edit (monthly and yearly).
2. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and the seller details (`SELLER_NAME`, `SELLER_GSTIN`, `SELLER_ADDRESS`, `SELLER_STATE_CODE`, `SELLER_EMAIL`). GST is charged only when `SELLER_GSTIN` is set. Confirm the SAC code (`GST_SAC`, default 997331) with your CA.
3. Add a webhook in Razorpay pointing to `https://<api domain>/api/billing/webhook` with the events `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.updated`, and set `RAZORPAY_WEBHOOK_SECRET`.

How it works: the first payment is verified by signature and creates invoice `SFS/<FY>/0001`; renewals arrive by webhook and are invoiced once per payment. Upgrades apply immediately, downgrades at the end of the paid period, cancellation at period end. Same state as the seller → CGST + SGST, otherwise IGST. Gallery restores are added to the next renewal as Razorpay add-ons and appear as invoice lines. Invoice numbers are gap-free per financial year (April–March).

## Postman

Import the files in [postman/](postman/) into Postman: the collection plus the Local and Production environments. Each folder starts with a login for its role, and requests save the ids they return, so run folders top to bottom. To run everything from the command line against a local API with demo data:

```bash
npx newman run postman/SitesForStudios-API.postman_collection.json -e postman/SitesForStudios-Local.postman_environment.json
```

## Structure

```
src/
├── index.js            server entry, route mounting, error handler
├── config.js           environment settings
├── db/
│   ├── migrations/     PostgreSQL schema (applied by npm run migrate)
│   ├── pg.js           PostgreSQL pool
│   ├── mongo.js        MongoDB connection
│   └── seed.js         plans, templates, super admin, demo data
├── models/index.js     MongoDB models: SiteConfig, Photo, Face, PersonCluster
├── middleware/auth.js  session cookie, role and ownership checks
├── routes/             one router per role (see below)
└── services/
    ├── storage.js      local disk (dev) or S3, signed URLs
    ├── processing.js   thumbnails + face indexing queue
    └── faces.js        Rekognition collections, clustering, selfie search
```

| Role | Route file | Prefix |
| --- | --- | --- |
| Super Admin | `routes/admin.js` | `/api/admin` |
| Organization | `routes/orgs.js` | `/api/org` |
| Studio (partner) | `routes/studios.js`, `routes/events.js` | `/api/studios`, `/api/events` |
| Client | `routes/portal.js` | `/api/portal` |
| Public | `routes/public.js` | `/api/sites…`, `/api/media`, `/api/uploads` |
| Shared | `routes/auth.js`, `routes/billing.js` | `/api/auth`, `/api/billing` |

## How the main flows work

- **Accounts:** studios create client accounts and get a one-time temporary password. Clients must set their own password at first login. There is no public sign-up and no forgot-password endpoint; studios reset passwords, which logs the user out everywhere.
- **Uploads:** `POST /api/events/:id/uploads` returns signed upload URLs; the browser PUTs files straight to storage, then calls `uploads/complete`. A worker makes WebP thumbnail and web versions and indexes faces.
- **Downloads:** single photos redirect to short-lived signed URLs. ZIPs (all, highlights, ceremony, selection, RAW) stream on the fly. RAW is only for `primary` (couple) access on events with RAW delivery on.
- **Face recognition:** one Rekognition collection per event, faces grouped into person clusters at 90% similarity. Clients can name and merge people and search by selfie (not stored). Deleting an event deletes its face data.
- **Custom domains:** a studio sets a domain, adds a CNAME to `SITES_CNAME_TARGET` and a TXT record, then verifies.
- **Plans:** storage quota, studios per organization, staff seats, RAW delivery and premium templates are enforced here.

## Deployment

The test environment runs on an EC2 server at `https://api.thaaram.in` (web app + API behind nginx, API under PM2). Setup and the one-line deploy command are in [DEPLOYMENT.md](DEPLOYMENT.md); scripts are in [deploy/ec2/](deploy/ec2/). GitHub Actions (`.github/workflows/ci.yml`) runs the tests on every push.

## Production checklist

- [ ] `NODE_ENV=production`, real `JWT_SECRET` and `MEDIA_SIGNING_SECRET`.
- [ ] `STORAGE_DRIVER=s3` with a private bucket in `ap-south-1`, CORS for PUT from the app origin, lifecycle rules (originals to Standard-IA after 90 days, RAW to Glacier Instant Retrieval).
- [ ] CloudFront signed URLs for media.
- [ ] Move processing from the in-process queue to S3 events → SQS → Lambda.
- [ ] Background ZIP jobs (5 GB parts) with an emailed link.
- [ ] `FACE_PROVIDER=rekognition` with an IAM role, plus a consent screen before first face search.
- [ ] Custom domain job: verify DNS, request ACM certificate, attach to CloudFront.
- [ ] Razorpay plans, keys and webhook (`/api/billing/webhook`).
- [ ] Enquiry notifications by email (SES) and WhatsApp.
- [ ] Automated tests and CI.
