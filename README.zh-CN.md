# dsh-llama-model-manager

[English](README.md) · [简体中文](README.zh-CN.md)

**免责声明：本项目在开发过程中广泛使用了 AI 辅助：大部分实现改动由 AI 辅助工作流生成，随后通过运行测试、调试和反复迭代进行验证。 在将本项目用于生产环境之前，请先仔细审查相关改动。**

一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件：在 Windows 上用
**`llama-server.exe` 运行本地 GGUF 模型**，并把它以稳定的 OpenAI 兼容接口暴露给 DSH。

它接管模型的完整生命周期——启动、停止、切换、崩溃恢复——因此 DSH 永远只面对一个固定
URL，而它背后的模型可以随时更换。

```
DSH  ──►  http://127.0.0.1:8080/v1   ──►  本插件的 Gateway
                                            │  （串行化访问、决定用哪个模型）
                                            ▼
                                         llama-server.exe  ──►  your-model.gguf
                                         http://127.0.0.1:18080
```

---

## 为什么需要它

直接把 DSH 指向 `llama-server` 也能用，直到你想**换模型**为止。那时你得停服务、改 DSH 的
provider 配置、重启，还得祈祷没有请求正在途中。这个插件把这件事变成一次点击，并处理掉那些
容易出错的部分：

| 问题 | 处理方式 |
|---|---|
| 推理途中切换模型会损坏输出 | 串行化门闸：推理持有共享票，切换需要独占票并等待在飞请求排空 |
| 停止 `llama-server` 会泄漏约 12 GB 显存 | 送达**真正的** `Ctrl+C`，由 llama.cpp 自己释放模型（`stopMethod: auto`） |
| 每次启停都闪出控制台窗口 | 一律以隐藏控制台启动（`CREATE_NO_WINDOW`） |
| DSH 崩溃后留下孤儿进程占着端口和显存 | `runtime.json` 记录 + 残留进程安全网，且只会动**能确证属于自己**的进程 |
| 端口已被别的程序占用 | 启动前预检端口，并在报错里指出占用者 |
| 不知道当前加载的是哪个模型 | 设置页：实时状态、日志、模型列表、启动/停止/切换/重启 |

---

## 环境要求

