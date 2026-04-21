import { chromium } from 'playwright';

const URL = 'http://localhost:5173/?nats=wss://bioresearchchat.selfai.cc/ws/&service=1d174e1acdf27de08990ccc6ac73652f3a03738ec6519eb25c7dee7e4195dba8&auto=true';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Select a chat
  if (await page.locator('.chat-item').count() > 0) {
    await page.locator('.chat-item').first().click();
    await page.waitForTimeout(1000);
  }

  // Open files panel
  await page.locator('.tb-btn:has-text("Files")').click();
  await page.waitForTimeout(2000);

  // ================================================
  // TEST 1: Root entries
  // ================================================
  console.log('=== Test 1: Root entries ===');
  let rows = page.locator('.entry-row');
  let count = await rows.count();
  console.log(`Root entries: ${count}`);
  for (let i = 0; i < count; i++) {
    const name = await rows.nth(i).locator('.name').textContent();
    const icon = await rows.nth(i).locator('.icon').textContent();
    console.log(`  ${icon} ${name}`);
  }
  await page.screenshot({ path: '/tmp/ss-ft-1-root.png' });

  // ================================================
  // TEST 2: Click .pantheon directory to expand
  // ================================================
  console.log('\n=== Test 2: Expand .pantheon ===');
  // Find .pantheon row
  let targetRow = null;
  for (let i = 0; i < count; i++) {
    const name = await rows.nth(i).locator('.name').textContent();
    if (name?.trim() === '.pantheon') { targetRow = i; break; }
  }
  if (targetRow !== null) {
    await rows.nth(targetRow).click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/tmp/ss-ft-2-expanded.png' });

    rows = page.locator('.entry-row');
    const afterExpand = await rows.count();
    console.log(`Rows after expand: ${afterExpand} (was ${count})`);

    // Print new entries (the children should be indented)
    for (let i = 0; i < afterExpand; i++) {
      const name = await rows.nth(i).locator('.name').textContent();
      const icon = await rows.nth(i).locator('.icon').textContent();
      const style = await rows.nth(i).getAttribute('style');
      const indent = style?.match(/padding-left:\s*(\d+)/)?.[1] || '12';
      const depth = Math.round((parseInt(indent) - 12) / 16);
      const prefix = '  '.repeat(depth);
      console.log(`  ${prefix}${icon} ${name}`);
    }
  }

  // ================================================
  // TEST 3: Expand a subdirectory (depth 2)
  // ================================================
  console.log('\n=== Test 3: Expand agents subdirectory ===');
  rows = page.locator('.entry-row');
  const rowCount2 = await rows.count();
  let agentsRow = null;
  for (let i = 0; i < rowCount2; i++) {
    const name = await rows.nth(i).locator('.name').textContent();
    if (name?.trim() === 'agents') { agentsRow = i; break; }
  }
  if (agentsRow !== null) {
    await rows.nth(agentsRow).click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/tmp/ss-ft-3-depth2.png' });

    rows = page.locator('.entry-row');
    const afterDepth2 = await rows.count();
    console.log(`Rows after depth-2 expand: ${afterDepth2}`);
  }

  // ================================================
  // TEST 4: Collapse .pantheon
  // ================================================
  console.log('\n=== Test 4: Collapse .pantheon ===');
  rows = page.locator('.entry-row');
  for (let i = 0; i < await rows.count(); i++) {
    const name = await rows.nth(i).locator('.name').textContent();
    if (name?.trim() === '.pantheon') {
      await rows.nth(i).click();
      break;
    }
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/ss-ft-4-collapsed.png' });

  rows = page.locator('.entry-row');
  const afterCollapse = await rows.count();
  console.log(`Rows after collapse: ${afterCollapse} (should be ${count})`);

  // ================================================
  // TEST 5: Re-expand (cached)
  // ================================================
  console.log('\n=== Test 5: Re-expand (cached) ===');
  for (let i = 0; i < await rows.count(); i++) {
    const name = await rows.nth(i).locator('.name').textContent();
    if (name?.trim() === '.pantheon') {
      await rows.nth(i).click();
      break;
    }
  }
  await page.waitForTimeout(500);
  rows = page.locator('.entry-row');
  const afterReexpand = await rows.count();
  console.log(`Rows after re-expand: ${afterReexpand} (cached, should be > ${count})`);
  await page.screenshot({ path: '/tmp/ss-ft-5-reexpand.png' });

  // ================================================
  // TEST 6: Expand projects directory too
  // ================================================
  console.log('\n=== Test 6: Expand projects directory ===');
  // First collapse .pantheon
  rows = page.locator('.entry-row');
  for (let i = 0; i < await rows.count(); i++) {
    const name = await rows.nth(i).locator('.name').textContent();
    if (name?.trim() === '.pantheon') {
      await rows.nth(i).click();
      break;
    }
  }
  await page.waitForTimeout(300);

  // Now expand projects
  rows = page.locator('.entry-row');
  for (let i = 0; i < await rows.count(); i++) {
    const name = await rows.nth(i).locator('.name').textContent();
    if (name?.trim() === 'projects') {
      await rows.nth(i).click();
      break;
    }
  }
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/ss-ft-6-projects.png' });
  rows = page.locator('.entry-row');
  console.log(`Rows with projects expanded: ${await rows.count()}`);

  // Error check
  console.log(`\n=== Errors: ${errors.length} ===`);
  for (const e of errors) console.log(`  ${e}`);

  await browser.close();
}

main().catch(console.error);
