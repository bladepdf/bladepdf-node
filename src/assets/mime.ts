import { extname } from 'node:path';

const WEB_ASSET_MIME_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  css: 'text/css',
  eot: 'application/vnd.ms-fontobject',
  gif: 'image/gif',
  htm: 'text/html',
  html: 'text/html',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  mjs: 'text/javascript',
  otf: 'font/otf',
  png: 'image/png',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

export function guessMimeType(path: string): string {
  const extension = extname(path).slice(1).toLowerCase();

  return WEB_ASSET_MIME_TYPES[extension] ?? 'application/octet-stream';
}
