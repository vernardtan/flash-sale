import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class CreateTransactionDto {
  /** Server-generated idempotency handle returned by POST /checkouts. */
  @IsUUID()
  requestId!: string;

  /**
   * Development-only identity. Must match the checkout owner; production
   * would derive this from an authenticated principal.
   */
  @IsString()
  @IsNotEmpty()
  userId!: string;
}
