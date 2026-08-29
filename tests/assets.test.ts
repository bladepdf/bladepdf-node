import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AssetAccessDeniedError,
  AssetNotFoundError,
  AssetResolver,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  root: string;
  outside: string;
  resolver: AssetResolver;
}> {
  const root = await mkdtemp(join(tmpdir(), 'bladepdf-assets-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'bladepdf-assets-outside-'));
  temporaryDirectories.push(root, outside);
  await mkdir(join(root, 'css', 'nested'), { recursive: true });
  await mkdir(join(root, 'images'), { recursive: true });
  await mkdir(join(root, 'fonts'), { recursive: true });
  await writeFile(
    join(root, 'css', 'app.css'),
    '@import "./nested/theme.css"; .hero { background: url(../images/hero.png?v=2#main); }',
  );
  await writeFile(
    join(root, 'css', 'nested', 'theme.css'),
    '@import "../app.css"; @font-face { src: url(../../fonts/app.woff2?v=1); }',
  );
  await writeFile(join(root, 'images', 'hero.png'), 'png');
  await writeFile(join(root, 'images', 'hero@2x.png'), 'png2');
  await writeFile(join(root, 'fonts', 'app.woff2'), 'font');
  await writeFile(join(root, 'script.js'), 'fetch("/runtime.json")');
  await writeFile(
    join(root, 'sprite.svg'),
    '<svg><image href="inner.png"/></svg>',
  );
  await writeFile(join(outside, 'private.txt'), 'secret');

  return {
    root,
    outside,
    resolver: new AssetResolver({
      documentRoot: root,
      searchRoots: [root],
      localHosts: ['assets.test'],
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe('AssetResolver', () => {
  it('rewrites HTML, nested CSS, srcset, local URLs, query and fragments', async () => {
    const { root, resolver } = await fixture();
    const resolved = await resolver.resolve({
      html: [
        '<link href="/css/app.css?build=8">',
        '<img src="https://assets.test/images/hero.png#preview">',
        '<img srcset="/images/hero.png 1x, /images/hero@2x.png 2x">',
        '<script src="/script.js"></script>',
        '<svg><use href="/sprite.svg#check"></use></svg>',
        '<div style="background:url(/images/hero.png)"></div>',
        '<img src="https://cdn.example/image.png">',
        '<img src="//cdn.example/image.png">',
        '<img src="data:image/png;base64,AA==">',
      ].join(''),
      htmlBaseDirectory: root,
    });

    expect(resolved.html).toMatch(/asset:\/\/\/[a-f0-9]{32}\.css\?build=8/u);
    expect(resolved.html).toMatch(/asset:\/\/\/[a-f0-9]{32}\.png#preview/u);
    expect(resolved.html).toMatch(/asset:\/\/\/[a-f0-9]{32}\.svg#check/u);
    expect(resolved.html).toContain('https://cdn.example/image.png');
    expect(resolved.html).toContain('//cdn.example/image.png');
    expect(resolved.html).toContain('data:image/png;base64,AA==');
    expect(resolved.assets).toHaveLength(7);

    const cssAssets = resolved.assets.filter(
      (asset) => asset.mimeType === 'text/css',
    );
    expect(cssAssets).toHaveLength(2);
    const css = cssAssets
      .map((asset) => Buffer.from(asset.contents).toString())
      .join('\n');
    expect(css).toMatch(/asset:\/\/\/[a-f0-9]{32}\.png\?v=2#main/u);
    expect(css).toMatch(/asset:\/\/\/[a-f0-9]{32}\.woff2\?v=1/u);

    const script = resolved.assets.find(
      (asset) => asset.filename === 'script.js',
    );
    const svg = resolved.assets.find(
      (asset) => asset.filename === 'sprite.svg',
    );
    expect(Buffer.from(script!.contents).toString()).toContain('fetch(');
    expect(Buffer.from(svg!.contents).toString()).toContain('inner.png');
  });

  it('does not read the filesystem without configured roots', async () => {
    const { root } = await fixture();
    const resolver = new AssetResolver();
    const source = `<img src="${join(root, 'images', 'hero.png')}">`;
    const resolved = await resolver.resolve({ html: source });

    expect(resolved.html).toBe(source);
    expect(resolved.assets).toEqual([]);
  });

  it('denies traversal, absolute files and symlink escapes', async () => {
    const { root, outside, resolver } = await fixture();
    const outsideFile = join(outside, 'private.txt');

    await expect(
      resolver.resolve({
        html: `<img src="${outsideFile}">`,
        htmlBaseDirectory: root,
      }),
    ).rejects.toBeInstanceOf(AssetAccessDeniedError);

    await expect(
      resolver.resolve({
        html: '<img src="../bladepdf-assets-outside-does-not-exist/private.txt">',
        htmlBaseDirectory: root,
      }),
    ).resolves.toBeDefined();

    if (process.platform !== 'win32') {
      const escapedLink = join(root, 'images', 'escaped.txt');
      await symlink(outsideFile, escapedLink);
      await expect(
        resolver.resolve({ html: '<img src="/images/escaped.txt">' }),
      ).rejects.toBeInstanceOf(AssetAccessDeniedError);
    }
  });

  it('allows explicit file/data assets outside roots and validates missing files', async () => {
    const { outside, resolver } = await fixture();
    const resolved = await resolver.resolve({
      html: '<img src="asset:///private.txt"><img src="asset:///memory.bin">',
      manualAssets: [
        {
          type: 'file',
          path: join(outside, 'private.txt'),
          options: { target: 'private.txt' },
        },
        {
          type: 'data',
          data: Buffer.from('memory'),
          options: {
            target: 'memory.bin',
            filename: 'memory.bin',
            mimeType: 'application/custom',
          },
        },
      ],
    });

    expect(resolved.assets).toHaveLength(2);
    expect(resolved.assets[0]).toMatchObject({
      fieldName: 'asset:///private.txt',
      mimeType: 'application/octet-stream',
    });
    expect(resolved.assets[1]).toMatchObject({
      fieldName: 'asset:///memory.bin',
      mimeType: 'application/custom',
    });

    await expect(
      resolver.resolve({
        html: 'x',
        manualAssets: [
          { type: 'file', path: join(outside, 'missing'), options: {} },
        ],
      }),
    ).rejects.toBeInstanceOf(AssetNotFoundError);
  });

  it('rewrites CSS supplied from memory and lets the later target win', async () => {
    const { root, resolver } = await fixture();
    const resolved = await resolver.resolve({
      html: '<link href="asset:///custom.css">',
      manualAssets: [
        {
          type: 'data',
          data: Buffer.from('.a{color:red}'),
          options: { target: 'custom.css', filename: 'first.css' },
        },
        {
          type: 'data',
          data: Buffer.from('.b{background:url(images/hero.png)}'),
          options: {
            target: 'custom.css',
            filename: 'replacement.css',
            baseDirectory: root,
          },
        },
      ],
    });

    const custom = resolved.assets.find(
      (asset) => asset.fieldName === 'asset:///custom.css',
    );
    expect(Buffer.from(custom!.contents).toString()).toMatch(
      /\.b\{background:url\(asset:\/\/\/[a-f0-9]{32}\.png\)\}/u,
    );
    expect(custom?.filename).toBe('replacement.css');
    expect(resolved.assets).toHaveLength(2);
  });
});
