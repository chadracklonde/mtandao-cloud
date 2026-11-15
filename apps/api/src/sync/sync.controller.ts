import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/auth.guard';
import { AuthenticatedRequest } from '../auth/auth.types';
import { SyncEventsBatchDto } from './sync-event.dto';
import { SyncService } from './sync.service';

@Controller('sites/:siteId/sync/events')
@UseGuards(SupabaseAuthGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post()
  ingest(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body() batch: SyncEventsBatchDto,
    @Req() request: AuthenticatedRequest,
  ) {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    return this.syncService.ingest(siteId, batch, token);
  }
}
