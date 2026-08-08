// End-to-end coverage for the chooser dialog: what happens when a
// clicked `mailto:` link has no target configured to be followed
// automatically.
//
// The dialog lives in an open shadow root, which Playwright locators
// pierce, so it can be addressed with ordinary role/text selectors.

import { test, expect } from '../fixtures/extension';
import type { Page } from '@playwright/test';

const PAGE = 'link_page.html';
const HOST = '#fix-mailto-links-dialog';

function dialog(page: Page) {
  return page.locator(HOST);
}

test.describe('chooser dialog', () => {
  test('opens instead of the email app when no target is automatic', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTargets([
      {
        emailDomain: '',
        urlTemplate: 'https://example.test/any?q={email}',
        openDirectly: false,
      },
    ]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    // The href is left exactly as the page wrote it — cancelling the
    // click, not changing the link, is what stops the email app.
    await expect(
      page.getByRole('link', { name: 'alice@example.com' }),
    ).toHaveAttribute('href', 'mailto:alice@example.com');
    await page.getByRole('link', { name: 'alice@example.com' }).click();

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator('.address')).toHaveText(
      'mailto:alice@example.com',
    );
    // Titled with the extension name, from the manifest.
    await expect(
      dialog(page).getByRole('heading', { name: 'Fix Mailto Links' }),
    ).toBeVisible();
    // Still on the same page: nothing navigated.
    expect(page.url()).toContain(PAGE);

    await page.close();
  });

  test('lists only the targets that match, in configured order', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTargets([
      {
        emailDomain: 'example.org',
        urlTemplate: 'https://example.test/org?u={username}',
        openDirectly: false,
      },
      {
        emailDomain: '',
        urlTemplate: 'https://example.test/any?q={email}',
        openDirectly: false,
      },
      {
        emailDomain: 'example.com',
        urlTemplate: 'https://example.test/com?u={username}',
        openDirectly: false,
      },
    ]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await page.getByRole('link', { name: 'alice@example.com' }).click();

    const links = dialog(page).locator('li a');
    // Two matches plus the original mailto: as the last bullet.
    await expect(links).toHaveCount(3);
    await expect(links.nth(0)).toHaveAttribute(
      'href',
      'https://example.test/any?q=alice@example.com',
    );
    await expect(links.nth(1)).toHaveAttribute(
      'href',
      'https://example.test/com?u=alice',
    );
    await expect(links.nth(2)).toHaveAttribute(
      'href',
      'mailto:alice@example.com',
    );
    // Targets are labelled by site, not by their whole URL.
    await expect(links.nth(0)).toHaveText('example.test');
    await expect(links.nth(2)).toHaveText('mailto:alice@example.com');

    await page.close();
  });

  test('says so when nothing matches at all', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTargets([]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await page.getByRole('link', { name: 'alice@example.com' }).click();

    await expect(
      dialog(page).getByText('No link targets match this address.'),
    ).toBeVisible();

    await page.close();
  });

  test('clicking a listed target navigates there', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTargets([
      {
        emailDomain: '',
        urlTemplate: `${fixtureServer.baseUrl}/landing.html?to={email}`,
        openDirectly: false,
      },
    ]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await page.getByRole('link', { name: 'alice@example.com' }).click();
    // No new tab on a live page: the link navigates where it is.
    await expect(dialog(page).locator('li a').first()).not.toHaveAttribute(
      'target',
      '_blank',
    );
    await dialog(page).locator('li a').first().click();

    await page.waitForURL(/landing\.html/);
    await expect(page.locator('#target')).toHaveText('landing page');
    expect(new URL(page.url()).searchParams.get('to')).toBe('alice@example.com');

    await page.close();
  });

  test('offers the original mailto: link, parameters and all', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTargets([]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await page.getByRole('link', { name: 'Dave (with subject/body)' }).click();
    // The bullet is only asserted on, never clicked: following it would
    // hand off to the OS email handler.
    await expect(dialog(page).locator('li a').last()).toHaveAttribute(
      'href',
      'mailto:dave@example.com?subject=Hello&body=Hi%20Dave',
    );

    await page.close();
  });

  test('shows a percent-encoded address decoded, but links it raw', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTargets([]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await page.getByRole('link', { name: '"Eve Smith" <eve@example.com>' }).click();
    const readable = 'mailto:"Eve Smith" <eve@example.com>';
    const raw = 'mailto:%22Eve%20Smith%22%20%3Ceve@example.com%3E';

    // Both places that show the link are for reading, so both decode...
    await expect(dialog(page).locator('.address')).toHaveText(readable);
    const bullet = dialog(page).locator('li a').last();
    await expect(bullet).toHaveText(readable);
    // ...but the href keeps the page's own bytes, so the hand-off to the
    // email app is byte-for-byte what the page asked for.
    await expect(bullet).toHaveAttribute('href', raw);

    await page.close();
  });

  test('copies the username and the address', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTargets([]);
    await extensionContext.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: fixtureServer.baseUrl,
    });
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await page.getByRole('link', { name: 'alice@example.com' }).click();

    await dialog(page).getByRole('button', { name: 'Copy username' }).click();
    await expect(dialog(page).getByText('Copied')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('alice');

    await dialog(page).getByRole('button', { name: 'Copy email address' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'alice@example.com',
    );

    await page.close();
  });

  test('Cancel and Escape both close it', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTargets([]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await page.getByRole('link', { name: 'alice@example.com' }).click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);

    await page.getByRole('link', { name: 'alice@example.com' }).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);

    await page.close();
  });

  test('"Configure link targets" opens the options page in a tab', async ({
    extensionContext,
    extensionId,
    fixtureServer,
    config,
  }) => {
    await config.setTargets([]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await page.getByRole('link', { name: 'alice@example.com' }).click();
    const opened = extensionContext.waitForEvent('page');
    await dialog(page)
      .getByRole('button', { name: 'Configure link targets' })
      .click();

    const optionsPage = await opened;
    await expect
      .poll(() => optionsPage.url())
      .toBe(`chrome-extension://${extensionId}/options.html`);

    await optionsPage.close();
    await page.close();
  });

  test('does not open when a target is followed automatically', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTargets([
      {
        emailDomain: '',
        urlTemplate: `${fixtureServer.baseUrl}/landing.html?to={email}`,
        openDirectly: true,
      },
    ]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    await page.getByRole('link', { name: 'alice@example.com' }).click();

    await page.waitForURL(/landing\.html/);
    expect(await page.locator(HOST).count()).toBe(0);

    await page.close();
  });

  test('leaves ordinary links alone', async ({
    extensionContext,
    fixtureServer,
    config,
  }) => {
    await config.setTargets([]);
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/${PAGE}`);

    // Positive control first: prove the click handler is installed.
    await page.getByRole('link', { name: 'alice@example.com' }).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');

    // Repointed at the local fixture so the click doesn't need the real
    // network to prove it navigated.
    await page.evaluate((url) => {
      const a = document.querySelector<HTMLAnchorElement>(
        'a[href="https://example.com/contact"]',
      );
      a!.setAttribute('href', url);
    }, `${fixtureServer.baseUrl}/landing.html`);

    await page.getByRole('link', { name: 'regular https link' }).click();
    await page.waitForURL(/landing\.html/);
    expect(await page.locator(HOST).count()).toBe(0);

    await page.close();
  });
});
