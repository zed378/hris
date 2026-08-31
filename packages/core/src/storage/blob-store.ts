import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Binary file storage.
 *
 * Pulled out of the attendance photo pipeline once employee documents needed the
 * same thing. Not a contrived abstraction: the first version of photo storage
 * carried two bugs that hid each other — a relative path that differed per
 * process, and a deletion that swallowed its errors — and copying that pattern
 * into employee documents would have copied both, silence included.
 *
 *
 * Its interface is deliberately this narrow so that replacing it with an
 * S3-compatible one later touches a single file.
 */

export class BlobError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid_key' | 'not_found' | 'too_large',
  ) {
    super(message);
    this.name = 'BlobError';
  }
}

/**
 * The storage root.
 *
 * A relative path resolves against the repository root, NOT against the
 * process's working directory. The difference is not tidiness: `apps/web` and
 * `apps/worker` run from different directories, so a relative path makes the two
 * point at different places — one process writes, the other looks in the wrong
 * place, and the cleanup job reports successfully deleting files it never found.
 */
function storageRoot(envVar: string, fallback: string): string {
  const configured = process.env[envVar] ?? fallback;
  if (isAbsolute(configured)) return configured;

  // packages/core/src/storage/blob-store.ts → four levels up to the repository root.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../..', configured);
}

export interface DeleteOutcome {
  /** The file was genuinely deleted on this call. */
  removed: boolean;
  /** The file was already gone. Not an error. */
  alreadyGone: boolean;
}

export interface BlobStore {
  /** Stores the contents and returns its key. */
  put: (content: Buffer, extension: string) => Promise<{ key: string; bytes: number }>;
  get: (key: string) => Promise<Buffer>;
  /** The file size in bytes, or null when it does not exist. */
  size: (key: string) => Promise<number | null>;
  /**
   * Deletes a file.
   *
   * Distinguishes "already gone" from "failed to delete". The first version of
   * the photo pipeline swallowed every error, so a file that was NOT FOUND was
   * reported as successfully deleted — the retention job looked like it was
   * working perfectly while every file was still on disk. A failure other than
   * file-not-found is thrown, so the caller can count it and not delete its
   * reference.
   */
  remove: (key: string) => Promise<DeleteOutcome>;
}

/**
 * Creates a store with its own root and key rules.
 *
 * `envVar` allows each kind of file to be moved separately — attendance photos
 * to a short-lived volume, employee documents to one that is backed up.
 */
export function createBlobStore(options: {
  envVar: string;
  fallbackDir: string;
  /** The accepted extensions, without the dot. */
  extensions: string[];
  maxBytes: number;
}): BlobStore {
  const allowed = new Set(options.extensions.map((extension) => extension.toLowerCase()));

  // The key is validated so it cannot escape the storage directory. Without this,
  // a key containing "../" turns the file-serving endpoint into an arbitrary file
  // reader — and the cleanup job into an arbitrary file deleter.
  const pathFor = (key: string): string => {
    const match = /^([0-9a-f-]{36})\.([a-z0-9]{1,5})$/.exec(key);
    if (!match || !allowed.has(match[2]!)) {
      throw new BlobError('Kunci berkas tidak sah', 'invalid_key');
    }
    return join(storageRoot(options.envVar, options.fallbackDir), key.slice(0, 2), key);
  };

  return {
    async put(content, extension) {
      if (content.length > options.maxBytes) {
        throw new BlobError(
          `Ukuran berkas ${Math.round(content.length / 1024)} KB melebihi batas ${Math.round(options.maxBytes / 1024)} KB`,
          'too_large',
        );
      }

      // The key contains a random UUID, not an employee id or a date. A guessable
      // key means anyone who learns the pattern can fetch someone else's file just
      // by assembling the URL, which would make authorisation on the serving
      // endpoint the only guard rather than the second layer.
      const key = `${randomUUID()}.${extension.toLowerCase()}`;
      const path = pathFor(key);

      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);

      return { key, bytes: content.length };
    },

    async get(key) {
      try {
        return await readFile(pathFor(key));
      } catch (error) {
        if (error instanceof BlobError) throw error;
        throw new BlobError('Berkas tidak ditemukan', 'not_found');
      }
    },

    async size(key) {
      try {
        return (await stat(pathFor(key))).size;
      } catch {
        return null;
      }
    },

    async remove(key) {
      try {
        await unlink(pathFor(key));
        return { removed: true, alreadyGone: false };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { removed: false, alreadyGone: true };
        }
        throw error;
      }
    },
  };
}
