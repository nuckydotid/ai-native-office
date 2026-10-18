import { formatDate, formatMoney, lineTotal, orderTotal, orderUnits } from '../api/orders';
import type { Order } from '../api/orders';
import { StatusChip } from './StatusChip';

const STEPS = ['Placed', 'Packed', 'Shipped', 'Delivered'] as const;
const STEP_AT: Record<string, number> = { processing: 1, shipped: 2, delivered: 3 };

export function OrderDetail({ order }: { order: Order }) {
  const reached = order.status === 'cancelled' ? 0 : (STEP_AT[order.status] ?? 0);
  return (
    <div className="stack">
      <a className="back-link" href="#/">
        ← All orders
      </a>

      <section className="page-intro detail-intro">
        <div>
          <p className="eyebrow">Order</p>
          <h1>{order.id}</h1>
          <p className="lede">
            Placed by <strong>{order.customer}</strong> on {formatDate(order.placedAt)}.
          </p>
        </div>
        <div className="detail-status">
          <StatusChip status={order.status} />
          <span className="detail-total">{formatMoney(orderTotal(order))}</span>
        </div>
      </section>

      {order.status === 'cancelled' ? (
        <div className="notice">This order was cancelled. Nothing was shipped and no payment was taken.</div>
      ) : (
        <ol className="timeline" aria-label="Order progress">
          {STEPS.map((step, index) => (
            <li key={step} className={index <= reached ? 'timeline-done' : ''} aria-current={index === reached ? 'step' : undefined}>
              <span className="timeline-dot" aria-hidden="true" />
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="detail-grid">
        <section className="card">
          <div className="card-heading">
            <h2>Items</h2>
            <span>
              {order.lines.length} lines · {orderUnits(order)} units
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">SKU</th>
                  <th scope="col" className="numeric">
                    Qty
                  </th>
                  <th scope="col" className="numeric">
                    Unit
                  </th>
                  <th scope="col" className="numeric">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line) => (
                  <tr key={line.sku}>
                    <td>{line.name}</td>
                    <td className="mono">{line.sku}</td>
                    <td className="numeric">{line.quantity}</td>
                    <td className="numeric">{formatMoney(line.unitPrice)}</td>
                    <td className="numeric">{formatMoney(lineTotal(line))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={4}>
                    Subtotal
                  </th>
                  <td className="numeric">{formatMoney(orderTotal(order))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <aside className="stack-tight">
          <section className="card">
            <h2>Delivery</h2>
            <address>
              <strong>{order.customer}</strong>
              <br />
              {order.shipping.address}
              <br />
              {order.shipping.city}
              <br />
              {order.shipping.postcode}
              <br />
              {order.shipping.country}
            </address>
            <p className="muted">Tracking is emailed when the order leaves the warehouse.</p>
          </section>
          <section className="card">
            <h2>Contact</h2>
            <p className="mono">{order.email}</p>
            <p className="muted">Quote the order number in any message about this order.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function OrderNotFound({ id }: { id: string }) {
  return (
    <div className="stack">
      <a className="back-link" href="#/">
        ← All orders
      </a>
      <section className="card empty-state">
        <h1>Order not found</h1>
        <p>
          There is no order <span className="mono">{id}</span> on this account. Check the link, or go back to the list.
        </p>
        <a className="button" href="#/">
          Back to orders
        </a>
      </section>
    </div>
  );
}
