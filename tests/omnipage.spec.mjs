import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const validLink = (name, url) => ({ name, url, desc: '', keywords: '' });

async function openImport(page) {
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.locator('#modal')).toHaveClass(/active/);
}

async function submitImport(page, payload) {
  await openImport(page);
  await page.locator('#jsonArea').fill(JSON.stringify(payload));
  const dialogPromise = page.waitForEvent('dialog');
  const clickPromise = page.getByRole('button', { name: '确认导入' }).click();
  const dialog = await dialogPromise;
  await dialog.accept();
  await clickPromise;
  return dialog;
}

test('uses the native Chinese calendar and refreshes after midnight', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-21T23:59:59+08:00') });
  await page.goto('/');

  await expect(page.locator('#calendarDate')).toContainText('2026年08月21日');
  await expect(page.locator('.cal-lunar')).toHaveText('农历丙午年七月初九');

  await page.clock.fastForward(2_500);
  await expect(page.locator('#calendarDate')).toContainText('2026年08月22日');
  await expect(page.locator('.cal-lunar')).toHaveText('农历丙午年七月初十');
});

test('rejects malformed and unsafe imports without changing current data', async ({ page }) => {
  await page.goto('/');
  const initialNames = await page.locator('.link-name').allTextContents();
  const initialStorage = await page.evaluate(() => localStorage.getItem('omnipage_data'));

  const malformedDialog = await submitImport(page, { categories: [null] });
  expect(malformedDialog.type()).toBe('alert');
  expect(malformedDialog.message()).toContain('第 1 个分类格式无效');
  await expect(page.locator('#modal')).toHaveClass(/active/);
  await page.getByRole('button', { name: '关闭' }).click();

  const unsafeDialog = await submitImport(page, {
    schemaVersion: 1,
    categories: [{ id: 'unsafe', title: 'Unsafe', links: [validLink('Bad', 'javascript:alert(1)')] }]
  });
  expect(unsafeDialog.type()).toBe('alert');
  expect(unsafeDialog.message()).toContain('只允许 http:// 或 https://');
  await page.getByRole('button', { name: '关闭' }).click();

  await expect(page.locator('.link-name')).toHaveText(initialNames);
  expect(await page.evaluate(() => localStorage.getItem('omnipage_data'))).toBe(initialStorage);
});

test('blocks import during editing and keeps invalid edits unsaved', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.locator('#modal')).not.toHaveClass(/active/);
  await expect(page.locator('.toast')).toContainText('请先保存或取消编辑后再导入');

  await page.locator('input[aria-label="URL"]').first().fill('data:text/html,bad');
  const dialogPromise = page.waitForEvent('dialog');
  const clickPromise = page.getByRole('button', { name: '保存', exact: true }).click();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe('alert');
  expect(dialog.message()).toContain('只允许 http:// 或 https://');
  await dialog.accept();
  await clickPromise;

  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('omnipage_data'))).toBeNull();
});

test('maps duplicate names by stable indices and reports honest link states', async ({ page }) => {
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  const dialog = await submitImport(page, {
    schemaVersion: 1,
    categories: [
      { id: 'first', title: 'First', links: [validLink('Duplicate', `${origin}/__ok`)] },
      { id: 'second', title: 'Second', links: [validLink('Duplicate', `${origin}/__missing`)] }
    ]
  });
  expect(dialog.type()).toBe('confirm');
  await expect(page.locator('#modal')).not.toHaveClass(/active/);

  await page.getByRole('button', { name: '检查链接' }).click();
  const firstStatus = page.locator('.link-card[data-cat-idx="0"][data-link-idx="0"] .link-status');
  const secondStatus = page.locator('.link-card[data-cat-idx="1"][data-link-idx="0"] .link-status');
  await expect(firstStatus).toHaveClass(/ok/);
  await expect(secondStatus).toHaveClass(/dead/);
  await expect(secondStatus).toHaveAttribute('title', 'HTTP 404');
  await expect(secondStatus).toHaveAttribute('aria-label', /明确失效/);
  await expect(page.getByRole('button', { name: '检查链接' })).toBeEnabled();

  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('omnipage_data')));
  expect(JSON.stringify(stored)).not.toContain('_dead');
});

test('exports versioned data and isolates the accessible modal', async ({ page }) => {
  await page.goto('/');
  const exportButton = page.getByRole('button', { name: '导出', exact: true });
  await exportButton.click();

  await expect(page.locator('#modal')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('.modal')).toBeFocused();
  expect(await page.locator('.main-wrap').evaluate(element => element.inert)).toBe(true);
  const payload = JSON.parse(await page.locator('#jsonArea').inputValue());
  expect(payload.schemaVersion).toBe(1);
  expect(payload.appVersion).toBe('1.0.1');
  expect(payload.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  await page.getByRole('button', { name: '关闭' }).click();
  expect(await page.locator('.main-wrap').evaluate(element => element.inert)).toBe(false);
  await expect(exportButton).toBeFocused();
});

test('restores the last valid backup when primary storage is corrupt', async ({ page }) => {
  await page.goto('/');
  const backup = {
    schemaVersion: 1,
    categories: [{ id: 'backup', title: 'Backup', links: [validLink('Recovered', 'https://example.com')] }]
  };
  await page.evaluate(data => {
    localStorage.setItem('omnipage_data', '{broken');
    localStorage.setItem('omnipage_data_backup', JSON.stringify(data));
  }, backup);
  await page.reload();

  await expect(page.locator('.link-name')).toHaveText(['Recovered']);
  await expect(page.locator('.toast')).toContainText('已恢复上一份本地备份');
  const repairedPrimary = JSON.parse(await page.evaluate(() => localStorage.getItem('omnipage_data')));
  expect(repairedPrimary.categories[0].links[0].name).toBe('Recovered');
});

test('keeps the closed mobile sidebar out of keyboard navigation', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto('/');
  const sidebar = page.locator('#sidebar');
  const toggle = page.locator('#sidebarToggle');

  await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
  expect(await sidebar.evaluate(element => element.inert)).toBe(true);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false');
  expect(await sidebar.evaluate(element => element.inert)).toBe(false);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#navList .nav-item').first()).toHaveJSProperty('tagName', 'BUTTON');
});

test('opens only validated links with opener isolation', async ({ page }) => {
  await page.goto('/');
  const cards = page.locator('a.link-card');
  await expect(cards.first()).toHaveAttribute('target', '_blank');
  await expect(cards.first()).toHaveAttribute('rel', /noopener/);
  await expect(cards.first()).toHaveAttribute('rel', /noreferrer/);
  expect(await cards.evaluateAll(elements => elements.every(element => /^https?:$/.test(new URL(element.href).protocol)))).toBe(true);
});

test('still works when index.html is opened directly from disk', async ({ page }) => {
  const fileUrl = pathToFileURL(resolve('index.html')).href;
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(fileUrl);

  await expect(page.locator('#calendarDate')).toContainText('年');
  await expect(page.locator('.link-card')).toHaveCount(7);
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await expect(page.locator('#modal')).toHaveClass(/active/);
  expect(pageErrors).toEqual([]);
});
