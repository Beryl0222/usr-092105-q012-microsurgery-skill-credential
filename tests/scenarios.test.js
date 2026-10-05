import assert from "node:assert/strict";
import test from "node:test";

import {
  H1, EQ1, PROC, COMMITTEE,
  newService, seedWorld, committeeDecision,
  recordAttemptCourse, recordSimPass, recordObservation, recordCase,
  recordCompetencyReview, buildQualifiedSurgeon, grantIndependentChief,
} from "./fixtures.js";
import { GovernanceError } from "../src/service.js";
import { deidentifyTeachingCase, DeidentificationError, projectCaseForPurpose } from "../src/deidentify.js";

const baseQuery = (surgeonId, at, role = "independent_chief") => ({
  surgeon_id: surgeonId,
  hospital_id: H1,
  equipment_condition_id: EQ1,
  procedure_code: PROC,
  role,
  caliber_mm: 0.8,
  at,
});

test("场景1：只完成线上课程不产生任何授权", () => {
  const svc = newService();
  seedWorld(svc);
  recordAttemptCourse(svc, "surgeon-online", "2026-09-15T10:00:00+08:00", true);

  const res = svc.checkScheduling(baseQuery("surgeon-online", "2026-09-16T10:00:00+08:00"));
  assert.equal(res.authorized, false);
  const details = res.gaps.map((g) => g.detail).join("\n");
  assert.ok(details.includes("连续 3 次"), "应指出模拟连续达标缺口");
  assert.ok(details.includes("导师通过观察"), "应指出导师观察缺口");
  assert.ok(details.includes("委员会"), "应指出委员会授权缺口");
  // 即使伪造一个签署也必须被退回，因为证据缺口仍在。
  assert.throws(
    () =>
      svc.requestGrant({
        surgeon_id: "surgeon-online",
        scope: { hospital_id: H1, equipment_condition_id: EQ1, procedure_code: PROC, caliber_min_mm: 0.5, caliber_max_mm: 1.5, role: "independent_chief" },
        valid_until: "2027-09-27T23:59:59+08:00",
        decision: committeeDecision("2026-09-20T15:00:00+08:00"),
      }),
    GovernanceError,
  );
});

test("场景2：单次模拟成功不算稳定达标", () => {
  const svc = newService();
  seedWorld(svc);
  recordAttemptCourse(svc, "surgeon-once", "2026-03-01T10:00:00+08:00");
  recordSimPass(svc, "surgeon-once", "2026-09-19T10:00:00+08:00", true, 0);

  const res = svc.checkScheduling(baseQuery("surgeon-once", "2026-09-20T10:00:00+08:00", "chief_under_supervision"));
  assert.equal(res.authorized, false);
  assert.ok(res.gaps.some((g) => g.detail.includes("仅有 1 次记录")), "单次成功应被明确拒绝");
});

test("场景3：半年未实践即使授权在有效期，排班也被拦并要求重新复核", () => {
  const svc = newService();
  seedWorld(svc);
  buildQualifiedSurgeon(svc, "surgeon-idle");
  grantIndependentChief(svc, "surgeon-idle");

  // 最近实台 2026-08-20，跳到 2027-05（超过 180 天），授权有效期到 2027-09-27。
  const res = svc.checkScheduling(baseQuery("surgeon-idle", "2027-05-10T08:00:00+08:00"));
  assert.equal(res.authorized, false);
  const currency = res.gaps.find((g) => g.kind === "currency");
  assert.ok(currency, "必须给出时效缺口");
  assert.ok(currency.detail.includes("180"));
  assert.equal(res.valid_until, "2027-09-27T23:59:59+08:00", "纸面授权仍在，到期时间照常返回");
});

