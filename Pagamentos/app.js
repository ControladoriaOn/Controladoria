'use strict';

/* ============================================================================
   CONFIG
   ============================================================================ */
const CONFIG = Object.freeze({
  // ⬇️ SUBSTITUA PELA URL DO SEU WEB APP APÓS O DEPLOY
  DATA_URL: 'https://script.google.com/macros/s/AKfycbzm2fFfi9BtOlK4u6Ffq3BK0Q24P_59510wAeYduAxqWnZiO0j3MqOgAygDtkPKalZo/exec',
  NATUREZAS_URL: 'naturezas.json',
  FETCH_RETRIES: 3,
  FETCH_BACKOFF_MS: 600,
  SECTIONS: ['dashboard', 'realizados', 'previsto'],
  STALE_HOURS: 30,
  PAGE_SIZE: 50,
  SEARCH_DEBOUNCE_MS: 150,
  LOCALE: 'pt-BR',
});

/* ============================================================================
   UTILS
   ============================================================================ */
const Utils = {
  fmtBR(n) {
    return (n || 0).toLocaleString(CONFIG.LOCALE, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  },
  fmtBRInt(n) {
    return (n || 0).toLocaleString(CONFIG.LOCALE, { maximumFractionDigits: 0 });
  },
  fmtBRShort(n) {
    if (!n) return '0';
    if (Math.abs(n) >= 1e6) return (n/1e6).toLocaleString(CONFIG.LOCALE, {maximumFractionDigits:2}) + ' mi';
    if (Math.abs(n) >= 1e3) return (n/1e3).toLocaleString(CONFIG.LOCALE, {maximumFractionDigits:1}) + ' mil';
    return n.toLocaleString(CONFIG.LOCALE, {maximumFractionDigits:0});
  },
  fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
    if (isNaN(d)) return '—';
    return d.toLocaleDateString(CONFIG.LOCALE, { day: '2-digit', month: 'long', year: 'numeric' });
  },
  fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString(CONFIG.LOCALE, { day:'2-digit', month:'2-digit' }) + ' às ' +
           d.toLocaleTimeString(CONFIG.LOCALE, { hour:'2-digit', minute:'2-digit' });
  },
  truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n-1) + '…' : s;
  },
  pillClass(tipo) {
    return ({ NF: 'nf', BOL: 'bol', RD: 'rd', PA: 'pa', CIOT: 'ciot' })[tipo] || '';
  },
  compareRows(a, b, col, dir) {
    const va = a[col], vb = b[col];
    if (typeof va === 'number' || typeof vb === 'number') {
      return ((va || 0) - (vb || 0)) * dir;
    }
    return String(va || '').localeCompare(String(vb || ''), CONFIG.LOCALE) * dir;
  },
  isApprovalStatus(status) {
    return /aprova[cç][aã]o/i.test(status || '');
  },
  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  },
  debounce(fn, wait) {
    let timer = null;
    return function debounced(...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  },
  titleCase(s) {
    if (!s) return s;
    const low = ['de', 'da', 'do', 'dos', 'das', 'e', 'em', 'ou', 'a', 'o'];
    return s.toLowerCase().split(/\s+/).map((w, i) =>
      i > 0 && low.includes(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)
    ).join(' ');
  },
};

/* ============================================================================
   DATE UTILS
   ============================================================================ */
const DateUtils = {
  isWeekend(date) {
    const d = date.getDay();
    return d === 0 || d === 6;
  },
  fromISO(iso) {
    if (!iso) return null;
    const parts = iso.slice(0, 10).split('-');
    if (parts.length !== 3) return null;
    const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    return isNaN(d) ? null : d;
  },
  toISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  },
  nextBusinessDay(date) {
    const d = new Date(date);
    d.setDate(d.getDate() + 1);
    while (this.isWeekend(d)) d.setDate(d.getDate() + 1);
    return d;
  },
  ensureBusinessDay(date) {
    if (!this.isWeekend(date)) return new Date(date);
    const d = new Date(date);
    while (this.isWeekend(d)) d.setDate(d.getDate() + 1);
    return d;
  },
  weekdayName(date) {
    return date.toLocaleDateString(CONFIG.LOCALE, { weekday: 'long' });
  },
};

/* ============================================================================
   DOM — XSS-safe builder
   ============================================================================ */
const DOM = {
  h(tag, props, children) {
    const el = document.createElement(tag);
    if (props && typeof props === 'object') {
      for (const [key, val] of Object.entries(props)) {
        if (val == null || val === false) continue;
        if (key === 'class' || key === 'className') el.className = val;
        else if (key === 'text') el.textContent = val;
        else if (key === 'dataset') Object.assign(el.dataset, val);
        else if (key === 'style' && typeof val === 'object') Object.assign(el.style, val);
        else if (key.startsWith('on') && typeof val === 'function') {
          el.addEventListener(key.slice(2).toLowerCase(), val);
        } else {
          el.setAttribute(key, val);
        }
      }
    }
    this._append(el, children);
    return el;
  },
  _append(parent, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) {
      for (const c of child) this._append(parent, c);
      return;
    }
    if (child instanceof Node) { parent.appendChild(child); return; }
    parent.appendChild(document.createTextNode(String(child)));
  },
  icon(cls) {
    return this.h('i', { class: 'fa-solid ' + cls, 'aria-hidden': 'true' });
  },
  pill(text, extraCls) {
    const cls = 'pill' + (extraCls ? ' ' + extraCls : '');
    return this.h('span', { class: cls }, text || '—');
  },
  clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  },
  byId(id) { return document.getElementById(id); },
};

/* ============================================================================
   DATA SERVICE
   ============================================================================ */
const DataService = {
  async fetchWithRetry(url, { retries = CONFIG.FETCH_RETRIES, backoff = CONFIG.FETCH_BACKOFF_MS, silent404 = false } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) {
          if (silent404 && response.status === 404) throw new Error('404');
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        return response;
      } catch (err) {
        lastError = err;
        if (silent404 && err.message === '404') throw err;
        if (attempt < retries) {
          const waitMs = backoff * Math.pow(2, attempt);
          console.warn(`[DataService] ${url} — tentativa ${attempt+1} falhou: ${err.message}. Aguardando ${waitMs}ms…`);
          await Utils.delay(waitMs);
        }
      }
    }
    throw lastError;
  },

  async loadData() {
    const url = CONFIG.DATA_URL + '?v=' + Date.now();
    const response = await this.fetchWithRetry(url);
    const json = await response.json();
    this._validateData(json);
    return json;
  },

  async loadNaturezas() {
    try {
      const url = CONFIG.NATUREZAS_URL + '?v=' + Date.now();
      const response = await this.fetchWithRetry(url, { retries: 1, silent404: true });
      const json = await response.json();
      if (!json || typeof json !== 'object') return {};
      return json;
    } catch (err) {
      console.info('[DataService] naturezas.json não disponível — seguindo sem o mapa.');
      return {};
    }
  },

  _validateData(data) {
    if (!data || typeof data !== 'object') throw new Error('Resposta não é um objeto JSON válido');
    if (!data.meta || !data.pago_hoje || !data.previsto_amanha) {
      throw new Error('Estrutura do data.json está incompleta');
    }
  },
};

/* ============================================================================
   NATUREZA MAP
   ============================================================================ */
