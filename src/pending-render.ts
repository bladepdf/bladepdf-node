import { basename } from 'node:path';

import { normalizeAssetTarget } from './assets/resolver.js';
import type { AssetResolver, ManualAsset } from './assets/resolver.js';
import type { RenderClient } from './client.js';
import { InvalidRenderConfigurationError } from './errors.js';
import { atomicWriteStream } from './files.js';
import { cloneJsonObject, encodeJson, isPlainObject } from './internal.js';
import {
  RenderFileResult,
  type RenderResult,
  type RenderStreamResult,
  type RenderSubmission,
} from './results.js';
import {
  RenderRequest,
  type AssetData,
  type AssetDataOptions,
  type AssetFileOptions,
  type DeliveryOptions,
  type EmulateMedia,
  type FileDeliveryOptions,
  type HtmlSourceOptions,
  type JsonObject,
  type MarginOptions,
  type PaperSizeOptions,
  type PdfFormat,
  type PdfLength,
  type PdfOptions,
  type RenderMetadata,
  type WaitUntil,
  type WebhookEvent,
  type WebhookOptions,
} from './types.js';

interface HtmlSourceState {
  type: 'html';
  html: string;
  baseDirectory?: string;
}

interface TemplateSourceState {
  type: 'template';
  templateId: string;
}

type SourceState = HtmlSourceState | TemplateSourceState;

interface HtmlFragment {
  html: string;
  baseDirectory?: string;
}

interface BuilderSnapshot {
  source: SourceState;
  header?: HtmlFragment;
  footer?: HtmlFragment;
  context: JsonObject;
  pdfOptions: PdfOptions;
  waitUntil?: WaitUntil;
  waitFunction?: string;
  emulateMedia?: EmulateMedia;
  reference?: string;
  templateName?: string;
  storePdf?: boolean;
  webhook?: {
    url: string;
    secret: string;
    events: readonly WebhookEvent[];
  };
  manualAssets: readonly ManualAsset[];
  autoResolve?: boolean;
}

const PDF_FORMATS = new Set<PdfFormat>([
  'Letter',
  'Legal',
  'Tabloid',
  'Ledger',
  'A0',
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
]);
const WAIT_UNTIL = new Set<WaitUntil>([
  'load',
  'domcontentloaded',
  'networkidle0',
  'networkidle2',
  'function',
]);
const PDF_OPTION_KEYS = new Set([
  'format',
  'width',
  'height',
  'landscape',
  'margin',
  'omitBackground',
  'outline',
  'pageRanges',
  'preferCSSPageSize',
  'printBackground',
  'scale',
  'tagged',
  'waitForFonts',
]);
const WEBHOOK_EVENTS = new Set<WebhookEvent>(['pdf.rendered', 'pdf.failed']);

function cloneSource(source: SourceState): SourceState {
  return source.type === 'html'
    ? {
        type: 'html',
        html: source.html,
        ...(source.baseDirectory === undefined
          ? {}
          : { baseDirectory: source.baseDirectory }),
      }
    : { type: 'template', templateId: source.templateId };
}

function cloneFragment(
  fragment: HtmlFragment | undefined,
): HtmlFragment | undefined {
  return fragment
    ? {
        html: fragment.html,
        ...(fragment.baseDirectory === undefined
          ? {}
          : { baseDirectory: fragment.baseDirectory }),
      }
    : undefined;
}

function cloneManualAsset(asset: ManualAsset): ManualAsset {
  return asset.type === 'file'
    ? {
        type: 'file',
        path: asset.path,
        options: { ...asset.options },
      }
    : {
        type: 'data',
        data: Uint8Array.from(asset.data),
        options: { ...asset.options },
      };
}

function mergeObjects(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };

  for (const [key, value] of Object.entries(incoming)) {
    merged[key] =
      isPlainObject(value) && isPlainObject(merged[key])
        ? mergeObjects(merged[key], value)
        : value;
  }

  return merged;
}

