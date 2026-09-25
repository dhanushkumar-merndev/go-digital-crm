import { test, expect as baseExpect } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 30_000 });
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

test.use({
  launchOptions: {
    slowMo: Number(process.env.E2E_SLOW_MO ?? 3000),
    ...(process.env.E2E_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE }
      : {}),
  },
  viewport: { width: 1440, height: 1000 },
});

test('refreshes inbox messages and syncs history only for the selected chat', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const historyRequests = [];
  const messageRequests = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/functions/v1/personal-whatsapp-sync'))
      historyRequests.push(request.postDataJSON());
    if (request.url().endsWith('/rest/v1/rpc/get_context_inbox_messages'))
      messageRequests.push(request.postDataJSON());
  });

  await test.step('Sign in as the demo Telecaller', async () => {
    await page.goto(`${baseURL}/login`);
    await page.getByRole('button', { name: /Open development role switcher/ }).click();
    await page.getByRole('button', { name: 'Telecaller / BDC Executive', exact: true }).click();
    await page.waitForURL(/\/telecaller\/dashboard/, { timeout: 45_000 });
  });

  let personalChats;
  await test.step('Open the inbox and select the first personal chat', async () => {
    const loaded = page.waitForResponse(
      (response) => response.url().endsWith('/rest/v1/rpc/get_context_inbox_page') && response.ok(),
    );
    await page.goto(`${baseURL}/telecaller/inbox`);
    personalChats = (await (await loaded).json()).records.filter(
      (row) => row.channel === 'WHATSAPP_PERSONAL',
    );
    expect(personalChats.length).toBeGreaterThanOrEqual(2);
    const chat = personalChats[0];
    await page
      .locator('aside button')
      .filter({ hasText: chat.customer_name })
      .filter({ hasText: 'My WhatsApp' })
      .click();
    await expect(
      page.getByText(`Older text history · ${chat.customer_name}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sync text history', exact: true })).toHaveCount(
      0,
    );
  });

  await test.step('Refresh reads messages without requesting WhatsApp history', async () => {
    const before = messageRequests.length;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => messageRequests.length).toBeGreaterThan(before);
    expect(historyRequests).toHaveLength(0);
  });

  await test.step('Switch chats and sync only the newly selected chat', async () => {
    const chat = personalChats[1];
    await page
      .locator('aside button')
      .filter({ hasText: chat.customer_name })
      .filter({ hasText: 'My WhatsApp' })
      .click();
    const label = page.getByText(`Older text history · ${chat.customer_name}`, { exact: true });
    await expect(label).toBeVisible();
    const sync = page.getByRole('button', { name: 'Sync this chat’s history', exact: true });
    await expect(sync).toBeEnabled();
    const response = page.waitForResponse(
      (result) =>
        result.url().endsWith('/functions/v1/personal-whatsapp-sync') &&
        result.request().method() === 'POST',
    );
    await sync.click();
    const result = await response;
    expect(historyRequests).toEqual([{ conversation_id: chat.id }]);
    expect(result.status(), 'Selected-chat history request should be accepted').toBe(202);
    await expect(
      page.getByText(`History requested for ${chat.customer_name}`, { exact: true }),
    ).toBeVisible();
    await label.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath('selected-chat-history.png'),
      fullPage: true,
    });
  });
});
