import { expect } from 'chai';
import { describe, it } from 'mocha';

// 刻意直接引入依赖本身，而不是经 `@/utils`（上游 utils/index.js）间接引入。
//
// 原因：上游源码里的 `import * as ipAddress from 'ip-address'` 是裸模块名，在
// @babel/register 下走 Node 默认解析——会沿目录树向上查找，可能命中仓库之外的
// node_modules（本机上就存在一个 ../../node_modules 提供了旧版 9.0.5），
// 结果因机器而异，CI 与本地不一致。
//
// 构建侧没有这个问题：esbuild 用 `nodePaths: [<workers>/node_modules]` 强制解析
// （见 esbuild.js）。本文件从 src/test/ 出发解析 'ip-address'，命中的正是
// sub-store-workers/node_modules，与打进产物的那份完全一致。
import { Address4, Address6 } from 'ip-address';

describe('ip-address (打进产物的那份)', function () {
    it('rejects IPv4 octets with leading zeros (CVE-2026-69192)', function () {
        // 9.0.5 会把 '010.1.1.1' 解析成 '10.1.1.1'（前导零歧义，SSRF 绕过一类）；
        // 上游 2.38.x 升到 ^10.3.1 修复，此处锁定行为，防止依赖被回退到 9.x
        expect(() => new Address4('010.1.1.1')).to.throw();
    });

    it('still parses well-formed IPv4 addresses', function () {
        expect(new Address4('1.2.3.4').correctForm()).to.equal('1.2.3.4');
        expect(new Address4('8.8.8.8/24').correctForm()).to.equal('8.8.8.8');
        expect(new Address4('255.255.255.255').subnetMask).to.equal(32);
    });

    it('keeps IPv6 behaviour unchanged across the 9.x -> 10.x upgrade', function () {
        // 上游唯一的内部调用点是 processors/index.js 的 new Address6(ip).correctForm()
        expect(new Address6('2001:db8::1').correctForm()).to.equal(
            '2001:db8::1',
        );
        expect(
            new Address6('2001:0db8:0000:0000:0000:0000:0000:0001').correctForm(),
        ).to.equal('2001:db8::1');
        expect(() => new Address6('gggg::')).to.throw();
    });
});
