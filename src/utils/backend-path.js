/**
 * 后端路径前缀（SUB_STORE_FRONTEND_BACKEND_PATH）处理。
 *
 * 抽成独立纯函数模块的原因：`src/index.js` 在模块加载时就注册全部路由（有副作用），
 * 测试无法只引入它的路径逻辑；这里保持零依赖、零副作用，可被单测直接引入。
 *
 * 与上游的关系：上游 2.38.x 起 `SUB_STORE_FRONTEND_BACKEND_PATH` 允许设为 `/`，并
 * 导出了 `matchesBackendPath` / `stripBackendPath`（见 `backend/src/restful/index.js`）。
 * 本模块沿用上游对 `/` 的**语义**，但不复用其实现——上游在前缀非 `/` 时用
 * `path.startsWith(backendPath)`，会让 `/secretFOO/...` 通过 `/secret` 的校验并被剥离成
 * `FOO/...`；Workers 侧要求前缀后必须紧跟 `/`（或完全相等），鉴权边界更严，故保留。
 */

/**
 * 归一化前缀配置，把「等价于不设前缀」的几种写法统一成空串。
 *
 * 归一化为 '' 后，调用方的 `if (backendPath)` 分支自然按「未设置」处理：
 * 不要求前缀、管理 API 公开，并照常发出安全告警。
 *
 * 处理以下会导致部署被锁死的配置（归一化前，管理 API 全部返回 401 且无任何入口）：
 *   - `/`        上游语义为「后端挂根路径、不要求前缀」
 *   - `/secret/` 结尾多余斜杠导致 `startsWith('/secret/' + '/')` 永不匹配
 *   - `secret`   缺少前导斜杠，与 pathname 永不相等
 *
 * @param {unknown} raw - 环境变量原始值
 * @returns {string} 归一化后的前缀，`''` 表示不要求前缀
 */
export function normalizeBackendPath(raw) {
    if (typeof raw !== 'string') return '';

    const trimmed = raw.trim();
    if (!trimmed) return '';

    // 去掉结尾斜杠；纯 '/' 或 '///' 会在此变成空串
    const withoutTrailing = trimmed.replace(/\/+$/, '');
    if (!withoutTrailing) return '';

    // 补上前导斜杠，避免 'secret' 这类写法与 pathname 永不相等
    return withoutTrailing.startsWith('/')
        ? withoutTrailing
        : `/${withoutTrailing}`;
}

/**
 * 判断 pathname 是否带了正确的前缀。
 *
 * 严格匹配：必须完全相等，或前缀后紧跟 `/`。
 *
 * @param {string} pathname
 * @param {string} backendPath - 已归一化的前缀
 * @returns {boolean}
 */
export function matchesBackendPath(pathname, backendPath) {
    if (!backendPath) return false;
    return (
        pathname === backendPath || pathname.startsWith(`${backendPath}/`)
    );
}

/**
 * 剥离前缀，返回交给路由的 pathname。
 *
 * @param {string} pathname
 * @param {string} backendPath - 已归一化的前缀
 * @returns {string} 剥离后的 pathname，始终以 `/` 开头
 */
export function stripBackendPath(pathname, backendPath) {
    if (!matchesBackendPath(pathname, backendPath)) return pathname;
    return pathname.slice(backendPath.length) || '/';
}
