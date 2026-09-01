const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export type SaleStatus =
  'DISABLED' | 'UPCOMING' | 'ACTIVE' | 'ENDED' | 'SOLD_OUT';

export interface SaleStatusResponse {
  status: SaleStatus;
  productId: string | null;
  startTime: string | null;
  endTime: string | null;
  remainingStock: number | null;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  price: string;
  currency: string;
  totalStock: number;
  remainingStock: number;
  sale: { status: SaleStatus; startTime: string; endTime: string } | null;
  eligibility: { eligible: boolean; reason: string | null } | null;
  buyNowAvailable: boolean;
}

export interface PaymentMethod {
  id: string;
  name: string;
}

export interface CheckoutResponse {
  requestId: string;
  checkoutId: string;
  status: 'PENDING';
  productId: string;
  quantity: number;
  unitPrice: string;
  currency: string;
  expiresAt: string;
}

export interface TransactionResponse {
  purchaseId: string;
  requestId: string;
  status: 'COMPLETED';
  productId: string;
  quantity: number;
  unitPrice: string;
  totalAmount: string;
  currency: string;
  paymentMethod: string;
  createdAt: string;
}

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body as { code?: string; message?: string } | null;
    throw new ApiError(
      err?.code ?? 'INTERNAL_ERROR',
      err?.message ?? `Request failed (${res.status})`,
    );
  }
  return body as T;
}

export const api = {
  getSaleStatus: () => request<SaleStatusResponse>('/sale/status'),
  getProducts: (userId?: string) =>
    request<{ products: Product[] }>(
      `/products${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`,
    ),
  getPaymentMethods: () =>
    request<{ paymentMethods: PaymentMethod[] }>('/payment-methods'),
  createCheckout: (payload: {
    userId: string;
    productId: string;
    quantity: number;
    paymentMethod: string;
  }) =>
    request<CheckoutResponse>('/checkouts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  executeTransaction: (payload: { requestId: string; userId: string }) =>
    request<TransactionResponse>('/transactions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