- **Windows 10/11**（插件仅支持 Windows；停止路径依赖 Win32 控制台语义）
- **Node.js ≥ 20.10**（DSH 自带；推荐 v22+）
- 带 Web UI 的 **DSH**
- 一份 **`llama-server.exe`**——[llama.cpp](https://github.com/ggml-org/llama.cpp) 官方
  release 二进制或 conda 包均可
- 一个或多个 **`.gguf`** 模型文件

无 npm 依赖，无构建步骤。

---

## 安装

```bash
dsh plugin --profile web add github:DoctorxPriestess/dsh-llama-model-manager
```

然后**重启 DSH**——profile bundles 只在启动时读取。

<details>
<summary>手动安装（当 <code>dsh plugin</code> 不可用时）</summary>

1. 把本仓库放到任意位置，例如 `D:\dsh\plugins\dsh-llama-model-manager`。
2. 链接进 profile 的 `node_modules`：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-llama-model-manager" `
     -Target "D:\dsh\plugins\dsh-llama-model-manager"
   ```

3. 在 `%USERPROFILE%\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` 末尾追加
   `"dsh-llama-model-manager"`。
4. 重启 DSH。

用 junction（而非复制）意味着改动源码后下次重启即生效。
</details>

---

## 配置

打开 **设置 → 本地模型管理**，填两样东西：

1. **llama-server 路径**——`llama-server.exe` 的完整路径。
   该 `.exe` 通常只是一个小的启动器，旁边有一个很大的 `llama-server-impl.dll`；请指向 `.exe`。
2. **至少一个模型**——模型 ID、显示名称、`.gguf` 的完整路径。

然后把 DSH 的 provider 指向本 Gateway。在 `%USERPROFILE%\.dsh\settings.yaml` 中：

```yaml
providers:
  llamacpp:
    displayName: llama.cpp 本地
    baseURL: http://127.0.0.1:8080/v1
    models:
      qwen38-iq3s:          # 与插件里配置的模型 ID 保持一致
        displayName: Qwen3.8-27B IQ3_S
```

> 插件**从不**读写 DSH 的 `settings.yaml`。那个文件完全归你。

端口：Gateway 监听 **8080**（DSH 连接它）；`llama-server` 监听 **18080**（内部端口，不暴露给
DSH）。冲突时可在设置页修改。

### 每个模型的启动参数

`arguments` 会**原样**传给 `llama-server`，追加在自动填充的 `-m / --host / --port` 之后：

```
--ctx-size 131072 -fa on -ctk q4_0 -ctv q4_0 -b 256 -ub 256 -np 1 --jinja
```

留空则只自动补 `-m`、`--host`、`--port`。

> **`-fa` 的值是*可选*的。** 请写 `-fa on`，不要裸写 `-fa`——裸写会吞掉下一个 flag
> （`-fa --no-webui` → `unknown value for --flash-attn: '--no-webui'`）。

若把 `maxConcurrentRequests` 设为大于 1，请给 llama-server 配上对应的 `-np`。

---

## 停止路径（为什么用 `Ctrl+C` 而不是 `taskkill`）

这是花最多实测才定下来的部分，值得解释。

在 Windows 上，Node 的 `child.kill('SIGINT')` **不会送达任何信号**——libuv 把它编译成
`TerminateProcess()`。它返回 `true`，而目标进程没有任何清理机会。我用一个会在进入 `SIGINT`
处理器时写日志的子进程验证过：处理器从未运行。

`taskkill /PID <pid> /T`（不带 `/F`）对控制台进程同样无效——它回答
*"This process can only be terminated forcefully"*，因为 `llama-server` 没有消息循环去接收
`WM_CLOSE`。

真正有效的是**真实控制台控制事件**：

```
AttachConsole(pid)  →  GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)
```

这要求目标进程拥有控制台，而这正是 `windowsHide: true` 提供的（libuv 会传
`CREATE_NO_WINDOW` → 一个**隐藏**控制台）。于是插件拿到了真正的 `Ctrl+C`，
**且全程不显示任何窗口**——`llama-server` 收到后会执行自己的清理并调用 `llama_model_free`。

用 27B 模型实测（`npm run e2e:ctrlc`）：

```
health ready   : 40.1 s
VRAM loaded    : 15267 MiB   (+12077)
stop result    : {"forced":false,"method":"ctrl-c","code":0}
VRAM after     :  3187 MiB   (-12080)
```

退出码干净地为 `0`，12 GB 显存归还系统，全程无窗口。

由于 Node 没有对应 API，由一个极小的 PowerShell 辅助脚本（`src/core/send-ctrlc.ps1`）完成
P/Invoke。它以隐藏方式启动，并且在该控制台**并非独占**时会**拒绝广播**——否则
`GenerateConsoleCtrlEvent(…, 0)` 会把 `Ctrl+C` 送给附着在该控制台上的**每一个**进程，
包括 DSH 自己。

升级顺序由 `stopMethod` 控制：

| `stopMethod` | 行为 |
|---|---|
| `auto`（默认） | `Ctrl+C` → 等待 `shutdownTimeoutMs` → `taskkill /T /F` |
| `ctrl-c` | 只用 `Ctrl+C`，绝不强制结束 |
| `taskkill` | 跳过 `Ctrl+C`，直接强制结束 |

最终兜底使用 **child 句柄**而非 pid，因此 PID 被复用也不会导致插件误杀无关进程。

---

## 设置项参考

| 设置 | 默认值 | 说明 |
|---|---|---|
| `llamaServerPath` | *(空)* | `llama-server.exe` 完整路径。必填。 |
| `gatewayHost` / `gatewayPort` | `127.0.0.1` / `8080` | DSH 连接的目标。 |
| `internalPort` | `18080` | `llama-server` 绑定的端口。 |
| `startupTimeoutMs` | `180000` | 27B 模型加载约需 50 秒。 |
| `shutdownTimeoutMs` | `30000` | 强制结束前的宽限期。释放 12 GB 约需 5 秒。 |
| `stopMethod` | `auto` | 见上文。 |
| `healthCheckIntervalMs` | `500` | 加载期间的健康检查间隔。 |
| `forceShutdownAfterTimeoutMs` | `300000` | 切换时等待在飞推理的上限。`0` = 一直等。 |
| `maxQueuedRequests` | `10` | 队列上限，溢出返回 HTTP 429。 |
| `maxConcurrentRequests` | `1` | `-np 1` 的模型请保持 1。 |
| `maxRetries` | `1` | 启动失败后的额外重试次数。 |
| `startupModel` | `null` | DSH 启动时预加载的模型 ID。 |
| `autoRecoverAfterCrash` | `false` | 意外退出后自动重载一次（不会无限循环）。 |
| `cleanupStaleProcessOnStart` | `false` | 清理上次运行遗留的进程（见下文）。 |
| `requireManagerToken` | `true` | 管理 API 的写操作要求 `x-llama-manager: 1` 请求头。 |

配置存放在独立文件中——`%USERPROFILE%\.dsh\llama-model-manager\config.json`，写入是原子的，
并保留上一版为 `.bak`。

---

## 管理 API

与 DSH UI 同源：`http://127.0.0.1:3080/llama-model-manager/api/...`