const NaturezaMap = {
  _map: {},
  set(obj) {
    this._map = obj && typeof obj === 'object' ? obj : {};
  },
  /* Devolve a entrada bruta (string OU objeto {descricao,conta_fluxo,fluxo_caixa}). */
  _entry(code) {
    if (!code && code !== 0) return null;
    return this._map[String(code).trim()] || null;
  },
  /* Extrai um campo da entrada — funciona tanto p/ formato antigo (string)
     quanto p/ o novo (objeto). Antes só existia a descrição como string. */
  _field(code, name) {
    const e = this._entry(code);
    if (!e) return '';
    if (typeof e === 'string') return name === 'descricao' ? e : '';
    return e[name] || '';
  },
  /* Compatível com chamadas legadas: devolve só a descrição (raw). */
  get(code) {
    return this._field(code, 'descricao') || null;
  },
  describe(code) {
    const desc = this._field(code, 'descricao');
    return desc ? Utils.titleCase(desc) : null;
  },
  contaFluxo(code) { return this._field(code, 'conta_fluxo'); },
  fluxoCaixa(code) { return this._field(code, 'fluxo_caixa'); },
  size() {
    return Object.keys(this._map).length;
  },
};

/* ============================================================================
   UI_SIDEBAR
   ============================================================================ */
const UI_Sidebar = {
  updateStamp(data) {
    const stamp = DOM.byId('stamp');
    const text = DOM.byId('stamp-text');
    if (!stamp || !text) return;

    if (!data || !data.meta || !data.meta.generated_at) {
      stamp.className = 'sidebar-stamp error';
      text.textContent = 'sem dados';
      return;
    }

    const generated = new Date(data.meta.generated_at);
    const hoursAgo = (Date.now() - generated.getTime()) / 36e5;

    if (hoursAgo > CONFIG.STALE_HOURS) {
      stamp.className = 'sidebar-stamp stale';
      const days = Math.floor(hoursAgo / 24);
      text.textContent = `dados de ${days}d atrás`;
    } else {
      stamp.className = 'sidebar-stamp';
      text.textContent = `atualizado em ${Utils.fmtDateTime(data.meta.generated_at)}`;
    }
  },

  setError() {
    const stamp = DOM.byId('stamp');
    const text = DOM.byId('stamp-text');
    if (stamp) stamp.className = 'sidebar-stamp error';
    if (text) text.textContent = 'falha ao carregar';
  },
};

/* ============================================================================
   PAGINATION WIDGET
   ============================================================================ */
const Pagination = {
  render({ page, pageSize, total, onPage }) {
    if (total <= pageSize) return null;

    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);

    const info = DOM.h('div', { class: 'pagination-info' }, [
      'Mostrando ',
      DOM.h('strong', {}, String(start)),
      ' a ',
      DOM.h('strong', {}, String(end)),
      ' de ',
      DOM.h('strong', {}, String(total)),
    ]);

    const controls = DOM.h('div', { class: 'pagination-controls' });

    const mkBtn = (label, targetPage, { disabled = false, active = false, ariaLabel } = {}) => {
      const btn = DOM.h('button', {
        class: 'page-btn' + (active ? ' active' : ''),
        type: 'button',
        disabled: disabled || null,
        'aria-label': ariaLabel || label,
      }, label);
      if (!disabled && !active) {
        btn.addEventListener('click', () => onPage(targetPage));
      }
      return btn;
    };

    controls.appendChild(mkBtn(DOM.icon('fa-angles-left'), 1, { disabled: page === 1, ariaLabel: 'Primeira página' }));
    controls.appendChild(mkBtn(DOM.icon('fa-angle-left'), page - 1, { disabled: page === 1, ariaLabel: 'Anterior' }));

    const pages = this._computePageList(page, totalPages);
    for (const p of pages) {
      if (p === '…') {
        controls.appendChild(DOM.h('span', { class: 'page-ellipsis' }, '…'));
      } else {
        controls.appendChild(mkBtn(String(p), p, { active: p === page, ariaLabel: `Página ${p}` }));
      }
    }

    controls.appendChild(mkBtn(DOM.icon('fa-angle-right'), page + 1, { disabled: page === totalPages, ariaLabel: 'Próxima' }));
    controls.appendChild(mkBtn(DOM.icon('fa-angles-right'), totalPages, { disabled: page === totalPages, ariaLabel: 'Última página' }));

    return DOM.h('div', { class: 'pagination' }, [info, controls]);
  },

  _computePageList(current, total) {
    const pages = [];
    const window = 1;
    for (let i = 1; i <= total; i++) {
      if (i === 1 || i === total || (i >= current - window && i <= current + window)) {
        pages.push(i);
      } else if (pages[pages.length - 1] !== '…') {
        pages.push('…');
      }
    }
    return pages;
  },
};

/* ============================================================================
   UI_DASHBOARD
   ============================================================================ */
const UI_Dashboard = {
  render(data) {
    return DOM.h('section', { id: 'dashboard', class: 'reveal' }, [
      this._renderSectionHead(data.meta),
      this._renderAlerts(data),
      this._renderKPIs(data),
    ]);
  },

  _renderSectionHead(meta) {
    return DOM.h('div', { class: 'section-head' }, [
      DOM.h('div', { class: 'section-head-left' }, [
        DOM.h('h2', { class: 'section-title' }, [DOM.icon('fa-gauge-high'), 'Dashboard']),
        DOM.h('p', { class: 'section-sub' }, 'Visão consolidada de hoje e amanhã'),
      ]),
      DOM.h('span', { class: 'date-badge' }, [
        DOM.icon('fa-calendar'),
        Utils.fmtDate(meta.data_hoje),
      ]),
    ]);
  },

  _renderAlerts(data) {
    const alerts = this._buildAlerts(data);
    if (!alerts.length) return null;
    return DOM.h('div', { class: 'alerts' }, alerts);
  },

  _buildAlerts(data) {
    const arr = [];
    const { previsto_amanha: prev, pago_hoje: hoje } = data;

    const dataHoje = DateUtils.fromISO(data.meta.data_hoje);
    if (dataHoje && DateUtils.isWeekend(dataHoje)) {
      const wd = DateUtils.weekdayName(dataHoje);
      arr.push(this._buildAlert('info', 'fa-circle-info', [
        DOM.h('strong', {}, `Dados gerados num ${wd}`),
        DOM.h('small', {}, 'Como pagamentos ocorrem apenas em dias úteis, confira se deseja atualizar.'),
      ]));
    }

    if (prev.em_aprovacao > 0) {
      arr.push(this._buildAlert('warn', 'fa-triangle-exclamation', [
        DOM.h('strong', {}, `${prev.em_aprovacao} títulos pendentes de aprovação`),
      ]));
    }

    if (prev.total > hoje.total * 1.5 && hoje.total > 0) {
      const mult = (prev.total / hoje.total).toFixed(1);
      arr.push(this._buildAlert('info', 'fa-arrow-trend-up', [
        DOM.h('strong', {}, `Prévia de amanhã ${mult}× maior que hoje`),
      ]));
    }

    const forns = prev.nf_servico.concat(prev.nf_titulo, prev.reembolso)
      .map(x => (x.fornecedor || '').toUpperCase()).filter(Boolean);
    const hojeSet = new Set(hoje.titulos.map(t => (t.fornecedor || '').toUpperCase()).filter(Boolean));
    const recorrentes = [...new Set(forns.filter(f => hojeSet.has(f)))];
    if (recorrentes.length) {
      const plural = recorrentes.length > 1;
      const exemplos = recorrentes.slice(0, 2).map(s => Utils.truncate(s, 28)).join(', ');
      const more = recorrentes.length > 2 ? ' e mais' : '';
      arr.push(this._buildAlert('ok', 'fa-rotate', [
        DOM.h('strong', {}, `${recorrentes.length} fornecedor${plural?'es':''} recorrente${plural?'s':''}`),
        DOM.h('small', {}, `Apareceram hoje e voltam amanhã. Ex.: ${exemplos}${more}.`),
      ]));
    }

    return arr;
  },

  _buildAlert(kind, iconCls, contentNodes) {
    return DOM.h('div', { class: 'alert ' + kind, role: 'alert' }, [
      DOM.h('div', { class: 'alert-icon' }, DOM.icon(iconCls)),
      DOM.h('div', {}, contentNodes),
    ]);
  },

  _renderKPIs(data) {
    const { pago_hoje: hoje, previsto_amanha: prev, meta } = data;
    const maiorNat = (hoje.maior && hoje.maior.natureza)
      ? (NaturezaMap.describe(hoje.maior.natureza) || `Natureza ${hoje.maior.natureza}`)
      : '—';

    return DOM.h('div', { class: 'kpi-grid' }, [
      this._buildKPI({
        accent: true, icon: 'fa-check-circle', label: 'Pago hoje',
        value: hoje.total,
        sub: `${hoje.quantidade} títulos · ${Utils.fmtDate(meta.data_hoje)}`,
      }),
      this._buildKPI({
        icon: 'fa-calendar-day', label: 'Previsto amanhã',
        value: prev.total,
        sub: `${prev.quantidade} títulos · ${Utils.fmtDate(meta.data_amanha)}`,
      }),
      this._buildKPI({
        icon: 'fa-trophy', label: 'Maior pagamento hoje',
        value: (hoje.maior && hoje.maior.valor) || 0,
        subNode: DOM.h('span', { title: maiorNat }, Utils.truncate(maiorNat, 30)),
      }),
      this._buildKPIPlain({
        icon: 'fa-triangle-exclamation', label: 'Pend. de aprovação',
        value: String(prev.em_aprovacao),
        subNode: DOM.h('span', {}, [
          DOM.h('span', { class: 'kpi-chip' }, 'risco'),
          ` dos ${prev.quantidade} previstos`,
        ]),
      }),
    ]);
  },

  _buildKPI({ accent, icon, label, value, sub, subNode }) {
    return DOM.h('div', { class: 'kpi' + (accent ? ' accent' : '') }, [
      DOM.h('p', { class: 'kpi-label' }, [DOM.icon(icon), label]),
      DOM.h('div', { class: 'kpi-value' }, [
        DOM.h('span', { class: 'prefix' }, 'R$'),
        Utils.fmtBRInt(value),
      ]),
      DOM.h('p', { class: 'kpi-sub' }, subNode || sub),
    ]);
  },

  _buildKPIPlain({ icon, label, value, subNode }) {
    return DOM.h('div', { class: 'kpi' }, [
      DOM.h('p', { class: 'kpi-label' }, [DOM.icon(icon), label]),
      DOM.h('div', { class: 'kpi-value' }, value),
      DOM.h('p', { class: 'kpi-sub' }, subNode),
    ]);
  },
};

