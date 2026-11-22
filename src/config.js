const env = process.env;

function required(name, fallback) {
  const v = env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env var ${name}`);
  return v;
}

const isProd = env.NODE_ENV === 'production';
if (isProd && (env.JWT_SECRET?.startsWith('dev-') || env.MEDIA_SIGNING_SECRET?.startsWith('dev-'))) {
  throw new Error('Set real JWT_SECRET and MEDIA_SIGNING_SECRET in production');
}

export const config = {
  isProd,
  port: Number(env.PORT || 4000),
  appUrl: env.APP_URL || 'http://localhost:5173',
  sitesCnameTarget: env.SITES_CNAME_TARGET || 'sites.sitesforstudios.com',
  databaseUrl: required('DATABASE_URL', 'postgres://localhost:5432/sitesforstudios'),
  mongoUrl: required('MONGO_URL', 'mongodb://127.0.0.1:27017/sitesforstudios'),
  jwtSecret: required('JWT_SECRET', 'dev-jwt-secret-change-me'),
  mediaSecret: required('MEDIA_SIGNING_SECRET', 'dev-media-secret-change-me'),
  storageDriver: env.STORAGE_DRIVER || 'local',
  awsRegion: env.AWS_REGION || 'ap-south-1',
  s3Bucket: env.S3_BUCKET || '',
  faceProvider: env.FACE_PROVIDER || 'none',
  razorpay: {
    keyId: env.RAZORPAY_KEY_ID || '',
    keySecret: env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
  },
};
