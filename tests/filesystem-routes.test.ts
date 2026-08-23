import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { apiRouter } from '../apps/server/src/routes/api';

describe('Filesystem API routes', () => {
  let fixtureRoot: string;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-fs-routes-'));
    fs.mkdirSync(path.join(fixtureRoot, 'Movies'));
    fs.mkdirSync(path.join(fixtureRoot, 'Empty'));
    fs.mkdirSync(path.join(fixtureRoot, '.hidden'));
    fs.mkdirSync(path.join(fixtureRoot, 'node_modules'));
    fs.writeFileSync(path.join(fixtureRoot, 'Movies', 'Example.Movie.2026.mkv'), 'fixture');
    fs.writeFileSync(path.join(fixtureRoot, 'readme.txt'), 'fixture');
  });

  afterAll(() => {
    const expectedPrefix = path.join(os.tmpdir(), 'caster-fs-routes-');
    if (fixtureRoot.startsWith(expectedPrefix)) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('lists accessible child folders and marks folders containing media', async () => {
    const response = await apiRouter.request(
      `/fs/browse?path=${encodeURIComponent(fixtureRoot)}`
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.current).toBe(path.resolve(fixtureRoot));
    expect(body.parent).toBe(path.dirname(path.resolve(fixtureRoot)));
    expect(body.entries).toEqual([
      {
        name: 'Empty',
        path: path.join(path.resolve(fixtureRoot), 'Empty'),
        hasMedia: false
      },
      {
        name: 'Movies',
        path: path.join(path.resolve(fixtureRoot), 'Movies'),
        hasMedia: true
      }
    ]);
  });

  it('returns a safe 404 response for missing paths and files', async () => {
    const missingResponse = await apiRouter.request(
      `/fs/browse?path=${encodeURIComponent(path.join(fixtureRoot, 'missing'))}`
    );
    const fileResponse = await apiRouter.request(
      `/fs/browse?path=${encodeURIComponent(path.join(fixtureRoot, 'readme.txt'))}`
    );

    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({ error: 'Path not found or not accessible' });
    expect(fileResponse.status).toBe(404);
  });

  it('registers both filesystem endpoints', () => {
    expect(apiRouter.routes.some((route) => route.method === 'GET' && route.path === '/fs/browse')).toBe(true);
    expect(apiRouter.routes.some((route) => route.method === 'GET' && route.path === '/fs/suggest')).toBe(true);
  });
});
