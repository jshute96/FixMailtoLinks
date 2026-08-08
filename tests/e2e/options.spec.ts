// End-to-end coverage for the options page: editing the list of link
// targets, persisting it, and the live "Test it" link.
//
// The options page is loaded directly by its chrome-extension:// URL.
// Clicking the toolbar action can't be driven from Playwright, so the
// background service worker's action.onClicked handler isn't exercised
// here — opening options.html directly is the same page it would open.

import { test, expect, DEFAULT_TEMPLATE, type TestTarget } from '../fixtures/extension';
import type { Page } from '@playwright/test';

const PAGE = 'link_page.html';
const DIALOG = '#fix-mailto-links-dialog';

function rows(page: Page) {
  return page.locator('#targets > .grid');
}

function row(page: Page, index: number) {
  return rows(page).nth(index);
}

async function openOptions(page: Page, extensionId: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  // init() renders the rows only after an awaited storage read, and an
  // empty target list is legitimate — so wait for the flag it sets when
  // it's done rather than for any particular row to appear.
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
}

async function fillRow(
  page: Page,
  index: number,
  target: TestTarget,
): Promise<void> {
  await row(page, index).locator('.domain').fill(target.emailDomain);
  await row(page, index).locator('.template').fill(target.urlTemplate);
  await row(page, index)
    .locator('.auto input')
    .setChecked(target.openDirectly);
}

