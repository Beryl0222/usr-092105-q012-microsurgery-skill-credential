import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

test("中文样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("授权类事件必须携带 payload 与委员会签署块", () => {
  const errors = validateEvent({
    event_id: "evt-092105-012-0002",
    event_type: "PRIVILEGE_GRANTED",
    aggregate_type: "clinical_privilege",
    aggregate_id: "priv-x",
    occurred_at: "2026-09-28T15:00:00+08:00",
    version: 1,
    summary: "缺少载荷的授权事件",
  });
  assert.ok(errors.some((e) => e.includes("payload")));
});

test("事件类型与聚合类型必须匹配", () => {
  const errors = validateEvent({
    event_id: "evt-092105-012-0003",
    event_type: "ATTEMPT_RECORDED",
    aggregate_type: "clinical_privilege",
    aggregate_id: "x",
    occurred_at: "2026-09-28T15:00:00+08:00",
    version: 1,
    summary: "错配聚合",
    payload: { surgeon_id: "s1", kind: "course", completed_at: "2026-09-01T10:00:00+08:00", course_code: "C1" },
  });
  assert.ok(errors.some((e) => e.includes("聚合类型必须是")));
});
