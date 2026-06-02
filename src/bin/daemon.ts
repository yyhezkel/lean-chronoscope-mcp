import { parseDaemonArgs, runDaemon } from "@daemon/index.js";
import { getLogger } from "@shared/logger.js";

const log = getLogger("daemon/entry");

const config = parseDaemonArgs(process.argv);
runDaemon(config).catch((err) => {
  log.fatal({ err }, "daemon failed to start");
  process.exit(1);
});
