import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  BladePdfClient,
  RenderFailedError,
  RenderRequest,
} from '../src/index.js';

function htmlRequest(): RenderRequest {
  return new RenderRequest({
    source: { type: 'html' },
    html: '<h1>Ahoj světe</h1>',
    headerHtml: '<span>Header</span>',
    footerHtml: '<span>Footer</span>',
    waitUntil: 'networkidle0',
    emulateMedia: 'print',
    metadata: { reference: 'order-1', template_name: 'invoice' },
    storePdf: true,
    webhook: {
      url: 'https://example.test/webhook',
      secret: 'secret',
      events: ['pdf.rendered', 'pdf.failed'],
    },
    pdfOptions: { format: 'A4', printBackground: true },
    assets: [
      {
        fieldName: 'asset:///logo.svg',
        filename: 'logo.svg',
        contents: Buffer.from('<svg/>'),
        mimeType: 'image/svg+xml',
      },
    ],
  });
}

describe('BladePdfClient', () => {
  it('sends the exact synchronous multipart request and parses result metadata', async () => {
    let receivedUrl: string | URL | Request | undefined;
    let receivedInit: RequestInit | undefined;
    const fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        receivedUrl = url;
        receivedInit = init;
        return new Response(Buffer.from('%PDF-test'), {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'x-request-id': 'request-header',
            link: '<https://cdn.test/file.pdf>; rel="stored-pdf", <https://example.test>; rel="help"',
          },
        });
      },
    );
    const client = new BladePdfClient(' api-key ', {
      baseUrl: 'https://api.test/',
      fetch,
    });

    const result = await client.render(htmlRequest());

    expect(receivedUrl).toBe('https://api.test/render');
    expect(receivedInit?.method).toBe('POST');
    expect(receivedInit?.headers).toMatchObject({
      Authorization: 'Bearer api-key',
      Accept: 'application/pdf',
      'User-Agent': 'bladepdf-node/1.0',
    });
    const form = receivedInit?.body as FormData;
    expect(JSON.parse(String(form.get('source')))).toEqual({ type: 'html' });
    expect(form.get('wait_until')).toBe('networkidle0');
    expect(form.get('emulate_media')).toBe('print');
    expect(form.get('store_pdf')).toBe('true');
    expect(JSON.parse(String(form.get('metadata')))).toEqual({
      reference: 'order-1',
      template_name: 'invoice',
    });
    const html = form.get('html');
    const asset = form.get('asset:///logo.svg');
    expect(html).toBeInstanceOf(File);
    expect((html as File).name).toBe('html.html');
    expect((html as File).type).toBe('text/html; charset=utf-8');
    expect(await (html as File).text()).toContain('Ahoj světe');
    expect(asset).toBeInstanceOf(File);
    expect((asset as File).name).toBe('logo.svg');
    expect((asset as File).type).toBe('image/svg+xml');
    expect(result.pdf.toString()).toBe('%PDF-test');
    expect(result.requestId).toBe('request-header');
    expect(result.storedPdfUrl).toBe('https://cdn.test/file.pdf');
  });

  it('sends template context as a JSON file and submits a background render', async () => {
    let form: FormData | undefined;
    let headers: RequestInit['headers'];
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        form = init?.body as FormData;
        headers = init?.headers;
        return new Response(
          JSON.stringify({
            request_id: 'background-id',
            reference: 'invoice-8',
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
      },
    );
    const client = new BladePdfClient('key', { fetch });
    const request = new RenderRequest({
      source: { type: 'template', templateId: 'template-id' },
      context: {},
      storePdf: true,
    });

    const submission = await client.submit(request);

    expect(headers).toMatchObject({
      Accept: 'application/json',
      Prefer: 'respond-async',
    });
    const context = form?.get('context');
    expect(context).toBeInstanceOf(File);
    expect(await (context as File).text()).toBe('{}');
    expect(submission.requestId).toBe('background-id');
    expect(submission.reference).toBe('invoice-8');
  });

  it('exposes structured, safely limited response errors', async () => {
    const body = `invalid-${'x'.repeat(2_000)}`;
    const client = new BladePdfClient('key', {
      retries: 0,
      fetch: async () =>
        new Response(body, {
          status: 422,
          headers: { 'x-request-id': 'failed-request' },
        }),
    });

    const error = await client
      .render(htmlRequest())
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RenderFailedError);
    expect(error).toMatchObject({
      statusCode: 422,
      requestId: 'failed-request',
      responseBody: body,
    });
    expect((error as Error).message.length).toBeLessThan(1_200);
    expect((error as Error).message).not.toContain('Bearer');
  });

  it('retries only retryable responses and transport failures', async () => {
    const responseFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('busy', { status: 503, headers: { 'retry-after': '0' } }),
      )
      .mockResolvedValueOnce(new Response('%PDF-ok', { status: 200 }));
    const responseClient = new BladePdfClient('key', {
      fetch: responseFetch,
      retries: 1,
      retryDelayMs: 0,
    });
    await expect(responseClient.render(htmlRequest())).resolves.toMatchObject({
      pdf: Buffer.from('%PDF-ok'),
    });
    expect(responseFetch).toHaveBeenCalledTimes(2);

    const networkFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(new Response('%PDF-ok', { status: 200 }));
    const networkClient = new BladePdfClient('key', {
      fetch: networkFetch,
      retries: 1,
      retryDelayMs: 0,
    });
    await expect(networkClient.render(htmlRequest())).resolves.toBeDefined();
    expect(networkFetch).toHaveBeenCalledTimes(2);

    const validationFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('bad', { status: 400 }));
    const validationClient = new BladePdfClient('key', {
      fetch: validationFetch,
      retries: 3,
    });
    await expect(validationClient.render(htmlRequest())).rejects.toBeInstanceOf(
      RenderFailedError,
    );
    expect(validationFetch).toHaveBeenCalledTimes(1);

    const programmerFailure = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('custom fetch implementation failed'));
    const programmerFailureClient = new BladePdfClient('key', {
      fetch: programmerFailure,
      retries: 3,
      retryDelayMs: 0,
    });
    await expect(
      programmerFailureClient.render(htmlRequest()),
    ).rejects.toBeInstanceOf(RenderFailedError);
    expect(programmerFailure).toHaveBeenCalledTimes(1);
  });

  it('preserves caller AbortError and wraps an internal timeout', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const neverFetch = vi.fn<typeof fetch>();
    const client = new BladePdfClient('key', { fetch: neverFetch, retries: 0 });

    await expect(
      client.render(htmlRequest(), { signal: aborted.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(neverFetch).not.toHaveBeenCalled();

    const timeoutClient = new BladePdfClient('key', {
      retries: 0,
      timeoutMs: 5,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    });
    await expect(timeoutClient.render(htmlRequest())).rejects.toMatchObject({
      name: 'RenderFailedError',
      message: expect.stringContaining('timed out'),
    });
  });

  it('returns a Node stream and never retries a stream failure after headers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('%PDF-'));
          controller.error(new Error('socket closed'));
        },
      });
      return new Response(body, { status: 200 });
    });
    const client = new BladePdfClient('key', { fetch, retries: 3 });
    const result = await client.renderStream(htmlRequest());

    expect(result.stream).toBeInstanceOf(Readable);
    await expect(
      (async () => {
        for await (const chunk of result.stream) {
          void chunk;
        }
      })(),
    ).rejects.toThrow('socket closed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed background success responses', async () => {
    const invalidJson = new BladePdfClient('key', {
      fetch: async () => new Response('{', { status: 202 }),
    });
    await expect(
      invalidJson.submit(
        new RenderRequest({
          source: { type: 'template', templateId: 'id' },
          context: {},
          storePdf: true,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 202 });

    const missingId = new BladePdfClient('key', {
      fetch: async () => new Response('{}', { status: 202 }),
    });
    await expect(
      missingId.submit(
        new RenderRequest({
          source: { type: 'template', templateId: 'id' },
          context: {},
          storePdf: true,
        }),
      ),
    ).rejects.toThrow('missing a valid request_id');
  });
});