/* ============================================================================
   COMMON — builders de células reutilizáveis
   ============================================================================ */

function buildFornecedorCell(fornecedor, historicoRaw) {
  const children = [fornecedor || '—'];
  const hasHist = historicoRaw && String(historicoRaw).trim();
  if (hasHist) {
    children.push(DOM.h('div', { class: 'hist' }, Utils.truncate(String(historicoRaw), 90)));
  }
  return DOM.h('div', {}, children);
}

function buildDescNatCell(natCode) {
  const desc = NaturezaMap.describe(natCode);
  if (!desc) return DOM.h('span', { class: 'nat-empty' }, '—');
  return DOM.h('span', { class: 'nat-desc' }, desc);
}

function buildBorderoCell(bordero) {
  const v = (bordero || '').trim();
  if (!v) return DOM.h('span', { class: 'nat-empty' }, '—');
  const isManual = v.toLowerCase() === 'manual';
  return DOM.h('span', {
    class: 'pill ' + (isManual ? 'bord-manual' : 'bord-auto'),
  }, v);
}

/* ============================================================================
   UI_HOJE — Pagamentos Realizados
   ============================================================================ */
const UI_Hoje = {
  _state: null,
  _data: null,
  _meta: null,
  _els: null,
  _debouncedSearch: null,

  render(data) {
    this._data = data.pago_hoje;
    this._meta = data.meta;
    this._state = {
      filter: { q: '', tipo: null },
      sort:   { col: 'valor_rs', dir: -1 },
      page: 1,
      pageSize: CONFIG.PAGE_SIZE,
    };

    const section = DOM.h('section', { id: 'realizados', class: 'reveal' }, [
      this._renderSectionHead(),
      this._renderCard(),
    ]);

    this._debouncedSearch = Utils.debounce(value => {
      this._state.filter.q = value;
      this._state.page = 1;
      this._refresh();
    }, CONFIG.SEARCH_DEBOUNCE_MS);

    this._refresh();
    return section;
  },

  _renderSectionHead() {
    const exportBtn = DOM.h('button', {
      class: 'btn-export', type: 'button', title: 'Exportar a tabela para Excel (.xlsx)',
    }, [DOM.icon('fa-file-excel'), 'Exportar Excel']);
    exportBtn.addEventListener('click', () => this._exportXlsx());
    if (!this._data.titulos || !this._data.titulos.length) exportBtn.disabled = true;

    return DOM.h('div', { class: 'section-head' }, [
      DOM.h('div', { class: 'section-head-left' }, [
        DOM.h('h2', { class: 'section-title' }, [DOM.icon('fa-check-double'), 'Pagamentos Realizados']),
        DOM.h('p', { class: 'section-sub' },
          `${this._data.quantidade} títulos liquidados · Total R$ ${Utils.fmtBR(this._data.total)}`),
      ]),
      DOM.h('div', { class: 'section-head-right' }, [
        DOM.h('span', { class: 'date-badge' }, [
          DOM.icon('fa-calendar-check'),
          Utils.fmtDate(this._meta.data_hoje),
        ]),
        exportBtn,
      ]),
    ]);
  },

  /* Exporta a tabela de Pagamentos Realizados para .xlsx no modelo do
     RELATÓRIO CONTAS A PAGAR (12 colunas + título + linha de total). */
  _exportXlsx() {
    if (typeof XLSX === 'undefined') {
      console.error('[Export] Biblioteca XLSX não carregou.');
      alert('Não foi possível gerar o Excel: a biblioteca não carregou. Verifique sua conexão e recarregue a página.');
      return;
    }
    const titulos = (this._data && this._data.titulos) || [];

    const fmtDateBR = iso => {
      if (!iso) return '';
      const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
      return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso);
    };
    // Devolve número quando o valor é só dígitos (para Natureza, Conta Fluxo, Bordero etc.).
    const numOrStr = v => {
      if (v === null || v === undefined || v === '') return '';
      const s = String(v).trim();
      return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
    };

    const dataHoje = (this._meta && this._meta.data_hoje) || '';
    const dataLabel = fmtDateBR(dataHoje) || '—';

    // 13 colunas — espelho fiel do RELATÓRIO CONTAS A PAGAR ON TIME +
    // uma coluna nova "Desc. Natureza" logo ao lado do código.
    // Conta Fluxo e Fluxo Caixa: se o dado não veio no upload, busca pelo código
    // da natureza no naturezas.json (mesma lógica do VLOOKUP do relatório).
    const COLS = [
      { h: 'Banco',          get: t => t.banco || '',                         w:  7.0, center: true },
      { h: 'No. Titulo',     get: t => numOrStr(t.numero),                    w: 12.2, center: true },
      { h: 'Tipo',           get: t => t.tipo || '',                          w:  7.2, center: true },
      { h: 'Natureza',       get: t => numOrStr(t.natureza),                  w: 11.3, center: true },
      { h: 'Desc. Natureza', get: t => NaturezaMap.describe(t.natureza) || '',w: 28.0 },
      { h: 'Conta Fluxo C',  get: t => numOrStr(t.conta_fluxo || NaturezaMap.contaFluxo(t.natureza)),
                                                                              w:  9.0, center: true },
      { h: 'Fluxo Caixa',    get: t => t.fluxo_caixa || NaturezaMap.fluxoCaixa(t.natureza) || '',
                                                                              w: 25.1 },
      { h: 'Nome Fornece',   get: t => t.fornecedor || '',                    w: 18.8 },
      { h: 'Vencto Real',    get: t => fmtDateBR(t.vencimento),               w: 13.4, center: true, peach: true },
      { h: 'Vlr.Titulo',     get: t => Number(t.valor) || 0,                  w: 11.3, num: true },
      { h: 'Historico',      get: t => t.historico || '',                     w: 36.3 },
      { h: 'Saldo',          get: t => Number(t.valor_rs) || 0,               w: 11.6, num: true },
      { h: 'Bordero',        get: t => numOrStr(t.bordero),                   w:  9.9, center: true },
    ];
    const N = COLS.length;

    // Layout do relatório original:
    // r1 vazia · r2 título (mesclado) · r3 vazia · r4 header · r5+ dados · 2 vazias · total
    const aoa = [];
    aoa.push([]);                                                    // r1
    aoa.push([`RELATÓRIO CONTAS A PAGAR ON TIME - ${dataLabel}`]);    // r2 (mesclado)
    aoa.push([]);                                                    // r3
    aoa.push(COLS.map(c => c.h));                                    // r4: header
    titulos.forEach(t => aoa.push(COLS.map(c => c.get(t))));         // r5+: dados
    aoa.push([]);                                                    // vazia
    aoa.push([]);                                                    // vazia
    const idxHist  = COLS.findIndex(c => c.h === 'Historico');
    const idxSaldo = COLS.findIndex(c => c.h === 'Saldo');
    const total = titulos.reduce((s, t) => s + (Number(t.valor_rs) || 0), 0);
    const linhaTotal = new Array(N).fill('');
    linhaTotal[idxHist]  = 'TOTAL A PAGAR ';
    linhaTotal[idxSaldo] = total;
    aoa.push(linhaTotal);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = COLS.map(c => ({ wch: c.w }));
    ws['!merges'] = [{ s: { r: 1, c: 0 }, e: { r: 1, c: N - 1 } }];
    ws['!rows'] = [{ hpt: 6 }, { hpt: 22 }, { hpt: 6 }, { hpt: 20 }];

    const PEACH  = 'F8CBAD';
    const ORANGE = 'FFC000';
    const ACCFMT = '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-';
    const lastRow = aoa.length;
    const firstData = 4;
    const lastData  = 4 + titulos.length - 1;

    for (let r = 0; r < lastRow; r++) {
      for (let c = 0; c < N; c++) {
        const addr = XLSX.utils.encode_cell({ r: r, c: c });
        let cell = ws[addr];
        if (!cell) { cell = { v: '', t: 's' }; ws[addr] = cell; }

        if (r === 1) {                       // título mesclado
          cell.s = {
            font: { bold: true, sz: 12, color: { rgb: '7B3F00' } },
            fill: { patternType: 'solid', fgColor: { rgb: PEACH } },
            alignment: { horizontal: 'center', vertical: 'center' },
          };
        } else if (r === 3) {                // header
          cell.s = {
            font: { bold: true, sz: 9 },
            fill: { patternType: 'solid', fgColor: { rgb: PEACH } },
            alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          };
        } else if (r === lastRow - 1) {      // linha do TOTAL
          const halign = (c === idxHist || c === idxSaldo) ? 'right' : 'center';
          cell.s = {
            font: { bold: true, sz: 9 },
            alignment: { horizontal: halign, vertical: 'center' },
          };
          if (c === idxSaldo) cell.z = ACCFMT;
        } else if (r >= firstData && r <= lastData) {  // linhas de dados
          const def = COLS[c];
          const halign = def.center ? 'center' : (def.num ? 'right' : 'left');
          let fillColor = null;
          if (c === 0) fillColor = ORANGE;       // Banco
          else if (def.peach) fillColor = PEACH; // Vencto Real
          const style = {
            font: { sz: 8 },
            alignment: { horizontal: halign, vertical: 'center' },
          };
          if (fillColor) style.fill = { patternType: 'solid', fgColor: { rgb: fillColor } };
          cell.s = style;
          if (def.num) cell.z = ACCFMT;
        }
      }
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pagamentos Realizados');
    XLSX.writeFile(wb, `pagamentos-realizados-${dataHoje || 'export'}.xlsx`);
  },

  _columns() {
    const cols = [
      { key: 'tipo',       label: 'Tipo',
        renderCell: t => DOM.pill(t.tipo || '?', Utils.pillClass(t.tipo)) },
      { key: 'numero',     label: 'Título',
        renderCell: t => String(t.numero || '—') },
      { key: 'fornecedor', label: 'Fornecedor',
        renderCell: t => buildFornecedorCell(t.fornecedor, t.historico) },
      { key: 'natureza',   label: 'Desc. Nat.',
        renderCell: t => buildDescNatCell(t.natureza) },
      { key: 'bordero',    label: 'Bordero', center: true,
        renderCell: t => buildBorderoCell(t.bordero) },
      { key: 'valor_rs',   label: 'Valor',
        num: true, strong: true, center: true,
        renderCell: t => `R$ ${Utils.fmtBR(t.valor_rs)}` },
    ];
    // O botão "→ Amanhã" é uma ação de edição: só aparece pra quem entrou
    // pelo hub / atualizar (mesma regra do botão "Voltar ao Hub").
    if (HubLink.cameFromHub()) {
      cols.push({
        key: '_acoes', label: '', center: true, noSort: true,
        renderCell: t => {
          const btn = DOM.h('button', {
            class: 'btn-row-action', type: 'button',
            title: 'Postergar este pagamento para amanhã',
          }, [DOM.icon('fa-clock-rotate-left'), 'Amanhã']);
          btn.addEventListener('click', e => {
            e.stopPropagation();
            App.postergar(t);
          });
          return btn;
        },
      });
    }
    return cols;
  },

  _renderCard() {
    const cols = this._columns();
    const tipos = [...new Set(this._data.titulos.map(t => t.tipo).filter(Boolean))].sort();

    const searchInput = DOM.h('input', {
      id: 'hoje-search',
      placeholder: 'Buscar fornecedor, histórico, título...',
      type: 'text',
      'aria-label': 'Buscar pagamentos realizados',
    });
    searchInput.addEventListener('input', e => this._debouncedSearch(e.target.value));

    const searchBox = DOM.h('div', { class: 'search' }, [
      DOM.icon('fa-magnifying-glass'),
      searchInput,
    ]);

    const allChip = this._buildFilterChip('', 'Todos', null, true);
    const tipoChips = tipos.map(t => this._buildFilterChip(t, t, Utils.pillClass(t), false));
    const chips = [allChip, ...tipoChips];

    const countEl = DOM.h('strong', { id: 'hoje-count' }, '0');
    const totalEl = DOM.h('strong', { id: 'hoje-total' }, 'R$ 0,00');

    const toolbarRight = DOM.h('div', { class: 'toolbar-right' }, [
      DOM.h('span', { class: 'lbl' }, 'Total'),
      countEl,
      DOM.h('span', { class: 'divider' }),
      DOM.h('span', { class: 'lbl' }, 'Soma'),
      totalEl,
    ]);

    const toolbar = DOM.h('div', { class: 'toolbar' }, [searchBox, ...chips, toolbarRight]);

    const thead = DOM.h('thead', {}, DOM.h('tr', {},
      cols.map(c => {
        const th = DOM.h('th', {
          class: [c.num ? 'num' : '', c.center ? 'center' : ''].filter(Boolean).join(' ') || null,
          dataset: { key: c.key },
        }, c.label);
        th.addEventListener('click', () => {
          if (this._state.sort.col === c.key) this._state.sort.dir *= -1;
          else { this._state.sort.col = c.key; this._state.sort.dir = 1; }
          this._state.page = 1;
          this._refresh();
        });
        return th;
      })
    ));

    const tbody = DOM.h('tbody', { id: 'hoje-tbody' });
    const tfoot = DOM.h('tfoot', { class: 'data', id: 'hoje-tfoot' });
    const table = DOM.h('table', { class: 'data' }, [thead, tbody, tfoot]);
    const tableWrap = DOM.h('div', { class: 'table-wrap' }, table);

    const paginationMount = DOM.h('div', { id: 'hoje-pagination' });

    this._els = { tbody, tfoot, countEl, totalEl, thead, chips, cols, paginationMount };

    return DOM.h('div', { class: 'card' }, [toolbar, tableWrap, paginationMount]);
  },

  _buildFilterChip(tipoValue, label, pillCls, isActive) {
    const chip = DOM.h('button', {
      class: 'filter-chip' + (isActive ? ' active' : ''),
      dataset: { tipo: tipoValue },
      type: 'button',
    }, pillCls ? DOM.pill(label, pillCls) : label);

    chip.addEventListener('click', () => {
      if (!this._els || !this._els.chips) return;
      this._els.chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      this._state.filter.tipo = tipoValue || null;
      this._state.page = 1;
      this._refresh();
    });
    return chip;
  },

  _filterAndSort() {
    const { q, tipo } = this._state.filter;
    const { col, dir } = this._state.sort;

    const rows = this._data.titulos.filter(t => {
      if (tipo && t.tipo !== tipo) return false;
      if (q) {
        const query = q.toLowerCase();
        const natDesc = NaturezaMap.get(t.natureza) || '';
        const blob = [t.fornecedor, t.historico, t.numero, t.natureza, natDesc, t.bordero, t.banco]
          .map(v => (v || '').toString().toLowerCase())
          .join(' ');
        if (!blob.includes(query)) return false;
      }
      return true;
    });

    rows.sort((a, b) => Utils.compareRows(a, b, col, dir));
    return rows;
  },

  _refresh() {
    if (!this._els) return;
    const { tbody, tfoot, countEl, totalEl, thead, cols, paginationMount } = this._els;
    const { col, dir } = this._state.sort;

    const allFiltered = this._filterAndSort();
    const total = allFiltered.reduce((s, t) => s + (t.valor_rs || 0), 0);
    countEl.textContent = String(allFiltered.length);
    totalEl.textContent = 'R$ ' + Utils.fmtBR(total);

    const start = (this._state.page - 1) * this._state.pageSize;
    const pageRows = allFiltered.slice(start, start + this._state.pageSize);

    DOM.clear(tbody);
    if (pageRows.length === 0) {
      tbody.appendChild(DOM.h('tr', {},
        DOM.h('td', { class: 'empty-row', colspan: cols.length }, 'Nenhum resultado')
      ));
    } else {
      for (const t of pageRows) tbody.appendChild(this._renderRow(t, cols));
    }

    DOM.clear(tfoot);
    const spanCount = cols.length - 1;
    tfoot.appendChild(DOM.h('tr', {}, [
      DOM.h('td', { colspan: spanCount }, `Total exibido (${allFiltered.length} de ${this._data.titulos.length})`),
      DOM.h('td', { class: 'num center' }, 'R$ ' + Utils.fmtBR(total)),
    ]));

    DOM.clear(paginationMount);
    const pag = Pagination.render({
      page: this._state.page,
      pageSize: this._state.pageSize,
      total: allFiltered.length,
      onPage: p => { this._state.page = p; this._refresh(); this._scrollToTop(); },
    });
    if (pag) paginationMount.appendChild(pag);

    thead.querySelectorAll('th').forEach(th => {
      const isSorted = th.dataset.key === col;
      th.classList.toggle('sorted', isSorted);
      th.dataset.dir = isSorted ? (dir > 0 ? ' ↑' : ' ↓') : '';
    });
  },

  _scrollToTop() {
    const sec = document.getElementById('realizados');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  _renderRow(t, cols) {
    const tr = DOM.h('tr', {});
    for (const c of cols) {
      const classes = [];
      if (c.num) classes.push('num');
      if (c.strong) classes.push('strong');
      if (c.center) classes.push('center');
      const td = DOM.h('td', { class: classes.join(' ') || null });
      DOM._append(td, c.renderCell(t));
      tr.appendChild(td);
    }
    return tr;
  },
};

/* ============================================================================
   UI_PREVISTO — Prévia de Pagamentos
   ============================================================================ */
const UI_Previsto = {
  _state: null,
  _data: null,
  _meta: null,
  _els: null,
  _cats: null,
  _debouncedSearch: null,

  render(data) {
    this._data = data.previsto_amanha;
    this._meta = data.meta;

    this._cats = [
      { key: 'nf_servico', label: 'NFs de Serviço', icon: 'fa-truck',        data: this._data.nf_servico },
      { key: 'nf_titulo',  label: 'Contas',          icon: 'fa-file-invoice', data: this._data.nf_titulo },
      { key: 'reembolso',  label: 'Reembolsos',     icon: 'fa-receipt',      data: this._data.reembolso },
    ];
    if (this._data.postergados && this._data.postergados.length) {
      this._cats.push({
        key: 'postergados', label: 'Postergados', icon: 'fa-clock-rotate-left',
        data: this._data.postergados,
      });
    }

    const activeCat = this._cats.reduce((a, b) => a.data.length >= b.data.length ? a : b).key;

    this._state = {
      activeCat,
      filter: { q: '' },
      sort:   { col: 'valor_total', dir: -1 },
      page: 1,
      pageSize: CONFIG.PAGE_SIZE,
    };

    const section = DOM.h('section', { id: 'previsto', class: 'reveal' }, [
      this._renderSectionHead(),
      this._renderCard(),
    ]);

    this._debouncedSearch = Utils.debounce(value => {
      this._state.filter.q = value;
      this._state.page = 1;
      this._refresh();
    }, CONFIG.SEARCH_DEBOUNCE_MS);

    this._refresh();
    return section;
  },

  _renderSectionHead() {
    return DOM.h('div', { class: 'section-head' }, [
      DOM.h('div', { class: 'section-head-left' }, [
        DOM.h('h2', { class: 'section-title' }, [DOM.icon('fa-calendar-day'), 'Prévia de Pagamentos']),
        DOM.h('p', { class: 'section-sub' },
          `${this._data.quantidade} títulos previstos · Total R$ ${Utils.fmtBR(this._data.total)}`),
      ]),
      DOM.h('span', { class: 'date-badge' }, [
        DOM.icon('fa-calendar'),
        Utils.fmtDate(this._meta.data_amanha),
      ]),
    ]);
  },

  _columnsFor(catKey) {
    const common = {
      aprovador: { key: 'aprovador',   label: 'Aprovador', renderCell: r => r.aprovador || '—' },
      status:    { key: 'status',      label: 'Status',    renderCell: r => this._renderStatus(r.status) },
      valor:     { key: 'valor_total', label: 'Valor',     num: true, strong: true, center: true,
                   renderCell: r => `R$ ${Utils.fmtBR(r.valor_total)}` },
      descNat:   { key: 'natureza_cod', label: 'Desc. Nat.',
                   renderCell: r => buildDescNatCell(r.natureza_cod) },
    };

    if (catKey === 'nf_servico') {
      return [
        { key: 'numero_nf',   label: 'NF',         renderCell: r => r.numero_nf || '—' },
        { key: 'fornecedor',  label: 'Fornecedor',
          renderCell: r => buildFornecedorCell(r.fornecedor, r.observacoes) },
        common.descNat,
        common.aprovador,
        common.status,
        common.valor,
      ];
    }
    if (catKey === 'nf_titulo') {
      return [
        { key: 'numero_titulo', label: 'Título', renderCell: r => r.numero_titulo || '—' },
        { key: 'fornecedor',    label: 'Fornecedor',
          renderCell: r => buildFornecedorCell(r.fornecedor, r.historico) },
        common.descNat,
        common.aprovador,
        common.status,
        common.valor,
      ];
    }
    if (catKey === 'postergados') {
      return [
        { key: 'tipo',       label: 'Tipo',       renderCell: r => DOM.pill(r.tipo || '?', Utils.pillClass(r.tipo)) },
        { key: 'numero',     label: 'Título',     renderCell: r => String(r.numero || '—') },
        { key: 'fornecedor', label: 'Fornecedor', renderCell: r => buildFornecedorCell(r.fornecedor, r.historico) },
        { key: 'natureza',   label: 'Desc. Nat.', renderCell: r => buildDescNatCell(r.natureza) },
        { key: 'bordero',    label: 'Bordero',    center: true,
          renderCell: r => buildBorderoCell(r.bordero) },
        { key: 'valor_rs',   label: 'Valor',      num: true, strong: true, center: true,
          renderCell: r => `R$ ${Utils.fmtBR(r.valor_rs)}` },
      ];
    }
    return [
      { key: 'solicitante',      label: 'Solicitante',  renderCell: r => r.solicitante || '—' },
      { key: 'tipo_despesa',     label: 'Tipo despesa', renderCell: r => DOM.pill(r.tipo_despesa || '—') },
      { key: 'fornecedor',       label: 'Beneficiário',
        renderCell: r => buildFornecedorCell(r.fornecedor, '') },
      common.descNat,
      { key: 'tipo_solicitacao', label: 'Solicitação',  renderCell: r => r.tipo_solicitacao || '—' },
      common.aprovador,
      common.valor,
    ];
  },

  _renderStatus(s) {
    if (!s) return DOM.pill('—');
    const low = s.toLowerCase();
    if (/aprova[cç][aã]o/.test(low)) return DOM.pill(s, 'warn');
    if (/aguardando|baixa/.test(low)) return DOM.pill(s, 'ok');
    return DOM.pill(s);
  },

  _renderCard() {
    const catItems = this._cats.map(c => {
      const isActive = c.key === this._state.activeCat;
      const item = DOM.h('div', {
        class: 'cat-item' + (isActive ? ' active' : ''),
        dataset: { cat: c.key },
        role: 'button',
        tabindex: '0',
      }, [
        DOM.h('p', { class: 'cat-label' }, [DOM.icon(c.icon), c.label]),
        DOM.h('div', { class: 'cat-value' }, 'R$ ' + Utils.fmtBR(this._data.por_categoria[c.key].total)),
        DOM.h('p', { class: 'cat-sub' }, `${this._data.por_categoria[c.key].quantidade} títulos`),
      ]);
      item.addEventListener('click', () => this._switchCat(c.key));
      item.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._switchCat(c.key); }
      });
      return item;
    });

    const catSummary = DOM.h('div', { class: 'cat-summary' }, catItems);

    const tabs = this._cats.map(c => {
      const isActive = c.key === this._state.activeCat;
      const tab = DOM.h('button', {
        class: 'tab' + (isActive ? ' active' : ''),
        dataset: { cat: c.key },
        type: 'button',
      }, [
        DOM.icon(c.icon),
        c.label,
        DOM.h('span', { class: 'tab-count' }, String(c.data.length)),
      ]);
      tab.addEventListener('click', () => this._switchCat(c.key));
      return tab;
    });
    const tabsBar = DOM.h('div', { class: 'tabs', role: 'tablist' }, tabs);

    const searchInput = DOM.h('input', {
      id: 'prev-search',
      placeholder: 'Buscar fornecedor, solicitante, aprovador...',
      type: 'text',
      'aria-label': 'Buscar prévia de pagamentos',
    });
    searchInput.addEventListener('input', e => this._debouncedSearch(e.target.value));

    const searchBox = DOM.h('div', { class: 'search' }, [DOM.icon('fa-magnifying-glass'), searchInput]);

    const countEl = DOM.h('strong', { id: 'prev-count' }, '0');
    const totalEl = DOM.h('strong', { id: 'prev-total' }, 'R$ 0,00');

    const toolbarRight = DOM.h('div', { class: 'toolbar-right' }, [
      DOM.h('span', { class: 'lbl' }, 'Total'),
      countEl,
      DOM.h('span', { class: 'divider' }),
      DOM.h('span', { class: 'lbl' }, 'Soma'),
      totalEl,
    ]);

    const toolbar = DOM.h('div', { class: 'toolbar' }, [searchBox, toolbarRight]);

    const thead = DOM.h('thead');
    const tbody = DOM.h('tbody', { id: 'prev-tbody' });
    const tfoot = DOM.h('tfoot', { class: 'data', id: 'prev-tfoot' });
    const table = DOM.h('table', { class: 'data' }, [thead, tbody, tfoot]);
    const tableWrap = DOM.h('div', { class: 'table-wrap' }, table);

    const paginationMount = DOM.h('div', { id: 'prev-pagination' });

    this._els = { catItems, tabs, thead, tbody, tfoot, countEl, totalEl, searchInput, paginationMount };

    return DOM.h('div', { class: 'card' }, [catSummary, tabsBar, toolbar, tableWrap, paginationMount]);
  },

  _switchCat(catKey) {
    if (catKey === this._state.activeCat) return;
    this._state.activeCat = catKey;
    this._state.sort = { col: 'valor_total', dir: -1 };
    this._state.page = 1;

    this._els.catItems.forEach(ci => ci.classList.toggle('active', ci.dataset.cat === catKey));
    this._els.tabs.forEach(t => t.classList.toggle('active', t.dataset.cat === catKey));
    this._refresh();
  },

  _filterAndSort(cols) {
    const { q } = this._state.filter;
    const { col, dir } = this._state.sort;
    const cat = this._cats.find(c => c.key === this._state.activeCat);
    const validCol = cols.find(c => c.key === col) ? col : cols[cols.length - 1].key;

    const rows = cat.data.filter(r => {
      if (!q) return true;
      const query = q.toLowerCase();
      const natDesc = NaturezaMap.get(r.natureza_cod) || '';
      const blob = (JSON.stringify(r) + ' ' + natDesc).toLowerCase();
      return blob.includes(query);
    });

    rows.sort((a, b) => Utils.compareRows(a, b, validCol, dir));
    return { rows, validCol };
  },

  _refresh() {
    if (!this._els) return;
    const { thead, tbody, tfoot, countEl, totalEl, paginationMount } = this._els;
    const { dir } = this._state.sort;

    const cat = this._cats.find(c => c.key === this._state.activeCat);
    const cols = this._columnsFor(this._state.activeCat);
    const { rows: allFiltered, validCol } = this._filterAndSort(cols);

    const total = allFiltered.reduce((s, r) => s + (r.valor_total || 0), 0);
    countEl.textContent = String(allFiltered.length);
    totalEl.textContent = 'R$ ' + Utils.fmtBR(total);

    const start = (this._state.page - 1) * this._state.pageSize;
    const pageRows = allFiltered.slice(start, start + this._state.pageSize);

    DOM.clear(thead);
    const headerRow = DOM.h('tr', {});
    for (const c of cols) {
      const isSorted = c.key === validCol;
      const th = DOM.h('th', {
        class: [c.num ? 'num' : '', c.center ? 'center' : '', isSorted ? 'sorted' : ''].filter(Boolean).join(' ') || null,
        dataset: { key: c.key, dir: isSorted ? (dir > 0 ? ' ↑' : ' ↓') : '' },
      }, c.label);
      th.addEventListener('click', () => {
        if (this._state.sort.col === c.key) this._state.sort.dir *= -1;
        else { this._state.sort.col = c.key; this._state.sort.dir = 1; }
        this._state.page = 1;
        this._refresh();
      });
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);

    DOM.clear(tbody);
    if (pageRows.length === 0) {
      tbody.appendChild(DOM.h('tr', {},
        DOM.h('td', { class: 'empty-row', colspan: cols.length },
          `Nenhum título ${cat.label.toLowerCase()} previsto`)
      ));
    } else {
      for (const r of pageRows) tbody.appendChild(this._renderRow(r, cols));
    }

    DOM.clear(tfoot);
    tfoot.appendChild(DOM.h('tr', {}, [
      DOM.h('td', { colspan: cols.length - 1 },
        `Total exibido (${allFiltered.length} de ${cat.data.length})`),
      DOM.h('td', { class: 'num center' }, 'R$ ' + Utils.fmtBR(total)),
    ]));

    DOM.clear(paginationMount);
    const pag = Pagination.render({
      page: this._state.page,
      pageSize: this._state.pageSize,
      total: allFiltered.length,
      onPage: p => { this._state.page = p; this._refresh(); this._scrollToTop(); },
    });
    if (pag) paginationMount.appendChild(pag);
  },

  _scrollToTop() {
    const sec = document.getElementById('previsto');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  _renderRow(r, cols) {
    const isRisk = Utils.isApprovalStatus(r.status);
    const tr = DOM.h('tr', { class: isRisk ? 'flag-approval' : null });
    for (const c of cols) {
      const classes = [];
      if (c.num) classes.push('num');
      if (c.strong) classes.push('strong');
      if (c.center) classes.push('center');
      const td = DOM.h('td', { class: classes.join(' ') || null });
      DOM._append(td, c.renderCell(r));
      tr.appendChild(td);
    }
    return tr;
  },
};

