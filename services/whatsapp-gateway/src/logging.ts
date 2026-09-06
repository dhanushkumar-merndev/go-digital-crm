// Some upstream Signal code logs entire key objects through console.warn.
// This isolated service never emits third-party console arguments. Operational
// status lives in the masked session RPC and /health, not provider debug logs.
const silent = () => undefined;
console.log = silent;
console.info = silent;
console.warn = silent;
console.error = silent;
console.debug = silent;
