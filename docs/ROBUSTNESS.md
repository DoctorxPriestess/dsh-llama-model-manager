# 鲁棒性加固记录（Robustness Hardening）

> 本文档记录 `dsh-llama-model-manager` 在实现过程中**实测发现并修复**的缺陷，
> 以及为「不误伤外部进程 / 不泄漏资源 / 不改变宿主语义」而加的约束。
> 每条都标注了触发条件与验证方式。
>
> 最后更新：2026-09-11

---

## A. 严重（会破坏宿主或泄漏资源）

### A1. CTRL+C 会广播到整个控制台 —— 可能连 DSH 一起杀掉

**问题**：`GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` 的第二个参数为 `0` 表示
「向当前控制台**所有**进程广播」，而不只是目标进程。送达方式是先
`AttachConsole(target)` 再广播。若目标进程没有自己独立的隐藏控制台（例如有人把
`windowsHide` 改成 `false`、或加了 `detached`），我们就会附着到**宿主自己的控制台**，
这一发 Ctrl+C 会打到 DSH 身上。

**修复**（`src/core/send-ctrlc.ps1`）：广播前增加**独占性安全门**——
用 `GetConsoleProcessList` 取回当前控制台上的进程列表，只有满足：

1. 列表**包含**目标 pid（确认附着到了正确的控制台），且
2. 列表长度 **≤ 2**（只有目标 + 我们自己）

才允许广播；否则以退出码 `5` 拒绝，调用方回退到定向强杀。

**代价**：若目标进程自己派生了共享控制台的子进程，会被保守拒绝 —— 失败方向是安全的
（回退强杀），不会误伤。

**验证**：`scripts/e2e-ctrlc.mjs` 加门后仍为 `method: ctrl-c`、退出码 0，未误拒。

### A2. 插件注册的 `uncaughtException` 会吞掉整个 DSH 的致命错误

**问题**：原实现在宿主插件里注册了 `process.on('uncaughtException')` 与
`unhandledRejection`。Node 的语义是：**一旦有监听器，默认的「打印堆栈并退出」就不再生效**。
实测确认 **DSH 自身没有注册任何这类监听器**，所以插件这一个注册会把宿主从
「致命错误 → 崩溃」变成「静默继续运行」，把 harness 留在未知状态。

而且它对「防孤儿」也没有必要：`process.on('exit')` 在**未捕获异常导致的退出**时同样会触发。

**修复**（`src/index.js`）：删除这两个监听器，只保留 `exit` 兜底；并在注释里写明原因。
`src/standalone.js`（独立进程，自己就是宿主）保留监听器，但改为**崩溃时以非 0 退出码退出**，
便于外部监管程序区分「崩溃」与「正常停止」。

### A3. 模型门闸在「有请求在飞时切换」会永久挂起

**问题**（`src/core/gate.js`）：`_enqueue()` 结尾只调用了 `_notify()`，**没有调用 `_drain()`**。
而独占等待者的 drain 超时计时器**恰恰是在 `_drain()` 里启动的**。结果是：入队一个独占
（模型切换）票之后，若在飞请求迟迟不结束，超时永远不会触发，切换**永久挂起**。
这就是 `npm test` 一直卡住的原因。

**修复**：`_enqueue()` 末尾改为调用 `_drain()`；等待者被 abort 移除时同样调用 `_drain()`
（移除可能解除对其他等待者的阻塞）。

**验证**：`test/unit.gate.test.js` 8/8 通过，含 `forced drain` 用例。

### A4. 残留进程清理会「谎报成功」

**问题**（`src/core/manager.js`）：`cleanupStaleProcess()` 无条件执行
`stale.cleaned = true`，**完全不看 taskkill 的结果**。若 taskkill 失败（权限不足等），
插件会报告清理成功，而端口与显存仍被占用。

另外 `_inspectStaleProcess({cleanup:true})` 在**清理成功后恒返回 `null`** —— 因为
`cleanupStaleProcess()` 会把 `this.staleProcess` 置空，而调用方紧接着 `return this.staleProcess`。

**修复**：
- 捕获 taskkill 的 `error/stdout/stderr` 作为诊断信息（`stale.cleanupNote`）；
- 清理后**实际校验**进程是否消失，只有真的消失才置 `cleaned = true`；
- 失败时抛出 `STALE_CLEANUP_FAILED` 并写入 `lastError`；在 `_inspectStaleProcess` 里
  catch 住，绝不让清理失败阻断插件启动；