/* ============================================================================
   SCROLLSPY
   ============================================================================ */
const ScrollSpy = {
  _links: null,
  _sections: null,
  _ticking: false,
  _offset: 120,

  init() {
    this._links = Array.from(document.querySelectorAll('[data-spy-link]'));
    if (!this._links.length) return;

    this._sections = CONFIG.SECTIONS
      .map(id => ({ id, el: document.getElementById(id) }))
      .filter(s => s.el);
    if (!this._sections.length) return;

    this._links.forEach(link => {
      link.addEventListener('click', e => {
        const targetId = link.getAttribute('href').slice(1);
        const target = document.getElementById(targetId);
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        this._setActive(targetId);
      });
    });

    window.addEventListener('scroll', () => this._onScroll(), { passive: true });
    window.addEventListener('resize', () => this._onScroll(), { passive: true });
    this._onScroll();
  },

  _onScroll() {
    if (this._ticking) return;
    this._ticking = true;
    requestAnimationFrame(() => {
      this._update();
      this._ticking = false;
    });
  },

  _update() {
    const trigger = window.scrollY + this._offset;
    let activeId = this._sections[0].id;
    for (const { id, el } of this._sections) {
      if (el.offsetTop <= trigger) activeId = id;
    }
    this._setActive(activeId);
  },

  _setActive(id) {
    this._links.forEach(l => {
      const href = l.getAttribute('href') || '';
      l.classList.toggle('active', href === '#' + id);
    });
  },
};

