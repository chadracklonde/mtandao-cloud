import {
  Controller,\n  Get,
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
import { CreateRouterDto } from './create-router.dto';
import { RoutersService } from './routers.service';

@Controller('sites/:siteId/routers')
@UseGuards(SupabaseAuthGuard)
export class RoutersController {
  constructor(private readonly routersService: RoutersService) {}

  @Get()\n  list(\n    @Param('siteId', new ParseUUIDPipe()) siteId: string,\n    @Req() request: AuthenticatedRequest,\n  ) {\n    const token = readBearerToken(request.headers.authorization);\n    if (!token) throw new UnauthorizedException('Bearer token required');\n    return this.routersService.list(siteId, token);\n  }\n\n  @Post()
  register(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body() dto: CreateRouterDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ routerId: string; enrollmentToken: string; expiresInSeconds: number }> {
    const token = readBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Bearer token required');
    return this.routersService.register(siteId, dto, token);
  }
}
