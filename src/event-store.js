/**
 * 只追加事件存储。
 *
 * 不变量：
 * 1. 事件只追加，不提供修改/删除接口；规则更新不得篡改历史表现。
 * 2. event_id 全局幂等：来源重试沿用原标识时直接返回既有事件，不重复入账。
 * 3. 同一 aggregate_id 的 version 从 1 连续递增（乐观并发）。
 * 4. 每条事件记录前一条事件的哈希，形成哈希链，任何事后修改都可被 detect 出来。
 */

import { createHash } from "node:crypto";

import { validateEvent } from "./validator.js";

export class EventValidationError extends Error {
  constructor(errors) {
    super(`事件校验失败：${errors.join("；")}`);
    this.name = "EventValidationError";
    this.errors = errors;
  }
}

export class ConcurrencyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConcurrencyError";
  }
}

function canonical(event) {
  return JSON.stringify(event, Object.keys(event).sort());
}

export function hashEvent(event, prevHash) {
  return createHash("sha256").update(`${prevHash}\n${canonical(event)}`).digest("hex");
}

export class EventStore {
  constructor() {
    /** @type {Array<{event: object, hash: string}>} */
    this.records = [];
    this.eventIds = new Map(); // event_id -> record position
    this.aggregateVersions = new Map(); // aggregate_id -> latest version
  }

  /**
   * 追加事件。
   * @param {object} event 已通过信封约定的事件
   * @param {{expectedVersion?: number}} [opts] 聚合当前版本（新聚合为 0 或不传）
   */
  append(event, opts = {}) {
    const errors = validateEvent(event);
    if (errors.length) throw new EventValidationError(errors);

    // 幂等：同一 event_id 重放直接返回既有记录。
    const existing = this.eventIds.get(event.event_id);
    if (existing !== undefined) {
      return { record: this.records[existing], duplicated: true };
    }

    const current = this.aggregateVersions.get(event.aggregate_id) ?? 0;
    if (event.version !== current + 1) {
      throw new ConcurrencyError(
        `聚合 ${event.aggregate_id} 版本冲突：期望 ${current + 1}，收到 ${event.version}`,
      );
    }
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== current) {
      throw new ConcurrencyError(
        `聚合 ${event.aggregate_id} 乐观并发失败：调用方预期版本 ${opts.expectedVersion}，实际 ${current}`,
      );
    }

    const prevHash = this.records.length ? this.records[this.records.length - 1].hash : "GENESIS";
    const hash = hashEvent(event, prevHash);
    const record = { event, hash, prevHash, stored_order: this.records.length };
    this.records.push(record);
    this.eventIds.set(event.event_id, this.records.length - 1);
    this.aggregateVersions.set(event.aggregate_id, event.version);
    return { record, duplicated: false };
  }

  /** 全部事件，按入账顺序（只读视图）。 */
  all() {
    return this.records.map((r) => r.event);
  }

  /** 某聚合的事件流。 */
  stream(aggregateId) {
    return this.records
      .filter((r) => r.event.aggregate_id === aggregateId)
      .map((r) => r.event);
  }

  byId(eventId) {
    const pos = this.eventIds.get(eventId);
    return pos === undefined ? null : this.records[pos].event;
  }

  /**
   * 校验哈希链完整性；任何对历史事件的事后修改都会使校验失败。
   * 返回被篡改位置（null 表示链完整）。
   */
  verifyIntegrity() {
    let prevHash = "GENESIS";
    for (let i = 0; i < this.records.length; i += 1) {
      const { event, hash } = this.records[i];
      if (hashEvent(event, prevHash) !== hash) return { index: i, aggregate_id: event.aggregate_id };
      prevHash = hash;
    }
    return null;
  }
}
