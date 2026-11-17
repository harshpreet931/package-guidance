import { useEffect, useState } from 'react';

export default function App() {
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    fetch('/api/orders').then((r) => r.json()).then(setOrders).catch(() => setOrders([]));
  }, []);
  return (
    <main>
      <h1>Orders</h1>
      <ul>{orders.map((o) => <li key={o.id}>{o.customer} — {o.total}</li>)}</ul>
    </main>
  );
}
