# Deploying SitesForStudios

Both repos deploy to AWS Mumbai (`ap-south-1`) from GitHub Actions on every push to `main`. One CloudFormation stack ([deploy/cloudformation.yml](deploy/cloudformation.yml)) creates everything both apps need. You set it up once, by hand, in the AWS console; after that, deploys are automatic.

## What runs where

| Part | AWS service | Deployed by |
| --- | --- | --- |
| Web app + studio websites | S3 bucket behind CloudFront | [SitesForStudios-UI](https://github.com/sarathchandran12370/SitesForStudios-UI) workflow: build, sync to S3, refresh CloudFront |
| API | One EC2 instance (t4g.small, Node 24, systemd), reached through the same CloudFront address at `/api/*` | This repo's workflow: test, upload release to S3, install it on the instance through SSM |
| PostgreSQL | RDS PostgreSQL 16 (db.t4g.micro, encrypted, 7-day backups) | Migrations run on every API deploy |
| MongoDB | MongoDB Atlas (you create it) | — |
| Photos | Private S3 bucket. RAW moves to Glacier Instant Retrieval after 7 days, originals to Standard-IA after 90 | — |
| Secrets | Secrets Manager (database, JWT, media signing, CloudFront header, admin password, Atlas URL, Razorpay) | Read by the instance on each deploy |
| GitHub → AWS | OpenID Connect roles (no AWS keys stored in GitHub), one per repo, usable only from its `production` environment | — |

The UI and API share one CloudFront address, so the login cookie works without any cross-origin setup. CloudFront adds a secret header to API requests, and the API refuses requests that arrive without it.

**Approximate fixed cost:** about $35–40 a month plus MongoDB Atlas (Flex about $8–30, M10 about $57). That is EC2 t4g.small ~$13, RDS ~$16, public IPv4 ~$4, Secrets Manager ~$3. S3 storage, CloudFront traffic and Rekognition are extra and grow with usage. These are estimates; check the [AWS Pricing Calculator](https://calculator.aws/).

## One-time setup

### 1. Create the MongoDB Atlas database

1. In [MongoDB Atlas](https://cloud.mongodb.com), create a cluster on **AWS, Mumbai (ap-south-1)**. Flex is fine to start.
2. **Database Access:** add a database user with a strong password.
3. **Connect → Drivers:** copy the connection string and put `sitesforstudios` as the database name, for example `mongodb+srv://sfs:PASSWORD@cluster0.abcde.mongodb.net/sitesforstudios?retryWrites=true&w=majority`.
4. Leave **Network Access** for step 3.

### 2. Create the AWS stack

1. Sign in to the AWS console and switch the region to **Asia Pacific (Mumbai)**.
2. Optional but recommended: open **VPC → Managed prefix lists**, find `com.amazonaws.global.cloudfront.origin-facing`, and copy its ID (starts with `pl-`).
3. Open **CloudFormation → Create stack → With new resources**, choose **Upload a template file**, and upload `deploy/cloudformation.yml` from this repo.
4. Stack name: `sitesforstudios`. Fill in:
   - **VpcId:** your default VPC.
   - **SubnetIds:** at least two subnets of that VPC in different availability zones.
   - **CloudFrontPrefixListId:** the `pl-…` ID from step 2, or leave empty.
   - **AdminEmail:** the email you will log in with as Super Admin.
   - **MongoUrl:** the Atlas connection string from step 1.
   - **Razorpay** fields: leave empty until billing is ready.
   - **CreateGitHubOidcProvider:** `true`, unless this AWS account already has the `token.actions.githubusercontent.com` identity provider (IAM → Identity providers).
5. Tick **I acknowledge that AWS CloudFormation might create IAM resources with custom names**, then **Submit**.
6. Wait for `CREATE_COMPLETE` (about 15–20 minutes; CloudFront and RDS are the slow parts). Keep the **Outputs** tab open for the next steps.

### 3. Let the API reach Atlas

In Atlas **Network Access**, add the `ApiPublicIp` value from the stack outputs.

### 4. Connect the API repo

In **SitesForStudios-API → Settings**:

1. **Environments → New environment** named `production`. Under **Deployment branches**, choose **Selected branches** and add `main`. Optionally add yourself as a required reviewer to approve each deploy.
2. **Secrets and variables → Actions → Variables → New repository variable**, add:

   | Variable | Value (from stack outputs) |
   | --- | --- |
   | `AWS_DEPLOY_ROLE_ARN` | `ApiDeployRoleArn` |
   | `DEPLOY_BUCKET` | `DeployBucketName` |
   | `API_INSTANCE_ID` | `ApiInstanceId` |

3. **Actions → API CI / Deploy → Run workflow** on `main`. The deploy job installs the API, runs migrations, creates the Super Admin and checks health. If it fails, its log shows the instance output.

Deploy the API before the UI, so the app works as soon as the UI is live.

### 5. Connect the UI repo

In **SitesForStudios-UI → Settings**:

1. Create the same `production` environment, limited to `main`.
2. Add these repository variables:

   | Variable | Value |
   | --- | --- |
   | `AWS_DEPLOY_ROLE_ARN` | `UiDeployRoleArn` (from stack outputs) |
   | `UI_BUCKET` | `SiteBucketName` |
   | `CLOUDFRONT_DISTRIBUTION_ID` | `DistributionId` |
   | `APP_HOSTS` | Optional. Your own app domain later, e.g. `app.sitesforstudios.com` |

3. **Actions → UI CI / Deploy → Run workflow** on `main`.

### 6. First login

1. Open the `AppUrl` output (`https://dxxxx.cloudfront.net`).
2. In **Secrets Manager**, open `sitesforstudios/admin-password` → **Retrieve secret value**.
3. Log in with your `AdminEmail` and that password, then change the password from the sidebar.
4. Create your first organization and studio. The demo data is not loaded in production.

## Everyday use

- **Deploy:** push to `main` in either repo. Pull requests run the tests and build only.
- **Roll back:** re-run an older successful run of the deploy workflow (Actions → pick the run → Re-run jobs). The API also rolls back on its own if the new release fails its health check.
- **Server logs:** EC2 → the `sitesforstudios-api` instance → **Connect → Session Manager**, then `sudo journalctl -u sitesforstudios -f`. No SSH key or open SSH port is needed.
- **Change a secret** (Atlas URL, Razorpay keys): update it in Secrets Manager or update the stack parameters, then re-run the API deploy so the instance picks it up.

## Later

- **Your own app domain** (`app.sitesforstudios.com`): request a certificate in **ACM in us-east-1**, add the domain and certificate to the CloudFront distribution, point DNS at the distribution, and add the domain to the UI's `APP_HOSTS`. Also update `APP_URL` in `/etc/sitesforstudios/stack.env` on the instance and redeploy.
- **Studio custom domains:** each studio domain must also be added to CloudFront with a certificate. The planned job (README production checklist) will automate this with CloudFront multi-tenant distributions.
- **More traffic:** move to two instances behind a load balancer, and move photo processing to SQS + Lambda (README production checklist).

## Removing the stack

The database has deletion protection, and the photo bucket is kept when the stack is deleted, so customer photos are never lost by accident. Turn off deletion protection on the RDS instance first if you really want to delete everything.
