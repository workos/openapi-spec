import type { OagenConfig } from "@workos/oagen";
import { nodeEmitter } from "@workos/oagen-emitters";
import { nodeExtractor, pythonExtractor } from "@workos/oagen/compat";

const config: OagenConfig = {
  emitters: [nodeEmitter],
  extractors: [nodeExtractor, pythonExtractor],
  docUrl: "https://workos.com/docs",
};

export default config;
