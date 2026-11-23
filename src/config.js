const env = process.env;

function required(name, fallback) {
  const v = env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env var ${name}`);
  return v;
}

const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';
if (isProd && (env.JWT_SECRET?.startsWith('dev-') || env.MEDIA_SIGNING_SECRET?.startsWith('dev-'))) {
  throw new Error('Set real JWT_SECRET and MEDIA_SIGNING_SECRET in production');
}

export const config = {
  isProd,
  isTest,
  // Rate limits are relaxed in automated tests only.
  rateLimitScale: isTest ? 100 : 1,
  port: Number(env.PORT || 4000),
  appUrl: env.APP_URL || 'http://localhost:5173',
  sitesCnameTarget: env.SITES_CNAME_TARGET || 'sites.sitesforstudios.com',
  databaseUrl: required('DATABASE_URL', 'postgres://localhost:5432/sitesforstudios'),
  mongoUrl: required('MONGO_URL', 'mongodb://127.0.0.1:27017/sitesforstudios'),
  jwtSecret: required('JWT_SECRET', 'dev-jwt-secret-change-me'),
  mediaSecret: required('MEDIA_SIGNING_SECRET', 'dev-media-secret-change-me'),
  storageDriver: env.STORAGE_DRIVER || 'local',
  awsRegion: env.AWS_REGION || 'ap-south-1',
  s3Bucket: env.S3_BUCKET_NAME || env.S3_BUCKET || '',
  faceProvider: env.FACE_PROVIDER || 'none',
  // Secret header CloudFront adds to every request it forwards to the API (production only).
  originVerifySecret: env.ORIGIN_VERIFY_SECRET || '',
  // Path to the RDS CA bundle; when set, PostgreSQL connections use verified TLS.
  databaseSslCa: env.DATABASE_SSL_CA || '',
  // Photos processed at the same time. Keep 1 on small (1 GB) servers.
  processingConcurrency: Math.max(1, Number(env.PROCESSING_CONCURRENCY || 1)),
  notifications: {
    // Email: "log" (dev: printed and stored in the notifications table) or "ses" (Amazon SES).
    emailProvider: env.EMAIL_PROVIDER || 'log',
    emailFrom: env.EMAIL_FROM || 'SitesForStudios <no-reply@sitesforstudios.in>',
    // WhatsApp: "none" or "meta" (WhatsApp Business Cloud API with approved templates).
    whatsappProvider: env.WHATSAPP_PROVIDER || 'none',
    whatsappToken: env.WHATSAPP_TOKEN || '',
    whatsappPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    whatsappLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',
    whatsappTemplates: {
      invite: env.WHATSAPP_TEMPLATE_INVITE || '',
      photosReady: env.WHATSAPP_TEMPLATE_PHOTOS_READY || '',
      enquiry: env.WHATSAPP_TEMPLATE_ENQUIRY || '',
      retention: env.WHATSAPP_TEMPLATE_RETENTION || '',
    },
  },
  retention: {
    // Hours between retention checks (warnings, archiving, restores). 0 disables the scheduler.
    checkEveryHours: Number(env.RETENTION_CHECK_HOURS ?? 1),
    restoreExtendsMonths: Number(env.RESTORE_EXTENDS_MONTHS || 6),
    restorePriceInr: Number(env.RESTORE_PRICE_INR || 499),
  },
  signup: {
    enabled: env.SIGNUP_ENABLED !== 'false',
    trialDays: Number(env.TRIAL_DAYS || 14),
    graceDays: Number(env.TRIAL_GRACE_DAYS || 14), // after the trial ends, websites/galleries stay up this long
  },
  razorpay: {
    keyId: env.RAZORPAY_KEY_ID || '',
    keySecret: env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
    apiBase: env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1', // tests point this at a fake server
  },
  // Seller details printed on invoices. GST is charged only when SELLER_GSTIN is set.
  billing: {
    sellerName: env.SELLER_NAME || 'SitesForStudios',
    sellerGstin: (env.SELLER_GSTIN || '').toUpperCase(),
    sellerAddress: env.SELLER_ADDRESS || '',
    sellerStateCode: env.SELLER_STATE_CODE || (env.SELLER_GSTIN ? env.SELLER_GSTIN.slice(0, 2) : '32'),
    sellerEmail: env.SELLER_EMAIL || '',
    sac: env.GST_SAC || '997331', // confirm the SAC code with your CA
    gstRatePercent: Number(env.GST_RATE_PERCENT || 18),
    invoicePrefix: env.INVOICE_PREFIX || 'SFS',
  },
};
