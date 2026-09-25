import { test, expect as baseExpect } from '@playwright/test';

// `next dev` compiles each route and its client chunks on first visit, which
// can take several seconds per page. Assertions wait long enough for that
// one-time compile instead of reporting it as a missing CRM record.
const expect = baseExpect.configure({ timeout: 30_000 });

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const runId = Date.now().toString(36);
const customerName = `Amal browser QA ${runId}`;
const edgeCustomerName = `Amal edge QA ${runId}`;
const followupCustomerName = `Amal follow-up QA ${runId}`;
const cancelledFollowupCustomerName = `Amal cancel follow-up QA ${runId}`;
const handoffCancellationCustomerName = `Amal transfer cancel QA ${runId}`;
// Keep the requested Amal mobile on the primary end-to-end lead. Edge fixtures
// use distinct valid mobiles so repeated runs do not build one enormous phone
// group and distort the queue/search behavior being tested.
const edgePhoneSeed = Date.now() % 1_000_000_000;
const edgePhone = (offset) =>
  `+91 8${String((edgePhoneSeed + offset) % 1_000_000_000).padStart(9, '0')}`;
// A full local run owns one fresh lead from Telecaller creation through
// delivery. Supplying this variable remains useful for focused reruns against
// an existing lead, but must not be required for the complete suite.
const salesFlowLeadName = process.env.E2E_SALES_FLOW_LEAD ?? customerName;
// A delivered unit can never be allocated again, so a fixed demo VIN breaks
// every run after the first. The allocation step selects a currently AVAILABLE
// unit and records it here for the delivery step of the same serial run.
let allocationVin = process.env.E2E_ALLOCATION_VIN ?? null;

// CI and ordinary local runs use Playwright's managed Chromium. This opt-in is
// only for a workstation whose managed browser download is still in progress.
if (process.env.E2E_CHROMIUM_EXECUTABLE) {
  const visibleBrowser = process.env.E2E_VISIBLE_BROWSER === 'true';
  test.use({
    launchOptions: {
      executablePath: process.env.E2E_CHROMIUM_EXECUTABLE,
      // Keeps an observed local run on the left display at full usable size.
      // CI/headless runs do not opt into these desktop-window arguments.
      ...(visibleBrowser
        ? {
            headless: false,
            args: ['--start-fullscreen', '--window-position=0,0', '--window-size=1920,1080'],
          }
        : {}),
    },
    ...(visibleBrowser ? { viewport: null } : {}),
  });
}

async function signInAs(page, role) {
  await page.goto(`${baseURL}/login`);
  await page.getByRole('button', { name: /Open development role switcher/ }).click();
  const roleLabels = {
    telecaller: 'Telecaller / BDC Executive',
    'sales-consultant': 'Sales Consultant',
    inventory: 'Inventory Manager',
    finance: 'Finance Manager',
    insurance: 'Insurance Manager',
    rto: 'RTO Manager',
    delivery: 'Delivery Manager',
  };
  await page.getByRole('button', { name: roleLabels[role] }).click();
  const dashboardUrl = new RegExp(`/${role}/dashboard`);
  try {
    await page.waitForURL(dashboardUrl, { timeout: 30_000 });
  } catch {
    // Development demo login replaces the session cookie, then the access gate
    // immediately queries Supabase. During a local rebuild that first query can
    // briefly fail even though the new session is valid; use the gate's own
    // retry rather than misreporting it as a CRM workflow failure.
    const retryAccess = page.getByRole('button', { name: 'Check again' });
    if (await retryAccess.isVisible().catch(() => false)) {
      await retryAccess.click();
    } else {
      // The demo login has already written its local session before the
      // redirect. A local Next dev navigation can occasionally stall at `/`
      // without rendering the access gate, so re-enter at the intended route.
      await page.goto(`${baseURL}/${role}/dashboard`, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForURL(dashboardUrl, { timeout: 30_000 });
  }
}

async function searchForLead(page) {
  const search = page.getByPlaceholder('Search by name or mobile…');
  await search.fill(customerName);
}

async function openManualLeadDialog(page) {
  await page.goto(`${baseURL}/telecaller/my-leads`);
  await page.getByRole('button', { name: 'Add lead' }).click();
  return page.getByRole('dialog', { name: 'Add lead' });
}

function futureDateTimeInput(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60_000).toISOString().slice(0, 16);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchingRows(page, leadName) {
  return page.locator('tbody tr').filter({ hasText: leadName });
}

async function selectQuickView(page, label, status) {
  await page.getByRole('tab', { name: new RegExp(`^${escapeRegExp(label)}\\s+\\d+$`) }).click();
  await expect
    .poll(() => {
      const actual = new URL(page.url()).searchParams.get('status');
      return status === 'all' ? actual === null || actual === 'all' : actual === status;
    })
    .toBe(true);
}

async function expectLeadInQuickView(page, leadName, label, status) {
  await selectQuickView(page, label, status);
  const search = page.getByPlaceholder('Search by name or mobile…');
  await search.fill('');
  await search.fill(leadName);
  await expect(matchingRows(page, leadName)).toHaveCount(1, { timeout: 30_000 });
}

async function expectLeadOutsideQuickView(page, leadName, label, status) {
  await selectQuickView(page, label, status);
  const search = page.getByPlaceholder('Search by name or mobile…');
  await search.fill('');
  await search.fill(leadName);
  await expect(matchingRows(page, leadName)).toHaveCount(0, { timeout: 30_000 });
}

async function clickWhatsAppWithoutLeavingCrm(page, whatsapp) {
  // The CRM first-contact mutation is attached to this anchor's click handler.
  // Cancel only the browser's default external navigation; React still receives
  // the same click and persists the real contact event in this CRM session.
  await page.evaluate(() => {
    const cancelExternalNavigation = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('a[target="_blank"][href*="wa.me/"]')) return;
      event.preventDefault();
      document.removeEventListener('click', cancelExternalNavigation, true);
    };
    document.addEventListener('click', cancelExternalNavigation, true);
  });
  await whatsapp.click({ noWaitAfter: true });
}