/* ============================================================================
   HUB LINK
   ============================================================================ */
const HubLink = {
  HUB_PATH_PREFIX: '/Controladoria',
  SELF_PATH_PREFIX: '/Controladoria/Pagamentos',
  STORAGE_KEY: 'came_from_hub',
  _cached: null,

  init() {
    const btn = DOM.byId('btn-hub');
    const linkAtualizar = DOM.byId('link-atualizar');

    if (this.cameFromHub()) {
      if (btn) btn.hidden = false;
      if (linkAtualizar) linkAtualizar.hidden = false;
      try { sessionStorage.setItem(this.STORAGE_KEY, '1'); } catch (e) {}
    }
  },

  /* Public: outros módulos checam isso pra liberar ações de edição
     (postergar etc.) que devem ficar escondidas no acesso público. */
  cameFromHub() {
    if (this._cached !== null) return this._cached;
    this._cached = this._userCameFromHub();
    return this._cached;
  },

  _userCameFromHub() {
    try {
      if (document.referrer) {
        const ref = new URL(document.referrer);
        const sameOrigin = ref.origin === location.origin;
        const isHubPath = ref.pathname.startsWith(this.HUB_PATH_PREFIX);
        const isSelfPath = ref.pathname.startsWith(this.SELF_PATH_PREFIX);
        if (sameOrigin && isHubPath && !isSelfPath) return true;
      }
    } catch (e) {}
    try {
      const params = new URLSearchParams(location.search);
      if (params.has('from')) return true;
    } catch (e) {}
    try {
      if (sessionStorage.getItem(this.STORAGE_KEY) === '1') return true;
    } catch (e) {}
    return false;
  },
};

