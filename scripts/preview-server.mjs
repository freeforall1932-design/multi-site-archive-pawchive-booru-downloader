/**
 * Static preview server: serves the built UI (dist/) plus the harness page and
 * mock media, so the whole extension UI can be exercised in a normal browser tab
 * without loading an unpacked extension.
 *
 * Usage: npm run preview   (builds first, then serves on 0.0.0.0:4173)
 */
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const port = Number(process.env.PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.map': 'application/json; charset=utf-8',
};

/** SVG placeholder used for every mock post's preview and file URL. */
function mockMedia(id, ext) {
  const hue = (id * 37) % 360;
  const hue2 = (hue + 48) % 360;
  const label = `#${id}`;
  const shapes = Array.from({ length: 5 }, (_value, index) => {
    const cx = 120 + ((id * (index + 3)) % 640);
    const cy = 90 + ((id * (index + 5) * 7) % 420);
    const r = 40 + ((id + index * 29) % 120);
    const opacity = 0.12 + (index % 3) * 0.07;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${(hue2 + index * 24) % 360} 80% 62%)" opacity="${opacity.toFixed(2)}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600" role="img" aria-label="mock booru post ${label}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="hsl(${hue} 70% 22%)"/>
    <stop offset="100%" stop-color="hsl(${hue2} 75% 42%)"/>
  </linearGradient></defs>
  <rect width="800" height="600" fill="url(#g)"/>
  ${shapes}
  <g fill="#ffffff" opacity="0.92" font-family="system-ui, sans-serif">
    <text x="48" y="520" font-size="64" font-weight="700">${label}</text>
    <text x="48" y="560" font-size="26" opacity="0.85">mock ${ext} asset · preview harness</text>
  </g>
</svg>`;
}

async function sendFile(res, file, status = 200) {
  const extension = path.extname(file).toLowerCase();
  const body = await readFile(file);
  res.writeHead(status, {
    'content-type': MIME[extension] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    let pathname = decodeURIComponent(url.pathname);

    // Mock media for the preview dataset (SVG, so nothing binary is needed).
    if (pathname.startsWith('/mock/media/')) {
      const match = /^\/mock\/media\/(\d+)\.(png|jpg)$/.exec(pathname);
      if (!match) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = mockMedia(Number(match[1]), match[2]);
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }

    if (pathname === '/' || pathname === '/preview' || pathname === '/preview/') {
      pathname = '/dev/preview/index.html';
    }

    // Only the compiled extension and the harness are public. In particular,
    // never serve source files, Git metadata or sibling directories. Normalize
    // first so encoded traversal cannot pass the prefix check.
    pathname = path.posix.normalize(pathname);
    const area = pathname.startsWith('/dist/') ? 'dist'
      : pathname.startsWith('/dev/preview/') ? 'dev/preview' : null;
    if (!area) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const allowedRoot = path.join(root, area);
    const candidate = path.join(root, pathname.replace(/^\/+/, ''));
    const info = await stat(candidate).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    // realpath also blocks symlinks inside an allowed directory that point out.
    const [realRoot, realCandidate] = await Promise.all([realpath(allowedRoot), realpath(candidate)]);
    const relative = path.relative(realRoot, realCandidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
      return;
    }
    await sendFile(res, realCandidate);
  } catch (error) {
    const status = error instanceof URIError ? 400 : 500;
    res.writeHead(status, { 'content-type': 'text/plain' }).end(status === 400 ? 'bad request' : 'preview server error');
  }
});

server.listen(port, '0.0.0.0', () => {
  const address = server.address();
  const listeningPort = address && typeof address !== 'string' ? address.port : port;
  console.log(`Preview harness:  http://0.0.0.0:${listeningPort}/  (options page: /dist/options/options.html)`);
  console.log('Mock booru API + mock media are served by the in-page mock fetch, no real network calls happen.');
});