test("场景4：导师保留不同意见时不得授权，且异议记录不被覆盖", () => {
  const svc = newService();
  seedWorld(svc);
  const ids = buildQualifiedSurgeon(svc, "surgeon-dissent");
  // 另一位导师追加否决意见。
  recordObservation(svc, "surgeon-dissent", "2026-09-21T09:00:00+08:00", {
    rating: "fail",
    dissent: true,
    mentor: "mentor-g-011",
    comments: "0.8mm口径下进针角度不稳定，不同意独立主刀",
  });

  const res = svc.checkScheduling(baseQuery("surgeon-dissent", "2026-09-25T10:00:00+08:00"));
  assert.ok(res.gaps.some((g) => g.detail.includes("mentor-g-011") && g.detail.includes("不得被多数意见覆盖")));
  // 原始异议在投影中原样保留。
  const dissentObs = svc.projection.surgeon("surgeon-dissent").observations.find((o) => o.observer_mentor_id === "mentor-g-011");
  assert.equal(dissentObs.dissent, true);

  // 阶段复核明确引用该异议并裁定 proceed 后，异议仍保留在历史中，但缺口解除。
  const review2 = recordCompetencyReview(svc, "surgeon-dissent", "2026-09-26T14:00:00+08:00",
    [...ids.simIds, ...ids.obsIds, dissentObs.event_id],
    { notes: "委员会预审：附加模拟与带教后，认定异议涉及问题已纠正，维持准入建议" });
  assert.ok(review2);
  const res2 = svc.checkScheduling(baseQuery("surgeon-dissent", "2026-09-27T10:00:00+08:00"));
  assert.ok(!res2.gaps.some((g) => g.detail.includes("mentor-g-011")), "异议经裁定后不再阻断");
  assert.ok(
    svc.projection.surgeon("surgeon-dissent").observations.some((o) => o.event_id === dissentObs.event_id),
    "异议事件仍在证据链中，未被删除或改写",
  );
});

test("场景5：授权、暂停、恢复只能由委员会达法定人数签署", () => {
  const svc = newService();
  seedWorld(svc);
  buildQualifiedSurgeon(svc, "surgeon-comm");

  // 非在册委员签署被拒。
  assert.throws(() => grantIndependentChiefAt(svc, "surgeon-comm", ["doc-unknown"]), /在册委员/);
  // 人数不足被拒。
  assert.throws(() => grantIndependentChiefAt(svc, "surgeon-comm", ["doc-m1"]), /法定人数/);
  // 合规签署成功。
  const { event: granted } = grantIndependentChief(svc, "surgeon-comm");
  const privilegeId = granted.payload.privilege_id;

  // 导师个人尝试暂停：没有委员会签署块入口，直接类型错误/治理错误。
  assert.throws(
    () =>
      svc.suspendPrivilege({
        privilege_id: privilegeId,
        reason: "导师个人认为不应手术",
        decision: { ...committeeDecision("2026-12-01T15:00:00+08:00"), committee_id: "C-TRAINING-CENTER" },
      }),
    /委员会/,
  );

  // 委员会正式暂停。
  svc.suspendPrivilege({
    privilege_id: privilegeId,
    reason: "近期吻合口栓塞重大并发症复盘",
    decision: committeeDecision("2026-12-02T15:00:00+08:00", ["doc-m2", "doc-m3"], "dec-susp-1"),
  });
  let res = svc.checkScheduling(baseQuery("surgeon-comm", "2026-12-03T08:00:00+08:00"));
  assert.equal(res.authorized, false);
  assert.ok(res.gaps.some((g) => g.detail.includes("暂停")));

  // 恢复必须再次委员会签署，且证据仍满足（无新缺口）。
  svc.restorePrivilege({
    privilege_id: privilegeId,
    valid_until: "2028-06-30T23:59:59+08:00",
    decision: committeeDecision("2027-01-10T15:00:00+08:00", ["doc-m1", "doc-m3"], "dec-restore-1"),
  });
  res = svc.checkScheduling(baseQuery("surgeon-comm", "2027-01-11T08:00:00+08:00"));
  assert.equal(res.authorized, true);
  assert.equal(res.valid_until, "2028-06-30T23:59:59+08:00");
});

