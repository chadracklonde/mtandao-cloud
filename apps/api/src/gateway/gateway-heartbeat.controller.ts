import {
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { GatewayHeartbeatService } from './gateway-heartbeat.service';

@Controller('gateway')
export class GatewayHeartbeatController {
  constructor(private readonly heartbeatService: GatewayHeartbeatService) {}

  @Post('heartbeat')
  heartbeat(@Headers('authorization') authorization?: string) {
    const match = authorization?.match(/^Bearer ([a-f0-9]{64})$/);
    if (!match) throw new UnauthorizedException('Gateway bearer credential required');
    return this.heartbeatService.heartbeat(match[1]);
  }
}
