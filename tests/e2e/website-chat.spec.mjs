import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test, expect as baseExpect } from '@playwright/test';
import { createDemoSessionProvider, demoJson } from './demo-api.mjs';

// Website chat widget + Lead API, end to end against the running CRM:
//   Client Admin configures the connection and issues an API key in the UI ->
//   a visitor completes the chat on an allowed dealer page -> the lead lands in
//   the CRM with requirements and the chosen showroom -> a disallowed site
//   cannot show the chat -> the Lead API accepts, dedupes and rejects as it
//   should -> a key revoked in the UI stops working.
//
// Needs `next dev` with DEMO_ROLE_LOGIN_ENABLED=true (E2E_BASE_URL, default
// :3000) and the deployed website-* / lead-api Edge Functions. Turnstile must
// be unset, or set to Cloudflare's always-pass test keys.

const expect = baseExpect.configure({ timeout: 30_000 });
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });
test.describe.configure({ mode: 'serial' });
// Same opt-in as lead-flow.spec.mjs for a workstation whose managed browser
// download differs from the pinned Playwright build.
if (process.env.E2E_CHROMIUM_EXECUTABLE) {
  test.use({
    launchOptions: {
      executablePath: process.env.E2E_CHROMIUM_EXECUTABLE,
      ...(process.env.E2E_VISIBLE_BROWSER === 'true' ? { headless: false } : {}),
    },
  });
}

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const allowedPort = Number(process.env.E2E_DEALER_PORT ?? 4599);
const blockedPort = allowedPort - 1;
const allowedOrigin = `http://localhost:${allowedPort}`;
const connectionName = 'E2E website chat';
const runId = Date.now().toString(36);
const visitorName = `Website chat QA ${runId}`;
const visitorMobile = `9${String(Date.now() % 1_000_000_000).padStart(9, '0')}`;
const apiKeyName = `E2E key ${runId}`;

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
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? localEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
// A fresh session per call: the demo login used by the browser steps signs the
// same Client Admin in again, which ends any session cached before it.
function clientAdminToken() {
  return createDemoSessionProvider({
    projectUrl,
    anonKey,
    password: process.env.DEMO_TEST_PASSWORD ?? localEnv.DEMO_TEST_PASSWORD,
  })('client_admin');
}

async function rows(table, query) {
  const token = await clientAdminToken();
  return demoJson(
    await fetch(`${projectUrl}/rest/v1/${table}?${new URLSearchParams(query)}`, {
      headers: { apikey: anonKey, authorization: `Bearer ${token}` },
    }),
  );
}

async function rpc(name, body) {
  const token = await clientAdminToken();
  return demoJson(
    await fetch(`${projectUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
}

async function postLead(apiKey, body, idempotencyKey) {
  const response = await fetch(`${projectUrl}/functions/v1/lead-api`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// Two stand-ins for a dealer website: one on the connection's allowed list,
// one that is not. Both embed the real loader from the CRM.
let publicKey = null;
let apiKey = null;
const dealerServers = [];

function dealerPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>E2E Dealer</title>
<link rel="icon" href="data:,"></head><body><h1>E2E Dealer Motors</h1>
<script>window.addEventListener('gdm:lead', () => { document.body.dataset.lead = 'sent'; });</script>
<script src="${baseURL}/widget/v1/gdm-chat.js" data-key="${publicKey}" async></script>
</body></html>`;
}

test.beforeAll(async () => {
  for (const port of [allowedPort, blockedPort]) {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(dealerPage());
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, 'localhost', resolve);
    });
    dealerServers.push(server);
  }
});

test.afterAll(async () => {
  await Promise.all(dealerServers.map((server) => new Promise((done) => server.close(done))));
});

async function signInAsClientAdmin(page) {
  const login = await page.request.post(`${baseURL}/api/development/demo-role-login`, {
    data: { role: 'client-admin', organization: 'demo' },
  });
  expect(login.ok(), `Demo login returned HTTP ${login.status()}`).toBe(true);
}

async function openIntegrations(page) {
  await page.goto(`${baseURL}/client-admin/integrations`);
  await expect(page.getByRole('button', { name: 'Connect provider' })).toBeVisible({
    timeout: 60_000,
  });
}

function connectionRow(page) {
  return page.locator('tr', { hasText: connectionName });
}

// The chat iframe sits in the loader's closed shadow root, so it is reached
// through the page's frame list rather than a locator.
async function chatFrame(page) {
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('/embed/chat/')))
    .toBe(true);
  return page.frames().find((frame) => frame.url().includes('/embed/chat/'));
}

async function openLauncher(page) {
  // The loader is async; wait until it has mounted the bubble.
  await page.waitForFunction(() => window.GDMChat && document.querySelector('[data-gdm-chat]'));
  // A real click on the bubble (bottom-right, 56px, 20px inset).
  const viewport = page.viewportSize();
  await page.mouse.click(viewport.width - 48, viewport.height - 48);
}

