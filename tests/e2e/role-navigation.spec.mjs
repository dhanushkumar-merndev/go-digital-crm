import { test, expect as baseExpect } from '@playwright/test';

// Every role's sidebar, end to end against the running CRM:
//   sign in as the role -> open every collapsible sidebar group -> visit every
//   sidebar page and require a rendered page heading with no "unavailable" or
//   not-found state -> click every tab on the tabbed pages and require the URL
//   to carry it -> open each retired page URL and require the redirect to its tab.
//
// Read-only: it never submits a form. Pages are visited one at a time so the
// shared demo project is not flooded while another suite runs.
//
// Needs `next dev` with DEMO_ROLE_LOGIN_ENABLED=true (E2E_BASE_URL, default :3000).
// E2E_ROLES=finance,gm-sales limits the run to some roles.

const expect = baseExpect.configure({ timeout: 45_000 });
test.use({
  actionTimeout: 30_000,
  navigationTimeout: 60_000,
  viewport: { width: 1440, height: 900 },
});
// One role failing must not hide the others; --workers=1 keeps the visits sequential.
if (process.env.E2E_CHROMIUM_EXECUTABLE) {
  const visibleBrowser = process.env.E2E_VISIBLE_BROWSER === 'true';
  test.use({
    launchOptions: {
      executablePath: process.env.E2E_CHROMIUM_EXECUTABLE,
      ...(visibleBrowser
        ? {
            headless: false,
            ...(Number(process.env.E2E_SLOW_MO) > 0
              ? { slowMo: Number(process.env.E2E_SLOW_MO) }
              : {}),
          }
        : {}),
    },
  });
}

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const allRoles = [
  'telecaller',
  'sales-consultant',
  'team-manager',
  'showroom-manager',
  'gm-sales',
  'client-admin',
  'system-administrator',
  'business-owner',
  'super-admin',
  'inventory',
  'inventory-executive',
  'finance',
  'finance-executive',
  'insurance',
  'insurance-executive',
  'rto',
  'rto-executive',
  'exchange',
  'exchange-executive',
  'delivery',
  'delivery-executive',
  'customer-care',
  'customer-relationship-executive',
  'digital-marketing',
];
const roles = process.env.E2E_ROLES
  ? allRoles.filter((role) => process.env.E2E_ROLES.split(',').includes(role))
  : allRoles;

// Retired sidebar pages and the tab each one now opens.
const retiredPages = {
  'gm-sales': {
    'showroom-comparison': '/gm-sales/sales-performance?view=showroom-comparison',
    'consultant-ranking': '/gm-sales/sales-performance?view=consultant-ranking',
    'model-performance': '/gm-sales/sales-performance?view=model-performance',
  },
  finance: {
    'pending-documents': '/finance/finance-cases?status=DOCUMENTS',
    applications: '/finance/finance-cases?status=APPLICATION_SUBMITTED',
    disbursement: '/finance/finance-cases?status=APPROVED',
  },
  exchange: {
    evaluations: '/exchange/exchange-requests?status=INSPECTION_SCHEDULED',
    'accepted-exchanges': '/exchange/exchange-requests?status=ACCEPTED',
  },
  delivery: {
    'delivery-planner': '/delivery/upcoming-deliveries?status=SCHEDULED',
    'pending-checklist': '/delivery/upcoming-deliveries?status=CHECKLIST_PENDING',
    'ready-for-delivery': '/delivery/upcoming-deliveries?status=READY',
    delivered: '/delivery/upcoming-deliveries?status=DELIVERED',
    'delivery-photos': '/delivery/upcoming-deliveries?status=DELIVERED',
  },
};

// Tabbed pages: [path, query parameter the tabs write].
const tabbedPages = {
  'gm-sales': [['/gm-sales/sales-performance', 'view']],
  finance: [['/finance/finance-cases', 'status']],
  exchange: [['/exchange/exchange-requests', 'status']],
  delivery: [['/delivery/upcoming-deliveries', 'status']],
};

const brokenStates = [
  'Live workspace unavailable',
  'This page could not be found',
  'is unavailable',
  'are not available yet',
  'is not available yet',
];

async function signInAs(page, role) {
  const response = await page.request.post(`${baseURL}/api/development/demo-role-login`, {
    data: { role, organization: 'demo' },
  });
  expect(response.ok(), `demo login for ${role}: ${response.status()}`).toBeTruthy();
}

async function expandSidebar(page) {
  const sidebar = page.locator('aside');
  for (;;) {
    const closed = sidebar.locator('nav button[aria-expanded="false"]');
    if ((await closed.count()) === 0) return;
    await closed.first().click();
  }
}

async function sidebarHrefs(page, role) {
  await expandSidebar(page);
  const hrefs = await page
    .locator('aside nav a')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  return [...new Set(hrefs.filter((href) => href?.startsWith(`/${role}/`)))];
}

async function expectRenderedPage(page, href) {
  await page.goto(`${baseURL}${href}`, { waitUntil: 'domcontentloaded' });
  // The Inbox nests a <main> for its message pane; the shell's is the outer one.
  const main = page.locator('main').first();
  // Most pages carry an h1; workspaces like the Inbox title their panes instead.
  await expect(main.getByRole('heading').first(), `${href} renders a heading`).toBeVisible();
  // Let the first data read settle into a rendered table/card or an error state.
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  const text = await main.innerText();
  const broken = brokenStates.find((marker) => text.includes(marker));
  return broken ? `${href}: "${broken}"` : null;
}

for (const role of roles) {
  test(`${role}: every sidebar page renders`, async ({ page }) => {
    test.setTimeout(15 * 60_000);
    await signInAs(page, role);
    await page.goto(`${baseURL}/${role}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('aside nav a').first()).toBeVisible();
    const hrefs = await sidebarHrefs(page, role);
    expect(hrefs.length, `${role} has sidebar pages`).toBeGreaterThan(1);

    const failures = [];
    for (const href of hrefs) {
      const failure = await expectRenderedPage(page, href).catch(
        (error) => `${href}: ${String(error.message ?? error).split('\n')[0]}`,
      );
      if (failure) failures.push(failure);
    }

    for (const [path, parameter] of tabbedPages[role] ?? []) {
      await page.goto(`${baseURL}${path}`, { waitUntil: 'domcontentloaded' });
      const tabs = page.locator('main [role="tablist"]').first().getByRole('tab');
      await expect(tabs.first()).toBeVisible();
      const count = await tabs.count();
      expect(count, `${path} has tabs`).toBeGreaterThan(1);
      for (let index = count - 1; index >= 0; index -= 1) {
        await tabs.nth(index).click();
        await expect(tabs.nth(index)).toHaveAttribute('data-state', 'active');
        // The first tab is the page default and is omitted from the URL.
        if (index > 0)
          await expect
            .poll(() => new URL(page.url()).searchParams.get(parameter), {
              message: `${path} tab ${index} writes ?${parameter}=`,
            })
            .not.toBeNull();
      }
      // Back to a tab from a shared link.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(tabs.first()).toBeVisible();
    }

    for (const [slug, target] of Object.entries(retiredPages[role] ?? {})) {
      await page.goto(`${baseURL}/${role}/${slug}`, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => {
          const url = new URL(page.url());
          return `${url.pathname}${url.search}`;
        })
        .toBe(target);
    }

    expect(failures, `${role} pages in a broken state`).toEqual([]);
  });
}
