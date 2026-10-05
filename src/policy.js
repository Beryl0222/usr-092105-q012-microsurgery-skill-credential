/**
 * 授权证据规则评估。
 *
 * 核心立场：
 * - 课时只满足“课程前置”，模拟必须“连续稳定达标”，二者本身都不产生授权。
 * - 一次成功不算：模拟任务以“最近 N 次全部通过”为准。
 * - 导师否决/异议单独成项，未被阶段复核裁定前不得被多数意见冲销。
 * - 证据有时效（currency_days）：超期未实践 → 重新复核缺口，即使授权尚在有效期。
 * - 阶段复核结论钉住规则版本；规则集更新后产生“未来复核”缺口，但不改写历史表现。
 */

import { roleLevel } from "./roles.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(aIso, bIso) {
  return Math.abs(Date.parse(bIso) - Date.parse(aIso)) / DAY_MS;
}

function gap(kind, requirement, detail) {
  return { kind, requirement, detail };
}

/**
 * 评估某医师在某术式、某角色上截至 as_of 的证据状态。
 * @param {object} [options]
 * @param {string} [options.rulesetVersion] 强制按指定规则版本评估
 *  （排班查询对持有效授权者按授权钉住的版本，避免规则更新即时收紧既有授权；
 *   授予/续期/恢复一律用最新版本）。
 * @returns {{satisfied: boolean, gaps: Array, ruleset_version: string|null, qualifying: object}}
 */
