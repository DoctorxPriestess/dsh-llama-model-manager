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

### A6. 注册信号监听器会**拿掉用户的逃生通道**

**问题**：插件为 `SIGINT/SIGTERM/SIGHUP/SIGBREAK` 都注册了监听器。Node 的语义是
**只要装了第一个监听器，该信号的「默认终止进程」行为就被移除**。所以：

- `SIGINT/SIGTERM`：DSH 自己已经装了（`profile-boot` 的 `interrupt()` → 销毁 fiber），
  默认行为早就没了，插件再装一个**不改变任何终止语义**。
- `SIGHUP/SIGBREAK`：**DSH 没有装**。插件装上去就等于把 Ctrl+Break（以及关闭控制台窗口）
  的终止能力**静默取消** —— 用户想强制结束 DSH 时会发现它死活不退。

这与 A2（`uncaughtException` 吞掉宿主致命错误）是同一类错误：**插件不该改变宿主级行为**。

**实测**（隐藏控制台 + `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT)`，与真实 llama-server 同款启动方式）：

| 子进程 | CTRL_BREAK_EVENT 之后 | 退出码 |
|---|---|---|
| 无监听器 | **被终止** | `3221225786` = `0xC000013A` (`STATUS_CONTROL_C_EXIT`) |
| 装了 `SIGBREAK` 监听器 | 处理器触发，但**进程存活**（只能 SIGKILL） | — |

**修复**：两组分开处理。`SIGINT/SIGTERM` 保持（只为尽早释放显存，语义上无副作用）；
`SIGHUP/SIGBREAK` 在停掉子进程后**复现系统本该执行的退出**。

复现方式也做了实测：`process.kill(pid, 'SIGBREAK')` 在 Windows 上抛 **`ENOSYS`**
（无法重新触发信号），而 `process.exit(0xC000013A)` 让父进程观察到的退出码正是
`3221225786` —— 与系统终止完全一致。

> 局限：这条路径**没有自动化测试**。Windows 上无法给自己投递 `SIGBREAK`
> （`ENOSYS`），所以只能在子进程 + 外部 `GenerateConsoleCtrlEvent` 的组合里验证，
> 上面的表格就是那次验证的结果。

### A7. 把子进程的 `error` 原样重发，会把整个 DSH 带走

**问题**：`start()` 里写了

```js
child.once('error', (error) => { this.emit('error', error); });
```

而 `LlamaServerProcess` 是 EventEmitter，且**全项目没有任何地方**监听它的 `'error'`。Node 的
语义是：**`'error'` 事件没有监听者时直接抛出**。抛点在 libuv 回调里 → 未捕获异常 → 而本插件
**故意不装** `uncaughtException`（见 A2）→ **DSH 整个进程退出**。

触发条件：`spawn` 之后的**异步**启动失败 —— 预检 `isExistingFile()` 与 `proc.start()` 之间 exe
被改名/删除（TOCTOU）、被杀软/EDR 锁定（`EPERM/EACCES`）、镜像位数不对等。`spawn` 对 ENOENT
不抛同步异常，只发 `'error'`，所以调用处的 `try/catch` 接不住。附带损害：同一次 `emit` 的后续
监听器不再执行，原本要做的「标记 exited / 结算退出等待者」也被跳过。

**实测**：修复前该断言报 `Got unwanted exception: must not throw ERR_UNHANDLED_ERROR`。

**修复**：记录为 `proc.spawnError` 并写入 stderr 尾巴（否则启动失败只报 `exit code -1`，没有
原因），只在**确实有监听者**时才重发。

### A8. 停止失败被报成「已停止」，并销毁唯一的孤儿记录

**问题**：`stop()` 在配置方法无法结束进程时返回 `{exited:false}` —— 尤其是
`stopMethod:'ctrl-c'`（该模式**按设计从不强杀**，测试里正是断言 `exited === false`）。
但 `_stopCurrent()` 不看这个字段，照样：

```js
if (this.current === entry) this.current = null;
this._clearRuntimeState();     // ← 删掉 runtime.json
this.setState(STATE.STOPPED);  // ← 声称已停
```

而进程还在跑，占着 ~12GB 显存和内部端口。**最严重的连带后果是删记录**：启动时的残留清理
安全网靠 `runtime.json` 定位进程，记录一删就再也找不到它；同时 `index.js` 的退出兜底读的是
`manager.current?.proc`，已为 `null`，于是 DSH 退出后进程无人清理。

**修复**：区分两种语义。
- 用户主动 unload/switch：**不越权强杀**（用户把 stopMethod 设成 `ctrl-c` 就是明确要求不要强杀），
  但如实抛出 `STOP_FAILED`，并**保留** `current` 与 `runtime.json`。
- `shutdown()`：这里确实要退出，留孤儿更糟，所以升级为强杀；**只有连强杀都失败**时才保留记录，
  交给下次启动的残留清理。

### A9. 客户端断开 → 共享票永久泄漏 → 网关从此不再服务任何请求

**问题**：`_handleProxy` 取排他票时**没有传 signal**，而断开桥接挂在 `await` **之后**：

