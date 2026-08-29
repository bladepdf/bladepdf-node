import { basename, dirname, extname } from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';

import {
  AssetNotFoundError,
  InvalidRenderConfigurationError,
} from '../errors.js';
import { replaceAsync } from '../internal.js';
import type {
  AssetDataOptions,
  AssetFileOptions,
  AssetResolverOptions,
  ResolvedDocument,
} from '../types.js';
import { AssetBag } from './bag.js';
import { FilesystemAssetLocator } from './locator.js';
import { guessMimeType } from './mime.js';
import { NormalizedAssetResolverOptions } from './options.js';

export interface ManualFileAsset {
  readonly type: 'file';
  readonly path: string;
  readonly options: AssetFileOptions;
}

export interface ManualDataAsset {
  readonly type: 'data';
  readonly data: Uint8Array;
  readonly options: AssetDataOptions;
}

export type ManualAsset = ManualFileAsset | ManualDataAsset;

export interface AssetResolutionInput {
  html: string;
  headerHtml?: string;
  footerHtml?: string;
  manualAssets?: readonly ManualAsset[];
  autoResolve?: boolean;
  htmlBaseDirectory?: string;
  headerBaseDirectory?: string;
  footerBaseDirectory?: string;
}

const RESERVED_TARGETS = new Set([
  'html',
  'header_html',
  'footer_html',
  'context',
]);

export function normalizeAssetTarget(target: string): string {
  let normalized = target.startsWith('asset:///')
    ? target.slice('asset:///'.length)
    : target;
  normalized = normalized.replace(/^\/+/, '');

  if (
    normalized === '' ||
    !/^[a-z0-9._-]+$/iu.test(normalized) ||
    RESERVED_TARGETS.has(normalized)
  ) {
    throw new InvalidRenderConfigurationError(
      'BladePDF asset targets may only contain letters, numbers, dots, underscores, and hyphens and may not use a reserved file field name.',
    );
  }

  return normalized;
}

export class AssetResolver {
  readonly #options: NormalizedAssetResolverOptions;
  readonly #locator: FilesystemAssetLocator;

  public constructor(options: AssetResolverOptions = {}) {
    this.#options = new NormalizedAssetResolverOptions(options);
    this.#locator = new FilesystemAssetLocator(this.#options);
  }

  public async resolve(input: AssetResolutionInput): Promise<ResolvedDocument> {
    const bag = new AssetBag();
    const autoResolve = input.autoResolve ?? this.#options.autoResolve;
    const canResolveFromFilesystem =
      autoResolve && this.#options.searchRoots.length > 0;
    let html = input.html;
    let headerHtml = input.headerHtml;
    let footerHtml = input.footerHtml;

    if (canResolveFromFilesystem) {
      html = await this.rewriteHtml(
        html,
        bag,
        input.htmlBaseDirectory ?? this.#options.documentRoot,
      );
      headerHtml = headerHtml
        ? await this.rewriteHtml(
            headerHtml,
            bag,
            input.headerBaseDirectory ?? this.#options.documentRoot,
          )
        : headerHtml;
      footerHtml = footerHtml
        ? await this.rewriteHtml(
            footerHtml,
            bag,
            input.footerBaseDirectory ?? this.#options.documentRoot,
          )
        : footerHtml;
    }

    for (const asset of input.manualAssets ?? []) {
      if (asset.type === 'file') {
        await this.registerManualFile(asset, bag, canResolveFromFilesystem);
      } else {
        await this.registerManualData(asset, bag, canResolveFromFilesystem);
      }
    }

    return Object.freeze({
      html,
      ...(headerHtml === undefined ? {} : { headerHtml }),
      ...(footerHtml === undefined ? {} : { footerHtml }),
      assets: bag.all(),
    });
  }

  public async registerReference(
    reference: string,
    bag: AssetBag,
    baseDirectory?: string,
  ): Promise<string | undefined> {
    const located = await this.#locator.locate(reference, baseDirectory);

    if (!located) {
      return undefined;
    }

    const existing = bag.uriForSource(located.path);

    if (existing) {
      return `${existing}${located.suffix}`;
    }

    const filename = basename(located.path);
    const mimeType = guessMimeType(located.path);
    const fieldName = bag.reserveSource(located.path, filename, mimeType);
    let contents = await this.readAsset(located.path);

    if (extname(located.path).toLowerCase() === '.css') {
      const rewritten = await this.rewriteCss(
        Buffer.from(contents).toString('utf8'),
        bag,
        dirname(located.path),
      );
      contents = Buffer.from(rewritten);
    }

    bag.completeSource(located.path, contents);

    return `${fieldName}${located.suffix}`;
  }

