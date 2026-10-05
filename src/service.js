/**
 * 应用服务：把事件存储、注册表、投影、规则评估串成用例。
 *
 * 授权治理要点：
 * - 授权/暂停/恢复/续期/申诉裁定只能由医院委员会签署，系统核验委员会、
 *   医院归属、委员名册与法定人数；任何导师个人或培训中心都不能授权。
 * - 签署只是必要条件，不是充分条件：证据缺口存在时，授权请求被拒绝并退回缺口清单，
 *   课时或一次成功无法“自动”也无法“走捷径”变成权限。
 * - 规则更新只登记“未来复核”，不改写历史事件、不即时收回授权。
 * - 排班查询是只读用例：返回当前可承担范围与到期时间，或逐项证据/复核/委员会缺口，
 *   并始终保留申诉入口与完整授权来路。
 */

import { EventStore, EventValidationError, ConcurrencyError } from "./event-store.js";
import { Registries, RegistryError } from "./registries.js";
import { Projection } from "./projection.js";
import { AuditLog } from "./audit.js";
import { evaluateEvidence } from "./policy.js";

export { EventValidationError, ConcurrencyError, RegistryError };

export class GovernanceError extends Error {
  constructor(message, gaps = []) {
    super(message);
    this.name = "GovernanceError";
    this.gaps = gaps;
  }
}

let seq = 0;
function newEventId(prefix) {
  seq += 1;
  return `evt-${prefix}-${Date.now().toString(36)}-${seq.toString(36).padStart(4, "0")}`;
}

export class CredentialingService {
  constructor() {
    this.store = new EventStore();
    this.registries = new Registries();
    this.projection = new Projection();
    this.audit = new AuditLog();
  }

  // -- 入账 ------------------------------------------------------------------

  /** 登记一条已构造好的事件（注册表事件也走这里）。 */
  record(event) {
    const { record: rec, duplicated } = this.store.append(event);
    if (!duplicated) {
      this.registries.apply(event);
      this.projection.apply(event);
      this.onNewRuleset(event);
    }
    return { event: rec.event, duplicated };
  }

  // -- 委员会签署核验 --------------------------------------------------------

  verifyCommitteeDecision(decision, hospitalId) {
    const committee = this.registries.getCommittee(decision.committee_id);
    if (!committee) throw new GovernanceError(`委员会 ${decision.committee_id} 未登记`);
    if (committee.hospital_id !== hospitalId) {
      throw new GovernanceError(
        `委员会 ${decision.committee_id} 不属于医院 ${hospitalId}，不得跨院签署`,
      );
    }
    const signers = decision.signatories ?? [];
    const unique = new Set(signers);
    if (unique.size !== signers.length) throw new GovernanceError("签署委员重复");
    for (const id of signers) {
      if (!committee.member_ids.includes(id)) {
        throw new GovernanceError(`${id} 不是该委员会在册委员，无权签署`);
      }
    }
    if (signers.length < committee.quorum) {
      throw new GovernanceError(
        `签署人数 ${signers.length} 未达法定人数 ${committee.quorum}，委员会决定不成立`,
      );
    }
  }

  // -- 授权生命周期 -----------------------------------------------------------

  scopeKey(scope) {
    return `${scope.hospital_id}|${scope.equipment_condition_id}|${scope.procedure_code}|${scope.caliber_min_mm}-${scope.caliber_max_mm}|${scope.role}`;
  }