test.describe('options page', () => {
  test('shows the default target when nothing is stored', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    void config; // resets storage first
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, 0).locator('.domain')).toHaveValue('');
    await expect(row(page, 0).locator('.template')).toHaveValue(DEFAULT_TEMPLATE);
    // Off by default: a fresh install asks rather than redirecting the
    // first mailto: link someone clicks. The checkbox is labelled by its
    // column heading, "Open directly".
    await expect(row(page, 0).getByLabel('Open directly')).not.toBeChecked();
    // A lone row can move neither way.
    await expect(
      row(page, 0).getByRole('button', { name: 'Move up' }),
    ).toBeDisabled();
    await expect(
      row(page, 0).getByRole('button', { name: 'Move down' }),
    ).toBeDisabled();

    await page.close();
  });

  test('shows the stored targets in order', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    await config.setTargets([
      {
        emailDomain: 'abc.com',
        urlTemplate: 'https://people.abc.com/{username}',
        openDirectly: true,
      },
      {
        emailDomain: '',
        urlTemplate: 'https://example.test/s?q={email}',
        openDirectly: false,
      },
    ]);
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    await expect(rows(page)).toHaveCount(2);
    await expect(row(page, 0).locator('.domain')).toHaveValue('abc.com');
    await expect(row(page, 0).locator('.auto input')).toBeChecked();
    await expect(row(page, 1).locator('.template')).toHaveValue(
      'https://example.test/s?q={email}',
    );
    await expect(row(page, 1).locator('.auto input')).not.toBeChecked();

    await page.close();
  });

  test('saving writes every row to synced storage', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    await fillRow(page, 0, {
      emailDomain: 'ABC.com',
      urlTemplate: '  https://people.abc.com/{username}  ',
      openDirectly: true,
    });
    await page.getByRole('button', { name: 'Add target' }).click();
    await fillRow(page, 1, {
      emailDomain: '',
      urlTemplate: 'https://example.test/s?q={email}',
      openDirectly: false,
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Saved.');

    // The domain is lower-cased and the template trimmed on the way in,
    // and the form is re-rendered so the user sees what was stored.
    await expect
      .poll(() => config.getTargets())
      .toEqual([
        {
          emailDomain: 'abc.com',
          urlTemplate: 'https://people.abc.com/{username}',
          openDirectly: true,
        },
        {
          emailDomain: '',
          urlTemplate: 'https://example.test/s?q={email}',
          openDirectly: false,
        },
      ]);
    await expect(row(page, 0).locator('.domain')).toHaveValue('abc.com');
    await expect(row(page, 0).locator('.template')).toHaveValue(
      'https://people.abc.com/{username}',
    );

    await page.close();
  });

  test('add, reorder, and remove rows', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    await fillRow(page, 0, {
      emailDomain: 'first.test',
      urlTemplate: 'https://example.test/1?q={email}',
      openDirectly: false,
    });
    await page.getByRole('button', { name: 'Add target' }).click();
    await fillRow(page, 1, {
      emailDomain: 'second.test',
      urlTemplate: 'https://example.test/2?q={email}',
      openDirectly: false,
    });
    await page.getByRole('button', { name: 'Add target' }).click();
    await fillRow(page, 2, {
      emailDomain: 'third.test',
      urlTemplate: 'https://example.test/3?q={email}',
      openDirectly: false,
    });

    // Move the last row to the top with two "up" clicks.
    await row(page, 2).getByRole('button', { name: 'Move up' }).click();
    await row(page, 1).getByRole('button', { name: 'Move up' }).click();
    await expect(row(page, 0).locator('.domain')).toHaveValue('third.test');

    // Then push it back down one.
    await row(page, 0).getByRole('button', { name: 'Move down' }).click();
    await expect(row(page, 1).locator('.domain')).toHaveValue('third.test');

    await row(page, 0).getByRole('button', { name: 'Remove' }).click();
    await expect(rows(page)).toHaveCount(2);

    // Nothing can move past either end of the list.
    await expect(
      row(page, 0).getByRole('button', { name: 'Move up' }),
    ).toBeDisabled();
    await expect(
      row(page, 0).getByRole('button', { name: 'Move down' }),
    ).toBeEnabled();
    await expect(
      row(page, 1).getByRole('button', { name: 'Move down' }),
    ).toBeDisabled();

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(async () => (await config.getTargets())?.map((t) => t.emailDomain))
      .toEqual(['third.test', 'second.test']);

    await page.close();
  });

  test('an empty list is allowed and means "always ask"', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    await row(page, 0).getByRole('button', { name: 'Remove' }).click();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator('#noTargets')).toBeVisible();

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => config.getTargets()).toEqual([]);

    await page.close();
  });

  test('rejects a link target that ignores the address', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    // A URL with no placeholder sends every address to the same fixed
    // page, which is never what anyone means to configure.
    await config.setTemplate('https://example.test/lookup?addr={email}');
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    await row(page, 0).locator('.template').fill('https://example.test/lookup');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.locator('#status')).toHaveText(
      'Link targets must include {username} or {email}',
    );
    await expect(page.locator('#status')).toHaveClass(/error/);
    expect(await config.getTargets()).toEqual([
      {
        emailDomain: '',
        urlTemplate: 'https://example.test/lookup?addr={email}',
        openDirectly: true,
      },
    ]);

    // Either placeholder satisfies it.
    await row(page, 0).locator('.template').fill('https://example.test/{username}');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Saved.');

    await page.close();
  });

  test.describe('rejects link targets that would break the extension', () => {
    // Each of these is stopped at the options page rather than saved:
    // empty sends the click back to the current page, mailto: hands
    // straight to the email app the extension exists to avoid, and
    // javascript: would run script in every page the user visits.
    for (const [label, template] of [
      ['an empty target', ''],
      ['a whitespace-only target', '   '],
      ['a mailto: target', 'mailto:{email}'],
      ['a javascript: target', 'javascript:alert(1)'],
      ['a bare domain with no scheme', 'example.test/s?q={email}'],
    ] as const) {
      test(label, async ({ extensionContext, extensionId, config }) => {
        await config.setTemplate('https://example.test/lookup?addr={email}');
        const page = await extensionContext.newPage();
        await openOptions(page, extensionId);

        await row(page, 0).locator('.template').fill(template);
        await page.getByRole('button', { name: 'Save', exact: true }).click();

        await expect(page.locator('#status')).toHaveText(
          'Link targets must be URLs starting with http:// or https://',
        );
        await expect(page.locator('#status')).toHaveClass(/error/);
        // Errors don't time out — this one is still there well after a
        // confirmation would have faded.
        await page.waitForTimeout(3000);
        await expect(page.locator('#status')).toHaveClass(/error/);
        // ...but editing the row clears it, since that's the user acting
        // on what it said.
        await row(page, 0).locator('.template').fill('https://example.test/{email}');
        await expect(page.locator('#status')).toHaveText('');
        // Nothing was written; the stored config survives untouched.
        expect(await config.getTargets()).toEqual([
          {
            emailDomain: '',
            urlTemplate: 'https://example.test/lookup?addr={email}',
            openDirectly: true,
          },
        ]);

        await page.close();
      });
    }
  });

  test('reports a save the browser refuses', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    await config.setTemplate('https://example.test/lookup?addr={email}');
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    // A perfectly valid template that storage still won't take:
    // chrome.storage.sync caps one item at QUOTA_BYTES_PER_ITEM (8192).
    // Validation passes, the write rejects — the path that used to fail
    // silently, leaving neither "Saved." nor an error on screen.
    const oversized = `https://example.test/${'x'.repeat(9000)}?q={email}`;
    await row(page, 0).locator('.template').fill(oversized);
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // Chrome's own wording for this is `QUOTA_BYTES_PER_ITEM quota
    // exceeded`, which is not something to show anyone.
    await expect(page.locator('#status')).toHaveText(
      'Save failed: The settings are too large to sync',
    );
    await expect(page.locator('#status')).toHaveClass(/error/);
    // Sticky, like the validation errors: a confirmation would have gone
    // by now.
    await page.waitForTimeout(3000);
    await expect(page.locator('#status')).toHaveClass(/error/);
    // And the stored config is untouched.
    expect(await config.getTargets()).toEqual([
      {
        emailDomain: '',
        urlTemplate: 'https://example.test/lookup?addr={email}',
        openDirectly: true,
      },
    ]);

    await page.close();
  });

  test('Cancel restores what is stored', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    await config.setTemplate('https://example.test/lookup?addr={email}');
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    await row(page, 0).locator('.domain').fill('scratch.test');
    await page.getByRole('button', { name: 'Add target' }).click();
    await expect(rows(page)).toHaveCount(2);

    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.locator('#status')).toHaveText('Changes discarded.');
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, 0).locator('.domain')).toHaveValue('');
    await expect(row(page, 0).locator('.template')).toHaveValue(
      'https://example.test/lookup?addr={email}',
    );

    await page.close();
  });

  test('the status message clears itself after a moment', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#status')).toHaveText('Saved.');
    // A confirmation clears itself after 2.5s (an error would not).
    await expect(page.locator('#status')).toHaveText('', { timeout: 5000 });

    await page.close();
  });

  test('a target saved here takes effect on an open page', async ({
    extensionContext,
    extensionId,
    fixtureServer,
    config,
  }) => {
    void config;
    // The full user-visible loop: open a page with mailto links, change
    // the config in the options UI, and watch the already-open page
    // update without a reload.
    const linkPage = await extensionContext.newPage();
    await linkPage.goto(`${fixtureServer.baseUrl}/${PAGE}`);
    // The shipped default isn't automatic, so the link starts out asking.
    // Clicking here also makes the frame read its config, which is what
    // registers the storage listener the assertion at the end depends on.
    await linkPage.getByRole('link', { name: 'alice@example.com' }).click();
    await expect(
      linkPage.locator('#fix-mailto-links-dialog').locator('.panel'),
    ).toBeVisible();
    await linkPage.keyboard.press('Escape');

    const optionsPage = await extensionContext.newPage();
    await openOptions(optionsPage, extensionId);
    await row(optionsPage, 0)
      .locator('.template')
      .fill('https://example.test/lookup?u={username}');
    await row(optionsPage, 0).locator('.auto input').check();
    await optionsPage.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(optionsPage.locator('#status')).toHaveText('Saved.');

    // No reload of linkPage: the click below has to pick up the new
    // target from the storage listener alone.
    await linkPage.getByRole('link', { name: 'alice@example.com' }).click();
    await expect
      .poll(() => linkPage.url())
      .toBe('https://example.test/lookup?u=alice');

    await optionsPage.close();
    await linkPage.close();
  });
});

