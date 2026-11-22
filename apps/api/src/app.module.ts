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
import { SyncController } from './sync/sync.controller';
import { SyncService } from './sync/sync.service';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { CommerceController } from './commerce/commerce.controller';
import { CommerceService } from './commerce/commerce.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { CommandsController, GatewayCommandsController } from './commands/commands.controller';
import { CommandsService } from './commands/commands.service';

@Module({
  controllers: [
    HealthController,
    SitesController,
    InvitationsController,
    RoutersController,
    GatewayEnrollmentController,
    GatewayHeartbeatController,
    SyncController,
    AuditController,
    CommerceController,
    ReportsController,
    CommandsController,
    GatewayCommandsController,
  ],
  providers: [
    SupabaseAuthGuard,
    SitesService,
    InvitationsService,
    RoutersService,
    GatewayEnrollmentService,
    GatewayHeartbeatService,
    SyncService,
    AuditService,
    CommerceService,
    ReportsService,
    CommandsService,
  ],
})
export class AppModule {}
