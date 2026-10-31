// 真 ERPNext 客户端。**凭据只在这里出现，永远不出 Gateway 进程。**
//
// 两处真踩过的坑：
//   1. Frappe 按 Host 头路由站点。erp.localhost 在 Windows 上 Node 解析不了
//      （dns.lookup → ENOTFOUND），所以基址走 localhost，站点靠显式 Host 头指定。
//   2. 不置 set_posting_time 时 ERPNext 会把 posting_date 覆盖成站点当天，
//      跨时区就触发「截止日期早于过帐日期」。写单一律带它。

import { DocType, ErpClient, ErpFilters, ErpRef, UpstreamError } from './types.js';

export interface SiteCredential { host: string; user: string; password: string }

/** 凭据解析器。学员拿不到这个接口的实现。 */
export interface CredentialResolver {
  resolve(siteId: string, persona: string): Promise<SiteCredential>;
}

export class HttpErp implements ErpClient {
  private cookies = new Map<string, string>();
  constructor(private baseUrl: string, private creds: CredentialResolver) {}

  private async session(siteId: string, persona: string): Promise<{ host: string; cookie: string }> {
    const c = await this.creds.resolve(siteId, persona);
    const ck = c.host + ':' + c.user;
    const cached = this.cookies.get(ck);
    if (cached) return { host: c.host, cookie: cached };

    const r = await fetch(this.baseUrl + '/api/method/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: c.host },
      body: JSON.stringify({ usr: c.user, pwd: c.password }),
    });
    if (!r.ok) throw new UpstreamError('login failed for site ' + c.host + ' (' + r.status + ')');
    const cookie = (r.headers.getSetCookie?.() ?? []).join('; ');
    this.cookies.set(ck, cookie);
    return { host: c.host, cookie };
  }

  private async req(
    siteId: string, persona: string, path: string,
    init: RequestInit = {}, effectMayHaveHappened = false,
  ): Promise<any> {
    const { host, cookie } = await this.session(siteId, persona);
    const r = await fetch(this.baseUrl + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', Host: host, Cookie: cookie, ...(init.headers ?? {}) },
    });
    const text = await r.text();
    if (!r.ok) throw new UpstreamError(r.status + ' ' + text.slice(0, 400), effectMayHaveHappened);
    return text ? JSON.parse(text) : null;
  }

  async list(siteId: string, persona: string, dt: DocType, filters: ErpFilters = {}): Promise<Record<string, unknown>[]> {
    const f = encodeURIComponent(JSON.stringify(Object.entries(filters).map(([k, v]) => [k, '=', v])));
    const j = await this.req(siteId, persona,
      '/api/resource/' + encodeURIComponent(dt) + '?limit_page_length=200&fields=["*"]&filters=' + f);
    return (j?.data ?? []) as Record<string, unknown>[];
  }

  async get(siteId: string, persona: string, dt: DocType, name: string): Promise<Record<string, unknown>> {
    const j = await this.req(siteId, persona,
      '/api/resource/' + encodeURIComponent(dt) + '/' + encodeURIComponent(name));
    if (!j?.data) throw new UpstreamError(dt + ' ' + name + ' not found in site ' + siteId);
    const d = j.data as Record<string, unknown>;
    return { ...d, docstatus: Number(d.docstatus) };   // 一律数字，不要字符串
  }

  async insert(siteId: string, persona: string, dt: DocType, doc: Record<string, unknown>): Promise<ErpRef> {
    const body = { set_posting_time: 1, ...doc };
    // 写请求一旦发出去，效果就可能已经发生 —— 抛错时要让上层知道该去对账。
    const j = await this.req(siteId, persona, '/api/resource/' + encodeURIComponent(dt),
      { method: 'POST', body: JSON.stringify(body) }, true);
    return { doctype: dt, name: String(j.data.name) };
  }

  async submit(siteId: string, persona: string, dt: DocType, name: string): Promise<ErpRef> {
    await this.req(siteId, persona,
      '/api/resource/' + encodeURIComponent(dt) + '/' + encodeURIComponent(name),
      { method: 'PUT', body: JSON.stringify({ docstatus: 1 }) }, true);
    return { doctype: dt, name };
  }

  async cancel(siteId: string, persona: string, dt: DocType, name: string): Promise<void> {
    await this.req(siteId, persona, '/api/method/frappe.client.cancel',
      { method: 'POST', body: JSON.stringify({ doctype: dt, name }) }, true);
  }

  async remove(siteId: string, persona: string, dt: DocType, name: string): Promise<void> {
    await this.req(siteId, persona,
      '/api/resource/' + encodeURIComponent(dt) + '/' + encodeURIComponent(name),
      { method: 'DELETE' }, true);
  }
}
