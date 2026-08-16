import {
  require_execAsync
} from "./chunk-KPX4QND6.mjs";
import {
  esm_exports,
  init_esm as init_esm2
} from "./chunk-A6MQDKKC.mjs";
import {
  __commonJS,
  __name,
  __toCommonJS,
  init_esm
} from "./chunk-265QJBBL.mjs";

// ../../../../.local/share/pnpm/store/v11/links/@opentelemetry/resources/2.7.1/597c46321c08e582b3119595907862a8174865d99122a2cdd16b0906ac57c615/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId-darwin.js
var require_getMachineId_darwin = __commonJS({
  "../../../../.local/share/pnpm/store/v11/links/@opentelemetry/resources/2.7.1/597c46321c08e582b3119595907862a8174865d99122a2cdd16b0906ac57c615/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId-darwin.js"(exports) {
    init_esm();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getMachineId = void 0;
    var execAsync_1 = require_execAsync();
    var api_1 = (init_esm2(), __toCommonJS(esm_exports));
    async function getMachineId() {
      try {
        const result = await (0, execAsync_1.execAsync)('ioreg -rd1 -c "IOPlatformExpertDevice"');
        const idLine = result.stdout.split("\n").find((line) => line.includes("IOPlatformUUID"));
        if (!idLine) {
          return void 0;
        }
        const parts = idLine.split('" = "');
        if (parts.length === 2) {
          return parts[1].slice(0, -1);
        }
      } catch (e) {
        api_1.diag.debug(`error reading machine id: ${e}`);
      }
      return void 0;
    }
    __name(getMachineId, "getMachineId");
    exports.getMachineId = getMachineId;
  }
});
export default require_getMachineId_darwin();
//# sourceMappingURL=getMachineId-darwin-G6T6JD4A.mjs.map
