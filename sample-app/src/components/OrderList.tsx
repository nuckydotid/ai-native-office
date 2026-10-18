import { useMemo, useState } from 'react';
import { ORDER_STATUSES, filterOrders, formatDate, formatMoney, orderTotal, ordersSummary, statusLabel } from '../api/orders';
import type { OrderStatus } from '../api/orders';
import { StatusChip } from './StatusChip';

export function OrderList({ orders }: { orders: readonly import('../api/orders').Order[] }) {
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterOrders(orders, status, query), [orders, status, query]);
  const summary = useMemo(() => ordersSummary(orders), [orders]);

  return (
    <div className="stack">
      <section className="page-intro">
        <div>
          <p className="eyebrow">Wholesale account · Harbour Outfitters</p>
          <h1>Orders</h1>
          <p className="lede">Every order placed with Northwind Commerce, from packing to delivery.</p>
        </div>
        <div className="stats" aria-label="Order summary">
          <div className="stat">
            <span>Open orders</span>
            <strong>{summary.open}</strong>
          </div>
          <div className="stat">
            <span>Orders</span>
            <strong>{summary.total}</strong>
          </div>
          <div className="stat">
            <span>Value</span>
            <strong>{formatMoney(summary.revenue)}</strong>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="toolbar">
          <label className="field grow">
            <span>Search orders</span>
            <input
              type="search"
              value={query}
              placeholder="Order, customer or city"
              aria-label="Search orders"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Status</span>
            <select value={status} aria-label="Filter by status" onChange={(event) => setStatus(event.target.value as OrderStatus | 'all')}>
              <option value="all">All statuses</option>
              {ORDER_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {shown.length === 0 ? (
          <p className="empty" role="status">
            No orders match that search.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Orders</caption>
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Placed</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="numeric">
                    Units
                  </th>
                  <th scope="col" className="numeric">
                    Total
                  </th>
                  <th scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <a className="order-link" href={`#/orders/${order.id}`}>
                        {order.id}
                      </a>
                    </td>
                    <td>
                      <strong>{order.customer}</strong>
                      <small>{order.shipping.city}</small>
                    </td>
                    <td>{formatDate(order.placedAt)}</td>
                    <td>
                      <StatusChip status={order.status} />
                    </td>
                    <td className="numeric">{order.lines.reduce((sum, line) => sum + line.quantity, 0)}</td>
                    <td className="numeric">{formatMoney(orderTotal(order))}</td>
                    <td>
                      <a className="row-action" href={`#/orders/${order.id}`} aria-label={`Open order ${order.id}`}>
                        View
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="table-note">
          Showing {shown.length} of {orders.length} orders. Figures are in GBP and exclude delivery.
        </p>
      </section>
    </div>
  );
}
