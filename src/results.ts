import type { Readable } from 'node:stream';

import { atomicWriteBuffer } from './files.js';

export interface SaveOptions {
  overwrite?: boolean;
}

export class RenderResult {
  public constructor(
    public readonly pdf: Buffer,
    public readonly storedPdfUrl?: string,
    public readonly requestId?: string,
  ) {}

  public toBase64(): string {
    return this.pdf.toString('base64');
  }

  public async save(path: string, options: SaveOptions = {}): Promise<string> {
    return atomicWriteBuffer(path, this.pdf, options.overwrite ?? true);
  }
}

export class RenderStreamResult {
  public constructor(
    public readonly stream: Readable,
    public readonly storedPdfUrl?: string,
    public readonly requestId?: string,
  ) {}
}

export class RenderFileResult {
  public constructor(
    public readonly path: string,
    public readonly storedPdfUrl?: string,
    public readonly requestId?: string,
  ) {}
}

export class RenderSubmission {
  public constructor(
    public readonly requestId: string,
    public readonly reference?: string,
  ) {}
}
