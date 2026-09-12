const fs = require('fs');
const { spawn } = require('child_process');

async function main() {
  const brave = spawn('/usr/bin/brave', [
    '--headless=new',
    '--no-sandbox',
    '--remote-debugging-port=9222',
    '--user-data-dir=/tmp/brave-test-profile',
  ]);

  // wait for brave to start listening
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
  const wsUrl = target.webSocketDebuggerUrl;

  const ws = new WebSocket(wsUrl);
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

  // Login via demo-role-login
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

  // Navigate to telecaller dashboard
  await send('Page.navigate', { url: 'http://localhost:3000/telecaller/dashboard' });
  await new Promise((r) => setTimeout(r, 4000));

  // Evaluate bounding rects of the cards
  const result = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const titles = Array.from(document.querySelectorAll('h3, .text-sm, .font-semibold, div, p'));
        const findCardByTitle = (t) => {
          const el = titles.find(e => e.textContent && e.textContent.trim() === t);
          return el ? el.closest('.rounded-xl, .shadow-none, [class*="border"]') : null;
        };

        const needsCall = findCardByTitle('Needs a call now');
        const reqAttention = findCardByTitle('Requires attention');
        const funnel = findCardByTitle('Lead pipeline funnel');
        const recentLeads = findCardByTitle('My recent leads');
        const tasksAlerts = findCardByTitle('Tasks & alerts');

        const rect = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
        };

        return {
          needsCall: rect(needsCall),
          reqAttention: rect(reqAttention),
          funnel: rect(funnel),
          recentLeads: rect(recentLeads),
          tasksAlerts: rect(tasksAlerts),
        };
      })()
    `,
    returnByValue: true,
  });

  console.log('MEASUREMENTS:', JSON.stringify(result.result?.result?.value, null, 2));

  await send('Target.closeTarget', { targetId: target.id });
  ws.close();
  brave.kill();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
