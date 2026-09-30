import { chromium } from '@playwright/test';

const baseURL = process.env.BASE_URL ?? 'http://localhost:3000';
const executablePath =
  process.env.E2E_CHROMIUM_EXECUTABLE ??
  '/home/dhanushkr/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';

async function main() {
  console.log('🚀 Launching Chromium to test IndiaMART 1-click automatic setup...');
  const browser = await chromium.launch({
    executablePath,
    headless: false,
    slowMo: 800,
    args: ['--window-size=1440,920', '--window-position=50,50'],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 860 },
  });
  const page = await context.newPage();

  page.on('console', (msg) => console.log('BROWSER LOG:', msg.text()));
  page.on('response', async (res) => {
    if (res.url().includes('integration-connect-indiamart')) {
      console.log('EDGE STATUS:', res.status());
      try {
        console.log('EDGE BODY:', await res.text());
      } catch {}
    }
  });

  console.log('📍 Step 1: Navigating to CRM login page...');
  await page.goto(`${baseURL}/login`);
  await page.waitForTimeout(1000);

  console.log('📍 Step 2: Logging in as Client Admin (integrations authority)...');
  const switcherBtn = page.getByRole('button', { name: /Open development role switcher/ });
  await switcherBtn.click();
  await page.waitForTimeout(600);

  const clientAdminBtn = page.getByRole('button', { name: /Client Admin/ });
  await clientAdminBtn.click();
  await page.waitForURL(/\/client-admin\/dashboard/, { timeout: 30000 });
  console.log('✅ Logged in successfully as Client Admin!');

  console.log('📍 Step 3: Navigating to Integrations workspace...');
  await page.goto(`${baseURL}/client-admin/integrations`);
  await page.waitForTimeout(2000);

  console.log('📍 Step 4: Opening Connect Provider Dialog...');
  const connectBtn = page.getByRole('button', { name: /Connect provider/i });
  await connectBtn.click();
  await page.waitForTimeout(1500);

  console.log('📍 Step 5: Selecting "IndiaMART Seller Leads" from provider dropdown...');
  // The first combobox inside dialog is the Provider selector
  const dialog = page.getByRole('dialog');
  const providerSelect = dialog.getByRole('combobox').first();
  await providerSelect.click();
  await page.waitForTimeout(600);

  const indiamartOption = page.getByRole('option', { name: /IndiaMART Seller Leads/i });
  await indiamartOption.click();
  await page.waitForTimeout(1500);

  // Take screenshot of the IndiaMART auto-config form
  await page.screenshot({ path: 'scratch/indiamart_form_view.png' });
  console.log('📸 Screenshot taken: scratch/indiamart_form_view.png');

  console.log('📍 Step 6: Entering IndiaMART Seller Mobile & CRM Key...');
  const mobileInput = dialog.locator('input[name="indiamartMobile"]');
  await mobileInput.fill('9876543210');
  await page.waitForTimeout(400);

  const crmKeyInput = dialog.locator('input[name="indiamartCrmKey"]');
  await crmKeyInput.fill('test_crm_key_9876543210');
  await page.waitForTimeout(600);

  console.log('📍 Step 7: Submitting "Connect & Auto-Configure"...');
  const submitBtn = dialog.getByRole('button', { name: /Connect & Auto-Configure/i });
  await submitBtn.click();

  const doneBtn = dialog.getByRole('button', { name: /Done/i });
  await doneBtn.waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(1000);

  // Take screenshot of the success alert with webhook and round-robin status
  await page.screenshot({ path: 'scratch/indiamart_connected_alert.png' });
  console.log('📸 Screenshot taken: scratch/indiamart_connected_alert.png');

  console.log('📍 Step 8: Clicking Done to view connection in table...');
  await doneBtn.click();
  await page.waitForTimeout(3000);

  // Take final screenshot of the table with IndiaMART connected
  await page.screenshot({ path: 'scratch/indiamart_table_view.png' });
  console.log('📸 Screenshot taken: scratch/indiamart_table_view.png');

  console.log('🎉 IndiaMART automatic setup test completed successfully!');
  await page.waitForTimeout(2000);
  await browser.close();
}

main().catch((err) => {
  console.error('Error running test:', err);
  process.exit(1);
});
