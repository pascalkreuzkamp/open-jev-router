import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The router's own version, recorded on every telemetry session for later compatibility work. */
export const ROUTER_VERSION = require("../package.json").version;
