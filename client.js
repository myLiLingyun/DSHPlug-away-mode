/**
 * dsh-away-mode — 浏览器端。
 *
 * 在输入框下方的 `conversation.composer.dock` 中放一个紧凑的「离开模式」选择器。
 * 状态由 Host 持久化；每次打开/聚焦页面都会重新读取，修改后立即写回 Host。
 */

window.__ModuleLoader__.load({
  id: 'dsh-away-mode',
  factory(require) {
    'use strict';

    var React = require('react');
    var h = React.createElement;

    /** 与 Host 路由保持一致。 */
    var STATE_URL = '/api/dsh-away-mode/state';
    /** 本插件自己的 locale 命名空间。 */
    var NS = 'awayMode';
    /** 允许的模式值。 */
    var MODES = ['off', 'self', 'pause'];

    var ZH = {
      label: '离开模式',
      off: '关',
      self: '自行选择',
      pause: '暂停任务',
      ariaLabel: '离开模式：agent 提问时的处理方式',
      hintOff: '正常提问：agent 会等待你回答。',
      hintSelf: '你忙时，agent 会自行判断并继续；计划模式下的计划不会被自动批准，需要审批的操作会因无人批准而失败。',
      hintPause: '你忙时，agent 会暂停需要你选择的部分，推进无需你选择的部分；计划不会被自动批准，需要审批的操作会直接失败。',
      saveFailed: '保存失败',
      retry: '重试',
    };

    var EN = {
      label: 'Away mode',
      off: 'Off',
      self: 'Decide for me',
      pause: 'Pause task',
      ariaLabel: 'Away mode: how the agent handles questions',
      hintOff: 'Normal: the agent waits for your answer.',
      hintSelf: 'While you are away, the agent decides for you and continues; a plan is never auto-approved in plan mode, and operations that need approval fail without one.',
      hintPause: 'While you are away, the agent pauses choices that need you and advances the rest; a plan is never auto-approved, and operations that need approval fail immediately.',
      saveFailed: 'Could not save',
      retry: 'Retry',
    };

    var HINTS = { off: 'hintOff', self: 'hintSelf', pause: 'hintPause' };

    var CSS = [
      '.dsh-away-mode-root{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;min-height:26px;padding:1px 6px 1px 9px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap;transition:background-color .12s ease,border-color .12s ease}',
      '.dsh-away-mode-root:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-away-mode-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.dsh-away-mode-root[data-mode="self"] .dsh-away-mode-dot{background:var(--dsw-alias-brand-primary)}',
      '.dsh-away-mode-root[data-mode="pause"] .dsh-away-mode-dot{background:var(--dsw-alias-state-warn-primary)}',
      '.dsh-away-mode-label{color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.dsh-away-mode-separator{flex:none;width:1px;height:10px;background:var(--dsw-alias-border-l1)}',
      '.dsh-away-mode-selectWrap{position:relative;display:inline-flex;align-items:center}',
      '.dsh-away-mode-select{appearance:none;-webkit-appearance:none;box-sizing:border-box;height:22px;max-width:132px;margin:0;padding:0 14px 0 1px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-weight:500;line-height:22px;cursor:pointer;outline:none}',
      '.dsh-away-mode-select:disabled{opacity:.55;cursor:default}',
      '.dsh-away-mode-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-away-mode-chevron{position:absolute;right:1px;top:50%;transform:translateY(-55%);pointer-events:none;color:var(--dsw-alias-label-secondary);font-size:9px;line-height:1}',
      '.dsh-away-mode-error{flex:none;display:grid;place-items:center;box-sizing:border-box;width:16px;height:16px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-weight:700;line-height:16px;cursor:pointer}',
      '.dsh-away-mode-error:hover{background:var(--dsw-alias-bg-base)}',
      '.dsh-away-mode-error:focus-visible{outline:2px solid var(--dsw-alias-state-error-primary);outline-offset:1px}',
    ].join('');

    var snapshot = { mode: 'off', phase: 'loading', saving: false, error: null };
    var listeners = new Set();
    var requestSeq = 0;

    function getSnapshot() {
      return snapshot;
    }

    function subscribe(listener) {
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    }

    function publish(patch) {
      snapshot = Object.assign({}, snapshot, patch);
      listeners.forEach(function (listener) {
        try {
          listener();
        } catch (error) {
          console.error('[away-mode] listener failed:', error);
        }
      });
    }

    function failure(error) {
      return error && error.message ? error.message : String(error);
    }

    /** 从 Host 读取当前模式；失败时保留本地已知值。 */
    function refresh() {
      if (snapshot.saving) return;
      var seq = ++requestSeq;
      fetch(STATE_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (data) {
          if (seq !== requestSeq) return;
          if (data === null || typeof data !== 'object' || MODES.indexOf(data.mode) === -1) {
            throw new Error('invalid server response');
          }
          publish({ mode: data.mode, phase: 'ready', error: null });
        })
        .catch(function (error) {
          if (seq !== requestSeq) return;
          publish({ phase: 'error', error: failure(error) });
        });
    }

    /** 把新模式写回 Host；乐观更新，失败回滚并显示重试。 */
    function save(next) {
      if (MODES.indexOf(next) === -1) return;
      var previous = snapshot.mode;
      var seq = ++requestSeq;
      publish({ mode: next, saving: true, error: null });
      fetch(STATE_URL, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ mode: next }),
      })
        .then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (body) {
            if (!response.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + response.status);
            return body;
          });
        })
        .then(function (body) {
          if (seq !== requestSeq) return;
          var confirmed = body && MODES.indexOf(body.mode) !== -1 ? body.mode : next;
          publish({ mode: confirmed, phase: 'ready', saving: false, error: null });
        })
        .catch(function (error) {
          if (seq !== requestSeq) return;
          publish({ mode: previous, phase: 'ready', saving: false, error: failure(error) });
        });
    }

    function AwayModeControl(props) {
      var t = props.t;
      var pair = React.useState(getSnapshot());
      var state = pair[0];
      var setState = pair[1];

      React.useEffect(function () {
        return subscribe(function () {
          setState(getSnapshot());
        });
      }, []);

      var hint = t(HINTS[state.mode] || 'hintOff');
      var busy = state.phase === 'loading' || state.saving;

      return h(
        'div',
        {
          className: 'dsh-away-mode-root',
          'data-mode': state.mode,
          title: hint,
        },
        h('style', null, CSS),
        h('span', { className: 'dsh-away-mode-dot', 'aria-hidden': 'true' }),
        h('label', { className: 'dsh-away-mode-label', htmlFor: 'dsh-away-mode-select' }, t('label')),
        h('span', { className: 'dsh-away-mode-separator', 'aria-hidden': 'true' }),
        h(
          'span',
          { className: 'dsh-away-mode-selectWrap' },
          h(
            'select',
            {
              id: 'dsh-away-mode-select',
              className: 'dsh-away-mode-select',
              value: state.mode,
              disabled: busy,
              'aria-label': t('ariaLabel'),
              title: hint,
              onChange: function (event) {
                save(event.target.value);
              },
            },
            h('option', { value: 'off' }, t('off')),
            h('option', { value: 'self' }, t('self')),
            h('option', { value: 'pause' }, t('pause')),
          ),
          h('span', { className: 'dsh-away-mode-chevron', 'aria-hidden': 'true' }, '▾'),
        ),
        state.error === null
          ? null
          : h(
              'button',
              {
                type: 'button',
                className: 'dsh-away-mode-error',
                title: t('saveFailed') + ': ' + state.error,
                'aria-label': t('retry'),
                onClick: function () {
                  save(snapshot.mode);
                },
              },
              '!',
            ),
      );
    }

    return {
      name: 'away-mode',
      inject: ['slots', 'locale'],
      apply: function (ctx) {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: ZH, en: EN });
        }, 'away-mode: dictionaries');

        ctx.effect(function () {
          var onFocus = function () {
            refresh();
          };
          if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
          refresh();
          return function () {
            if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
          };
        }, 'away-mode: state sync');

        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'away-mode',
              order: 20,
              locale: NS,
            },
            AwayModeControl,
          );
        });
      },
    };
  },
});
