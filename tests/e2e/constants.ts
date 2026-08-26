import path from 'node:path';

export const E2E_PORT = 43_142;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
export const SEEDED_LIBRARY_ID = 'lib_e2e_seeded';
export const SEEDED_LIBRARY_NAME = 'E2E Seeded Media';
export const MOONRISE_MEDIA_ID = 'media_e2e_moonrise';
export const MOONRISE_TITLE = 'Moonrise Test Feature';
export const HARBOR_MEDIA_ID = 'media_e2e_harbor';
export const HARBOR_TITLE = 'Harbor Test Feature';

export function getE2ERuntimePaths(workspaceRoot = process.cwd()) {
  const playwrightRoot = path.resolve(workspaceRoot, 'test-results', 'playwright');
  const runtimeRoot = path.resolve(
    process.env.CASTER_E2E_RUNTIME_DIR || path.join(playwrightRoot, 'runtime')
  );

  return {
    playwrightRoot,
    runtimeRoot,
    dataDir: path.join(runtimeRoot, 'data'),
    mediaDir: path.join(runtimeRoot, 'media'),
    emptyLibraryDir: path.join(runtimeRoot, 'empty-library'),
    thumbnailsDir: path.join(runtimeRoot, 'thumbnails'),
    transcodeCacheDir: path.join(runtimeRoot, 'transcode-cache')
  };
}
