import { randomBytes } from 'node:crypto';
import { queryWindowsPortOwners } from './windows-owner-query.mjs';
import { releaseWindowsPortOwner } from './windows-owner-release.mjs';

const problem = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const products = { glove: '手套', 'hand-pad': '手垫', body: '人体传感器', insole: '鞋垫' };

export function normalizeSerialPort(value) {
  if (typeof value !== 'string' || value.length > 24) throw problem('请选择有效的 Windows COM 串口。', 400);
  const match = /^(?:\\\\\.\\)?COM0*([1-9][0-9]{0,4})$/i.exec(value.trim());
  if (!match) throw problem('请选择有效的 Windows COM 串口。', 400);
  return `COM${Number(match[1])}`;
}
function samePort(value, port) {
  try { return normalizeSerialPort(value) === port; } catch { return false; }
}
function recording(status) {
  return Boolean(status.session_id) || ['recording', 'stopping'].includes(status.state);
}
function inspectionReason(result) {
  const reason = result.reason;
  if (!reason && result.complete === true) return undefined;
  if (reason === 'unsupported_platform') return '当前系统暂不支持查询外部串口占用程序。';
  if (reason === 'port_not_mapped') return 'Windows 未检测到此串口，请检查设备连接并刷新串口列表。';
  if (reason === 'helper_timeout') return 'Windows 占用查询超时，暂时无法确认，请稍后重新查询。';
  if (reason?.startsWith('helper_')) return 'Windows 暂未完成占用查询，请稍后重试或在原程序中断开串口。';
  return result.owners?.length
    ? '已列出确认的占用程序；部分进程无法查询，结果可能不完整。'
    : '部分系统进程无权访问或查询超时，暂时无法确认全部占用情况。';
}

