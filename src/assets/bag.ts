import { createHash } from 'node:crypto';
import { extname } from 'node:path';

import { InvalidRenderConfigurationError } from '../errors.js';
import type { ResolvedAsset } from '../types.js';

interface PendingAsset {
  filename: string;
  contents?: Uint8Array;
  mimeType: string;
  sourcePath?: string;
}

function normalizedSourcePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export class AssetBag {
  readonly #assets = new Map<string, PendingAsset>();
  readonly #sourceMap = new Map<string, string>();

  public uriForSource(sourcePath: string): string | undefined {
    return this.#sourceMap.get(normalizedSourcePath(sourcePath));
  }

  public reserveSource(
    sourcePath: string,
    filename: string,
    mimeType: string,
    fieldName?: string,
  ): string {
    const normalized = normalizedSourcePath(sourcePath);
    const existing = this.#sourceMap.get(normalized);

    if (existing) {
      return existing;
    }

    const resolvedFieldName =
      fieldName ?? this.generatedFieldName(normalized, filename);
    this.#sourceMap.set(normalized, resolvedFieldName);
    this.#assets.set(resolvedFieldName, {
      filename,
      mimeType,
      sourcePath,
    });

    return resolvedFieldName;
  }

  public completeSource(sourcePath: string, contents: Uint8Array): void {
    const normalized = normalizedSourcePath(sourcePath);
    const fieldName = this.#sourceMap.get(normalized);
    const asset = fieldName ? this.#assets.get(fieldName) : undefined;

    if (!fieldName || !asset) {
      throw new InvalidRenderConfigurationError(
        `BladePDF asset [${sourcePath}] was completed before it was reserved.`,
      );
    }

    this.#assets.set(fieldName, { ...asset, contents });
  }

  public putManual(
    contents: Uint8Array,
    filename: string,
    mimeType: string,
    sourcePath?: string,
    fieldName?: string,
  ): string {
    const normalized = sourcePath
      ? normalizedSourcePath(sourcePath)
      : undefined;
    const existing = normalized ? this.#sourceMap.get(normalized) : undefined;
    const resolvedFieldName =
      fieldName ??
      existing ??
      this.generatedFieldName(normalized ?? filename, filename);
    this.#assets.set(resolvedFieldName, {
      filename,
      contents,
      mimeType,
      ...(sourcePath === undefined ? {} : { sourcePath }),
    });

    if (normalized && !existing) {
      this.#sourceMap.set(normalized, resolvedFieldName);
    }

    return resolvedFieldName;
  }

  public all(): readonly ResolvedAsset[] {
    return Object.freeze(
      [...this.#assets.entries()].map(([fieldName, asset]) => {
        if (!asset.contents) {
          throw new InvalidRenderConfigurationError(
            `BladePDF asset [${fieldName}] was reserved but not resolved.`,
          );
        }

        return Object.freeze({
          fieldName,
          filename: asset.filename,
          contents: asset.contents,
          mimeType: asset.mimeType,
          ...(asset.sourcePath === undefined
            ? {}
            : { sourcePath: asset.sourcePath }),
        });
      }),
    );
  }

  private generatedFieldName(sourcePath: string, filename: string): string {
    const extension = extname(filename).toLowerCase();
    const hash = createHash('sha256')
      .update(sourcePath)
      .digest('hex')
      .slice(0, 32);

    return `asset:///${hash}${extension}`;
  }
}
