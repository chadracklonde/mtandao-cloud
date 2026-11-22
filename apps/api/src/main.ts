import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.setGlobalPrefix('v1');
  // Behind a reverse proxy (Render, Cloud Run) set TRUST_PROXY_HOPS=1 so rate
  // limits see the real client address. The default trusts no forwarded header.
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (Number.isInteger(hops) && hops > 0 && hops <= 5) {
    (app.getHttpAdapter().getInstance() as { set(key: string, value: unknown): void }).set('trust proxy', hops);
  }
  const dashboardOrigin = process.env.DASHBOARD_ORIGIN?.trim();
  if (dashboardOrigin) {
    app.enableCors({ origin: dashboardOrigin, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type', 'Accept'] });
  }
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
}
void bootstrap();
