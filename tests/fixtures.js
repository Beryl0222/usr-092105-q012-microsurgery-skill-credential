/**
 * 测试夹具：一家培训中心 + 医院 H1 的完整注册数据，
 * 以及构造不同证据状态医师的助手。
 */

import { CredentialingService } from "../src/service.js";
import { deidentifyTeachingCase } from "../src/deidentify.js";

export const H1 = "HSP-01";
export const EQ1 = "EQ-OPMIC-A";
export const H2 = "HSP-02";
export const PROC = "PROC-REPLANT"; // 断指再植
export const COURSE = "COURSE-MICRO-BASIC";
export const SIM = "SIM-ANAST-08";
export const COMMITTEE = "C-H1";
export const SALT = "test-center-salt";

export function event(eventType, aggregateType, aggregateId, occurredAt, summary, payload, version = 1) {
  return {
    event_id: `evt-${aggregateId}-${eventType.toLowerCase()}-v${version}-${Math.random().toString(36).slice(2, 8)}`,
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: occurredAt,
    version,
    summary,
    payload,
  };
}

export function committeeDecision(at, signatories = ["doc-m1", "doc-m2"], id = `dec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`) {
  return {
    decision_id: id,
    committee_id: COMMITTEE,
    signed_at: at,
    signatories,
    minutes_ref: `minutes-${id}`,
  };
}

/** 注册课程/模拟任务/术式/医院设备/委员会/规则集 v1。 */
export function seedWorld(service, rulesetVersion = "2026.1") {
  service.record(
    event("COURSE_VERSION_PUBLISHED", "course_version", `${COURSE}-v3`, "2026-01-05T09:00:00+08:00",
      "发布显微外科基础课程 v3（含线上模块）", {
        course_code: COURSE,
        course_version: "3.0",
        title: "显微外科基础与血管吻合",
        delivery_modes: ["online", "simulation"],
        published_at: "2026-01-05T09:00:00+08:00",
      }),
  );
  service.record(
    event("SIM_TASK_DEFINED", "sim_task", `${SIM}-v1`, "2026-01-05T09:00:00+08:00",
      "定义0.8mm模拟血管端侧吻合任务，须连续3次达标", {
        task_code: SIM,
        task_version: "1.0",
        procedure_code: PROC,
        caliber_mm: 0.8,
        pass_threshold: { time_min: 45, leak_score: 2, patency_check: 1 },
        required_consecutive_passes: 3,
        equipment: { microscope: "10x-20x手术显微镜", suture: "10-0无损伤线", model: "0.8mm模拟血管" },
      }),
  );
  service.record(
    event("PROCEDURE_DEFINED", "procedure_definition", PROC, "2026-01-05T09:00:00+08:00",
      "定义断指再植术可授权口径0.5–3.0mm", {
        procedure_code: PROC,
        name: "断指再植（血管吻合）",
        caliber_min_mm: 0.5,
        caliber_max_mm: 3.0,
      }),
  );
  service.record(
    event("HOSPITAL_CAPABILITY_REGISTERED", "hospital_capability", `${H1}|${EQ1}`, "2026-01-06T09:00:00+08:00",
      "H1医院A号显微镜设备条件登记", {
        hospital_id: H1,
        hospital_name: "市立第一医院",
        equipment_condition_id: EQ1,
        equipment_condition_name: "A号手术显微镜组（含10-0缝线）",
        supported_procedures: [{ procedure_code: PROC, caliber_min_mm: 0.5, caliber_max_mm: 3.0 }],
      }),
  );
  service.record(
    event("COMMITTEE_REGISTERED", "committee", COMMITTEE, "2026-01-06T09:00:00+08:00",
      "登记H1医院医疗技术临床授权委员会（法定人数2）", {
        committee_id: COMMITTEE,
        hospital_id: H1,
        name: "H1医院医疗技术临床授权委员会",
        member_ids: ["doc-m1", "doc-m2", "doc-m3"],
        quorum: 2,
      }),
  );
  service.record(
    event("RULESET_PUBLISHED", "ruleset", `ruleset-${rulesetVersion}`, "2026-01-10T09:00:00+08:00",
      `发布授权规则集 ${rulesetVersion}`, {
        ruleset_version: rulesetVersion,
        published_at: "2026-01-10T09:00:00+08:00",
        role_requirements: {
          [PROC]: {
            chief_under_supervision: {
              course_codes: [COURSE],
              sim_task_codes: [SIM],
              observations: 2,
              prior_case_role: "co_surgeon",
              prior_case_count: 2,
              currency_days: 180,
            },
            independent_chief: {
              course_codes: [COURSE],
              sim_task_codes: [SIM],
              observations: 3,
              prior_case_role: "chief_under_supervision",
              prior_case_count: 2,
              currency_days: 180,
              requires_supervised_chief: true,
            },
          },
        },
      }),
  );
}

