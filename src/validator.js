/**
 * 领域事件校验：公共信封 + 按事件类型的载荷必填项与取值域。
 * 错误信息为中文，可直接展示给接入方。
 */

const REQUIRED_ENVELOPE = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
];

export const EVENT_TYPES = [
  "COURSE_VERSION_PUBLISHED",
  "SIM_TASK_DEFINED",
  "PROCEDURE_DEFINED",
  "HOSPITAL_CAPABILITY_REGISTERED",
  "COMMITTEE_REGISTERED",
  "RULESET_PUBLISHED",
  "ATTEMPT_RECORDED",
  "OBSERVATION_SIGNED",
  "CASE_ROLE_LOGGED",
  "CONSENT_RECORDED",
  "CONSENT_SCOPE_UPDATED",
  "COMPLICATION_REVIEWED",
  "COMPETENCY_REVIEWED",
  "REASSESSMENT_REQUIRED",
  "PRIVILEGE_GRANTED",
  "PRIVILEGE_SUSPENDED",
  "PRIVILEGE_RESTORED",
  "PRIVILEGE_RENEWED",
  "EVIDENCE_RETRACTED",
  "APPEAL_FILED",
  "APPEAL_DECIDED",
];

export const AGGREGATE_TYPES = [
  "course_version",
  "sim_task",
  "procedure_definition",
  "hospital_capability",
  "committee",
  "ruleset",
  "training_attempt",
  "mentor_observation",
  "case_record",
  "consent_record",
  "complication_review",
  "competency_state",
  "clinical_privilege",
  "appeal",
];

export const CASE_ROLES = [
  "observer",
  "assistant",
  "co_surgeon",
  "chief_under_supervision",
  "independent_chief",
];

/** 事件类型 → 允许的聚合类型。 */
const AGGREGATE_FOR_EVENT = {
  COURSE_VERSION_PUBLISHED: "course_version",
  SIM_TASK_DEFINED: "sim_task",
  PROCEDURE_DEFINED: "procedure_definition",
  HOSPITAL_CAPABILITY_REGISTERED: "hospital_capability",
  COMMITTEE_REGISTERED: "committee",
  RULESET_PUBLISHED: "ruleset",
  ATTEMPT_RECORDED: "training_attempt",
  OBSERVATION_SIGNED: "mentor_observation",
  CASE_ROLE_LOGGED: "case_record",
  CONSENT_RECORDED: "consent_record",
  CONSENT_SCOPE_UPDATED: "consent_record",
  COMPLICATION_REVIEWED: "complication_review",
  COMPETENCY_REVIEWED: "competency_state",
  REASSESSMENT_REQUIRED: "competency_state",
  PRIVILEGE_GRANTED: "clinical_privilege",
  PRIVILEGE_SUSPENDED: "clinical_privilege",
  PRIVILEGE_RESTORED: "clinical_privilege",
  PRIVILEGE_RENEWED: "clinical_privilege",
  EVIDENCE_RETRACTED: "training_attempt",
  APPEAL_FILED: "appeal",
  APPEAL_DECIDED: "appeal",
};

