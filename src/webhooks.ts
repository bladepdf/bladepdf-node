import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface VerifyWebhookSignatureOptions {
  rawBody: string | Uint8Array;
  timestamp?: string | null | undefined;
  signature?: string | null | undefined;
  secret: string;
  toleranceSeconds?: number;
  now?: number;
}

export function verifyWebhookSignature(
  options: VerifyWebhookSignatureOptions,
): boolean {
  const tolerance =
    options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;

  if (
    options.timestamp === null ||
    options.timestamp === undefined ||
    options.signature === null ||
    options.signature === undefined ||
    options.secret.trim() === '' ||
    !Number.isInteger(tolerance) ||
    tolerance < 0
  ) {
    return false;
  }

  const timestamp = options.timestamp.trim();
  const signature = options.signature.trim();

  if (
    !/^[1-9][0-9]*$/u.test(timestamp) ||
    !/^v1=[a-f0-9]{64}$/u.test(signature)
  ) {
    return false;
  }

  const timestampValue = Number(timestamp);
  const now = options.now ?? Math.floor(Date.now() / 1_000);

  if (
    !Number.isSafeInteger(timestampValue) ||
    timestampValue <= 0 ||
    !Number.isSafeInteger(now) ||
    (tolerance > 0 && Math.abs(now - timestampValue) > tolerance)
  ) {
    return false;
  }

  const hmac = createHmac('sha256', options.secret);
  hmac.update(`${timestamp}.`, 'utf8');
  hmac.update(options.rawBody);
  const expected = Buffer.from(`v1=${hmac.digest('hex')}`);
  const actual = Buffer.from(signature);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
