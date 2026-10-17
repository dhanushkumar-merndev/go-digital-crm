/*!
 * Go Digital Marketing CRM - website chat widget loader (v1).
 *
 *   <script src="https://<crm>/widget/v1/gdm-chat.js" data-key="wpk_..." async></script>
 *
 * Optional attributes: data-color="#2563eb", data-position="left", data-open="true".
 * The chat itself runs in an iframe served by the CRM; this file only draws the
 * launcher button and relays open/close messages. It holds no secrets.
 * Page API: window.GDMChat.open() / .close(); window event "gdm:lead" after a submit.
 */
(function () {
  'use strict';
  if (window.GDMChat) return;

  var script =
    document.currentScript ||
    document.querySelector('script[data-key][src*="/widget/v1/gdm-chat.js"]');
  if (!script) return;
  var key = script.getAttribute('data-key') || '';
  if (!/^wpk_[A-Za-z0-9_-]{24,64}$/.test(key)) {
    if (window.console) console.warn('[GDM chat] Missing or invalid data-key.');
    return;
  }
  var crmOrigin = new URL(script.src, location.href).origin;
  var color = /^#[0-9a-fA-F]{6}$/.test(script.getAttribute('data-color') || '')
    ? script.getAttribute('data-color')
    : '#2563eb';
  var left = script.getAttribute('data-position') === 'left';
  var side = left ? 'left' : 'right';

  var host = document.createElement('div');
  host.setAttribute('data-gdm-chat', '');
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;' + side + ':0;';
  var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;

  var style = document.createElement('style');
  style.textContent =
    ':host{all:initial}' +
    '.launcher{position:fixed;bottom:20px;' +
    side +
    ':20px;width:56px;height:56px;border:0;border-radius:50%;' +
    'cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;' +
    'box-shadow:0 4px 14px rgba(0,0,0,.18);transition:transform .15s ease}' +
    '.launcher:hover{transform:scale(1.05)}' +
    '.launcher:focus-visible{outline:3px solid rgba(37,99,235,.45);outline-offset:3px}' +
    '.launcher svg{width:26px;height:26px}' +
    '.frame{position:fixed;bottom:88px;' +
    side +
    ':20px;width:380px;height:600px;' +
    'max-height:calc(100vh - 108px);border:0;border-radius:16px;background:#fff;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.2);display:none;color-scheme:normal}' +
    '.frame.open{display:block}' +
    '@media (max-width:639px){.frame{inset:0;width:100%;height:100%;max-height:none;border-radius:0}' +
    '.launcher.hidden-mobile{display:none}}';
  root.appendChild(style);

  var chatIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var closeIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'launcher';
  launcher.style.background = color;
  launcher.setAttribute('aria-label', 'Open chat');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.innerHTML = chatIcon;
  root.appendChild(launcher);

  var frame = null;
  var ready = false;
  var isOpen = false;
  var readyTimer = null;

  function frameSrc() {
    var params = new URLSearchParams({
      page: (location.origin + location.pathname).slice(0, 500),
    });
    return crmOrigin + '/embed/chat/' + encodeURIComponent(key) + '?' + params.toString();
  }

  function ensureFrame() {
    if (frame) return;
    frame = document.createElement('iframe');
    frame.className = 'frame';
    frame.title = 'Chat';
    frame.src = frameSrc();
    frame.setAttribute('allow', 'clipboard-write');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    root.appendChild(frame);
    // A frame the CRM refuses (unknown key, domain not allowed) never reports ready.
    readyTimer = setTimeout(function () {
      if (!ready) unavailable();
    }, 20000);
  }

  function post(type) {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: type }, crmOrigin);
  }

  function open() {
    ensureFrame();
    isOpen = true;
    frame.classList.add('open');
    launcher.innerHTML = closeIcon;
    launcher.classList.add('hidden-mobile');
    launcher.setAttribute('aria-label', 'Close chat');
    launcher.setAttribute('aria-expanded', 'true');
    if (ready) post('gdm:open');
  }

  function close() {
    if (!frame) return;
    isOpen = false;
    frame.classList.remove('open');
    launcher.innerHTML = chatIcon;
    launcher.classList.remove('hidden-mobile');
    launcher.setAttribute('aria-label', 'Open chat');
    launcher.setAttribute('aria-expanded', 'false');
  }

  function unavailable() {
    if (readyTimer) clearTimeout(readyTimer);
    if (host.parentNode) host.parentNode.removeChild(host);
  }

  launcher.addEventListener('click', function () {
    if (isOpen) close();
    else open();
  });
  // Load the iframe on intent, not on every page view.
  launcher.addEventListener('pointerenter', ensureFrame, { once: true });
  launcher.addEventListener('focus', ensureFrame, { once: true });

  window.addEventListener('message', function (event) {
    if (event.origin !== crmOrigin || !frame || event.source !== frame.contentWindow) return;
    var data = event.data || {};
    if (data.type === 'gdm:ready') {
      ready = true;
      if (readyTimer) clearTimeout(readyTimer);
      if (typeof data.accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.accentColor))
        launcher.style.background = data.accentColor;
      if (isOpen) post('gdm:open');
    } else if (data.type === 'gdm:close') {
      close();
      launcher.focus();
    } else if (data.type === 'gdm:submitted') {
      try {
        window.dispatchEvent(new CustomEvent('gdm:lead', { detail: { source: 'website-chat' } }));
      } catch {
        // Old browsers without CustomEvent simply skip the analytics hook.
      }
    } else if (data.type === 'gdm:unavailable') {
      unavailable();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen) close();
  });

  window.GDMChat = { open: open, close: close };

  function mount() {
    document.body.appendChild(host);
    if (script.getAttribute('data-open') === 'true') open();
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
