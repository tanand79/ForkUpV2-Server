import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { mountLegacyApi } from "./legacy/mount";
import { config } from "./legacy/config";
import { startSettlementWorker } from "./legacy/lib/settlement-worker";

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const expressApp = app.getHttpAdapter().getInstance();
  mountLegacyApi(expressApp);

  await app.listen(config.port, "0.0.0.0");
  console.log(
    `ForkUp API (NestJS) on port ${config.port} (${config.nodeEnv}, db: ${config.databaseTarget})`,
  );
  startSettlementWorker();
}

bootstrap().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
