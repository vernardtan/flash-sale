import { Injectable } from '@nestjs/common';

/**
 * Time source. All sale-window logic reads time through this service so
 * tests can substitute a fixed instant. All comparisons are UTC end to end
 * (timestamptz in PostgreSQL, Date in TypeScript).
 */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
