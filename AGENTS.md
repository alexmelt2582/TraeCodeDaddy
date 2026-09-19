# TraeCode CN 增强助手（AGENTS.md）

## 定位
本地多账号增强助手，控制 `Trae CN`（TraeCode CN）IDE：无感登录/假退出、多账号切换、自动签到、登录保活、注入侧边面板。与 `d:\Me\副业\Trae多账号协同`（TRAE SOLO CN 增强助手）为姊妹项目，共享大部分代码，产品标识与端口不同。

## 怎么跑
- 依赖：Node.js 22+；构建 esbuild + postject（SEA 单文件）。
- 验证：`npm test`（node --test，265 用例）；`npm run check`（语法检查，自动扫 src/ scripts/）。
- 构建：`npm run build:exe`（便携单文件）；`npm run build:installer`（Inno 安装包，输出 dist\installer）。
- 注入链路：`scripts\launch-hidden.vbs`（隐藏启动）或 `node src/launcher.js`；后台 `node src/daemon.js`；CLI `node scripts\service.js {start|daemon|stop|restart|status|locate|configure|net|install|uninstall|logs|tray}`。

## 技术栈
Node 22 ESM；CDP 注入渲染进程；面板与 daemon 走 WebSocket（Trae CN workbench CSP 只放行 ws:）；OAuth PKCE + 设备公钥绑定（ExchangeToken）；SEA 单文件 + Inno 安装。

## 目录与约定
- `src/lib/`：核心库（oauth/refresh/product/storage/checkin/keepalive/settings 等）；`src/ui/inject.js`：注入面板；`scripts/`：CLI 与构建；`test/`：node --test。
- `data/`、`logs/`、`dist/`、`node_modules/` 为本地状态，不入库（见 .gitignore）。
- Git 元数据在 `.git-meta`：`git --git-dir=.git-meta --work-tree=. ...`。
- 端口：UI 47836、CDP 9336（与 SOLO 助手的 47835/9335 错开，勿改回）。
- 环境变量命名空间：`TRAECODE_ENHANCER_`；AppId `BB144F88-F2C9-4DBC-AE6B-BD489F0D0A35`。

## 硬约束（踩过的坑）
- 无感登录必须用 `auth_from=trae` + 真实 storage 设备身份（deviceId/machineId 与交换一致），不要换随机设备；PlatformCode 用 `IDE_PC`。否则 api.trae.com.cn 返回 401/20403。
- Trae CN 面板 CSP 禁 http，面板通信必须 ws://。
- crypto.randomInt 上限 2^48，deviceId 用 Number 运算生成。
- 直接双击 Trae CN.exe 不带 CDP，面板不注入；注入必须走 launch-hidden.vbs / start 入口。
- CDP 端口复用前先验证归属（trae-process.isTraeCdpManagedBy），避免注错环境变量。

## 当前状态
1.0.0 已构建并安装（D:\ProgramFiles\TraeCode\），无感登录 20403 已修复并端到端验证（账号已落盘）；265/265 测试通过；首次提交 ac09b13。
下一步：注册登录自启动（autostart 目前 absent），可选把 Trae CN 一并设为开机自启。
