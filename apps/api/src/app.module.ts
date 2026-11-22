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
import { PaymentWebhookController, PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { WebhookService } from './payments/webhook.service';
import { PortalController } from './portal/portal.controller';
import { PortalService } from './portal/portal.service';
import { AssistantController } from './assistant/assistant.controller';
import { AssistantService } from './assistant/assistant.service';
import { ReadinessController } from './readiness/readiness.controller';
import { ReadinessService } from './readiness/readiness.service';

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
    PaymentsController,
    PaymentWebhookController,
    PortalController,
    AssistantController,
    ReadinessController,
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
    PaymentsService,
    WebhookService,
    PortalService,
    AssistantService,
    ReadinessService,
  ],
})
export class AppModule {}
