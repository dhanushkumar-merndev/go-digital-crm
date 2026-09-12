const fs = require('fs');
const { spawn } = require('child_process');

async function main() {
  const brave = spawn('/usr/bin/brave', [
    '--headless=new',
    '--no-sandbox',
    '--remote-debugging-port=9222',
    '--user-data-dir=/tmp/brave-test-profile',
  ]);

  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch('http://localhost:9222/json/version');
      if (res.ok) break;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const versionRes = await fetch('http://localhost:9222/json/list');
  const targets = await versionRes.json();
  const target = targets[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const resolver = pending.get(msg.id);
      pending.delete(msg.id);
      resolver(msg);
    }
  };

  await new Promise((r) => (ws.onopen = r));

  function send(method, params = {}) {
    return new Promise((resolve) => {
      const msgId = id++;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await send('Page.navigate', { url: 'http://localhost:3000/login' });
  await new Promise((r) => setTimeout(r, 1000));

  await send('Runtime.evaluate', {
    expression: `
      fetch('/api/development/demo-role-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'telecaller' })
      }).then(r => r.json())
    `,
    awaitPromise: true,
  });

  await send('Page.navigate', { url: 'http://localhost:3000/telecaller/dashboard' });
  await new Promise((r) => setTimeout(r, 4000));

  const evalRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const findByText = (t) => {
          const el = Array.from(document.querySelectorAll('*')).find(e => e.children.length === 0 && e.textContent.trim() === t);
          return el ? el.closest('.shadow-none') : null;
        };
        const rect = el => el ? {
          top: Math.round(el.getBoundingClientRect().top),
          bottom: Math.round(el.getBoundingClientRect().bottom),
          height: Math.round(el.getBoundingClientRect().height)
        } : null;

        const leftCol1 = document.querySelector('.space-y-4.xl\\\\:col-span-8');

        return JSON.stringify({
          leftCol1: rect(leftCol1),
          reqAttention: rect(findByText('Requires attention')),
          quickActions: rect(findByText('Quick actions')),
          needsCall: rect(findByText('Needs a call now')),
          recentLeads: rect(findByText('My recent leads')),
          tasksAlerts: rect(findByText('Tasks & alerts')),
        });
      })()
    `,
  });

  const measurements = JSON.parse(evalRes.result?.result?.value || '{}');
  fs.writeFileSync('/tmp/layout-measurements.json', JSON.stringify(measurements, null, 2));
  console.log('MEASUREMENTS WRITTEN TO /tmp/layout-measurements.json:');
  console.log(JSON.stringify(measurements, null, 2));

  ws.close();
  brave.kill();
}

main().catch(console.error);
