import { createServer, type Server } from "node:http";
import type { Logger } from "pino";
import type { BridgeState } from "../types";

export interface HealthServerOptions {
  port: number;
  logger: Pick<Logger, "info" | "warn">;
  getBridgeState: () => BridgeState;
}

export class HealthServer {
  private readonly port: number;
  private readonly logger: Pick<Logger, "info" | "warn">;
  private readonly getBridgeState: () => BridgeState;
  private server: Server | null = null;

  constructor(options: HealthServerOptions) {
    this.port = options.port;
    this.logger = options.logger;
    this.getBridgeState = options.getBridgeState;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/healthz") {
        const body = JSON.stringify(this.getBridgeState());
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        });
        response.end(body);
        return;
      }

      response.writeHead(404, {
        "Content-Type": "text/plain"
      });
      response.end("Not Found");
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server?.off("listening", onListening);
        reject(error);
      };

      const onListening = (): void => {
        this.server?.off("error", onError);
        resolve();
      };

      this.server?.once("error", onError);
      this.server?.once("listening", onListening);
      this.server?.listen(this.port);
    });

    this.logger.info({ port: this.port }, "Health endpoint is listening");
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve) => {
      server.close((error) => {
        if (error) {
          this.logger.warn({ error }, "Error while shutting down health endpoint");
        }
        resolve();
      });
    });
  }
}