  private async registerManualFile(
    asset: ManualFileAsset,
    bag: AssetBag,
    autoResolve: boolean,
  ): Promise<void> {
    let canonical: string;

    try {
      canonical = await realpath(asset.path);
      if (!(await stat(canonical)).isFile()) {
        throw new Error('Not a regular file.');
      }
    } catch (error) {
      throw new AssetNotFoundError(
        `Manual BladePDF asset [${asset.path}] was not found.`,
        { cause: error },
      );
    }

    const target = asset.options.target
      ? `asset:///${normalizeAssetTarget(asset.options.target)}`
      : undefined;
    const filename = basename(canonical);
    const mimeType = asset.options.mimeType ?? guessMimeType(canonical);
    const isCss = extname(canonical).toLowerCase() === '.css';

    if (autoResolve && isCss && !bag.uriForSource(canonical)) {
      const reserved = bag.reserveSource(canonical, filename, mimeType, target);
      const source = Buffer.from(await this.readAsset(canonical)).toString(
        'utf8',
      );
      const rewritten = await this.rewriteCss(source, bag, dirname(canonical));
      bag.completeSource(canonical, Buffer.from(rewritten));

      if (!target || reserved === target) {
        return;
      }
    }

    let contents = await this.readAsset(canonical);

    if (autoResolve && isCss) {
      contents = Buffer.from(
        await this.rewriteCss(
          Buffer.from(contents).toString('utf8'),
          bag,
          dirname(canonical),
        ),
      );
    }

    bag.putManual(contents, filename, mimeType, canonical, target);
  }

  private async registerManualData(
    asset: ManualDataAsset,
    bag: AssetBag,
    autoResolve: boolean,
  ): Promise<void> {
    const target = `asset:///${normalizeAssetTarget(asset.options.target)}`;
    const filename =
      asset.options.filename ??
      asset.options.target.replace(/^asset:\/\/\//u, '');
    const mimeType = asset.options.mimeType ?? guessMimeType(filename);
    let contents = Uint8Array.from(asset.data);

    if (autoResolve && extname(filename).toLowerCase() === '.css') {
      contents = Buffer.from(
        await this.rewriteCss(
          Buffer.from(contents).toString('utf8'),
          bag,
          asset.options.baseDirectory,
        ),
      );
    }

    bag.putManual(contents, filename, mimeType, undefined, target);
  }

  private async rewriteHtml(
    source: string,
    bag: AssetBag,
    baseDirectory?: string,
  ): Promise<string> {
    let html = await replaceAsync(
      source,
      /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/giu,
      async (match) =>
        `${match[1] ?? ''}${await this.rewriteCss(match[2] ?? '', bag, baseDirectory)}${match[3] ?? ''}`,
    );

    html = await replaceAsync(
      html,
      /\sstyle=(["'])([\s\S]*?)\1/giu,
      async (match) =>
        ` style=${match[1] ?? '"'}${await this.rewriteCss(match[2] ?? '', bag, baseDirectory)}${match[1] ?? '"'}`,
    );

    html = await replaceAsync(
      html,
      /\s(srcset)=(["'])([\s\S]*?)\2/giu,
      async (match) => {
        const candidates = await Promise.all(
          this.splitSrcset(match[3] ?? '').map(async (candidate) => {
            const parts = candidate.trim().split(/\s+/u, 2);
            const reference = parts[0] ?? '';
            const descriptor = parts[1] ?? '';
            const replacement = await this.registerReference(
              reference,
              bag,
              baseDirectory,
            );

            return replacement
              ? `${replacement}${descriptor ? ` ${descriptor}` : ''}`
              : candidate;
          }),
        );

        return ` ${match[1] ?? 'srcset'}=${match[2] ?? '"'}${candidates.join(', ')}${match[2] ?? '"'}`;
      },
    );

    return replaceAsync(
      html,
      /\s(src|href|poster|data-src|data-href)=(["'])([\s\S]*?)\2/giu,
      async (match) => {
        const replacement = await this.registerReference(
          match[3] ?? '',
          bag,
          baseDirectory,
        );

        return replacement
          ? ` ${match[1] ?? ''}=${match[2] ?? '"'}${replacement}${match[2] ?? '"'}`
          : match[0];
      },
    );
  }

  private async rewriteCss(
    source: string,
    bag: AssetBag,
    baseDirectory?: string,
  ): Promise<string> {
    let css = await replaceAsync(
      source,
      /url\(\s*(["']?)([\s\S]*?)\1\s*\)/giu,
      async (match) => {
        const replacement = await this.registerReference(
          (match[2] ?? '').trim(),
          bag,
          baseDirectory,
        );

        return replacement ? `url(${replacement})` : match[0];
      },
    );

    css = await replaceAsync(
      css,
      /@import\s+(?:url\()?\s*(["']?)([\s\S]*?)\1\s*\)?\s*;/giu,
      async (match) => {
        const replacement = await this.registerReference(
          (match[2] ?? '').trim(),
          bag,
          baseDirectory,
        );

        return replacement ? `@import url(${replacement});` : match[0];
      },
    );

    return css;
  }

  private splitSrcset(srcset: string): string[] {
    const candidates: string[] = [];
    let current = '';
    let isDataUrl = false;
    let seenWhitespace = false;

    for (const character of srcset) {
      if (current === '') {
        isDataUrl = false;
        seenWhitespace = false;

        if (/\s/u.test(character)) {
          continue;
        }
      }

      current += character;

      if (current.length === 5 && current.toLowerCase() === 'data:') {
        isDataUrl = true;
      }

      if (/\s/u.test(character)) {
        seenWhitespace = true;
      }

      if (character === ',' && (!isDataUrl || seenWhitespace)) {
        const candidate = current.slice(0, -1).trim();
        if (candidate) {
          candidates.push(candidate);
        }
        current = '';
      }
    }

    if (current.trim()) {
      candidates.push(current.trim());
    }

    return candidates;
  }

  private async readAsset(path: string): Promise<Uint8Array> {
    try {
      return await readFile(path);
    } catch (error) {
      throw new AssetNotFoundError(
        `BladePDF asset [${path}] could not be read.`,
        { cause: error },
      );
    }
  }
}