  /** 授权申请：先过证据规则，再过委员会签署，两个条件缺一不可。 */
  requestGrant({ surgeon_id, scope, valid_until, decision, conditions = [] }) {
    const asOf = decision.signed_at;
    const evalResult = evaluateEvidence(this.projection, this.registries, {
      surgeon_id,
      procedure_code: scope.procedure_code,
      role: scope.role,
      caliber_mm: (scope.caliber_min_mm + scope.caliber_max_mm) / 2,
      as_of: asOf,
    });
    if (!evalResult.satisfied || evalResult.advisories.length) {
      throw new GovernanceError(
        "证据不满足授权要求，委员会签署被系统退回",
        [...evalResult.gaps, ...evalResult.advisories],
      );
    }
    this.verifyCommitteeDecision(decision, scope.hospital_id);

    const privilegeId = `priv-${this.scopeKey(scope)}`;
    if (this.projection.privileges.has(privilegeId)) {
      throw new GovernanceError("该范围授权已存在；延续应走续期，恢复应走恢复流程");
    }
    const event = {
      event_id: newEventId("grant"),
      event_type: "PRIVILEGE_GRANTED",
      aggregate_type: "clinical_privilege",
      aggregate_id: privilegeId,
      occurred_at: decision.signed_at,
      version: 1,
      summary: `${committeeLabel(this, decision)} 授予 ${surgeon_id} 在 ${scope.hospital_id} 的 ${scope.procedure_code}（${scope.caliber_min_mm}–${scope.caliber_max_mm}mm）${roleLabel(scope.role)}权限`,
      payload: {
        privilege_id: privilegeId,
        surgeon_id,
        scope,
        granted_at: decision.signed_at,
        valid_until,
        decision,
        based_on_event_ids: this.evidenceChainIds(surgeon_id, scope, evalResult),
        ruleset_version: evalResult.ruleset_version,
        conditions,
      },
    };
    return this.record(event);
  }

  /** 暂停：委员会可随时基于并发症等原因暂停；导师个人无权暂停。 */
  suspendPrivilege({ privilege_id, reason, decision }) {
    const view = this.projection.privileges.get(privilege_id);
    if (!view) throw new GovernanceError(`授权 ${privilege_id} 不存在`);
    this.verifyCommitteeDecision(decision, view.scope.hospital_id);
    const nextVersion = view.history.length + 1;
    return this.record({
      event_id: newEventId("susp"),
      event_type: "PRIVILEGE_SUSPENDED",
      aggregate_type: "clinical_privilege",
      aggregate_id: privilege_id,
      occurred_at: decision.signed_at,
      version: nextVersion,
      summary: `${committeeLabel(this, decision)} 暂停 ${view.surgeon_id} 的 ${view.scope.procedure_code}${roleLabel(view.scope.role)}权限：${reason}`,
      payload: {
        privilege_id,
        surgeon_id: view.surgeon_id,
        scope: view.scope,
        suspended_at: decision.signed_at,
        reason,
        decision,
      },
    });
  }

  /** 恢复：只能由委员会签署，且暂停原因须已通过再评估闭环。 */
  restorePrivilege({ privilege_id, valid_until, decision }) {
    const view = this.projection.privileges.get(privilege_id);
    if (!view) throw new GovernanceError(`授权 ${privilege_id} 不存在`);
    if (view.state !== "suspended") throw new GovernanceError("仅暂停中的授权可以恢复");
    this.verifyCommitteeDecision(decision, view.scope.hospital_id);

    const evalResult = evaluateEvidence(this.projection, this.registries, {
      surgeon_id: view.surgeon_id,
      procedure_code: view.scope.procedure_code,
      role: view.scope.role,
      caliber_mm: (view.scope.caliber_min_mm + view.scope.caliber_max_mm) / 2,
      as_of: decision.signed_at,
    });
    if (!evalResult.satisfied || evalResult.advisories.length) {
      throw new GovernanceError(
        "暂停原因尚未闭环或证据已不满足，恢复被退回",
        [...evalResult.gaps, ...evalResult.advisories],
      );
    }

    const nextVersion = view.history.length + 1;
    return this.record({
      event_id: newEventId("rest"),
      event_type: "PRIVILEGE_RESTORED",
      aggregate_type: "clinical_privilege",
      aggregate_id: privilege_id,
      occurred_at: decision.signed_at,
      version: nextVersion,
      summary: `${committeeLabel(this, decision)} 恢复 ${view.surgeon_id} 的相关权限，有效期至 ${valid_until.slice(0, 10)}`,
      payload: {
        privilege_id,
        surgeon_id: view.surgeon_id,
        scope: view.scope,
        restored_at: decision.signed_at,
        valid_until,
        decision,
        based_on_event_ids: this.evidenceChainIds(view.surgeon_id, view.scope, evalResult),
      },
    });
  }

