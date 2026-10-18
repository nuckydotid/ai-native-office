import type { OrderStatus } from '../api/orders';
import { statusLabel } from '../api/orders';

export function StatusChip({ status }: { status: OrderStatus }) {
  return <span className={`status status-${status}`}>{statusLabel(status)}</span>;
}
