#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./motivation.js";

async function main() {
  const transport = new StdioServerTransport();
  const { server } = createServer();
  await server.connect(transport);
}

main().catch(console.error);