- 返回清理前的快照，不再返回 `null`。

### A5. 清理成功的判定过于急躁

**问题**：taskkill 返回后立刻校验一次存活，但持有 ~12GB 显存的 llama-server 拆解需要时间，
于是**明明杀掉了却判定失败**。实测输出中该进程 2.5 秒后才消失。

**修复**：新增 `_waitForProcessGone(pid, timeoutMs)`，以 250ms 间隔**有界轮询**
（非忙等），先给 15 秒，失败再补一次不带 `/T` 的强杀并再等 10 秒。

---

## B. 进程安全（不误伤外部进程）

### B1. 兜底强杀使用 PID —— 有 PID 复用风险

**问题**：`process.kill(pid, 'SIGKILL')` 在 Windows 上按 **PID** 定位进程。
若子进程已死且 PID 已被系统复用，就会杀到一个**无关进程**。

**修复**：所有兜底路径改用 **child 句柄** `proc.child.kill('SIGKILL')` —— libuv 用它创建时
持有的进程对象定位，**不可能命中复用后的 PID**。涉及 `src/core/process.js`、
`src/index.js`、`src/standalone.js`。

**验证**：`test/unit.process.test.js` 的 *the last-resort kill uses the child handle,
never a bare pid* —— 该用例会拦截 `process.kill` 并在被调用时失败。

### B2. 残留进程归因（已有设计，已实测）

只有**同时**满足以下条件才会动手：

1. 记录的 pid 仍存活；
2. 其镜像名与记录的可执行文件名一致；
3. 该 pid 在记录的端口上，`/v1/models` 确实包含记录的模型路径。

PID 复用几乎不可能同时满足 2 与 3。

**验证**：`test/unit.stale.test.js`
- 归因成功 → 确实被杀；
- 模型路径不匹配（**这正是 PID 复用的样子**）→ **拒绝动手，进程存活**；
- pid 已不存在 → 只清记录，不做任何操作。

---

## C. 并发与资源

| # | 问题 | 修复 |
|---|---|---|
| C1 | 并发 `stop()`（如 `shutdown()` 与模型切换同时发生）会发出两次 CTRL+C + 两次 taskkill | `stop()` 记录 in-flight promise，后续调用**加入同一次操作** |
| C2 | `_sendCtrlC` 的完成路径可能被 settle 多次（timeout / error / close 竞态） | 加 `settled` 守卫，统一走 `finish()` |
| C3 | PowerShell 缺失时，每次模型切换都要白等一次 spawn 失败 | ENOENT 时把该 shell 加入黑名单，自动换下一个候选 |
| C4 | 辅助脚本输出在非英文 Windows 上是 GBK，Node 按 UTF-8 解码会乱码 | 辅助脚本内设 `[Console]::OutputEncoding = UTF8` |
| C5 | `execFile('taskkill', ...)` 未传 `windowsHide`（默认 `false`）会**闪出控制台窗口** | 补 `windowsHide: true`（已核对全项目所有 `spawn`/`execFile` 调用点） |
| C6 | `taskkill` 的中文输出按 UTF-8 解码成替换字符，设置页里显示为乱码 | 以 `encoding:'buffer'` 捕获，先试 UTF-8；若出现替换字符再用 `gbk`/`gb18030` 解码（`decodeConsoleOutput`）。DSH/Node 无内置编码时才回退 UTF-8 |

---

## D. 编码/环境陷阱

### D1. `tasklist` 的「无此进程」提示是**本地化**的

本机为中文区域，查询不存在的 PID 时输出：

```
信息: 没有运行的任务匹配指定标准。
```

**不以英文 `INFO:` 开头**。任何「用 `INFO:` 前缀判定进程不存在」的写法在中文 Windows 上
会把**每一个已死 PID 都判为存活**。

生产代码（`manager.js`）本来就用正则 `^"([^"]+)"` 判定（真实进程行必为 `"<镜像名>","<pid>",…`），
**与语言环境无关**。但我的两个测试助手用了 `INFO:` 前缀，导致误报 —— 已统一改为同一套正则逻辑
（`manager._queryImageName`、测试助手、e2e 脚本三处一致）。

### D2. `-fa` 是**可选取值**参数

