// 身份解析。整个 Gateway **唯一**一处产生 Principal 的地方。
//
// 做成单出口，是因为「不信客户端」这条规则如果散在各处靠自觉，
// 迟早有人从 body 里读一个 siteId 图方便。这里让类型系统兜底。

import { Principal, ErpPersona, DocType, DeniedError, SPOOFABLE_FIELDS } from './types.js';

/** 平台令牌记录。真实实现读平台存储，这里是接口。 */
export interface TokenRecord {
  learnerId: string;
  siteId: string;
  personaName: string;
  allowedDocTypes: readonly DocType[];
  expiresAt: number;
  revoked: boolean;
}

export interface TokenStore {
  lookup(token: string): Promise<TokenRecord | null>;
}

export class Identity {
  constructor(private tokens: TokenStore, private now: () => number = Date.now) {}

  /**
   * @param bearer  Authorization: Bearer <平台令牌>
   * @param body    请求体 —— **只用来做防伪检查，不取任何身份信息**
   */
  async resolve(bearer: string | undefined, body?: Record<string, unknown>): Promise<Principal> {
    // 身份字段即使是空值也拒绝；只检查存在性，不用请求体生成身份。
    for (const field of [...SPOOFABLE_FIELDS, 'runId']) {
      if (body && Object.prototype.hasOwnProperty.call(body, field)) {
        throw new DeniedError(`请求体不允许身份字段 ${field}`, 'SPOOFED_IDENTITY');
      }
    }

    if (!bearer) throw new DeniedError('缺少平台令牌', 'MISSING_TOKEN');
    if (!bearer.startsWith('Bearer '))
      throw new DeniedError('Authorization 必须使用 Bearer 令牌', 'INVALID_TOKEN');
    const token = bearer.slice('Bearer '.length).trim();
    if (!token) throw new DeniedError('平台令牌为空', 'MISSING_TOKEN');

    const rec = await this.tokens.lookup(token);
    if (!rec) throw new DeniedError('平台令牌不存在或未签发', 'INVALID_TOKEN');
    if (rec.revoked) throw new DeniedError('平台令牌已撤销', 'INVALID_TOKEN');
    if (rec.expiresAt <= this.now()) throw new DeniedError('平台令牌已过期', 'EXPIRED_TOKEN');

    const persona: ErpPersona = { name: rec.personaName, allowedDocTypes: rec.allowedDocTypes };
    return { learnerId: rec.learnerId, siteId: rec.siteId, persona };
  }
}

/** 内存令牌表。mock 模式与测试用。 */
export class MemoryTokenStore implements TokenStore {
  private m = new Map<string, TokenRecord>();
  put(token: string, rec: TokenRecord): void { this.m.set(token, rec); }
  async lookup(token: string): Promise<TokenRecord | null> { return this.m.get(token) ?? null; }
}
