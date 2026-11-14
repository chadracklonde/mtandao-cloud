import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { SupabaseAuthGuard } from './auth/auth.guard';
import { SitesController } from './sites/sites.controller';
import { SitesService } from './sites/sites.service';
import { InvitationsController } from './invitations/invitations.controller';
import { InvitationsService } from './invitations/invitations.service';
import { RoutersController } from './routers/routers.controller';
import { RoutersService } from './routers/routers.service';

@Module({
  controllers: [HealthController, SitesController, InvitationsController, RoutersController],
  providers: [SupabaseAuthGuard, SitesService, InvitationsService, RoutersService],
})
export class AppModule {}
