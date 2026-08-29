# BladePDF for Node.js

The official server-side Node.js and TypeScript SDK for the
[BladePDF](https://bladepdf.com) managed Chromium API.

- Raw and pre-rendered HTML
- BladePDF cloud templates
- Type-safe PDF, readiness, storage, metadata, and webhook options
- Secure automatic local CSS, image, font, JavaScript, and SVG assets
- Buffered, streamed, file, and background delivery
- ESM and CommonJS
- No runtime dependencies

> [!IMPORTANT]
> `@bladepdf/node` is a server-only package. Do not bundle it into browser code
> or expose a BladePDF API key to an end user.

## Requirements

- Node.js 22 or newer
- A BladePDF API key

## Installation

```bash
npm install @bladepdf/node
```

## Quickstart

The SDK requires an explicit API key. It does not read `.env` or
`BLADEPDF_API_KEY` by itself.

```ts
import { BladePdf } from '@bladepdf/node';

const apiKey = process.env.BLADEPDF_API_KEY;

if (!apiKey) {
  throw new Error('Missing BLADEPDF_API_KEY');
}

const bladePdf = new BladePdf({ apiKey });

const result = await bladePdf
  .fromHtml(
    `
    <!doctype html>
    <html>
      <body>
        <h1>Hello from Node.js</h1>
      </body>
    </html>
  `,
  )
  .format('A4')
  .printBackground()
  .render();

await result.save('document.pdf');
console.log(result.requestId);
```

CommonJS uses the same named exports:

```js
const { BladePdf } = require('@bladepdf/node');
```

## Pre-rendered templates

Render Handlebars, EJS, Pug, React SSR, Nunjucks, or another template engine in
your application, then pass the resulting HTML string to BladePDF:

```ts
const html = renderInvoiceTemplate(invoice);

const result = await bladePdf
  .fromHtml(html, { baseDirectory: '/srv/app/templates/invoice' })
  .render();
```

The SDK intentionally does not depend on a template engine.

## Local assets

Automatic filesystem access is disabled until at least one root is configured.
Only canonical files inside these roots may be discovered automatically;
traversal and symlink escapes are rejected.

```ts
import { BladePdf } from '@bladepdf/node';

const bladePdf = new BladePdf({
  apiKey,
  assets: {
    documentRoot: '/srv/app/public',
    searchRoots: ['/srv/app/public', '/srv/app/storage'],
    localHosts: ['app.test', 'localhost'],
  },
});

await bladePdf
  .fromHtml(
    `
    <link rel="stylesheet" href="/build/app.css">
    <img src="/images/logo.svg#mark">
  `,
  )
  .renderToFile('invoice.pdf');
```

The resolver supports HTML `src`, `href`, `poster`, `data-src`, `data-href`,
`srcset`, inline styles and `<style>`, plus CSS `url()` and `@import`. Nested CSS
and cyclic imports are handled safely. Query strings and fragments are kept in
the rewritten document URI, never in the multipart asset name.

External HTTP(S), protocol-relative CDN, `data:`, `blob:`, `javascript:`,
`mailto:`, `tel:`, and existing `asset:///` references are left unchanged.

Attach an intentional file outside the roots explicitly:

```ts
render.assetFile('/srv/tenants/acme/logo.svg', {
  target: 'tenant-logo.svg',
});
```

Or attach generated data without creating a temporary file:

```ts
render.assetData(chartBuffer, {
  target: 'chart.png',
  mimeType: 'image/png',
});
```

JavaScript is attached only from `<script src>`. The SDK does not inspect JS
imports, dynamic imports, `fetch()`, or runtime URLs. SVG files are opaque; their
contents and internal dependencies are not inspected.

## Headers, footers, and PDF options

```ts
const result = await bladePdf
  .fromHtml(html)
  .headerHtml('<div class="header">Invoice</div>')
  .footerHtml('<div class="footer"><span class="pageNumber"></span></div>')
  .paperSize({ width: 210, height: 297, unit: 'mm' })
  .margins({ top: 15, right: 12, bottom: 15, left: 12, unit: 'mm' })
  .landscape()
  .scale(0.95)
  .waitUntil('networkidle0')
  .emulateMedia('print')
  .render();
```

Cloud templates own their header and footer and therefore do not accept
per-request HTML header/footer overrides.

## Cloud templates

```ts
const result = await bladePdf
  .fromTemplate('tpl_123', {
    customer: { name: 'Acme' },
    lines: [{ description: 'Consulting', total: 1200 }],
  })
  .reference('invoice-2026-001')
  .render();
```

Use `context()` to replace context and `mergeContext()` to recursively merge
plain objects.

## Buffer, stream, and file delivery

`render()` buffers the complete PDF:

```ts
const result = await render.render();
result.pdf; // Buffer
result.toBase64();
await result.save('/srv/pdfs/invoice.pdf', { overwrite: false });
```

`renderStream()` returns a one-shot Node `Readable`. Always consume or destroy
it:

```ts
import { pipeline } from 'node:stream/promises';

const result = await render.renderStream();
await pipeline(result.stream, httpResponse);
```

`renderToFile()` streams through a temporary sibling file and only replaces the
target after the complete PDF has arrived:

```ts
const result = await render.renderToFile('/srv/pdfs/invoice.pdf', {
  overwrite: true,
});
```

Every delivery method accepts `{ signal: AbortSignal }`.

## Background renders

Background renders must be stored so they remain available after the request is
accepted:

```ts
const submission = await bladePdf
  .fromHtml(html)
  .reference('invoice-2026-001')
  .storePdf()
  .webhook({
    url: 'https://app.example/webhooks/bladepdf',
    secret: process.env.BLADEPDF_WEBHOOK_SECRET!,
  })
  .submit();

console.log(submission.requestId);
```

## Webhook signatures

Signature verification requires the exact raw request bytes, before JSON
parsing:

```ts
import express from 'express';
import { verifyWebhookSignature } from '@bladepdf/node';

const app = express();

// Register this route before a global express.json() middleware.
app.post(
  '/webhooks/bladepdf',
  express.raw({ type: 'application/json' }),
  (request, response) => {
    const valid = verifyWebhookSignature({
      rawBody: request.body,
      timestamp: request.header('bladepdf-timestamp'),
      signature: request.header('bladepdf-signature'),
      secret: process.env.BLADEPDF_WEBHOOK_SECRET!,
    });

    if (!valid) {
      response.sendStatus(401);
      return;
    }

    const payload = JSON.parse(request.body.toString('utf8'));
    queueWebhook(payload);
    response.sendStatus(204);
  },
);
```

The default freshness tolerance is 300 seconds.

## Client configuration

```ts
const bladePdf = new BladePdf({
  apiKey,
  baseUrl: 'https://api.bladepdf.com',
  timeoutMs: 60_000,
  retries: 1,
  retryDelayMs: 1_000,
  userAgent: 'my-service/2.0 bladepdf-node/1.0',
  fetch: customFetch,
});
```

`retries` is the number of retries after the initial request. Only network
failures and HTTP 429, 502, 503, and 504 are retried. `Retry-After` is respected.
Native platform TLS verification is always enabled; a custom proxy, CA, or
dispatcher can be supplied through an injected `fetch` implementation.

For advanced testing or dependency injection:

```ts
const bladePdf = BladePdf.fromDependencies({
  client: fakeRenderClient,
  assetResolver,
});
```

## Errors

All SDK errors extend `BladePdfError`:

```ts
import { BladePdfError, RenderFailedError } from '@bladepdf/node';

try {
  await render.render();
} catch (error) {
  if (error instanceof RenderFailedError) {
    console.error(error.statusCode, error.requestId, error.responseBody);
  } else if (error instanceof BladePdfError) {
    console.error(error.message);
  }
}
```

Caller cancellation preserves the standard `AbortError`.

## Documentation

Full guides and API reference are available at
[docs.bladepdf.com/node-sdk](https://docs.bladepdf.com/node-sdk).

## License

MIT
