'use strict';

/**
 * browser.js
 * Motor de navegador (Puppeteer) usado como fallback ao axios/cheerio,
 * ou quando o Yupoo exigir JavaScript / bloquear requisicoes simples.
 *
 * Modos suportados (configurados pela UI):
 *  - 'chromium'      : usa o Chromium empacotado pelo Puppeteer.
 *  - 'brave-launch'  : inicia o Brave instalado na maquina (executablePath).
 *  - 'brave-connect' : conecta a um Brave JA ABERTO com porta de debug.
 *                      Abra o Brave assim (uma vez):
 *                      "brave.exe" --remote-debugging-port=9222
 *
 * O navegador fica vivo entre chamadas (reaproveitado) e so fecha em closeBrowser().
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let puppeteer = null;
function loadPuppeteer() {
  if (puppeteer) return puppeteer;
  // puppeteer inclui o Chromium; puppeteer-core e um fallback sem download.
  try {
    puppeteer = require('puppeteer');
  } catch (_) {
    puppeteer = require('puppeteer-core');
  }
  return puppeteer;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Config atual do motor. mode 'http' significa "nao usar navegador". */
let config = {
  mode: 'http',
  bravePath: null,
  browserURL: 'http://127.0.0.1:9222',
  headless: true,
};

/** @type {import('puppeteer').Browser|null} */
let browser = null;
let connected = false; // true quando conectado (nao devemos fechar o Brave do usuario)

/** Caminhos comuns de instalacao do Brave no Windows. */
function detectBravePath() {
  const candidates = [
    path.join(
      process.env['PROGRAMFILES'] || 'C:\\Program Files',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    ),
    path.join(
      process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    ),
    path.join(
      process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData\\Local'),
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    ),
  ];
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch (_) {
      return false;
    }
  }) || null;
}

/** Atualiza a configuracao do motor. Fecha instancia antiga se o modo mudou. */
async function configure(next = {}) {
  const prevMode = config.mode;
  config = { ...config, ...next };
  if (config.mode === 'brave-launch' && !config.bravePath) {
    config.bravePath = detectBravePath();
  }
  // Se mudou o modo/alvo, derruba a instancia atual para recriar sob demanda.
  if (prevMode !== config.mode) {
    await closeBrowser();
  }
  return status();
}

function status() {
  return {
    mode: config.mode,
    active: !!browser,
    connected,
    bravePath: config.bravePath || detectBravePath(),
    browserURL: config.browserURL,
    headless: config.headless,
  };
}

/** Garante um browser vivo conforme o modo configurado. */
async function ensureBrowser() {
  if (browser) return browser;
  const pptr = loadPuppeteer();

  if (config.mode === 'brave-connect') {
    // Conecta a um Brave/Chrome ja aberto com --remote-debugging-port.
    browser = await pptr.connect({
      browserURL: config.browserURL,
      defaultViewport: null,
    });
    connected = true;
    return browser;
  }

  const launchOpts = {
    headless: config.headless ? true : false,
    defaultViewport: { width: 1366, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--lang=pt-BR',
    ],
  };

  if (config.mode === 'brave-launch') {
    const bp = config.bravePath || detectBravePath();
    if (!bp) {
      throw new Error(
        'Brave nao encontrado. Informe o caminho do brave.exe ou use o modo Chromium.'
      );
    }
    launchOpts.executablePath = bp;
  }
  // modo 'chromium' -> usa o Chromium empacotado (sem executablePath).

  browser = await pptr.launch(launchOpts);
  connected = false;
  return browser;
}

/**
 * Abre a URL e devolve o HTML renderizado.
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.waitFor] seletor CSS a aguardar (opcional)
 * @param {number} [opts.timeout] ms (default 40000)
 */
async function getRenderedHtml(url, opts = {}) {
  const b = await ensureBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' });
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: opts.timeout || 40000,
    });
    if (opts.waitFor) {
      await page.waitForSelector(opts.waitFor, { timeout: 8000 }).catch(() => {});
    }
    // Rola a pagina para disparar lazy-load das imagens.
    await autoScroll(page).catch(() => {});
    return await page.content();
  } finally {
    await page.close().catch(() => {});
  }
}

