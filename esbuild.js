#!/usr/bin/env node
const { build } = require('esbuild');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// 路径配置
const WORKERS_SRC = path.resolve(__dirname, 'src');
const ORIGINAL_SRC = path.resolve(__dirname, '..', 'Sub-Store', 'backend', 'src');
const UPSTREAM_REPO = path.resolve(__dirname, '..', 'Sub-Store');
const UPSTREAM_SHA_FILE = path.resolve(__dirname, '.upstream-sha');

/**
 * 校验 ../Sub-Store 的实际版本与 .upstream-sha 标记是否一致。
 *
 * 这是**本地开发**的护栏：本地构建直接读 ../Sub-Store/backend/src/，没有任何闸门，
 * 上游被 git pull 到新版本后，构建会静默使用新代码而标记仍是旧的，产物无法复现。
 *
 * CI 下默认跳过：sync-upstream.yml 里 .upstream-sha 的语义是「上次同步到哪个版本」，
 * 检出的上游必然更新（否则不会触发构建），构建时不一致正是正常状态，标记要到流程
 * 最后一步才更新。若确实想在 CI 强制校验，显式传 --strict。
 *
 * 默认仅警告，传 --strict 时失败。
 */
function checkUpstreamVersion() {
    const strict = process.argv.includes('--strict');

    if (process.env.CI && !strict) {
        console.log('[upstream] CI 环境，跳过 SHA 校验（同步流程中不一致属正常）');
        return;
    }

    if (!fs.existsSync(UPSTREAM_SHA_FILE)) return;

    const expected = fs.readFileSync(UPSTREAM_SHA_FILE, 'utf8').trim();
    if (!expected) return;

    let actual;
    try {
        actual = execFileSync('git', ['-C', UPSTREAM_REPO, 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch (e) {
        // 上游不是 git 仓库（如 CI 用 tarball 展开），跳过校验
        return;
    }

    if (actual === expected) {
        console.log(`[upstream] SHA 一致: ${expected.slice(0, 8)}`);
        return;
    }

    const msg =
        `上游版本与 .upstream-sha 不一致\n` +
        `  .upstream-sha : ${expected.slice(0, 8)}\n` +
        `  ../Sub-Store  : ${actual.slice(0, 8)}\n` +
        `  产物将基于 ../Sub-Store 的实际代码构建，与标记版本不符。\n` +
        `  修正: cd ../Sub-Store && git checkout ${expected.slice(0, 8)}\n` +
        `  或更新标记: echo ${actual} > .upstream-sha`;

    if (strict) {
        console.error(`[upstream] ${msg}`);
        process.exit(1);
    }
    console.warn(`[upstream] 警告: ${msg}`);
}

/** 插件：路径别名解析 */
function resolveFile(basePath) {
    // 尝试加后缀
    for (const ext of ['.js', '.json']) {
        const full = basePath + ext;
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
            return full;
        }
    }
    // 尝试原始路径
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
        return basePath;
    }
    // 尝试目录 index
    if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
        const indexPath = path.join(basePath, 'index.js');
        if (fs.existsSync(indexPath)) {
            return indexPath;
        }
    }
    return null;
}

const aliasPlugin = {
    name: 'substore-alias',
    setup(build) {
        // 解析 @/ 导入
        build.onResolve({ filter: /^@\// }, (args) => {
            const relPath = args.path.slice(2); // strip "@/"

            // 优先 Workers 覆盖
            const workersResolved = resolveFile(path.join(WORKERS_SRC, relPath));
            if (workersResolved) return { path: workersResolved };

            // 回退到原始源码
            const originalResolved = resolveFile(path.join(ORIGINAL_SRC, relPath));
            if (originalResolved) return { path: originalResolved };

            console.warn(`[alias] Could not resolve: ${args.path}`);
            return null;
        });
    },
};

