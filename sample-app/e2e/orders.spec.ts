import { expect, test } from '@playwright/test';

const orderLink = (id: string) => ({ name: id, exact: true });

test('lists the orders and filters them by status and search', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', orderLink('o-1001'))).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Harbour Outfitters' })).toBeVisible();

  await page.getByLabel('Filter by status').selectOption('shipped');
  await expect(page.getByRole('link', orderLink('o-1001'))).toBeVisible();
  await expect(page.getByRole('link', orderLink('o-1003'))).toHaveCount(0);
  await expect(page.getByRole('link', orderLink('o-1005'))).toHaveCount(0);

  await page.getByLabel('Filter by status').selectOption('all');
  await page.getByLabel('Search orders').fill('paper kite');
  await expect(page.getByRole('link', orderLink('o-1002'))).toBeVisible();
  await expect(page.getByRole('link', orderLink('o-1001'))).toHaveCount(0);

  await page.getByLabel('Search orders').fill('nothing like this');
  await expect(page.getByRole('status')).toHaveText('No orders match that search.');
});

test('opens an order, shows its lines and total, and goes back', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', orderLink('o-1001')).click();
  await expect(page.getByRole('heading', { name: 'o-1001', level: 1 })).toBeVisible();
  await expect(page.getByText('Waxed canvas tote')).toBeVisible();
  await expect(page.getByText('£459.00').first()).toBeVisible();
  await expect(page.getByText('18 Quay Street')).toBeVisible();

  await page.getByRole('link', { name: '← All orders' }).click();
  await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();
});

test('opens an order from a deep link', async ({ page }) => {
  await page.goto('/#/orders/o-1002');
  await expect(page.getByRole('heading', { name: 'o-1002', level: 1 })).toBeVisible();
  await expect(page.getByRole('paragraph').filter({ hasText: 'The Paper Kite' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Order progress' })).toBeVisible();
});

test('says plainly when an order is not there', async ({ page }) => {
  await page.goto('/#/orders/o-9999');
  await expect(page.getByRole('heading', { name: 'Order not found' })).toBeVisible();
  await expect(page.getByText('o-9999')).toBeVisible();
});
