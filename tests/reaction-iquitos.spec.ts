import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';

test('Reaction filter on difusion_iquitos with screenshots', async ({ page }) => {
  test.setTimeout(60_000);

  // Login
  await page.goto(BASE + '/');
  await page.waitForLoadState('networkidle');
  await page.locator('input[type="text"], input[type="email"]').first().fill('ricardo');
  await page.locator('input[type="password"]').first().fill('Ricardo123@');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });

  // Switch to difusion_iquitos via API directly to bypass UI
  const switched = await page.evaluate(async () => {
    const token = localStorage.getItem('token');
    // Get account list by re-calling login (it returns accounts array)
    const loginRes = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ricardo', password: 'Ricardo123@' }),
    }).then(r => r.json());
    const accounts = loginRes.accounts || [];
    const target = accounts.find((a: any) => a.account_name === 'difusion_iquitos');
    if (!target) return { ok: false, reason: 'difusion_iquitos not found', accounts };
    const r = await fetch('/api/auth/switch-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ account_id: target.account_id }),
    });
    const d = await r.json();
    if (d.token) {
      localStorage.setItem('token', d.token);
      if (d.user) localStorage.setItem('user', JSON.stringify(d.user));
    }
    return { ok: d.success, account_id: target.account_id, name: target.account_name };
  });
  console.log('Switch result:', switched);

  await page.goto(BASE + '/dashboard/chats');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  // Screenshot 1: default state
  await page.screenshot({ path: 'test-results/iquitos-01-default.png', fullPage: false });

  // Read total from API directly
  const baseline = await page.evaluate(async () => {
    const token = localStorage.getItem('token');
    const r = await fetch('/api/chats?limit=1', { headers: { Authorization: `Bearer ${token}` } });
    return (await r.json()).total;
  });
  console.log('Baseline total:', baseline);

  // Activate filter
  await page.locator('[data-testid="filter-reaction-toggle"]').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/iquitos-02-reaction-on.png', fullPage: false });

  // Open advanced
  await page.locator('[data-testid="filter-reaction-advanced"] button').first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/iquitos-03-advanced-open.png', fullPage: false });

  // Pick "Operador" + 👍
  await page.locator('[data-testid="reaction-from-me"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="reaction-emoji-👍"]').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/iquitos-04-me-thumb.png', fullPage: false });

  // Final API counts
  const filtered = await page.evaluate(async () => {
    const token = localStorage.getItem('token');
    const r = await fetch('/api/chats?limit=1&has_reaction=true&reaction_from_me=true&reaction_emojis=' + encodeURIComponent('👍'), {
      headers: { Authorization: `Bearer ${token}` },
    });
    return (await r.json()).total;
  });
  console.log('Filtered (operator + 👍) total:', filtered);

  expect(filtered).toBeLessThanOrEqual(baseline);
  expect(filtered).toBeGreaterThan(0);
});