/** 插件：eval 重写 */
const evalRewritePlugin = {
    name: 'eval-rewrite',
    setup(build) {
        build.onLoad({ filter: /\.js$/ }, async (args) => {
            // 仅处理原始源码
            if (!args.path.startsWith(ORIGINAL_SRC)) return null;

            const original = fs.readFileSync(args.path, 'utf8');
            let contents = original;

            // eval(require) → require
            contents = contents.replace(
                /eval\((['"`])(require\((['"`])(.+?)\3\))\1\)/g,
                '$2',
            );

            // eval(process.env) → globalThis
            contents = contents.replace(
                /eval\((['"`])process\.env\.(\w+)\1\)/g,
                '(globalThis.__workerEnv?.$2)',
            );

            // eval(process.version)
            contents = contents.replace(
                /eval\((['"`])process\.version\1\)/g,
                '"workers"',
            );

            // eval(process.argv)
            contents = contents.replace(
                /eval\((['"`])process\.argv\1\)/g,
                '[]',
            );

            // eval(__filename)
            contents = contents.replace(
                /eval\((['"`])__filename\1\)/g,
                '"worker.js"',
            );

            // eval(__dirname)
            contents = contents.replace(
                /eval\((['"`])__dirname\1\)/g,
                '"/"',
            );

            // eval(typeof require)
            contents = contents.replace(
                /eval\((['"`])typeof require !== (['"`])undefined\2\1\)/g,
                'false',
            );

            // eval(typeof process)
            contents = contents.replace(
                /eval\((['"`])typeof process !== (['"`])undefined\2\1\)/g,
                'false',
            );

            if (args.path.endsWith(path.join('core', 'proxy-utils', 'processors', 'index.js'))) {
                contents = contents.replace(
                    /function createDynamicFunction\(name, script, \$arguments, \$options\) \{[\s\S]*?\n\}/,
                    `function createDynamicFunction(name, script, $arguments, $options) {
    const engine = globalThis.__workerEnv?.SCRIPT_ENGINE;
    if (engine === 'disabled' || engine === 'none') {
        throw new Error('Script Operator is disabled. Remove SCRIPT_ENGINE="disabled" from wrangler.toml [vars] to re-enable. Alternative: use built-in filters/operators, mihomo YAML patch, or an external trusted execution service.');
    }
    const { createScriptFunction } = require('@/vendor/quickjs-executor');
    return createScriptFunction(script, name, $arguments, $options);
}`,
                );
            }

            if (contents !== original) {
                return {
                    contents,
                    loader: 'js',
                };
            }

            return null;
        });
    },
};

/** 插件：peggy 预编译 */
const peggyPrecompilePlugin = {
    name: 'peggy-precompile',
    setup(build) {
        const peggyDir = path.join(
            ORIGINAL_SRC,
            'core',
            'proxy-utils',
            'parsers',
            'peggy',
        );

        // 拦截 peggy 文法文件
        build.onLoad(
            { filter: /parsers[\\/]peggy[\\/].*\.js$/ },
            async (args) => {
                // 仅处理原始源码
                if (!args.path.startsWith(peggyDir)) return null;

                const source = fs.readFileSync(args.path, 'utf8');

                // \u63d0\u53d6\u6587\u6cd5\u5b57\u7b26\u4e32
                const grammarMatch = source.match(
                    /const grammars\s*=\s*String\.raw`([\s\S]*?)`;/,
                );
                if (!grammarMatch) {
                    console.warn(
                        `[peggy-precompile] Could not find grammar in ${args.path}`,
                    );
                    return null;
                }

                const grammar = grammarMatch[1];

                try {
                    const peggy = require('peggy');
                    // 生成解析器源码
                    const parserSource = peggy.generate(grammar, {
                        output: 'source',
                        format: 'commonjs',
                    });

                    // 构建替代模块
                    const contents = `
let parser;
export default function getParser() {
    if (!parser) {
        parser = (function() {
            var module = { exports: {} };
            var exports = module.exports;
            ${parserSource}
            return module.exports;
        })();
    }
    return parser;
}
`;
                    console.log(
                        `[peggy-precompile] Pre-compiled: ${path.basename(args.path)}`,
                    );
                    return { contents, loader: 'js' };
                } catch (e) {
                    console.error(
                        `[peggy-precompile] Failed to compile ${path.basename(args.path)}: ${e.message}`,
                    );
                    return null; // 回退到原始处理
                }
            },
        );
    },
};

/** 插件：Node 模块存根 */
const nodeStubPlugin = {
    name: 'node-stub',
    setup(build) {
        // 存根 Node 专用模块
        const stubs = [
            'dotenv',
            'cron',
            'connect-history-api-fallback',
            'http-proxy-middleware',
            'body-parser',
            'express',
            '@maxmind/geoip2-node',
            'undici',
            'fetch-socks',
            'child_process',
            'stream/promises',
            'mime-types',
            // jsrsasign 必须存根：它在模块加载时（全局作用域）就生成随机数种子，
            // 而 Workers 禁止在全局作用域生成随机值 / 做异步 IO / 设置定时器，
            // 真实打包会导致 wrangler deploy 被服务端校验拒绝（code 10021）。
            // 代价：上游 utils/rs.js 的 generateFingerprint 不可用，节点设
            // ca-str/ca_str 时会抛错（既存问题，见 codemap 已知风险）。
            'jsrsasign',
            'fs',
            'path',
            'net',
            'tls',
            'http',
            'https',
            'os',
            'crypto',
            'dgram',
        ];

        for (const mod of stubs) {
            build.onResolve({ filter: new RegExp(`^${mod.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')}$`) }, () => {
                return { path: mod, namespace: 'node-stub' };
            });
        }

        build.onLoad({ filter: /.*/, namespace: 'node-stub' }, (args) => {
            return {
                contents: `
                    module.exports = new Proxy({}, {
                        get(target, prop) {
                            if (prop === '__esModule') return false;
                            if (prop === 'default') return target;
                            return function() {
                                console.warn('[Workers stub] ${args.path}.' + prop + ' is not available in Workers');
                                return {};
                            };
                        }
                    });
                `,
                loader: 'js',
            };
        });
    },
};

!(async () => {
    console.log('Building Sub-Store Workers...');
    console.log(`Workers source: ${WORKERS_SRC}`);
    console.log(`Original source: ${ORIGINAL_SRC}`);

    checkUpstreamVersion();

    await build({
        entryPoints: [path.join(WORKERS_SRC, 'index.js')],
        bundle: true,
        minify: true,
        sourcemap: true,
        platform: 'browser', // Workers 运行时
        format: 'esm',
        target: 'es2022',
        outfile: path.join(__dirname, 'dist', 'worker.js'),
        plugins: [aliasPlugin, peggyPrecompilePlugin, evalRewritePlugin, nodeStubPlugin],
        loader: {
            '.wasm': 'copy',
        },
        assetNames: '[name]',
        define: {
            'process.env.NODE_ENV': '"production"',
        },
        external: [],
        nodePaths: [path.resolve(__dirname, 'node_modules')],
        // Workers 包体积限制
        logLevel: 'info',
    });

    const stats = fs.statSync(path.join(__dirname, 'dist', 'worker.js'));
    console.log(`\nOutput: dist/worker.js (${(stats.size / 1024).toFixed(1)} KB)`);
    console.log('Build complete!');
})().catch((e) => {
    console.error('Build failed:', e);
    process.exit(1);
});
