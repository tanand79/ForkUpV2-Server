"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const app_module_1 = require("./app.module");
const mount_1 = require("./legacy/mount");
const config_1 = require("./legacy/config");
process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
});
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule, { bodyParser: false });
    const expressApp = app.getHttpAdapter().getInstance();
    (0, mount_1.mountLegacyApi)(expressApp);
    await app.listen(config_1.config.port, "0.0.0.0");
    console.log(`ForkUp API (NestJS) on port ${config_1.config.port} (${config_1.config.nodeEnv}, db: ${config_1.config.databaseTarget})`);
}
bootstrap().catch((err) => {
    console.error("Server failed to start:", err);
    process.exit(1);
});
//# sourceMappingURL=main.js.map