/** 事件类型 → payload 必填字段。 */
const PAYLOAD_REQUIRED = {
  COURSE_VERSION_PUBLISHED: ["course_code", "course_version", "title", "delivery_modes", "published_at"],
  SIM_TASK_DEFINED: [
    "task_code",
    "task_version",
    "procedure_code",
    "caliber_mm",
    "pass_threshold",
    "required_consecutive_passes",
    "equipment",
  ],
  PROCEDURE_DEFINED: ["procedure_code", "name", "caliber_min_mm", "caliber_max_mm"],
  HOSPITAL_CAPABILITY_REGISTERED: [
    "hospital_id",
    "hospital_name",
    "equipment_condition_id",
    "equipment_condition_name",
    "supported_procedures",
  ],
  COMMITTEE_REGISTERED: ["committee_id", "hospital_id", "name", "member_ids", "quorum"],
  RULESET_PUBLISHED: ["ruleset_version", "published_at", "role_requirements"],
  ATTEMPT_RECORDED: ["surgeon_id", "kind", "completed_at"],
  OBSERVATION_SIGNED: [
    "surgeon_id",
    "observer_mentor_id",
    "procedure_code",
    "caliber_mm",
    "role",
    "observed_at",
    "rating",
    "comments",
  ],
  CASE_ROLE_LOGGED: [
    "surgeon_id",
    "procedure_code",
    "caliber_mm",
    "role",
    "case_date",
    "deidentified_case_ref",
    "consent_record_id",
  ],
  CONSENT_RECORDED: ["consent_record_id", "subject_pseudonym", "purposes", "granted_at", "statement"],
  CONSENT_SCOPE_UPDATED: ["consent_record_id", "subject_pseudonym", "purposes", "changed_at", "reason"],
  COMPLICATION_REVIEWED: [
    "surgeon_id",
    "case_ref",
    "procedure_code",
    "caliber_mm",
    "role",
    "occurred_at",
    "category",
    "severity",
    "disposition",
    "findings",
  ],
  COMPETENCY_REVIEWED: [
    "surgeon_id",
    "procedure_code",
    "stage",
    "decision",
    "reviewed_at",
    "reviewer_ids",
    "notes",
    "based_on_event_ids",
    "ruleset_version",
  ],
  REASSESSMENT_REQUIRED: ["surgeon_id", "procedure_code", "required_at", "reason"],
  PRIVILEGE_GRANTED: [
    "privilege_id",
    "surgeon_id",
    "scope",
    "granted_at",
    "valid_until",
    "decision",
    "based_on_event_ids",
    "ruleset_version",
  ],
  PRIVILEGE_SUSPENDED: ["privilege_id", "surgeon_id", "scope", "suspended_at", "reason", "decision"],
  PRIVILEGE_RESTORED: [
    "privilege_id",
    "surgeon_id",
    "scope",
    "restored_at",
    "valid_until",
    "decision",
    "based_on_event_ids",
  ],
  PRIVILEGE_RENEWED: [
    "privilege_id",
    "surgeon_id",
    "scope",
    "renewed_at",
    "valid_until",
    "decision",
    "based_on_event_ids",
    "ruleset_version",
  ],
  EVIDENCE_RETRACTED: ["evidence_event_id", "surgeon_id", "retracted_at", "reason", "retention_basis", "retained_until"],
  APPEAL_FILED: ["appeal_id", "surgeon_id", "against_decision_id", "scope", "filed_at", "grounds"],
  APPEAL_DECIDED: ["appeal_id", "surgeon_id", "decided_at", "outcome", "decision", "rationale"],
};

function isIsoDateTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function checkDecision(payload, errors, prefix = "decision") {
  const d = payload.decision;
  if (!d || typeof d !== "object") {
    errors.push(`${prefix}：缺少委员会签署块`);
    return;
  }
  for (const field of ["decision_id", "committee_id", "signed_at", "signatories"]) {
    if (!(field in d)) errors.push(`${prefix}.${field}：签署块缺少字段`);
  }
  if (Array.isArray(d.signatories) && d.signatories.length < 1) {
    errors.push(`${prefix}.signatories：至少一名签署委员`);
  }
  if ("signed_at" in d && !isIsoDateTime(d.signed_at)) errors.push(`${prefix}.signed_at：时间格式无效`);
}

function checkScope(scope, errors) {
  if (!scope || typeof scope !== "object") {
    errors.push("scope：缺少授权范围");
    return;
  }
  for (const field of [
    "hospital_id",
    "equipment_condition_id",
    "procedure_code",
    "caliber_min_mm",
    "caliber_max_mm",
    "role",
  ]) {
    if (!(field in scope)) errors.push(`scope.${field}：授权范围缺少字段`);
  }
  if ("role" in scope && !CASE_ROLES.includes(scope.role)) errors.push(`scope.role：非法病例角色 ${scope.role}`);
  if (
    "caliber_min_mm" in scope &&
    "caliber_max_mm" in scope &&
    Number(scope.caliber_min_mm) > Number(scope.caliber_max_mm)
  ) {
    errors.push("scope：口径最小值不得大于最大值");
  }
}

