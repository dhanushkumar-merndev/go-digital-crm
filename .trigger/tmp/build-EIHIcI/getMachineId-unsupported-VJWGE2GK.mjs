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

// ../../../../.local/share/pnpm/store/v11/links/@opentelemetry/resources/2.7.1/597c46321c08e582b3119595907862a8174865d99122a2cdd16b0906ac57c615/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId-unsupported.js
var require_getMachineId_unsupported = __commonJS({
  "../../../../.local/share/pnpm/store/v11/links/@opentelemetry/resources/2.7.1/597c46321c08e582b3119595907862a8174865d99122a2cdd16b0906ac57c615/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId-unsupported.js"(exports) {
    init_esm();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getMachineId = void 0;
    var api_1 = (init_esm2(), __toCommonJS(esm_exports));
    async function getMachineId() {
      api_1.diag.debug("could not read machine-id: unsupported platform");
      return void 0;
    }
    __name(getMachineId, "getMachineId");
    exports.getMachineId = getMachineId;
  }
});
export default require_getMachineId_unsupported();
//# sourceMappingURL=getMachineId-unsupported-VJWGE2GK.mjs.map