/** 与 service.record 一致地拿到真实 event_id。 */
export function recordAttemptCourse(service, surgeonId, at = "2026-03-01T10:00:00+08:00", onlineOnly = false) {
  const id = `attempt-${surgeonId}-course`;
  const { event: e } = service.record(event("ATTEMPT_RECORDED", "training_attempt", id, at,
    `${surgeonId} 完成显微外科基础课程 v3${onlineOnly ? "（仅线上模块）" : ""}`, {
      surgeon_id: surgeonId, kind: "course", course_code: COURSE, course_version: "3.0",
      completed_at: at, online_only: onlineOnly,
    }));
  return e.event_id;
}

export function recordSimPass(service, surgeonId, at, passed = true, n = 0) {
  const id = `attempt-${surgeonId}-sim-${n}-${at.slice(0, 10)}`;
  const { event: e } = service.record(event("ATTEMPT_RECORDED", "training_attempt", id, at,
    `${surgeonId} 在0.8mm模拟血管吻合任务中${passed ? "达标" : "未达标"}（第${n + 1}次）`, {
      surgeon_id: surgeonId,
      kind: "simulation",
      sim_task_code: SIM,
      sim_task_version: "1.0",
      completed_at: at,
      metrics: passed ? { time_min: 36 + n, leak_score: 1, patency_check: 1 } : { time_min: 52, leak_score: 3, patency_check: 0 },
      passed,
      raw_refs: [{ kind: "video", uri: `training-center://${id}/video`, sha256: `h-${id}` }],
      instructor_id: "mentor-z-007",
    }));
  return e.event_id;
}

export function recordObservation(service, surgeonId, at, { rating = "pass", dissent = false, role = "independent_chief", mentor = "mentor-z-007", comments = "操作稳定，吻合质量可靠" } = {}) {
  const id = `obs-${surgeonId}-${mentor}-${at.slice(0, 10)}`;
  const { event: e } = service.record(event("OBSERVATION_SIGNED", "mentor_observation", id, at,
    `导师${mentor}对${surgeonId}的授前主刀观察：${rating}${dissent ? "（保留不同意见）" : ""}`, {
      surgeon_id: surgeonId,
      observer_mentor_id: mentor,
      procedure_code: PROC,
      caliber_mm: 0.8,
      role,
      observed_at: at,
      rating,
      dissent,
      comments,
    }));
  return e.event_id;
}

