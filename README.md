# dsh-away-mode

在 DSH Web 输入框下方增加「离开模式」选择器：

| 选项 | `ask_user_question` 被调用时 | 计划审阅（`exit_plan_mode`） | 审批请求（`approval/request`） |
| --- | --- | --- | --- |
| 关 | 不介入，问题照常显示。 | 不介入，审阅面板照常显示。 | 不介入，审批照常显示。 |
| 自行选择 | 自动返回：`用户忙，请根据用户需求选择。` | 自动返回同一文案；计划模式判为「Keep planning」，文案作为反馈，**不会批准计划**。 | 返回 `unavailable`，操作按 fail-closed 处理。 |
| 暂停任务 | 自动返回：`用户忙，请暂停当前任务或推进无需用户选择的部分。` | 自动返回同一暂停文案；同样判为「Keep planning」，**不会批准计划**。 | 返回 `unavailable`，操作按 fail-closed 处理。 |

自动答复挂在 Host 的 `user-questions/request` waterfall 上，因此 agent 收到的是正常的
`ask_user_question` 答案（`answers[].custom`），问题也不会在页面上弹出。

## 计划模式（`exit_plan_mode`）

`exit_plan_mode` 通过同一个 `user-questions/request` 通道请求审阅，问题是
`id: 'plan-review'`、`intent.kind: 'plan-review'`、选项为 `Approve` / `Keep planning`。
离开模式按「纯文字答复」处理，与 `ask_user_question` 一致：

- plan-mode 只把 `selected: ['Approve']`（且没有 `custom`）当作批准；因此离开模式
  返回的纯文字会被判为 **Keep planning**，文案原样作为反馈交回模型。
- 也就是说，**离开模式下计划永远不会被自动批准**；模型可能据此修订计划并再次提交，
  每次都会被同样自动答复。用户回来后可自行审阅离开模式期间产生的计划。

审批请求挂在同一 Host 的 `approval/request` waterfall 上。离开模式不会代替用户批准
高风险操作，而是返回 `unavailable`（没有可用的审批人），让调用方 fail-closed；审批
面板也不会在页面上弹出。

## 状态与接口

- 状态是全局的，保存在 `$DSH_HOME/away-mode.json`（默认 `~/.dsh/away-mode.json`）。
- 页面通过同源、仅限本机回环地址的接口读写：
  - `GET /api/dsh-away-mode/state`
  - `PUT /api/dsh-away-mode/state`，请求体 `{"mode":"off"|"self"|"pause"}`

## 安装

在 DSH 中执行：

```text
plugin_manager action=install_bundle target=/absolute/path/to/dsh-away-mode
```

## 许可

本项目采用**代码与文档分离**的双重许可：

| 范围 | 内容 | 许可 |
| --- | --- | --- |
| 代码 | `index.js`、`client.js`、`cordis.patch.yml`、`icon.svg`、`package.json` 及构建/配置文件 | [GNU General Public License v3.0 only](LICENSE)（GPL-3.0-only） |
| 文档 | `README.md`、`locale/*.json` 及仓库中的其他说明文字 | [CC BY-NC-SA 4.0](LICENSE-DOCS) |

- 代码版权归 myLiLingyun 所有，按 GPL-3.0-only 发布，完整条款见 [`LICENSE`](LICENSE)。
- 文档按 CC BY-NC-SA 4.0 发布，完整条款见 [`LICENSE-DOCS`](LICENSE-DOCS)；转载或改编需署名
  myLiLingyun、注明来源（[本仓库](https://github.com/myLiLingyun/DSHPlug-away-mode)）、以相同许可
  共享，且不得用于商业目的。
- 两套许可分别适用于各自范围；GPL-3.0-only 不限制代码的商业使用。
