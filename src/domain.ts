/** 显微外科技能证据与临床授权系统的领域类型。 */

// ---------------------------------------------------------------------------
// 事件信封
// ---------------------------------------------------------------------------

export type EventType =
  // 版本化注册表
  | "COURSE_VERSION_PUBLISHED"
  | "SIM_TASK_DEFINED"
  | "PROCEDURE_DEFINED"
  | "HOSPITAL_CAPABILITY_REGISTERED"
  | "COMMITTEE_REGISTERED"
  | "RULESET_PUBLISHED"
  // 证据
  | "ATTEMPT_RECORDED"
  | "OBSERVATION_SIGNED"
  | "CASE_ROLE_LOGGED"
  | "CONSENT_RECORDED"
  | "CONSENT_SCOPE_UPDATED"
  | "COMPLICATION_REVIEWED"
  // 阶段能力
  | "COMPETENCY_REVIEWED"
  | "REASSESSMENT_REQUIRED"
  // 授权生命周期（仅委员会签署）
  | "PRIVILEGE_GRANTED"
  | "PRIVILEGE_SUSPENDED"
  | "PRIVILEGE_RESTORED"
  | "PRIVILEGE_RENEWED"
  | "EVIDENCE_RETRACTED"
  // 申诉
  | "APPEAL_FILED"
  | "APPEAL_DECIDED";

export type AggregateType =
  | "course_version"
  | "sim_task"
  | "procedure_definition"
  | "hospital_capability"
  | "committee"
  | "ruleset"
  | "training_attempt"
  | "mentor_observation"
  | "case_record"
  | "consent_record"
  | "complication_review"
  | "competency_state"
  | "clinical_privilege"
  | "appeal";

/** 病例角色：观摩 → 助手 → 共同术者 → 督导主刀 → 独立主刀。 */
export type CaseRole =
  | "observer"
  | "assistant"
  | "co_surgeon"
  | "chief_under_supervision"
  | "independent_chief";

/** 授权范围。 */
export interface PrivilegeScope {
  hospital_id: string;
  equipment_condition_id: string;
  procedure_code: string;
  /** 血管口径区间（毫米），授权不覆盖区间以外的口径。 */
  caliber_min_mm: number;
  caliber_max_mm: number;
  role: CaseRole;
}

/** 委员会签署块；授权/暂停/恢复/复核裁定都必须携带。 */
export interface CommitteeDecision {
  decision_id: string;
  committee_id: string;
  signed_at: string;
  signatories: string[];
  minutes_ref?: string;
}

/** 原始操作材料引用：只存引用与哈希。 */
export interface RawOperationRef {
  kind: "video" | "image" | "log" | "device_export";
  uri: string;
  sha256?: string;
}