/** Rola ate o fim para carregar imagens com loading="lazy". */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 600;
      const timer = setInterval(() => {
        const { scrollHeight } = document.body;
        window.scrollBy(0, step);
        total += step;
        if (total >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 120);
    });
  });
}

/** Fecha (ou desconecta) o navegador. */
async function closeBrowser() {
  if (!browser) return;
  try {
    if (connected) await browser.disconnect();
    else await browser.close();
  } catch (_) {
    /* ignora */
  }
  browser = null;
  connected = false;
}

/* -------------------------------------------------------------------------- */
/*  NAVEGADOR PARA PRECOS (instancia separada / "realista")                   */
/*                                                                            */
/*  Usado para abrir paginas de produto (Taobao/Weidian/Mulebuy) e ler o      */
/*  preco. Estrategia em escada, para "parecer realista":                     */
/*   1) Conecta ao Brave JA ABERTO (--remote-debugging-port) -> sessao logada */
/*   2) Inicia o Brave instalado no sistema (navegador real do usuario)       */
/*   3) Fallback: Chromium empacotado pelo Puppeteer                          */
/*                                                                            */
/*  Mantido separado do 'browser' de scraping do Yupoo para nao interferir.   */
/* -------------------------------------------------------------------------- */

/** @type {import('puppeteer').Browser|null} */
let priceBrowser = null;
let priceConnected = false;
let priceKind = null; // 'connect' | 'brave' | 'chromium'

async function ensurePriceBrowser() {
  if (priceBrowser) return priceBrowser;
  const pptr = loadPuppeteer();

  // 1) Brave ja aberto (mais realista: sessao/cookies do usuario).
  try {
    priceBrowser = await pptr.connect({
      browserURL: config.browserURL,
      defaultViewport: null,
    });
    priceConnected = true;
    priceKind = 'connect';
    return priceBrowser;
  } catch (_) {
    /* segue para o proximo nivel */
  }

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--lang=pt-BR',
  ];

  // 2) Brave instalado no sistema (navegador real).
  const bp = detectBravePath();
  if (bp) {
    priceBrowser = await pptr.launch({
      headless: false,
      executablePath: bp,
      defaultViewport: { width: 1366, height: 900 },
      args,
    });
    priceConnected = false;
    priceKind = 'brave';
    return priceBrowser;
  }

  // 3) Chromium empacotado.
  priceBrowser = await pptr.launch({
    headless: true,
    defaultViewport: { width: 1366, height: 900 },
    args,
  });
  priceConnected = false;
  priceKind = 'chromium';
  return priceBrowser;
}

/**
 * Abre a URL num navegador "realista" e devolve o HTML renderizado.
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.waitFor] seletor CSS a aguardar
 * @param {number} [opts.timeout] ms (default 45000)
 * @returns {Promise<{html:string, engine:string}>}
 */
async function renderPricePage(url, opts = {}) {
  const b = await ensurePriceBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' });
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: opts.timeout || 45000,
    });
    if (opts.waitFor) {
      await page.waitForSelector(opts.waitFor, { timeout: 8000 }).catch(() => {});
    }
    const html = await page.content();
    return { html, engine: priceKind || 'browser' };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Fecha (ou desconecta) o navegador de precos. */
async function closePriceBrowser() {
  if (!priceBrowser) return;
  try {
    if (priceConnected) await priceBrowser.disconnect();
    else await priceBrowser.close();
  } catch (_) {
    /* ignora */
  }
  priceBrowser = null;
  priceConnected = false;
  priceKind = null;
}

module.exports = {
  configure,
  status,
  getRenderedHtml,
  closeBrowser,
  detectBravePath,
  renderPricePage,
  closePriceBrowser,
  isBrowserMode: () => config.mode !== 'http',
};