/* ============================================================================
   UI_LOADING — shimmer nos cards + mensagens rotativas + barra de progresso
   ============================================================================ */
const UI_Loading = {
  _msgTimer: null,
  _progTimer: null,
  _refs: null,
  _progress: 0,
  _msgIndex: 0,

  MESSAGES: [
    'Conectando ao Google Sheets…',
    'Lendo os pagamentos realizados…',
    'Conferindo a prévia de amanhã…',
    'Calculando totais e somas…',
    'Verificando títulos em aprovação…',
    'Montando o painel…',
  ],

  start() {
    const container = DOM.byId('main-container');
    if (!container) return;
    DOM.clear(container);

    const skKpi = () => DOM.h('div', { class: 'kpi kpi-sk' }, [
      DOM.h('div', { class: 'sk-line sk-label' }),
      DOM.h('div', { class: 'sk-line sk-value' }),
      DOM.h('div', { class: 'sk-line sk-sub' }),
    ]);
    const skRow = w => DOM.h('div', { class: 'sk-row ' + w });

    const msgEl = DOM.h('div', { class: 'load-msg' }, this.MESSAGES[0]);
    const barEl = DOM.h('div', { class: 'load-bar' });
    const pctEl = DOM.h('div', { class: 'load-pct' }, '0%');
    const statusEl = DOM.h('div', { class: 'load-status' }, [
      DOM.h('div', { class: 'load-spinner' }),
      msgEl,
      DOM.h('div', { class: 'load-track' }, barEl),
      pctEl,
    ]);

    container.appendChild(DOM.h('div', { class: 'dash-loading' }, [
      DOM.h('div', { class: 'kpi-grid' }, [skKpi(), skKpi(), skKpi(), skKpi()]),
      statusEl,
      DOM.h('div', { class: 'card sk-card' }, [
        skRow('w-90'), skRow('w-75'), skRow('w-90'), skRow('w-60'), skRow('w-75'),
      ]),
    ]));

    this._refs = { msgEl, barEl, pctEl, statusEl };
    this._progress = 0;
    this._msgIndex = 0;

    // Mensagens rotativas — trocam a cada ~1,1s.
    this._msgTimer = setInterval(() => this._rotateMsg(), 1100);

    // Barra simulada — sobe até ~92% enquanto os dados não chegam.
    this._progTimer = setInterval(() => {
      if (this._progress < 92) {
        this._progress = Math.min(92, this._progress + 4 + Math.random() * 11);
        this._setBar(this._progress);
      }
    }, 240);
    this._setBar(6);
  },

  _rotateMsg() {
    if (!this._refs) return;
    const el = this._refs.msgEl;
    el.classList.add('fading');
    setTimeout(() => {
      if (!this._refs) return;
      this._msgIndex = (this._msgIndex + 1) % this.MESSAGES.length;
      el.textContent = this.MESSAGES[this._msgIndex];
      el.classList.remove('fading');
    }, 250);
  },

  _setBar(pct) {
    if (!this._refs) return;
    const p = Math.min(100, Math.round(pct));
    this._refs.barEl.style.width = p + '%';
    this._refs.pctEl.textContent = p + '%';
  },

  _clearTimers() {
    if (this._msgTimer) { clearInterval(this._msgTimer); this._msgTimer = null; }
    if (this._progTimer) { clearInterval(this._progTimer); this._progTimer = null; }
  },

  // Completa a barra e devolve uma Promise (para o conteúdo surgir suave).
  finish() {
    this._clearTimers();
    if (!this._refs) return Promise.resolve();
    this._refs.statusEl.classList.add('done');
    this._refs.msgEl.textContent = 'Tudo pronto!';
    this._setBar(100);
    return Utils.delay(420);
  },

  stop() {
    this._clearTimers();
    this._refs = null;
  },
};

