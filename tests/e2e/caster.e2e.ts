import { expect, test, type Page } from '@playwright/test';
import {
  HARBOR_TITLE,
  MOONRISE_MEDIA_ID,
  MOONRISE_TITLE,
  SEEDED_LIBRARY_ID,
  getE2ERuntimePaths
} from './constants';

const SETTINGS_LIBRARY_NAME = 'E2E Settings Library';

async function openCaster(page: Page) {
  await page.goto('/');
  await expect(page.getByTitle('Server Settings')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Movies', exact: true })).toBeVisible();
}

async function fetchFromPage(
  page: Page,
  request: { path: string; method?: string; body?: unknown }
) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const responseBody = await response.text();
    return { status: response.status, body: responseBody };
  }, request);
}

test('changes a library setting without account setup', async ({ page }) => {
  await openCaster(page);

  const emptyLibraryDirectory = getE2ERuntimePaths().emptyLibraryDir;
  const mutation = await fetchFromPage(page, {
    path: '/api/libraries',
    method: 'POST',
    body: {
      name: 'Must Not Be Created',
      path: emptyLibraryDirectory,
      type: 'movies'
    }
  });
  expect(mutation.status).not.toBe(401);
  await page.getByTitle('Server Settings').click();
  await expect(
    page.getByRole('heading', { name: 'Server Settings & Configuration' })
  ).toBeVisible();

  const existingLibraries = await fetchFromPage(page, { path: '/api/libraries' });
  expect(existingLibraries.status).toBe(200);
  const parsedLibraries = JSON.parse(existingLibraries.body) as {
    libraries: Array<{ id: string; name: string }>;
  };
  for (const library of parsedLibraries.libraries) {
    if (library.name === SETTINGS_LIBRARY_NAME && library.id !== SEEDED_LIBRARY_ID) {
      await fetchFromPage(page, {
        path: `/api/libraries/${library.id}`,
        method: 'DELETE'
      });
    }
  }

  await page.getByPlaceholder('e.g. Movies 4K').fill(SETTINGS_LIBRARY_NAME);
  await page.getByPlaceholder(/media\/movies/).fill(emptyLibraryDirectory);
  await page.getByTestId('settings-dialog').getByRole('combobox').selectOption('home_videos');

  const createResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/libraries') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Add Library' }).click();
  expect((await createResponse).status()).toBe(200);
  await expect(page.getByText(SETTINGS_LIBRARY_NAME, { exact: true })).toBeVisible();

  const librariesAfterCreate = await fetchFromPage(page, { path: '/api/libraries' });
  const createdLibrary = (
    JSON.parse(librariesAfterCreate.body) as {
      libraries: Array<{ id: string; name: string }>;
    }
  ).libraries.find((library) => library.name === SETTINGS_LIBRARY_NAME);
  expect(createdLibrary).toBeTruthy();

  if (createdLibrary) {
    const cleanup = await fetchFromPage(page, {
      path: `/api/libraries/${createdLibrary.id}`,
      method: 'DELETE'
    });
    expect(cleanup.status).toBe(200);
  }
});

test('browses the movie library and combines resolution and title filters', async ({ page }) => {
  await openCaster(page);

  const movieResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/media' && url.searchParams.get('type') === 'movie';
  });
  await page.getByRole('button', { name: 'Movies', exact: true }).click();
  expect((await movieResponse).status()).toBe(200);

  await expect(page.getByRole('heading', { name: MOONRISE_TITLE, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: HARBOR_TITLE, exact: true })).toBeVisible();
  await expect(page.getByText('Showing 2 of 2 items', { exact: true })).toBeVisible();

  const resolutionResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/media' && url.searchParams.get('resolution') === '1080p';
  });
  await page.getByRole('button', { name: '1080p', exact: true }).click();
  expect((await resolutionResponse).status()).toBe(200);
  await expect(page.getByRole('heading', { name: MOONRISE_TITLE, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: HARBOR_TITLE, exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Any', exact: true }).click();
  const searchResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/media' && url.searchParams.get('search') === 'Harbor';
  });
  await page.getByPlaceholder('Search titles, series...').fill('Harbor');
  expect((await searchResponse).status()).toBe(200);

  await expect(page.getByRole('heading', { name: HARBOR_TITLE, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: MOONRISE_TITLE, exact: true })).toHaveCount(0);
  await expect(page.getByText('Showing 1 of 1 item', { exact: true })).toBeVisible();
});

test('opens playback and restores persisted resume progress', async ({ page }) => {
  await openCaster(page);

  const resetProgress = await fetchFromPage(page, {
    path: `/api/media/${MOONRISE_MEDIA_ID}/progress`,
    method: 'DELETE'
  });
  expect(resetProgress.status).toBe(200);

  const initialSearchResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/media' && url.searchParams.get('search') === 'Moonrise';
  });
  await page.getByPlaceholder('Search titles, series...').fill('Moonrise');
  expect((await initialSearchResponse).status()).toBe(200);
  await expect(page.getByRole('heading', { name: MOONRISE_TITLE, exact: true })).toBeVisible();
  await page.getByRole('heading', { name: MOONRISE_TITLE, exact: true }).click();
  const detailPlayButton = page.getByRole('button').filter({ hasText: /^Play Now$/ });
  await expect(detailPlayButton).toBeVisible();

  const streamResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/media/${MOONRISE_MEDIA_ID}/stream` &&
      url.searchParams.has('cast');
  });
  await detailPlayButton.click();
  expect([200, 206]).toContain((await streamResponse).status());
  await expect(page.getByTitle('Back to library')).toBeVisible();
  await expect(
    page.getByText('Converting because this video is higher resolution than your device supports.', {
      exact: true
    })
  ).toBeVisible();
  await page.getByTitle('Back to library').click();

  const savedProgress = await fetchFromPage(page, {
    path: `/api/media/${MOONRISE_MEDIA_ID}/progress`,
    method: 'POST',
    body: { position: 42, duration: 120 }
  });
  expect(savedProgress.status).toBe(200);

  await page.reload();
  const resumedSearchResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/media' && url.searchParams.get('search') === 'Moonrise';
  });
  await page.getByPlaceholder('Search titles, series...').fill('Moonrise');
  expect((await resumedSearchResponse).status()).toBe(200);
  await expect(page.getByRole('heading', { name: MOONRISE_TITLE, exact: true })).toBeVisible();
  await page.getByRole('heading', { name: MOONRISE_TITLE, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume at 0m 42s' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play from Beginning' })).toBeVisible();
});

