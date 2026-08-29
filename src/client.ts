import { Readable } from 'node:stream';

import {
  InvalidRenderConfigurationError,
  MissingApiKeyError,
  RenderFailedError,
} from './errors.js';
import { abortError, encodeJson } from './internal.js';
import {
  RenderResult,
  RenderStreamResult,
  RenderSubmission,
} from './results.js';
import type { DeliveryOptions, RenderRequest } from './types.js';

export interface BladePdfClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  userAgent?: string;
  fetch?: typeof globalThis.fetch;
}

export interface RenderClient {
  render(
    request: RenderRequest,
    options?: DeliveryOptions,
  ): Promise<RenderResult>;
  renderStream(
    request: RenderRequest,
    options?: DeliveryOptions,
  ): Promise<RenderStreamResult>;
  submit(
    request: RenderRequest,
    options?: DeliveryOptions,
  ): Promise<RenderSubmission>;
}

interface AttemptContext {
  signal: AbortSignal;
  timedOut(): boolean;
  release(): void;
}

interface SentResponse {
  response: Response;
  attempt: AttemptContext;
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isRetryableTransportError(error: unknown, timedOut: boolean): boolean {
  if (timedOut || error instanceof TypeError) {
    return true;
  }

  let current: unknown = error;
  const seen = new Set<unknown>();

  while (
    typeof current === 'object' &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };

    if (
      typeof candidate.code === 'string' &&
      RETRYABLE_NETWORK_CODES.has(candidate.code)
    ) {
      return true;
    }

    current = candidate.cause;
  }

  return false;
}