/* ============================================================================
   showConfirm — modal de confirmação leve construído em JS
   ============================================================================ */
function showConfirm({ icon, title, message, details, confirmLabel, onConfirm }) {
  const close = () => overlay.remove();
  const cancelBtn = DOM.h('button', { class: 'cf-btn cf-cancel', type: 'button' }, 'Cancelar');
  const okBtn = DOM.h('button', { class: 'cf-btn cf-confirm', type: 'button' },
    confirmLabel || 'Confirmar');
  cancelBtn.addEventListener('click', close);
  okBtn.addEventListener('click', () => { close(); onConfirm && onConfirm(); });

  const body = [
    DOM.h('h3', { class: 'cf-title' }, [
      icon ? DOM.icon(icon) : null,
      title || 'Confirmar?',
    ].filter(Boolean)),
    DOM.h('p', { class: 'cf-text' }, message || ''),
  ];
  if (details) body.push(DOM.h('p', { class: 'cf-details' }, details));

  const overlay = DOM.h('div', { class: 'cf-overlay' }, [
    DOM.h('div', { class: 'cf-modal', role: 'dialog', 'aria-modal': 'true' }, [
      DOM.h('div', { class: 'cf-body' }, body),
      DOM.h('div', { class: 'cf-foot' }, [cancelBtn, okBtn]),
    ]),
  ]);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  setTimeout(() => okBtn.focus(), 40);
}

