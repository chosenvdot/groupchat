import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_PORT } from '@avorant/shared';
import { openDatabase, openMemoryDatabase, type DB } from './db/database.js';
import { Store, type StoreOptions } from './db/store.js';
import { ProtocolEngine } from './engine/protocolEngine.js';
import { buildHttpApp } from './http/app.js';
import { McpEndpoint } from './mcp/mcpEndpoint.js';
import { EventBus } from './wake/eventBus.js';
import { NoticeBoard } from './wake/notices.js';
import { StopPollRegistry } from './wake/stopPollRegistry.js';

export interface StartServerOptions {
  /** SQLite file path; omit (or pass db) for in-memory (tests). */
  dbPath?: string;
  db?: DB;
  /** 0 = ephemeral (tests). Defaults to 4815. */
  port?: number;
  storeOptions?: StoreOptions;
}

export interface ServerHandle {
  port: number;
  store: Store;
  engine: ProtocolEngine;
  bus: EventBus;
  close: () => Promise<void>;
}

/**
 * Boot the whole backend: store + engine + HTTP (MCP & hook routes) on
 * 127.0.0.1. Electron main calls this; tests call it with port 0.
 */
export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
  const db = options.db ?? (options.dbPath ? openDatabase(options.dbPath) : openMemoryDatabase());
  const store = new Store(db, options.storeOptions);
  const bus = new EventBus(store);
  const polls = new StopPollRegistry();
  const notices = new NoticeBoard();
  const engine = new ProtocolEngine({ store, bus, polls, notices });

  let actualPort = options.port ?? DEFAULT_PORT;
  const mcp = new McpEndpoint(engine, () => [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, '127.0.0.1', 'localhost']);
  const app = buildHttpApp(engine, mcp);
  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_PORT, '127.0.0.1', () => resolve());
  });
  actualPort = (server.address() as AddressInfo).port;

  const stopSweeping = engine.startSweeping();

  return {
    port: actualPort,
    store,
    engine,
    bus,
    close: async () => {
      stopSweeping();
      engine.polls.resolveAll({ action: 'release', reason: 'server shutting down' });
      await mcp.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
