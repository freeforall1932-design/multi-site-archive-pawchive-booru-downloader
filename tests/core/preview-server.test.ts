import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function request(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path: pathname }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

describe('offline preview server exposure', () => {
  it('serves only the harness, built extension and mock media; blocks traversal and symlinks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bsm-preview-'));
    await mkdir(path.join(root, 'dev/preview'), { recursive: true });
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, 'dev/preview/index.html'), 'preview');
    await writeFile(path.join(root, 'dev/preview/harness.js'), 'harness');
    await writeFile(path.join(root, 'dist/manifest.json'), '{}');
    await writeFile(path.join(root, '.git/config'), 'private-git-config');
    await writeFile(path.join(root, 'package.json'), 'private-package');
    if (process.platform !== 'win32') await symlink(path.join(root, 'package.json'), path.join(root, 'dist/leak.txt'));
    const script = path.resolve('scripts/preview-server.mjs');
    const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Preview server did not start')), 4000);
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          const match = /0\.0\.0\.0:(\d+)\//.exec(output);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Preview exited early: ${code}`)); });
      });
      expect(await request(port, '/')).toMatchObject({ status: 200, body: 'preview' });
      expect(await request(port, '/dev/preview/harness.js')).toMatchObject({ status: 200, body: 'harness' });
      expect((await request(port, '/dist/manifest.json')).status).toBe(200);
      expect((await request(port, '/mock/media/1.jpg')).status).toBe(200);
      expect((await request(port, '/.git/config')).status).toBe(404);
      expect((await request(port, '/package.json')).status).toBe(404);
      expect((await request(port, '/dist/%2e%2e%2f.git%2fconfig')).status).toBe(404);
      if (process.platform !== 'win32') expect((await request(port, '/dist/leak.txt')).status).toBe(403);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill();
        await stopped;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
