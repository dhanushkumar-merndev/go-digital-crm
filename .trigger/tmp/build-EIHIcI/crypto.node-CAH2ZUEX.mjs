import {
  __name,
  init_esm
} from "./chunk-265QJBBL.mjs";

// ../../../../.local/share/pnpm/store/v11/links/@/uncrypto/0.1.3/9dc42a76f825761d2fdcd18ae3ba0018b80cdcf6885dda28fb8a58a80293fdb9/node_modules/uncrypto/dist/crypto.node.mjs
init_esm();
import nodeCrypto from "node:crypto";
var subtle = nodeCrypto.webcrypto?.subtle || {};
var randomUUID = /* @__PURE__ */ __name(() => {
  return nodeCrypto.randomUUID();
}, "randomUUID");
var getRandomValues = /* @__PURE__ */ __name((array) => {
  return nodeCrypto.webcrypto.getRandomValues(array);
}, "getRandomValues");
var _crypto = {
  randomUUID,
  getRandomValues,
  subtle
};
export {
  _crypto as default,
  getRandomValues,
  randomUUID,
  subtle
};
//# sourceMappingURL=crypto.node-CAH2ZUEX.mjs.map
