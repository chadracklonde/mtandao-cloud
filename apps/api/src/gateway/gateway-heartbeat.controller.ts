import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import { GatewayHeartbeatService, RouterConnectionStatus } from './gateway-heartbeat.service';

class GatewayHeartbeatDto {
  @IsOptional()
  @IsIn(['unknown', 'online', 'unavailable'])
  routerConnectionStatus?: RouterConnectionStatus;
}

@Controller('gateway')
export class GatewayHeartbeatController {
  constructor(private readonly heartbeatService: GatewayHeartbeatService) {}

  @Post('heartbeat')
  heartbeat(
    @Headers('authorization') authorization?: string,
    @Body() body: GatewayHeartbeatDto = {},
  ) {
    const match = authorization?.match(/^Bearer ([a-f0-9]{64})$/);
    if (!match) throw new UnauthorizedException('Gateway bearer credential required');
    return this.heartbeatService.heartbeat(
      match[1],
      body.routerConnectionStatus ?? 'unknown',
    );
  }
}
