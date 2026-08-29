import { cloneJsonObject, deepFreezeJson } from './internal.js';

export type JsonObject = Record<string, unknown>;

export type PdfFormat =
  | 'Letter'
  | 'Legal'
  | 'Tabloid'
  | 'Ledger'
  | 'A0'
  | 'A1'
  | 'A2'
  | 'A3'
  | 'A4'
  | 'A5'
  | 'A6';

export type PdfLength = string | number;

export interface PdfMargin {
  top?: PdfLength;
  right?: PdfLength;
  bottom?: PdfLength;
  left?: PdfLength;
}

export interface PdfOptions {
  format?: PdfFormat;
  width?: PdfLength;
  height?: PdfLength;
  landscape?: boolean;
  margin?: PdfMargin;
  omitBackground?: boolean;
  outline?: boolean;
  pageRanges?: string;
  preferCSSPageSize?: boolean;
  printBackground?: boolean;
  scale?: number;
  tagged?: boolean;
  waitForFonts?: boolean;
}

export type WaitUntil =
  'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2' | 'function';

export type EmulateMedia = 'screen' | 'print';

export type WebhookEvent = 'pdf.rendered' | 'pdf.failed';

export interface WebhookOptions {
  url: string;
  secret: string;
  events?: readonly WebhookEvent[];
}

export interface RenderMetadata {
  reference?: string;
  templateName?: string;
}

export interface HtmlSourceOptions {
  baseDirectory?: string;
}

export interface AssetResolverOptions {
  documentRoot?: string;
  searchRoots?: readonly string[];
  localHosts?: readonly string[];
  autoResolve?: boolean;
}

export interface AssetFileOptions {
  target?: string;
  mimeType?: string;
}

export interface AssetDataOptions {
  target: string;
  filename?: string;
  mimeType?: string;
  baseDirectory?: string;
}

export type AssetData = Uint8Array | ArrayBuffer;

export interface PaperSizeOptions {
  width: PdfLength;
  height: PdfLength;
  unit?: string;
}

export interface MarginOptions {
  top: PdfLength;
  right: PdfLength;
  bottom: PdfLength;
  left: PdfLength;
  unit?: string;
}

export interface DeliveryOptions {
  signal?: AbortSignal;
}

export interface FileDeliveryOptions extends DeliveryOptions {
  overwrite?: boolean;
}

export interface ResolvedAsset {
  readonly fieldName: string;
  readonly filename: string;
  readonly contents: Uint8Array;
  readonly mimeType: string;
  readonly sourcePath?: string;
}

export interface ResolvedDocument {
  readonly html: string;
  readonly headerHtml?: string;
  readonly footerHtml?: string;
  readonly assets: readonly ResolvedAsset[];
}

export interface HtmlRenderSource {
  readonly type: 'html';
}

export interface TemplateRenderSource {
  readonly type: 'template';
  readonly templateId: string;
}

export type RenderSource = HtmlRenderSource | TemplateRenderSource;

export interface RenderRequestOptions {
  source: RenderSource;
  html?: string;
  headerHtml?: string;
  footerHtml?: string;
  context?: JsonObject;
  waitUntil?: WaitUntil;
  waitFunction?: string;
  emulateMedia?: EmulateMedia;
  metadata?: {
    reference?: string;
    template_name?: string;
  };
  storePdf?: boolean;
  webhook?: {
    url: string;
    secret: string;
    events: readonly WebhookEvent[];
  };
  pdfOptions?: PdfOptions;
  assets?: readonly ResolvedAsset[];
}

export class RenderRequest {
  public readonly source: RenderSource;
  public readonly html: string | undefined;
  public readonly headerHtml: string | undefined;
  public readonly footerHtml: string | undefined;
  public readonly context: JsonObject | undefined;
  public readonly waitUntil: WaitUntil | undefined;
  public readonly waitFunction: string | undefined;
  public readonly emulateMedia: EmulateMedia | undefined;
  public readonly metadata:
    | { readonly reference?: string; readonly template_name?: string }
    | undefined;
  public readonly storePdf: boolean | undefined;
  public readonly webhook:
    | {
        readonly url: string;
        readonly secret: string;
        readonly events: readonly WebhookEvent[];
      }
    | undefined;
  public readonly pdfOptions: Readonly<PdfOptions> | undefined;
  public readonly assets: readonly ResolvedAsset[];

  public constructor(options: RenderRequestOptions) {
    this.source = Object.freeze({ ...options.source });
    this.html = options.html;
    this.headerHtml = options.headerHtml;
    this.footerHtml = options.footerHtml;
    this.context = options.context
      ? deepFreezeJson(cloneJsonObject(options.context))
      : undefined;
    this.waitUntil = options.waitUntil;
    this.waitFunction = options.waitFunction;
    this.emulateMedia = options.emulateMedia;
    this.metadata = options.metadata
      ? Object.freeze({ ...options.metadata })
      : undefined;
    this.storePdf = options.storePdf;
    this.webhook = options.webhook
      ? Object.freeze({
          ...options.webhook,
          events: Object.freeze([...options.webhook.events]),
        })
      : undefined;
    this.pdfOptions = options.pdfOptions
      ? Object.freeze({
          ...options.pdfOptions,
          ...(options.pdfOptions.margin
            ? { margin: Object.freeze({ ...options.pdfOptions.margin }) }
            : {}),
        })
      : undefined;
    this.assets = Object.freeze(
      (options.assets ?? []).map((asset) =>
        Object.freeze({
          ...asset,
          contents: Uint8Array.from(asset.contents),
        }),
      ),
    );
    Object.freeze(this);
  }
}