  /** 续期：到期前由委员会按当前规则与证据重新签署。 */
  renewPrivilege({ privilege_id, valid_until, decision }) {
    const view = this.projection.privileges.get(privilege_id);
    if (!view) throw new GovernanceError(`授权 ${privilege_id} 不存在`);
    this.verifyCommitteeDecision(decision, view.scope.hospital_id);
    const evalResult = evaluateEvidence(this.projection, this.registries, {
      surgeon_id: view.surgeon_id,
      procedure_code: view.scope.procedure_code,
      role: view.scope.role,
      caliber_mm: (view.scope.caliber_min_mm + view.scope.caliber_max_mm) / 2,
      as_of: decision.signed_at,
    });
    if (!evalResult.satisfied || evalResult.advisories.length) {
      throw new GovernanceError(
        "证据或复核不满足续期要求",
        [...evalResult.gaps, ...evalResult.advisories],
      );
    }
    const nextVersion = view.history.length + 1;
    return this.record({
      event_id: newEventId("renew"),
      event_type: "PRIVILEGE_RENEWED",
      aggregate_type: "clinical_privilege",
      aggregate_id: privilege_id,
      occurred_at: decision.signed_at,
      version: nextVersion,
      summary: `${committeeLabel(this, decision)} 续期 ${view.surgeon_id} 的相关权限至 ${valid_until.slice(0, 10)}`,
      payload: {
        privilege_id,
        surgeon_id: view.surgeon_id,
        scope: view.scope,
        renewed_at: decision.signed_at,
        valid_until,
        decision,
        based_on_event_ids: this.evidenceChainIds(view.surgeon_id, view.scope, evalResult),
        ruleset_version: evalResult.ruleset_version,
      },
    });
  }

  evidenceChainIds(surgeonId, scope, evalResult) {
    const ids = new Set();
    for (const list of ["course_attempts", "sim_attempts", "observations", "cases"]) {
      for (const id of evalResult.qualifying[list] ?? []) ids.add(id);
    }
    if (evalResult.qualifying.review) ids.add(evalResult.qualifying.review);
    // 阶段复核自身依据的底层证据一并入链，保证来路完整。
    for (const id of [...ids]) {
      const e = this.store.byId(id);
      for (const base of e?.payload?.based_on_event_ids ?? []) ids.add(base);
    }
    return [...ids];
  }

  // -- 规则更新只触发未来复核 --------------------------------------------------

  onNewRuleset(event) {
    if (event.event_type !== "RULESET_PUBLISHED") return;
    const affected = new Set(Object.keys(event.payload.role_requirements));
    // 对受影响术式上仍有效的授权登记“到期前未来复核”；不改动任何历史事件。
    for (const view of this.projection.privileges.values()) {
      if (view.state !== "active") continue;
      if (!affected.has(view.scope.procedure_code)) continue;
      const surgeon = this.projection.surgeon(view.surgeon_id);
      const competencyAggregateId = `competency-${view.surgeon_id}-${view.scope.procedure_code}`;
      if (surgeon.reassessments.some((r) => r.reason?.includes(event.payload.ruleset_version))) continue;
      this.store.append({
        event_id: newEventId("reassess"),
        event_type: "REASSESSMENT_REQUIRED",
        aggregate_type: "competency_state",
        aggregate_id: competencyAggregateId,
        occurred_at: event.occurred_at,
        version: (this.store.aggregateVersions.get(competencyAggregateId) ?? 0) + 1,
        summary: `规则集更新至 ${event.payload.ruleset_version}：登记未来复核，历史表现与原结论不作改动`,
        payload: {
          surgeon_id: view.surgeon_id,
          procedure_code: view.scope.procedure_code,
          required_at: view.valid_until,
          reason: `规则集更新至 ${event.payload.ruleset_version}，续期前须按新规则完成复核`,
          ruleset_version: event.payload.ruleset_version,
        },
      });
      // 追加后补投影（绕过 record 防止递归）。
      const saved = this.store.records[this.store.records.length - 1].event;
      this.projection.apply(saved);
    }
  }

