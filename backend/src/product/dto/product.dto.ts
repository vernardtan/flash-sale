import type { SaleStatus } from '../../sale/sale.service.js';

export interface ProductEligibility {
  eligible: boolean;
  reason: string | null;
}

export interface ProductResponse {
  id: string;
  name: string;
  description: string | null;
  /** Money serialized as a fixed-precision string, never a float. */
  price: string;
  currency: string;
  totalStock: number;
  remainingStock: number;
  sale: {
    status: SaleStatus;
    startTime: string;
    endTime: string;
  } | null;
  /** Present only when a userId query parameter was supplied. */
  eligibility: ProductEligibility | null;
  buyNowAvailable: boolean;
}