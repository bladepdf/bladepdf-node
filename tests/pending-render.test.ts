import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BladePdf,
  InvalidRenderConfigurationError,
  RenderResult,
  RenderRequest,
  RenderStreamResult,
  RenderSubmission,
  type DeliveryOptions,
  type RenderClient,
} from '../src/index.js';

class FakeClient implements RenderClient {
  public readonly requests: RenderRequest[] = [];

  public async render(request: RenderRequest): Promise<RenderResult> {
    this.requests.push(request);
    return new RenderResult(
      Buffer.from('%PDF-buffer'),
      'https://stored',
      'request',
    );
  }

  public async renderStream(
    request: RenderRequest,
  ): Promise<RenderStreamResult> {
    this.requests.push(request);
    return new RenderStreamResult(
      Readable.from([Buffer.from('%PDF-stream')]),
      'https://stored',
      'request',
    );
  }

  public async submit(
    request: RenderRequest,
    _options?: DeliveryOptions,
  ): Promise<RenderSubmission> {
    this.requests.push(request);
    return new RenderSubmission('background', request.metadata?.reference);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe('PendingRender', () => {
  it('maps the fluent API to a readonly render request', async () => {
    const fake = new FakeClient();
    const bladePdf = BladePdf.fromDependencies({ client: fake });

    const result = await bladePdf
      .fromHtml('<h1>Invoice</h1>')
      .headerHtml('<span>Header</span>')
      .footerHtml('<span>Footer</span>')
      .format('A4')
      .paperSize({ width: 210, height: 297, unit: 'mm' })
      .margins({ top: 1, right: 2, bottom: 3, left: 4, unit: 'cm' })
      .landscape()
      .printBackground()
      .transparentBackground()
      .scale(1.25)
      .pageRanges('1-3')
      .taggedPdf()
      .preferCssPageSize()
      .waitForFonts()
      .outline()
      .waitUntil('networkidle0')
      .emulateMedia('print')
      .metadata({ reference: 'order-8', templateName: 'invoice' })
      .storePdf()
      .webhook({ url: 'https://example.test/hook', secret: 'secret' })
      .render();

    expect(result.pdf.toString()).toBe('%PDF-buffer');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      source: { type: 'html' },
      html: '<h1>Invoice</h1>',
      headerHtml: '<span>Header</span>',
      footerHtml: '<span>Footer</span>',
      waitUntil: 'networkidle0',
      emulateMedia: 'print',
      metadata: { reference: 'order-8', template_name: 'invoice' },
      storePdf: true,
      pdfOptions: {
        width: '210mm',
        height: '297mm',
        landscape: true,
        printBackground: true,
        omitBackground: true,
        scale: 1.25,
        pageRanges: '1-3',
        tagged: true,
        preferCSSPageSize: true,
        waitForFonts: true,
        outline: true,
        margin: { top: '1cm', right: '2cm', bottom: '3cm', left: '4cm' },
      },
    });
    expect(Object.isFrozen(fake.requests[0])).toBe(true);
  });

  it('captures delivery state before the first asynchronous operation', async () => {
    const fake = new FakeClient();
    const builder = BladePdf.fromDependencies({ client: fake })
      .fromHtml('<p>Document</p>')
      .format('A4');

    const first = builder.render();
    builder.format('Letter').reference('second');
    const second = builder.render();
    await Promise.all([first, second]);

    expect(fake.requests[0]?.pdfOptions?.format).toBe('A4');
    expect(fake.requests[0]?.metadata).toBeUndefined();
    expect(fake.requests[1]?.pdfOptions?.format).toBe('Letter');
    expect(fake.requests[1]?.metadata?.reference).toBe('second');
  });

  it('supports cloud context merging and requires storage for submit', async () => {
    const fake = new FakeClient();
    const render = BladePdf.fromDependencies({ client: fake }).fromTemplate(
      ' template-id ',
      { customer: { name: 'Acme', country: 'CZ' } },
    );

    render.mergeContext({ customer: { name: 'BladePDF' }, lines: [1, 2] });
    expect(() => render.submit()).toThrow(InvalidRenderConfigurationError);

    const submission = await render.reference('invoice-1').storePdf().submit();
    expect(submission.requestId).toBe('background');
    expect(fake.requests[0]).toMatchObject({
      source: { type: 'template', templateId: 'template-id' },
      context: {
        customer: { name: 'BladePDF', country: 'CZ' },
        lines: [1, 2],
      },
      storePdf: true,
    });
  });

  it('rejects source-specific and invalid JavaScript configurations early', () => {
    const bladePdf = BladePdf.fromDependencies({ client: new FakeClient() });

    expect(() => bladePdf.fromHtml('x').context({})).toThrow(
      InvalidRenderConfigurationError,
    );
    expect(() => bladePdf.fromTemplate('id').headerHtml('x')).toThrow(
      InvalidRenderConfigurationError,
    );
    expect(() => bladePdf.fromTemplate('id').templateName('x')).toThrow(
      InvalidRenderConfigurationError,
    );
    expect(() => bladePdf.fromHtml('x').scale(2.1)).toThrow(
      InvalidRenderConfigurationError,
    );
    expect(() =>
      bladePdf.fromHtml('x').pdfOptions({ unknown: true } as never),
    ).toThrow('Unsupported BladePDF PDF option');
    expect(() => bladePdf.fromTemplate('id', { value: 1n })).toThrow(
      'JSON serializable',
    );
    expect(() => bladePdf.fromTemplate('id', [] as never)).toThrow(
      'context must be an object',
    );
    expect(() => bladePdf.fromHtml('x').metadata(null as never)).toThrow(
      InvalidRenderConfigurationError,
    );
    expect(() =>
      bladePdf.fromHtml('x').metadata({ reference: 42 } as never),
    ).toThrow('reference must be a string');
    expect(() =>
      bladePdf.fromHtml('x').webhook({
        url: 'https://example.test/hook',
        secret: 'secret',
        extra: true,
      } as never),
    ).toThrow('Unsupported BladePDF webhook option');
  });

  it('detaches and freezes nested request state', () => {
    const context = { customer: { name: 'Acme' } };
    const contents = Buffer.from('original');
    const request = new RenderRequest({
      source: { type: 'template', templateId: 'template-id' },
      context,
      assets: [
        {
          fieldName: 'asset:///file.bin',
          filename: 'file.bin',
          contents,
          mimeType: 'application/octet-stream',
        },
      ],
    });

    context.customer.name = 'changed';
    contents.fill(0);

    expect(request.context).toEqual({ customer: { name: 'Acme' } });
    expect(Object.isFrozen(request.context)).toBe(true);
    expect(Object.isFrozen(request.context?.customer)).toBe(true);
    expect(Buffer.from(request.assets[0]!.contents).toString()).toBe(
      'original',
    );
  });

  it('supports binary assets and atomic file delivery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bladepdf-node-builder-'));
    temporaryDirectories.push(directory);
    const target = join(directory, 'invoice.pdf');
    const fake = new FakeClient();
    const result = await BladePdf.fromDependencies({ client: fake })
      .fromHtml('<img src="asset:///chart.png">')
      .assetData(Buffer.from('png'), {
        target: 'chart.png',
        mimeType: 'image/png',
      })
      .renderToFile(target);

    expect(result.path).toBe(target);
    expect(await readFile(target, 'utf8')).toBe('%PDF-stream');
    expect(fake.requests[0]?.assets[0]).toMatchObject({
      fieldName: 'asset:///chart.png',
      filename: 'chart.png',
      mimeType: 'image/png',
    });

    await writeFile(target, 'existing');
    await expect(
      BladePdf.fromDependencies({ client: fake })
        .fromHtml('x')
        .renderToFile(target, { overwrite: false }),
    ).rejects.toThrow('Unable to write');
    expect(await readFile(target, 'utf8')).toBe('existing');
  });
});
