import { IsIn, IsInt, IsNotEmpty, IsString, IsUUID } from 'class-validator';
import { PAYMENT_METHODS } from '../../payment/payment-methods.js';

export class CreateCheckoutDto {
  /**
   * Development-only identity. Production would derive the user from an
   * authenticated principal, never from a client-supplied field.
   */
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsUUID()
  productId!: string;

  @IsInt()
  quantity!: number;

  @IsString()
  @IsIn(PAYMENT_METHODS.map((method) => method.id))
  paymentMethod!: string;
}
