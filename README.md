# dsh-session-cycle

会话轮换插件：上下文到阈值 → 让会话写一份交接 → 换新会话 → 把其它插件里写死的会话 id 一起指过去 → 旧会话改名加日期、归档。

## 它做什么

DSH 的会话只增不减，聊久了每轮都要重读全部历史。压缩只能折掉中间一段，最近那段压不掉；这个插件用「换一页」的方式把上下文归零，同时保留交接。

一次轮换的完整流程：

1. 当前会话的下一条回复结束时，若 `usage.totalTokens ≥ 上下文窗口 × 阈值`，注入一段交接提示；
2. 会话把交接正文用 `<<<HANDOFF>>> … <<<END>>>` 包着回复出来（提示词可自己改，格式要求由插件自动追加）；
3. 插件抓到正文后：
   - 新建一个会话（挂 `standard` 预设、接进同一个工作区）；
   - 旧会话题名改成 `<原标题> MM-DD`；
   - 新会话继承原标题；
   - 归档旧会话；
   - 按「配置文件」清单，把里面等于旧会话 id 的字符串递归替换成新会话 id；
   - 把交接正文注入新会话。

## 安装

```powershell
dsh plugin --profile desktop add dsh-session-cycle
```

或手动：放进 `$DSH_HOME/profiles/<profile>/node_modules/`，并在该 profile 的 `package.json` 里同时加入 `dependencies` 与 `dsh.profile.bundles`，然后重启 DSH。

装完检查 `$DSH_HOME/logs/session-cycle.log`，应该有一行：

```
[...] mounted v0.6.4; current=<会话 id> threshold=... bindings=2 archive=true
```

## 设置页

设置 → 会话轮换：

- **会话更换阈值**：百分比，到 `上下文窗口 × 阈值` 时轮换；
- **生效范围**：列出未归档、有内容的会话，每个一个按钮；**点选只改本地高亮，点「保存」才生效**；一个都不选 = **完全不生效**；运行中新建的会话要点「刷新列表」才会出现；
- **空闲轮换**：开启时只在会话空闲（`idle`）才触发，忙/跑任务时跳过；
- **归档会话删除条件**：保留天数、空间上限（MB）、已归档会话保留数；**时间与空间都满足才删**，只超空间只提示；
- **配置文件（会话 id 挂接）**：「新增文件」打开系统文件选择框，选中的 json 会参与 id 替换；
- **交接提示词**：整段可改；末尾的固定格式要求由插件自动追加，页面不显示。

## 配置

`$DSH_HOME/session-cycle.json`（设置页保存的就是它）：

```json
{
  "enabled": true,
  "workspace": "",
  "currentSessionId": "",
  "contextWindow": 1048576,
  "thresholdRatio": 0.6,
  "cooldownMinutes": 30,
  "provider": "deepseek-account",
  "model": "deepseek-flash",
  "pendingTimeoutMinutes": 15,
  "archiveOld": true,
  "onlyWhenIdle": true,
  "watchSessionIds": [],
  "handoffHeader": "上下文快满了，帮我把这段时间整理成交接备忘。",
  "cleanup": {
    "enabled": true,
    "keepDays": 30,
    "totalSizeMB": 2000,
    "checkMinutes": 60,
    "keepRecent": 3
  },
  "bindings": []
}
```

- `contextWindow`：按你用的模型填（默认 1M）。阈值 = `contextWindow × thresholdRatio`；
- `currentSessionId`：只盯一个会话时填它的 id；也可以用 `bindings` 里的映射文件自动解析（旧字段 `peerKey` 仍兼容）；
- `watchSessionIds`：要监控的会话 id 列表；留空 = 不生效。设置页点选的就是它；
- `onlyWhenIdle`：只在会话空闲时触发，默认 `true`；
- `bindings`：相对 `$DSH_HOME` 的路径，或绝对路径；每项必须是 JSON，里面任何**字符串值**等于旧会话 id 都会被替换（写前留 `.bak-cycle-*`）；
- `handoffHeader`：交接提示词的可编辑部分；
- `cleanup`：只清理本插件轮换下来、列在历史里的旧会话；最近 `keepRecent` 个永不删，当前会话永不删。

## 工具

- `session_recall({ sessionId?, limit? })`：读旧会话的对话原文（`sessions` 与 `archived-sessions` 都会找）。不传 id 读最近一次轮换掉的会话；
- `session_cycle({ action: "status" | "rotate" })`：看阈值、当前会话、bindings、清理状态；`rotate` 立刻走一次轮换。

## 注意事项

- **不依赖记忆插件**：交接只是「注入文本」。如果装了记忆插件，可以在提示词里补一句让它把交接写进记忆；
- 自带的「固定格式要求」不可在设置页查看/修改，避免被改坏导致抓不到正文；
- 轮换频率越高，单页越便宜，但交接开销占比也越高；一般 30%–60% 比较平衡；
- 旧会话归档后仍可用 `session_recall` 读；只有清理逻辑真的删除文件后才会读不到；
- 插件改的是其它插件的配置文件，改前会留 `.bak-cycle-*`，出问题可以据此回滚；
- 设置页的会话列表按需加载（可能几秒，取决于会话文件大小），解析结果按文件 mtime+size 缓存；运行中新增会话请点「刷新列表」。