test.describe('options page "Test it" link', () => {
  test('offers two independent test lines', async ({
    extensionContext,
    extensionId,
    fixtureServer,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    // The two default addresses differ by domain, which is the point:
    // one config, two match outcomes, no retyping.
    await expect(page.locator('#testLink')).toHaveText('mailto:nobody@example.com');
    await expect(page.locator('#testLink2')).toHaveText('mailto:nobody@example.net');

    await fillRow(page, 0, {
      emailDomain: 'example.com',
      urlTemplate: `${fixtureServer.baseUrl}/landing.html?u={username}`,
      openDirectly: true,
    });

    // The .com line matches the rule and is followed...
    const opened = extensionContext.waitForEvent('page');
    await page.locator('#testLink').click();
    const target = await opened;
    await target.waitForURL(/landing\.html/);
    await target.close();

    // ...while the .net line matches nothing and falls through to the
    // dialog, from the same unsaved config.
    await page.locator('#testLink2').click();
    await expect(page.locator(DIALOG).locator('.address')).toHaveText(
      'mailto:nobody@example.net',
    );
    await expect(
      page.locator(DIALOG).getByText('No link targets match this address.'),
    ).toBeVisible();

    await page.close();
  });

  test('tracks the address typed into the test field', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    await page.locator('#testEmail').fill('someone@abc.com');

    await expect(page.locator('#testLink')).toHaveAttribute(
      'href',
      'mailto:someone@abc.com',
    );
    await expect(page.locator('#testLink')).toHaveText('mailto:someone@abc.com');
    // The other line is untouched by that edit.
    await expect(page.locator('#testLink2')).toHaveAttribute(
      'href',
      'mailto:nobody@example.net',
    );

    await page.close();
  });

  test('follows an automatic target in a new tab, using unsaved edits', async ({
    extensionContext,
    extensionId,
    fixtureServer,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    await fillRow(page, 0, {
      emailDomain: 'abc.com',
      urlTemplate: `${fixtureServer.baseUrl}/landing.html?u={username}`,
      openDirectly: true,
    });
    await page.locator('#testEmail').fill('someone@abc.com');

    // Deliberately not saved — the test link runs against the live form.
    const opened = extensionContext.waitForEvent('page');
    await page.locator('#testLink').click();
    const target = await opened;

    await target.waitForURL(/landing\.html/);
    expect(new URL(target.url()).searchParams.get('u')).toBe('someone');
    // The options page itself stayed put, so the edits survive.
    expect(page.url()).toContain('options.html');
    expect(await config.getTargets()).toBeUndefined();

    await target.close();
    await page.close();
  });

  test('opens the dialog when no target is automatic', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    await fillRow(page, 0, {
      emailDomain: '',
      urlTemplate: 'https://example.test/s?q={email}',
      openDirectly: false,
    });
    await page.locator('#testEmail').fill('someone@abc.com');
    await page.locator('#testLink').click();

    const dialog = page.locator(DIALOG);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.address')).toHaveText('mailto:someone@abc.com');
    await expect(dialog.locator('li a').first()).toHaveAttribute(
      'href',
      'https://example.test/s?q=someone@abc.com',
    );
    await expect(dialog.locator('li a').last()).toHaveAttribute(
      'href',
      'mailto:someone@abc.com',
    );
    // Targets open in a new tab here so the unsaved form isn't lost; the
    // mailto: bullet doesn't, or the handoff would strand a blank tab.
    await expect(dialog.locator('li a').first()).toHaveAttribute(
      'target',
      '_blank',
    );
    await expect(dialog.locator('li a').last()).not.toHaveAttribute(
      'target',
      '_blank',
    );
    // The configure button is present but has nowhere to send anyone
    // from here, so it just closes.
    await dialog
      .getByRole('button', { name: 'Configure link targets' })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(page.url()).toContain('options.html');

    await page.close();
  });

  test('skips rows with an unusable target URL', async ({
    extensionContext,
    extensionId,
    config,
  }) => {
    void config;
    const page = await extensionContext.newPage();
    await openOptions(page, extensionId);

    // A half-typed row shouldn't stop the rest of the form from being
    // testable — Save is where a bad URL gets rejected.
    await fillRow(page, 0, {
      emailDomain: '',
      urlTemplate: 'https:/',
      openDirectly: true,
    });
    await page.getByRole('button', { name: 'Add target' }).click();
    await fillRow(page, 1, {
      emailDomain: '',
      urlTemplate: 'https://example.test/s?q={email}',
      openDirectly: false,
    });
    await page.locator('#testLink').click();

    const dialog = page.locator(DIALOG);
    // The valid row, plus the original mailto: bullet.
    await expect(dialog.locator('li a')).toHaveCount(2);
    await expect(dialog.locator('li a').first()).toHaveAttribute(
      'href',
      'https://example.test/s?q=nobody@example.com',
    );

    await page.close();
  });
});
