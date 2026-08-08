// End-to-end coverage for the options page: does editing the template
// there actually persist, and does a content script pick it up?
//
// The options page is loaded directly by its chrome-extension:// URL.
// Clicking the toolbar action can't be driven from Playwright, so the
// background service worker's action.onClicked handler isn't exercised
// here — opening options.html directly is the same page it would open.

import { test, expect, DEFAULT_TEMPLATE } from '../fixtures/extension';

const PAGE = 'link_page.html';

test.describe('options page', () => {
  test('shows the default template when nothing is stored', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    void config; // resets storage first
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page.locator('#urlTemplate')).toHaveValue(DEFAULT_TEMPLATE);

    await page.close();
  });

  test('shows the stored template when one is set', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    await config.setTemplate('https://example.test/lookup?addr={email}');
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page.locator('#urlTemplate')).toHaveValue(
      'https://example.test/lookup?addr={email}',
    );

    await page.close();
  });

  test('saving writes the template to synced storage', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await page.locator('#urlTemplate').fill('https://example.test/s?q={email}');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#status')).toHaveText('Saved.');

    await expect
      .poll(() => config.getTemplate())
      .toBe('https://example.test/s?q={email}');

    await page.close();
  });

  test('pressing Enter in the input saves', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await page.locator('#urlTemplate').fill('https://example.test/s?q={email}');
    await page.locator('#urlTemplate').press('Enter');
    await expect(page.locator('#status')).toHaveText('Saved.');

    await expect
      .poll(() => config.getTemplate())
      .toBe('https://example.test/s?q={email}');

    await page.close();
  });

  test('trims surrounding whitespace before saving', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await page.locator('#urlTemplate').fill('  https://example.test/s?q={email}  ');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect
      .poll(() => config.getTemplate())
      .toBe('https://example.test/s?q={email}');
    await expect(page.locator('#urlTemplate')).toHaveValue(
      'https://example.test/s?q={email}',
    );

    await page.close();
  });

  test.describe('rejects templates that would break the rewriter', () => {
    // Each of these is stopped at the options page rather than saved:
    // empty blanks out every href, mailto: sends the content script into
    // an infinite rewrite loop, and javascript: would inject executable
    // hrefs into every page the user visits.
    for (const [label, template] of [
      ['an empty template', ''],
      ['a whitespace-only template', '   '],
      ['a mailto: template', 'mailto:{email}'],
      ['a javascript: template', 'javascript:alert(1)'],
      ['a bare domain with no scheme', 'example.test/s?q={email}'],
    ] as const) {
      test(label, async ({ extensionContext, extensionId, config }) => {
        await config.setTemplate('https://example.test/lookup?addr={email}');
        const page = await extensionContext.newPage();
        await page.goto(`chrome-extension://${extensionId}/options.html`);
        await expect(page.locator('#urlTemplate')).toHaveValue(
          'https://example.test/lookup?addr={email}',
        );

        await page.locator('#urlTemplate').fill(template);
        await page.getByRole('button', { name: 'Save' }).click();

        await expect(page.locator('#status')).toHaveText(
          'Enter a URL starting with http:// or https://',
        );
        await expect(page.locator('#status')).toHaveClass(/error/);
        // The previously stored template survives untouched.
        expect(await config.getTemplate()).toBe(
          'https://example.test/lookup?addr={email}',
        );

        await page.close();
      });
    }
  });

  test('the status message clears itself after a moment', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#status')).toHaveText('Saved.');
    // flashStatus() clears after 1.5s; the default expect timeout covers it.
    await expect(page.locator('#status')).toHaveText('');

    await page.close();
  });

  test('"Reset to default" restores the default template', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    await config.setTemplate('https://example.test/lookup?addr={email}');
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(page.locator('#urlTemplate')).toHaveValue(
      'https://example.test/lookup?addr={email}',
    );

    await page.getByRole('button', { name: 'Reset to default' }).click();

    await expect(page.locator('#urlTemplate')).toHaveValue(DEFAULT_TEMPLATE);
    await expect.poll(() => config.getTemplate()).toBe(DEFAULT_TEMPLATE);

    await page.close();
  });

  test('a template saved here takes effect on an open page', async ({
    extensionContext,
    extensionId,
    fixtureServer,
    config,
  }) => {
    void config;
    // This is the full user-visible loop: open a page with mailto links,
    // change the template in the options UI, and watch the already-open
    // page update without a reload.
    const linkPage = await extensionContext.newPage();
    await linkPage.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    await expect(
      linkPage.getByRole('link', { name: 'alice@example.com' }),
    ).toHaveAttribute('href', 'https://www.google.com/search?q=alice%40example.com');

    const optionsPage = await extensionContext.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await optionsPage
      .locator('#urlTemplate')
      .fill('https://example.test/lookup?addr={email}');
    await optionsPage.getByRole('button', { name: 'Save' }).click();
    await expect(optionsPage.locator('#status')).toHaveText('Saved.');

    await expect(
      linkPage.getByRole('link', { name: 'alice@example.com' }),
    ).toHaveAttribute('href', 'https://example.test/lookup?addr=alice%40example.com');

    await optionsPage.close();
    await linkPage.close();
  });
});
