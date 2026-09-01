import { Body, Controller, Post } from '@nestjs/common';
import { RateLimit } from '../common/rate-limit/rate-limit.guard.js';
import {
  TransactionService,
  TransactionResponse,
} from './transaction.service.js';
import { CreateTransactionDto } from './dto/create-transaction.dto.js';

@Controller('transactions')
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  @Post()
  @RateLimit('transaction')
  execute(@Body() dto: CreateTransactionDto): Promise<TransactionResponse> {
    return this.transactionService.execute(dto);
  }
}
