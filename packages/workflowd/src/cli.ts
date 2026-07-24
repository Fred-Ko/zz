#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkflowHandler } from "./server";
import { SqliteWorkflowRegistry } from "./sqlite-store";

const databasePath = process.env.WORKFLOWD_DB_PATH ?? path.join(os.homedir(), ".zz", "workflowd.db");
await fs.mkdir(path.dirname(databasePath), { recursive: true });
const store = new SqliteWorkflowRegistry(databasePath);
await store.migrate();

const host = process.env.WORKFLOWD_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.WORKFLOWD_PORT ?? "8890", 10);
const server = Bun.serve({ hostname: host, port, fetch: createWorkflowHandler(store) });
process.stdout.write(`zz-workflowd listening on ${server.url}\n`);

async function shutdown(): Promise<void> {
	server.stop(false);
	await store.close();
}

process.once("SIGINT", () => {
	void shutdown();
});
process.once("SIGTERM", () => {
	void shutdown();
});
