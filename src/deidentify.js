/**
 * 教学病例脱敏与同意范围执行。
 *
 * 规则：
 * - 真实患者标识（姓名、证件号、住院号、联系方式等）永不进入技能证据系统，
 *   病例只能以“脱敏引用 + 同意记录”入账。
 * - 入库前扫描自由文本，命中真实标识特征即拒绝，而不是静默替换。
 * - 可见字段随同意用途变化：research 撤回后研究视图拿不到病例细节；
 *   training / privilege_audit 依留存义务可见，访问由审计日志留痕。
 */

import { createHash } from "node:crypto";

/** 明显的真实标识特征（住院号、身份证号、手机号、邮箱等）。 */
const IDENTIFIER_PATTERNS = [
  { re: /\b\d{17}[\dXx]\b/, label: "疑似身份证号" },
  { re: /\b1[3-9]\d{9}\b/, label: "疑似手机号" },
  { re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/, label: "疑似邮箱" },
  { re: /(住院号|病案号|门诊号|护照)\s*[:：]?\s*[A-Za-z0-9-]{4,}/, label: "疑似就诊标识" },
  { re: /(姓名|真实姓名)\s*[:：]\s*\S+/, label: "疑似姓名" },
];

/**
 * 生成稳定但不可逆的病例假名（同机构盐值下可重复关联，不暴露真实身份）。
 */
export function pseudonymizeCase(hospitalId, localCaseId, salt) {
  const digest = createHash("sha256").update(`${salt}:${hospitalId}:${localCaseId}`).digest("hex").slice(0, 16);
  return `CASE-${hospitalId.toUpperCase()}-${digest}`;
}

/**
 * 脱敏一份教学病例材料。
 * @returns {{deidentified_case_ref: string, safe_text: string}}
 * @throws 含真实标识特征时直接拒绝，要求上游先脱敏。
 */
export function deidentifyTeachingCase({ hospital_id, local_case_id, salt, text = "" }) {
  for (const { re, label } of IDENTIFIER_PATTERNS) {
    if (re.test(text)) {
      throw new DeidentificationError(`${label}：病例文本必须先脱敏才能进入培训证据系统`);
    }
  }
  return {
    deidentified_case_ref: pseudonymizeCase(hospital_id, local_case_id, salt),
    safe_text: text,
  };
}

export class DeidentificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeidentificationError";
  }
}

/**
 * 按用途投影病例视图：research 用途缺失同意时整段屏蔽；
 * training/audit 用途保留技能相关字段，继续剥离身份类字段（双保险）。
 */
export function projectCaseForPurpose(caseEvent, allowedPurposes, purpose) {
  if (!allowedPurposes.includes(purpose)) {
    return {
      event_id: caseEvent.event_id,
      redacted: true,
      reason: `当前同意范围不含 ${purpose} 用途`,
    };
  }
  const { surgeon_id, procedure_code, caliber_mm, role, case_date, outcome, deidentified_case_ref } =
    caseEvent.payload ?? caseEvent;
  return {
    event_id: caseEvent.event_id,
    surgeon_id,
    procedure_code,
    caliber_mm,
    role,
    case_date,
    outcome,
    deidentified_case_ref,
  };
}
