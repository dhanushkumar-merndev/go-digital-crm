import {
  createClient,
  dist_exports
} from "../../../../../chunk-YD4LEPU7.mjs";
import {
  schedules_exports
} from "../../../../../chunk-JF2PC2IM.mjs";
import {
  __name,
  init_esm
} from "../../../../../chunk-265QJBBL.mjs";

// trigger/support-session-expiry.ts
init_esm();
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
__name(requiredEnvironment, "requiredEnvironment");
var supportSessionExpiry = schedules_exports.task({
  id: "support-session-expiry",
  cron: "* * * * *",
  run: /* @__PURE__ */ __name(async () => {
    const supabase = createClient(
      requiredEnvironment("SUPABASE_URL"),
      requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await supabase.rpc("expire_support_sessions");
    if (error) throw error;
    return { expired_sessions: data ?? 0 };
  }, "run")
});
export {
  supportSessionExpiry
};
//# sourceMappingURL=support-session-expiry.mjs.map
