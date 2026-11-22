import {
  Body,
  Controller,
  Header,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { readBearerToken, SupabaseAuthGuard } from '../auth/auth.guard';
import { AuthenticatedRequest } from '../auth/auth.types';
import { RateLimiter } from '../portal/rate-limiter';
import { AskAssistantDto } from './assistant.dto';
import { AssistantAnswer, AssistantService } from './assistant.service';

const limiter = new RateLimiter();
const MINUTE = 60_000;

@Controller('sites/:siteId/assistant')
@UseGuards(SupabaseAuthGuard)
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  /** Each question can trigger several paid model calls: limit them per user. */
  private throttle(request: AuthenticatedRequest): void {
    const who = request.user?.id ?? 'anonymous';
    if (!limiter.allow(`assistant-min:${who}`, 6, MINUTE) || !limiter.allow(`assistant-hour:${who}`, 60, 60 * MINUTE)) {
      throw new HttpException('Trop de questions, patientez un instant.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  ask(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body() dto: AskAssistantDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<AssistantAnswer> {
    const token = readBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Bearer token required');
    this.throttle(request);
    return this.assistant.ask(siteId, token, dto.question, dto.history);
  }
}