test('Client Admin connects the website chat and issues a Lead API key', async ({ page }) => {
  test.setTimeout(240_000);
  await signInAsClientAdmin(page);
  await openIntegrations(page);

  const existing = (await connectionRow(page).count()) > 0;
  if (existing) {
    await connectionRow(page).getByRole('button', { name: 'Edit settings' }).click();
  } else {
    await page.getByRole('button', { name: 'Connect provider' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Website chat widget & Lead API' }).click();
    await dialog.getByLabel('Connection name').fill(connectionName);
  }
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Chat questions')).toBeVisible();

  // An enabled widget with no domains is refused before anything is sent.
  const domains = dialog.getByLabel('Website domains allowed to show the chat');
  await domains.fill('');
  await dialog.getByRole('button', { name: 'Save website connection' }).click();
  await expect(dialog.getByText('Add at least one website domain')).toBeVisible();

  await domains.fill(`${allowedOrigin}\nhttps://e2e-dealer.example`);
  await dialog.getByLabel('Chat title').fill('E2E chat');
  await dialog.getByRole('button', { name: 'Save website connection' }).click();
  await expect(dialog.getByText('Website connection saved')).toBeVisible();

  const embed = await dialog.locator('pre').first().innerText();
  publicKey = embed.match(/data-key="(wpk_[A-Za-z0-9_-]+)"/)?.[1] ?? null;
  expect(publicKey, 'embed code carries the public key').toBeTruthy();
  expect(embed).toContain('/widget/v1/gdm-chat.js');

  await dialog.getByRole('button', { name: 'Create key' }).click();
  const keyDialog = page.getByRole('dialog', { name: 'Create Lead API key' });
  await keyDialog.getByLabel('Key name').fill(apiKeyName);
  await keyDialog.getByRole('button', { name: 'Create key' }).click();
  const issued = page.getByRole('dialog', { name: 'Copy your API key now' });
  apiKey = await issued.getByLabel('API key').inputValue();
  expect(apiKey).toMatch(/^gdm_live_[A-Za-z0-9]{10}_[A-Za-z0-9_-]{32,}$/);
  await issued.getByRole('button', { name: 'I have stored the key' }).click();
  await expect(dialog.getByRole('cell', { name: apiKeyName })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
});

test('a visitor completes the chat on an allowed site and the lead reaches the CRM', async ({
  page,
}) => {
  test.setTimeout(180_000);
  test.skip(!publicKey, 'needs the connection from the previous test');
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${allowedOrigin}/`);
  await openLauncher(page);
  const chat = await chatFrame(page);
  await expect(chat.getByText('E2E chat')).toBeVisible({ timeout: 60_000 });

  const answer = async (text) => {
    const input = chat.locator('footer form input');
    await input.fill(text);
    await input.press('Enter');
  };
  // Answer chips only: optional questions also show a "Skip this question" button.
  const chips = chat.locator('footer div.flex-wrap button');
  const choose = async (label) =>
    chat.locator('footer').getByRole('button', { name: label, exact: true }).first().click();

  await expect(chat.getByText('May I know your name?')).toBeVisible();
  await answer(visitorName);
  await expect(chat.getByText('What is your mobile number')).toBeVisible();
  await answer('12345');
  await expect(chat.getByText('Enter a valid mobile number.')).toBeVisible();
  await answer(visitorMobile);

  await expect(chat.getByText('Which car are you interested in?')).toBeVisible();
  const model = (await chips.first().innerText()).trim();
  await choose(model);
  await expect(chat.getByText('What is your budget?')).toBeVisible();
  await choose('₹10–15 lakh');
  await expect(chat.getByText('When are you planning to buy?')).toBeVisible();
  await choose('Within 1 month');
  await expect(chat.getByText('Which showroom is convenient for you?')).toBeVisible();
  const showroom = (await chips.last().innerText()).trim();
  await choose(showroom);
  await expect(chat.getByText('Do you have a car to exchange?')).toBeVisible();
  await choose('Yes');
  await expect(chat.getByText('car loan / finance')).toBeVisible();
  await chat.getByRole('button', { name: 'Skip this question' }).click();
  await expect(chat.getByText('book a test drive?')).toBeVisible();
  await choose('Yes');

  await expect(chat.getByText('Our team will call you shortly')).toBeVisible();
  await expect(chat.getByText('Details sent')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-lead', 'sent');

  let lead;
  await expect
    .poll(async () => {
      [lead] = await rows('leads', {
        select:
          'id,customer_name,phone,source,interested_model,lifecycle_status,branch_id,assigned_user_id',
        customer_name: `eq.${visitorName}`,
      });
      return Boolean(lead);
    })
    .toBe(true);
  expect(lead).toMatchObject({
    phone: `+91${visitorMobile}`,
    source: 'Website',
    interested_model: model,
    lifecycle_status: 'New',
  });
  const [branch] = await rows('branches', { select: 'name', id: `eq.${lead.branch_id}` });
  expect(branch.name, 'routed to the showroom the visitor picked').toBe(showroom);
  const [requirements] = await rows('lead_requirements', {
    select:
      'budget_min,budget_max,purchase_timeline,exchange_required,finance_required,test_drive_required',
    lead_id: `eq.${lead.id}`,
  });
  expect(requirements).toEqual({
    budget_min: 1_000_000,
    budget_max: 1_500_000,
    purchase_timeline: 'Within 1 month',
    exchange_required: true,
    finance_required: null,
    test_drive_required: true,
  });
  const answers = await rpc('get_lead_website_answers', { target_lead_id: lead.id });
  expect(answers.map((entry) => entry.answer)).toContain(showroom);

  // The same transcript is on the lead page for CRM users.
  await signInAsClientAdmin(page);
  await page.goto(`${baseURL}/client-admin/leads/${lead.id}`);
  await expect(page.getByText('Website answers')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(visitorName).first()).toBeVisible();
});

test('a site that is not on the allowed list cannot show the chat', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(!publicKey, 'needs the connection from the first test');
  await page.goto(`http://localhost:${blockedPort}/`);
  await openLauncher(page);
  // CSP frame-ancestors blocks the frame; the loader then removes its button.
  await expect
    .poll(() => page.evaluate(() => Boolean(document.querySelector('[data-gdm-chat]'))), {
      timeout: 40_000,
    })
    .toBe(false);
  const frame = page.frames().find((candidate) => candidate.url().includes('/embed/chat/'));
  const rendered = frame
    ? await frame
        .getByText('May I know your name?')
        .count()
        .catch(() => 0)
    : 0;
  expect(rendered).toBe(0);
});

test('the chat page opened directly is a preview that sends nothing', async ({ page }) => {
  test.skip(!publicKey, 'needs the connection from the first test');
  await page.goto(`${baseURL}/embed/chat/${publicKey}`);
  await expect(page.getByText('Preview — answers are not sent')).toBeVisible({ timeout: 60_000 });
  const headers = (await page.request.get(`${baseURL}/embed/chat/${publicKey}`)).headers();
  expect(headers['content-security-policy']).toContain(`frame-ancestors 'self'`);
  expect(headers['content-security-policy']).toContain(allowedOrigin);
});

test('the Lead API accepts, deduplicates and rejects requests correctly', async () => {
  test.skip(!apiKey, 'needs the key from the first test');
  const idempotencyKey = randomUUID();
  const lead = {
    customer_name: `Lead API QA ${runId}`,
    phone: `8${String((Date.now() + 7) % 1_000_000_000).padStart(9, '0')}`,
    interested_model: 'Nexon',
    campaign: 'E2E',
    city: 'Bengaluru',
    message: 'Weekend test drive',
    requirements: { budget_min: 800000, budget_max: 1200000, finance_required: true },
  };

  const created = await postLead(apiKey, lead, idempotencyKey);
  expect(created.status).toBe(201);
  expect(created.body.data.duplicate).toBe(false);
  const repeated = await postLead(apiKey, lead, idempotencyKey);
  expect(repeated.status).toBe(200);
  expect(repeated.body.data).toEqual({ lead_id: created.body.data.lead_id, duplicate: true });

  // The read can land a moment before the new row is visible to it.
  let stored;
  await expect
    .poll(async () => {
      [stored] = await rows('leads', {
        select: 'customer_name,source,source_detail,campaign',
        id: `eq.${created.body.data.lead_id}`,
      });
      return Boolean(stored);
    })
    .toBe(true);
  expect(stored).toMatchObject({
    source: 'Website',
    source_detail: `Lead API: ${apiKeyName}`,
    campaign: 'E2E',
  });

  expect((await postLead(null, lead)).status).toBe(401);
  expect((await postLead(`${apiKey.slice(0, -4)}AAAA`, lead)).status).toBe(403);
  const invalid = await postLead(apiKey, { customer_name: 'X', phone: '12' });
  expect(invalid.status).toBe(422);
  expect(invalid.body.error.code).toBe('INVALID_PAYLOAD');
  const badBranch = await postLead(apiKey, { ...lead, branch_code: 'NO-SUCH-BRANCH' });
  expect(badBranch.status).toBe(422);
  expect(badBranch.body.error.code).toBe('BRANCH_NOT_ALLOWED');
});

test('a key revoked in the CRM stops working immediately', async ({ page }) => {
  test.setTimeout(150_000);
  test.skip(!apiKey, 'needs the key from the first test');
  await signInAsClientAdmin(page);
  await openIntegrations(page);
  await connectionRow(page).getByRole('button', { name: 'View' }).click();
  const sheet = page.getByRole('dialog', { name: connectionName });
  const keyRow = sheet.getByRole('row', { name: new RegExp(apiKeyName) });
  await keyRow.getByRole('button', { name: 'Revoke' }).click();
  await page
    .getByRole('dialog', { name: `Revoke “${apiKeyName}”?` })
    .getByRole('button', { name: 'Revoke key' })
    .click();
  await expect(keyRow.getByText('Revoked')).toBeVisible();

  const rejected = await postLead(apiKey, {
    customer_name: `Revoked key QA ${runId}`,
    phone: '9876501234',
  });
  expect(rejected.status).toBe(403);
  expect(rejected.body.error.code).toBe('INVALID_API_KEY');
});