async function salesLeadId(page, leadName) {
  await page.goto(`${baseURL}/sales-consultant/my-leads?status=all`);
  await page.getByPlaceholder('Search by name or mobile…').fill(leadName);
  const row = matchingRows(page, leadName).first();
  await expect(row).toContainText(leadName, { timeout: 30_000 });
  const href = await row
    .locator('a[href*="/sales-consultant/leads/"]')
    .first()
    .getAttribute('href');
  const leadId = href?.match(/\/sales-consultant\/leads\/([0-9a-f-]{36})(?:[?#]|$)/i)?.[1];
  expect(leadId, 'The Sales lead row must link to its lead detail record.').toBeTruthy();
  return leadId;
}

async function createOperationalCase(page, role, route, caseName) {
  await signInAs(page, role);
  await page.goto(`${baseURL}/${role}/${route}?status=all`);
  await page.getByPlaceholder('Search this department').fill(salesFlowLeadName);
  let row = matchingRows(page, salesFlowLeadName).first();
  if (!(await row.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Create case' }).click();
    const dialog = page.getByRole('dialog', { name: `Create ${caseName} case` });
    await expect(dialog).toBeVisible();
    await dialog.locator('#case-booking-search').fill(salesFlowLeadName);
    await dialog.getByRole('combobox').first().click();
    const option = page
      .getByRole('option', { name: new RegExp(escapeRegExp(salesFlowLeadName)) })
      .first();
    await expect(option).toBeVisible({ timeout: 25_000 });
    await option.click();
    await dialog.locator('#case-due-at').fill(futureDateTimeInput(96));
    await dialog.locator('#case-notes').fill(`Browser QA ${caseName.toLowerCase()} case.`);
    await dialog.getByRole('button', { name: 'Create case' }).click();
    await expect(dialog).toBeHidden({ timeout: 25_000 });
    row = matchingRows(page, salesFlowLeadName).first();
  }
  await expect(row).toContainText(salesFlowLeadName, { timeout: 25_000 });
  return openOperationalCase(page, caseName);
}

async function openOperationalCase(page, caseName) {
  const existingSheet = page.getByRole('dialog', { name: `${caseName} case` });
  if (await existingSheet.isVisible().catch(() => false)) {
    await expect(
      existingSheet.getByText(new RegExp(`^${escapeRegExp(caseName)} case$`, 'i')),
    ).toBeVisible({ timeout: 60_000 });
    await expect(existingSheet.getByText('Loading scoped case data.', { exact: true })).toBeHidden({
      timeout: 60_000,
    });
    return existingSheet;
  }
  const row = matchingRows(page, salesFlowLeadName).first();
  await expect(row).toContainText(salesFlowLeadName, { timeout: 25_000 });
  await row.getByRole('button').first().click();
  // Radix Sheet names differ slightly between browser engines; its modal role
  // is stable and the title is verified independently below.
  const sheet = page.locator('[role="dialog"]').last();
  await expect(sheet).toBeVisible({ timeout: 25_000 });
  await expect(sheet.getByText(new RegExp(`^${escapeRegExp(caseName)} case$`, 'i'))).toBeVisible({
    timeout: 60_000,
  });
  await expect(sheet.getByText('Loading scoped case data.', { exact: true })).toBeHidden({
    timeout: 60_000,
  });
  return sheet;
}

async function uploadCaseProof(page, sheet) {
  const upload = sheet.locator('input[type="file"]');
  await expect(upload).toBeAttached();
  const failedRequests = [];
  const onRequestFailed = (request) => {
    if (
      new URL(request.url()).hostname.endsWith('.storage.dev') ||
      request.url().includes('/functions/v1/')
    ) {
      failedRequests.push(
        `${new URL(request.url()).hostname}: ${request.failure()?.errorText}; headers=${Object.keys(request.headers()).sort().join(',')}`,
      );
    }
  };
  page.on('requestfailed', onRequestFailed);
  const presignResponse = page.waitForResponse(
    (response) => response.url().includes('/functions/v1/presign-upload'),
    { timeout: 30_000 },
  );
  const storageResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).hostname.endsWith('.storage.dev') &&
      response.request().method() === 'PUT',
    { timeout: 30_000 },
  );
  const finalizeResponse = page.waitForResponse(
    (response) => response.url().includes('/functions/v1/object-upload-finalize'),
    { timeout: 30_000 },
  );
  await upload.setInputFiles('public/logo.webp');
  const presigned = await presignResponse;
  expect(presigned.status(), 'The document service must issue a signed upload URL.').toBe(201);
  const presignBody = await presigned.json();
  const signedUrl = new URL(presignBody.data.upload_url);
  console.log(
    `Signed upload host: ${signedUrl.host}; headers=${signedUrl.searchParams.get('X-Amz-SignedHeaders')}`,
  );
  let uploaded;
  try {
    uploaded = await storageResponse;
  } catch (error) {
    console.log(`Signed upload request failures: ${failedRequests.join('; ') || 'none'}`);
    throw error;
  }
  if (!uploaded.ok()) {
    throw new Error(
      `Signed document upload failed with HTTP ${uploaded.status()}: ${(await uploaded.text()).slice(0, 500)}`,
    );
  }
  const finalized = await finalizeResponse;
  if (finalized.status() !== 201) {
    const body = await finalized.json().catch(() => null);
    throw new Error(
      `Document upload finalization failed with HTTP ${finalized.status()}: ${JSON.stringify(body)}`,
    );
  }
  try {
    await expect(sheet.getByRole('paragraph').filter({ hasText: 'logo.webp' }).first()).toBeVisible(
      { timeout: 30_000 },
    );
  } catch (error) {
    console.log(`Document upload request failures: ${failedRequests.join('; ') || 'none'}`);
    throw error;
  } finally {
    page.off('requestfailed', onRequestFailed);
  }
}

async function progressCase(sheet, nextStatus, patch = {}) {
  const statusLabel = nextStatus
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  const statusPicker = sheet.getByRole('combobox').first();
  await statusPicker.click();
  const option = sheet.page().getByRole('option', { name: statusLabel, exact: true }).last();
  await expect(option).toBeVisible({ timeout: 25_000 });
  await option.click();
  for (const [id, value] of Object.entries(patch)) {
    await sheet.locator(`#case-${id}`).fill(value);
  }
  await sheet.locator('#case-change-reason').fill(`Browser QA transition to ${nextStatus}.`);
  const update = sheet
    .page()
    .waitForResponse((response) => response.url().includes('/rpc/update_operational_case'), {
      timeout: 30_000,
    });
  await sheet.getByRole('button', { name: 'Save changes' }).click();
  const updateResponse = await update;
  if (!updateResponse.ok()) {
    throw new Error(
      `Operational case transition to ${nextStatus} failed: ${updateResponse.status()} ${JSON.stringify(await updateResponse.json())}`,
    );
  }
  // The picker shows the chosen value before anything is saved, so it is not
  // proof of persistence. A successful save refetches the case list and then
  // closes the sheet itself; wait for both so the next step reopens a fresh
  // record rather than being closed by that pending close mid-action.
  // A delivered case correctly leaves Upcoming Deliveries; the delivery test
  // confirms it on the Delivered page instead.
  if (nextStatus !== 'DELIVERED') await expectCaseRowStatus(sheet.page(), nextStatus);
  await expect(sheet.page().getByRole('dialog')).toHaveCount(0, { timeout: 30_000 });
}

async function expectCaseRowStatus(page, status) {
  await expect(
    page
      .locator('tbody tr')
      .filter({ hasText: salesFlowLeadName })
      .first()
      .locator('td')
      .filter({ hasText: new RegExp(`^${escapeRegExp(status.replaceAll('_', ' '))}$`) }),
  ).toHaveCount(1, { timeout: 30_000 });
}

async function caseStatus(sheet) {
  return (await sheet.getByRole('combobox').first().textContent())?.trim().replace(/^Keep\s+/, '');
}

function statusLabel(status) {
  return status
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function transitionBooking(page, targetStatus) {
  await signInAs(page, 'sales-consultant');
  await page.goto(
    `${baseURL}/sales-consultant/bookings?q=${encodeURIComponent(salesFlowLeadName)}`,
  );
  const row = matchingRows(page, salesFlowLeadName).first();
  await expect(row).toContainText(salesFlowLeadName, { timeout: 25_000 });
  const label = statusLabel(targetStatus);
  if (
    (await row
      .getByText(targetStatus.replaceAll('_', ' '), { exact: true })
      .isVisible()
      .catch(() => false)) ||
    (targetStatus === 'READY_FOR_DELIVERY' &&
      (await row
        .getByText('DELIVERED', { exact: true })
        .isVisible()
        .catch(() => false)))
  )
    return;
  await row.getByRole('button', { name: 'Booking actions' }).click();
  await page.getByRole('menuitem', { name: label }).click();
  const transition = page.getByRole('dialog', { name: label });
  await expect(transition).toBeVisible();
  const update = page.waitForResponse(
    (response) => response.url().includes('/rpc/transition_booking_status'),
    { timeout: 30_000 },
  );
  await transition.getByRole('button', { name: `Confirm ${label}` }).click();
  const updateResponse = await update;
  if (!updateResponse.ok()) {
    throw new Error(
      `Booking transition to ${targetStatus} failed: ${updateResponse.status()} ${JSON.stringify(await updateResponse.json())}`,
    );
  }
  await expect(transition).toBeHidden({ timeout: 25_000 });
  await expect(row.getByText(targetStatus.replaceAll('_', ' '), { exact: true })).toBeVisible({
    timeout: 25_000,
  });
}

async function transitionStockLifecycle(page, targetStatus) {
  expect(allocationVin, 'Run the allocation step first or set E2E_ALLOCATION_VIN.').toBeTruthy();
  await signInAs(page, 'inventory');
  await page.goto(`${baseURL}/inventory/vehicle-inventory?q=${encodeURIComponent(allocationVin)}`);
  const row = page.locator('tbody tr').filter({ hasText: allocationVin }).first();
  await expect(row).toContainText(allocationVin, { timeout: 25_000 });
  const targetLabel = targetStatus.replaceAll('_', ' ');
  const alreadyAtOrBeyondTarget =
    (await row
      .getByText(targetLabel, { exact: true })
      .isVisible()
      .catch(() => false)) ||
    (targetStatus === 'READY_FOR_DELIVERY' &&
      (await row
        .getByText('DELIVERED', { exact: true })
        .isVisible()
        .catch(() => false)));
  if (alreadyAtOrBeyondTarget) return;
  await row.getByRole('button', { name: 'Open' }).click();
  const stock = page
    .locator('[role="dialog"]')
    .filter({ has: page.getByText('Stock unit detail', { exact: true }) })
    .last();
  await expect(stock.getByText('Stock unit detail', { exact: true })).toBeVisible({
    timeout: 25_000,
  });
  // The sheet title renders before the scoped stock-detail query. The lifecycle
  // form signals that the record has fully loaded and can be mutated.
  await expect(stock.getByText('Change lifecycle status', { exact: true })).toBeVisible({
    timeout: 25_000,
  });
  const reason = stock.locator('input[placeholder="Reason"]');
  const form = reason.locator('xpath=ancestor::form');
  await form.getByRole('combobox').click();
  const option = page
    .locator('[role="option"]')
    .filter({ hasText: new RegExp(`^${escapeRegExp(targetLabel)}$`) });
  if (targetStatus === 'READY_FOR_DELIVERY' && (await option.count()) === 0) {
    await page.keyboard.press('Escape');
    return;
  }
  await expect(option).toBeVisible({ timeout: 25_000 });
  await option.click();
  await reason.fill(`Browser QA vehicle transition to ${targetStatus}.`);
  const update = page.waitForResponse(
    (response) => response.url().includes('/rpc/set_stock_unit_status'),
    { timeout: 30_000 },
  );
  await form.getByRole('button', { name: 'Update' }).click();
  const updateResponse = await update;
  if (!updateResponse.ok()) {
    throw new Error(
      `Stock transition to ${targetStatus} failed: ${updateResponse.status()} ${JSON.stringify(await updateResponse.json())}`,
    );
  }
  await expect(
    stock.locator('div.inline-flex').filter({ hasText: targetLabel }).first(),
  ).toContainText(targetLabel, { timeout: 25_000 });
}

async function completeDeliveryChecklist(sheet) {
  const checklist = sheet.locator('input[type="checkbox"]');
  const total = await checklist.count();
  expect(total, 'A delivery must have its generated completion checklist.').toBeGreaterThan(0);
  const page = sheet.page();
  // Ticks are a local draft: no request per item, one save for the whole sheet.
  const saves = [];
  const onRequest = (request) => {
    if (/\/rpc\/(save_delivery_checklist|set_delivery_checklist_item)/.test(request.url())) {
      saves.push(request.url());
    }
  };
  page.on('request', onRequest);
  try {
    const open = sheet.locator('input[type="checkbox"]:not(:checked)');
    while ((await open.count()) > 0) await open.first().click();
    await expect(sheet.locator('input[type="checkbox"]:checked')).toHaveCount(total);
    expect(saves, 'Ticking checklist items must not send requests.').toHaveLength(0);

    const save = sheet.getByRole('button', { name: /^Save checklist/ });
    if (await save.isEnabled()) {
      const response = page.waitForResponse(
        (candidate) => candidate.url().includes('/rpc/save_delivery_checklist'),
        { timeout: 30_000 },
      );
      await save.click();
      const saved = await response;
      if (!saved.ok()) {
        throw new Error(
          `Delivery checklist save failed: ${saved.status()} ${JSON.stringify(await saved.json())}`,
        );
      }
      await expect(save).toBeDisabled({ timeout: 25_000 });
      expect(saves.filter((url) => url.includes('save_delivery_checklist'))).toHaveLength(1);
      expect(saves.filter((url) => url.includes('set_delivery_checklist_item'))).toHaveLength(0);
    }
    await expect(sheet.locator('input[type="checkbox"]:checked')).toHaveCount(total, {
      timeout: 25_000,
    });
  } finally {
    page.off('request', onRequest);
  }
}

async function completeDeliveryPdi(page, sheet) {
  await sheet.getByRole('button', { name: 'Open PDI Sheet' }).click();
  const pdi = page.getByRole('dialog', { name: 'Pre-Delivery Inspection (PDI)' });
  await expect(pdi).toBeVisible({ timeout: 25_000 });
  await expect(pdi.getByText('Total Points', { exact: true })).toBeVisible({ timeout: 25_000 });
  if (
    await pdi
      .getByText('PASSED', { exact: true })
      .isVisible()
      .catch(() => false)
  ) {
    await pdi.getByText('Close', { exact: true }).click();
    await expect(pdi).toBeHidden({ timeout: 25_000 });
    return;
  }
  // Pass clicks are a local draft; the only PDI write is the final certify.
  const pdiWrites = [];
  const onPdiRequest = (request) => {
    if (/\/rpc\/(update_pdi_item_result|save_pdi_inspection)/.test(request.url())) {
      pdiWrites.push(request.url());
    }
  };
  page.on('request', onPdiRequest);
  const passes = pdi.getByRole('button', { name: 'Pass', exact: true });
  const pointCount = await passes.count();
  expect(pointCount, 'The PDI must load its inspection points.').toBeGreaterThan(0);
  for (let index = 0; index < pointCount; index += 1) {
    const pass = passes.nth(index);
    if (!(await pass.getAttribute('class'))?.includes('bg-emerald-600')) {
      await pass.click();
      await expect(pass).toHaveClass(/bg-emerald-600/, { timeout: 25_000 });
    }
  }
  const notes = pdi.getByPlaceholder('Overall PDI notes (optional)...');
  await expect(notes).toBeVisible({ timeout: 25_000 });
  await notes.fill('Browser QA PDI completed without defects.');
  const certification = page.waitForResponse(
    (response) => response.url().includes('/rpc/save_pdi_inspection'),
    { timeout: 30_000 },
  );
  expect(pdiWrites, 'Marking PDI points must not call the server per click.').toHaveLength(0);
  await pdi.getByRole('button', { name: 'Sign & Certify PDI' }).click();
  const certificationResponse = await certification;
  if (!certificationResponse.ok()) {
    throw new Error(
      `PDI certification failed: ${certificationResponse.status()} ${JSON.stringify(await certificationResponse.json())}`,
    );
  }
  await expect(pdi).toBeHidden({ timeout: 25_000 });
  page.off('request', onPdiRequest);
  expect(pdiWrites, 'Certifying the PDI must be a single request.').toHaveLength(1);
}

async function selectDeliverySignature(page, sheet) {
  // The progress form has status, priority, then the delivery-only signature selector.
  const picker = sheet.getByRole('combobox').nth(2);
  await picker.click();
  const proof = page.getByRole('option', { name: 'logo.webp', exact: true }).last();
  await expect(proof).toBeVisible({ timeout: 25_000 });
  await proof.click();
}

test.describe('manual lead: Telecaller to Sales', () => {
  // Each step continues the lead created by the first test. A failure must stop
  // the chain: Playwright would otherwise restart the worker, generate a new
  // runId, and report every later step against a lead that was never created.
  test.describe.configure({ mode: 'serial' });
  // A cold scoped-case query can take tens of seconds after each persisted
  // workflow transition. Finance/RTO legitimately reopen a case several
  // times, so the suite-level limit must cover that audited work rather than
  // terminating a valid department flow midway through it.
  test.setTimeout(240_000);

  test('creates Amal as a Manual lead, records contact, and hands the lead to Sales', async ({
    page,
  }) => {
    await signInAs(page, 'telecaller');
    const createDialog = await openManualLeadDialog(page);
    await expect(createDialog).toBeVisible();
    await createDialog.getByLabel('Customer name').fill(customerName);
    await createDialog.getByLabel('Phone').fill('+91 85939 39234');
    await createDialog.getByRole('button', { name: 'Create lead' }).click();
    await expect(createDialog).toBeHidden({ timeout: 25_000 });

    await searchForLead(page);
    const row = page.locator('tbody tr').filter({ hasText: customerName }).first();
    await expect(row.getByText('New', { exact: true })).toBeVisible();
    await expect(row).toContainText('Manual');

    // A Telecaller works one active queue at a time. Assert the actual tabs,
    // not merely the All search result: a fresh enquiry is only in New.
    await expectLeadInQuickView(page, customerName, 'New', 'new-today');
    await expectLeadOutsideQuickView(page, customerName, 'Contacted', 'contacted');
    await expectLeadOutsideQuickView(page, customerName, 'Follow-up', 'follow-up');
    await expectLeadOutsideQuickView(
      page,
      customerName,
      'Transferred to Sales',
      'transferred-to-sales',
    );
    await expectLeadOutsideQuickView(page, customerName, 'Lost', 'lost');
    await selectQuickView(page, 'All', 'all');
    // Quick-view changes issue independent server queries. Reapply the
    // page-local search before using row actions so this primary lead is read
    // from the refreshed All result rather than a stale tab response.
    await searchForLead(page);

    // Pending is time-derived (24 hours without contact), so it is asserted by
    // its absence on a just-created lead rather than faking time in production.
    await expect(row.getByText('Pending', { exact: true })).toHaveCount(0);

    // The call button must be available for this customer, but opening its
    // `tel:` choice hands control to the operating system, not the CRM.
    await expect(row.getByLabel(`Call ${customerName}`)).toBeVisible();
    // WhatsApp is an equally valid first-contact channel and updates the same
    // Contacted workflow. Suppress its external tab so the test stays in CRM.
    const whatsapp = row.getByLabel(`WhatsApp ${customerName}`);
    await expect(whatsapp).toHaveAttribute('href', /wa\.me\/918593939234/);
    // The CRM handler records the contact, while the link opens WhatsApp in a
    // separate tab. Close that external tab immediately so observed browser
    // runs never leave a misleading ERR_FAILED page on the user's display.
    await clickWhatsAppWithoutLeavingCrm(page, whatsapp);
    // The contact RPC invalidates the server-paginated lead list. A request
    // already in flight can return the pre-contact row once, so wait for the
    // subsequent fresh result rather than treating that normal race as failure.
    await expect(row.getByText('Contacted', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expectLeadInQuickView(page, customerName, 'Contacted', 'contacted');
    await expectLeadOutsideQuickView(page, customerName, 'New', 'new-today');
    await expectLeadOutsideQuickView(page, customerName, 'Follow-up', 'follow-up');
    await expectLeadOutsideQuickView(
      page,
      customerName,
      'Transferred to Sales',
      'transferred-to-sales',
    );
    await expectLeadOutsideQuickView(page, customerName, 'Lost', 'lost');
    await selectQuickView(page, 'All', 'all');

    // A lead must explicitly link to a Customer before it can enter Sales.
    // This preserves the Customer-360 ownership model instead of handoffing an
    // anonymous enquiry.
    await row.getByLabel(`Review possible customer match for ${customerName}`).click();
    const customerMatch = page.getByRole('dialog', {
      name: /Create customer|Review possible customer match/,
    });
    await expect(customerMatch).toBeVisible();
    const decisionReason = customerMatch.getByLabel(/Decision reason/);
    if (await decisionReason.isVisible().catch(() => false)) {
      await decisionReason.fill('This is a separate enquiry recorded during browser QA.');
    }
    await Promise.all([
      page.waitForURL(new RegExp(`/${'telecaller'}/customers/`)),
      customerMatch.getByRole('button', { name: 'Create and link customer' }).click(),
    ]);
    await expect(customerMatch).toBeHidden();

    await page.goto(`${baseURL}/telecaller/my-leads`);
    await searchForLead(page);
    const linkedRow = page.locator('tbody tr').filter({ hasText: customerName }).first();
    await expect(linkedRow.getByText('Contacted', { exact: true })).toBeVisible();
    await linkedRow.getByLabel(`Transfer ${customerName} to Sales`).click();
    const handoff = page.getByRole('dialog', { name: 'Transfer to Sales' });
    await handoff.getByLabel('Reason').fill('Qualified during browser QA');
    await handoff.getByRole('combobox').click();
    await page.getByRole('option', { name: /Dhanush Kumar/ }).click();
    await handoff.getByRole('button', { name: 'Transfer to Sales' }).click();
    await expect(handoff).toBeHidden();
    await expect(linkedRow.getByText('Transferred to Sales', { exact: true })).toBeVisible();
    await expectLeadInQuickView(page, customerName, 'Transferred to Sales', 'transferred-to-sales');
    await expectLeadOutsideQuickView(page, customerName, 'New', 'new-today');
    await expectLeadOutsideQuickView(page, customerName, 'Contacted', 'contacted');
    await expectLeadOutsideQuickView(page, customerName, 'Follow-up', 'follow-up');
    await expectLeadOutsideQuickView(page, customerName, 'Lost', 'lost');

    await signInAs(page, 'sales-consultant');
    await page.goto(`${baseURL}/sales-consultant/my-leads?status=all`);
    await searchForLead(page);
    const salesRow = page.locator('tbody tr').filter({ hasText: customerName }).first();
    await expect(salesRow.getByText('Transferred to Sales', { exact: true })).toBeVisible();

    // The receiving consultant records their own first contact, then creates
    // an actionable follow-up from the same lead row.
    const salesWhatsapp = salesRow.getByLabel(`WhatsApp ${customerName}`);
    await clickWhatsAppWithoutLeavingCrm(page, salesWhatsapp);
    await expect(salesRow.getByText('Sales Contacted', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await salesRow.getByLabel(`Schedule a follow-up for ${customerName}`).click();
    await page.getByRole('menuitem', { name: 'Customer Callback' }).click();
    const followup = page.getByRole('dialog', { name: 'Schedule follow-up' });
    await followup.locator('#followups-scheduled-at').fill(futureDateTimeInput());
    await followup.getByRole('button', { name: 'Save' }).click();
    await expect(followup).toBeHidden();
    await expect(salesRow.getByText('Follow-up', { exact: true })).toBeVisible({ timeout: 30_000 });
  });

  test('enforces Customer linking before Sales and prevents a Lost lead from handoff', async ({
    page,
  }) => {
    await signInAs(page, 'telecaller');
    const createDialog = await openManualLeadDialog(page);
    await expect(createDialog).toBeVisible();
    await createDialog.getByLabel('Customer name').fill(edgeCustomerName);
    await createDialog.getByLabel('Phone').fill(edgePhone(1));
    const createResponse = page.waitForResponse(
      (response) => response.url().includes('/rpc/create_lead'),
      { timeout: 30_000 },
    );
    await createDialog.getByRole('button', { name: 'Create lead' }).click();
    const response = await createResponse;
    if (!response.ok()) {
      throw new Error(`Manual lead creation failed: ${response.status()} ${await response.text()}`);
    }
    await expect(createDialog).toBeHidden({ timeout: 25_000 });

    const search = page.getByPlaceholder('Search by name or mobile…');
    await search.fill(edgeCustomerName);
    const row = page.locator('tbody tr').filter({ hasText: edgeCustomerName }).first();
    const transfer = row.getByLabel(`Transfer ${edgeCustomerName} to Sales`);
    await expect(transfer).toBeDisabled();

    await row.getByLabel('More lead actions').click();
    await page.getByRole('menuitem', { name: 'Mark as lost' }).click();
    const lostDialog = page.getByRole('dialog', { name: 'Mark lead as Lost' });
    await lostDialog.getByLabel('Lost reason').fill('Customer is not proceeding');
    await lostDialog.getByLabel('Change reason').fill('Browser QA negative-path verification');
    await lostDialog.getByRole('button', { name: 'Mark as Lost' }).click();
    await expect(lostDialog).toBeHidden();
    await expect(row.getByText('Lost', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(transfer).toBeDisabled();

    // Lost is terminal: it must leave every active Telecaller queue, including
    // New even when the lead was never contacted.
    await expectLeadInQuickView(page, edgeCustomerName, 'Lost', 'lost');
    await expectLeadOutsideQuickView(page, edgeCustomerName, 'New', 'new-today');
    await expectLeadOutsideQuickView(page, edgeCustomerName, 'Contacted', 'contacted');
    await expectLeadOutsideQuickView(page, edgeCustomerName, 'Follow-up', 'follow-up');
    await expectLeadOutsideQuickView(
      page,
      edgeCustomerName,
      'Transferred to Sales',
      'transferred-to-sales',
    );
  });

  test('places an open Telecaller follow-up only in the Follow-up tab', async ({ page }) => {
    await signInAs(page, 'telecaller');
    const createDialog = await openManualLeadDialog(page);
    await createDialog.getByLabel('Customer name').fill(followupCustomerName);
    await createDialog.getByLabel('Phone').fill(edgePhone(2));
    await createDialog.getByRole('button', { name: 'Create lead' }).click();
    await expect(createDialog).toBeHidden({ timeout: 25_000 });

    const search = page.getByPlaceholder('Search by name or mobile…');
    await search.fill(followupCustomerName);
    const row = matchingRows(page, followupCustomerName).first();
    await expect(row.getByText('New', { exact: true })).toBeVisible();
    await clickWhatsAppWithoutLeavingCrm(page, row.getByLabel(`WhatsApp ${followupCustomerName}`));
    await expect(row.getByText('Contacted', { exact: true })).toBeVisible({ timeout: 30_000 });

    const followupTrigger = row.getByLabel(`Schedule a follow-up for ${followupCustomerName}`);
    await expect(followupTrigger).toBeVisible();
    await followupTrigger.click();
    const callbackOption = page.getByRole('menuitem', { name: 'Customer Callback' });
    await expect(callbackOption).toBeVisible();
    await callbackOption.click();
    const followup = page.getByRole('dialog', { name: 'Schedule follow-up' });
    await expect(followup).toBeVisible();
    await followup.locator('#followups-scheduled-at').fill(futureDateTimeInput());
    await followup.getByRole('button', { name: 'Save' }).click();
    await expect(followup).toBeHidden({ timeout: 25_000 });

    await expectLeadInQuickView(page, followupCustomerName, 'Follow-up', 'follow-up');
    await expectLeadOutsideQuickView(page, followupCustomerName, 'New', 'new-today');
    await expectLeadOutsideQuickView(page, followupCustomerName, 'Contacted', 'contacted');
    await expectLeadOutsideQuickView(
      page,
      followupCustomerName,
      'Transferred to Sales',
      'transferred-to-sales',
    );
    await expectLeadOutsideQuickView(page, followupCustomerName, 'Lost', 'lost');
  });

  test('blocks Sales handoff until a Telecaller cancels the open follow-up', async ({ page }) => {
    await signInAs(page, 'telecaller');
    const createDialog = await openManualLeadDialog(page);
    await createDialog.getByLabel('Customer name').fill(cancelledFollowupCustomerName);
    await createDialog.getByLabel('Phone').fill(edgePhone(3));
    const createResponse = page.waitForResponse(
      (response) => response.url().includes('/rpc/create_lead'),
      { timeout: 30_000 },
    );
    await createDialog.getByRole('button', { name: 'Create lead' }).click();
    const response = await createResponse;
    if (!response.ok()) {
      throw new Error(`Manual lead creation failed: ${response.status()} ${await response.text()}`);
    }
    await expect(createDialog).toBeHidden({ timeout: 25_000 });

    await page.getByPlaceholder('Search by name or mobile…').fill(cancelledFollowupCustomerName);
    const row = matchingRows(page, cancelledFollowupCustomerName).first();
    await clickWhatsAppWithoutLeavingCrm(
      page,
      row.getByLabel(`WhatsApp ${cancelledFollowupCustomerName}`),
    );
    await expect(row.getByText('Contacted', { exact: true })).toBeVisible({ timeout: 30_000 });
    // Handoff requires a Customer link independently of follow-up state. Link
    // first so this test exercises the pending-follow-up guard rather than the
    // earlier Customer-ownership guard.
    await row
      .getByLabel(`Review possible customer match for ${cancelledFollowupCustomerName}`)
      .click();
    const customerMatch = page.getByRole('dialog', {
      name: /Create customer|Review possible customer match/,
    });
    const decisionReason = customerMatch.getByLabel(/Decision reason/);
    if (await decisionReason.isVisible().catch(() => false)) {
      await decisionReason.fill('Separate browser QA customer for follow-up cancellation.');
    }
    await Promise.all([
      page.waitForURL(/\/telecaller\/customers\//),
      customerMatch.getByRole('button', { name: 'Create and link customer' }).click(),
    ]);
    await page.goto(`${baseURL}/telecaller/my-leads`);
    await page.getByPlaceholder('Search by name or mobile…').fill(cancelledFollowupCustomerName);
    const linkedRow = matchingRows(page, cancelledFollowupCustomerName).first();
    await linkedRow.getByLabel(`Schedule a follow-up for ${cancelledFollowupCustomerName}`).click();
    await page.getByRole('menuitem', { name: 'Customer Callback' }).click();
    const schedule = page.getByRole('dialog', { name: 'Schedule follow-up' });
    await schedule.locator('#followups-scheduled-at').fill(futureDateTimeInput());
    await schedule.getByRole('button', { name: 'Save' }).click();
    await expect(schedule).toBeHidden({ timeout: 25_000 });
    await expectLeadInQuickView(page, cancelledFollowupCustomerName, 'Follow-up', 'follow-up');

    await selectQuickView(page, 'All', 'all');
    const allRow = matchingRows(page, cancelledFollowupCustomerName).first();
    await expect(
      allRow.getByLabel(`Transfer ${cancelledFollowupCustomerName} to Sales`),
    ).toBeDisabled();
    // Resolve the original work item in the Follow-ups workspace, where the
    // actual OPEN row and its optimistic version are authoritative.
    await Promise.all([
      page.waitForURL(/\/telecaller\/follow-ups\?status=all&focus=/),
      allRow.getByLabel(`Open follow-ups for ${cancelledFollowupCustomerName}`).click(),
    ]);
    await page
      .getByPlaceholder('Search customer, phone, lead or work ID…')
      .fill(cancelledFollowupCustomerName);
    const followupRow = matchingRows(page, cancelledFollowupCustomerName).first();
    await expect(followupRow).toContainText(cancelledFollowupCustomerName, { timeout: 25_000 });
    await followupRow.getByRole('button', { name: 'Cancel' }).click();
    const cancel = page.getByRole('dialog', { name: 'Cancel follow-up' });
    await cancel.locator('#cancel-work-note').fill('Customer requested a later call.');
    await cancel.getByRole('button', { name: 'Confirm cancellation' }).click();
    await expect(cancel).toBeHidden({ timeout: 25_000 });
    await page.goto(`${baseURL}/telecaller/my-leads`);
    await page.getByPlaceholder('Search by name or mobile…').fill(cancelledFollowupCustomerName);
    await expectLeadInQuickView(page, cancelledFollowupCustomerName, 'Contacted', 'contacted');
    await expectLeadOutsideQuickView(page, cancelledFollowupCustomerName, 'Follow-up', 'follow-up');
  });

  test('keeps a dismissed handoff unchanged and lets its Telecaller reverse a confirmed transfer', async ({
    page,
  }) => {
    await signInAs(page, 'telecaller');
    const createDialog = await openManualLeadDialog(page);
    await createDialog.getByLabel('Customer name').fill(handoffCancellationCustomerName);
    await createDialog.getByLabel('Phone').fill(edgePhone(4));
    await createDialog.getByRole('button', { name: 'Create lead' }).click();
    await expect(createDialog).toBeHidden({ timeout: 25_000 });
    await page.getByPlaceholder('Search by name or mobile…').fill(handoffCancellationCustomerName);
    const row = matchingRows(page, handoffCancellationCustomerName).first();
    await clickWhatsAppWithoutLeavingCrm(
      page,
      row.getByLabel(`WhatsApp ${handoffCancellationCustomerName}`),
    );
    await expect(row.getByText('Contacted', { exact: true })).toBeVisible({ timeout: 30_000 });
    await row
      .getByLabel(`Review possible customer match for ${handoffCancellationCustomerName}`)
      .click();
    const customerMatch = page.getByRole('dialog', {
      name: /Create customer|Review possible customer match/,
    });
    const decisionReason = customerMatch.getByLabel(/Decision reason/);
    if (await decisionReason.isVisible().catch(() => false)) {
      await decisionReason.fill('Separate browser QA customer for transfer cancellation.');
    }
    await Promise.all([
      page.waitForURL(/\/telecaller\/customers\//),
      customerMatch.getByRole('button', { name: 'Create and link customer' }).click(),
    ]);
    await page.goto(`${baseURL}/telecaller/my-leads`);
    await page.getByPlaceholder('Search by name or mobile…').fill(handoffCancellationCustomerName);
    const linkedRow = matchingRows(page, handoffCancellationCustomerName).first();
    await linkedRow.getByLabel(`Transfer ${handoffCancellationCustomerName} to Sales`).click();
    const handoff = page.getByRole('dialog', { name: 'Transfer to Sales' });
    await handoff.getByRole('button', { name: 'Cancel' }).click();
    await expect(handoff).toBeHidden();
    await expect(linkedRow.getByText('Contacted', { exact: true })).toBeVisible();

    await linkedRow.getByLabel(`Transfer ${handoffCancellationCustomerName} to Sales`).click();
    await handoff.getByLabel('Reason').fill('Qualified during Telecaller edge QA.');
    await handoff.getByRole('combobox').click();
    await page.getByRole('option', { name: /Dhanush Kumar/ }).click();
    await handoff.getByRole('button', { name: 'Transfer to Sales' }).click();
    await expect(handoff).toBeHidden({ timeout: 25_000 });
    await expect(linkedRow.getByText('Transferred to Sales', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await linkedRow.getByLabel(`Cancel transfer for ${handoffCancellationCustomerName}`).click();
    const reverse = page.getByRole('dialog', { name: 'Cancel transfer to Sales?' });
    await reverse
      .getByPlaceholder('Why should this lead return to the Telecaller queue?')
      .fill('Customer needs a Telecaller follow-up first.');
    await reverse.getByRole('button', { name: 'Cancel transfer' }).click();
    await expect(reverse).toBeHidden({ timeout: 25_000 });
    await expect(linkedRow.getByText('Contacted', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('Sales Consultant contacts and schedules a follow-up for an existing Sales lead', async ({
    page,
  }) => {
    test.skip(!salesFlowLeadName, 'Set E2E_SALES_FLOW_LEAD to continue an existing Sales lead.');
    await signInAs(page, 'sales-consultant');
    await page.goto(`${baseURL}/sales-consultant/my-leads?status=all`);
    await page.getByPlaceholder('Search by name or mobile…').fill(salesFlowLeadName);
    const row = page.locator('tbody tr').filter({ hasText: salesFlowLeadName }).first();
    // The chain's own lead already carries the handoff's Sales follow-up, so
    // its stage reads the derived "Follow-up" rather than the lifecycle value.
    await expect(row.getByText(/^(Transferred to Sales|Sales Contacted|Follow-up)$/)).toBeVisible();

    // The Sales-contact event was recorded in the earlier browser run for this
    // persisted lead. Keep the contact affordance visible and advance to the
    // follow-up action without opening another external WhatsApp tab.
    await expect(row.getByLabel(`WhatsApp ${salesFlowLeadName}`)).toBeVisible();

    await row.getByLabel(`Schedule a follow-up for ${salesFlowLeadName}`).click();
    await page.getByRole('menuitem', { name: 'Customer Callback' }).click();
    const followup = page.getByRole('dialog', { name: 'Schedule follow-up' });
    const pending = page.getByRole('dialog', { name: 'Follow-up still pending' });
    await expect(followup.or(pending)).toBeVisible({ timeout: 25_000 });

    if (await pending.isVisible()) {
      // A lead owes at most one open follow-up: scheduling another must first
      // resolve the handoff's, so the guard lists it and leaves it untouched on Close.
      await expect(pending).toContainText('Customer Callback');
      await expect(pending.getByRole('button', { name: 'Complete follow-up' })).toBeEnabled();
      await expect(pending.getByRole('button', { name: 'Cancel follow-up' })).toBeEnabled();
      await pending.getByRole('button', { name: 'Close' }).click();
      await expect(pending).toBeHidden();
      await expect(followup).toBeHidden();
    } else {
      await followup.locator('#followups-scheduled-at').fill(futureDateTimeInput());
      await followup.getByRole('button', { name: 'Save' }).click();
      await expect(followup).toBeHidden({ timeout: 25_000 });
    }
    await expect(row.getByText('Follow-up', { exact: true })).toBeVisible({ timeout: 30_000 });
  });

  test('Sales Consultant completes a follow-up by scheduling an appointment', async ({ page }) => {
    test.skip(!salesFlowLeadName, 'Set E2E_SALES_FLOW_LEAD to continue an existing Sales lead.');
    await signInAs(page, 'sales-consultant');
    await page.goto(
      `${baseURL}/sales-consultant/follow-ups?status=all&q=${encodeURIComponent(salesFlowLeadName)}`,
    );
    const row = matchingRows(page, salesFlowLeadName).first();
    await expect(row).toContainText(salesFlowLeadName, { timeout: 30_000 });
    await row.getByRole('button', { name: 'Complete' }).click();

    const completeFollowup = page.getByRole('dialog', { name: 'Complete follow-up' });
    await expect(completeFollowup).toBeVisible();
    await completeFollowup.getByRole('button', { name: /Book an appointment/ }).click();
    await completeFollowup.getByRole('button', { name: 'Next: book appointment' }).click();

    const appointment = page.getByRole('dialog', { name: 'Schedule appointment' });
    await expect(appointment).toBeVisible();
    await appointment.locator('#appointments-scheduled-at').fill(futureDateTimeInput(48));
    await appointment
      .locator('#appointment-notes')
      .fill('Browser QA appointment after Sales follow-up.');
    await appointment.getByRole('button', { name: 'Save' }).click();
    await expect(appointment).toBeHidden({ timeout: 25_000 });
    await expect(completeFollowup).toBeHidden({ timeout: 25_000 });

    await page.goto(
      `${baseURL}/sales-consultant/appointments?q=${encodeURIComponent(salesFlowLeadName)}`,
    );
    await expect(matchingRows(page, salesFlowLeadName).first()).toContainText(salesFlowLeadName, {
      timeout: 30_000,
    });
  });

  test('Sales Consultant schedules, completes, and finalizes a test drive', async ({ page }) => {
    test.skip(!salesFlowLeadName, 'Set E2E_SALES_FLOW_LEAD to continue an existing Sales lead.');
    await signInAs(page, 'sales-consultant');
    const leadId = await salesLeadId(page, salesFlowLeadName);
    const testDriveRegistration = `KA QA ${runId.toUpperCase()}`;

    await page.goto(
      `${baseURL}/sales-consultant/test-drives?action=create&lead=${leadId}&q=${encodeURIComponent(salesFlowLeadName)}`,
    );
    const leadPicker = page.getByRole('combobox', { name: 'Find assigned customer or lead' });
    // This lookup runs through the scoped option RPC and can be slower than a
    // normal list query on a cold local Supabase connection. It must resolve
    // before a stock vehicle can be selected; do not race it with the generic
    // Playwright expectation timeout.
    await expect(leadPicker).toBeEnabled({ timeout: 35_000 });
    await expect(page.getByPlaceholder('Filled from customer record')).toHaveValue(
      /\d(?:\D*\d){9}/,
      {
        timeout: 35_000,
      },
    );

    const vehiclePicker = page.getByRole('combobox', { name: 'Available test-drive vehicle' });
    await expect(vehiclePicker).toBeEnabled({ timeout: 30_000 });
    await expect(vehiclePicker.locator('svg.animate-spin')).toHaveCount(0, { timeout: 30_000 });
    await vehiclePicker.click();
    const vehicleOption = page.getByRole('option').first();
    await expect(vehicleOption).toBeVisible({ timeout: 30_000 });
    await vehicleOption.click();
    await page.locator('#test-drive-registration-number').fill(testDriveRegistration);
    await page.locator('input[type="datetime-local"]').fill(futureDateTimeInput(72));
    await page.getByPlaceholder('Showroom entrance').fill('Browser QA showroom');
    await page.getByPlaceholder('Planned destination').fill('Browser QA destination');
    await page.getByRole('button', { name: 'Save test drive' }).click();

    await page.goto(
      `${baseURL}/sales-consultant/test-drives?view=all&q=${encodeURIComponent(salesFlowLeadName)}`,
    );
    let driveRow = matchingRows(page, salesFlowLeadName)
      .filter({ hasText: testDriveRegistration })
      .filter({ has: page.getByText('READY', { exact: true }) })
      .first();
    await expect(driveRow.getByText('READY', { exact: true })).toBeVisible({ timeout: 25_000 });
    const currentDriveAtStatus = (status) =>
      matchingRows(page, salesFlowLeadName)
        .filter({ hasText: testDriveRegistration })
        .filter({ has: page.getByText(status, { exact: true }) })
        .first();

    await driveRow.getByRole('button', { name: 'Test-drive actions' }).click();
    await page.getByRole('menuitem', { name: 'Start test drive' }).click();
    const start = page.getByRole('dialog', { name: 'Start test drive' });
    await start.locator('#test-drive-start-latitude').fill('12.9716');
    await start.locator('#test-drive-start-longitude').fill('77.5946');
    await start.locator('#test-drive-start-odometer').fill('1000');
    await start.getByRole('button', { name: 'Start test drive' }).click();
    await expect(start).toBeHidden({ timeout: 25_000 });

    driveRow = currentDriveAtStatus('ACTIVE');
    await expect(driveRow.getByText('ACTIVE', { exact: true })).toBeVisible({ timeout: 25_000 });
    await driveRow.getByRole('button', { name: 'Test-drive actions' }).click();
    await page.getByRole('menuitem', { name: 'Complete test drive' }).click();
    const complete = page.getByRole('dialog', { name: 'Complete test drive' });
    await complete.locator('#test-drive-end-latitude').fill('12.9750');
    await complete.locator('#test-drive-end-longitude').fill('77.5990');
    await complete.locator('#test-drive-end-odometer').fill('1002');
    await complete.getByRole('button', { name: 'Complete test drive' }).click();
    await expect(complete).toBeHidden({ timeout: 25_000 });

    driveRow = currentDriveAtStatus('COMPLETED');
    await expect(driveRow.getByText('COMPLETED', { exact: true })).toBeVisible({ timeout: 25_000 });
    await driveRow.getByRole('button', { name: 'Test-drive actions' }).click();
    await page.getByRole('menuitem', { name: 'Finalize route summary' }).click();
    const finalize = page.getByRole('dialog', { name: 'Finalize route summary' });
    await finalize.getByRole('button', { name: 'Finalize route' }).click();
    await expect(finalize).toBeHidden({ timeout: 25_000 });
  });

  test('Sales Consultant creates a quotation from the Sales lead', async ({ page }) => {
    test.skip(!salesFlowLeadName, 'Set E2E_SALES_FLOW_LEAD to continue an existing Sales lead.');
    await signInAs(page, 'sales-consultant');
    const leadId = await salesLeadId(page, salesFlowLeadName);
    await page.goto(`${baseURL}/sales-consultant/quotations?action=create&lead=${leadId}`);

    const customer = page.getByRole('combobox', { name: 'Customer opportunity' });
    await expect(customer).toHaveText(salesFlowLeadName, { timeout: 35_000 });
    // Quotations support both a manual model (when stock is unavailable) and
    // stock-backed Model/Variant/Colour selectors. Exercise whichever branch
    // the current branch inventory exposes.
    const manualModel = page.getByRole('textbox', { name: 'Enter model' });
    if (await manualModel.isVisible().catch(() => false)) {
      await manualModel.fill('Browser QA Sedan');
    } else {
      const modelPicker = page.getByRole('combobox').nth(1);
      await modelPicker.click();
      const modelOption = page.getByRole('option').first();
      await expect(modelOption).toBeVisible({ timeout: 30_000 });
      await modelOption.click();
    }
    await page.locator('#quotation-vehicle').fill('1500000');
    await page
      .locator('#quotation-validity')
      .fill(new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString().slice(0, 10));
    await page.getByRole('button', { name: 'Save Draft' }).first().click();
    await page.goto(
      `${baseURL}/sales-consultant/quotations?q=${encodeURIComponent(salesFlowLeadName)}`,
    );
    await expect(matchingRows(page, salesFlowLeadName).first()).toContainText(salesFlowLeadName, {
      timeout: 25_000,
    });
  });

  test('Sales Consultant accepts the quotation and creates a finance booking', async ({ page }) => {
    test.skip(!salesFlowLeadName, 'Set E2E_SALES_FLOW_LEAD to continue an existing Sales lead.');
    await signInAs(page, 'sales-consultant');
    await page.goto(
      `${baseURL}/sales-consultant/quotations?status=draft&q=${encodeURIComponent(salesFlowLeadName)}`,
    );
    let quotationRow = matchingRows(page, salesFlowLeadName).first();
    await expect(quotationRow.getByText('DRAFT', { exact: true })).toBeVisible({ timeout: 25_000 });
    await quotationRow.getByRole('button', { name: 'Quotation actions' }).click();
    await page.getByRole('menuitem', { name: 'Mark sent' }).click();
    let transition = page.getByRole('dialog', { name: 'Sent' });
    await transition.getByRole('button', { name: 'Confirm Sent' }).click();
    await expect(transition).toBeHidden({ timeout: 25_000 });

    await page.goto(
      `${baseURL}/sales-consultant/quotations?status=sent&q=${encodeURIComponent(salesFlowLeadName)}`,
    );
    quotationRow = matchingRows(page, salesFlowLeadName).first();
    await expect(quotationRow.getByText('SENT', { exact: true })).toBeVisible({ timeout: 25_000 });
    await quotationRow.getByRole('button', { name: 'Quotation actions' }).click();
    await page.getByRole('menuitem', { name: 'Mark accepted' }).click();
    transition = page.getByRole('dialog', { name: 'Accepted' });
    await transition.getByRole('button', { name: 'Confirm Accepted' }).click();
    await expect(transition).toBeHidden({ timeout: 25_000 });

    await page.goto(`${baseURL}/sales-consultant/bookings?action=create`);
    const booking = page.getByRole('dialog', { name: 'Create booking' });
    const quotationPicker = booking.getByRole('combobox', { name: 'Accepted quotation' });
    await quotationPicker.click();
    const quotationSearch = page.getByRole('textbox', {
      name: 'Search quotation, customer or phone',
    });
    await quotationSearch.fill(salesFlowLeadName);
    // SearchSelect renders its popover in a portal, outside the Dialog node.
    const acceptedOption = page.getByRole('option').first();
    await expect(acceptedOption).toBeVisible({ timeout: 25_000 });
    await acceptedOption.click();
    await booking.locator('#booking-amount').fill('150000');
    await booking
      .locator('#delivery-date')
      .fill(new Date(Date.now() + 45 * 24 * 60 * 60_000).toISOString().slice(0, 10));
    await booking.getByRole('button', { name: 'Finance not required' }).click();
    await booking.getByRole('button', { name: 'Create booking' }).click();
    await expect(booking).toBeHidden({ timeout: 25_000 });

    await page.goto(
      `${baseURL}/sales-consultant/bookings?q=${encodeURIComponent(salesFlowLeadName)}`,
    );
    await expect(
      matchingRows(page, salesFlowLeadName).first().getByText('CONFIRMED', { exact: true }),
    ).toBeVisible({
      timeout: 25_000,
    });
  });

  test('Finance Manager completes the finance case with the required proof', async ({ page }) => {
    test.skip(!salesFlowLeadName, 'Set E2E_SALES_FLOW_LEAD to continue an existing Sales lead.');
    let finance = await createOperationalCase(page, 'finance', 'finance-cases', 'Finance');
    let status = await caseStatus(finance);
    if (status === 'Documents Pending') {
      // Upload through the case UI before advancing, so the resulting record
      // and document audit trail are the same as an ordinary operator workflow.
      await uploadCaseProof(page, finance);
      await progressCase(finance, 'APPLICATION_SUBMITTED', {
        lender: 'Browser QA Finance',
        application_reference: `QA-${Date.now()}`,
      });
      status = 'Application Submitted';
      finance = await openOperationalCase(page, 'Finance');
    }
    if (status === 'Application Submitted') {
      await progressCase(finance, 'UNDER_REVIEW');
      status = 'Under Review';
      finance = await openOperationalCase(page, 'Finance');
    }
    if (status === 'Under Review') {
      await progressCase(finance, 'APPROVED', { approved_amount: '1350000' });
      status = 'Approved';
      finance = await openOperationalCase(page, 'Finance');
    }
    if (status === 'Approved') {
      await progressCase(finance, 'DISBURSED', {
        approved_amount: '1350000',
        disbursed_at: futureDateTimeInput(2),
      });
    }
    await expectCaseRowStatus(page, 'DISBURSED');
  });

  test('Insurance Manager completes the policy case with the required proof', async ({ page }) => {
    test.skip(!salesFlowLeadName, 'Set E2E_SALES_FLOW_LEAD to continue an existing Sales lead.');
    let insurance = await createOperationalCase(page, 'insurance', 'insurance-cases', 'Insurance');
    let status = await caseStatus(insurance);
    if (status === 'Quote Pending') {
      await progressCase(insurance, 'QUOTE_SHARED', { insurer: 'Browser QA Insurance' });
      status = 'Quote Shared';
      insurance = await openOperationalCase(page, 'Insurance');
    }
    if (status === 'Quote Shared') {
      await progressCase(insurance, 'CUSTOMER_ACCEPTED', { insurer: 'Browser QA Insurance' });
      status = 'Customer Accepted';
      insurance = await openOperationalCase(page, 'Insurance');
    }
    if (status === 'Customer Accepted') {
      await uploadCaseProof(page, insurance);
      await progressCase(insurance, 'POLICY_ISSUED', {
        insurer: 'Browser QA Insurance',
        policy_number: `QA-POL-${Date.now()}`,
        policy_start: new Date().toISOString().slice(0, 10),
        policy_end: new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString().slice(0, 10),
      });
    }
    await expectCaseRowStatus(page, 'POLICY_ISSUED');
  });

  test('RTO Manager completes registration with the required proof', async ({ page }) => {
    test.skip(!salesFlowLeadName, 'Set E2E_SALES_FLOW_LEAD to continue an existing Sales lead.');
    let rto = await createOperationalCase(page, 'rto', 'rto-cases', 'RTO');
    let status = await caseStatus(rto);
    if (status === 'New') {
      await progressCase(rto, 'DOCUMENTS_PENDING');
      status = 'Documents Pending';
      rto = await openOperationalCase(page, 'RTO');
    }
    if (status === 'Documents Pending') {
      await uploadCaseProof(page, rto);
      await progressCase(rto, 'SUBMITTED', { submitted_at: futureDateTimeInput(1) });
      status = 'Submitted';
      rto = await openOperationalCase(page, 'RTO');
    }
    if (status === 'Submitted') {
      await progressCase(rto, 'IN_PROCESS', { submitted_at: futureDateTimeInput(1) });
      status = 'In Process';
      rto = await openOperationalCase(page, 'RTO');
    }
    if (status === 'In Process') {
      await progressCase(rto, 'REGISTERED', {
        registration_number: 'KA01QA2026',
        submitted_at: futureDateTimeInput(1),
        completed_at: futureDateTimeInput(2),
      });
    }
    await expectCaseRowStatus(page, 'REGISTERED');
  });

  test('Sales and Inventory allocate a VIN to the confirmed booking', async ({ page }) => {
    test.skip(!salesFlowLeadName, 'Set E2E_SALES_FLOW_LEAD to continue an existing Sales lead.');
    await signInAs(page, 'sales-consultant');
    await page.goto(
      `${baseURL}/sales-consultant/bookings?q=${encodeURIComponent(salesFlowLeadName)}`,
    );
    let bookingRow = matchingRows(page, salesFlowLeadName).first();
    await expect(bookingRow).toContainText(salesFlowLeadName, { timeout: 25_000 });
    if (
      await bookingRow
        .getByText('CONFIRMED', { exact: true })
        .isVisible()
        .catch(() => false)
    ) {
      await bookingRow.getByRole('button', { name: 'Booking actions' }).click();
      await page.getByRole('menuitem', { name: 'Awaiting Allocation' }).click();
      const transition = page.getByRole('dialog', { name: 'Awaiting Allocation' });
      await transition.getByRole('button', { name: 'Confirm Awaiting Allocation' }).click();
      await expect(transition).toBeHidden({ timeout: 25_000 });
    }

    await signInAs(page, 'inventory');
    await page.goto(`${baseURL}/inventory/vehicle-inventory?status=AVAILABLE`);
    const availableRows = page
      .locator('tbody tr')
      .filter({ has: page.getByText('AVAILABLE', { exact: true }) });
    await expect(availableRows.first()).toBeVisible({ timeout: 25_000 });
    // The first cell renders the VIN above the chassis number.
    const candidateVins = allocationVin
      ? [allocationVin]
      : (await availableRows.locator('td:first-child p:first-child').allTextContents()).map((vin) =>
          vin.trim(),
        );
    expect(candidateVins.length, 'Inventory must list an AVAILABLE unit.').toBeGreaterThan(0);

    // An AVAILABLE unit that still has a scheduled or active test drive is
    // protected from sale. The CRM must refuse it with an explanation, and the
    // desk then allocates the next free unit instead.
    let stock;
    for (const vin of candidateVins) {
      await page
        .getByPlaceholder('Search VIN, chassis, engine, model, variant or colour…')
        .fill(vin);
      const row = availableRows.filter({ hasText: vin }).first();
      await expect(row).toContainText(vin, { timeout: 25_000 });
      await row.getByRole('button', { name: 'Open' }).click();
      stock = page.locator('[role="dialog"]').last();
      await expect(stock.getByText('Stock unit detail', { exact: true })).toBeVisible({
        timeout: 25_000,
      });
      const allocationSearch = stock.getByPlaceholder('Search booking or customer…');
      await allocationSearch.fill(salesFlowLeadName);
      const allocationForm = allocationSearch.locator('xpath=ancestor::form');
      await allocationForm.getByRole('combobox').first().click();
      const bookingOption = page
        .locator('[role="option"]')
        .filter({ hasText: salesFlowLeadName })
        .first();
      await expect(bookingOption).toBeVisible({ timeout: 25_000 });
      await bookingOption.click();
      const allocationResponse = page.waitForResponse(
        (response) => response.url().includes('/rpc/allocate_stock_unit'),
        { timeout: 30_000 },
      );
      await allocationForm.getByRole('button', { name: 'Allocate stock' }).click();
      const allocationResult = await allocationResponse;
      if (allocationResult.ok()) {
        allocationVin = vin;
        break;
      }
      const failure = await allocationResult.json();
      if (failure?.message !== 'TEST_DRIVE_PREVENTS_STOCK_ALLOCATION') {
        throw new Error(`Inventory allocation failed: ${JSON.stringify(failure)}`);
      }
      await expect(
        stock.getByText(/has a scheduled or active test drive/, { exact: false }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    expect(
      allocationVin,
      'An AVAILABLE unit free of test drives must be allocatable.',
    ).toBeTruthy();
    await expect(stock.getByText('ALLOCATED', { exact: true })).toBeVisible({ timeout: 25_000 });

    await signInAs(page, 'sales-consultant');
    await page.goto(
      `${baseURL}/sales-consultant/bookings?q=${encodeURIComponent(salesFlowLeadName)}`,
    );
    bookingRow = matchingRows(page, salesFlowLeadName).first();
    await expect(bookingRow.getByText('AWAITING ALLOCATION', { exact: true })).toBeVisible({
      timeout: 25_000,
    });
    await bookingRow.getByRole('button', { name: 'Booking actions' }).click();
    await page.getByRole('menuitem', { name: 'Allocated' }).click();
    const allocated = page.getByRole('dialog', { name: 'Allocated' });
    await allocated.getByRole('button', { name: 'Confirm Allocated' }).click();
    await expect(allocated).toBeHidden({ timeout: 25_000 });
  });

  test('Delivery Manager completes PDI, checklist, signed delivery, and booking completion', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    test.skip(!salesFlowLeadName, 'Set E2E_SALES_FLOW_LEAD to continue an existing Sales lead.');

    // The allocated stock unit must be released to the delivery desk before the
    // booking can be marked ready. These are separate audited workflows.
    await transitionStockLifecycle(page, 'READY_FOR_DELIVERY');
    await transitionBooking(page, 'READY_FOR_DELIVERY');

    let delivery = await createOperationalCase(page, 'delivery', 'upcoming-deliveries', 'Delivery');
    let status = await caseStatus(delivery);
    if (status === 'Planning') {
      await completeDeliveryPdi(page, delivery);
      await completeDeliveryChecklist(delivery);
      delivery = await openOperationalCase(page, 'Delivery');
      // The checklist save moves a Planning case to Checklist Pending; the sheet can
      // first show the cached pre-save status, so wait for the refetched one.
      await expect(delivery.getByRole('combobox').first()).not.toContainText('Planning', {
        timeout: 30_000,
      });
      status = await caseStatus(delivery);
    }
    if (status === 'Checklist Pending') {
      await completeDeliveryPdi(page, delivery);
      await completeDeliveryChecklist(delivery);
      delivery = await openOperationalCase(page, 'Delivery');
      status = await caseStatus(delivery);
    }
    if (status === 'Checklist Pending') {
      await progressCase(delivery, 'READY');
      delivery = await openOperationalCase(page, 'Delivery');
      status = 'Ready';
    }
    if (status === 'Ready') {
      const scheduledAt = futureDateTimeInput(48);
      await progressCase(delivery, 'SCHEDULED', { scheduled_at: scheduledAt });
      delivery = await openOperationalCase(page, 'Delivery');
      status = 'Scheduled';
    }
    if (status === 'Delivered') {
      await transitionStockLifecycle(page, 'DELIVERED');
      await transitionBooking(page, 'DELIVERED');
      return;
    }
    await expect(delivery.getByRole('combobox').first()).toContainText('Scheduled');

    // Vehicle delivery is a stock lifecycle action, not an implicit side effect
    // of case completion; proving both prevents a booking from outpacing stock.
    await transitionStockLifecycle(page, 'DELIVERED');
    await signInAs(page, 'delivery');
    await page.goto(
      `${baseURL}/delivery/upcoming-deliveries?q=${encodeURIComponent(salesFlowLeadName)}`,
    );
    delivery = await openOperationalCase(page, 'Delivery');
    if (
      !(await delivery
        .getByRole('paragraph')
        .filter({ hasText: 'logo.webp' })
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      await uploadCaseProof(page, delivery);
    }
    const scheduledAt = await delivery.locator('#case-scheduled_at').inputValue();
    await selectDeliverySignature(page, delivery);
    await progressCase(delivery, 'DELIVERED', {
      scheduled_at: scheduledAt,
      delivered_at: futureDateTimeInput(72),
    });
    await page.goto(`${baseURL}/delivery/delivered?q=${encodeURIComponent(salesFlowLeadName)}`);
    await expectCaseRowStatus(page, 'DELIVERED');

    await transitionBooking(page, 'DELIVERED');
  });
});
