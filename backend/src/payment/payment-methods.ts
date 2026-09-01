/**
 * Mocked payment methods. No real payment provider integration exists in
 * this assessment; the canonical list lives here so the endpoint and the
 * checkout validator can never drift apart.
 */
export interface PaymentMethod {
  id: string;
  name: string;
}

export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  { id: 'GCASH', name: 'GCash' },
  { id: 'MAYA', name: 'Maya' },
  { id: 'CARD', name: 'Credit/Debit Card' },
];

export function isValidPaymentMethod(id: string): boolean {
  return PAYMENT_METHODS.some((method) => method.id === id);
}