/** Explicit inspection only: expensive OS handle scans never run on preview polling. */
export class PortOwnershipService {
  constructor({ capture, queryOwners = queryWindowsPortOwners, releaseOwner = releaseWindowsPortOwner,
    now = Date.now, tokenTtlMs = 120000, protectedPids = [] }) {
    this.capture = capture; this.queryOwners = queryOwners; this.releaseOwner = releaseOwner;
    this.now = now; this.tokenTtlMs = tokenTtlMs; this.extraProtectedPids = protectedPids;
    this.tokens = new Map(); this.scans = new Map(); this.releasing = false; this.revision = 0;
  }
  protectedPids() {
    return [...new Set([process.pid, process.ppid, this.capture.child?.pid, ...this.extraProtectedPids])]
      .filter(pid => Number.isInteger(pid) && pid > 0);
  }
  async internal(port) {
    const info = await this.capture.sdkInfo();
    return (info?.instances ?? (info ? [info] : [])).filter(instance =>
      samePort(instance.path, port) && (instance.connected || instance.has_device || instance.connecting));
  }
  idle() {
    if (recording(this.capture.status())) throw problem('请先停止并保存录制，再释放串口。');
  }
  prune() {
    for (const [token, value] of this.tokens) if (value.expires <= this.now()) this.tokens.delete(token);
    while (this.tokens.size >= 128) this.tokens.delete(this.tokens.keys().next().value);
  }
  ticket(port, target) {
    this.prune();
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, { port, target, expires: this.now() + this.tokenTtlMs, revision: this.revision });
    return token;
  }
  async scan(port, preferredPids = [], fresh = false) {
    if (fresh && this.scans.has(port)) await this.scans.get(port);
    if (this.scans.has(port)) return this.scans.get(port);
    if (this.scans.size >= 2) throw problem('正在查询其他串口，请稍后再试。', 429);
    const pending = Promise.resolve().then(() => this.queryOwners(port, {
      preferredPids: [...new Set([...preferredPids, ...this.protectedPids()])],
    }));
    this.scans.set(port, pending);
    try { return await pending; } finally { if (this.scans.get(port) === pending) this.scans.delete(port); }
  }
  externalReason(owner) {
    if (recording(this.capture.status())) return '请先停止并保存录制。';
    if (!Number.isInteger(owner.pid) || owner.pid <= 4 || this.protectedPids().includes(owner.pid))
      return '这是当前采集服务或受保护进程，请通过对应设备的断开按钮释放。';
    if (owner.isCritical !== false || !Number.isInteger(owner.sessionId) || owner.sessionId <= 0)
      return '系统或受保护进程不能在此结束。';
    if (owner.currentUserOwned !== true) return '无法确认属于当前用户，请在原程序中断开串口。';
    if (typeof owner.creationTime !== 'string' || !/^[1-9][0-9]{0,19}$/.test(owner.creationTime))
      return '无法验证进程身份，请在原程序中断开串口。';
    return null;
  }
  async inspect(input = {}) {
    const port = normalizeSerialPort(input.port);
    const instances = await this.internal(port);
    if (instances.length) {
      const owners = instances.map(instance => {
        const reason = recording(this.capture.status()) ? '请先停止并保存录制。'
          : instance.connecting ? '设备正在连接，请等待连接结束后重新查询。' : null;
        const target = { kind: 'internal', instance_id: instance.instance_id ?? 'default',
          product: instance.product, path: port };
        return { id: `internal:${target.instance_id}`, kind: 'internal',
          name: `本工作站 · ${products[instance.product] ?? instance.product ?? '传感器'} (${target.instance_id})`,
          instance_id: target.instance_id, pid: this.capture.child?.pid,
          can_release: !reason, ...(reason ? { release_reason: reason } : { release_token: this.ticket(port, target) }) };
      });
      return { port, owners, complete: true };
    }
    const result = await this.scan(port);
    // A connection might have been established while the OS scan was running.
    if ((await this.internal(port)).length) return this.inspect({ port });
    const owners = (result.owners ?? []).map(owner => {
      const reason = this.externalReason(owner);
      const target = { ...owner, kind: 'external' };
      return { id: `external:${owner.pid}:${owner.creationTime ?? 'unknown'}`, kind: 'external',
        name: owner.name || '未知程序', pid: owner.pid, executable: owner.executable,
        can_release: !reason, ...(reason ? { release_reason: reason } : { release_token: this.ticket(port, target) }) };
    });
    const reason = inspectionReason(result);
    return { port, owners, complete: result.complete === true, ...(reason ? { reason } : {}) };
  }
  async release(input = {}) {
    const port = normalizeSerialPort(input.port);
    if (input.confirm !== true) throw problem('请先确认需要断开连接或结束占用程序。', 400);
    if (this.releasing) throw problem('正在释放串口，请等待当前操作完成。');
    const token = input.release_token;
    const ticket = typeof token === 'string' ? this.tokens.get(token) : null;
    if (!ticket || ticket.port !== port || ticket.expires <= this.now())
      throw problem('占用信息已过期，请重新查询后确认。');
    this.idle();
    this.tokens.delete(token);
    this.releasing = true;
    try {
      const internal = await this.internal(port);
      const target = ticket.target;
      if (target.kind === 'internal') {
        const instance = internal.find(item => (item.instance_id ?? 'default') === target.instance_id && item.product === target.product);
        if (!instance || instance.connecting) throw problem('设备连接状态已变化，请重新查询。');
        this.assertCurrent(ticket); this.idle();
        await this.capture.sdkDisconnect({ instance_id: target.instance_id });
        return { released: true, port, message: `${port} 的本工作站连接已断开，可以重新连接。` };
      }
      if (internal.length) throw problem('串口已被本工作站连接，占用方已变化，请重新查询。');
      const result = await this.scan(port, [target.pid], true);
      const current = (result.owners ?? []).find(owner => owner.pid === target.pid && owner.creationTime === target.creationTime);
      if (!current) throw problem('原占用程序已退出或串口占用已变化，请重新查询。');
      const reason = this.externalReason(current);
      if (reason) throw problem(reason);
      // A release request cannot act on a connection created during the OS scan.
      if ((await this.internal(port)).length) throw problem('串口已被本工作站连接，请重新查询。');
      this.assertCurrent(ticket); this.idle();
      const resultRelease = await this.releaseOwner(current, { protectedPids: this.protectedPids() });
      if (resultRelease?.released !== true) {
        const reasons = { owner_changed: '进程身份已变化，请重新查询。', access_denied: 'Windows 拒绝结束此程序，请在原程序中断开串口。',
          different_user: '占用程序属于其他用户，请在原程序中断开串口。', critical_process: '不能结束系统关键进程。',
          session_zero: '不能结束系统服务。', protected_process: '不能结束当前采集服务或受保护进程。',
          owner_unverifiable: '无法再次确认进程身份，请在原程序中断开串口。', already_exited: '原程序已经退出，请重新查询占用状态。',
          helper_timeout: '释放操作超时，请重新查询占用状态。', wait_timeout: '程序尚未退出，请稍后重新查询占用状态。' };
        throw problem(reasons[resultRelease?.reason] ?? '未能确认程序已结束，请重新查询占用状态。');
      }
      return { released: true, port, message: `已结束 ${current.name || '占用程序'}（PID ${current.pid}），请重新连接 ${port}。` };
    } finally { this.releasing = false; }
  }
  assertCurrent(ticket) {
    if (ticket.revision !== this.revision || ticket.expires <= this.now())
      throw problem('设备连接或占用信息已变化，请重新查询。');
  }
  invalidate() { this.revision++; this.tokens.clear(); }
  close() { this.invalidate(); }
}
