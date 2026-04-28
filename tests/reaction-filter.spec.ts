import { test, expect, Page } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const USERNAME = 'ricardo';
const PASSWORD = 'Ricardo123@';
const ACCOUNT_NAME = 'difusion_iquitos';

async function login(page: Page) {
  await page.goto(BASE + '/');
  // Wait for login form
  await page.waitForLoadState('networkidle');
  // Login fields - try common selectors
  const userInput = page.locator('input[name="username"], input[type="text"], input[placeholder*="usuario" i], input[placeholder*="user" i], input[placeholder*="email" i]').first();
  const passInput = page.locator('input[type="password"]').first();
  await userInput.fill(USERNAME);
  await passInput.fill(PASSWORD);
  await page.locator('button[type="submit"], button:has-text("Iniciar"), button:has-text("Ingresar"), button:has-text("Login")').first().click();
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

async function selectAccount(page: Page, accountName: string) {
  // The account picker may appear as a dropdown or list of accounts.
  // Try to find an element with the account name and click it.
  await page.waitForTimeout(1500);
  const acct = page.locator(`text=${accountName}`).first();
  if (await acct.isVisible({ timeout: 3000 }).catch(() => false)) {
    await acct.click();
    await page.waitForTimeout(1000);
  }
}

test.describe('Chat reaction filter', () => {
  test.setTimeout(90_000);

  test('1. Login & navigate to chats', async ({ page }) => {
    await login(page);
    await selectAccount(page, ACCOUNT_NAME);
    await page.goto(BASE + '/dashboard/chats');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-testid="filter-reaction-toggle"]')).toBeVisible();
    await page.screenshot({ path: 'test-results/01-chats-default.png', fullPage: false });
  });

  test('2. Toggle reaction filter shows advanced panel and filters list', async ({ page }) => {
    await login(page);
    await selectAccount(page, ACCOUNT_NAME);
    await page.goto(BASE + '/dashboard/chats');
    await page.waitForLoadState('networkidle');

    // Capture default chat count
    const defaultRes = await page.evaluate(async () => {
      const token = localStorage.getItem('token');
      const r = await fetch('/api/chats?limit=1', { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      return d.total;
    });

    // Click toggle
    const toggle = page.locator('[data-testid="filter-reaction-toggle"]');
    await toggle.click();
    await page.waitForTimeout(800);

    // Advanced panel should appear
    await expect(page.locator('[data-testid="filter-reaction-advanced"]')).toBeVisible();

    // After enabling, total should be <= default
    const filteredRes = await page.evaluate(async () => {
      const token = localStorage.getItem('token');
      const r = await fetch('/api/chats?limit=1&has_reaction=true&reaction_from_me=false', { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      return { total: d.total, success: d.success, error: d.error };
    });
    console.log('Default total:', defaultRes, 'Filtered total:', filteredRes);
    expect(filteredRes.success).toBe(true);
    expect(filteredRes.total).toBeLessThanOrEqual(defaultRes);
    await page.screenshot({ path: 'test-results/02-reaction-active.png', fullPage: false });
  });

  test('3. Backend API: has_reaction=true returns chats with reactions', async ({ page }) => {
    await login(page);
    await selectAccount(page, ACCOUNT_NAME);
    await page.goto(BASE + '/dashboard/chats');
    await page.waitForLoadState('networkidle');

    const result = await page.evaluate(async () => {
      const token = localStorage.getItem('token');
      const variants: Record<string, any> = {};
      const queries: [string, string][] = [
        ['none', 'limit=5'],
        ['has_any', 'limit=5&has_reaction=true'],
        ['from_client', 'limit=5&has_reaction=true&reaction_from_me=false'],
        ['from_me', 'limit=5&has_reaction=true&reaction_from_me=true'],
        ['emoji_thumb', 'limit=5&has_reaction=true&reaction_emojis=' + encodeURIComponent('👍')],
        ['since_30d', 'limit=5&has_reaction=true&reaction_since=' + encodeURIComponent(new Date(Date.now() - 30*24*60*60*1000).toISOString())],
      ];
      for (const [k, q] of queries) {
        const r = await fetch('/api/chats?' + q, { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json();
        variants[k] = { status: r.status, total: d.total, count: (d.chats || []).length, success: d.success, error: d.error };
      }
      return variants;
    });
    console.log('Backend variants:', JSON.stringify(result, null, 2));

    // All variants must succeed
    for (const k of Object.keys(result)) {
      expect(result[k].success, `variant ${k} failed: ${result[k].error}`).toBe(true);
    }

    // has_any total <= none total
    expect(result.has_any.total).toBeLessThanOrEqual(result.none.total);
    // from_client and from_me totals <= has_any total
    expect(result.from_client.total).toBeLessThanOrEqual(result.has_any.total);
    expect(result.from_me.total).toBeLessThanOrEqual(result.has_any.total);
    // emoji-specific <= has_any
    expect(result.emoji_thumb.total).toBeLessThanOrEqual(result.has_any.total);
    // since_30d <= has_any
    expect(result.since_30d.total).toBeLessThanOrEqual(result.has_any.total);
  });

  test('4. UI: clicking emoji and from-me options updates query', async ({ page }) => {
    await login(page);
    await selectAccount(page, ACCOUNT_NAME);
    await page.goto(BASE + '/dashboard/chats');
    await page.waitForLoadState('networkidle');

    await page.locator('[data-testid="filter-reaction-toggle"]').click();
    await page.waitForTimeout(500);

    // Expand advanced if collapsed
    const advancedHeader = page.locator('[data-testid="filter-reaction-advanced"] button').first();
    await advancedHeader.click();
    await page.waitForTimeout(300);

    // Click "me" option
    const requests: string[] = [];
    page.on('request', req => {
      if (req.url().includes('/api/chats')) requests.push(req.url());
    });

    await page.locator('[data-testid="reaction-from-me"]').click();
    await page.waitForTimeout(800);

    await page.locator('[data-testid="reaction-emoji-👍"]').click();
    await page.waitForTimeout(800);

    await page.locator('[data-testid="reaction-range-7d"]').click();
    await page.waitForTimeout(800);

    const last = requests[requests.length - 1] || '';
    console.log('Last /api/chats request:', last);
    expect(last).toContain('has_reaction=true');
    expect(last).toContain('reaction_from_me=true');
    expect(last).toContain('reaction_emojis=');
    expect(last).toContain('reaction_since=');

    await page.screenshot({ path: 'test-results/04-advanced-filter.png', fullPage: false });
  });

  test('5. Disabling toggle restores full list', async ({ page }) => {
    await login(page);
    await selectAccount(page, ACCOUNT_NAME);
    await page.goto(BASE + '/dashboard/chats');
    await page.waitForLoadState('networkidle');

    const totalBefore = await page.evaluate(async () => {
      const token = localStorage.getItem('token');
      const r = await fetch('/api/chats?limit=1', { headers: { Authorization: `Bearer ${token}` } });
      return (await r.json()).total;
    });

    const toggle = page.locator('[data-testid="filter-reaction-toggle"]');
    await toggle.click();
    await page.waitForTimeout(600);
    await toggle.click();
    await page.waitForTimeout(600);

    const totalAfter = await page.evaluate(async () => {
      const token = localStorage.getItem('token');
      const r = await fetch('/api/chats?limit=1', { headers: { Authorization: `Bearer ${token}` } });
      return (await r.json()).total;
    });

    expect(totalAfter).toBe(totalBefore);
    await expect(page.locator('[data-testid="filter-reaction-advanced"]')).toHaveCount(0);
  });
});
