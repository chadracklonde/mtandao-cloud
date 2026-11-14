import {
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Body,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { readBearerToken, SupabaseAuthGuard } from '../auth/auth.guard';
import { AuthenticatedRequest } from '../auth/auth.types';
import { CreateInvitationDto } from './create-invitation.dto';
import { InvitationsService } from './invitations.service';

@Controller()
@UseGuards(SupabaseAuthGuard)
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post('sites/:siteId/invitations')
  create(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body() dto: CreateInvitationDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ invitationId: string }> {
    const token = readBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Bearer token required');
    return this.invitationsService.create(siteId, dto.email, dto.role, token);
  }

  @Post('invitations/:invitationId/accept')
  accept(
    @Param('invitationId', new ParseUUIDPipe()) invitationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ siteId: string }> {
    const token = readBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Bearer token required');
    return this.invitationsService.accept(invitationId, token);
  }
}
