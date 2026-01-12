import Fastify from "fastify";
import { registerRoutes } from "./routes.js";

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined
  },
  bodyLimit: 1024 * 1024 * 2
});

await registerRoutes(app);

const port = Number(process.env.PORT ?? 8787);
const host = "0.0.0.0";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
