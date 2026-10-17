import { readFileSync } from 'node:fs';
import { test, expect as baseExpect } from '@playwright/test';
import { demoJson } from './demo-api.mjs';

// Branch Google review link, end to end against the running CRM:
//   a Google Business Profile location mapped to a branch fills the branch's
//   empty review link -> Client Admin sees it under Branches -> Feedback page ->
//   Delivery creates the feedback follow-up and issues the customer's form link ->
//   the customer rates 2 stars with a comment, still gets the Google button (no
//   review gating), and the button opens the branch link and copies the comment ->
//   the spent link cannot be used again.
//
// The demo org has no real Google account connected, so the mapping row is
// written with the service role the way the OAuth callback writes it. The
// fill_branch_review_url_from_gbp trigger and everything after it are real.
// Fixture rows are removed afterwards and the branch link is reset, unless
// E2E_KEEP_REVIEW_LINK=true.
//
// Needs `next dev` with DEMO_ROLE_LOGIN_ENABLED=true (E2E_BASE_URL, default :3000).

const expect = baseExpect.configure({ timeout: 30_000 });
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });
test.describe.configure({ mode: 'serial' });
// Same visible-run options as lead-flow.spec.mjs.
if (process.env.E2E_CHROMIUM_EXECUTABLE) {
  const visibleBrowser = process.env.E2E_VISIBLE_BROWSER === 'true';
  const windowPosition = process.env.E2E_WINDOW_POSITION;
  test.use({
    launchOptions: {
      executablePath: process.env.E2E_CHROMIUM_EXECUTABLE,
      ...(visibleBrowser
        ? {
            headless: false,
            ...(Number(process.env.E2E_SLOW_MO) > 0
              ? { slowMo: Number(process.env.E2E_SLOW_MO) }
              : {}),
            args: [
              '--start-fullscreen',
              `--window-position=${windowPosition ?? '0,0'}`,
              '--window-size=1920,1080',
              ...(windowPosition ? ['--ozone-platform=x11', '--class=gdm-e2e'] : []),
            ],
          }
        : {}),
    },
    ...(visibleBrowser ? { viewport: null } : {}),
  });
}

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const branchCode = process.env.E2E_REVIEW_BRANCH ?? 'BLR-01';
const runId = Date.now().toString(36);
const reviewUrl = `https://search.google.com/local/writereview?placeid=E2E-${runId}`;
const comment = `E2E review check ${runId}: the delivery was late but the staff were kind.`;

function readLocalEnv() {
  try {
    return Object.fromEntries(
      readFileSync(new URL('../../.env', import.meta.url), 'utf8')
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('#'))
        .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
        .filter(Boolean)
        .map((match) => [match[1], match[2].replace(/^"|"$/g, '')]),
    );
  } catch {
    return {};
  }
}

const localEnv = readLocalEnv();
const projectUrl = (
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? localEnv.NEXT_PUBLIC_SUPABASE_URL
)?.replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? localEnv.SUPABASE_SERVICE_ROLE_KEY;