/* ============================================================================
   APP
   ============================================================================ */
const App = {
  async init() {
    UI_Loading.start();
    try {
      const [data, naturezas] = await Promise.all([
        DataService.loadData(),
        DataService.loadNaturezas(),
      ]);

      NaturezaMap.set(naturezas);
      await UI_Loading.finish();
      UI_Sidebar.updateStamp(data);
      HubLink.init();
      this._renderAll(data);
      ScrollSpy.init();

      console.info(`[App] Dashboard pronto · ${NaturezaMap.size()} naturezas carregadas`);
    } catch (err) {
      UI_Loading.stop();
      console.error('[App] Falha ao carregar dashboard:', err);
      UI_Sidebar.setError();
      this._renderError(err);
    }
  },

  _renderAll(data) {
    const container = DOM.byId('main-container');
    DOM.clear(container);
    container.appendChild(UI_Dashboard.render(data));
    container.appendChild(UI_Hoje.render(data));
    container.appendChild(UI_Previsto.render(data));
  },

  /* Re-busca os dados e re-renderiza tudo (sem o loading inicial, mais leve). */
  async refresh() {
    try {
      const [data, naturezas] = await Promise.all([
        DataService.loadData(),
        DataService.loadNaturezas(),
      ]);
      NaturezaMap.set(naturezas);
      UI_Sidebar.updateStamp(data);
      this._renderAll(data);
      ScrollSpy.init();
    } catch (err) {
      console.error('[App] Falha ao recarregar:', err);
      this._renderError(err);
    }
  },

  /* Move um título de Pagamentos Realizados para Postergados (amanhã). */
  postergar(titulo) {
    if (!titulo) return;
    const valor = 'R$ ' + Utils.fmtBR(titulo.valor_rs || 0);
    const forn  = titulo.fornecedor || '—';
    showConfirm({
      icon: 'fa-clock-rotate-left',
      title: 'Postergar para amanhã?',
      message: `Este pagamento sairá de Pagamentos Realizados e entrará na Prévia de amanhã, na lista de "Postergados".`,
      details: `${forn} · ${valor}`,
      confirmLabel: 'Postergar',
      onConfirm: async () => {
        const url = CONFIG.DATA_URL || '';
        if (!url || !/^https?:\/\//.test(url)) {
          alert('URL do App Script não configurada.');
          return;
        }
        try {
          await fetch(url, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ acao: 'postergar', titulo: titulo }),
          });
          // Pequena espera p/ o App Script processar + cache ser limpo.
          await Utils.delay(900);
          await this.refresh();
        } catch (err) {
          console.error('[App] Falha ao postergar:', err);
          alert('Erro ao postergar: ' + (err.message || err));
        }
      },
    });
  },

  _renderError(err) {
    const container = DOM.byId('main-container');
    DOM.clear(container);

    const retryBtn = DOM.h('button', { class: 'btn-retry', type: 'button' },
      [DOM.icon('fa-rotate-right'), 'Tentar novamente']);

    retryBtn.addEventListener('click', () => {
      DOM.clear(container);
      container.appendChild(DOM.h('div', { class: 'empty-state' }, [
        DOM.h('h2', {}, 'Recarregando…'),
        DOM.h('p', {}, 'Tentando buscar os dados novamente.'),
      ]));
      App.init();
    });

    const message = err && err.message ? err.message : 'Erro desconhecido';

    container.appendChild(DOM.h('div', { class: 'empty-state' }, [
      DOM.h('h2', {}, 'Não foi possível carregar o dashboard'),
      DOM.h('p', {}, [
        'Tentamos buscar os dados do Google Sheets e não conseguimos. Verifique se a URL do App Script está configurada corretamente.',
      ]),
      DOM.h('p', { style: { color: 'var(--subtle)', fontSize: '12px', marginBottom: '20px' } },
        `Detalhe técnico: ${message}`),
      retryBtn,
    ]));
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());