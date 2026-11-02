import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class CleanupTask {
  @Cron('0 * * * *')
  cleanup() {
    return 0;
  }
}
