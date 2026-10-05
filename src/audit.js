/**
 * 只读访问审计日志（只追加，内存实现可替换为持久化 sink）。
 * 撤回科研用途后，培训证据因法定义务继续留存；任何 audit 用途的读取
 * 都必须在此留痕，保证“留存但可审计”。
 */

export class AuditLog {
  constructor() {
    this.entries = [];
  }

  record(entry) {
    const full = { at: new Date().toISOString(), ...entry };
    this.entries.push(full);
    return full;
  }

  byEvent(eventId) {
    return this.entries.filter((e) => e.event_ids.includes(eventId));
  }

  all() {
    return this.entries.slice();
  }
}
