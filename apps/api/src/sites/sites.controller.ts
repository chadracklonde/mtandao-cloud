import {
  Body,
  Controller,
  Post,
  Req,
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

  @Post()
  create(
    @Body() dto: CreateSiteDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ id: string }> {
    const token = readBearerToken(request.headers.authorization);
    if (!token) throw new Error('Authenticated request is missing its bearer token');
    return this.sitesService.create(dto, token);
  }
}
