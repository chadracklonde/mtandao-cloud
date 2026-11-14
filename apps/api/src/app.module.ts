import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { SupabaseAuthGuard } from './auth/auth.guard';
import { SitesController } from './sites/sites.controller';
import { SitesService } from './sites/sites.service';
import { InvitationsController } from './invitations/invitations.controller';
import { InvitationsService } from './invitations/invitations.service';
import { RoutersController } from './routers/routers.controller';
import { RoutersService } from './routers/routers.service';
import { GatewayEnrollmentController } from './gateway/gateway-enrollment.controller';
import { GatewayEnrollmentService } from './gateway/gateway-enrollment.service';
import { GatewayHeartbeatController } from './gateway/gateway-heartbeat.controller';
import { GatewayHeartbeatService } from './gateway/gateway-heartbeat.service';

@Module({
  controllers: [
    HealthController,
    SitesController,
    InvitationsController,
    RoutersController,
    GatewayEnrollmentController,
    GatewayHeartbeatController,
  ],
  providers: [
    SupabaseAuthGuard,
    SitesService,
    InvitationsService,
    RoutersService,
    GatewayEnrollmentService,
    GatewayHeartbeatService,
  ],
})
export class AppModule {}
