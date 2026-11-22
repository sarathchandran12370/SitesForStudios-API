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
