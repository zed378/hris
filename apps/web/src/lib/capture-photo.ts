'use client';

/**
 * Capturing and compressing selfie photos for attendance (document 10 §4.2).
 *
 * Compression is done on the device, not on the server. Raw photos from modern
 * phone cameras are 3–8 MB; sending them over mobile networks in industrial
 * areas means attendance that fails on timeout, or employee data quotas spent on
 * something that should be invisible.
 *
 * A beneficial side effect: drawing to canvas discards all metadata, including
 * EXIF GPS coordinates. The server still strips them again — what the client
 * sends is never the basis for a privacy guarantee.
 */

/** The longest side after resizing. Small enough to recognise a face. */
const MAX_DIMENSION = 800;
const JPEG_QUALITY = 0.7;

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly kind: 'denied' | 'unavailable' | 'failed',
  ) {
    super(message);
    this.name = 'CaptureError';
  }
}

/**
 * Resizes and compresses an image file to JPEG.
 *
 * Uses `createImageBitmap` which honours EXIF orientation before the metadata is
 * discarded — without it, photos from some phones are stored rotated 90 degrees
 * and HR reviews a queue of sideways faces.
 */
export async function compressImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new CaptureError('Image could not be read', 'failed');
  });

  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) throw new CaptureError('Device does not support image processing', 'unavailable');

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          :           reject(new CaptureError('Photo compression failed', 'failed')),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

/**
 * Opens the camera via a file input, not `getUserMedia`.
 *
 * `capture="user"` opens the front camera on phones, and on desktop falls back to
 * the ordinary file picker. `getUserMedia` offers a live preview, but demands a
 * persistent camera permission, its own orientation handling, and stream cleanup —
 * complexity disproportionate for one photo per click.
 *
 * A known limit: the file input lets the user pick from their gallery instead of
 * taking a new photo. This cannot be prevented on the web, and is exactly why
 * browser-based attendance always carries a trust penalty (document 10 §1.1).
 */
export function openCamera(): Promise<File> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'user';

    input.onchange = () => {
      const file = input.files?.[0];
      if (file) resolve(file);
      else reject(new CaptureError('No photo selected', 'failed'));
    };

    // The browser does not signal when the dialog is closed without choosing. What
    // happens is a promise that never resolves — so the caller must still be able
    // to proceed without a photo.
    input.click();
  });
}
