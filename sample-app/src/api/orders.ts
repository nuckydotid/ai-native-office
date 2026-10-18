/**
 * The customer portal's data: synthetic orders from Northwind Commerce. Everything here is invented, and no value in this file is a
 * real customer, address or payment.
 */

export const ORDER_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderLine {
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface ShippingAddress {
  address: string;
  city: string;
  postcode: string;
  country: string;
}

export interface Order {
  id: string;
  customer: string;
  email: string;
  placedAt: string;
  status: OrderStatus;
  lines: OrderLine[];
  shipping: ShippingAddress;
}

export const orders: readonly Order[] = [
  {
    id: 'o-1001',
    customer: 'Harbour Outfitters',
    email: 'orders@harbour-outfitters.example',
    placedAt: '2026-10-02',
    status: 'shipped',
    lines: [
      { sku: 'NW-WAX-01', name: 'Waxed canvas tote', quantity: 12, unitPrice: 28.5 },
      { sku: 'NW-ROPE-04', name: 'Braided rope handle', quantity: 12, unitPrice: 9.75 },
    ],
    shipping: { address: '18 Quay Street', city: 'Bristol', postcode: 'BS1 4RN', country: 'United Kingdom' },
  },
  {
    id: 'o-1002',
    customer: 'The Paper Kite',
    email: 'hello@paperkite.example',
    placedAt: '2026-09-27',
    status: 'delivered',
    lines: [
      { sku: 'NW-NOTE-12', name: 'Recycled notebook, pack of 12', quantity: 4, unitPrice: 36 },
      { sku: 'NW-PENCIL-24', name: 'Cedar pencil set', quantity: 4, unitPrice: 14.25 },
    ],
    shipping: { address: '7 Market Lane', city: 'York', postcode: 'YO1 7LQ', country: 'United Kingdom' },
  },
  {
    id: 'o-1003',
    customer: 'Brecon Bikes',
    email: 'parts@breconbikes.example',
    placedAt: '2026-10-09',
    status: 'processing',
    lines: [
      { sku: 'NW-BAG-09', name: 'Saddle bag, olive', quantity: 8, unitPrice: 42 },
      { sku: 'NW-STRAP-02', name: 'Leather strap pair', quantity: 8, unitPrice: 18.5 },
    ],
    shipping: { address: '4 Mill Yard', city: 'Brecon', postcode: 'LD3 7AB', country: 'United Kingdom' },
  },
  {
    id: 'o-1004',
    customer: 'Moss & Fern',
    email: 'studio@mossandfern.example',
    placedAt: '2026-10-05',
    status: 'shipped',
    lines: [
      { sku: 'NW-APRON-03', name: 'Canvas work apron', quantity: 6, unitPrice: 31 },
      { sku: 'NW-GLOVE-05', name: 'Gardening gloves, small', quantity: 6, unitPrice: 12.75 },
    ],
    shipping: { address: '22 Orchard Road', city: 'Hereford', postcode: 'HR1 2AA', country: 'United Kingdom' },
  },
  {
    id: 'o-1005',
    customer: 'Atelier Nord',
    email: 'buying@ateliernord.example',
    placedAt: '2026-09-18',
    status: 'cancelled',
    lines: [{ sku: 'NW-LAMP-07', name: 'Desk lamp, brushed steel', quantity: 3, unitPrice: 64 }],
    shipping: { address: '9 Crown Passage', city: 'Edinburgh', postcode: 'EH1 1AA', country: 'United Kingdom' },
  },
  {
    id: 'o-1006',
    customer: 'Cobalt Studio',
    email: 'ops@cobaltstudio.example',
    placedAt: '2026-09-12',
    status: 'delivered',
    lines: [
      { sku: 'NW-CABLE-11', name: 'Braided cable tidy', quantity: 20, unitPrice: 6.4 },
      { sku: 'NW-TRAY-06', name: 'Oak desk tray', quantity: 10, unitPrice: 24 },
    ],
    shipping: { address: '31 Foundry Street', city: 'Leeds', postcode: 'LS2 7AA', country: 'United Kingdom' },
  },
  {
    id: 'o-1007',
    customer: 'Riverstone Deli',
    email: 'shop@riverstone.example',
    placedAt: '2026-10-11',
    status: 'processing',
    lines: [
      { sku: 'NW-BOARD-08', name: 'Beech serving board', quantity: 5, unitPrice: 38 },
      { sku: 'NW-CLOTH-10', name: 'Linen cloth, pair', quantity: 10, unitPrice: 16 },
    ],
    shipping: { address: '2 Bridge Parade', city: 'Bath', postcode: 'BA2 4AS', country: 'United Kingdom' },
  },
  {
    id: 'o-1008',
    customer: 'Lantern Goods',
    email: 'team@lanterngoods.example',
    placedAt: '2026-10-07',
    status: 'shipped',
    lines: [{ sku: 'NW-BOX-14', name: 'Folding storage box', quantity: 15, unitPrice: 21.5 }],
    shipping: { address: '56 Lantern Hill', city: 'London', postcode: 'E17 4AA', country: 'United Kingdom' },
  },
];

/** Every order. The server reads this; a change set may change how it is selected, not who may call it. */
export function listOrders(): readonly Order[] {
  return orders;
}

export function findOrder(id: string): Order | undefined {
  return orders.find((order) => order.id === id);
}

export function filterOrders(list: readonly Order[], status: OrderStatus | 'all', query: string): Order[] {
  const needle = query.trim().toLowerCase();
  return list.filter((order) => {
    if (status !== 'all' && order.status !== status) return false;
    if (!needle) return true;
    const haystack = [order.id, order.customer, order.email, order.shipping.city, ...order.lines.map((line) => line.name)].join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}

export const lineTotal = (line: OrderLine): number => line.quantity * line.unitPrice;

export const orderTotal = (order: Pick<Order, 'lines'>): number => order.lines.reduce((sum, line) => sum + lineTotal(line), 0);

export const orderUnits = (order: Pick<Order, 'lines'>): number => order.lines.reduce((sum, line) => sum + line.quantity, 0);

export interface OrdersSummary {
  total: number;
  open: number;
  revenue: number;
  byStatus: Record<OrderStatus, number>;
}

export function ordersSummary(list: readonly Order[] = orders): OrdersSummary {
  const byStatus = { processing: 0, shipped: 0, delivered: 0, cancelled: 0 } satisfies Record<OrderStatus, number>;
  let revenue = 0;
  for (const order of list) {
    byStatus[order.status] += 1;
    if (order.status !== 'cancelled') revenue += orderTotal(order);
  }
  return {
    total: list.length,
    open: byStatus.processing + byStatus.shipped,
    revenue: Math.round(revenue * 100) / 100,
    byStatus,
  };
}

export const statusLabel = (status: OrderStatus): string =>
  status === 'processing' ? 'Processing' : status === 'shipped' ? 'Shipped' : status === 'delivered' ? 'Delivered' : 'Cancelled';

export const formatMoney = (value: number): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2 }).format(value);

export const formatDate = (iso: string): string => {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
};
