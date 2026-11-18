import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  // rawBody: payment webhooks verify signatures over the exact bytes received.
  const app = configureApp(await NestFactory.create(AppModule, { rawBody: true }));
  const port = process.env.PORT || 4000;
  await app.listen(port);
  console.log(`🚀 Server running on http://localhost:${port} (docs: /api/docs)`);
}
bootstrap();