export function evaluateEvidence(projection, registries, input, options = {}) {
  const { surgeon_id, procedure_code, role, caliber_mm, as_of } = input;
  const gaps = [];
  const advisories = [];
  const s = projection.surgeon(surgeon_id);

  const forcedVersion = options.rulesetVersion ?? null;
  const latestVersion = forcedVersion ?? registries.latestRulesetVersion();
  if (!latestVersion) {
    return {
      satisfied: false,
      gaps: [gap("review", "授权规则集", "尚未发布任何授权规则集，无法评估")],
      advisories: [],
      ruleset_version: null,
      qualifying: {},
    };
  }
  if (!registries.getRuleset(latestVersion)) {
    return {
      satisfied: false,
      gaps: [gap("review", "授权规则集", `指定的规则版本 ${latestVersion} 不存在`)],
      advisories: [],
      ruleset_version: latestVersion,
      qualifying: {},
    };
  }
  const ruleset = registries.getRuleset(latestVersion);
  const procReqs = ruleset.role_requirements[procedure_code];
  const req = procReqs?.[role];
  if (!req) {
    return {
      satisfied: false,
      gaps: [gap("evidence", "角色规则配置", `规则集 ${latestVersion} 未配置术式 ${procedure_code} 的 ${role} 要求`)],
      advisories: [],
      ruleset_version: latestVersion,
      qualifying: {},
    };
  }

  const qualifying = { course_attempts: [], sim_attempts: [], observations: [], cases: [], review: null };

  // 1) 课程前置 ----------------------------------------------------------------
  for (const code of req.course_codes ?? []) {
    const done = s.attempts.find(
      (a) =>
        a.kind === "course" &&
        a.course_code === code &&
        Date.parse(a.completed_at) <= Date.parse(as_of),
    );
    if (!done) {
      gaps.push(gap("evidence", `课程版本 ${code}`, `缺少课程 ${code} 的有效版本完成记录`));
    } else {
      qualifying.course_attempts.push(done.event_id);
    }
  }

  // 2) 模拟任务：最近 N 次必须全部达标 -----------------------------------------
  for (const taskCode of req.sim_task_codes ?? []) {
    const attempts = s.attempts
      .filter(
        (a) =>
          a.kind === "simulation" &&
          a.sim_task_code === taskCode &&
          Date.parse(a.completed_at) <= Date.parse(as_of),
      )
      .sort((a, b) => a.completed_at.localeCompare(b.completed_at));

    // 取该任务最新版本的定义来判定连续达标次数。
    const taskDef =
      registries.getSimTask(taskCode, attempts[attempts.length - 1]?.sim_task_version) ??
      registries.getSimTask(taskCode, registries.simLatest.get(taskCode));
    const need = taskDef?.required_consecutive_passes ?? 1;

    if (attempts.length < need) {
      gaps.push(
        gap(
          "evidence",
          `模拟任务 ${taskCode} 连续 ${need} 次达标`,
          `该任务仅有 ${attempts.length} 次记录，距离连续 ${need} 次稳定达标还差 ${need - attempts.length} 次；单次成功或仅完成线上课程均不足以证明稳定达标`,
        ),
      );
      continue;
    }
    const suffix = attempts.slice(-need);
    const allPass = suffix.every((a) => a.passed === true);
    if (!allPass) {
      gaps.push(
        gap(
          "evidence",
          `模拟任务 ${taskCode} 连续 ${need} 次达标`,
          `最近 ${need} 次操作未全部达标，须在模拟血管上重新取得连续达标序列`,
        ),
      );
    } else {
      qualifying.sim_attempts.push(...suffix.map((a) => a.event_id));
    }
  }

  // 3) 导师观察 ---------------------------------------------------------------
  const passObs = s.observations
    .filter(
      (o) =>
        o.procedure_code === procedure_code &&
        o.rating === "pass" &&
        roleLevel(o.role) >= roleLevel(role) &&
        // 观察口径不粗于申请口径：更细血管上的通过观察可覆盖更粗口径，反之不可。
        (caliber_mm === undefined || o.caliber_mm <= caliber_mm + 1e-9) &&
        Date.parse(o.observed_at) <= Date.parse(as_of),
    )
    .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const needObs = req.observations ?? 0;
  if (passObs.length < needObs) {
    gaps.push(
      gap(
        "evidence",
        `${needObs} 条导师通过观察`,
        `当前仅有 ${passObs.length} 条与该术式/角色匹配的导师通过观察`,
      ),
    );
  } else {
    qualifying.observations.push(...passObs.slice(-needObs).map((o) => o.event_id));
  }

  // 导师否决/异议：保留每一条，须被其后的阶段复核 proceed 明确裁定。
  for (const o of s.observations) {
    if (o.procedure_code !== procedure_code) continue;
    if (o.rating !== "fail" && o.dissent !== true) continue;
    const adjudicated = s.competencyReviews.some(
      (r) =>
        r.decision === "proceed" &&
        Date.parse(r.reviewed_at) > Date.parse(o.observed_at) &&
        (r.based_on_event_ids ?? []).includes(o.event_id),
    );
    if (!adjudicated) {
      gaps.push(
        gap(
          "evidence",
          "导师异议裁定",
          `导师 ${o.observer_mentor_id} 于 ${o.observed_at} 保留${o.rating === "fail" ? "否决" : "不同"}意见（${o.comments}），须经阶段复核或委员会裁定，不得被多数意见覆盖`,
        ),
      );
    }
  }

  // 4) 实台病例角色与口径 ------------------------------------------------------
  const priorRole = req.prior_case_role;
  const priorCount = req.prior_case_count ?? 0;
  if (priorRole && priorCount > 0) {
    const cases = s.cases
      .filter(
        (c) =>
          c.procedure_code === procedure_code &&
          c.role === priorRole &&
          Date.parse(c.case_date) <= Date.parse(as_of) &&
          // 撤回科研用途不影响培训计数；但若连培训用途同意也不存在，则不能计入。
          projection.consentAllows(c.consent_record_id, "training"),
      )
      .sort((a, b) => a.case_date.localeCompare(b.case_date));
    if (cases.length < priorCount) {
      gaps.push(
        gap(
          "evidence",
          `${priorCount} 例 ${priorRole} 实台病例`,
          `当前仅有 ${cases.length} 例口径与术式相符、同意范围有效的 ${priorRole} 病例`,
        ),
      );
    } else {
      qualifying.cases.push(...cases.slice(-priorCount).map((c) => c.event_id));
    }
  }
  if (req.requires_supervised_chief) {
    const supervised = s.cases.some(
      (c) =>
        c.procedure_code === procedure_code &&
        c.role === "chief_under_supervision" &&
        Date.parse(c.case_date) <= Date.parse(as_of),
    );
    if (!supervised) {
      gaps.push(
        gap("evidence", "督导下主刀经历", "独立主刀前须至少有一例导师督导下主刀记录"),
      );
    }
  }

  // 5) 时效：超期未实践 --------------------------------------------------------
  const practiceRoleLevel = priorRole ? roleLevel(priorRole) : roleLevel(role);
  const latestPractice = s.cases
    .filter(
      (c) =>
        c.procedure_code === procedure_code &&
        roleLevel(c.role) >= practiceRoleLevel &&
        Date.parse(c.case_date) <= Date.parse(as_of) &&
        projection.consentAllows(c.consent_record_id, "training"),
    )
    .map((c) => c.case_date)
    .sort()
    .at(-1);
  if (!latestPractice) {
    gaps.push(gap("currency", `近 ${req.currency_days} 天内实台实践`, "没有可计入的实台病例时间点"));
  } else if (daysBetween(latestPractice, as_of) > req.currency_days) {
    gaps.push(
      gap(
        "currency",
        `近 ${req.currency_days} 天内实台实践`,
        `最近一次相应角色实台实践为 ${latestPractice.slice(0, 10)}，已超过 ${req.currency_days} 天未实践，须重新复核后方可安排`,
      ),
    );
  }

  // 6) 未处置的并发症复盘 ------------------------------------------------------
  // reassessment 与 suspension 类并发症，都须在其后出现引用该复盘事件的
  // proceed 阶段复核才算闭环；suspension 的最终解除仍以委员会恢复事件为准。
  for (const c of s.complications) {
    if (c.procedure_code !== procedure_code) continue;
    if (c.disposition === "none") continue;
    const closed = s.competencyReviews.some(
      (r) =>
        r.decision === "proceed" &&
        Date.parse(r.reviewed_at) > Date.parse(c.occurred_at) &&
        (r.based_on_event_ids ?? []).includes(c.event_id),
    );
    if (!closed) {
      gaps.push(
        gap(
          "review",
          "并发症复盘处置闭环",
          `${c.occurred_at.slice(0, 10)} 的${c.category}（${c.severity}）复盘要求 ${c.disposition}，尚未见到引用该复盘的通过复核`,
        ),
      );
    }
  }

  // 7) 未完成的再评估要求 ------------------------------------------------------
  for (const r of s.reassessments) {
    if (r.procedure_code !== procedure_code) continue;
    const cleared = s.competencyReviews.some(
      (rv) => rv.decision === "proceed" && Date.parse(rv.reviewed_at) >= Date.parse(r.required_at),
    );
    if (!cleared && Date.parse(r.required_at) <= Date.parse(as_of)) {
      gaps.push(gap("review", "到期再评估", `再评估要求已于 ${r.required_at.slice(0, 10)} 到期：${r.reason}`));
    }
  }

  // 8) 阶段能力复核（钉规则版本；规则更新 → 未来复核） --------------------------
  const reviews = s.competencyReviews
    .filter((r) => r.procedure_code === procedure_code && Date.parse(r.reviewed_at) <= Date.parse(as_of))
    .sort((a, b) => a.reviewed_at.localeCompare(b.reviewed_at));
  const latestReview = reviews.at(-1);
  if (!latestReview || latestReview.decision !== "proceed") {
    gaps.push(gap("review", "阶段能力复核 proceed 结论", "缺少通过的阶段能力复核结论"));
  } else {
    if (latestReview.ruleset_version !== latestVersion) {
      // 规则更新只触发“未来复核”：对当前仍有效的排班不构成即时阻断，
      // 但委员会续期/新授权时必须先按新规则复核（见服务层 advisoryPolicy）。
      advisories.push(
        gap(
          "review",
          `按规则集 ${latestVersion} 完成未来复核`,
          `规则已由 ${latestReview.ruleset_version} 更新为 ${latestVersion}；历史表现与原结论保留不篡改，续期前须按新规则完成复核`,
        ),
      );
    }
    // 复核必须晚于它所依据的最新证据，避免“先复核后补证据”。
    const evidenceDates = [
      ...qualifying.sim_attempts.map((id) => projection.surgeon(surgeon_id).attempts.find((a) => a.event_id === id)?.completed_at),
      ...qualifying.observations.map((id) => projection.surgeon(surgeon_id).observations.find((o) => o.event_id === id)?.observed_at),
      ...qualifying.cases.map((id) => projection.surgeon(surgeon_id).cases.find((c) => c.event_id === id)?.case_date),
    ].filter(Boolean);
    const newestEvidence = evidenceDates.sort().at(-1);
    if (newestEvidence && Date.parse(latestReview.reviewed_at) < Date.parse(newestEvidence)) {
      gaps.push(
        gap("review", "复核覆盖最新证据", `最新证据产生于 ${newestEvidence.slice(0, 10)}，晚于复核日期，须重新复核`),
      );
    }
    qualifying.review = latestReview.event_id;
  }

  return {
    satisfied: gaps.length === 0,
    gaps,
    advisories,
    ruleset_version: latestVersion,
    qualifying,
  };
}