function grantIndependentChiefAt(svc, surgeonId, signatories) {
  return svc.requestGrant({
    surgeon_id: surgeonId,
    scope: { hospital_id: H1, equipment_condition_id: EQ1, procedure_code: PROC, caliber_min_mm: 0.5, caliber_max_mm: 1.5, role: "independent_chief" },
    valid_until: "2027-09-27T23:59:59+08:00",
    decision: committeeDecision("2026-09-28T15:00:00+08:00", signatories),
  });
}

test("场景6：规则更新只触发未来复核，不篡改历史表现，且不即时收回授权", () => {
  const svc = newService();
  seedWorld(svc);
  buildQualifiedSurgeon(svc, "surgeon-rules");
  grantIndependentChief(svc, "surgeon-rules");

  // 2026-12 发布规则 2027.1（独立主刀观察数从 3 提到 4）。
  svc.record({
    event_id: "evt-ruleset-2027-1-published",
    event_type: "RULESET_PUBLISHED",
    aggregate_type: "ruleset",
    aggregate_id: "ruleset-2027.1",
    occurred_at: "2026-12-15T09:00:00+08:00",
    version: 1,
    summary: "发布授权规则集 2027.1：独立主刀导师观察提高到4条",
    payload: {
      ruleset_version: "2027.1",
      published_at: "2026-12-15T09:00:00+08:00",
      role_requirements: {
        [PROC]: {
          chief_under_supervision: {
            course_codes: ["COURSE-MICRO-BASIC"], sim_task_codes: ["SIM-ANAST-08"],
            observations: 2, prior_case_role: "co_surgeon", prior_case_count: 2, currency_days: 180,
          },
          independent_chief: {
            course_codes: ["COURSE-MICRO-BASIC"], sim_task_codes: ["SIM-ANAST-08"],
            observations: 4, prior_case_role: "chief_under_supervision", prior_case_count: 2,
            currency_days: 180, requires_supervised_chief: true,
          },
        },
      },
    },
  });

  // 排班仍授权，但带“未来复核”提示；历史授权事件与证据未变。
  const res = svc.checkScheduling(baseQuery("surgeon-rules", "2026-12-20T08:00:00+08:00"));
  assert.equal(res.authorized, true);
  assert.ok(res.advisories.some((a) => a.detail.includes("2027.1") && a.detail.includes("未来复核")));
  assert.equal(svc.store.verifyIntegrity(), null);

  // 续期时新规则生效：观察只有3条 → 被退回，缺口指向新规则。
  const privilegeId = `priv-${H1}|${EQ1}|${PROC}|0.5-1.5|independent_chief`;
  let blocked;
  assert.throws(
    () =>
      svc.renewPrivilege({
        privilege_id: privilegeId,
        valid_until: "2028-09-27T23:59:59+08:00",
        decision: committeeDecision("2027-09-20T15:00:00+08:00", ["doc-m1", "doc-m2"], "dec-renew-blocked"),
      }),
    (e) => {
      blocked = e;
      return e.name === "GovernanceError";
    },
  );
  // 注意：续期时已过 180 天时效，缺口包含时效项；这里验证新规则的复核项也在。
  assert.ok(blocked.gaps.some((g) => g.detail.includes("2027.1")), "续期须按新规则复核");

  // 历史阶段复核结论原样保留为 ruleset 2026.1。
  const reviews = svc.projection.surgeon("surgeon-rules").competencyReviews;
  assert.equal(reviews.at(-1).ruleset_version, "2026.1");
});

