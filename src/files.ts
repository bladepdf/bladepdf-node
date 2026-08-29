import {
  constants,
  link,
  open,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import { UnableToWritePdfError } from './errors.js';

async function targetExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function createTemporaryPath(path: string): Promise<string> {
  const directory = dirname(path);
  const name = basename(path);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = join(
      directory,
      `.${name}.bladepdf-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
    );

    try {
      const handle = await open(
        candidate,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.close();
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  throw new Error('Unable to reserve a temporary PDF path.');
}

async function commitTemporaryFile(
  temporaryPath: string,
  targetPath: string,
  overwrite: boolean,
): Promise<void> {
  if (!overwrite) {
    await link(temporaryPath, targetPath);
    await unlink(temporaryPath);
    return;
  }

  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code !== 'EEXIST' && code !== 'EPERM') {
      throw error;
    }

    await rm(targetPath, { force: true });
    await rename(temporaryPath, targetPath);
  }
}

async function atomicWrite(
  targetPath: string,
  overwrite: boolean,
  writer: (temporaryPath: string) => Promise<void>,
): Promise<string> {
  let temporaryPath: string | undefined;

  try {
    if (!overwrite && (await targetExists(targetPath))) {
      throw new Error(`The target file [${targetPath}] already exists.`);
    }

    temporaryPath = await createTemporaryPath(targetPath);
    await writer(temporaryPath);
    await commitTemporaryFile(temporaryPath, targetPath, overwrite);
    temporaryPath = undefined;

    return targetPath;
  } catch (error) {
    if (temporaryPath) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }

    if (error instanceof UnableToWritePdfError) {
      throw error;
    }

    throw new UnableToWritePdfError(
      `Unable to write the generated PDF to [${targetPath}].`,
      { cause: error },
    );
  }
}

export async function atomicWriteBuffer(
  path: string,
  contents: Uint8Array,
  overwrite = true,
): Promise<string> {
  return atomicWrite(path, overwrite, async (temporaryPath) => {
    await writeFile(temporaryPath, contents);
  });
}

export async function atomicWriteStream(
  path: string,
  stream: Readable,
  overwrite = true,
): Promise<string> {
  return atomicWrite(path, overwrite, async (temporaryPath) => {
    const handle = await open(temporaryPath, 'w');
    const writable = handle.createWriteStream();

    try {
      await pipeline(stream, writable);
    } finally {
      await handle.close().catch(() => undefined);
    }
  });
}
