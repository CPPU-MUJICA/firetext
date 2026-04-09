/**
 * 多模型 API 配置（OpenAI 兼容 / Anthropic Claude）
 * 供 api.html、ai-chat.html 等页面共用，数据存 localStorage
 */
(function (g) {
  var KEY = 'firetext_ai_v1';

  function newId() {
    return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function defaultState() {
    return {
      version: 1,
      activeId: 'p_deepseek',
      profiles: [
        { id: 'p_deepseek', name: 'DeepSeek', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' },
        { id: 'p_openai', name: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
        { id: 'p_claude', name: 'Claude (Anthropic)', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-20241022', apiKey: '' }
      ]
    };
  }

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && Array.isArray(s.profiles) && s.profiles.length) {
        if (!s.version) s.version = 1;
        return s;
      }
    } catch (e) {}
    return defaultState();
  }

  function save(state) {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  function chatCompletionsUrl(baseUrl) {
    var b = (baseUrl || '').trim().replace(/\/+$/, '');
    if (!b) return '';
    if (/\/v1$/i.test(b)) return b + '/chat/completions';
    return b + '/v1/chat/completions';
  }

  function getActiveProfile() {
    var s = load();
    var id = s.activeId;
    for (var i = 0; i < s.profiles.length; i++) {
      if (s.profiles[i].id === id) return s.profiles[i];
    }
    return s.profiles[0] || null;
  }

  function setActiveId(id) {
    var s = load();
    s.activeId = id;
    save(s);
  }

  function streamOpenAI(profile, messages, cb) {
    var url = chatCompletionsUrl(profile.baseUrl);
    if (!url) {
      cb.onError(new Error('Base URL 无效'));
      return;
    }
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + profile.apiKey
      },
      body: JSON.stringify({ model: profile.model, messages: messages, stream: true })
    })
      .then(function (res) {
        if (!res.ok)
          return res.text().then(function (t) {
            throw new Error('HTTP ' + res.status + (t ? ': ' + t.slice(0, 280) : ''));
          });
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var sseBuf = '';
        function read() {
          reader.read().then(function (r) {
            if (r.done) {
              cb.onDone();
              return;
            }
            sseBuf += dec.decode(r.value, { stream: true });
            var parts = sseBuf.split('\n');
            sseBuf = parts.pop() || '';
            for (var i = 0; i < parts.length; i++) {
              var line = parts[i].trim();
              if (line.indexOf('data:') !== 0 || line === 'data: [DONE]') continue;
              var payload = line.indexOf('data: ') === 0 ? line.slice(6) : line.slice(5);
              try {
                var json = JSON.parse(payload);
                var d = json.choices && json.choices[0] && json.choices[0].delta;
                if (d && d.content) cb.onToken(d.content);
              } catch (e) {}
            }
            read();
          }).catch(function (e) {
            cb.onError(e);
          });
        }
        read();
      })
      .catch(cb.onError);
  }

  function streamAnthropic(profile, messages, cb) {
    var system = '';
    var msgs = [];
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === 'system') system = messages[i].content;
      else msgs.push({ role: messages[i].role, content: messages[i].content });
    }
    var base = (profile.baseUrl || '').replace(/\/+$/, '');
    var url = base + '/v1/messages';
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': profile.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: profile.model,
        max_tokens: 8192,
        system: system || 'You are a helpful assistant.',
        messages: msgs,
        stream: true
      })
    })
      .then(function (res) {
        if (!res.ok)
          return res.text().then(function (t) {
            throw new Error('HTTP ' + res.status + (t ? ': ' + t.slice(0, 280) : ''));
          });
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var lineBuf = '';
        function read() {
          reader.read().then(function (r) {
            if (r.done) {
              cb.onDone();
              return;
            }
            lineBuf += dec.decode(r.value, { stream: true });
            var lines = lineBuf.split('\n');
            lineBuf = lines.pop() || '';
            for (var j = 0; j < lines.length; j++) {
              var line = lines[j].trim();
              if (!line || line.indexOf('event:') === 0) continue;
              if (line.indexOf('data:') === 0) {
                var raw = line.slice(5).trim();
                if (raw === '[DONE]') continue;
                try {
                  var ev = JSON.parse(raw);
                  if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) cb.onToken(ev.delta.text);
                } catch (e) {}
              }
            }
            read();
          }).catch(function (e) {
            cb.onError(e);
          });
        }
        read();
      })
      .catch(cb.onError);
  }

  function streamChat(profile, messages, cb) {
    if (!profile || !profile.apiKey) {
      cb.onError(new Error('未配置 API Key，请前往「API」设置页填写并保存'));
      return;
    }
    if (profile.provider === 'anthropic') return streamAnthropic(profile, messages, cb);
    return streamOpenAI(profile, messages, cb);
  }

  g.FireTextAI = {
    STORAGE_KEY: KEY,
    newId: newId,
    defaultState: defaultState,
    load: load,
    save: save,
    saveFull: function (state) {
      if (!state.profiles || !state.profiles.length) throw new Error('至少保留一条配置');
      var activeOk = false;
      for (var i = 0; i < state.profiles.length; i++) {
        if (state.profiles[i].id === state.activeId) activeOk = true;
      }
      if (!activeOk) state.activeId = state.profiles[0].id;
      save({ version: 1, activeId: state.activeId, profiles: state.profiles });
    },
    getActiveProfile: getActiveProfile,
    setActiveId: setActiveId,
    chatCompletionsUrl: chatCompletionsUrl,
    streamChat: streamChat
  };
})(typeof window !== 'undefined' ? window : this);
