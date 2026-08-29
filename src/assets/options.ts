import { parse } from 'node:path';
import { realpathSync, statSync } from 'node:fs';

import { InvalidRenderConfigurationError } from '../errors.js';
import type { AssetResolverOptions } from '../types.js';

function canonicalDirectory(path: string): string {
  if (path.trim() === '') {
    throw new InvalidRenderConfigurationError(
      'BladePDF asset roots must be non-empty strings.',
    );
  }

  let resolved: string;

  try {
    resolved = realpathSync.native(path);
  } catch (error) {
    throw new InvalidRenderConfigurationError(
      `BladePDF asset root [${path}] is not an existing directory.`,
      { cause: error },
    );
  }

  if (!statSync(resolved).isDirectory()) {
    throw new InvalidRenderConfigurationError(
      `BladePDF asset root [${path}] is not an existing directory.`,
    );
  }

  const filesystemRoot = parse(resolved).root;

  return resolved === filesystemRoot
    ? resolved
    : resolved.replace(/[\\/]+$/u, '');
}

export class NormalizedAssetResolverOptions {
  public readonly documentRoot: string | undefined;
  public readonly searchRoots: readonly string[];
  public readonly localHosts: readonly string[];
  public readonly autoResolve: boolean;

  public constructor(options: AssetResolverOptions = {}) {
    const documentRoot = options.documentRoot
      ? canonicalDirectory(options.documentRoot)
      : undefined;
    const roots = [
      ...(documentRoot === undefined ? [] : [documentRoot]),
      ...(options.searchRoots ?? []).map(canonicalDirectory),
    ];

    this.documentRoot = documentRoot;
    this.searchRoots = Object.freeze([...new Set(roots)]);
    this.localHosts = Object.freeze([
      ...new Set(
        (options.localHosts ?? ['localhost', '127.0.0.1', '::1'])
          .map((host) =>
            host
              .trim()
              .replace(/^\[|\]$/gu, '')
              .toLowerCase(),
          )
          .filter((host) => host !== ''),
      ),
    ]);
    this.autoResolve = options.autoResolve ?? true;
  }
}
