import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The dashboard is served through a Cloudflare tunnel, which by default caches
 * `.js`/`.css` for hours but revalidates HTML on every request. That split is
 * actively dangerous: after a deploy the browser gets the NEW markup and the
 * OLD script, so newly added fields render but nothing is wired to them — they
 * look permanently broken rather than merely stale.
 *
 * Stamping a content hash into the asset URLs makes the cache key change
 * whenever the file changes, so markup and script can never disagree.
 */
const VERSIONED_ASSETS = ['/app.js', '/styles.css'];

export function assetUrlPattern(asset) {
  return new RegExp(`(["'])${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g');
}

export function stampAssetUrls(html, version) {
  let out = html;
  for (const asset of VERSIONED_ASSETS) {
    out = out.replace(assetUrlPattern(asset), `"${asset}?v=${version}"`);
  }
  return out;
}

export function hashContents(buffers) {
  const hash = crypto.createHash('sha1');
  for (const buffer of buffers) hash.update(buffer);
  return hash.digest('hex').slice(0, 12);
}

/**
 * Rebuilds only when an asset actually changes on disk, so a long-running
 * process picks up a deploy without paying a hash on every page load.
 */
export function createIndexHtmlBuilder(publicDir) {
  const indexPath = path.join(publicDir, 'index.html');
  const assetPaths = VERSIONED_ASSETS.map((asset) => path.join(publicDir, asset.replace(/^\//, '')));
  let cache = null;

  async function fingerprint() {
    const stats = await Promise.all(
      [indexPath, ...assetPaths].map((file) => fs.stat(file).then((s) => `${s.mtimeMs}:${s.size}`, () => 'missing')),
    );
    return stats.join('|');
  }

  return async function buildIndexHtml() {
    const current = await fingerprint();
    if (cache && cache.fingerprint === current) return cache.html;

    const html = await fs.readFile(indexPath, 'utf8');
    const contents = await Promise.all(
      assetPaths.map((file) => fs.readFile(file).catch(() => Buffer.alloc(0))),
    );
    const stamped = stampAssetUrls(html, hashContents(contents));
    cache = { fingerprint: current, html: stamped };
    return stamped;
  };
}
