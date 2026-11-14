// End-to-end UI test against a local MOCK of the Claude API (not the real service). Optional developer check:
// needs Playwright available to Node (it is not a project dependency). Usage: node scripts/e2e-mock.cjs <screenshot-dir>
const { _electron } = require('playwright');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const seen = [];
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
    seen.push({ url: req.url, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v).slice(0, 24)])), key: req.headers['x-api-key'], body: body ? JSON.parse(body) : null });
    if (req.url.startsWith('/v1/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'x', created_at: '2026-01-01T00:00:00Z' }, { id: 'claude-fable-5-2', type: 'model', display_name: 'y', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'a', last_id: 'b' }));
    if (req.url.includes('count_tokens')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 2100 }));
    if (req.url.startsWith('/v1/messages')) {
      const p = JSON.parse(body); const lc = p.messages[p.messages.length - 1].content; const lastUser = JSON.stringify(Array.isArray(lc) ? lc[lc.length - 1] : lc);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: p.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2000, output_tokens: 1 } } });
      if (lastUser.includes('SLOW')) { ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Starting a very long answer' } }); return; /* hangs until aborted */ }
      const text = lastUser.includes('tool_result') ? 'Saved **One Chunk** to your videos.' : lastUser.includes('save') ? null : 'Mock reply. Here is the detail:\n\n- point one\n- point two';
      if (text === null) {
        ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'save_video_idea', input: {} } });
        ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ title: 'One Chunk', premise: 'Survive in one chunk', format: 'long' }) } });
        ev('content_block_stop', { index: 0 });
        ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } });
      } else {
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        for (const part of text.match(/.{1,12}/gs)) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } });
        ev('content_block_stop', { index: 0 });
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 60 } });
      }
      ev('message_stop', {}); return res.end();
    }
    res.writeHead(404).end('{}');
  });
});
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gubbo-e2e-'));
  const launch = () => _electron.launch({ executablePath: require(path.resolve('node_modules/electron')), args: ['.', '--no-sandbox', '--password-store=basic'], env: { ...process.env, GUBBO_USER_DATA: dataDir, GUBBO_DEV_API_BASE: base, GUBBO_DEV_INSECURE_SECRETS: '1' } });
  const results = []; const check = (name, ok, extra = '') => { results.push([ok ? 'PASS' : 'FAIL', name, extra]); };
  let app = await launch(); await new Promise((r) => setTimeout(r, 3500));
  let panel = app.windows().find((w) => w.url().includes('panel.html'));
  const KEY = 'sk-ant-api03-' + 'E2eFakeKeyNotReal'.repeat(3);
  await panel.click('.progress li:has-text("Claude")');
  await panel.fill('input[type=password]', KEY); await panel.click('text=Save key'); await panel.waitForSelector('text=Remove key', { timeout: 8000 });
  check('key accepted via free models call and stored', seen.some((s) => s.url.startsWith('/v1/models') && s.headers.authorization.startsWith('Bearer sk-ant-api03-E2e')), JSON.stringify(seen[0].headers));
  check('key input cleared after saving', (await panel.inputValue('input[type=password]')) === '');
  await panel.click('text=Finish later');
  // budget not verified yet → blocked before dispatch
  const before = seen.filter((s) => s.url.startsWith('/v1/messages')).length;
  await panel.fill('.composer textarea', 'hello there'); await panel.click('.composer button.primary'); await panel.waitForSelector('.notice.bad', { timeout: 5000 });
  check('unverified budget blocks before any request', seen.filter((s) => s.url.startsWith('/v1/messages')).length === before, await panel.textContent('.notice.bad'));
  check('draft restored after block', (await panel.inputValue('.composer textarea')) === 'hello there');
  await panel.click('header nav >> text=Settings');
  const checks = panel.locator('label.check input'); await checks.nth(0).check(); await checks.nth(1).check();
  await panel.locator('.row:has-text("Credit available now") input').fill('25');
  await panel.click('text=Confirm budget'); await panel.waitForSelector('.notice.ok', { timeout: 5000 });
  await panel.click('header nav >> text=Talk');
  await panel.fill('.composer textarea', 'hello there'); await panel.click('.composer button.primary');
  await panel.waitForSelector('.msg.bot:not(.live) .md', { timeout: 15000 });
  check('streamed reply rendered as markdown', (await panel.locator('.msg.bot .md li').count()) === 2);
  const req = seen.filter((s) => s.url === '/v1/messages' || s.url.startsWith('/v1/messages?')).pop().body;
  check('request used the selected model, adaptive thinking and effort', req.model === 'claude-opus-5-5' && req.thinking.type === 'adaptive' && req.output_config.effort === 'medium' && req.stream === true, JSON.stringify({ m: req.model, t: req.thinking, o: req.output_config }));
  check('tools sent with eager input streaming, no fallbacks', req.tools.length === 12 && req.tools.every((t) => t.eager_input_streaming) && !('fallbacks' in req));
  await panel.fill('.composer textarea', 'please save that idea'); await panel.click('.composer button.primary');
  await panel.waitForSelector('.tag.ok:has-text("Saved idea")', { timeout: 15000 });
  await panel.click('header nav >> text=Videos');
  await panel.waitForTimeout(800); check('tool call created a video card', (await panel.locator('.projects aside li:has-text("One Chunk")').count()) === 1, await panel.locator('.projects aside').innerText());
  // cancel mid-stream
  await panel.click('header nav >> text=Talk');
  await panel.fill('.composer textarea', 'SLOW question'); await panel.click('.composer button.primary');
  await panel.waitForSelector('.msg.live .md', { timeout: 10000 });
  const state = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Escape'));
  check('Escape is bound globally while thinking', state === true);
  await panel.click('button.stop'); await panel.waitForSelector('.tag.warn:has-text("stopped early")', { timeout: 8000 });
  check('Escape released when idle', (await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Escape'))) === false);
  await panel.click('header nav >> text=Settings');
  await panel.waitForSelector('tr.uncertain', { timeout: 5000 });
  check('cancelled request is held as uncertain in the budget', (await panel.locator('tr.uncertain').count()) === 1, await panel.locator('.stats').first().innerText());
  await panel.screenshot({ path: process.argv[2] + '/e2e-budget.png', fullPage: false });
  await panel.click('header nav >> text=Talk'); await panel.screenshot({ path: process.argv[2] + '/e2e-chat.png' });
  const count1 = await panel.locator('.msg').count();
  await app.close();
  app = await launch(); await new Promise((r) => setTimeout(r, 3500));
  panel = app.windows().find((w) => w.url().includes('panel.html'));
  check('conversation restored after restart', (await panel.locator('.msg').count()) === count1 && count1 >= 5, `messages=${count1}`);
  check('single instance: second launch exits', await new Promise((resolve) => { const p = require('child_process').spawn(require(path.resolve('node_modules/electron')), ['.', '--no-sandbox', '--password-store=basic'], { env: { ...process.env, GUBBO_USER_DATA: dataDir } }); const t = setTimeout(() => { p.kill(); resolve(false); }, 8000); p.on('exit', () => { clearTimeout(t); resolve(true); }); }));
  const hay = [fs.readFileSync(path.join(dataDir, 'gubbo.db')), ...fs.readdirSync('dist/renderer/assets').map((f) => fs.readFileSync(path.join('dist/renderer/assets', f)))];
  check('key absent from database and renderer bundles', hay.every((b) => !b.includes('E2eFakeKey')));
  await app.close(); server.close();
  for (const r of results) console.log(r.join(' | '));
  process.exit(results.every((r) => r[0] === 'PASS') ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
