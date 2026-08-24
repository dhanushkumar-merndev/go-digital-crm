import {
  defineConfig
} from "../../../../../chunk-FABYBGNY.mjs";
import {
  init_esm
} from "../../../../../chunk-COHEUWNP.mjs";

// trigger.config.ts
init_esm();
var trigger_config_default = defineConfig({
  // Keep the checked-in default aligned with the shared production project.
  // Local/staging environments can still override this through TRIGGER_PROJECT_REF.
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_lbrobdruuorfdlhdxcgt",
  runtime: "node-24",
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
