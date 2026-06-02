import puppeteer, { type Browser } from "puppeteer-core";
import { getLogger } from "@shared/logger.js";

const log = getLogger("daemon/browser");

export interface BrowserOptions {
  executablePath?: string;
  headless?: boolean;
  userDataDir?: string;
}

const DEFAULT_FLAGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=TranslateUI,IsolateOrigins,site-per-process",
  "--no-first-run",
  "--no-default-browser-check",
];

export async function launchBrowser(opts: BrowserOptions = {}): Promise<Browser> {
  const executablePath = opts.executablePath ?? process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
  const headless = opts.headless ?? true;

  log.info({ executablePath, headless }, "launching Chrome");

  const browser = await puppeteer.launch({
    executablePath,
    headless,
    pipe: true,
    args: DEFAULT_FLAGS,
    userDataDir: opts.userDataDir,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });

  browser.on("disconnected", () => {
    log.warn("Chrome disconnected");
  });

  const version = await browser.version();
  log.info({ version }, "Chrome launched");
  return browser;
}