export interface DomainEvent {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// 注册表载荷
// ---------------------------------------------------------------------------

/** 课程版本：结业只代表“完成某版本课程”，不等于临床权限。 */
export interface CourseVersionPayload {
  course_code: string;
  course_version: string;
  title: string;
  /** online | simulation | clinical_attachment 等；线上课只是其中一类。 */
  delivery_modes: string[];
  published_at: string;
}

/** 模拟任务与器械条件（如模拟血管口径、放大设备、缝线）。 */
export interface SimTaskPayload {
  task_code: string;
  task_version: string;
  procedure_code: string;
  caliber_mm: number;
  /** 通过阈值，例如限时、漏血评分、patency 标准。 */
  pass_threshold: Record<string, number>;
  /** 要求连续稳定达标的次数，单次成功不算。 */
  required_consecutive_passes: number;
  equipment: { microscope?: string; suture?: string; model?: string };
}

/** 术式定义与可授权口径。 */
export interface ProcedurePayload {
  procedure_code: string;
  name: string;
  caliber_min_mm: number;
  caliber_max_mm: number;
}

/** 医院设备条件：某医院在特定设备条件下可开展的术式与口径。 */
export interface HospitalCapabilityPayload {
  hospital_id: string;
  hospital_name: string;
  equipment_condition_id: string;
  equipment_condition_name: string;
  supported_procedures: Array<{
    procedure_code: string;
    caliber_min_mm: number;
    caliber_max_mm: number;
  }>;
}

/** 医院委员会名册与法定人数。 */
export interface CommitteePayload {
  committee_id: string;
  hospital_id: string;
  name: string;
  member_ids: string[];
  quorum: number;
}

/**
 * 授权规则集，版本化发布。规则更新只触发“未来复核”，
 * 不修改历史表现，也不自动收回既有授权。
 */
export interface RulesetPayload {
  ruleset_version: string;
  published_at: string;
  /** 各角色的证据要求，按 procedure_code 配置。 */
  role_requirements: Record<
    string,
    Partial<
      Record<
        CaseRole,
        {
          course_codes: string[];
          sim_task_codes: string[];
          /** 该角色至少需要的导师观察条数（且不得有未处置的否决）。 */
          observations: number;
          /** 更低一级角色的实台病例条数要求。 */
          prior_case_role?: CaseRole;
          prior_case_count?: number;
          /** 证据时效：超过该天数未实践须重新复核。 */
          currency_days: number;
          /** 独立主刀须先有督导主刀记录。 */
          requires_supervised_chief?: boolean;
        }
      >
    >
  >;
}

// ---------------------------------------------------------------------------
// 证据载荷
// ---------------------------------------------------------------------------

/** training_attempt：课程课时 / 模拟任务的原始操作。 */
export interface AttemptPayload {
  surgeon_id: string;
  kind: "course" | "simulation";
  course_code?: string;
  course_version?: string;
  sim_task_code?: string;
  sim_task_version?: string;
  completed_at: string;
  /** simulation 时的客观指标与是否达标。 */
  metrics?: Record<string, number>;
  passed?: boolean;
  raw_refs?: RawOperationRef[];
  instructor_id?: string;
  /** 仅线上完成（无模拟/实台）时置真，永远不足以单独授权。 */
  online_only?: boolean;
}

/** mentor_observation：导师在实台/模拟中的观察与意见。 */
export interface ObservationPayload {
  surgeon_id: string;
  observer_mentor_id: string;
  procedure_code: string;
  caliber_mm: number;
  role: CaseRole;
  observed_at: string;
  rating: "pass" | "conditional" | "fail";
  dissent?: boolean;
  /** 不同意见原文保留，不会被多数意见覆盖。 */
  comments: string;
  raw_refs?: RawOperationRef[];
}

/** case_record：教学病例的实台角色与口径。 */
export interface CaseRolePayload {
  surgeon_id: string;
  procedure_code: string;
  caliber_mm: number;
  role: CaseRole;
  case_date: string;
  supervisor_mentor_id?: string;
  /** 脱敏后的病例引用；真实患者标识永不进入本系统。 */
  deidentified_case_ref: string;
  consent_record_id: string;
  outcome?: string;
}

/** 同意范围（教学/科研/授权审计分别授权）。 */
export interface ConsentPayload {
  consent_record_id: string;
  /** 教学病例本体系统中的脱敏主体标识（非真实身份）。 */
  subject_pseudonym: string;
  purposes: Array<"training" | "research" | "privilege_audit">;
  granted_at: string;
  statement: string;
}

export interface ConsentScopeUpdatePayload {
  consent_record_id: string;
  subject_pseudonym: string;
  purposes: Array<"training" | "research" | "privilege_audit">;
  changed_at: string;
  reason: string;
}

/** 并发症复盘。 */
export interface ComplicationPayload {
  surgeon_id: string;
  case_ref: string;
  procedure_code: string;
  caliber_mm: number;
  role: CaseRole;
  occurred_at: string;
  category: string;
  severity: "minor" | "major" | "death";
  /** 复盘结论是否要求再评估/暂停。 */
  disposition: "none" | "reassessment" | "suspension";
  findings: string;
}

// ---------------------------------------------------------------------------
// 能力与授权载荷
// ---------------------------------------------------------------------------

/** competency_state：阶段能力复核结论（非授权）。 */
export interface CompetencyReviewedPayload {
  surgeon_id: string;
  procedure_code: string;
  stage: string;
  decision: "proceed" | "hold" | "remediate";
  reviewed_at: string;
  reviewer_ids: string[];
  notes: string;
  /** 本次复核所依据的证据事件 id。 */
  based_on_event_ids: string[];
  /** 复核时适用的规则版本；历史结论钉住当时规则。 */
  ruleset_version: string;
}

export interface ReassessmentPayload {
  surgeon_id: string;
  procedure_code: string;
  required_at: string;
  reason: string;
  ruleset_version?: string;
}

export interface PrivilegeGrantedPayload {
  privilege_id: string;
  surgeon_id: string;
  scope: PrivilegeScope;
  granted_at: string;
  valid_until: string;
  decision: CommitteeDecision;
  based_on_event_ids: string[];
  ruleset_version: string;
  conditions?: string[];
}

export interface PrivilegeSuspendedPayload {
  privilege_id: string;
  surgeon_id: string;
  scope: PrivilegeScope;
  suspended_at: string;
  reason: string;
  decision: CommitteeDecision;
}

export interface PrivilegeRestoredPayload {
  privilege_id: string;
  surgeon_id: string;
  scope: PrivilegeScope;
  restored_at: string;
  valid_until: string;
  decision: CommitteeDecision;
  based_on_event_ids: string[];
}

export interface PrivilegeRenewedPayload {
  privilege_id: string;
  surgeon_id: string;
  scope: PrivilegeScope;
  renewed_at: string;
  valid_until: string;
  decision: CommitteeDecision;
  based_on_event_ids: string[];
  ruleset_version: string;
}

/** 科研撤证：停止 research 用途展示，但依法留存的培训证据保持可审计。 */
export interface EvidenceRetractedPayload {
  evidence_event_id: string;
  surgeon_id: string;
  retracted_at: string;
  reason: string;
  /** 留存依据（法规/制度条款）。 */
  retention_basis: string;
  retained_until: string;
}

export interface AppealFiledPayload {
  appeal_id: string;
  surgeon_id: string;
  against_decision_id: string;
  scope: PrivilegeScope;
  filed_at: string;
  grounds: string;
}

export interface AppealDecidedPayload {
  appeal_id: string;
  surgeon_id: string;
  decided_at: string;
  outcome: "upheld" | "overturned" | "remanded";
  decision: CommitteeDecision;
  rationale: string;
}

// ---------------------------------------------------------------------------
// 排班查询结果
// ---------------------------------------------------------------------------

export type GapKind =
  | "evidence"
  | "review"
  | "committee_decision"
  | "currency"
  | "hospital_capability"
  | "consent"
  | "appeal_pending";

export interface EvidenceGap {
  kind: GapKind;
  requirement: string;
  detail: string;
}

export interface ProvenanceEntry {
  event_id: string;
  event_type: EventType;
  occurred_at: string;
  summary: string;
}

export interface SchedulingQuery {
  hospital_id: string;
  equipment_condition_id: string;
  procedure_code: string;
  role: CaseRole;
  caliber_mm?: number;
  at?: string;
}

export interface SchedulingResult {
  surgeon_id: string;
  query: SchedulingQuery;
  as_of: string;
  authorized: boolean;
  /** 当前可承担范围（授权区间按口径收窄后）。 */
  current_scope?: PrivilegeScope;
  valid_until?: string;
  gaps: EvidenceGap[];
  /** 申诉入口：无论是否授权都保留。 */
  appeal: { available: true; instructions: string; against_decision_id?: string };
  /** 完整授权来路：从原始证据到委员会签署的事件链。 */
  provenance: ProvenanceEntry[];
}
