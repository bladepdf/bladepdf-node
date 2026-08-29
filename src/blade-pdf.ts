import { AssetResolver } from './assets/resolver.js';
import {
  BladePdfClient,
  type BladePdfClientOptions,
  type RenderClient,
} from './client.js';
import {
  InvalidRenderConfigurationError,
  MissingApiKeyError,
} from './errors.js';
import { isPlainObject } from './internal.js';
import { PendingRender } from './pending-render.js';
import type {
  AssetResolverOptions,
  HtmlSourceOptions,
  JsonObject,
} from './types.js';

export interface BladePdfOptions extends BladePdfClientOptions {
  apiKey: string;
  assets?: AssetResolverOptions;
}

export interface BladePdfDependencies {
  client: RenderClient;
  assetResolver?: AssetResolver;
}

export class BladePdf {
  readonly #client: RenderClient;
  readonly #assetResolver: AssetResolver;

  public constructor(options: BladePdfOptions | BladePdfDependencies) {
    if ('client' in options) {
      this.#client = options.client;
      this.#assetResolver = options.assetResolver ?? new AssetResolver();
      return;
    }

    const apiKey = options.apiKey.trim();

    if (apiKey === '') {
      throw new MissingApiKeyError('Missing BladePDF API key.');
    }

    this.#client = new BladePdfClient(apiKey, {
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.retries === undefined ? {} : { retries: options.retries }),
      ...(options.retryDelayMs === undefined
        ? {}
        : { retryDelayMs: options.retryDelayMs }),
      ...(options.userAgent === undefined
        ? {}
        : { userAgent: options.userAgent }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.#assetResolver = new AssetResolver(options.assets);
  }

  public static fromDependencies(dependencies: BladePdfDependencies): BladePdf {
    return new BladePdf(dependencies);
  }

  public fromHtml(
    html: string,
    options: HtmlSourceOptions = {},
  ): PendingRender {
    if (typeof html !== 'string') {
      throw new InvalidRenderConfigurationError(
        'BladePDF HTML source must be a string.',
      );
    }
    if (!isPlainObject(options)) {
      throw new InvalidRenderConfigurationError(
        'BladePDF HTML source options must be an object.',
      );
    }
    if (
      options.baseDirectory !== undefined &&
      typeof options.baseDirectory !== 'string'
    ) {
      throw new InvalidRenderConfigurationError(
        'BladePDF HTML baseDirectory must be a string.',
      );
    }

    return new PendingRender(this.#client, this.#assetResolver, {
      type: 'html',
      html,
      ...(options.baseDirectory === undefined
        ? {}
        : { baseDirectory: options.baseDirectory }),
    });
  }

  public fromTemplate(
    templateId: string,
    context: JsonObject = {},
  ): PendingRender {
    if (typeof templateId !== 'string') {
      throw new InvalidRenderConfigurationError(
        'BladePDF template id must be a string.',
      );
    }
    if (!isPlainObject(context)) {
      throw new InvalidRenderConfigurationError(
        'BladePDF template context must be an object.',
      );
    }

    const normalized = templateId.trim();

    if (normalized === '') {
      throw new InvalidRenderConfigurationError(
        'BladePDF template id cannot be empty.',
      );
    }

    return new PendingRender(
      this.#client,
      this.#assetResolver,
      { type: 'template', templateId: normalized },
      context,
    );
  }
}