/** 返回中文错误数组；为空表示通过。 */
export function validateEvent(record) {
  const errors = [];
  if (!record || typeof record !== "object") return ["事件必须是对象"];

  for (const name of REQUIRED_ENVELOPE) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if (errors.length) return errors;

  if (!EVENT_TYPES.includes(record.event_type)) errors.push(`event_type 非法：${record.event_type}`);
  if (!AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`aggregate_type 非法：${record.aggregate_type}`);
  if (!Number.isInteger(record.version) || record.version < 1) errors.push("version 必须是正整数");
  if (record.event_id.length < 8) errors.push("event_id 长度不足");
  if (typeof record.occurred_at !== "string" || !isIsoDateTime(record.occurred_at)) {
    errors.push("occurred_at 必须是可解析的时间字符串");
  }
  if (typeof record.summary !== "string" || record.summary.trim().length < 2) {
    errors.push("summary 至少两个字符");
  }
  if (AGGREGATE_FOR_EVENT[record.event_type] && record.aggregate_type !== AGGREGATE_FOR_EVENT[record.event_type]) {
    errors.push(
      `${record.event_type} 的聚合类型必须是 ${AGGREGATE_FOR_EVENT[record.event_type]}，实际为 ${record.aggregate_type}`,
    );
  }

  const required = PAYLOAD_REQUIRED[record.event_type];
  if (required) {
    const payload = record.payload;
    if (!payload || typeof payload !== "object") {
      errors.push("payload：事件必须携带事实载荷");
      return errors;
    }
    for (const field of required) {
      if (!(field in payload) || payload[field] === undefined || payload[field] === null) {
        errors.push(`payload.${field}：缺少必填项`);
      }
    }

    if (record.event_type === "ATTEMPT_RECORDED") {
      if (!["course", "simulation"].includes(payload.kind)) errors.push("payload.kind 必须为 course 或 simulation");
      if (payload.kind === "course" && !payload.course_code) errors.push("课程记录必须带 course_code");
      if (payload.kind === "simulation") {
        if (!payload.sim_task_code) errors.push("模拟记录必须带 sim_task_code");
        if (typeof payload.passed !== "boolean") errors.push("模拟记录必须给出 passed 布尔结论");
      }
    }
    if (record.event_type === "OBSERVATION_SIGNED") {
      if (!CASE_ROLES.includes(payload.role)) errors.push(`payload.role 非法：${payload.role}`);
      if (!["pass", "conditional", "fail"].includes(payload.rating)) {
        errors.push("payload.rating 必须为 pass/conditional/fail");
      }
    }
    if (record.event_type === "CASE_ROLE_LOGGED") {
      if (!CASE_ROLES.includes(payload.role)) errors.push(`payload.role 非法：${payload.role}`);
      // 真实患者标识防线：病例引用必须是脱敏标识。
      if (/姓名|身份证|护照|住院号|id_card|real_name/i.test(String(payload.deidentified_case_ref))) {
        errors.push("deidentified_case_ref 疑似包含真实身份标识，病例必须先脱敏");
      }
    }
    for (const evt of ["CONSENT_RECORDED", "CONSENT_SCOPE_UPDATED"]) {
      if (record.event_type === evt) {
        if (!Array.isArray(payload.purposes) || payload.purposes.length === 0) {
          errors.push("payload.purposes 至少包含一种用途");
        }
        const allowed = ["training", "research", "privilege_audit"];
        for (const p of payload.purposes ?? []) {
          if (!allowed.includes(p)) errors.push(`payload.purposes 含非法用途：${p}`);
        }
      }
    }
    if (record.event_type === "COMPLICATION_REVIEWED") {
      if (!CASE_ROLES.includes(payload.role)) errors.push(`payload.role 非法：${payload.role}`);
      if (!["minor", "major", "death"].includes(payload.severity)) errors.push("severity 非法");
      if (!["none", "reassessment", "suspension"].includes(payload.disposition)) errors.push("disposition 非法");
    }
    if (record.event_type === "COMPETENCY_REVIEWED") {
      if (!["proceed", "hold", "remediate"].includes(payload.decision)) errors.push("decision 非法");
      if (!Array.isArray(payload.reviewer_ids) || payload.reviewer_ids.length < 1) {
        errors.push("reviewer_ids 至少一人");
      }
      if (!Array.isArray(payload.based_on_event_ids) || payload.based_on_event_ids.length < 1) {
        errors.push("阶段能力结论必须引用证据事件 based_on_event_ids");
      }
    }
    if (record.event_type.startsWith("PRIVILEGE_")) {
      checkScope(payload.scope, errors);
      // PRIVILEGE_RENEWED 也走此分支：其签署块字段名同为 decision。
      checkDecision(payload, errors);
      if (!Array.isArray(payload.based_on_event_ids) || payload.based_on_event_ids.length < 1) {
        if (record.event_type !== "PRIVILEGE_SUSPENDED") {
          errors.push("授权事件必须引用证据链 based_on_event_ids");
        }
      }
    }
    if (record.event_type === "APPEAL_DECIDED") {
      checkDecision(payload, errors);
      if (!["upheld", "overturned", "remanded"].includes(payload.outcome)) errors.push("申诉 outcome 非法");
    }
  }

  return errors;
}
