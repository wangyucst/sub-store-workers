/**
 * 证书指纹计算（Workers 版），覆写上游 `../Sub-Store/backend/src/utils/rs.js`。
 *
 * 上游用 jsrsasign 实现：
 *     const hex = rs.pemtohex(caStr);
 *     const fingerPrint = rs.KJUR.crypto.Util.hashHex(hex, 'sha256');
 *     return fingerPrint.match(/.{2}/g).join(':').toUpperCase();
 *
 * 但 jsrsasign 在 Workers 下必须存根（它在模块加载时、也就是全局作用域就生成随机数
 * 种子，而 Workers 禁止在全局作用域生成随机值，真实打包会让 wrangler deploy 被服务端
 * 校验拒绝，code 10021）。存根后 rs 是空对象，上游那两行会抛
 * `TypeError: Cannot read properties of undefined (reading 'Util')`。
 *
 * 而调用点 `core/proxy-utils/index.js` 的
 *     if (!proxy['tls-fingerprint'] && caStr) {
 *         proxy['tls-fingerprint'] = rs.generateFingerprint(caStr);
 *     }
 * 既不在 try 块内（上面那个 try 只包了「读 CA 文件」），其调用方 lastParse()
 * 的两个调用点也没有兜底——所以**一个带 ca-str 的节点会让整条订阅解析失败**。
 *
 * 这里改用 @noble/hashes 的同步 sha256 重新实现：
 *   - 纯 JS、同步、经审计，模块加载时无副作用（不生成随机值、不做 IO）
 *   - 不能用 Web Crypto：`crypto.subtle.digest` 是异步的，而调用点是同步赋值
 *   - 不自己写密码学逻辑，本文件只做 PEM 剥离与十六进制格式化
 *
 * 另外比上游更稳健一点：解析失败时告警并返回 undefined，而不是抛错。上游遇到畸形
 * ca-str 同样会崩掉整条订阅；返回 undefined 对所有下游消费方都安全——它们要么用真值
 * 判断，要么走 producers/utils.js 的 `isPresent(obj, attr)`（基于 _.get 判非
 * undefined/null），都会正确跳过该字段。
 */

import { Base64 } from 'js-base64';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * 计算 PEM 证书的 SHA-256 指纹。
 *
 * @param {string} caStr - PEM 格式证书（可含 BEGIN/END 头尾与换行）
 * @returns {string|undefined} 形如 `AB:CD:...` 的大写冒号分隔指纹；解析失败返回 undefined
 */
export function generateFingerprint(caStr) {
    try {
        // 剥掉 -----BEGIN/END ...----- 头尾与所有空白，只留 base64 主体
        const body = String(caStr)
            .replace(/-----[^-]+-----/g, '')
            .replace(/\s+/g, '');
        if (!body) {
            console.warn('[rs] generateFingerprint: PEM 主体为空，跳过指纹计算');
            return undefined;
        }

        const der = Base64.toUint8Array(body);
        if (!der.length) {
            console.warn('[rs] generateFingerprint: base64 解码结果为空，跳过指纹计算');
            return undefined;
        }

        return bytesToHex(sha256(der))
            .match(/.{2}/g)
            .join(':')
            .toUpperCase();
    } catch (e) {
        // 不向上抛：调用点没有 try/catch，抛出会让整条订阅解析失败
        console.warn(
            `[rs] generateFingerprint 失败，跳过指纹计算: ${e.message ?? e}`,
        );
        return undefined;
    }
}

export default {
    generateFingerprint,
};
