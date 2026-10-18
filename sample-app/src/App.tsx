import { useEffect, useState } from 'react';
import { findOrder, listOrders } from './api/orders';
import { OrderDetail, OrderNotFound } from './components/OrderDetail';
import { OrderList } from './components/OrderList';
import { PortalHeader } from './components/PortalHeader';

function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || '#/');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function App() {
  const route = useHashRoute();
  const match = /^#\/orders\/([^/?#]+)$/.exec(route);
  const orderId = match ? decodeURIComponent(match[1]) : null;
  const order = orderId ? findOrder(orderId) : undefined;

  return (
    <div className="shell">
      <PortalHeader />
      <main className="page">
        {orderId ? order ? <OrderDetail order={order} /> : <OrderNotFound id={orderId} /> : <OrderList orders={listOrders()} />}
      </main>
      <footer className="portal-footer">
        <span>Northwind Commerce · Customer Portal</span>
        <span>Synthetic demo data. The workspace resets nightly.</span>
      </footer>
    </div>
  );
}
