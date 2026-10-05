/**
 * 读模型投影：把只追加事件折叠成当前可查询状态。
 *
 * 设计约束：
 * - 投影可随时从事件流重建；它不保存任何事件之外的“真相”。
 * - 历史表现永不被覆盖：所有清单只追加，当前状态由顺序决定。
 * - 导师异议（dissent / rating=fail）原样保留在 observations 中，
 *   多数意见不能冲销个别导师的反对记录。
 */

function emptySurgeon() {
  return {
    attempts: [], // 课程与模拟原始操作
    observations: [], // 导师观察（含不同意见）
    cases: [], // 实台病例角色
    complications: [], // 并发症复盘
    competencyReviews: [], // 阶段能力结论
    reassessments: [], // 再评估要求
  };
}

export class Projection {
  constructor() {
    this.surgeons = new Map();
    this.consents = new Map(); // consent_record_id -> { current, history }
    this.retractions = new Map(); // evidence_event_id -> 撤证载荷
    this.privileges = new Map(); // privilege_id -> 生命周期视图
    this.appeals = new Map(); // appeal_id -> 视图
  }

  surgeon(id) {
    if (!this.surgeons.has(id)) this.surgeons.set(id, emptySurgeon());
    return this.surgeons.get(id);
  }

  apply(event) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "ATTEMPT_RECORDED": {
        this.surgeon(p.surgeon_id).attempts.push({ event_id: event.event_id, occurred_at: event.occurred_at, ...p });
        break;
      }
      case "OBSERVATION_SIGNED": {
        this.surgeon(p.surgeon_id).observations.push({ event_id: event.event_id, occurred_at: event.occurred_at, ...p });
        break;
      }
      case "CASE_ROLE_LOGGED": {
        this.surgeon(p.surgeon_id).cases.push({ event_id: event.event_id, occurred_at: event.occurred_at, ...p });
        break;
      }
      case "COMPLICATION_REVIEWED": {
        this.surgeon(p.surgeon_id).complications.push({ event_id: event.event_id, occurred_at: event.occurred_at, ...p });
        break;
      }
      case "COMPETENCY_REVIEWED": {
        this.surgeon(p.surgeon_id).competencyReviews.push({
          event_id: event.event_id,
          occurred_at: event.occurred_at,
          ...p,
        });
        break;
      }
      case "REASSESSMENT_REQUIRED": {
        this.surgeon(p.surgeon_id).reassessments.push({ event_id: event.event_id, occurred_at: event.occurred_at, ...p });
        break;
      }
      case "CONSENT_RECORDED":
      case "CONSENT_SCOPE_UPDATED": {
        const existing = this.consents.get(p.consent_record_id) ?? { history: [] };
        existing.current = p;
        existing.history.push({ event_id: event.event_id, at: event.occurred_at, purposes: p.purposes.slice() });
        this.consents.set(p.consent_record_id, existing);
        break;
      }
      case "EVIDENCE_RETRACTED": {
        this.retractions.set(p.evidence_event_id, { event_id: event.event_id, ...p });
        break;
      }
      case "PRIVILEGE_GRANTED":
      case "PRIVILEGE_SUSPENDED":
      case "PRIVILEGE_RESTORED":
      case "PRIVILEGE_RENEWED": {
        const view = this.privileges.get(p.privilege_id) ?? {
          privilege_id: p.privilege_id,
          surgeon_id: p.surgeon_id,
          scope: p.scope,
          state: null,
          valid_until: null,
          based_on: [],
          history: [],
        };
        // 范围是授权身份的一部分：同一 privilege_id 的 scope 不得漂移。
        if (JSON.stringify(view.scope) !== JSON.stringify(p.scope)) {
          throw new Error(`授权 ${p.privilege_id} 范围发生漂移；新范围必须另行授权`);
        }
        view.surgeon_id = p.surgeon_id;
        if (event.event_type === "PRIVILEGE_GRANTED") {
          view.state = "active";
          view.valid_until = p.valid_until;
          view.based_on = p.based_on_event_ids.slice();
          view.ruleset_version = p.ruleset_version;
        } else if (event.event_type === "PRIVILEGE_SUSPENDED") {
          view.state = "suspended";
          view.suspension_reason = p.reason;
        } else if (event.event_type === "PRIVILEGE_RESTORED") {
          view.state = "active";
          view.valid_until = p.valid_until;
          view.suspension_reason = null;
          view.based_on = p.based_on_event_ids.slice();
        } else if (event.event_type === "PRIVILEGE_RENEWED") {
          view.state = "active";
          view.valid_until = p.valid_until;
          view.based_on = p.based_on_event_ids.slice();
          view.ruleset_version = p.ruleset_version;
        }
        view.history.push({
          event_id: event.event_id,
          type: event.event_type,
          at: event.occurred_at,
          decision_id: p.decision?.decision_id,
        });
        this.privileges.set(p.privilege_id, view);
        break;
      }
      case "APPEAL_FILED": {
        const view = this.appeals.get(p.appeal_id) ?? { history: [] };
        Object.assign(view, {
          appeal_id: p.appeal_id,
          surgeon_id: p.surgeon_id,
          against_decision_id: p.against_decision_id,
          scope: p.scope,
          grounds: p.grounds,
          state: "pending",
        });
        view.history.push({ event_id: event.event_id, at: event.occurred_at, type: "FILED" });
        this.appeals.set(p.appeal_id, view);
        break;
      }
      case "APPEAL_DECIDED": {
        const view = this.appeals.get(p.appeal_id);
        if (!view) throw new Error(`申诉 ${p.appeal_id} 在未见立案事件前被裁定`);
        view.state = p.outcome;
        view.decision = p.decision;
        view.rationale = p.rationale;
        view.history.push({ event_id: event.event_id, at: event.occurred_at, type: "DECIDED", outcome: p.outcome });
        break;
      }
      default:
        break;
    }
  }

  /** 该证据事件是否被撤回了科研用途（培训/审计留存不受影响）。 */
  isResearchRetracted(eventId) {
    return this.retractions.has(eventId);
  }

  /** 该病例证据在当前同意范围下是否可用于指定用途。 */
  consentAllows(consentRecordId, purpose) {
    const c = this.consents.get(consentRecordId);
    if (!c) return false;
    return c.current.purposes.includes(purpose);
  }

  /** 与查询范围相关、当前有效的授权（含暂停态，供说明缺口）。 */
  privilegesFor(surgeonId, scope) {
    return [...this.privileges.values()]
      .filter((v) => v.surgeon_id === surgeonId)
      .filter((v) => scopeMatches(v.scope, scope))
      .sort((a, b) => latestHistoryAt(b).localeCompare(latestHistoryAt(a)));
  }

  /** 与某决定相关的在审申诉。 */
  pendingAppealAgainst(decisionId) {
    for (const a of this.appeals.values()) {
      if (a.against_decision_id === decisionId && a.state === "pending") return a;
    }
    return null;
  }
}

/**
 * 持权范围是否覆盖查询范围：同医院、同设备条件、同术式、
 * 持权口径区间包含查询口径、持权角色级别不低于查询角色。
 */
export function scopeMatches(held, query) {
  if (held.hospital_id !== query.hospital_id) return false;
  if (held.equipment_condition_id !== query.equipment_condition_id) return false;
  if (held.procedure_code !== query.procedure_code) return false;
  const caliber = query.caliber_mm ?? (held.caliber_min_mm + held.caliber_max_mm) / 2;
  if (caliber < held.caliber_min_mm || caliber > held.caliber_max_mm) return false;
  const levels = ["observer", "assistant", "co_surgeon", "chief_under_supervision", "independent_chief"];
  return levels.indexOf(held.role) >= levels.indexOf(query.role);
}

function latestHistoryAt(view) {
  return view.history[view.history.length - 1].at;
}
