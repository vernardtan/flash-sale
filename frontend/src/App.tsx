import { useCallback, useEffect, useState } from 'react';
import './App.css';
import {
  api,
  ApiError,
  type CheckoutResponse,
  type PaymentMethod,
  type Product,
  type SaleStatusResponse,
  type TransactionResponse,
} from './api';

const STATUS_LABEL: Record<string, string> = {
  DISABLED: 'Sale Disabled',
  UPCOMING: 'Upcoming',
  ACTIVE: 'LIVE NOW',
  ENDED: 'Sale Ended',
  SOLD_OUT: 'Sold Out',
};

type FlowState =
  | { step: 'browse' }
  | { step: 'checkout'; checkout: CheckoutResponse }
  | { step: 'processing' }
  | { step: 'success'; transaction: TransactionResponse }
  | { step: 'error'; code: string; message: string };

function App() {
  const [userId, setUserId] = useState(
    () => localStorage.getItem('flash-sale-userId') ?? '',
  );
  const [saleStatus, setSaleStatus] = useState<SaleStatusResponse | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [paymentMethod, setPaymentMethod] = useState('GCASH');
  const [flow, setFlow] = useState<FlowState>({ step: 'browse' });

  const refresh = useCallback(async () => {
    const trimmed = userId.trim();
    try {
      const [status, productList] = await Promise.all([
        api.getSaleStatus(),
        api.getProducts(trimmed || undefined),
      ]);
      setSaleStatus(status);
      setProducts(productList.products);
    } catch {
      // Transient poll failures are ignored; the next poll retries.
    }
  }, [userId]);

  useEffect(() => {
    // Initial fetch deferred to a microtask: refresh() sets state after
    // awaiting, so this is not a synchronous setState-in-effect.
    queueMicrotask(() => void refresh());
    const interval = setInterval(() => void refresh(), 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    api
      .getPaymentMethods()
      .then((res) => setPaymentMethods(res.paymentMethods))
      .catch(() => setPaymentMethods([]));
  }, []);

  const onUserIdChange = (value: string) => {
    setUserId(value);
    localStorage.setItem('flash-sale-userId', value);
    setFlow({ step: 'browse' });
  };

  const product = products[0] ?? null;
  const alreadyPurchased = product?.eligibility?.reason === 'ALREADY_PURCHASED';

  const buyNow = async () => {
    if (!product) return;
    const trimmed = userId.trim();
    if (!trimmed) {
      setFlow({
        step: 'error',
        code: 'VALIDATION_FAILED',
        message: 'Enter a user identifier first.',
      });
      return;
    }
    try {
      // Quantity is locked to 1 — the flash-sale rule, enforced again by the backend.
      const checkout = await api.createCheckout({
        userId: trimmed,
        productId: product.id,
        quantity: 1,
        paymentMethod,
      });
      setFlow({ step: 'checkout', checkout });
    } catch (error) {
      setFlow(toErrorState(error));
      void refresh();
    }
  };

  const placeOrder = async (checkout: CheckoutResponse) => {
    setFlow({ step: 'processing' });
    try {
      const transaction = await api.executeTransaction({
        requestId: checkout.requestId,
        userId: userId.trim(),
      });
      setFlow({ step: 'success', transaction });
      void refresh();
    } catch (error) {
      setFlow(toErrorState(error));
      void refresh();
    }
  };

  return (
    <main className="container">
      <h1>⚡ Flash Sale</h1>

      <section className={`banner status-${saleStatus?.status ?? 'loading'}`}>
        {saleStatus ? STATUS_LABEL[saleStatus.status] : 'Loading…'}
        {saleStatus?.status === 'ACTIVE' &&
          saleStatus.remainingStock !== null && (
            <span className="stock"> — {saleStatus.remainingStock} left</span>
          )}
      </section>

      {saleStatus?.status === 'UPCOMING' && saleStatus.startTime && (
        <p className="muted">
          Starts at {new Date(saleStatus.startTime).toLocaleString()}
        </p>
      )}
      {saleStatus?.status === 'ENDED' && saleStatus.endTime && (
        <p className="muted">
          Ended at {new Date(saleStatus.endTime).toLocaleString()}
        </p>
      )}

      <label className="field">
        User ID
        <input
          value={userId}
          onChange={(e) => onUserIdChange(e.target.value)}
          placeholder="e.g. user-123"
        />
      </label>

      {product && (
        <section className="card">
          <h2>{product.name}</h2>
          {product.description && (
            <p className="muted">{product.description}</p>
          )}
          <p className="price">
            {product.currency} {product.price}
          </p>
          <p className="muted">
            {product.remainingStock} / {product.totalStock} remaining
          </p>

          {alreadyPurchased ? (
            <p className="notice success">✅ You already secured this item.</p>
          ) : flow.step === 'browse' || flow.step === 'error' ? (
            <>
              <label className="field">
                Payment method
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                >
                  {paymentMethods.map((method) => (
                    <option key={method.id} value={method.id}>
                      {method.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={!product.buyNowAvailable || !userId.trim()}
                onClick={() => void buyNow()}
              >
                Buy Now
              </button>
              {!product.buyNowAvailable && saleStatus?.status === 'ACTIVE' && (
                <p className="muted">Purchase not available right now.</p>
              )}
            </>
          ) : null}

          {flow.step === 'checkout' && (
            <section className="checkout">
              <h3>Checkout</h3>
              <p>
                1 × {product.name} — {flow.checkout.currency}{' '}
                {flow.checkout.unitPrice}
              </p>
              <p className="muted">
                Reserved until{' '}
                {new Date(flow.checkout.expiresAt).toLocaleTimeString()} ·
                Payment: {paymentMethod}
              </p>
              <button onClick={() => void placeOrder(flow.checkout)}>
                Place Order
              </button>
              <button
                className="link"
                onClick={() => setFlow({ step: 'browse' })}
              >
                Cancel
              </button>
            </section>
          )}

          {flow.step === 'processing' && (
            <p className="notice processing">⏳ Processing your transaction…</p>
          )}

          {flow.step === 'success' && (
            <section className="notice success">
              <h3>🎉 Purchase successful!</h3>
              <p>
                {flow.transaction.quantity} × {flow.transaction.currency}{' '}
                {flow.transaction.totalAmount} via{' '}
                {flow.transaction.paymentMethod}
              </p>
              <p className="muted">
                Purchase ID: {flow.transaction.purchaseId}
              </p>
            </section>
          )}

          {flow.step === 'error' && (
            <p className="notice error">
              {flow.code === 'TRANSACTION_PROCESSING'
                ? '⏳ Your transaction is being processed…'
                : `❌ ${flow.message}`}
            </p>
          )}
        </section>
      )}
    </main>
  );
}

function toErrorState(error: unknown): FlowState {
  if (error instanceof ApiError) {
    return { step: 'error', code: error.code, message: error.message };
  }
  return {
    step: 'error',
    code: 'INTERNAL_ERROR',
    message: 'Network error — please try again.',
  };
}

export default App;