export class BladePdfClient implements RenderClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #retryDelayMs: number;
  readonly #userAgent: string;
  readonly #fetch: typeof globalThis.fetch;

  public constructor(apiKey: string, options: BladePdfClientOptions = {}) {
    this.#apiKey = apiKey.trim();
    this.#baseUrl = options.baseUrl ?? 'https://api.bladepdf.com';
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#retries = options.retries ?? 1;
    this.#retryDelayMs = options.retryDelayMs ?? 1_000;
    this.#userAgent = options.userAgent ?? 'bladepdf-node/1.0';
    this.#fetch = options.fetch ?? globalThis.fetch;

    if (this.#apiKey === '') {
      throw new MissingApiKeyError('Missing BladePDF API key.');
    }
    if (this.#baseUrl.trim() === '') {
      throw new InvalidRenderConfigurationError(
        'BladePDF baseUrl cannot be empty.',
      );
    }
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new InvalidRenderConfigurationError(
        'BladePDF timeoutMs must be a positive integer.',
      );
    }
    if (!Number.isInteger(this.#retries) || this.#retries < 0) {
      throw new InvalidRenderConfigurationError(
        'BladePDF retries must be a non-negative integer.',
      );
    }
    if (!Number.isInteger(this.#retryDelayMs) || this.#retryDelayMs < 0) {
      throw new InvalidRenderConfigurationError(
        'BladePDF retryDelayMs must be a non-negative integer.',
      );
    }
    if (this.#userAgent.trim() === '') {
      throw new InvalidRenderConfigurationError(
        'BladePDF userAgent cannot be empty.',
      );
    }
    if (typeof this.#fetch !== 'function') {
      throw new InvalidRenderConfigurationError(
        'BladePDF fetch must be a function.',
      );
    }
  }

  public async render(
    request: RenderRequest,
    options: DeliveryOptions = {},
  ): Promise<RenderResult> {
    const { response, attempt } = await this.send(
      request,
      false,
      options.signal,
    );

    try {
      await this.assertSyncSuccess(response);
      const pdf = Buffer.from(await response.arrayBuffer());

      return new RenderResult(
        pdf,
        this.storedPdfUrl(response),
        this.header(response, 'x-request-id'),
      );
    } catch (error) {
      if (options.signal?.aborted) {
        throw abortError(options.signal);
      }
      if (error instanceof RenderFailedError) {
        throw error;
      }

      throw RenderFailedError.fromTransport(
        'BladePDF PDF response could not be read.',
        error,
      );
    } finally {
      attempt.release();
    }
  }

  public async renderStream(
    request: RenderRequest,
    options: DeliveryOptions = {},
  ): Promise<RenderStreamResult> {
    const { response, attempt } = await this.send(
      request,
      false,
      options.signal,
    );

    try {
      await this.assertSyncSuccess(response);

      if (!response.body) {
        const requestId = this.header(response, 'x-request-id');
        throw new RenderFailedError(
          'BladePDF render response did not contain a PDF stream.',
          {
            statusCode: response.status,
            ...(requestId === undefined ? {} : { requestId }),
          },
        );
      }

      const stream = Readable.fromWeb(response.body);
      let released = false;
      const release = (): void => {
        if (!released) {
          released = true;
          attempt.release();
        }
      };

      stream.once('end', release);
      stream.once('error', release);
      stream.once('close', release);

      return new RenderStreamResult(
        stream,
        this.storedPdfUrl(response),
        this.header(response, 'x-request-id'),
      );
    } catch (error) {
      attempt.release();
      if (options.signal?.aborted) {
        throw abortError(options.signal);
      }
      throw error;
    }
  }

  public async submit(
    request: RenderRequest,
    options: DeliveryOptions = {},
  ): Promise<RenderSubmission> {
    const { response, attempt } = await this.send(
      request,
      true,
      options.signal,
    );
    const headerRequestId = this.header(response, 'x-request-id');

    try {
      const body = await response.text();

      if (response.status !== 202) {
        throw RenderFailedError.fromResponse(
          response.status,
          body,
          headerRequestId,
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body) as unknown;
      } catch (error) {
        throw new RenderFailedError(
          'BladePDF async render response is not valid JSON.',
          {
            statusCode: 202,
            ...(headerRequestId === undefined
              ? {}
              : { requestId: headerRequestId }),
            responseBody: body,
            cause: error,
          },
        );
      }

      const requestId =
        typeof payload === 'object' &&
        payload !== null &&
        'request_id' in payload &&
        typeof payload.request_id === 'string'
          ? payload.request_id.trim()
          : '';

      if (requestId === '') {
        throw new RenderFailedError(
          'BladePDF async render response is missing a valid request_id.',
          {
            statusCode: 202,
            ...(headerRequestId === undefined
              ? {}
              : { requestId: headerRequestId }),
            responseBody: body,
          },
        );
      }

      const reference =
        typeof payload === 'object' &&
        payload !== null &&
        'reference' in payload &&
        typeof payload.reference === 'string'
          ? payload.reference
          : undefined;

      return new RenderSubmission(requestId, reference);
    } catch (error) {
      if (options.signal?.aborted) {
        throw abortError(options.signal);
      }
      if (error instanceof RenderFailedError) {
        throw error;
      }

      throw RenderFailedError.fromTransport(
        'BladePDF async render response could not be read.',
        error,
      );
    } finally {
      attempt.release();
    }
  }

  private async send(
    request: RenderRequest,
    background: boolean,
    callerSignal?: AbortSignal,
  ): Promise<SentResponse> {
    let retry = 0;

    while (true) {
      if (callerSignal?.aborted) {
        throw abortError(callerSignal);
      }

      const attempt = this.createAttempt(callerSignal);

      try {
        const response = await this.#fetch(this.endpoint('/render'), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            Accept: background ? 'application/json' : 'application/pdf',
            ...(background ? { Prefer: 'respond-async' } : {}),
            'User-Agent': this.#userAgent,
          },
          body: this.multipart(request),
          signal: attempt.signal,
        });

        if (RETRYABLE_STATUSES.has(response.status) && retry < this.#retries) {
          const retryAfter = this.retryAfterMilliseconds(response);
          await response.body?.cancel().catch(() => undefined);
          attempt.release();
          await this.waitBeforeRetry(
            retryAfter ?? this.#retryDelayMs * 2 ** retry,
            callerSignal,
          );
          retry += 1;
          continue;
        }

        return { response, attempt };
      } catch (error) {
        const didTimeOut = attempt.timedOut();
        attempt.release();

        if (callerSignal?.aborted) {
          throw abortError(callerSignal);
        }

        if (
          retry < this.#retries &&
          isRetryableTransportError(error, didTimeOut)
        ) {
          await this.waitBeforeRetry(
            this.#retryDelayMs * 2 ** retry,
            callerSignal,
          );
          retry += 1;
          continue;
        }

        throw RenderFailedError.fromTransport(
          didTimeOut
            ? `BladePDF render request timed out after ${this.#timeoutMs} ms.`
            : 'BladePDF render request could not be completed.',
          error,
        );
      }
    }
  }

  private multipart(request: RenderRequest): FormData {
    const form = new FormData();
    form.append('source', encodeJson(request.source, 'source'));

    if (request.waitUntil !== undefined) {
      form.append('wait_until', request.waitUntil);
    }
    if (request.waitFunction !== undefined) {
      form.append('wait_function', request.waitFunction);
    }
    if (request.emulateMedia !== undefined) {
      form.append('emulate_media', request.emulateMedia);
    }
    if (request.metadata !== undefined) {
      form.append('metadata', encodeJson(request.metadata, 'metadata'));
    }
    if (request.storePdf !== undefined) {
      form.append('store_pdf', request.storePdf ? 'true' : 'false');
    }
    if (request.webhook !== undefined) {
      form.append('webhook', encodeJson(request.webhook, 'webhook'));
    }
    if (request.pdfOptions !== undefined) {
      form.append('pdf_options', encodeJson(request.pdfOptions, 'PDF options'));
    }
    if (request.html !== undefined) {
      form.append(
        'html',
        new Blob([request.html], { type: 'text/html; charset=UTF-8' }),
        'html.html',
      );
    }
    if (request.headerHtml !== undefined) {
      form.append(
        'header_html',
        new Blob([request.headerHtml], {
          type: 'text/html; charset=UTF-8',
        }),
        'header.html',
      );
    }
    if (request.footerHtml !== undefined) {
      form.append(
        'footer_html',
        new Blob([request.footerHtml], {
          type: 'text/html; charset=UTF-8',
        }),
        'footer.html',
      );
    }
    if (request.context !== undefined) {
      form.append(
        'context',
        new Blob([encodeJson(request.context, 'context')], {
          type: 'application/json; charset=UTF-8',
        }),
        'context.json',
      );
    }

    for (const asset of request.assets) {
      form.append(
        asset.fieldName,
        new Blob([Uint8Array.from(asset.contents)], { type: asset.mimeType }),
        asset.filename,
      );
    }

    return form;
  }

  private async assertSyncSuccess(response: Response): Promise<void> {
    if (response.status >= 200 && response.status < 300) {
      return;
    }

    throw RenderFailedError.fromResponse(
      response.status,
      await response.text(),
      this.header(response, 'x-request-id'),
    );
  }

  private createAttempt(callerSignal?: AbortSignal): AttemptContext {
    const controller = new AbortController();
    let timedOut = false;
    let released = false;
    const abortFromCaller = (): void => {
      controller.abort(callerSignal?.reason);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new DOMException('The BladePDF request timed out.', 'TimeoutError'),
      );
    }, this.#timeoutMs);

    timeout.unref();
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

    if (callerSignal?.aborted) {
      abortFromCaller();
    }

    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      release: () => {
        if (!released) {
          released = true;
          clearTimeout(timeout);
          callerSignal?.removeEventListener('abort', abortFromCaller);
        }
      },
    };
  }

  private async waitBeforeRetry(
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      throw abortError(signal);
    }
    if (milliseconds <= 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timeout);
        reject(abortError(signal!));
      };
      const timeout = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      timeout.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private retryAfterMilliseconds(response: Response): number | undefined {
    const value = response.headers.get('retry-after')?.trim();

    if (!value) {
      return undefined;
    }
    if (/^\d+$/u.test(value)) {
      return Number.parseInt(value, 10) * 1_000;
    }

    const retryAt = Date.parse(value);

    return Number.isNaN(retryAt)
      ? undefined
      : Math.max(0, retryAt - Date.now());
  }

  private storedPdfUrl(response: Response): string | undefined {
    const link = response.headers.get('link');

    if (!link) {
      return undefined;
    }

    for (const part of link.split(/,(?=\s*<)/u)) {
      const url = /<([^>]+)>/u.exec(part)?.[1];

      if (
        url &&
        /;\s*rel=(?:"stored-pdf"|stored-pdf)(?:\s*;|\s*$)/iu.test(part)
      ) {
        return url;
      }
    }

    return undefined;
  }

  private header(response: Response, name: string): string | undefined {
    const value = response.headers.get(name)?.trim();
    return value || undefined;
  }

  private endpoint(path: string): string {
    return `${this.#baseUrl.replace(/\/+$/u, '')}/${path.replace(/^\/+/, '')}`;
  }
}
