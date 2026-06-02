import { parseMcpArgs, runMcp } from "@mcp/index.js";
import { getLogger } from "@shared/logger.js";

const log = getLogger("mcp/entry");

const config = parseMcpArgs(process.argv);
runMcp(config).catch((err) => {
  log.fatal({ err }, "mcp-server failed to start");
  process.exit(1);
});