test("场景7：教学病例按同意范围脱敏；撤回科研后培训证据依法留存且可审计", () => {
  // 入库前扫描真实标识。
  assert.throws(
    () => deidentifyTeachingCase({ hospital_id: H1, local_case_id: "c1", salt: "s", text: "患者 姓名：张三 术中情况..." }),
    DeidentificationError,
  );

  const svc = newService();
  seedWorld(svc);
  buildQualifiedSurgeon(svc, "surgeon-consent");
  grantIndependentChief(svc, "surgeon-consent");

  const targetCase = svc.projection.surgeon("surgeon-consent").cases[0];
  assert.ok(targetCase.deidentified_case_ref.startsWith("CASE-HSP-01-"));

  // 科研视图可见原始证据。
  const researchBefore = svc.viewEvidence("surgeon-consent", "research", "researcher-li");
  assert.ok(researchBefore.some((v) => v.event_id === targetCase.event_id && !v.redacted));

  // 主体撤回科研用途。
  svc.retractResearchUse({
    evidence_event_id: targetCase.event_id,
    surgeon_id: "surgeon-consent",
    reason: "受试者撤回科研知情同意",
    retention_basis: "《医疗卫生机构科研管理办法》培训证据法定留存义务",
    retained_until: "2031-09-20T23:59:59+08:00",
  }, "2026-10-15T10:00:00+08:00");

  // 科研视图屏蔽；培训与授权审计视图仍可读取（依法留存）。
  const researchAfter = svc.viewEvidence("surgeon-consent", "research", "researcher-li");
  const entry = researchAfter.find((v) => v.event_id === targetCase.event_id);
  assert.equal(entry.redacted, true);

  const trainingView = svc.viewEvidence("surgeon-consent", "training", "training-admin");
  assert.ok(trainingView.some((v) => v.event_id === targetCase.event_id && !v.redacted));

  // 撤回后排班授权不受影响（培训证据仍计入），授权来路中该证据标注 research_retracted。
  const res = svc.checkScheduling(baseQuery("surgeon-consent", "2026-10-16T08:00:00+08:00"));
  assert.equal(res.authorized, true);
  const provEntry = res.provenance.find((p) => p.event_id === targetCase.event_id);
  assert.equal(provEntry.research_retracted, true);

  // 每次留存证据的读取都有审计留痕。
  const audit = svc.audit.byEvent(targetCase.event_id);
  assert.ok(audit.some((a) => a.actor === "researcher-li" && a.purpose === "research"));
  assert.ok(audit.some((a) => a.actor === "training-admin" && a.purpose === "training"));
  assert.ok(audit.some((a) => a.action === "read_privilege_provenance"));

  // 事件不可删除，哈希链完整。
  assert.ok(svc.store.byId(targetCase.event_id));
  assert.equal(svc.store.verifyIntegrity(), null);
});

test("场景8：排班查询返回可承担范围/到期时间，或逐项缺口、申诉入口与完整来路", () => {
  const svc = newService();
  seedWorld(svc);
  buildQualifiedSurgeon(svc, "surgeon-sched");
  grantIndependentChief(svc, "surgeon-sched");

  const ok = svc.checkScheduling(baseQuery("surgeon-sched", "2026-10-01T08:00:00+08:00"));
  assert.equal(ok.authorized, true);
  assert.equal(ok.current_scope.role, "independent_chief");
  assert.equal(ok.valid_until, "2027-09-27T23:59:59+08:00");
  // 来路覆盖：课程 → 3次模拟 → 病例 → 观察 → 复核 → 授权。
  const types = ok.provenance.map((p) => p.event_type);
  assert.ok(types.includes("ATTEMPT_RECORDED"));
  assert.ok(types.includes("OBSERVATION_SIGNED"));
  assert.ok(types.includes("CASE_ROLE_LOGGED"));
  assert.ok(types.includes("COMPETENCY_REVIEWED"));
  assert.ok(types.includes("PRIVILEGE_GRANTED"));
  assert.ok(ok.appeal.available);

  // 设备不支持：查询未登记的设备条件 → 明确医院能力缺口。
  const badEq = svc.checkScheduling({
    ...baseQuery("surgeon-sched", "2026-10-01T08:00:00+08:00"),
    equipment_condition_id: "EQ-MISSING",
  });
  assert.equal(badEq.authorized, false);
  assert.ok(badEq.gaps.some((g) => g.kind === "hospital_capability"));

  // 未授权医师：缺口分类清晰，且保留申诉入口与部分来路供举证。
  const empty = svc.checkScheduling(baseQuery("surgeon-nobody", "2026-10-01T08:00:00+08:00"));
  assert.equal(empty.authorized, false);
  const kinds = new Set(empty.gaps.map((g) => g.kind));
  assert.ok(kinds.has("evidence"));
  assert.ok(kinds.has("review"));
  assert.ok(kinds.has("committee_decision"));
  assert.equal(empty.appeal.available, true);
});