function assertFiniteLength(
  value: unknown,
  label: string,
): asserts value is PdfLength {
  if (
    (typeof value !== 'string' || value.trim() === '') &&
    (typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new InvalidRenderConfigurationError(
      `BladePDF ${label} must be a non-empty string or finite number.`,
    );
  }
}

export class PendingRender {
  readonly #client: RenderClient;
  readonly #assetResolver: AssetResolver;
  readonly #source: SourceState;
  #header: HtmlFragment | undefined;
  #footer: HtmlFragment | undefined;
  #context: JsonObject = {};
  #pdfOptions: PdfOptions = {};
  #waitUntil: WaitUntil | undefined;
  #waitFunction: string | undefined;
  #emulateMedia: EmulateMedia | undefined;
  #reference: string | undefined;
  #templateName: string | undefined;
  #storePdf: boolean | undefined;
  #webhook:
    | { url: string; secret: string; events: readonly WebhookEvent[] }
    | undefined;
  #manualAssets: ManualAsset[] = [];
  #autoResolve: boolean | undefined;

  public constructor(
    client: RenderClient,
    assetResolver: AssetResolver,
    source: SourceState,
    context: JsonObject = {},
  ) {
    this.#client = client;
    this.#assetResolver = assetResolver;
    this.#source = cloneSource(source);

    if (source.type === 'template') {
      this.#context = cloneJsonObject(context);
    }
  }

  public headerHtml(html: string, options: HtmlSourceOptions = {}): this {
    this.assertHtmlSource('headerHtml()');
    this.#header = {
      html,
      ...(options.baseDirectory === undefined
        ? {}
        : { baseDirectory: options.baseDirectory }),
    };
    return this;
  }

  public footerHtml(html: string, options: HtmlSourceOptions = {}): this {
    this.assertHtmlSource('footerHtml()');
    this.#footer = {
      html,
      ...(options.baseDirectory === undefined
        ? {}
        : { baseDirectory: options.baseDirectory }),
    };
    return this;
  }

  public context(context: JsonObject): this {
    this.assertTemplateSource('context()');
    this.assertJsonObject(context, 'template context');
    this.#context = cloneJsonObject(context);
    return this;
  }

  public mergeContext(context: JsonObject): this {
    this.assertTemplateSource('mergeContext()');
    this.assertJsonObject(context, 'template context');
    this.#context = cloneJsonObject(mergeObjects(this.#context, context));
    return this;
  }

  public pdfOptions(options: PdfOptions): this {
    this.validatePdfOptions(options);
    this.#pdfOptions = {
      ...this.#pdfOptions,
      ...options,
      ...(options.margin
        ? {
            margin: {
              ...this.#pdfOptions.margin,
              ...options.margin,
            },
          }
        : {}),
    };
    return this;
  }

  public format(format: PdfFormat): this {
    if (!PDF_FORMATS.has(format)) {
      throw new InvalidRenderConfigurationError(
        `BladePDF format must be one of: ${[...PDF_FORMATS].join(', ')}.`,
      );
    }
    return this.pdfOptions({ format });
  }

  public paperSize(options: PaperSizeOptions): this {
    this.assertObject(options, 'paper size');
    assertFiniteLength(options.width, 'paper width');
    assertFiniteLength(options.height, 'paper height');
    const unit = this.normalizeUnit(options.unit ?? 'px');

    return this.pdfOptions({
      width: this.formatLength(options.width, unit),
      height: this.formatLength(options.height, unit),
    });
  }

  public margins(options: MarginOptions): this {
    this.assertObject(options, 'margins');
    assertFiniteLength(options.top, 'top margin');
    assertFiniteLength(options.right, 'right margin');
    assertFiniteLength(options.bottom, 'bottom margin');
    assertFiniteLength(options.left, 'left margin');
    const unit = this.normalizeUnit(options.unit ?? 'px');

    return this.pdfOptions({
      margin: {
        top: this.formatLength(options.top, unit),
        right: this.formatLength(options.right, unit),
        bottom: this.formatLength(options.bottom, unit),
        left: this.formatLength(options.left, unit),
      },
    });
  }

  public landscape(enabled = true): this {
    return this.pdfOptions({ landscape: enabled });
  }

  public portrait(): this {
    return this.landscape(false);
  }

  public printBackground(enabled = true): this {
    return this.pdfOptions({ printBackground: enabled });
  }

  public transparentBackground(enabled = true): this {
    return this.pdfOptions({ omitBackground: enabled });
  }

  public scale(scale: number): this {
    if (!Number.isFinite(scale) || scale < 0.1 || scale > 2) {
      throw new InvalidRenderConfigurationError(
        'BladePDF scale must be between 0.1 and 2.0.',
      );
    }
    return this.pdfOptions({ scale });
  }

  public pageRanges(pageRanges: string): this {
    if (typeof pageRanges !== 'string' || pageRanges.trim() === '') {
      throw new InvalidRenderConfigurationError(
        'BladePDF pageRanges cannot be empty.',
      );
    }
    return this.pdfOptions({ pageRanges });
  }

  public taggedPdf(enabled = true): this {
    return this.pdfOptions({ tagged: enabled });
  }

  public preferCssPageSize(enabled = true): this {
    return this.pdfOptions({ preferCSSPageSize: enabled });
  }

  public waitForFonts(enabled = true): this {
    return this.pdfOptions({ waitForFonts: enabled });
  }

  public outline(enabled = true): this {
    return this.pdfOptions({ outline: enabled });
  }

  public waitUntil(waitUntil?: WaitUntil): this {
    if (waitUntil !== undefined && !WAIT_UNTIL.has(waitUntil)) {
      throw new InvalidRenderConfigurationError(
        `BladePDF waitUntil must be one of: ${[...WAIT_UNTIL].join(', ')}.`,
      );
    }
    this.#waitUntil = waitUntil;
    if (waitUntil !== 'function') {
      this.#waitFunction = undefined;
    }
    return this;
  }

  public waitForFunction(source?: string): this {
    if (
      source !== undefined &&
      (typeof source !== 'string' || source.trim() === '')
    ) {
      throw new InvalidRenderConfigurationError(
        'BladePDF wait function cannot be empty.',
      );
    }
    this.#waitFunction = source;
    this.#waitUntil = source === undefined ? undefined : 'function';
    return this;
  }

  public emulateMedia(media?: EmulateMedia): this {
    if (media !== undefined && media !== 'screen' && media !== 'print') {
      throw new InvalidRenderConfigurationError(
        'BladePDF emulateMedia must be screen or print.',
      );
    }
    this.#emulateMedia = media;
    return this;
  }

  public reference(reference?: string): this {
    if (reference !== undefined && typeof reference !== 'string') {
      throw new InvalidRenderConfigurationError(
        'BladePDF reference must be a string.',
      );
    }
    this.#reference = reference;
    return this;
  }

  public templateName(templateName?: string): this {
    this.assertHtmlSource('templateName()');
    if (templateName !== undefined && typeof templateName !== 'string') {
      throw new InvalidRenderConfigurationError(
        'BladePDF templateName must be a string.',
      );
    }
    this.#templateName = templateName;
    return this;
  }

  public metadata(metadata: RenderMetadata): this {
    this.assertObject(metadata, 'metadata');
    const unsupported = Object.keys(metadata).filter(
      (key) => key !== 'reference' && key !== 'templateName',
    );

    if (unsupported.length > 0) {
      throw new InvalidRenderConfigurationError(
        `Unsupported BladePDF metadata field(s): ${unsupported.join(', ')}.`,
      );
    }
    if (metadata.reference !== undefined) {
      this.reference(metadata.reference);
    }
    if (metadata.templateName !== undefined) {
      this.templateName(metadata.templateName);
    }
    return this;
  }

  public storePdf(enabled = true): this {
    this.#storePdf = enabled;
    return this;
  }

  public webhook(options: WebhookOptions): this {
    this.assertObject(options, 'webhook options');
    const unsupported = Object.keys(options).filter(
      (key) => key !== 'url' && key !== 'secret' && key !== 'events',
    );

    if (unsupported.length > 0) {
      throw new InvalidRenderConfigurationError(
        `Unsupported BladePDF webhook option(s): ${unsupported.join(', ')}.`,
      );
    }
    if (typeof options.url !== 'string' || typeof options.secret !== 'string') {
      throw new InvalidRenderConfigurationError(
        'BladePDF webhook url and secret must be strings.',
      );
    }

    const url = options.url.trim();
    const secret = options.secret.trim();
    let parsed: URL;

    try {
      parsed = new URL(url);
    } catch (error) {
      throw new InvalidRenderConfigurationError(
        'BladePDF webhook URL must be a valid http or https URL.',
        { cause: error },
      );
    }

    if (
      url.length > 1024 ||
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    ) {
      throw new InvalidRenderConfigurationError(
        'BladePDF webhook URL must be a valid http or https URL.',
      );
    }
    if (secret === '' || secret.length > 1024) {
      throw new InvalidRenderConfigurationError(
        'BladePDF webhook secret must contain between 1 and 1024 characters.',
      );
    }

    if (options.events !== undefined && !Array.isArray(options.events)) {
      throw new InvalidRenderConfigurationError(
        'BladePDF webhook events must be an array.',
      );
    }

    const requestedEvents: readonly WebhookEvent[] = options.events ?? [
      'pdf.rendered',
      'pdf.failed',
    ];
    const events: WebhookEvent[] = [...new Set(requestedEvents)];

    if (
      events.length === 0 ||
      events.some((event) => !WEBHOOK_EVENTS.has(event))
    ) {
      throw new InvalidRenderConfigurationError(
        'BladePDF webhook events must contain pdf.rendered or pdf.failed.',
      );
    }

    this.#webhook = { url, secret, events: Object.freeze(events) };
    return this;
  }

  public resolveAssets(enabled = true): this {
    this.#autoResolve = enabled;
    return this;
  }

  public assetFile(path: string, options: AssetFileOptions = {}): this {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new InvalidRenderConfigurationError(
        'BladePDF asset file path cannot be empty.',
      );
    }
    const normalizedOptions: AssetFileOptions = {
      ...(options.target === undefined
        ? {}
        : { target: normalizeAssetTarget(options.target) }),
      ...(options.mimeType === undefined
        ? {}
        : { mimeType: this.normalizeMimeType(options.mimeType) }),
    };
    this.#manualAssets.push({ type: 'file', path, options: normalizedOptions });
    return this;
  }

  public assetData(data: AssetData, options: AssetDataOptions): this {
    const target = normalizeAssetTarget(options.target);
    const filename = basename(options.filename ?? target);

    if (filename === '' || filename === '.' || filename === '..') {
      throw new InvalidRenderConfigurationError(
        'BladePDF in-memory asset filename cannot be empty.',
      );
    }

    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data.slice(0))
        : Uint8Array.from(data);
    this.#manualAssets.push({
      type: 'data',
      data: bytes,
      options: {
        target,
        filename,
        ...(options.mimeType === undefined
          ? {}
          : { mimeType: this.normalizeMimeType(options.mimeType) }),
        ...(options.baseDirectory === undefined
          ? {}
          : { baseDirectory: options.baseDirectory }),
      },
    });
    return this;
  }

  public render(options: DeliveryOptions = {}): Promise<RenderResult> {
    const snapshot = this.snapshot();
    return this.executeRender(snapshot, options);
  }

  public renderStream(
    options: DeliveryOptions = {},
  ): Promise<RenderStreamResult> {
    const snapshot = this.snapshot();
    return this.executeRenderStream(snapshot, options);
  }

  public renderToFile(
    path: string,
    options: FileDeliveryOptions = {},
  ): Promise<RenderFileResult> {
    const snapshot = this.snapshot();
    return this.executeRenderToFile(snapshot, path, options);
  }

  public submit(options: DeliveryOptions = {}): Promise<RenderSubmission> {
    const snapshot = this.snapshot();

    if (snapshot.storePdf !== true) {
      throw new InvalidRenderConfigurationError(
        'BladePDF background renders require storePdf() so the generated PDF remains available after the request is accepted.',
      );
    }

    return this.executeSubmit(snapshot, options);
  }

  private snapshot(): BuilderSnapshot {
    encodeJson(this.#context, 'context');
    encodeJson(this.#pdfOptions, 'PDF options');

    return {
      source: cloneSource(this.#source),
      ...(this.#header === undefined
        ? {}
        : { header: cloneFragment(this.#header)! }),
      ...(this.#footer === undefined
        ? {}
        : { footer: cloneFragment(this.#footer)! }),
      context: cloneJsonObject(this.#context),
      pdfOptions: {
        ...this.#pdfOptions,
        ...(this.#pdfOptions.margin
          ? { margin: { ...this.#pdfOptions.margin } }
          : {}),
      },
      ...(this.#waitUntil === undefined ? {} : { waitUntil: this.#waitUntil }),
      ...(this.#waitFunction === undefined
        ? {}
        : { waitFunction: this.#waitFunction }),
      ...(this.#emulateMedia === undefined
        ? {}
        : { emulateMedia: this.#emulateMedia }),
      ...(this.#reference === undefined ? {} : { reference: this.#reference }),
      ...(this.#templateName === undefined
        ? {}
        : { templateName: this.#templateName }),
      ...(this.#storePdf === undefined ? {} : { storePdf: this.#storePdf }),
      ...(this.#webhook === undefined
        ? {}
        : {
            webhook: {
              ...this.#webhook,
              events: [...this.#webhook.events],
            },
          }),
      manualAssets: this.#manualAssets.map(cloneManualAsset),
      ...(this.#autoResolve === undefined
        ? {}
        : { autoResolve: this.#autoResolve }),
    };
  }

  private async executeRender(
    snapshot: BuilderSnapshot,
    options: DeliveryOptions,
  ): Promise<RenderResult> {
    return this.#client.render(await this.buildRequest(snapshot), options);
  }

  private async executeRenderStream(
    snapshot: BuilderSnapshot,
    options: DeliveryOptions,
  ): Promise<RenderStreamResult> {
    return this.#client.renderStream(
      await this.buildRequest(snapshot),
      options,
    );
  }

  private async executeRenderToFile(
    snapshot: BuilderSnapshot,
    path: string,
    options: FileDeliveryOptions,
  ): Promise<RenderFileResult> {
    const result = await this.#client.renderStream(
      await this.buildRequest(snapshot),
      options,
    );
    await atomicWriteStream(path, result.stream, options.overwrite ?? true);

    return new RenderFileResult(path, result.storedPdfUrl, result.requestId);
  }

  private async executeSubmit(
    snapshot: BuilderSnapshot,
    options: DeliveryOptions,
  ): Promise<RenderSubmission> {
    return this.#client.submit(await this.buildRequest(snapshot), options);
  }

  private async buildRequest(
    snapshot: BuilderSnapshot,
  ): Promise<RenderRequest> {
    const metadata = {
      ...(snapshot.reference === undefined
        ? {}
        : { reference: snapshot.reference }),
      ...(snapshot.templateName === undefined
        ? {}
        : { template_name: snapshot.templateName }),
    };
    const common = {
      ...(snapshot.waitUntil === undefined
        ? {}
        : { waitUntil: snapshot.waitUntil }),
      ...(snapshot.waitFunction === undefined
        ? {}
        : { waitFunction: snapshot.waitFunction }),
      ...(snapshot.emulateMedia === undefined
        ? {}
        : { emulateMedia: snapshot.emulateMedia }),
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
      ...(snapshot.storePdf === undefined
        ? {}
        : { storePdf: snapshot.storePdf }),
      ...(snapshot.webhook === undefined ? {} : { webhook: snapshot.webhook }),
      ...(Object.keys(snapshot.pdfOptions).length === 0
        ? {}
        : { pdfOptions: snapshot.pdfOptions }),
    };

    if (snapshot.source.type === 'template') {
      const resolved = await this.#assetResolver.resolve({
        html: '',
        manualAssets: snapshot.manualAssets,
        ...(snapshot.autoResolve === undefined
          ? {}
          : { autoResolve: snapshot.autoResolve }),
      });

      return new RenderRequest({
        source: {
          type: 'template',
          templateId: snapshot.source.templateId,
        },
        context: snapshot.context,
        assets: resolved.assets,
        ...common,
      });
    }

    const resolved = await this.#assetResolver.resolve({
      html: snapshot.source.html,
      ...(snapshot.header === undefined
        ? {}
        : { headerHtml: snapshot.header.html }),
      ...(snapshot.footer === undefined
        ? {}
        : { footerHtml: snapshot.footer.html }),
      manualAssets: snapshot.manualAssets,
      ...(snapshot.autoResolve === undefined
        ? {}
        : { autoResolve: snapshot.autoResolve }),
      ...(snapshot.source.baseDirectory === undefined
        ? {}
        : { htmlBaseDirectory: snapshot.source.baseDirectory }),
      ...(snapshot.header?.baseDirectory === undefined
        ? {}
        : { headerBaseDirectory: snapshot.header.baseDirectory }),
      ...(snapshot.footer?.baseDirectory === undefined
        ? {}
        : { footerBaseDirectory: snapshot.footer.baseDirectory }),
    });

    return new RenderRequest({
      source: { type: 'html' },
      html: resolved.html,
      ...(resolved.headerHtml === undefined
        ? {}
        : { headerHtml: resolved.headerHtml }),
      ...(resolved.footerHtml === undefined
        ? {}
        : { footerHtml: resolved.footerHtml }),
      assets: resolved.assets,
      ...common,
    });
  }

  private validatePdfOptions(options: PdfOptions): void {
    const untypedOptions: unknown = options;

    if (!isPlainObject(untypedOptions)) {
      throw new InvalidRenderConfigurationError(
        'BladePDF PDF options must be an object.',
      );
    }

    const unsupported = Object.keys(options).filter(
      (key) => !PDF_OPTION_KEYS.has(key),
    );
    if (unsupported.length > 0) {
      throw new InvalidRenderConfigurationError(
        `Unsupported BladePDF PDF option(s): ${unsupported.join(', ')}.`,
      );
    }
    if (options.format !== undefined && !PDF_FORMATS.has(options.format)) {
      throw new InvalidRenderConfigurationError('Invalid BladePDF PDF format.');
    }
    if (options.width !== undefined) {
      assertFiniteLength(options.width, 'paper width');
    }
    if (options.height !== undefined) {
      assertFiniteLength(options.height, 'paper height');
    }
    if (
      options.scale !== undefined &&
      (!Number.isFinite(options.scale) ||
        options.scale < 0.1 ||
        options.scale > 2)
    ) {
      throw new InvalidRenderConfigurationError(
        'BladePDF scale must be between 0.1 and 2.0.',
      );
    }
    if (options.margin !== undefined) {
      const untypedMargin: unknown = options.margin;

      if (!isPlainObject(untypedMargin)) {
        throw new InvalidRenderConfigurationError(
          'BladePDF margin must be an object.',
        );
      }
      const unsupportedMargins = Object.keys(options.margin).filter(
        (key) => !['top', 'right', 'bottom', 'left'].includes(key),
      );
      if (unsupportedMargins.length > 0) {
        throw new InvalidRenderConfigurationError(
          `Unsupported BladePDF margin field(s): ${unsupportedMargins.join(', ')}.`,
        );
      }
      for (const [key, value] of Object.entries(options.margin)) {
        assertFiniteLength(value, `${key} margin`);
      }
    }

    for (const [key, value] of Object.entries(options)) {
      if (
        [
          'landscape',
          'omitBackground',
          'outline',
          'preferCSSPageSize',
          'printBackground',
          'tagged',
          'waitForFonts',
        ].includes(key) &&
        typeof value !== 'boolean'
      ) {
        throw new InvalidRenderConfigurationError(
          `BladePDF PDF option ${key} must be a boolean.`,
        );
      }
    }
  }

  private assertHtmlSource(method: string): void {
    if (this.#source.type !== 'html') {
      throw new InvalidRenderConfigurationError(
        `BladePDF ${method} is only supported for HTML renders.`,
      );
    }
  }

  private assertTemplateSource(method: string): void {
    if (this.#source.type !== 'template') {
      throw new InvalidRenderConfigurationError(
        `BladePDF ${method} is only supported for cloud template renders.`,
      );
    }
  }

  private normalizeUnit(unit: string): string {
    const normalized = unit.trim();
    if (normalized === '' || !/^[a-z%]+$/iu.test(normalized)) {
      throw new InvalidRenderConfigurationError(
        'BladePDF PDF length unit must be a non-empty CSS unit.',
      );
    }
    return normalized;
  }

  private formatLength(value: PdfLength, unit: string): PdfLength {
    if (typeof value === 'string') {
      return value;
    }
    return `${Number(value.toFixed(4)).toString()}${unit}`;
  }

  private normalizeMimeType(mimeType: string): string {
    const normalized = mimeType.trim();
    if (normalized === '') {
      throw new InvalidRenderConfigurationError(
        'BladePDF asset MIME type cannot be empty.',
      );
    }
    return normalized;
  }

  private assertObject(value: unknown, label: string): void {
    if (!isPlainObject(value)) {
      throw new InvalidRenderConfigurationError(
        `BladePDF ${label} must be an object.`,
      );
    }
  }

  private assertJsonObject(
    value: unknown,
    label: string,
  ): asserts value is JsonObject {
    if (!isPlainObject(value)) {
      throw new InvalidRenderConfigurationError(
        `BladePDF ${label} must be an object.`,
      );
    }
    encodeJson(value, label);
  }
}
