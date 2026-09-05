import { expect } from 'chai';
import { describe, it } from 'mocha';

import {
    normalizeBackendPath,
    matchesBackendPath,
    stripBackendPath,
} from '@/utils/backend-path';

describe('backend path', function () {
    describe('normalizeBackendPath', function () {
        it('treats root and blank values as "no prefix"', function () {
            // 归一化前这些值会让管理 API 全部 401 且无任何入口
            expect(normalizeBackendPath('/')).to.equal('');
            expect(normalizeBackendPath('///')).to.equal('');
            expect(normalizeBackendPath('')).to.equal('');
            expect(normalizeBackendPath('   ')).to.equal('');
            expect(normalizeBackendPath(undefined)).to.equal('');
            expect(normalizeBackendPath(null)).to.equal('');
        });

        it('strips trailing slashes', function () {
            expect(normalizeBackendPath('/secret/')).to.equal('/secret');
            expect(normalizeBackendPath('/secret///')).to.equal('/secret');
        });

        it('adds a missing leading slash', function () {
            expect(normalizeBackendPath('secret')).to.equal('/secret');
            expect(normalizeBackendPath('secret/')).to.equal('/secret');
        });

        it('keeps a well-formed prefix untouched', function () {
            expect(normalizeBackendPath('/secret')).to.equal('/secret');
            expect(normalizeBackendPath('/a/b')).to.equal('/a/b');
        });
    });

    describe('matchesBackendPath', function () {
        it('matches the prefix exactly or followed by a slash', function () {
            expect(matchesBackendPath('/secret', '/secret')).to.equal(true);
            expect(matchesBackendPath('/secret/', '/secret')).to.equal(true);
            expect(matchesBackendPath('/secret/api/subs', '/secret')).to.equal(
                true,
            );
        });

        it('rejects prefixes that are not followed by a slash', function () {
            // 上游 `path.startsWith(backendPath)` 会放过这些，Workers 侧刻意更严
            expect(matchesBackendPath('/secretFOO/api', '/secret')).to.equal(
                false,
            );
            expect(matchesBackendPath('/secretive', '/secret')).to.equal(false);
        });

        it('rejects unprefixed and empty-prefix cases', function () {
            expect(matchesBackendPath('/api/subs', '/secret')).to.equal(false);
            expect(matchesBackendPath('/api/subs', '')).to.equal(false);
        });
    });

    describe('stripBackendPath', function () {
        it('strips a matching prefix', function () {
            expect(stripBackendPath('/secret/api/subs', '/secret')).to.equal(
                '/api/subs',
            );
            expect(stripBackendPath('/secret/', '/secret')).to.equal('/');
        });

        it('returns "/" when nothing is left after stripping', function () {
            expect(stripBackendPath('/secret', '/secret')).to.equal('/');
        });

        it('leaves non-matching paths untouched', function () {
            expect(stripBackendPath('/api/subs', '/secret')).to.equal(
                '/api/subs',
            );
            expect(stripBackendPath('/secretFOO/api', '/secret')).to.equal(
                '/secretFOO/api',
            );
            expect(stripBackendPath('/api/subs', '')).to.equal('/api/subs');
        });
    });
});
