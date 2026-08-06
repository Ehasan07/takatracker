/**
 * Renders the PWA icons from one SVG source using the Chromium that Playwright
 * already installs for the e2e suite — no extra image dependency in the tree.
 *
 *   node scripts/generate-icons.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/icons');

const icon = (size, maskable) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${maskable ? 0 : 96}" fill="#1F6F4A"/>
  <rect x="${maskable ? 76 : 44}" y="${maskable ? 76 : 44}" width="${maskable ? 360 : 424}" height="${maskable ? 360 : 424}" rx="${maskable ? 40 : 64}" fill="#FAFBF7"/>
  <text x="256" y="${maskable ? 330 : 348}" text-anchor="middle"
        font-family="Noto Sans Bengali, Hind Siliguri, sans-serif"
        font-size="${maskable ? 220 : 264}" font-weight="700" fill="#17251E">৳</text>
  <rect x="${maskable ? 150 : 120}" y="${maskable ? 356 : 384}" width="${maskable ? 212 : 272}" height="14" rx="7" fill="#8E6C18"/>
</svg>`;

const targets = [
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'maskable-512.png', size: 512, maskable: true },
];

const browser = await chromium.launch();
try {
  await mkdir(outDir, { recursive: true });
  for (const target of targets) {
    const page = await browser.newPage({
      viewport: { width: target.size, height: target.size },
      deviceScaleFactor: 1,
    });
    await page.setContent(`<body style="margin:0">${icon(target.size, target.maskable)}</body>`, {
      waitUntil: 'load',
    });
    const buffer = await page.screenshot({ omitBackground: true });
    await writeFile(resolve(outDir, target.name), buffer);
    await page.close();
    console.log(`wrote ${target.name} (${target.size}px)`);
  }

  // Favicon: reuse the 192 render at 32px.
  const page = await browser.newPage({ viewport: { width: 32, height: 32 } });
  await page.setContent(`<body style="margin:0">${icon(32, false)}</body>`, { waitUntil: 'load' });
  await writeFile(resolve(here, '../public/favicon.png'), await page.screenshot());
  await page.close();
  console.log('wrote favicon.png');
} finally {
  await browser.close();
}
