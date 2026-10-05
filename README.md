# 显微外科技能证据与临床授权系统

把医院排班表上一句笼统的“显微外科结业”，落地为一套**技能证据 → 阶段能力 → 委员会临床授权**的可审计系统。系统是只追加事件流（event sourcing）：课时、模拟成绩或一次成功永远不会自动变成临床权限；授权、暂停、恢复只能由医院委员会签署；规则更新只触发未来复核，不篡改历史表现。

## 治理原则（系统强制，不靠人工自觉）

1. **课时 ≠ 权限**：完成线上课程只满足“课程前置”。模拟任务须在规定口径模拟血管上**连续 N 次稳定达标**；一次成功不算。
2. **授权只能委员会签署**：`PRIVILEGE_GRANTED / SUSPENDED / RESTORED / RENEWED` 必须携带委员会签署块，系统核验委员会归属、委员名册与法定人数。导师个人和培训中心均无权授权或暂停。
3. **证据充分也不自动授权**：没有委员会授予事件，排班查询一律返回 `committee_decision` 缺口。
4. **导师异议保留**：任一导师的 `fail` 或 `dissent` 单独成项，未被其后引用该异议的阶段复核 `proceed` 裁定前持续阻断；多数意见不能冲销个别反对，异议事件永不删除。
5. **时效**：超过规则规定天数（默认 180 天）无相应角色实台实践，即使纸面授权仍在有效期，排班也被拦并要求重新复核。
6. **规则只前溯未来**：规则集新版本不改动历史证据与既往结论；持有效授权者在有效期内继续按授权钉住的规则版本工作，排班结果给出“未来复核”提示；**续期/新授权/恢复**必须按最新规则。
7. **授权范围四维**：医院 × 设备条件 × 术式 × 血管口径区间 × 病例角色（观摩/助手/共同术者/督导下主刀/独立主刀）。范围不漂移，变更须重新授权。
8. **教学病例脱敏与同意**：真实患者标识永不入库（入库前扫描，命中即拒）；病例以假名引用，按 `training / research / privilege_audit` 同意用途投影。撤回科研用途后证据**不删除**，依法继续留存供培训与授权审计，所有读取写入审计日志。
9. **申诉入口常驻**：排班结果无论是否授权都带申诉指引与完整授权来路；申诉期间暂停决定继续执行；申诉被推翻也不自动恢复权限，仍须委员会恢复签署。

## 保存的事实（事件聚合）

| 聚合 | 事件 |
| --- | --- |
| `course_version` | `COURSE_VERSION_PUBLISHED`（课程版本，线上/模拟等交付形态） |
| `sim_task` | `SIM_TASK_DEFINED`（模拟任务、口径、通过阈值、连续达标次数、器械条件） |
| `procedure_definition` | `PROCEDURE_DEFINED`（术式与可授权口径） |
| `hospital_capability` | `HOSPITAL_CAPABILITY_REGISTERED`（医院设备条件与可开展术式/口径） |
| `committee` | `COMMITTEE_REGISTERED`（委员会名册、法定人数） |
| `ruleset` | `RULESET_PUBLISHED`（版本化授权规则） |
| `training_attempt` | `ATTEMPT_RECORDED`（课程/模拟原始操作，含视频引用与哈希）、`EVIDENCE_RETRACTED`（撤回科研用途） |
| `mentor_observation` | `OBSERVATION_SIGNED`（导师观察、评级、不同意见） |
| `case_record` | `CASE_ROLE_LOGGED`（实台病例角色、口径、脱敏引用、同意记录） |
| `consent_record` | `CONSENT_RECORDED` / `CONSENT_SCOPE_UPDATED` |
| `complication_review` | `COMPLICATION_REVIEWED`（并发症复盘与处置要求） |
| `competency_state` | `COMPETENCY_REVIEWED`（阶段能力结论，钉规则版本、引用证据）、`REASSESSMENT_REQUIRED` |
| `clinical_privilege` | `PRIVILEGE_GRANTED / SUSPENDED / RESTORED / RENEWED`（委员会签署的授权生命周期） |
| `appeal` | `APPEAL_FILED` / `APPEAL_DECIDED` |

## 代码结构

- `contracts/domain.schema.json` — 事件信封、事件/聚合取值域、签署块与范围结构。
- `src/domain.ts` — 全部领域类型。
- `src/validator.js` — 信封 + 按事件类型的载荷校验（中文错误）。
- `src/event-store.js` — 只追加存储：`event_id` 幂等、聚合版本乐观并发、**SHA-256 哈希链**（任何历史篡改可被 `verifyIntegrity()` 发现）。
- `src/registries.js` — 版本化注册表（课程/模拟任务/术式/医院设备/委员会/规则集，按时刻取规则版本）。
- `src/projection.js` — 读模型：证据台账、同意现状、授权生命周期视图。
- `src/policy.js` — 证据规则评估（课程、连续模拟达标、导师观察与异议、病例角色、时效、并发症闭环、再评估、阶段复核）。
- `src/service.js` — 用例：委员会签署核验、授予/暂停/恢复/续期、撤证留痕、申诉、**排班查询**。
- `src/deidentify.js` — 病例脱敏、假名化、按同意用途投影。
- `src/audit.js` — 只读访问审计。
- `tests/scenarios.test.js` — 11 个端到端治理场景（见下）。

## 排班查询

输入医院、设备条件、术式、病例角色（可选口径与时间）：

```js
svc.checkScheduling({
  surgeon_id: "surgeon-w-0001",
  hospital_id: "HSP-01",
  equipment_condition_id: "EQ-OPMIC-A",
  procedure_code: "PROC-REPLANT",
  role: "independent_chief",
  caliber_mm: 0.8,
  at: "2026-10-01T08:00:00+08:00",
});
```

返回：

- `authorized`、`current_scope`（当前可承担范围，按口径收窄）、`valid_until`（到期时间）；
- 不满足时 `gaps` 逐项标明类别——`evidence`（缺哪类证据，如“连续 3 次达标还差 2 次”）、`currency`（超期未实践）、`review`（复核/并发症闭环）、`committee_decision`（缺授予/续期/恢复决定）、`hospital_capability`、`consent`；
- `advisories`：不阻断但须知悉（如规则更新后的未来复核、在审申诉）；
- `appeal`：常驻申诉入口与可针对的决定号；
- `provenance`：完整授权来路——授权事件 → 阶段复核 → 导师观察/病例/模拟/课程的递归证据链，撤回科研的条目标注 `research_retracted`。

## 测试场景

`node --test`，共 14 项：

1. 只完成线上课程不授权，伪造签署也被退回；
2. 单次模拟成功不算稳定达标；
3. 半年未实践，授权在有效期内仍被拦；
4. 导师不同意见保留且阻断，裁定后解除但历史不删；
5. 非在册委员/不足法定人数签署被拒；暂停与恢复只能委员会执行；
6. 规则更新只产生未来复核提示、不即时收回授权，续期才按新规则；
7. 病例脱敏拦截、撤回科研后培训证据留存且每次读取可审计；
8. 排班查询返回范围/到期/逐项缺口/申诉入口/完整来路；
9. 申诉立案与裁定，申诉推翻不自动恢复权限；
10. 事件幂等、版本连续、哈希链防篡改；
11. 按同意用途投影病例视图。

## 本地检查

```bash
node --test
```
