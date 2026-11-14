import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { SupabaseAuthGuard } from './auth/auth.guard';
import { SitesController } from './sites/sites.controller';
import { SitesService } from './sites/sites.service';

@Module({
  controllers: [HealthController, SitesController],
  providers: [SupabaseAuthGuard, SitesService],
})
export class AppModule {}