  // -- 同意与撤证 -------------------------------------------------------------

  /**
   * 撤回科研用途：证据事件本身不删（依法留存），只登记撤证；
   * 此后研究视图中该证据被屏蔽，而培训/授权审计用途仍可读取，且读取留痕。
   */
  retractResearchUse({ evidence_event_id, surgeon_id, reason, retention_basis, retained_until }, at) {
    if (!this.store.byId(evidence_event_id)) throw new GovernanceError("被撤证据事件不存在");
    const event = {
      event_id: newEventId("retract"),
      event_type: "EVIDENCE_RETRACTED",
      aggregate_type: "training_attempt",
      aggregate_id: evidence_event_id,
      occurred_at: at,
      version: (this.store.stream(evidence_event_id).length || 0) + 1,
      summary: `证据 ${evidence_event_id} 撤回科研用途；依 ${retention_basis} 留存培训与审计记录至 ${retained_until.slice(0, 10)}`,
      payload: { evidence_event_id, surgeon_id, retracted_at: at, reason, retention_basis, retained_until },
    };
    return this.record(event);
  }

  /**
   * 按用途读取证据视图。
   * - research：屏蔽已撤回科研用途的条目。
   * - training / privilege_audit：依法留存，全部可见，但每次读取写入审计日志。
   */
  viewEvidence(surgeonId, purpose, actor) {
    const s = this.projection.surgeon(surgeonId);
    const visible = [];
    for (const bucket of ["attempts", "observations", "cases"]) {
      for (const item of s[bucket]) {
        if (purpose === "research" && this.projection.isResearchRetracted(item.event_id)) {
          visible.push({ event_id: item.event_id, redacted: true, reason: "subject withdrew research use" });
          continue;
        }
        visible.push(item);
      }
    }
    this.audit.record({
      actor,
      purpose,
      surgeon_id: surgeonId,
      event_ids: visible.map((v) => v.event_id),
      action: "view_evidence",
    });
    return visible;
  }

  // -- 申诉 -------------------------------------------------------------------

  fileAppeal({ surgeon_id, against_decision_id, scope, grounds }, at) {
    const appealId = `appeal-${surgeon_id}-${against_decision_id}`;
    if (this.projection.appeals.has(appealId)) throw new GovernanceError("同一决定的申诉已存在，请勿重复提交");
    return this.record({
      event_id: newEventId("appeal"),
      event_type: "APPEAL_FILED",
      aggregate_type: "appeal",
      aggregate_id: appealId,
      occurred_at: at,
      version: 1,
      summary: `${surgeon_id} 就委员会决定 ${against_decision_id} 提出申诉`,
      payload: { appeal_id: appealId, surgeon_id, against_decision_id, scope, filed_at: at, grounds },
    });
  }

  decideAppeal({ appeal_id, outcome, decision, rationale }) {
    const view = this.projection.appeals.get(appeal_id);
    if (!view) throw new GovernanceError(`申诉 ${appeal_id} 不存在`);
    if (view.state !== "pending") throw new GovernanceError("申诉已裁定");
    this.verifyCommitteeDecision(decision, view.scope.hospital_id);
    return this.record({
      event_id: newEventId("appealdec"),
      event_type: "APPEAL_DECIDED",
      aggregate_type: "appeal",
      aggregate_id: appeal_id,
      occurred_at: decision.signed_at,
      version: view.history.length + 1,
      summary: `委员会就申诉 ${appeal_id} 裁定：${outcome}`,
      payload: { appeal_id, surgeon_id: view.surgeon_id, decided_at: decision.signed_at, outcome, decision, rationale },
    });
  }

