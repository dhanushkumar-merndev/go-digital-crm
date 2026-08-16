import {
  __name,
  init_esm
} from "./chunk-265QJBBL.mjs";

// ../../../../.local/share/pnpm/store/v11/links/@trigger.dev/core/4.5.11/fcad33c333c0517d6b33a19290a8fc9bfc1c2d85bf31303838e0e2be3c36dd61/node_modules/@trigger.dev/core/dist/esm/v3/build/runtime.js
init_esm();
import { join } from "node:path";
import { pathToFileURL } from "url";

// ../../../../.local/share/pnpm/store/v11/links/@trigger.dev/core/4.5.11/fcad33c333c0517d6b33a19290a8fc9bfc1c2d85bf31303838e0e2be3c36dd61/node_modules/@trigger.dev/core/dist/esm/v3/build/flags.js
init_esm();
function dedupFlags(flags) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  const pairs = flags.split(" ").filter(Boolean).map((flag) => {
    const equalIndex = flag.indexOf("=");
    if (equalIndex !== -1) {
      const key = flag.slice(0, equalIndex).replace(/_/g, "-");
      const value = flag.slice(equalIndex + 1);
      return [key, value];
    } else {
      return [flag.replace(/_/g, "-"), true];
    }
  });
  for (const [key, value] of pairs.reverse()) {
    if (!seen.has(key)) {
      seen.add(key);
      result.unshift([key, value]);
    }
  }
  return result.map(([key, value]) => value === true ? key : `${key}=${value}`).join(" ");
}
__name(dedupFlags, "dedupFlags");

// ../../../../.local/share/pnpm/store/v11/links/@trigger.dev/core/4.5.11/fcad33c333c0517d6b33a19290a8fc9bfc1c2d85bf31303838e0e2be3c36dd61/node_modules/@trigger.dev/core/dist/esm/v3/build/runtime.js
import { homedir } from "node:os";
function execPathForRuntime(runtime) {
  switch (runtime) {
    case "node":
    case "node-22":
    case "node-24":
    case "node-26":
      return process.execPath;
    case "bun":
      if (typeof process.env.BUN_INSTALL === "string") {
        return join(process.env.BUN_INSTALL, "bin", "bun");
      }
      if (typeof process.env.BUN_INSTALL_BIN === "string") {
        return join(process.env.BUN_INSTALL_BIN, "bun");
      }
      return join(homedir(), ".bun", "bin", "bun");
    default:
      throw new Error(`Unsupported runtime ${runtime}`);
  }
}
__name(execPathForRuntime, "execPathForRuntime");
function execOptionsForRuntime(runtime, options, additionalNodeOptions) {
  switch (runtime) {
    case "node":
    case "node-22":
    case "node-24":
    case "node-26": {
      const importEntryPoint = options.loaderEntryPoint ? `--import=${pathToFileURL(options.loaderEntryPoint).href}` : void 0;
      const conditions = options.customConditions?.map((condition) => `--conditions=${condition}`);
      const flags = [
        process.env.NODE_OPTIONS,
        additionalNodeOptions,
        importEntryPoint,
        conditions,
        nodeRuntimeNeedsGlobalWebCryptoFlag() ? "--experimental-global-webcrypto" : void 0
      ].filter(Boolean).flat().join(" ");
      return dedupFlags(flags);
    }
    case "bun": {
      return "";
    }
  }
}
__name(execOptionsForRuntime, "execOptionsForRuntime");
function nodeRuntimeNeedsGlobalWebCryptoFlag() {
  try {
    return process.versions.node.startsWith("18.");
  } catch {
    return false;
  }
}
__name(nodeRuntimeNeedsGlobalWebCryptoFlag, "nodeRuntimeNeedsGlobalWebCryptoFlag");
function detectRuntimeVersion() {
  try {
    const isBun = typeof process.versions.bun === "string";
    if (isBun) {
      return process.versions.bun;
    }
    return process.versions.node;
  } catch {
    return void 0;
  }
}
__name(detectRuntimeVersion, "detectRuntimeVersion");

export {
  execPathForRuntime,
  execOptionsForRuntime,
  detectRuntimeVersion
};
//# sourceMappingURL=chunk-4BLSDYTH.mjs.map
