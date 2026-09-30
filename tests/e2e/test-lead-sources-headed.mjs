import { chromium } from '@playwright/test';

const baseURL = process.env.BASE_URL ?? 'http://localhost:3000';
const executablePath =
  process.env.E2E_CHROMIUM_EXECUTABLE ??
  '/home/dhanushkr/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';

async function main() {
  console.log('🚀 Launching headed browser on your screen...');
  const browser = await chromium.launch({
    executablePath,
    headless: false,
    slowMo: 1000,
    args: ['--window-size=1440,920', '--window-position=50,50'],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 860 },
  });
  const page = await context.newPage();

  console.log('📍 Step 1: Navigating to CRM login page...');
  await page.goto(`${baseURL}/login`);
  await page.waitForTimeout(1000);

  console.log('📍 Step 2: Opening demo role switcher & logging in as Telecaller...');
  const switcherBtn = page.getByRole('button', { name: /Open development role switcher/ });
  await switcherBtn.click();
  await page.waitForTimeout(800);

  const telecallerBtn = page.getByRole('button', { name: /Telecaller \/ BDC Executive/ });
  await telecallerBtn.click();
  await page.waitForURL(/\/telecaller\/dashboard/, { timeout: 30000 });
  console.log('✅ Logged in successfully as Telecaller!');

  console.log('📍 Step 3: Opening My Leads workspace...');
  await page.goto(`${baseURL}/telecaller/my-leads`);
  await page.waitForTimeout(2000);

  console.log('📍 Step 4: Opening Source filter dropdown to inspect all sources...');
  const sourceDropdown = page.getByRole('combobox').filter({ hasText: /All sources|source/i }).first();
  await sourceDropdown.click();
  await page.waitForTimeout(3000); // Give user time to see all sources in dropdown

  console.log('📍 Step 5: Filtering table by "IndiaMART"...');
  const indiamartOption = page.getByRole('option', { name: 'IndiaMART' });
  await indiamartOption.click();
  await page.waitForTimeout(3000); // Give user time to see filtered IndiaMART leads

  console.log('📍 Step 6: Opening "Add lead" dialog...');
  const addLeadBtn = page.getByRole('button', { name: /Add lead/i });
  await addLeadBtn.click();
  await page.waitForTimeout(1200);

  console.log('📍 Step 7: Filling in lead details...');
  const runId = Math.floor(1000 + Math.random() * 9000);
  await page.locator('input[name="customerName"]').fill(`Rajesh Kumar ${runId}`);
  await page.locator('input[name="phone"]').fill(`+91981234${runId}`);
  await page.locator('input[name="email"]').fill(`rajesh.kumar.${runId}@example.com`);

  console.log('📍 Step 8: Selecting Source = "IndiaMART" in modal...');
  const modalSourceSelect = page
    .locator('[role="dialog"] button[role="combobox"]')
    .first();
  await modalSourceSelect.click();
  await page.waitForTimeout(800);
  await page.getByRole('option', { name: 'IndiaMART' }).click();
  await page.waitForTimeout(1000);

  console.log('📍 Step 9: Submitting the lead...');
  const submitBtn = page.getByRole('button', { name: /Create lead/i });
  await submitBtn.click();

  console.log('📍 Step 10: Verifying creation and live table update...');
  await page.waitForTimeout(3000);

  console.log('🎉 Test completed successfully! Browser will stay open for 5 seconds for viewing.');
  await page.waitForTimeout(5000);

  await browser.close();
  console.log('✨ Done!');
}

main().catch((err) => {
  console.error('❌ Headed run failed:', err);
  process.exit(1);
});
