import { createBlobStore, BlobError, type DeleteOutcome } from '../storage/index.ts';

/**
 * The attendance photo pipeline (document 10 §4).
 *
 * Four things must happen to every photo, and their order matters:
 *
 *   1. Validate    — JPEG only, and only below the size limit.
 *   2. Strip EXIF  — GPS coordinates, device model, and camera serial number
 *                    are discarded. An attendance selfie carrying EXIF is a
 *                    location tracker disguised as evidence of attendance.
 *   3. Store       — with an unguessable key.
 *   4. Retention   — 90 days, then deleted. Its attendance record stays intact.
 *
 * Step 2 happens on the server even though the client already compresses through
 * a canvas (which happens to drop EXIF). Evidence sent by a client is never the
 * basis of a privacy guarantee — the client can be replaced, and who bears that
 * is the employee who does not know their photo carries their home coordinates.
 */

/** The size limit after client compression. An 800px JPEG at q0.7 ≈ 80–150 KB. */
export const MAX_PHOTO_BYTES = 512 * 1024;

export class PhotoError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid_format' | 'too_large' | 'not_found',
  ) {
    super(message);
    this.name = 'PhotoError';
  }
}

/**
 * Strips every metadata segment from a JPEG.
 *
 * Written by hand rather than using `sharp`. The reason is not a reluctance to
 * use a library: `sharp` brings a native binary that has to be rebuilt per
 * architecture, and all that is needed here is dropping segments — not changing
 * pixels. The client already handles resizing through a canvas.
 *
 * The JPEG structure is simple enough for this: the file is a sequence of
 * segments, each beginning with 0xFF followed by a marker and its length. What is
 * dropped is APP1 (EXIF, XMP), APP2 (ICC), and COM (comments).
 */
export function stripJpegMetadata(input: Buffer): Buffer {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) {
    throw new PhotoError('Berkas bukan JPEG yang sah', 'invalid_format');
  }

  const output: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let offset = 2;

  while (offset < input.length - 1) {
    if (input[offset] !== 0xff) break;

    const marker = input[offset + 1]!;

    // 0xDA begins the compressed data; everything from there to the end of the
    // file is copied as it is. There is no metadata after this point.
    if (marker === 0xda) {
      output.push(input.subarray(offset));
      break;
    }

    // Markers with no payload.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = input.readUInt16BE(offset + 2);
    const segment = input.subarray(offset, offset + 2 + length);

    // APP1 (0xE1) holds EXIF and XMP — that is where the GPS coordinates live.
    // APP2 (0xE2) holds the ICC profile. COM (0xFE) holds free-form comments.
    const isMetadata = marker === 0xe1 || marker === 0xe2 || marker === 0xfe;
    if (!isMetadata) output.push(segment);

    offset += 2 + length;
  }

  return Buffer.concat(output);
}

export interface StoredPhoto {
  key: string;
  bytes: number;
}

/**
 * Photo storage.
 *
 * A local implementation for development and a single-VPS deployment — which is
 * the planned topology (PLAN/12 §3.2). Its interface is deliberately this narrow
 * so that replacing it with an S3-compatible one later touches a single file.
 *
 * The object key contains a random UUID, not an employee id or a date. A
 * guessable key means anyone who learns the pattern can fetch someone else's
 * photo just by assembling the URL — and authorisation on the serving endpoint
 * becomes the only guard rather than the second layer.
 */
/**
 * Attendance photo storage.
 *
 * Paths, key validation, and telling "already gone" apart from "failed to
 * delete" are handled by `@hrms/core/storage` — all three were once wrong here,
 * and fixing them in one place is cheaper than remembering to fix them
 * everywhere.
 */
const store = createBlobStore({
  envVar: 'PHOTO_STORAGE_DIR',
  fallbackDir: './.storage/attendance-photos',
  extensions: ['jpg'],
  maxBytes: MAX_PHOTO_BYTES,
});

export async function storePhoto(input: Buffer): Promise<StoredPhoto> {
  if (input.length > MAX_PHOTO_BYTES) {
    throw new PhotoError(
      `Ukuran foto ${Math.round(input.length / 1024)} KB melebihi batas ${MAX_PHOTO_BYTES / 1024} KB`,
      'too_large',
    );
  }

  // EXIF is dropped BEFORE storing, not when serving. A file that has ever
  // touched disk with coordinates inside it is already in a backup.
  return store.put(stripJpegMetadata(input), 'jpg');
}

export async function readPhoto(key: string): Promise<Buffer> {
  try {
    return await store.get(key);
  } catch (error) {
    throw new PhotoError(
      error instanceof BlobError && error.kind === 'invalid_key'
        ? 'Kunci foto tidak sah'
        : 'Foto tidak ditemukan atau sudah melewati masa retensi',
      error instanceof BlobError && error.kind === 'invalid_key' ? 'invalid_format' : 'not_found',
    );
  }
}

/**
 * Deletes a photo file.
 *
 * Distinguishes "already gone" from "failed to delete", and that distinction
 * carries the weight. The first version swallowed every error, so a file that was
 * NOT FOUND — because its storage path was wrong — was reported as successfully
 * deleted. The retention job looked like it was working perfectly while every
 * photo ever uploaded was still on disk.
 *
 * A failure other than file-not-found is thrown, so the caller can count it and
 * NOT delete its database reference. A surviving reference is the only way the
 * next round finds that file again.
 */
export async function deletePhoto(key: string): Promise<DeleteOutcome> {
  try {
    return await store.remove(key);
  } catch (error) {
    // Storage errors are translated into this module's vocabulary. Callers in
    // `apps/worker` and `apps/web` catch `PhotoError`; leaking a `BlobError`
    // through the front door would make their error handling miss it with not one
    // compilation error.
    if (error instanceof BlobError) {
      throw new PhotoError(
        error.kind === 'invalid_key' ? 'Kunci foto tidak sah' : error.message,
        error.kind === 'invalid_key' ? 'invalid_format' : 'not_found',
      );
    }
    throw error;
  }
}
