/**
 * 测试用 Babel 配置（`npm test` 经 @babel/register 加载）。
 *
 * 与上游的差异：上游 `backend/.babelrc` 用 `babel-plugin-relative-path-import` 解析 `@/`，
 * 该插件不做平台无关的路径计算——Windows 下任何深度的文件都被改写成同一个 `./src/...`，
 * 只有 POSIX 能正常工作。这里换成 `babel-plugin-module-resolver`：测试框架
 * （mocha + chai）与 `@/` 约定保持与上游一致，仅替换解析机制，
 * Linux（CI）/ macOS / Windows 行为统一。
 *
 * 解析顺序与 `esbuild.js` 的 aliasPlugin 严格一致：
 * Workers `src/` 优先 → 回退上游 `../Sub-Store/backend/src/`，避免构建与测试两套规则漂移。
 *
 * 路径全部用 path.* 基于 __dirname 在运行时计算，不含任何平台相关字面量；
 * @babel/register 只在内存中转换，解析结果不会落盘。
 */
const fs = require('fs');
const path = require('path');

const WORKERS_SRC = path.resolve(__dirname, 'src');
const ORIGINAL_SRC = path.resolve(
    __dirname,
    '..',
    'Sub-Store',
    'backend',
    'src',
);

/** 与 esbuild.js 的 resolveFile 同逻辑：加后缀 → 原路径 → 目录 index */
function resolveFile(basePath) {
    for (const ext of ['.js', '.json']) {
        const full = basePath + ext;
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    }
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
        return basePath;
    }
    if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
        const indexPath = path.join(basePath, 'index.js');
        if (fs.existsSync(indexPath)) return indexPath;
    }
    return null;
}

module.exports = {
    presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
    plugins: [
        [
            'module-resolver',
            {
                extensions: ['.js', '.json'],
                alias: {
                    // Workers 覆盖优先，其次上游；都没有时原样返回让 Node 报错，
                    // 错误信息里能看到期望路径，便于定位
                    '^@/(.+)$': ([, relPath]) =>
                        resolveFile(path.join(WORKERS_SRC, relPath)) ||
                        resolveFile(path.join(ORIGINAL_SRC, relPath)) ||
                        path.join(WORKERS_SRC, relPath),
                },
            },
        ],
    ],
};
