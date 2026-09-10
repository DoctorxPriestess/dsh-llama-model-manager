// dsh-llama-model-manager — client half.
//
// Registers a "本地模型管理" section in the DSH Web settings page: full CRUD for
// the GGUF model list, the llama-server launch arguments, the manager settings,
// live runtime status, and Load / Unload / Restart actions.
//
// Hand-written client bundle (no build step): the file is a classic script that
// registers a factory with window.__ModuleLoader__; `react` comes from the
// shell's static module table.
window.__ModuleLoader__.load({
  id: 'dsh-llama-model-manager',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;

    var API = '/llama-model-manager/api';
    var MANAGER_HEADER = { 'x-llama-manager': '1' };
    var POLL_MS = 2000;

    // ── API helpers ───────────────────────────────────────────────────────
    function call(path, options) {
      var opt = options || {};
      var init = { method: opt.method || 'GET', headers: Object.assign({}, MANAGER_HEADER) };
      if (opt.body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(opt.body);
      }
      return fetch(API + path, init).then(function (response) {
        return response.text().then(function (text) {
          var json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (error) {
            json = null;
          }
          if (!response.ok) {
            var message = (json && json.error && json.error.message) || text || 'HTTP ' + response.status;
            var err = new Error(message);
            err.status = response.status;
            err.code = json && json.error && json.error.code;
            err.detail = json && json.error && json.error.detail;
            throw err;
          }
          return json;
        });
      });
    }

    // ── styles ────────────────────────────────────────────────────────────
    var styles = {
      section: {
        width: '100%',
        maxWidth: 'none',
        color: 'var(--dsw-alias-label-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        boxSizing: 'border-box',
      },
      h2: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: '22px' },
      h3: { margin: 0, fontSize: 13, fontWeight: 600, lineHeight: '20px' },
      note: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        lineHeight: '17px',
        wordBreak: 'break-all',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-3)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minWidth: 0,
      },
      row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 },
      label: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 5,
        padding: '4px 7px',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 76,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 5,
        padding: '5px 7px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        lineHeight: '17px',
        resize: 'vertical',
      },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-primary)',
        background: 'transparent',
        font: 'inherit',
        cursor: 'pointer',
        borderRadius: 5,
        padding: '3px 9px',
        fontSize: 12,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        border: '1px solid var(--dsw-alias-state-business-primary)',
        color: 'var(--dsw-alias-state-business-primary)',
        background: 'transparent',
        font: 'inherit',
        cursor: 'pointer',
        borderRadius: 5,
        padding: '3px 9px',
        fontSize: 12,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: {
        textAlign: 'left',
        fontSize: 11,
        fontWeight: 500,
        color: 'var(--dsw-alias-label-tertiary)',
        padding: '4px 6px',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
      },
      td: { padding: '5px 6px', borderBottom: '1px solid var(--dsw-alias-border-l2)', verticalAlign: 'top' },
      pre: {
        margin: 0,
        padding: '6px 8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 5,
        maxHeight: 240,
        overflow: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        lineHeight: '17px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      pill: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 999,
        padding: '0 7px',
        fontSize: 11,
        lineHeight: '17px',
        whiteSpace: 'nowrap',
      },
      error: { color: 'var(--dsw-alias-label-primary)', fontSize: 12, lineHeight: '18px', margin: 0 },
    };

    var STATE_LABEL = {
      stopped: '已停止',
      starting: '启动中',
      ready: '就绪',
      stopping: '停止中',
      switching: '切换中',
      error: '错误',
    };

    function stateColor(state) {
      if (state === 'ready') return 'var(--dsw-alias-state-business-primary)';
      if (state === 'error') return 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))';
      return 'var(--dsw-alias-label-tertiary)';
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes)) return '未知大小';
      var units = ['B', 'KB', 'MB', 'GB', 'TB'];
      var value = bytes;
      var index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value = value / 1024;
        index += 1;
      }
      return value.toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
    }

    function formatTime(ts) {
      if (!ts) return '—';
      try {
        return new Date(ts).toLocaleTimeString();
      } catch (error) {
        return String(ts);
      }
    }

    // ── building blocks ───────────────────────────────────────────────────
    function Btn(props) {
      var style = props.kind === 'primary' ? styles.buttonPrimary : styles.button;
      if (props.disabled) {
        style = Object.assign({}, style, { opacity: 0.5, cursor: 'default' });
      }
      return h(
        'button',
        {
          type: 'button',
          style: style,
          disabled: !!props.disabled,
          title: props.title || undefined,
          onClick: props.disabled ? undefined : props.onClick,
        },
        props.children
      );
    }

    function Field(props) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
        h('span', { style: styles.label }, props.label),
        props.children,
        props.hint ? h('span', { style: styles.note }, props.hint) : null
      );
    }

    function TextField(props) {
      return h(Field, { label: props.label, hint: props.hint },
        h('input', {
          style: styles.input,
          type: props.type || 'text',
          value: props.value === null || props.value === undefined ? '' : String(props.value),
          placeholder: props.placeholder || '',
          onChange: function (event) { props.onChange(event.target.value); },
        })
      );
    }

    function NumberField(props) {
      return h(Field, { label: props.label, hint: props.hint },
        h('input', {
          style: styles.input,
          type: 'number',
          value: props.value === null || props.value === undefined ? '' : String(props.value),
          min: props.min,
          step: props.step || 1,
          onChange: function (event) {
            var raw = event.target.value;
            props.onChange(raw === '' ? '' : Number(raw));
          },
        })
      );
    }

    function CheckField(props) {
      return h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, lineHeight: '18px' } },
        h('input', {
          type: 'checkbox',
          checked: !!props.value,
          onChange: function (event) { props.onChange(event.target.checked); },
        }),
        h('span', null, props.label)
      );
    }

    function SelectField(props) {
      var options = props.options || [];
      // Fall back to the first option when the stored value is unknown, so the
      // control never renders blank for a value an older config wrote.
      var known = options.some(function (opt) { return opt.value === props.value; });
      var current = known ? props.value : (options[0] ? options[0].value : '');
      return h(Field, { label: props.label, hint: props.hint },
        h('select', {
          style: styles.input,
          value: current,
          onChange: function (event) { props.onChange(event.target.value); },
        },
          options.map(function (opt) {
            return h('option', { key: opt.value, value: opt.value }, opt.label);
          })
        )
      );
    }

    // ── status panel ──────────────────────────────────────────────────────
    function StatusPanel(props) {
      var status = props.status;
      if (!status) return h('p', { style: styles.note }, '正在读取管理器状态…');
      var currentModel = status.currentModel;
      var lastError = status.lastError;

      return h('div', { style: styles.card },
        h('div', { style: styles.row },
          h('h3', { style: styles.h3 }, '当前运行状态'),
          h('span', { style: Object.assign({}, styles.pill, { color: stateColor(status.state) }) },
            STATE_LABEL[status.state] || status.state),
          h('span', { style: styles.note }, '自动刷新'),
          h('input', {
            type: 'checkbox',
            checked: props.autoRefresh,
            onChange: function (event) { props.setAutoRefresh(event.target.checked); },
          }),
          h(Btn, { onClick: props.refresh }, '手动刷新')
        ),
        h('div', { style: styles.grid },
          infoItem('当前模型', currentModel ? (status.currentModelDisplayName || currentModel) : '无'),
          infoItem('模型 ID', currentModel || '—'),
          infoItem('PID', status.pid === null || status.pid === undefined ? '—' : String(status.pid)),
          infoItem('内部端口', String(status.internalPort)),
          infoItem('Gateway', status.gateway && status.gateway.listening
            ? status.gateway.host + ':' + status.gateway.port + '（监听中）'
            : status.gateway
              ? status.gateway.host + ':' + status.gateway.port + '（未监听）'
              : '—'),
          infoItem('排队请求', String(status.queueLength)),
          infoItem('进行中请求', String(status.inflightRequests)),
          infoItem('运行时长', status.uptimeSeconds + ' 秒'),
          infoItem('累计加载', String(status.stats ? status.stats.loads : 0)),
          infoItem('累计切换', String(status.stats ? status.stats.switches : 0)),
          infoItem('崩溃次数', String(status.stats ? status.stats.crashes : 0))
        ),
        // The stop button is ALWAYS present, not only when a model is loaded.
        // After a crash, a failed load, or while simply idle there is no
        // `currentModel`, and that is exactly when you want to be able to stop
        // llama-server and reclaim its VRAM. POST /manager/unload is safe to
        // call unconditionally -- it reports "nothing loaded" rather than
        // failing -- so the button stays enabled and tells you the truth.
        // Restart / Load only make sense with a current model, so they remain
        // conditional.
        h('div', { style: styles.row },
          h(Btn, {
            kind: currentModel ? 'primary' : undefined,
            disabled: props.busy,
            onClick: function () { props.action('unload'); },
          }, currentModel ? 'Unload 停止并释放显存' : 'Unload 停止（当前无模型）'),
          currentModel
            ? h(Btn, {
                disabled: props.busy,
                onClick: function () { props.action('restart', currentModel); },
              }, 'Restart 重启')
            : null,
          currentModel
            ? h(Btn, {
                disabled: props.busy,
                onClick: function () { props.action('load', currentModel); },
              }, 'Load 加载')
            : null
        ),
        lastError
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '最近错误'),
                h(Btn, { onClick: function () { props.action('clear-error'); } }, '清除')),
              h('p', { style: styles.error }, '[' + (lastError.code || 'ERROR') + '] ' + lastError.message +
                (lastError.modelId ? '（模型 ' + lastError.modelId + '）' : '') +
                (lastError.exitCode !== null && lastError.exitCode !== undefined ? '（exit code=' + lastError.exitCode + '）' : '')),
              lastError.detail && lastError.detail.stderrTail && lastError.detail.stderrTail.length
                ? h('details', null,
                    h('summary', { style: styles.label }, 'llama-server stderr（最后 ' + lastError.detail.stderrTail.length + ' 行）'),
                    h('pre', { style: styles.pre }, lastError.detail.stderrTail.join('\n')))
                : null,
              lastError.detail && lastError.detail.commandLine
                ? h('div', null,
                    h('span', { style: styles.label }, '启动命令'),
                    h('pre', { style: styles.pre }, lastError.detail.commandLine))
                : null)
          : h('p', { style: styles.note }, '最近错误：None'),
        props.staleProcess
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('p', { style: styles.note },
                '检测到上次运行遗留的进程：PID ' + props.staleProcess.pid +
                '（' + (props.staleProcess.imageName || '未知镜像') + '，模型 ' + (props.staleProcess.modelId || '?') + '）'),
              h('div', { style: styles.row },
                props.staleProcess.attributable
                  ? h(Btn, { onClick: function () { props.action('cleanup-stale'); } }, '清理残留进程')
                  : h('span', { style: styles.note }, '该进程无法确认由本插件启动，插件不会对它做任何操作。'))
            )
          : null
      );
    }

    function infoItem(label, value) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        h('span', { style: styles.label }, label),
        h('span', { style: Object.assign({}, styles.mono, { fontSize: 12 }) }, value)
      );
    }

    // ── model list + editor ───────────────────────────────────────────────
    function emptyModel(internalPort) {
      return { id: '', displayName: '', modelPath: '', arguments: '' };
    }

    function ModelEditor(props) {
      var draftState = React.useState(props.initial);
      var draft = draftState[0];
      var setDraft = draftState[1];
      var previewState = React.useState(null);
      var preview = previewState[0];
      var setPreview = previewState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var isNew = !props.initial.id;

      function update(patch) {
        setDraft(Object.assign({}, draft, patch));
      }

      function baseArguments() {
        var port = props.settings.internalPort;
        var parts = [];
        if (!/-m\b|--model\b/.test(draft.arguments || '')) {
          parts.push('-m "' + (draft.modelPath || '<GGUF 路径>') + '"');
        }
        if (!/--host\b/.test(draft.arguments || '')) parts.push('--host 127.0.0.1');
        if (!/--port\b/.test(draft.arguments || '')) parts.push('--port ' + port);
        return parts.join(' ');
      }

      function save() {
        setError(null);
        call(isNew ? '/models' : '/models/' + encodeURIComponent(props.initial.id), {
          method: isNew ? 'POST' : 'PUT',
          body: { id: draft.id, displayName: draft.displayName, modelPath: draft.modelPath, arguments: draft.arguments },
        })
          .then(function () { props.onSaved(); })
          .catch(function (err) { setError(err.message); });
      }

      function runPreview() {
        setError(null);
        call('/preview', { method: 'POST', body: { model: draft.id || props.initial.id } })
          .then(function (result) { setPreview(result.preview); })
          .catch(function (err) { setError(err.message); setPreview(null); });
      }

      return h('div', { style: styles.card },
        h('h3', { style: styles.h3 }, isNew ? '新增模型' : '编辑模型：' + props.initial.id),
        h('div', { style: styles.grid },
          h(TextField, {
            label: '模型显示名称',
            value: draft.displayName,
            placeholder: 'Qwen3.8-27B IQ3_S',
            onChange: function (value) { update({ displayName: value }); },
          }),
          h(TextField, {
            label: '模型 ID（DSH 请求里用的 model 字段）',
            value: draft.id,
            placeholder: 'qwen38-iq3s',
            hint: '只允许字母、数字与 . _ @ : + -',
            onChange: function (value) { update({ id: value }); },
          })
        ),
        h(TextField, {
          label: 'GGUF 路径',
          value: draft.modelPath,
          placeholder: 'C:\\models\\your-model.gguf',
          onChange: function (value) { update({ modelPath: value }); },
        }),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('span', { style: styles.label }, '完整 llama-server 启动参数（原样传给 llama-server，留空则自动补 -m/--host/--port）'),
          h('textarea', {
            style: styles.textarea,
            value: draft.arguments || '',
            placeholder: '--ctx-size 131072 -fa on -ctk q4_0 -ctv q4_0 -b 256 -ub 256 -np 1 --jinja',
            onChange: function (event) { update({ arguments: event.target.value }); },
          }),
          h('div', { style: styles.row },
            h(Btn, { onClick: function () { update({ arguments: baseArguments() }); } }, '自动填充基础参数'),
            h(Btn, {
              onClick: function () {
                var extra = '--ctx-size 131072 -fa on -ctk q4_0 -ctv q4_0 -b 256 -ub 256 -np 1 --jinja';
                update({ arguments: (draft.arguments ? draft.arguments + ' ' : '') + extra });
              },
            }, '插入示例参数'),
            h(Btn, { onClick: runPreview, disabled: !draft.id && !props.initial.id }, '参数预览'),
            h(Btn, { onClick: function () { update({ arguments: '' }); } }, '清空参数')
          ),
          h('span', { style: styles.note },
            '示例（需要 mmproj 时请自行补上真实路径）：-m "<GGUF>" --host 127.0.0.1 --port ' +
            props.settings.internalPort + ' --mmproj "C:\\models\\mmproj-your-model.gguf" --no-mmproj-offload --ctx-size 131072 --jinja')
        ),
        preview
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('span', { style: styles.label },
                '最终命令行（自动补全：' + (preview.autoFilled.join(', ') || '无') + '；端口 ' + preview.effectivePort + '）'),
              h('pre', { style: styles.pre }, preview.commandLine),
              preview.notes && preview.notes.length
                ? h('pre', { style: styles.pre }, preview.notes.join('\n'))
                : null)
          : null,
        error ? h('p', { style: styles.error, role: 'alert' }, error) : null,
        h('div', { style: styles.row },
          h(Btn, { kind: 'primary', onClick: save, disabled: props.busy }, isNew ? '创建模型' : '保存修改'),
          h(Btn, { onClick: props.onCancel }, '取消')
        )
      );
    }

    function ModelTable(props) {
      var models = props.models || [];
      if (!models.length) {
        return h('p', { style: styles.note }, '还没有任何模型，点击「新增模型」或「从目录扫描」开始。');
      }
      return h('table', { style: styles.table },
        h('thead', null,
          h('tr', null,
            h('th', { style: styles.th }, '显示名称'),
            h('th', { style: styles.th }, '模型 ID'),
            h('th', { style: styles.th }, 'GGUF 路径'),
            h('th', { style: styles.th }, '启动参数'),
            h('th', { style: styles.th }, '操作')
          )
        ),
        h('tbody', null, models.map(function (model) {
          var isCurrent = props.currentModel === model.id;
          return h('tr', { key: model.id },
            h('td', { style: styles.td }, h('strong', null, model.displayName || model.id),
              isCurrent ? h('span', { style: Object.assign({}, styles.pill, { marginLeft: 6, color: stateColor('ready') }) }, '运行中') : null),
            h('td', { style: Object.assign({}, styles.td, styles.mono) }, model.id),
            h('td', { style: Object.assign({}, styles.td, styles.mono) }, model.modelPath),
            h('td', { style: Object.assign({}, styles.td, styles.mono) },
              model.arguments ? model.arguments : h('span', { style: styles.note }, '（空 → 自动补 -m/--host/--port）')),
            h('td', { style: styles.td },
              h('div', { style: styles.row },
                h(Btn, { onClick: function () { props.onLoad(model.id); } }, 'Load'),
                h(Btn, { onClick: function () { props.onRestart(model.id); } }, 'Restart'),
                h(Btn, { onClick: function () { props.onEdit(model); } }, '编辑'),
                h(Btn, {
                  onClick: function () { props.onDelete(model.id); },
                  disabled: isCurrent,
                  title: isCurrent ? '运行中的模型请先 Unload' : '',
                }, '删除')
              )
            )
          );
        }))
      );
    }

    function Scanner(props) {
      var dirState = React.useState('');
      var dir = dirState[0];
      var setDir = dirState[1];
      var resultState = React.useState(null);
      var result = resultState[0];
      var setResult = resultState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      function scan() {
        setBusy(true);
        setError(null);
        call('/scan', { method: 'POST', body: { dir: dir } })
          .then(function (data) { setResult(data); })
          .catch(function (err) { setError(err.message); setResult(null); })
          .then(function () { setBusy(false); });
      }

      return h('div', { style: styles.card },
        h('h3', { style: styles.h3 }, '从目录扫描 GGUF'),
        h('div', { style: styles.row },
          h('input', {
            style: Object.assign({}, styles.input, { flex: '1 1 320px' }),
            value: dir,
            placeholder: 'C:\\models',
            onChange: function (event) { setDir(event.target.value); },
          }),
          h(Btn, { onClick: scan, disabled: busy || !dir }, busy ? '扫描中…' : '扫描')
        ),
        error ? h('p', { style: styles.error }, error) : null,
        result
          ? result.found.length
            ? h('table', { style: styles.table },
                h('thead', null, h('tr', null,
                  h('th', { style: styles.th }, '文件'),
                  h('th', { style: styles.th }, '大小'),
                  h('th', { style: styles.th }, '建议 ID'),
                  h('th', { style: styles.th }, '操作'))),
                h('tbody', null, result.found.map(function (item) {
                  var exists = props.models.some(function (m) { return m.modelPath === item.path; });
                  return h('tr', { key: item.path },
                    h('td', { style: Object.assign({}, styles.td, styles.mono) }, item.path),
                    h('td', { style: styles.td }, formatBytes(item.sizeBytes)),
                    h('td', { style: Object.assign({}, styles.td, styles.mono) }, item.suggestedId),
                    h('td', { style: styles.td },
                      exists
                        ? h('span', { style: styles.note }, '已添加')
                        : h(Btn, {
                            onClick: function () {
                              props.onAdd({ id: item.suggestedId, displayName: item.fileName, modelPath: item.path, arguments: '' });
                            },
                          }, '添加')));
                })))
            : h('p', { style: styles.note }, '该目录下未找到 .gguf 文件（已自动跳过 mmproj-* 投影文件）。')
          : null
      );
    }

    // ── settings form ─────────────────────────────────────────────────────
    function SettingsForm(props) {
      var state = React.useState(props.settings);
      var draft = state[0];
      var setDraft = state[1];

      React.useEffect(function () { setDraft(props.settings); }, [props.settings]);

      function update(patch) {
        setDraft(Object.assign({}, draft, patch));
      }

      return h('div', { style: styles.card },
        h('h3', { style: styles.h3 }, '管理器设置'),
        h('div', { style: styles.grid },
          h(TextField, {
            label: 'llama-server 可执行文件路径',
            value: draft.llamaServerPath,
            placeholder: 'C:\\path\\to\\llama-server.exe',
            onChange: function (v) { update({ llamaServerPath: v }); },
          }),
          h(TextField, {
            label: '管理器监听地址（Gateway host）',
            value: draft.gatewayHost,
            onChange: function (v) { update({ gatewayHost: v }); },
          }),
          h(NumberField, {
            label: '管理器监听端口（Gateway port）',
            value: draft.gatewayPort,
            min: 1,
            onChange: function (v) { update({ gatewayPort: v }); },
            hint: 'DSH 的 baseURL 指向这里，默认 8080',
          }),
          h(NumberField, {
            label: 'llama-server 内部端口',
            value: draft.internalPort,
            min: 1,
            onChange: function (v) { update({ internalPort: v }); },
            hint: 'Gateway 代理到的后端端口，默认 18080',
          }),
          h(NumberField, {
            label: '启动超时（ms）',
            value: draft.startupTimeoutMs,
            min: 1000,
            step: 1000,
            onChange: function (v) { update({ startupTimeoutMs: v }); },
          }),
          h(NumberField, {
            label: '停止超时（ms）',
            value: draft.shutdownTimeoutMs,
            min: 0,
            step: 1000,
            onChange: function (v) { update({ shutdownTimeoutMs: v }); },
          }),
          h(SelectField, {
            label: '停止方式',
            value: draft.stopMethod || 'auto',
            options: [
              { value: 'auto', label: '自动：先 Ctrl+C 优雅停止，超时再强制' },
              { value: 'ctrl-c', label: '仅 Ctrl+C（不强制结束）' },
              { value: 'taskkill', label: '直接强制结束（taskkill /F）' },
            ],
            onChange: function (v) { update({ stopMethod: v }); },
            hint: 'Ctrl+C 经隐藏控制台发送，不弹窗口；llama-server 收到后会释放显存',
          }),
          h(NumberField, {
            label: '健康检查间隔（ms）',
            value: draft.healthCheckIntervalMs,
            min: 50,
            step: 50,
            onChange: function (v) { update({ healthCheckIntervalMs: v }); },
          }),
          h(NumberField, {
            label: '切换前等待推理结束上限（ms，0=一直等）',
            value: draft.forceShutdownAfterTimeoutMs,
            min: 0,
            step: 1000,
            onChange: function (v) { update({ forceShutdownAfterTimeoutMs: v }); },
          }),
          h(NumberField, {
            label: '最大排队请求数',
            value: draft.maxQueuedRequests,
            min: 0,
            onChange: function (v) { update({ maxQueuedRequests: v }); },
          }),
          h(NumberField, {
            label: '最大并发代理请求数',
            value: draft.maxConcurrentRequests,
            min: 1,
            onChange: function (v) { update({ maxConcurrentRequests: v }); },
            hint: '-np 1 的模型请保持 1',
          }),
          h(NumberField, {
            label: '启动自动重试次数',
            value: draft.maxRetries,
            min: 0,
            onChange: function (v) { update({ maxRetries: v }); },
            hint: '0 = 不重试，默认 1（最多再试一次）',
          }),
          h(TextField, {
            label: '启动时自动加载的模型 ID（留空=不加载）',
            value: draft.startupModel || '',
            placeholder: 'qwen38-iq3s',
            onChange: function (v) { update({ startupModel: v.trim() === '' ? null : v }); },
          }),
          h(TextField, {
            label: '健康检查路径',
            value: draft.healthPath,
            onChange: function (v) { update({ healthPath: v }); },
            hint: '默认 /health，缺失时自动 fallback 到 ' + (draft.healthFallbackPath || '/v1/models'),
          })
        ),
        h('div', { style: styles.row },
          h(CheckField, {
            label: '崩溃后自动恢复一次（autoRecoverAfterCrash）',
            value: draft.autoRecoverAfterCrash,
            onChange: function (v) { update({ autoRecoverAfterCrash: v }); },
          }),
          h(CheckField, {
            label: '启动时清理本插件上次遗留的 llama-server',
            value: draft.cleanupStaleProcessOnStart,
            onChange: function (v) { update({ cleanupStaleProcessOnStart: v }); },
          }),
          h(CheckField, {
            label: '要求 x-llama-manager 请求头（防跨站）',
            value: draft.requireManagerToken,
            onChange: function (v) { update({ requireManagerToken: v }); },
          })
        ),
        h('div', { style: styles.row },
          h(Btn, { kind: 'primary', onClick: function () { props.onSave(draft); }, disabled: props.busy }, '保存设置'),
          h(Btn, { onClick: function () { setDraft(props.settings); } }, '放弃修改')
        ),
        h('p', { style: styles.note },
          '修改端口类设置后需要重启 DSH 才能生效；其余设置保存后立即应用。插件只写自己的配置文件，不会改动 DSH 的 settings.yaml。')
      );
    }

    // ── integration guide ─────────────────────────────────────────────────
    function buildDshSnippet(status, models) {
      var gateway = status && status.gateway ? status.gateway : { host: '127.0.0.1', port: 8080 };
      var lines = [];
      lines.push('llm-pi-ai:');
      lines.push('  providers:');
      lines.push('    llamacpp:');
      lines.push('      displayName: llama.cpp 本地');
      lines.push('      api: openai-completions');
      lines.push('      apiKeyEnv: LLAMACPP_API_KEY');
      lines.push('      baseURL: http://' + gateway.host + ':' + gateway.port + '/v1');
      lines.push('      models:');
      if (!models.length) {
        lines.push('        []   # 先在插件设置页添加模型');
      }
      models.forEach(function (model) {
        lines.push('        - id: ' + model.id);
        lines.push('          name: ' + (model.displayName || model.id));
        var ctxMatch = /(?:^|\s)(?:-c|--ctx-size)[\s=]+(\d+)/.exec(model.arguments || '');
        if (ctxMatch) lines.push('          contextWindow: ' + ctxMatch[1]);
        lines.push('          input:');
        lines.push('            - text');
        if (/mmproj|--no-mmproj-offload/.test(model.arguments || '')) lines.push('            - image');
        lines.push('          reasoningEfforts:');
        lines.push('            off: null');
        lines.push('            low: low');
        lines.push('            medium: medium');
        lines.push('            high: high');
        lines.push('            xhigh: xhigh');
      });
      return lines.join('\n');
    }

    function IntegrationGuide(props) {
      var copiedState = React.useState(false);
      var copied = copiedState[0];
      var setCopied = copiedState[1];
      var snippet = buildDshSnippet(props.status, props.models);

      function copy() {
        var clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
        if (clipboard && clipboard.writeText) {
          clipboard.writeText(snippet).then(function () {
            setCopied(true);
            setTimeout(function () { setCopied(false); }, 1500);
          }, function () { setCopied(false); });
        }
      }

      return h('div', { style: styles.card },
        h('div', { style: styles.row },
          h('h3', { style: styles.h3 }, '让 DSH 接入 Gateway'),
          h(Btn, { onClick: copy }, copied ? '已复制' : '复制 YAML')
        ),
        h('p', { style: styles.note },
          '把下面这段贴进 DSH 的 llm-pi-ai 配置（或按同样的字段手动改），baseURL 指向本插件的 Gateway，' +
          'model 用插件里注册的模型 ID。插件不会替你修改 settings.yaml。'),
        h('pre', { style: styles.pre }, snippet)
      );
    }

    function LogPanel(props) {
      var logs = props.logs || [];
      return h('div', { style: styles.card },
        h('h3', { style: styles.h3 }, '最近日志（' + logs.length + ' 条）'),
        logs.length
          ? h('pre', { style: styles.pre }, logs.map(function (entry) {
              return formatTime(entry.at) + ' [' + entry.level + '] ' + entry.line;
            }).join('\n'))
          : h('p', { style: styles.note }, '暂无日志。')
      );
    }

    // ── root ──────────────────────────────────────────────────────────────
    function LocalModelManager() {
      var statusState = React.useState(null);
      var status = statusState[0];
      var setStatus = statusState[1];
      var configState = React.useState(null);
      var config = configState[0];
      var setConfig = configState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var noticeState = React.useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var busyState = React.useState(null);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var editingState = React.useState(null);
      var editing = editingState[0];
      var setEditing = editingState[1];
      var autoRefreshState = React.useState(true);
      var autoRefresh = autoRefreshState[0];
      var setAutoRefresh = autoRefreshState[1];
      var showScannerState = React.useState(false);
      var showScanner = showScannerState[0];
      var setShowScanner = showScannerState[1];

      function refresh() {
        return call('/status')
          .then(function (data) { setStatus(data); setError(null); })
          .catch(function (err) { setError(err.message); });
      }

      function loadConfig() {
        return call('/config')
          .then(function (data) { setConfig(data.config); })
          .catch(function (err) { setError(err.message); });
      }

      React.useEffect(function () {
        refresh();
        loadConfig();
      }, []);

      React.useEffect(function () {
        if (!autoRefresh) return undefined;
        var timer = setInterval(function () { refresh(); }, POLL_MS);
        return function () { clearInterval(timer); };
      }, [autoRefresh]);

      function withBusy(label, promise) {
        setBusy(label);
        setError(null);
        setNotice(null);
        return promise
          .then(function (result) {
            return refresh().then(function () { return result; });
          })
          .catch(function (err) {
            setError(err.message + (err.detail && err.detail.rolledBackTo ? '（已回滚到 ' + err.detail.rolledBackTo + '）' : ''));
            return refresh();
          })
          .then(function (result) {
            setBusy(null);
            return result;
          });
      }

      function action(name, modelId) {
        if (name === 'unload') {
          return withBusy('unload', call('/unload', { method: 'POST', body: {} }).then(function (result) {
            // Report what actually happened: the stop button is always
            // available, so clicking it while idle must say so rather than
            // claiming something was stopped.
            if (result && result.unloaded === false) {
              setNotice('当前没有已加载的模型，无需停止（Gateway 仍在运行）。');
            } else {
              setNotice('已停止 ' + ((result && result.modelId) || '当前模型') + ' 并释放显存，Gateway 仍在运行。');
            }
          }));
        }
        if (name === 'restart') {
          return withBusy('restart', call('/restart', { method: 'POST', body: { model: modelId } }).then(function () {
            setNotice('已重启 ' + modelId);
          }));
        }
        if (name === 'load') {
          return withBusy('load', call('/load', { method: 'POST', body: { model: modelId } }).then(function (result) {
            setNotice(result && result.reused ? modelId + ' 已在运行，未重启' : '已加载 ' + modelId);
          }));
        }
        if (name === 'clear-error') {
          return call('/last-error', { method: 'DELETE' }).then(refresh, function (err) { setError(err.message); });
        }
        if (name === 'cleanup-stale') {
          return withBusy('cleanup-stale', call('/stale-process', { method: 'POST', body: {} }).then(function () {
            setNotice('已清理残留进程。');
          }));
        }
        return undefined;
      }

      function deleteModel(id) {
        var confirmed = typeof window === 'undefined' ? true : window.confirm('确定要删除模型 ' + id + ' 吗？');
        if (!confirmed) return undefined;
        return withBusy('delete', call('/models/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
          setNotice('已删除 ' + id);
        }));
      }

      function saveSettings(draft) {
        return withBusy('save-settings', call('/config', {
          method: 'PUT',
          body: Object.assign({}, config, { settings: draft }),
        }).then(function () {
          setNotice('设置已保存。');
          return loadConfig();
        }));
      }

      var models = status && status.models ? status.models : (config ? Object.values(config.models) : []);
      var settings = config ? config.settings : null;

      return h('div', { style: styles.section },
        h('div', { style: styles.row },
          h('h2', { style: styles.h2 }, '本地模型管理（llama-server）'),
          status ? h('span', { style: Object.assign({}, styles.pill, { color: stateColor(status.state) }) },
            STATE_LABEL[status.state] || status.state) : null
        ),
        h('p', { style: styles.note },
          '按请求里的 model ID 自动切换 llama-server：停旧模型 → 等进程退出 → 启新模型 → 健康检查 → 转发请求。' +
          '同一模型不会重复启动；切换全程串行。'),
        error ? h('p', { style: Object.assign({}, styles.error, { color: 'var(--dsw-alias-state-business-primary)' }), role: 'alert' }, '错误：' + error) : null,
        notice ? h('p', { style: styles.note }, notice) : null,
        h(StatusPanel, {
          status: status,
          staleProcess: status ? status.staleProcess : null,
          autoRefresh: autoRefresh,
          setAutoRefresh: setAutoRefresh,
          refresh: refresh,
          action: action,
          busy: !!busy,
        }),
        h('div', { style: styles.row },
          h('h3', { style: styles.h3 }, '模型列表'),
          h(Btn, { onClick: function () { setEditing(emptyModel()); } }, '新增模型'),
          h(Btn, { onClick: function () { setShowScanner(!showScanner); } }, showScanner ? '收起目录扫描' : '从目录扫描')
        ),
        h(ModelTable, {
          models: models,
          currentModel: status ? status.currentModel : null,
          onLoad: function (id) { action('load', id); },
          onRestart: function (id) { action('restart', id); },
          onEdit: function (model) { setEditing(model); },
          onDelete: deleteModel,
        }),
        editing
          ? h(ModelEditor, {
              initial: editing,
              settings: settings || { internalPort: 18080 },
              busy: !!busy,
              onCancel: function () { setEditing(null); },
              onSaved: function () {
                setEditing(null);
                setNotice('模型已保存。');
                loadConfig();
                refresh();
              },
            })
          : null,
        showScanner
          ? h(Scanner, {
              models: models,
              onAdd: function (model) {
                call('/models', { method: 'POST', body: model })
                  .then(function () { setNotice('已添加 ' + model.id); loadConfig(); refresh(); })
                  .catch(function (err) { setError(err.message); });
              },
            })
          : null,
        settings ? h(SettingsForm, { settings: settings, busy: !!busy, onSave: saveSettings }) : null,
        status ? h(IntegrationGuide, { status: status, models: models }) : null,
        status && status.recentLogs ? h(LogPanel, { logs: status.recentLogs }) : null,
        h('p', { style: styles.note },
          '配置文件：' + (status && status.configPath ? status.configPath : '（未知）') +
          '；管理 API：GET /manager/status、POST /manager/load|unload|restart（写操作需请求头 x-llama-manager: 1）。')
      );
    }

    function apply(ctx) {
      var slots = ctx.get('slots');
      if (!slots) return;
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'llama-model-manager', order: 17, label: '本地模型管理' },
          function () { return h(LocalModelManager); }
        );
      });
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
