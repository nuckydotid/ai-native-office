import { describe, expect, it } from 'vitest';
import {
  ORDER_STATUSES,
  filterOrders,
  findOrder,
  formatDate,
  formatMoney,
  lineTotal,
  listOrders,
  orderTotal,
  orderUnits,
  orders,
  ordersSummary,
  statusLabel,
} from '../src/api/orders';

describe('the order book', () => {
  it('lists every order, and the list has the fields the portal shows', () => {
    const all = listOrders();
    expect(all).toHaveLength(8);
    expect(all[0]).toMatchObject({ id: 'o-1001', customer: 'Harbour Outfitters', status: 'shipped' });
    expect(all.every((order) => order.lines.length > 0)).toBe(true);
  });

  it('finds an order by id, and says nothing for one that is not there', () => {
    expect(findOrder('o-1002')?.customer).toBe('The Paper Kite');
    expect(findOrder('o-9999')).toBeUndefined();
  });

  it('filters by status, and all means all', () => {
    expect(filterOrders(orders, 'all', '')).toHaveLength(orders.length);
    const shipped = filterOrders(orders, 'shipped', '');
    expect(shipped.map((order) => order.id)).toEqual(['o-1001', 'o-1004', 'o-1008']);
    expect(shipped.every((order) => order.status === 'shipped')).toBe(true);
    expect(filterOrders(orders, 'processing', '')).toHaveLength(2);
  });

  it('searches the order number, customer, email, city and items, without caring about case', () => {
    expect(filterOrders(orders, 'all', 'o-1003').map((order) => order.id)).toEqual(['o-1003']);
    expect(filterOrders(orders, 'all', 'paper kite').map((order) => order.id)).toEqual(['o-1002']);
    expect(filterOrders(orders, 'all', 'breconbikes.example').map((order) => order.id)).toEqual(['o-1003']);
    expect(filterOrders(orders, 'all', 'EDINBURGH').map((order) => order.id)).toEqual(['o-1005']);
    expect(filterOrders(orders, 'all', 'desk tray').map((order) => order.id)).toEqual(['o-1006']);
    expect(filterOrders(orders, 'shipped', 'paper kite')).toEqual([]);
    expect(filterOrders(orders, 'all', 'nothing like this')).toEqual([]);
  });

  it('adds up lines, units and orders', () => {
    const order = findOrder('o-1001')!;
    expect(lineTotal(order.lines[0])).toBe(342);
    expect(orderTotal(order)).toBe(459);
    expect(orderUnits(order)).toBe(24);
    expect(orderTotal({ lines: [] })).toBe(0);
  });

  it('summarises what is open and what it is worth, leaving cancelled orders out of the value', () => {
    const summary = ordersSummary();
    expect(summary.total).toBe(8);
    expect(summary.byStatus).toEqual({ processing: 2, shipped: 3, delivered: 2, cancelled: 1 });
    expect(summary.open).toBe(5);
    expect(summary.revenue).toBeGreaterThan(2000);
    const cancelled = findOrder('o-1005')!;
    expect(ordersSummary([cancelled])).toMatchObject({ total: 1, open: 0, revenue: 0, byStatus: { cancelled: 1 } });
  });

  it('writes statuses and money the way the portal shows them', () => {
    expect(ORDER_STATUSES.map(statusLabel)).toEqual(['Processing', 'Shipped', 'Delivered', 'Cancelled']);
    expect(formatMoney(459)).toBe('£459.00');
    expect(formatMoney(18.5)).toBe('£18.50');
  });

  it('writes dates in a short British form, and leaves a bad date alone', () => {
    expect(formatDate('2026-10-02')).toBe('2 Oct 2026');
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });
});