export function recordCase(service, surgeonId, at, role, n, { supervisor = "mentor-z-007", purposes = ["training", "research", "privilege_audit"] } = {}) {
  const localCaseId = `${surgeonId}-case-${n}`;
  const { deidentified_case_ref } = deidentifyTeachingCase({
    hospital_id: H1,
    local_case_id: localCaseId,
    salt: SALT,
    text: "教学复盘材料：断指再植一例，动静脉吻合过程记录。",
  });
  const consentId = `consent-${localCaseId}`;
  service.record(event("CONSENT_RECORDED", "consent_record", consentId, at,
    `教学病例 ${localCaseId} 同意用于：${purposes.join("、")}`, {
      consent_record_id: consentId,
      subject_pseudonym: deidentified_case_ref,
      purposes,
      granted_at: at,
      statement: "已告知并同意脱敏教学与授权审计用途",
    }));
  const id = `case-${localCaseId}`;
  const { event: e } = service.record(event("CASE_ROLE_LOGGED", "case_record", id, at,
    `${surgeonId} 以${role}身份参与教学病例（口径0.8mm，已脱敏）`, {
      surgeon_id: surgeonId,
      procedure_code: PROC,
      caliber_mm: 0.8,
      role,
      case_date: at.slice(0, 11) + "09:00:00+08:00",
      supervisor_mentor_id: supervisor,
      deidentified_case_ref,
      consent_record_id: consentId,
      outcome: "吻合通畅，恢复良好",
    }));
  return { event_id: e.event_id, consent_id: consentId, deidentified_case_ref };
}

export function recordCompetencyReview(service, surgeonId, at, basedOn, { rulesetVersion = "2026.1", decision = "proceed", stage = "独立主刀准入复核", notes = "证据链完整，同意进入授权审议" } = {}) {
  const id = `competency-review-${surgeonId}-${at.slice(0, 10)}`;
  const { event: e } = service.record(event("COMPETENCY_REVIEWED", "competency_state", id, at,
    `培训中心对${surgeonId}作出阶段能力结论：${decision}（规则${rulesetVersion}）`, {
      surgeon_id: surgeonId,
      procedure_code: PROC,
      stage,
      decision,
      reviewed_at: at,
      reviewer_ids: ["mentor-z-007", "mentor-q-002"],
      notes,
      based_on_event_ids: basedOn,
      ruleset_version: rulesetVersion,
    }));
  return e.event_id;
}

/** 构造一名证据完整、可获独立主刀授权的医师；返回各证据事件 id。 */
export function buildQualifiedSurgeon(service, surgeonId, dates = {}) {
  const d = {
    course: "2026-03-01T10:00:00+08:00",
    sim: ["2026-09-18T10:00:00+08:00", "2026-09-19T10:00:00+08:00", "2026-09-20T10:00:00+08:00"],
    coCases: ["2026-05-10T09:00:00+08:00", "2026-05-24T09:00:00+08:00"],
    chiefCases: ["2026-07-12T09:00:00+08:00", "2026-08-20T09:00:00+08:00"],
    observations: ["2026-08-02T09:00:00+08:00", "2026-08-16T09:00:00+08:00", "2026-09-06T09:00:00+08:00"],
    review: "2026-09-22T14:00:00+08:00",
    ...dates,
  };
  const courseId = recordAttemptCourse(service, surgeonId, d.course);
  const simIds = d.sim.map((at, i) => recordSimPass(service, surgeonId, at, true, i));
  const coCaseIds = d.coCases.map((at, i) => recordCase(service, surgeonId, at, "co_surgeon", i + 1).event_id);
  const chiefCaseIds = d.chiefCases.map((at, i) =>
    recordCase(service, surgeonId, at, "chief_under_supervision", i + 10).event_id);
  const obsIds = d.observations.map((at, i) => recordObservation(service, surgeonId, at, { n: i }));
  const reviewId = recordCompetencyReview(service, surgeonId, d.review, [
    courseId, ...simIds, ...coCaseIds, ...chiefCaseIds, ...obsIds,
  ]);
  return { courseId, simIds, coCaseIds, chiefCaseIds, obsIds, reviewId };
}

export function grantIndependentChief(service, surgeonId, at = "2026-09-28T15:00:00+08:00", validUntil = "2027-09-27T23:59:59+08:00") {
  return service.requestGrant({
    surgeon_id: surgeonId,
    scope: {
      hospital_id: H1,
      equipment_condition_id: EQ1,
      procedure_code: PROC,
      caliber_min_mm: 0.5,
      caliber_max_mm: 1.5,
      role: "independent_chief",
    },
    valid_until: validUntil,
    decision: committeeDecision(at),
    conditions: ["首例安排上级医师在场"],
  });
}

export function newService() {
  return new CredentialingService();
}