async function service(path, init = {}) {
  return demoJson(
    await fetch(`${projectUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
        ...init.headers,
      },
    }),
  );
}

const fixture = {
  organizationId: null,
  branchId: null,
  branchName: null,
  originalReviewUrl: null,
  connectedAccountId: null,
  bookingNumber: null,
  token: null,
};

async function signIn(page, role) {
  const login = await page.request.post(`${baseURL}/api/development/demo-role-login`, {
    data: { role, organization: 'demo' },
  });
  expect(login.ok(), `Demo login for ${role} returned HTTP ${login.status()}`).toBe(true);
}

test.beforeAll(async () => {
  expect(projectUrl && serviceKey, 'Supabase URL and service key are required').toBeTruthy();
  const [org] = await service('organizations?select=id&slug=eq.go-digital-demo-test');
  const [branch] = await service(
    `branches?select=id,name,google_review_url&organization_id=eq.${org.id}&code=eq.${branchCode}&deleted_at=is.null`,
  );
  Object.assign(fixture, {
    organizationId: org.id,
    branchId: branch.id,
    branchName: branch.name,
    originalReviewUrl: branch.google_review_url,
  });

  // A delivered case in this branch nobody has asked for feedback on yet.
  const cases = await service(
    `delivery_cases?select=id,bookings!delivery_cases_booking_id_fkey!inner(booking_number)&organization_id=eq.${org.id}` +
      `&branch_id=eq.${branch.id}&status=eq.DELIVERED&deleted_at=is.null&order=delivered_at.desc&limit=200`,
  );
  const asked = new Set(
    (
      await service(
        `feedback_requests?select=delivery_case_id&organization_id=eq.${org.id}&branch_id=eq.${branch.id}&delivery_case_id=not.is.null`,
      )
    ).map((row) => row.delivery_case_id),
  );
  const fresh = cases.find((row) => !asked.has(row.id));
  expect(
    fresh,
    `No delivered case in ${branchCode} is waiting for a feedback request`,
  ).toBeTruthy();
  fixture.bookingNumber = fresh.bookings.booking_number;
});

test.afterAll(async () => {
  if (process.env.E2E_KEEP_REVIEW_LINK === 'true' || !fixture.branchId) return;
  if (fixture.connectedAccountId) {
    await service(
      `integration_branch_mappings?connected_account_id=eq.${fixture.connectedAccountId}`,
      {
        method: 'DELETE',
      },
    );
    await service(`connected_accounts?id=eq.${fixture.connectedAccountId}`, { method: 'DELETE' });
  }
  await service(`branches?id=eq.${fixture.branchId}`, {
    method: 'PATCH',
    body: JSON.stringify({ google_review_url: fixture.originalReviewUrl }),
  });
});

test('mapping a Google Business Profile location fills the empty branch review link', async () => {
  if (fixture.originalReviewUrl) {
    // The trigger only fills an empty link; clear it so this run exercises the fill.
    await service(`branches?id=eq.${fixture.branchId}`, {
      method: 'PATCH',
      body: JSON.stringify({ google_review_url: null }),
    });
  }
  const [clientAdmin] = await service(
    `profiles?select=id&email=eq.client-admin@demo.go-digital.invalid`,
  );
  const [account] = await service('connected_accounts', {
    method: 'POST',
    body: JSON.stringify({
      organization_id: fixture.organizationId,
      provider_key: 'google_business_profile',
      display_name: `E2E Google Business Profile ${runId}`,
      scope_mode: 'ONE_BRANCH',
      status: 'CONNECTED',
      auth_type: 'OAUTH2',
      created_by: clientAdmin.id,
    }),
  });
  fixture.connectedAccountId = account.id;
  await service('integration_branch_mappings', {
    method: 'POST',
    body: JSON.stringify({
      organization_id: fixture.organizationId,
      connected_account_id: account.id,
      branch_id: fixture.branchId,
      external_resource_type: 'GBP_LOCATION',
      external_resource_id: `locations/e2e${runId}`,
      external_resource_label: `${fixture.branchName} (E2E)`,
      mapping_metadata: { review_url: reviewUrl },
    }),
  });

  const [branch] = await service(`branches?select=google_review_url&id=eq.${fixture.branchId}`);
  expect(branch.google_review_url).toBe(reviewUrl);
});

test('Client Admin sees the link under Branches -> Feedback page', async ({ page }) => {
  await signIn(page, 'client-admin');
  await page.goto(`${baseURL}/client-admin/branches`);
  const row = page.getByRole('row').filter({ hasText: fixture.branchName });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.getByRole('button', { name: 'Branch actions' }).click();
  await page.getByRole('menuitem', { name: 'Feedback page' }).click();

  const dialog = page.getByRole('dialog', { name: `${fixture.branchName} feedback page` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Google review link')).toBeVisible();
  await expect(dialog.getByText('Set', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: reviewUrl })).toHaveAttribute('href', reviewUrl);
  await page.waitForTimeout(1_500);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('Delivery creates the follow-up and issues the customer form link', async ({ page }) => {
  await signIn(page, 'delivery');
  await page.goto(`${baseURL}/delivery/feedback`);
  await page.getByRole('tab', { name: 'ALL' }).click();
  await page
    .getByPlaceholder('Customer, booking number or exact phone')
    .fill(fixture.bookingNumber);
  const row = page.getByRole('row').filter({ hasText: fixture.bookingNumber });
  await expect(row).toHaveCount(1, { timeout: 60_000 });

  await row.getByRole('button', { name: 'Create follow-up' }).click();
  const linkButton = row.getByRole('button', { name: 'Get form link' });
  await expect(linkButton).toBeVisible({ timeout: 60_000 });

  const issued = page.waitForResponse(
    (response) => response.url().includes('/rpc/issue_feedback_form_link') && response.ok(),
  );
  await linkButton.click();
  const body = await (await issued).json();
  expect(body.token).toMatch(/^[0-9a-f]{64}$/);
  fixture.token = body.token;
  await expect(page.getByText(/Form link (copied|ready)/)).toBeVisible();
});

test('a 2-star customer still gets the Google button, which opens the branch link and copies the comment', async ({
  browser,
}) => {
  // The customer has no CRM session at all.
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  await page.goto(`${baseURL}/feedback/${fixture.token}`);
  await expect(page.getByText('How was your experience?')).toBeVisible();
  await expect(page.getByText(fixture.branchName)).toBeVisible();

  await page.getByRole('button', { name: '2 stars' }).click();
  await page.getByLabel('Your comments').fill(comment);
  await page.getByRole('button', { name: 'Submit feedback' }).click();

  await expect(page.getByText('Thank you for your feedback')).toBeVisible();
  await expect(page.getByText(/We are sorry we let you down/)).toBeVisible();
  const google = page.getByRole('link', { name: 'Share your experience on Google' });
  await expect(google).toHaveAttribute('href', reviewUrl);
  await page.waitForTimeout(1_500);

  const popupPromise = context.waitForEvent('page');
  await google.click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  expect(popup.url()).toContain(`placeid=E2E-${runId}`);
  await expect(
    page.getByText('Comment copied. On Google, tap the review box and paste it.'),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(comment);
  await page.waitForTimeout(2_000);
  await popup.close();

  // Single use: the same link now only thanks the customer.
  await page.reload();
  await expect(page.getByText('Your feedback has already been received.')).toBeVisible();
  await context.close();
});
