import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { readBearerToken, SupabaseAuthGuard } from '../auth/auth.guard';
import { AuthenticatedRequest } from '../auth/auth.types';
import { CreateSiteDto } from './create-site.dto';
import { SitesService } from './sites.service';

@Controller('sites')
@UseGuards(SupabaseAuthGuard)
export class SitesController {
  constructor(private readonly sitesService: SitesService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    const token = readBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Bearer token required');
    if (!request.user?.id) throw new UnauthorizedException('Authenticated user required');
    return this.sitesService.list(token, request.user.id);
  }

  @Post()
  create(
    @Body() dto: CreateSiteDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ id: string }> {
    const token = readBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Bearer token required');
    return this.sitesService.create(dto, token);
  }
}
