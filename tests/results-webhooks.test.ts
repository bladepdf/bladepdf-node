import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  RenderResult,
  UnableToWritePdfError,
  verifyWebhookSignature,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe('RenderResult', () => {
  it('returns Buffer/base64 and atomically saves a PDF', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bladepdf-result-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'result.pdf');
    const result = new RenderResult(Buffer.from('%PDF-result'));

    expect(result.toBase64()).toBe(
      Buffer.from('%PDF-result').toString('base64'),
    );
    await expect(result.save(path)).resolves.toBe(path);
    expect(await readFile(path, 'utf8')).toBe('%PDF-result');

    await writeFile(path, 'existing');
    await expect(
      result.save(path, { overwrite: false }),
    ).rejects.toBeInstanceOf(UnableToWritePdfError);
    expect(await readFile(path, 'utf8')).toBe('existing');
  });
});

describe('verifyWebhookSignature', () => {
  const body = Buffer.from('{"event":"pdf.rendered"}');
  const timestamp = '2000000000';
  const secret = 'webhook-secret';
  const signature = `v1=${createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex')}`;

  it('validates raw bytes with a constant-time signature and tolerance', () => {
    expect(
      verifyWebhookSignature({
        rawBody: body,
        timestamp,
        signature,
        secret,
        now: 2_000_000_300,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        rawBody: body,
        timestamp,
        signature,
        secret,
        now: 2_000_000_301,
      }),
    ).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    for (const candidate of [
      undefined,
      '',
      'v1=ABC',
      `v2=${'a'.repeat(64)}`,
      `v1=${'a'.repeat(63)}`,
    ]) {
      expect(
        verifyWebhookSignature({
          rawBody: body,
          timestamp,
          signature: candidate,
          secret,
          now: 2_000_000_000,
        }),
      ).toBe(false);
    }
    expect(
      verifyWebhookSignature({
        rawBody: 'different',
        timestamp,
        signature,
        secret,
        now: 2_000_000_000,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        rawBody: body,
        timestamp: '02000000000',
        signature,
        secret,
        now: 2_000_000_000,
      }),
    ).toBe(false);
  });
});
