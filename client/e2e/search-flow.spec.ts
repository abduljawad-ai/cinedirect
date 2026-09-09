import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Deterministic end-to-end coverage of the search → results → detail flow.
 *
 * All remote APIs are intercepted with fixtures so the suite runs offline:
 * the WordPress posts API answers with two "Silo S01E01" posts whose links
 * are already-direct r2.dev URLs (so no hub resolution network calls occur).
 */

const SAMPLE_POSTS = [
  {
    id: 1,
    title: { rendered: 'Silo S01E01 1080p WEB-DL HDHub4u' },
    link: 'https://hblinks.co/silo-s01e01-1080p/',
    date: '2026-01-01T00:00:00',
    content: {
      rendered:
        '<p><strong>Silo</strong> S01E01 1080p WEB-DL Dual Audio [Hindi + English] ESub<br/>' +
        '<a href="https://pub-abc123.r2.dev/silo-s01e01-1080p.mkv">Silo S01E01 1080p Download</a></p>',
    },
  },
  {
    id: 2,
    title: { rendered: 'Silo S01E01 720p WEB-DL HDHub4u' },
    link: 'https://hblinks.co/silo-s01e01-720p/',
    date: '2026-01-01T00:00:01',
    content: {
      rendered:
        '<p>720p <a href="https://pub-abc123.r2.dev/silo-s01e01-720p.mkv">Silo S01E01 720p Download</a></p>',
    },
  },
];

async function stubRemoteApis(page: Page): Promise<void> {
  // A static host (like vite preview) serves index.html for /api/health with
  // 200, which the mode probe would misread as "local server". Force 404 so
  // the app settles into the deterministic "static" mode.
  await page.route('**/api/health', async (route: Route) => {
    await route.fulfill({ status: 404, body: 'not found' });
  });
  await page.route('**/wp-json/wp/v2/posts**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SAMPLE_POSTS),
    });
  });
  await page.route('**://api.tvmaze.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });
  });
  await page.route('**://en.wikipedia.org/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"query":{"search":[],"pages":[]}}',
    });
  });
}

test.beforeEach(async ({ page }) => {
  await stubRemoteApis(page);
});

test('autostart search renders result cards', async ({ page }) => {
  await page.goto('/');

  const searchInput = page.getByRole('searchbox', {
    name: 'Search movies and TV shows',
  });
  await expect(searchInput).toBeVisible();

  // The app auto-searches ("popular") on boot when no query is given.
  const card = page.locator('article').filter({ hasText: 'Silo' }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText('1080P')).toBeVisible();
});

test('search → details → back flow', async ({ page }) => {
  await page.goto('/');

  const searchInput = page.getByRole('searchbox', {
    name: 'Search movies and TV shows',
  });
  await expect(searchInput).toBeVisible();
  await searchInput.fill('Silo');
  await searchInput.press('Enter');

  const openLink = page.getByTestId('card-link').first();
  await expect(openLink).toBeVisible({ timeout: 15_000 });
  await openLink.click();

  await expect(page).toHaveURL(/#\/detail\//);

  const section = page.getByRole('region', { name: /Download options/ });
  await expect(section).toBeVisible();

  const rows = page.getByTestId('quality-link');
  await expect(rows).toHaveCount(2, { timeout: 15_000 });

  const first = rows.first();
  await expect(first).toContainText('Get link');
  await expect(first).toHaveAttribute('href', /r2\.dev/);
  await expect(first).toHaveAttribute('rel', 'noopener noreferrer');

  // The 1080p row sorts above the 720p row.
  const labels = page.getByTestId('quality-label');
  await expect(labels.first()).toHaveText('1080P');

  await page.getByTestId('back-button').click();
  await expect(page).toHaveURL(/#\/?$/);
  await expect(page.locator('article').first()).toBeVisible();
});

test('opens a shareable deep link on hard reload', async ({ page }) => {
  await page.goto('/');

  const card = page.locator('article').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  const href = await card.locator('a[href^="#/detail/"]').first().getAttribute('href');
  expect(href).toMatch(/^#\/detail\//);

  // Hard reload straight into the detail route (href already starts with "#").
  const base = page.url().split('#')[0];
  await page.goto(base + href);
  await page.reload();

  const section = page.getByRole('region', { name: /Download options/ });
  await expect(section).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('quality-link').first()).toBeVisible({
    timeout: 15_000,
  });
});

test('detail opens instantly — no blocking spinner, rows stream in', async ({
  page,
}) => {
  await page.goto('/');

  // The top card edition is pre-resolved by the background prefetch
  // (r2.dev fixtures need no upstream calls).
  const openLink = page.getByTestId('card-link').first();
  await expect(openLink).toBeVisible({ timeout: 15_000 });
  await openLink.click();

  // The Download section renders immediately instead of gating the whole
  // view behind the old full-screen "Loading release details…" spinner.
  const section = page.getByRole('region', { name: /Download options/ });
  await expect(section).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText('Loading release details…')).toHaveCount(0);

  // Pre-resolved rows are already there (or stream in within the wait).
  await expect(page.getByTestId('quality-link')).toHaveCount(2, {
    timeout: 10_000,
  });
  await expect(page.getByText('Resolving download links…')).toHaveCount(0);
});