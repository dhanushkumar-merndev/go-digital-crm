import {
  defineConfig
} from "../../../../chunk-JF2PC2IM.mjs";
import {
  init_esm
} from "../../../../chunk-265QJBBL.mjs";

// trigger.config.ts
init_esm();
var trigger_config_default = defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_go_digital_marketing_crm",
  dirs: ["./trigger"],
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 5,
      minTimeoutInMs: 1e3,
      maxTimeoutInMs: 3e4,
      factor: 2,
      randomize: true
    }
  },
  build: {}
});
var resolveEnvVars = void 0;
export {
  trigger_config_default as default,
  resolveEnvVars
};
//# sourceMappingURL=trigger.config.mjs.map