裸写 `-fa` 会吞掉下一个 flag：

```
error while handling argument "-fa": unknown value for --flash-attn: '--no-webui'
```

插件自身的示例、设置页 placeholder、测试数据都已写成 `-fa on`（无此 bug）；用户自定义参数
若裸写 `-fa`，会把 llama-server 的原始报错如实呈现。

---

## E. 事件循环语义

### E1. `unref()` 掉一个 deadline，`await` 会**永远丢失**

这是 CI 在 **Node 20/22 失败、Node 24 通过**的根因。

```js
// 反面写法
const timer = setTimeout(() => resolve(false), ms);
timer.unref();                 // “别让这个定时器维持进程存活”
const result = await race;     // 但 race 的唯一结算者就是它
```

`unref()` 之后，若事件循环上没有别的句柄撑着，Node 判定「无事可做」→ **直接排空循环** →
定时器永不触发 → `await` 永不返回。顶层 await 的进程以 **退出码 13** 结束：

```
Warning: Detected unsettled top-level await at ...:54
```

在 `node --test` 下则报成：

```
Promise resolution is still pending but the event loop has already resolved
failureType: 'cancelledByParent'
```

**为什么只在 20/22 上炸**：那两版的 test runner 跑用例时不会额外持有事件循环句柄，循环真的
被排空；Node 24 的 runner 恰好拿着一个句柄，把缺陷掩盖了。所以这是**真实的代码缺陷**，
不是测试环境问题 —— 同样的写法在生产里遇到「除这个 deadline 外没有别的活」的时刻就会挂死。

**判据**：一个定时器的触发如果是某个被 `await` 的 promise 的**唯一**结算者，就绝不能
`unref()`。`unref()` 只适用于「可选的、丢了也不影响正确性」的后台清理。

修复点（全部改为不 `unref`，并确保在正常路径上 `clearTimeout`）：

| 位置 | 该 deadline 的作用 |
|---|---|
| `gate.js` `drainTimer` | 在飞请求永不结束时，唯一能放行排队的独占切换者 |
| `process.js` `_raceExit` | `stop()` / `killNow()` 等待进程退出的超时臂 |
| `process.js` `_sendCtrlC` | CTRL+C 辅助进程卡死时的兜底 deadline |
| `gateway.js` proxy timeout | 上游卡死时中止请求的 deadline |
| `health.js` 端口探测 | `listen()` 不回话时结算探测的 deadline（并补上原先缺失的 `clearTimeout`） |
| `test/unit.process.test.js` `FakeChild.exitAfter` | `stop()` 所等待的进程退出事件 |

**回归防线**：`test/unit.eventloop.test.js` 把验证放进一个**子进程**，该子进程只 await
两个 deadline、别的什么都不做 —— 这样 runner 再也无法「顺手」撑住事件循环。修复前该子进程
退出码 13，修复后退出 0。同文件还有一条源码级检查：禁止 `src/` 出现白名单外的 `unref()`。

> 一般化：**测试通过不等于代码正确**。单元测试若通过只是因为「runner 恰好替我撑住了事件
> 循环」，那它验证的是 runner 的行为，不是代码的行为。凡是「必须发生才会继续」的时序，
> 都应在不受 runner 影响的进程里验证。

---

## F. 回归防线

| 测试 | 用例数 | 覆盖 |
|---|---|---|
| `test/unit.args.test.js` | 23 | 命令行 tokenizer、自动填充、冲突检测 |
| `test/unit.config.test.js` | 16 | 配置规范化、损坏配置降级 |
| `test/unit.process.test.js` | 12 | 停止升级链、并发序列化、句柄兜底、崩溃码识别 |
| `test/unit.gate.test.js` | 8 | 门闸串行化、drain 超时、队列上限、abort |
| `test/unit.stale.test.js` | 5 | 归因安全门、清理校验、死 pid 处理 |
| `test/unit.eventloop.test.js` | 2 | 子进程 deadline 存活 + `unref()` 白名单（见 E1） |
| `scripts/e2e-ctrlc.mjs` | — | **真实 27B 模型**的 CTRL+C 优雅停止 + 显存释放 |
| `scripts/e2e-orphan-recovery.mjs` | — | **真实 27B 模型**的残留进程安全门 + 清理 |

合计 **66 个单测**（约 3.5 秒），加两个需要真实模型的端到端脚本。