写操作需要请求头 `x-llama-manager: 1`（除非关闭 `requireManagerToken`）。
带非回环 `Host` 头的请求会被拒绝。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/manager/status` | 状态、当前模型、统计、最近日志 |
| `GET` | `/manager/health` | 轻量存活探测 |
| `GET` | `/manager/logs?limit=N` | 最近日志 |
| `GET` | `/manager/config` | 当前配置 + 配置路径 + 警告 |
| `PUT` | `/manager/config` | 替换配置（会做规范化和校验） |
| `POST` | `/manager/config/validate` | 只校验不应用 |
| `GET` | `/manager/models` | 列出已配置模型 |
| `POST` | `/manager/models` | 新增或更新模型 |
| `DELETE` | `/manager/models/:id` | 删除模型 |
| `POST` | `/manager/load` | 加载（或切换到）某模型 |
| `POST` | `/manager/unload` | 停止当前模型 |
| `POST` | `/manager/restart` | 重启当前（或指定）模型 |
| `POST` | `/manager/preview` | 预览将要使用的确切 argv |
| `GET`/`DELETE` | `/manager/last-error` | 读取或清除最后一次错误 |
| `GET`/`POST` | `/manager/stale-process` | 查看或清理残留进程 |
| `POST` | `/manager/scan` | 扫描目录中的 `.gguf` |
| `GET` | `/manager/runtime` | 运行时元信息 |

Gateway 同时承载 OpenAI 兼容流量（`/v1/chat/completions`、`/v1/models`、`/v1/embeddings` 等），
转发到已加载的模型。注意 `llama-server` 自身的 `/v1/models` **不是** OpenAI 格式，因此
Gateway 会**自行合成**规范的 OpenAI 响应，而不是直接透传。

---

## 残留进程

在 Windows 上，父进程死亡**不会**带走子进程。若 DSH 在模型已加载时被杀，`llama-server` 会
存活下来占着端口和显存，导致下次启动失败。

插件在模型就绪时写入 `runtime.json`（pid、镜像路径、模型、端口），干净停止时删除。启动时
检查该记录，但**只有同时满足**以下条件才会结束进程：

1. 记录的 pid 仍存活；
2. 其镜像名与记录的可执行文件一致；
3. 它在记录的端口上响应，且 `/v1/models` 报告了记录的模型路径。

被复用的 PID 不可能同时满足这三条。若无法归因，插件会明确告知并**对它不做任何操作**。

---

## 独立运行

```bash
npm start                 # 不依赖 DSH，单独跑 Gateway + 管理器
```

便于用其他客户端直接访问 Gateway。可按需传 `--port`、`--host`、`--config <path>`，
详见 `src/standalone.js`。

---

## 开发

```bash
npm test                  # 64 个单元/集成测试，约 4 秒，不需要模型
npm run preflight         # 校验注册到 DSH profile 是否正确
npm run e2e:ctrlc         # 真实模型：优雅停止 + 显存释放
npm run e2e:orphan        # 真实模型：残留进程安全门 + 清理
```

两个 e2e 脚本需要真实模型。路径从 `LLAMA_SERVER_PATH` / `LLAMA_MODEL` 解析，
未设置时回退到插件自己的配置——没有任何硬编码：

```powershell
$env:LLAMA_SERVER_PATH = 'C:\path\to\llama-server.exe'
$env:LLAMA_MODEL       = 'C:\models\your-model.gguf'
npm run e2e:ctrlc
```

`docs/ROBUSTNESS.md` 记录了开发过程中发现的**具体缺陷**及其触发条件——包括那些只在
非英文 Windows 上才会出现的问题。

### 目录结构

```
src/
  index.js            DSH 宿主插件（路由 + 生命周期）
  standalone.js       脱离 DSH 运行
  core/
    manager.js        模型生命周期、崩溃恢复、残留进程归因
    process.js        启动/停止、Ctrl+C 升级链
    gate.js           串行化门闸（共享票 vs 独占票）
    gateway.js        OpenAI 兼容反向代理
    api.js            管理 API
    args.js           命令行 tokenizer / argv 构建
    config.js         配置 schema、校验、原子保存
    health.js         就绪探测、端口检查
    send-ctrlc.ps1    Win32 控制台控制事件辅助脚本
lib/client.js         设置页（手写模块，无构建步骤）
```

---

## 常见问题

**"Gateway 未启动" / 端口被占用**——报错会指出占用进程。改 `gatewayPort`，或停掉占用者。

**模型一直不就绪**——报错会附带 `llama-server` stderr 的最后约 40 行。常见原因：`--ctx-size`
超出可用显存，或 `-ngl` 设得过高。

**错误信息里出现 `0xC0000409`**——这是 `llama-server` 自己调用了 `abort()`（通常是
`GGML_ASSERT` 或 CUDA 失败），而不是被插件停止。插件会把它报告为**崩溃**而非优雅停止，并锁定
该模型以防止无限重启。

**停止要花约 5 秒**——正常。这是 llama.cpp 在释放约 12 GB 的模型。

**设置页没有出现**——插件加载失败。检查 DSH 启动日志，并运行 `npm run preflight`。

---

## 许可

MIT——见 [LICENSE](LICENSE)。
