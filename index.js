/**
 * dsh-away-mode — 宿主端。
 *
 * 维护一个全局的「离开模式」状态，并在 agent 提问或请求审批时，
 * 按照该状态代替用户作答：
 *
 * - `off`  ：不介入，问题照常显示给用户；
 * - `self` ：返回「用户忙，请根据用户需求选择。」
 * - `pause`：返回「用户忙，请暂停当前任务或推进无需用户选择的部分。」
 *
 * 审批请求也受同一状态控制：`self` / `pause` 下不冒充用户批准操作，而是返回
 * `unavailable`，由调用方按 fail-closed 处理。
 *
 * 计划模式的审阅（`exit_plan_mode`）走同一个 `user-questions/request` 通道：
 * 返回的纯文字 `custom` 会被 plan-mode 判为「Keep planning」并原样作为反馈交给
 * 模型。因此离开模式与 `ask_user_question` 行为一致，也永远不会替用户批准计划。
 *
 * 状态由浏览器端通过同源 HTTP 路由读写，并持久化到 `$DSH_HOME/away-mode.json`。
 * 自动作答挂在 `user-questions/request` waterfall 上，因此走的是
 * `ask_user_question` 的正常答案通道，而不是伪造工具结果或拒绝调用。
 *
 * @module dsh-away-mode
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Cordis 插件名。 */
export const name = 'away-mode';

/** 依赖 Web 服务器来暴露页面控制接口。 */
export const inject = ['webServer'];

/** 页面读写状态的路由。 */
const STATE_ROUTE = '/api/dsh-away-mode/state';

/** 允许的模式值。 */
const MODES = new Set(['off', 'self', 'pause']);

/** 自动答复文本。 */
const AWAY_MESSAGES = Object.freeze({
  self: '用户忙，请根据用户需求选择。',
  pause: '用户忙，请暂停当前任务或推进无需用户选择的部分。',
});

/** 离开模式下审批请求的答复：没有可用的审批人，调用方必须 fail-closed。 */
const APPROVAL_OUTCOME = 'unavailable';

/** 计划模式审阅的声明意图（协议标记）。 */
const PLAN_REVIEW_KIND = 'plan-review';

/** plan-mode 使用的约定问题 id，作为没有 `intent` 时的兜底识别。 */
const PLAN_REVIEW_ID = 'plan-review';

/**
 * 判断一个问题是否是计划模式（`exit_plan_mode`）的审阅请求。
 *
 * `intent` 是 `dsh-user-questions` 定义的展示意图，`id` 是同包的约定值；
 * 识别本身不改变答案编码——计划审阅仍走通用纯文字通道，结果必然被判定为
 * 「Keep planning」，只是在日志里标明这条答复的去向。
 * @param {object} question - 请求中的单个问题。
 * @returns {boolean} 是否是计划审阅问题。
 */
function isPlanReview(question) {
  return question?.intent?.kind === PLAN_REVIEW_KIND || question?.id === PLAN_REVIEW_ID;
}

/** 状态文件默认位置。 */
function defaultStateFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'away-mode.json');
}

/** 把任意输入归一为受支持的模式。 */
function normalizeMode(value) {
  return typeof value === 'string' && MODES.has(value) ? value : 'off';
}

/** 从磁盘读取上次保存的模式；文件不存在或损坏时回到「关」。 */
function loadMode(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return normalizeMode(parsed?.mode);
  } catch {
    return 'off';
  }
}

/** 原子写入状态文件；失败只记录日志，不阻断当前请求。 */
function saveMode(ctx, file, mode) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
  } catch (error) {
    ctx.logger?.warn?.(
      '[away-mode] 无法保存状态到 %s：%s',
      file,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** 只信任本机回环连接，避免把状态写入接口暴露到局域网。 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

/** 写一个 JSON 响应（HEAD 不发送正文）。 */
function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

/** 读取有大小上限的 JSON 请求体。 */
async function readJsonBody(req, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return null;
  return JSON.parse(text);
}

/**
 * 挂载插件：注册状态路由，并拦截用户提问与审批请求。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 */
export function apply(ctx) {
  const stateFile = defaultStateFile();
  let mode = loadMode(stateFile);

  // 正常答案通道：用户忙时替用户提交一个自由文本答案。
  //
  // 必须 prepend：Web 端的 Remote answerer 也是这个 waterfall 的监听器，
  // 它会一直持有请求等待真人回答，且不会调用 next()。只有排到它前面，
  // 离开模式才能在问题显示给用户之前接管。
  ctx.on(
    'user-questions/request',
    async (request, next) => {
      if (mode === 'off') return next();
      const text = AWAY_MESSAGES[mode];
      if (text === undefined) return next();
      // 计划模式的审阅也在这里被接管：纯文字 `custom` 让 plan-mode 判定为
      // Keep planning，并把文案作为反馈交回模型，因此不会擅自批准计划。
      if (request.questions.some(isPlanReview)) {
        ctx.logger?.info?.('[away-mode] 以 %s 模式答复计划审阅：Keep planning（不会批准计划）', mode);
      }
      return {
        answers: request.questions.map((question) => ({
          id: question.id,
          selected: [],
          custom: text,
        })),
      };
    },
    { prepend: true },
  );

  // 审批通道：离开模式下不冒充用户批准需要确认的操作，而是声明没有可用的
  // 审批人（`unavailable`），让调用方按 fail-closed 处理。
  //
  // 与上面的问题通道一样必须 prepend：Web 端的 Remote answerer 会把审批面板
  // 显示给用户并等待真人点击，只有排到它前面，离开模式才能及时接管。
  ctx.on(
    'approval/request',
    async (_request, next) => {
      if (mode === 'off') return next();
      return APPROVAL_OUTCOME;
    },
    { prepend: true },
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATE_ROUTE,
        handler: async (req, res) => {
          if (!isLoopback(req)) {
            sendJson(req, res, 403, { error: 'forbidden' });
            return;
          }

          if (req.method === 'GET' || req.method === 'HEAD') {
            sendJson(req, res, 200, { mode });
            return;
          }

          if (req.method !== 'PUT' && req.method !== 'POST') {
            sendJson(req, res, 405, { error: 'method-not-allowed' });
            return;
          }

          let body;
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(req, res, 400, { error: 'invalid-json' });
            return;
          }

          if (body === null || typeof body !== 'object' || !MODES.has(body.mode)) {
            sendJson(req, res, 400, { error: 'invalid-mode' });
            return;
          }

          mode = body.mode;
          saveMode(ctx, stateFile, mode);
          sendJson(req, res, 200, { mode });
        },
      }),
    'away-mode: state route',
  );
}
