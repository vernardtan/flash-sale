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