test("场景9：申诉立案与委员会裁定，全程事件留痕", () => {
  const svc = newService();
  seedWorld(svc);
  buildQualifiedSurgeon(svc, "surgeon-appeal");
  grantIndependentChief(svc, "surgeon-appeal");
  const privilegeId = `priv-${H1}|${EQ1}|${PROC}|0.5-1.5|independent_chief`;
  svc.suspendPrivilege({
    privilege_id: privilegeId,
    reason: "并发症争议，医师认为与设备故障有关",
    decision: committeeDecision("2026-11-01T15:00:00+08:00", ["doc-m1", "doc-m2"], "dec-susp-appeal"),
  });

  svc.fileAppeal({
    surgeon_id: "surgeon-appeal",
    against_decision_id: "dec-susp-appeal",
    scope: { hospital_id: H1, equipment_condition_id: EQ1, procedure_code: PROC, caliber_min_mm: 0.5, caliber_max_mm: 1.5, role: "independent_chief" },
    grounds: "当夜显微镜光源故障，已报修，并发症非技术因素",
  }, "2026-11-03T10:00:00+08:00");

  const during = svc.checkScheduling(baseQuery("surgeon-appeal", "2026-11-05T08:00:00+08:00"));
  assert.equal(during.authorized, false, "申诉期间暂停继续执行");
  assert.ok(during.advisories.some((a) => a.kind === "appeal_pending"));

  // 委员会裁定发回重审/推翻后仍须走恢复流程，系统不自动授权。
  svc.decideAppeal({
    appeal_id: "appeal-surgeon-appeal-dec-susp-appeal",
    outcome: "overturned",
    decision: committeeDecision("2026-11-20T15:00:00+08:00", ["doc-m1", "doc-m3"], "dec-appeal-1"),
    rationale: "设备故障记录成立，但恢复仍须完成再评估与委员会恢复签署",
  });
  const after = svc.checkScheduling(baseQuery("surgeon-appeal", "2026-11-21T08:00:00+08:00"));
  assert.equal(after.authorized, false, "申诉推翻不自动恢复权限");
  assert.ok(after.gaps.some((g) => g.detail.includes("暂停")));
});

test("场景10：事件存储幂等、版本连续且历史不可篡改", async () => {
  const { EventStore } = await import("../src/event-store.js");
  const store = new EventStore();
  const make = (id, version) => ({
    event_id: id,
    event_type: "ATTEMPT_RECORDED",
    aggregate_type: "training_attempt",
    aggregate_id: "agg-1",
    occurred_at: "2026-09-20T10:00:00+08:00",
    version,
    summary: "幂等测试事件",
    payload: { surgeon_id: "s", kind: "course", course_code: "C1", completed_at: "2026-09-20T10:00:00+08:00" },
  });
  store.append(make("evt-idem-0001", 1));
  const second = store.append(make("evt-idem-0001", 1)); // 重试
  assert.equal(second.duplicated, true);
  assert.equal(store.all().length, 1);
  assert.throws(() => store.append(make("evt-idem-0002", 3)), /版本冲突/);

  // 篡改历史事件 → 哈希链校验报警。
  store.records[0].event.summary = "被人改过";
  const broken = store.verifyIntegrity();
  assert.ok(broken && broken.index === 0);
});

test("场景11：按同意用途投影病例视图", () => {
  const caseEvent = {
    event_id: "evt-case-x",
    payload: {
      surgeon_id: "s1", procedure_code: PROC, caliber_mm: 0.8, role: "co_surgeon",
      case_date: "2026-05-10T09:00:00+08:00", outcome: "良好", deidentified_case_ref: "CASE-X",
    },
  };
  const blocked = projectCaseForPurpose(caseEvent, ["training", "privilege_audit"], "research");
  assert.equal(blocked.redacted, true);
  const allowed = projectCaseForPurpose(caseEvent, ["training"], "training");
  assert.equal(allowed.deidentified_case_ref, "CASE-X");
  assert.equal("surgeon_id" in allowed, true);
});