  // -- 排班查询（核心只读用例） ------------------------------------------------

  /**
   * @param {object} query {surgeon_id, hospital_id, equipment_condition_id,
   *                        procedure_code, role, caliber_mm, at}
   * @param {{actor: string}} meta 调用人，用于审计
   */
  checkScheduling(query, meta = { actor: "scheduling-system" }) {
    const asOf = query.at ?? new Date().toISOString();
    const q = {
      hospital_id: query.hospital_id,
      equipment_condition_id: query.equipment_condition_id,
      procedure_code: query.procedure_code,
      role: query.role,
      caliber_mm: query.caliber_mm,
    };
    const gaps = [];

    // 1) 医院设备条件是否支持该术式与口径。
    const support = this.registries.supports(
      q.hospital_id,
      q.equipment_condition_id,
      q.procedure_code,
      q.caliber_mm,
    );
    if (!support.ok) {
      gaps.push({ kind: "hospital_capability", requirement: "医院设备条件支持", detail: support.reason });
    }

    // 2) 委员会授权状态（先确定 active/suspended/expired，以便对持有效授权者
    //    按授权钉住的规则版本评估证据——规则更新不得即时收紧仍在有效期的授权）。
    const queryScope = { ...q, caliber_min_mm: q.caliber_mm ?? 0.1, caliber_max_mm: q.caliber_mm ?? 99 };
    const matches = this.projection.privilegesFor(query.surgeon_id, queryScope);
    const active = matches.find((v) => v.state === "active" && Date.parse(v.valid_until) >= Date.parse(asOf));
    const suspended = matches.find((v) => v.state === "suspended");
    const expired = matches.find((v) => v.state === "active" && Date.parse(v.valid_until) < Date.parse(asOf));

    // 3) 证据、时效、复核、导师异议：持有效授权按其 ruleset_version，否则最新规则。
    const evalResult = evaluateEvidence(
      this.projection,
      this.registries,
      {
        surgeon_id: query.surgeon_id,
        procedure_code: q.procedure_code,
        role: q.role,
        caliber_mm: q.caliber_mm,
        as_of: asOf,
      },
      { rulesetVersion: active?.ruleset_version },
    );
    gaps.push(...evalResult.gaps);
    const latestRulesVersion = this.registries.latestRulesetVersion();
    if (active?.ruleset_version && active.ruleset_version !== latestRulesVersion) {
      evalResult.advisories.push({
        kind: "review",
        requirement: `按规则集 ${latestRulesVersion} 完成未来复核`,
        detail: `规则已由 ${active.ruleset_version} 更新为 ${latestRulesVersion}；当前授权在有效期内继续有效，续期前须按新规则完成未来复核`,
      });
    }

    let againstDecisionId;
    if (suspended) {
      const last = suspended.history.at(-1);
      againstDecisionId = last.decision_id;
      gaps.push({
        kind: "committee_decision",
        requirement: "有效（未暂停）的委员会授权",
        detail: `该范围权限已于 ${last.at.slice(0, 10)} 被委员会暂停（${suspended.suspension_reason}）；恢复只能由委员会签署`,
      });
    } else if (expired) {
      againstDecisionId = expired.history.at(-1).decision_id;
      gaps.push({
        kind: "committee_decision",
        requirement: "委员会续期决定",
        detail: `授权已于 ${expired.valid_until.slice(0, 10)} 到期，须由委员会按当前规则续期后才可安排`,
      });
    } else if (!active) {
      gaps.push({
        kind: "committee_decision",
        requirement: "医院委员会授权决定",
        detail: "证据再充分也不自动授权：当前没有该范围的有效委员会授予记录",
      });
    }

    // 4) 在审申诉（须知悉，不改变授权状态）。
    const advisories = [...evalResult.advisories];
    const decisionForAppeal = againstDecisionId ?? active?.history.at(-1)?.decision_id;
    const pendingAppeal = decisionForAppeal
      ? this.projection.pendingAppealAgainst(decisionForAppeal)
      : null;
    if (pendingAppeal) {
      advisories.push({
        kind: "appeal_pending",
        requirement: "申诉处理结果",
        detail: `针对相关决定存在在审申诉 ${pendingAppeal.appeal_id}，排班时应知悉`,
      });
    }

    const authorized = gaps.length === 0 && !!active;
    const provenance = active
      ? this.buildProvenance(active, meta.actor)
      : this.buildPartialProvenance(query.surgeon_id, q, evalResult, meta.actor);

    return {
      surgeon_id: query.surgeon_id,
      query: q,
      as_of: asOf,
      authorized,
      current_scope: authorized || active ? active.scope : undefined,
      valid_until: active ? active.valid_until : undefined,
      gaps,
      advisories,
      appeal: {
        available: true,
        instructions:
          "如对证据认定或委员会决定有异议，可在 15 个工作日内向医院医务部门提交申诉；申诉期间暂停类决定继续执行，委员会复核后裁定。",
        against_decision_id: decisionForAppeal ?? active?.history.at(-1)?.decision_id,
      },
      provenance,
    };
  }

