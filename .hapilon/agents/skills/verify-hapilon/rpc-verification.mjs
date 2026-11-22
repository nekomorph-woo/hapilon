import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { constants, accessSync, appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const cli = join(repo, 'dist/cli.js');
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const provider = 'verify-local';
const model = 'fixture';

export function bounded(promise, label, ms = 20_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
  })]).finally(() => clearTimeout(timer));
}

export async function withRpcVerification({ name, tools, settings = {}, reply, onEvent }, run) {
  assert.equal(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim(), version);
  const evidenceDir = join(repo, '.hapilon/verify');
  mkdirSync(evidenceDir, { recursive: true });
  const evidence = join(mkdtempSync(join(evidenceDir, `${name}-`)), 'events.jsonl');
  const record = (event) => appendFileSync(evidence, `${JSON.stringify(event)}\n`);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hapi-verify-')));
  const workspace = join(scratch, 'workspace');
  const home = join(scratch, 'home');
  const agent = join(home, '.hapilon/agent');
  let child;
  let endpointError;
  let closing = false;
  const pending = new Map();
  let sequence = 0;
  let ioError;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      const data = [];
      for await (const chunk of req) data.push(chunk);
      const request = JSON.parse(Buffer.concat(data).toString('utf8'));
      assert.equal(request.model, model);
      const { delta, finishReason } = reply(request, record);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      endpointError = error;
      res.writeHead(500).end('fixture endpoint error');
    }
  });

  function send(message) {
    if (ioError) throw ioError;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function rpc(type, payload = {}) {
    const id = String(++sequence);
    return bounded(new Promise((resolve) => {
      pending.set(id, resolve);
      send({ id, type, ...payload });
    }), type).then((response) => {
      assert.equal(response.success, true, JSON.stringify(response));
      return response.data;
    }).finally(() => pending.delete(id));
  }

  function receive(event) {
    if (event.type === 'response') pending.get(event.id)?.(event);
    else onEvent(event, { send, record });
  }

  function checkIo() {
    if (ioError || endpointError) throw ioError ?? endpointError;
  }

  async function launch() {
    mkdirSync(agent, { recursive: true });
    mkdirSync(workspace);
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { [provider]: {
      baseUrl, api: 'openai-completions', apiKey: 'fixture-not-a-key', models: [{ id: model }],
    } } }));
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({
      retry: { enabled: false },
      'pi-browser-use': { envAllowlist: ['CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS'] },
      ...settings,
    }));
    child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-session', '--no-mcp', '--no-econ', '--tools', tools.join(','), '--provider', provider, '--model', model], {
      cwd: workspace, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        HOME: home, HAPILON_HOME: dirname(agent), PATH: process.env.PATH, TMPDIR: scratch,
        XDG_CONFIG_HOME: join(home, '.config'), CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1', ACP_AUTO_UPDATE: '0',
      },
    });
    child.once('error', (error) => { ioError = error; });
    child.once('exit', (code, signal) => {
      if (!closing) ioError = new Error(`hapi 提前退出：${code ?? signal}`);
    });
    child.stdin.on('error', (error) => { ioError = error; });
    child.stderr.setEncoding('utf8').on('data', (text) => record({ type: 'stderr', text }));
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        if (line.startsWith('{')) receive(JSON.parse(line));
        else record({ type: 'startup-output', line });
      } catch (error) {
        ioError = error;
        record({ type: 'rpc-error', message: error.message });
      }
    });
    const state = await rpc('get_state');
    assert.equal(state.model?.provider, provider);
    assert.equal(state.model?.id, model);
    assert.equal(state.model?.baseUrl, baseUrl);
    assert.equal(state.isStreaming, false);
    record({ type: 'ready', cli, version, pid: child.pid, workspace, model: state.model.id, baseUrl });
  }

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await launch();
    return await run({ workspace, record, rpc, send, checkIo });
  } catch (error) {
    record({ type: 'harness-error', message: error.message });
    console.error(error);
    process.exitCode = 2;
  } finally {
    closing = true;
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.stdin.end();
        try {
          await bounded(exited, '退出 hapi', 3_000);
        } catch (error) {
          record({ type: 'cleanup-timeout', message: error.message });
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
          await bounded(exited, '结束 hapi 进程组', 3_000);
          process.exitCode = 2;
        }
      }
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(scratch, { recursive: true });
      record({ type: 'cleaned', scratch });
      accessSync(evidence, constants.R_OK);
      console.log(`证据：${evidence}`);
    }
  }
}
