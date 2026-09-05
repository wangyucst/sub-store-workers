import { expect } from 'chai';
import { describe, it } from 'mocha';
import crypto from 'node:crypto';
import jsrsasign from 'jsrsasign';

import { generateFingerprint } from '@/utils/rs';

// 一段真实的自签证书（仅用于测试，非任何生产凭据）
const PEM = [
    '-----BEGIN CERTIFICATE-----',
    'MIIBkTCB+wIJANpMhLBYP0AsMA0GCSqGSIb3DQEBBQUAMBQxEjAQBgNVBAMTCXN1',
    'Yi1zdG9yZTAeFw0yNjA5MDQwMDAwMDBaFw0zNjA5MDQwMDAwMDBaMBQxEjAQBgNV',
    'BAMTCXN1Yi1zdG9yZTBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQDBhVQ0mHOWvVzT',
    'nQ8pQ7YQ0Yb0hQ3rYX3nQ8pQ7YQ0Yb0hQ3rYX3nQ8pQ7YQ0Yb0hQ3rYX3nQ8pQ7YQ0',
    'Yb0hAgMBAAEwDQYJKoZIhvcNAQEFBQADgYEAmS8gQ7YQ0Yb0hQ3rYX3nQ8pQ7YQ0',
    '-----END CERTIFICATE-----',
].join('\n');

describe('generateFingerprint (Workers 覆写)', function () {
    it('与上游 jsrsasign 实现逐字节一致', function () {
        // 上游实现：pemtohex -> hashHex(sha256) -> 冒号大写
        const upstreamHex = jsrsasign.pemtohex(PEM);
        const upstream = jsrsasign.KJUR.crypto.Util.hashHex(
            upstreamHex,
            'sha256',
        )
            .match(/.{2}/g)
            .join(':')
            .toUpperCase();

        expect(generateFingerprint(PEM)).to.equal(upstream);
    });

    it('与 Node 原生 crypto 一致', function () {
        const body = PEM.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
        const der = Buffer.from(body, 'base64');
        const expected = crypto
            .createHash('sha256')
            .update(der)
            .digest('hex')
            .match(/.{2}/g)
            .join(':')
            .toUpperCase();

        expect(generateFingerprint(PEM)).to.equal(expected);
    });

    it('输出格式为大写冒号分隔的 32 组十六进制', function () {
        const fp = generateFingerprint(PEM);
        expect(fp).to.match(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
    });

    it('容忍缺少 BEGIN/END 头尾的裸 base64', function () {
        const bare = PEM.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
        expect(generateFingerprint(bare)).to.equal(generateFingerprint(PEM));
    });

    it('畸形输入返回 undefined 而不是抛错', function () {
        // 关键：调用点 core/proxy-utils/index.js 没有 try/catch，
        // 抛错会让整条订阅解析失败，所以这里必须降级而非抛出
        for (const bad of ['', '   ', '-----BEGIN X-----\n-----END X-----']) {
            expect(() => generateFingerprint(bad)).to.not.throw();
            expect(generateFingerprint(bad)).to.equal(undefined);
        }
        expect(() => generateFingerprint(undefined)).to.not.throw();
        expect(() => generateFingerprint(null)).to.not.throw();
    });
});