```js
const acquired = await this.manager.acquireForRequest(requestedModel, { reason });  // ← 没 signal
...
res.on('close', () => { if (!res.writableEnded) abortUpstream(); });                 // ← 挂晚了
```

客户端在排队期间（排在别的请求后面，或排在 40-50 秒的模型加载后面）断开时，`close` **早已触发**，
晚挂的监听器永不执行 → `abortUpstream()` 永不调用 → 最终 `finally { release(); }` 也不执行。
默认 `maxConcurrentRequests: 1` 下 `_activeReaders` 永远 ≥ 1，于是**任何推理票都无法再被授予**：
之后每个请求都排队直到超时，直到插件重启为止。

即便 `res` 已销毁，`stream.pipe(res)` 也不会再产生 `close`/`finish`，所以那个 await 永久悬挂。

**修复**：三条一起做 —— 桥接移到 acquire **之前**、把 signal 传进 acquire、流式 await 同时以
**源流的 `close`/`error`** 结算，并在 acquire 返回后补一道 `res.destroyed || signal.aborted`
检查直接归还票。

### A10. 压缩响应被按「已解压的实体 + 压缩的头部」转发

**问题**：`fetch`（undici）会**透明解压** gzip/deflate/br，但 `content-encoding` 与原始
`content-length` 仍留在 `response.headers` 里。原样复制给客户端，等于把一个 5000 字节明文
描述成「40 字节、gzip」—— 客户端按 zlib 解压明文，直接报错。

**修复**：上游请求显式要 `accept-encoding: identity`（这一跳是回环，压缩没有意义），并在转发
响应时丢弃 `content-encoding` 与 `content-length`，让 Node 自己重新定帧（chunked）。

> 一般化：**代理不等于透传**。只要中间任何一层会改写实体（解压、重编码、流式化），
> 那么描述实体的头部就不再成立，必须由改写者重新生成。

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
| `gateway.js` `close()` 兜底 | 还有 keep-alive 连接时，唯一能结算关停 promise 的 deadline |
| `health.js` 端口探测 | `listen()` 不回话时结算探测的 deadline（并补上原先缺失的 `clearTimeout`） |
| `test/unit.process.test.js` `FakeChild.exitAfter` | `stop()` 所等待的进程退出事件 |

**回归防线**：`test/unit.eventloop.test.js` 把验证放进一个**子进程**，该子进程只 await
两个 deadline、别的什么都不做 —— 这样 runner 再也无法「顺手」撑住事件循环。修复前该子进程
退出码 13，修复后退出 0。同文件还有一条源码级检查：禁止 `src/` 出现白名单外的 `unref`。

> 该检查第一版用 `\.unref\(\)` 匹配，**漏掉了 `.unref?.()`**（可选调用写法，语义完全相同），
> 于是它一边报「通过」、一边放过了 `gateway.js` 里真实存在的那一处。已改为 `\.unref\b`。
> 教训：**守卫本身也要被验证** —— 一条永远通过的断言比没有断言更危险。

> 一般化：**测试通过不等于代码正确**。单元测试若通过只是因为「runner 恰好替我撑住了事件
> 循环」，那它验证的是 runner 的行为，不是代码的行为。凡是「必须发生才会继续」的时序，
> 都应在不受 runner 影响的进程里验证。

---

## F. 回归防线

| 测试 | 用例数 | 覆盖 |
|---|---|---|
| `test/unit.args.test.js` | 23 | 命令行 tokenizer、自动填充、冲突检测 |
| `test/unit.config.test.js` | 16 | 配置规范化、损坏配置降级 |
| `test/unit.process.test.js` | 15 | 停止升级链、并发序列化、句柄兜底、崩溃码、`error` 事件不抛出、`waitForExit` 必结算 |
| `test/unit.gate.test.js` | 8 | 门闸串行化、drain 超时、队列上限、abort |
| `test/unit.stale.test.js` | 5 | 归因安全门、清理校验、死 pid 处理 |
| `test/unit.stop.test.js` | 5 | 停止结果的 `exited` 契约（见 A8） |
| `test/unit.gateway.test.js` | 2 | 压缩响应转发、客户端断开的票归还（见 C7/D3） |
| `test/unit.eventloop.test.js` | 2 | 子进程 deadline 存活 + `unref()` 白名单（见 E1） |
| `scripts/e2e-ctrlc.mjs` | — | **真实 27B 模型**的 CTRL+C 优雅停止 + 显存释放 |
| `scripts/e2e-orphan-recovery.mjs` | — | **真实 27B 模型**的残留进程安全门 + 清理 |

合计 **76 个单测**（约 3.5 秒），加两个需要真实模型的端到端脚本。

> 每个新回归测试都做过**反向验证**：把对应修复 `git stash` 掉再跑，确认它真的会失败
> （例如 A7 的测试在修复前报 `Got unwanted exception: must not throw ERR_UNHANDLED_ERROR`，
> A8 报 `Missing expected rejection`，C7 报 `the ticket must be handed back exactly once`）。
> **一条永远通过的断言比没有断言更危险。**

完整的三轮只读复审发现（含尚未修复项及其严重级别）记录在
[`KNOWN-ISSUES.md`](KNOWN-ISSUES.md)。
