/**
 * 版本化注册表：课程版本、模拟任务与器械条件、术式口径、
 * 医院设备条件、医院委员会、授权规则集。
 *
 * 关键语义：
 * - 所有定义都带版本号；证据记录钉住产生时的定义版本。
 * - 规则集可发布新版本，但投影只负责“按时间取版本”，是否触发复核由策略层决定；
 *   新版本绝不重写历史证据或既往结论。
 */

export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryError";
  }
}

export class Registries {
  constructor() {
    this.courses = new Map(); // course_code -> Map(version -> payload)
    this.courseLatest = new Map(); // course_code -> version
    this.simTasks = new Map(); // task_code -> Map(version -> payload)
    this.simLatest = new Map();
    this.procedures = new Map(); // procedure_code -> payload
    this.hospitals = new Map(); // `${hospital_id}|${equipment_condition_id}` -> payload
    this.committees = new Map(); // committee_id -> payload
    this.rulesets = new Map(); // version -> payload
    this.rulesetTimeline = []; // [{version, published_at}]
  }

  apply(event) {
    const p = event.payload;
    switch (event.event_type) {
      case "COURSE_VERSION_PUBLISHED": {
        if (!this.courses.has(p.course_code)) this.courses.set(p.course_code, new Map());
        const versions = this.courses.get(p.course_code);
        if (versions.has(p.course_version)) {
          throw new RegistryError(`课程 ${p.course_code} 版本 ${p.course_version} 已发布，版本不可覆盖`);
        }
        versions.set(p.course_version, p);
        this.courseLatest.set(p.course_code, p.course_version);
        break;
      }
      case "SIM_TASK_DEFINED": {
        if (!this.simTasks.has(p.task_code)) this.simTasks.set(p.task_code, new Map());
        const versions = this.simTasks.get(p.task_code);
        if (versions.has(p.task_version)) {
          throw new RegistryError(`模拟任务 ${p.task_code} 版本 ${p.task_version} 已存在，不可覆盖`);
        }
        versions.set(p.task_version, p);
        this.simLatest.set(p.task_code, p.task_version);
        break;
      }
      case "PROCEDURE_DEFINED":
        if (this.procedures.has(p.procedure_code)) {
          throw new RegistryError(`术式 ${p.procedure_code} 已定义；口径调整须通过新版本流程`);
        }
        this.procedures.set(p.procedure_code, p);
        break;
      case "HOSPITAL_CAPABILITY_REGISTERED":
        this.hospitals.set(`${p.hospital_id}|${p.equipment_condition_id}`, p);
        break;
      case "COMMITTEE_REGISTERED":
        this.committees.set(p.committee_id, p);
        break;
      case "RULESET_PUBLISHED": {
        if (this.rulesets.has(p.ruleset_version)) {
          throw new RegistryError(`规则集版本 ${p.ruleset_version} 已发布，不可篡改`);
        }
        this.rulesets.set(p.ruleset_version, p);
        this.rulesetTimeline.push({ version: p.ruleset_version, published_at: p.published_at });
        this.rulesetTimeline.sort((a, b) => a.published_at.localeCompare(b.published_at));
        break;
      }
      default:
        break;
    }
  }

  getCourse(code, version) {
    const versions = this.courses.get(code);
    if (!versions) return null;
    return versions.get(version) ?? null;
  }

  getSimTask(code, version) {
    const versions = this.simTasks.get(code);
    if (!versions) return null;
    return versions.get(version) ?? null;
  }

  getProcedure(code) {
    return this.procedures.get(code) ?? null;
  }

  getHospitalCapability(hospitalId, equipmentConditionId) {
    return this.hospitals.get(`${hospitalId}|${equipmentConditionId}`) ?? null;
  }

  getCommittee(committeeId) {
    return this.committees.get(committeeId) ?? null;
  }

  getRuleset(version) {
    return this.rulesets.get(version) ?? null;
  }

  /** 某时刻生效的规则版本（历史复核按 occurred_at 钉版本用）。 */
  rulesetVersionAt(at) {
    let current = null;
    for (const entry of this.rulesetTimeline) {
      if (entry.published_at.localeCompare(at) <= 0) current = entry.version;
    }
    return current;
  }

  latestRulesetVersion() {
    return this.rulesetTimeline.length
      ? this.rulesetTimeline[this.rulesetTimeline.length - 1].version
      : null;
  }

  /** 医院在指定设备条件下，是否支持某术式与口径。 */
  supports(hospitalId, equipmentConditionId, procedureCode, caliberMm) {
    const cap = this.getHospitalCapability(hospitalId, equipmentConditionId);
    if (!cap) return { ok: false, reason: "医院设备条件未登记" };
    const proc = cap.supported_procedures.find((x) => x.procedure_code === procedureCode);
    if (!proc) return { ok: false, reason: `该设备条件下未登记开展术式 ${procedureCode}` };
    if (caliberMm !== undefined && (caliberMm < proc.caliber_min_mm || caliberMm > proc.caliber_max_mm)) {
      return {
        ok: false,
        reason: `医院设备条件支持口径 ${proc.caliber_min_mm}–${proc.caliber_max_mm}mm，不含 ${caliberMm}mm`,
      };
    }
    return { ok: true, capability: cap, procedure: proc };
  }
}
