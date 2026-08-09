# pi-kimi-webbridge-bootstrap

[English](./README.md)

面向 Pi 的轻量级 [Kimi WebBridge](https://www.kimi.com/) 安装与更新代理。负责把官方 daemon 和 Pi skill 装好、对齐，不依赖 Kimi Code。

它本身不做浏览器操控。真正的控制能力在官方 WebBridge skill 里；本包装的是安装、校验、更新和发现。

不内置 Moonshot AI 的专有 skill 或运行时，元数据、二进制和 skill 都从官方 CDN 拉取：`https://cdn.kimi.com/webbridge`。

## 能做什么

- 缺 CLI 时，按平台装到 `~/.kimi-webbridge/bin/`
- 新二进制对照官方 `latest/version.json` 做 SHA-256 校验
- CLI 挂了会尝试修复；激活失败则回滚到旧版本
- daemon 没起来就帮你拉起
- Pi 启动 / reload / 新会话时，大约每 6 小时检查一次更新
- 已有运行时走官方 CLI 的 `upgrade`，沿用它的版本匹配、回滚和重启逻辑
- 按当前 daemon 版本下载对应 skill，放进 Pi 缓存，经 `resources_discover` 暴露
- 新 skill 过完路径、条目类型、解压大小、frontmatter/版本校验后，再原子切换指针；失败时旧 skill 继续可用
- 首次引导若检测不到浏览器扩展连接，会提示安装扩展

定时检查是会话触发的，不会装 cron 或 launch agent。已有缓存 skill 时，检查在后台跑，CDN 慢或挂了不会拖住 Pi 的资源发现。skill 变了会在更新完成后让 Pi 重新加载资源。

## 环境要求

- 支持 package 和 `resources_discover` 的 Pi（测过 `0.84.1`）
- Node.js 20+
- macOS 或 Linux，arm64 / x64  
  Windows 元数据能识别，但 skill 解压依赖兼容的 `tar`，本项目未完整验证
- 真正控浏览器需要 [Kimi WebBridge 浏览器扩展](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc)

## 安装

从 npm：

```bash
pi install npm:@specode/pi-kimi-webbridge-bootstrap
```

从 git：

```bash
pi install git:github.com/specode/pi-kimi-webbridge-bootstrap
```

本地目录：

```bash
pi install /absolute/path/to/pi-kimi-webbridge-bootstrap
```

装完后执行 `/reload`。首次会话可能稍慢，因为要下载 CLI 和 skill。

如果希望 `pi update --extensions` 也能更新本 bootstrap 包本身，不要把 git 源钉死在某个 tag 或 commit 上。

### 浏览器扩展

CLI 和 skill 可以自动装；Chrome / Edge 的扩展需要你自己点确认。

1. 安装 [Chrome 网上应用店里的 Kimi WebBridge](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc)
2. 确认扩展已启用
3. 在 Pi 里跑 `/webbridge-status`，看 `Browser extension` 是否为 `connected`

首次引导检测不到扩展时会自动给出链接。随时可用 `/webbridge-setup` 再看一遍说明。

## 命令

```text
/webbridge-status   # daemon、扩展、skill 缓存、上次更新错误
/webbridge-setup    # 扩展安装引导，或确认已连接
/webbridge-update   # 强制检查发布并刷新 Pi skill，然后 reload 资源
```

## 配置

- `PI_WEBBRIDGE_AUTO_UPDATE=0`：关掉自动安装和定时检查；手动命令仍可用
- `PI_WEBBRIDGE_UPDATE_INTERVAL_HOURS=<数字>`：改默认 6 小时间隔

检查失败后，大约 15 分钟才会在后续会话事件里再次尝试。跨进程锁在 `~/.kimi-webbridge/pi-bootstrap-update.lock`，避免不同 agent 目录的 Pi 会话同时改共享运行时；只有持有锁的进程已经不在了，才会回收陈旧锁。

## 更新边界

WebBridge daemon 是用户级全局的。官方 `kimi-webbridge upgrade` 可能顺带刷新其他 agent 运行时里已装的 WebBridge skill，并会短暂重启 daemon。自动检查发生在会话开始、浏览器任务之前，但别的程序如果也在用这个 daemon，仍可能观察到这次重启。

Pi 侧 active skill 靠原子缓存指针切换：

```text
~/.pi/agent/cache/pi-kimi-webbridge-bootstrap/skills/active.json
~/.pi/agent/cache/pi-kimi-webbridge-bootstrap/skills/current -> releases/<version>-<archive-sha256>/
~/.pi/agent/cache/pi-kimi-webbridge-bootstrap/skills/releases/<version>-<archive-sha256>/
```

macOS / Linux 上 Pi 发现的是稳定路径 `skills/current`，校验通过后原子替换链接目标。Windows 上目录 junction 不能原子替换，所以用 `active.json` 原子选出不可变 release，更新后 Pi 再加载该路径。旧的已校验 release 会留着，方便回滚。迁移期间，遗留的 `skills/kimi-webbridge/` 目录仍可作为回退。

若配置了 `PI_CODING_AGENT_DIR`，会用 Pi 解析后的 agent 目录。

## 开发检查

```bash
npm test
npm run check
```

## 许可证

MIT
