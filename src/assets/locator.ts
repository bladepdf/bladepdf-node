import { stat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AssetAccessDeniedError } from '../errors.js';
import type { NormalizedAssetResolverOptions } from './options.js';

export interface LocatedAsset {
  path: string;
  suffix: string;
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    quot: '"',
  };

  return value.replace(
    /&#(?:x([0-9a-f]+)|([0-9]+));?|&(amp|apos|gt|lt|quot);/giu,
    (
      match,
      hex: string | undefined,
      decimal: string | undefined,
      name: string | undefined,
    ) => {
      const codePoint = hex
        ? Number.parseInt(hex, 16)
        : decimal
          ? Number.parseInt(decimal, 10)
          : undefined;

      if (codePoint !== undefined && Number.isSafeInteger(codePoint)) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }

      return name ? (named[name.toLowerCase()] ?? match) : match;
    },
  );
}

function safelyDecodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function existingFile(path: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(path);
    const details = await stat(canonical);

    return details.isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

export class FilesystemAssetLocator {
  public constructor(
    private readonly options: NormalizedAssetResolverOptions,
  ) {}

  public async locate(
    unresolvedReference: string,
    baseDirectory?: string,
  ): Promise<LocatedAsset | undefined> {
    const reference = decodeHtmlEntities(unresolvedReference.trim());

    if (reference === '' || this.shouldSkip(reference)) {
      return undefined;
    }

    const windowsPath = /^[a-z]:[\\/]/iu.test(reference);
    const protocolRelative = reference.startsWith('//');

    if (protocolRelative || /^https?:/iu.test(reference)) {
      let url: URL;

      try {
        url = new URL(protocolRelative ? `http:${reference}` : reference);
      } catch {
        return undefined;
      }

      if (!this.options.localHosts.includes(url.hostname.toLowerCase())) {
        return undefined;
      }

      return this.locateUrlPath(
        safelyDecodePath(url.pathname),
        `${url.search}${url.hash}`,
      );
    }

    let path: string;
    let suffix: string;

    if (!windowsPath && /^file:/iu.test(reference)) {
      try {
        const url = new URL(reference);
        suffix = `${url.search}${url.hash}`;
        url.search = '';
        url.hash = '';
        path = fileURLToPath(url);
      } catch {
        return undefined;
      }
    } else {
      const scheme = windowsPath
        ? undefined
        : /^([a-z][a-z0-9+.-]*):/iu.exec(reference)?.[1]?.toLowerCase();

      if (scheme) {
        return undefined;
      }

      const splitAt = [reference.indexOf('?'), reference.indexOf('#')]
        .filter((index) => index >= 0)
        .sort((left, right) => left - right)[0];
      path = splitAt === undefined ? reference : reference.slice(0, splitAt);
      suffix = splitAt === undefined ? '' : reference.slice(splitAt);
      path = safelyDecodePath(path);
    }

    if (path === '' || path === '/') {
      return undefined;
    }

    if (isAbsolute(path) || win32.isAbsolute(path)) {
      const absolute = await existingFile(path);

      if (absolute) {
        this.assertAllowed(absolute, reference);
        return { path: absolute, suffix };
      }

      if (path.startsWith('/')) {
        const fromRoot = await this.fromDocumentRoot(path);
        return fromRoot ? { path: fromRoot, suffix } : undefined;
      }

      return undefined;
    }

    const candidates = [
      ...(baseDirectory?.trim() ? [resolve(baseDirectory, path)] : []),
      ...this.options.searchRoots.map((root) => resolve(root, path)),
    ];

    for (const candidate of candidates) {
      const located = await existingFile(candidate);

      if (located) {
        this.assertAllowed(located, reference);
        return { path: located, suffix };
      }
    }

    return undefined;
  }

  private async locateUrlPath(
    path: string,
    suffix: string,
  ): Promise<LocatedAsset | undefined> {
    if (path === '' || path === '/') {
      return undefined;
    }

    const located = await this.fromDocumentRoot(path);

    return located ? { path: located, suffix } : undefined;
  }

  private async fromDocumentRoot(path: string): Promise<string | undefined> {
    if (!this.options.documentRoot) {
      return undefined;
    }

    const candidate = join(
      this.options.documentRoot,
      path.replace(/^[\\/]+/u, ''),
    );
    const located = await existingFile(candidate);

    if (located) {
      this.assertAllowed(located, path);
    }

    return located;
  }

  private assertAllowed(path: string, reference: string): void {
    for (const root of this.options.searchRoots) {
      const nested = relative(root, path);

      if (
        nested === '' ||
        (!nested.startsWith(`..${sep}`) &&
          nested !== '..' &&
          !isAbsolute(nested))
      ) {
        return;
      }
    }

    throw new AssetAccessDeniedError(
      `Automatic BladePDF asset [${reference}] resolves outside the configured asset roots. Attach it explicitly with assetFile() if this access is intentional.`,
    );
  }

  private shouldSkip(reference: string): boolean {
    const lower = reference.toLowerCase();

    return [
      '#',
      'data:',
      'blob:',
      'javascript:',
      'mailto:',
      'tel:',
      'asset:///',
    ].some((prefix) => lower.startsWith(prefix));
  }
}
