// Face recognition. "rekognition" uses Amazon Rekognition (one collection per event);
// "none" disables the feature (local development without AWS).
import { config } from '../config.js';
import { Face, PersonCluster } from '../models/index.js';

const MATCH_THRESHOLD = 90;
let client = null;

async function rk() {
  if (!client) {
    const { RekognitionClient } = await import('@aws-sdk/client-rekognition');
    client = new RekognitionClient({ region: config.awsRegion });
  }
  return client;
}

const collectionId = (eventId) => `sfs-event-${eventId}`;

export const facesEnabled = () => config.faceProvider === 'rekognition';

async function ensureCollection(eventId) {
  const { CreateCollectionCommand } = await import('@aws-sdk/client-rekognition');
  try {
    await (await rk()).send(new CreateCollectionCommand({ CollectionId: collectionId(eventId) }));
  } catch (e) {
    if (e.name !== 'ResourceAlreadyExistsException') throw e;
  }
}

/**
 * Index faces in one photo (JPEG bytes, already resized) and assign each face to a person cluster.
 * A new face joins the cluster of the best existing match above the threshold, else starts a new cluster.
 */
export async function indexPhotoFaces({ eventId, photoId, imageBytes }) {
  if (!facesEnabled()) return 0;
  const { IndexFacesCommand, SearchFacesCommand } = await import('@aws-sdk/client-rekognition');
  await ensureCollection(eventId);
  const out = await (await rk()).send(
    new IndexFacesCommand({
      CollectionId: collectionId(eventId),
      Image: { Bytes: imageBytes },
      ExternalImageId: photoId,
      MaxFaces: 30,
      QualityFilter: 'AUTO',
      DetectionAttributes: [],
    })
  );
  const records = out.FaceRecords || [];
  for (const rec of records) {
    const faceId = rec.Face.FaceId;
    const bb = rec.Face.BoundingBox;
    let clusterId = null;
    const search = await (await rk()).send(
      new SearchFacesCommand({ CollectionId: collectionId(eventId), FaceId: faceId, FaceMatchThreshold: MATCH_THRESHOLD, MaxFaces: 5 })
    );
    for (const m of search.FaceMatches || []) {
      const existing = await Face.findOne({ eventId, providerFaceId: m.Face.FaceId, clusterId: { $ne: null } });
      if (existing) {
        clusterId = await resolveCluster(existing.clusterId);
        break;
      }
    }
    const face = await Face.create({
      eventId,
      photoId,
      providerFaceId: faceId,
      box: { left: bb.Left, top: bb.Top, width: bb.Width, height: bb.Height },
      confidence: rec.Face.Confidence,
    });
    if (!clusterId) {
      const cluster = await PersonCluster.create({ eventId, coverFaceId: face.id, faceCount: 0 });
      clusterId = cluster.id;
    }
    face.clusterId = clusterId;
    await face.save();
    await PersonCluster.updateOne({ _id: clusterId }, { $inc: { faceCount: 1 } });
  }
  return records.length;
}

async function resolveCluster(id) {
  let current = await PersonCluster.findById(id);
  while (current?.mergedInto) current = await PersonCluster.findById(current.mergedInto);
  return current ? current.id : id;
}

/** "Find me": photo ids in this event that contain the face in the selfie. */
export async function searchBySelfie({ eventId, imageBytes }) {
  if (!facesEnabled()) return [];
  const { SearchFacesByImageCommand } = await import('@aws-sdk/client-rekognition');
  try {
    const out = await (await rk()).send(
      new SearchFacesByImageCommand({
        CollectionId: collectionId(eventId),
        Image: { Bytes: imageBytes },
        FaceMatchThreshold: MATCH_THRESHOLD,
        MaxFaces: 1000,
      })
    );
    return [...new Set((out.FaceMatches || []).map((m) => m.Face.ExternalImageId))];
  } catch (e) {
    if (e.name === 'InvalidParameterException') return []; // no face in selfie
    throw e;
  }
}

/** Delete all face data for an event (biometric data must not outlive the event). */
export async function deleteEventFaces(eventId) {
  await Face.deleteMany({ eventId });
  await PersonCluster.deleteMany({ eventId });
  if (!facesEnabled()) return;
  const { DeleteCollectionCommand } = await import('@aws-sdk/client-rekognition');
  try {
    await (await rk()).send(new DeleteCollectionCommand({ CollectionId: collectionId(eventId) }));
  } catch (e) {
    if (e.name !== 'ResourceNotFoundException') throw e;
  }
}
