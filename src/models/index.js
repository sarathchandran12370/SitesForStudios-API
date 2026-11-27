import mongoose from 'mongoose';

const { Schema, model } = mongoose;

// Template customization for a studio website (minimal options by design).
const SiteConfigSchema = new Schema(
  {
    studioId: { type: String, required: true, unique: true },
    templateId: { type: String, default: 'editorial' },
    theme: {
      accent: { type: String, default: '#b08d57' },
      // "template" uses the selected template's own fonts; the others override them.
      fontPair: { type: String, enum: ['template', 'classic', 'modern', 'editorial'], default: 'template' },
    },
    logoKey: String,
    heroPhotoIds: [String],
    tagline: { type: String, default: 'Timeless wedding stories' },
    about: { type: String, default: '' },
    sections: {
      type: [{ id: String, enabled: Boolean }],
      default: () =>
        ['about', 'portfolio', 'packages', 'testimonials', 'faq', 'contact'].map((id) => ({ id, enabled: true })),
    },
    packages: [{ name: String, price: String, features: [String] }],
    testimonials: [{ quote: String, author: String }],
    faq: [{ q: String, a: String }],
    contact: {
      email: String,
      phone: String,
      whatsapp: String,
      city: String,
      instagram: String,
      youtube: String,
    },
    seo: { title: String, description: String },
  },
  { timestamps: true }
);

// One document per uploaded file. kind=image: edited JPEG/PNG; kind=raw: camera RAW; kind=video: MP4/MOV film.
const PhotoSchema = new Schema(
  {
    eventId: { type: String, required: true, index: true },
    studioId: { type: String, required: true, index: true },
    kind: { type: String, enum: ['image', 'raw', 'video'], default: 'image' },
    ceremony: { type: String, default: 'Wedding' },
    filename: String,
    originalKey: String,
    contentType: String, // videos: played straight from storage with this type
    // wm: the web-size preview with the watermark, made on first view; wmText is the text it carries.
    variants: { thumb: String, web: String, wm: String },
    wmText: String,
    width: Number,
    height: Number,
    bytes: Number,
    takenAt: Date,
    isHighlight: { type: Boolean, default: false },
    status: { type: String, enum: ['awaiting', 'uploaded', 'processing', 'ready', 'failed'], default: 'awaiting' },
    error: String,
    facesIndexed: { type: Boolean, default: false },
  },
  { timestamps: true }
);
PhotoSchema.index({ eventId: 1, kind: 1, ceremony: 1, filename: 1 });

const FaceSchema = new Schema(
  {
    eventId: { type: String, required: true, index: true },
    photoId: { type: String, required: true, index: true },
    providerFaceId: { type: String, index: true },
    box: { left: Number, top: Number, width: Number, height: Number }, // ratios 0..1
    confidence: Number,
    clusterId: { type: String, index: true },
  },
  { timestamps: true }
);

const PersonClusterSchema = new Schema(
  {
    eventId: { type: String, required: true, index: true },
    label: { type: String, default: '' },
    coverFaceId: String,
    faceCount: { type: Number, default: 0 },
    mergedInto: { type: String, default: null },
  },
  { timestamps: true }
);

export const SiteConfig = model('SiteConfig', SiteConfigSchema);
export const Photo = model('Photo', PhotoSchema);
export const Face = model('Face', FaceSchema);
export const PersonCluster = model('PersonCluster', PersonClusterSchema);