  /** 完整授权来路：授权事件 → 复核 → 底层证据（递归闭包），含暂停/恢复/续期与撤证标记。 */
  buildProvenance(privilegeView, actor) {
    const ids = new Set();
    for (const h of privilegeView.history) ids.add(h.event_id);
    for (const base of privilegeView.based_on ?? []) ids.add(base);
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...ids]) {
        const e = this.store.byId(id);
        for (const base of e?.payload?.based_on_event_ids ?? []) {
          if (!ids.has(base)) {
            ids.add(base);
            changed = true;
          }
        }
      }
    }
    const chain = [...ids]
      .map((id) => this.store.byId(id))
      .filter(Boolean)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
      .map((e) => ({
        event_id: e.event_id,
        event_type: e.event_type,
        occurred_at: e.occurred_at,
        summary: e.summary,
        research_retracted: this.projection.isResearchRetracted(e.event_id) || undefined,
      }));
    this.audit.record({
      actor,
      action: "read_privilege_provenance",
      privilege_id: privilegeView.privilege_id,
      event_ids: [...ids],
    });
    return chain;
  }

  /** 未授权时也返回证据来路（供缺口说明与申诉举证）。 */
  buildPartialProvenance(surgeonId, q, evalResult, actor) {
    const ids = new Set();
    for (const list of ["course_attempts", "sim_attempts", "observations", "cases"]) {
      for (const id of evalResult.qualifying?.[list] ?? []) ids.add(id);
    }
    if (evalResult.qualifying?.review) ids.add(evalResult.qualifying.review);
    const chain = [...ids]
      .map((id) => this.store.byId(id))
      .filter(Boolean)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
      .map((e) => ({
        event_id: e.event_id,
        event_type: e.event_type,
        occurred_at: e.occurred_at,
        summary: e.summary,
      }));
    this.audit.record({ actor, action: "read_partial_provenance", surgeon_id: surgeonId, event_ids: [...ids] });
    return chain;
  }
}

function committeeLabel(service, decision) {
  return service.registries.getCommittee(decision.committee_id)?.name ?? decision.committee_id;
}

function roleLabel(role) {
  return {
    observer: "观摩",
    assistant: "助手",
    co_surgeon: "共同术者",
    chief_under_supervision: "督导下主刀",
    independent_chief: "独立主刀",
  }[role];
}
