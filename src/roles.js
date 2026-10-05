/** 病例角色层级与比较。 */

export const ROLE_ORDER = [
  "observer", // 观摩
  "assistant", // 助手
  "co_surgeon", // 共同术者
  "chief_under_supervision", // 督导下主刀
  "independent_chief", // 独立主刀
];

export function roleLevel(role) {
  const i = ROLE_ORDER.indexOf(role);
  if (i < 0) throw new Error(`未知角色：${role}`);
  return i;
}

/** 持有的角色能否覆盖被查询的角色（独立主刀可向下兼容）。 */
export function roleCovers(held, requested) {
  return roleLevel(held) >= roleLevel(requested);
}
