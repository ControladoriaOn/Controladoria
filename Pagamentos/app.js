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
  get(code) {
    if (!code) return null;
    return this._map[String(code).trim()] || null;
  },
  describe(code) {
    const desc = this.get(code);
    if (!desc) return null;
    return Utils.titleCase(desc);
  },
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
    const maiorForn = (hoje.maior && hoje.maior.fornecedor) ? hoje.maior.fornecedor : '—';

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
        subNode: DOM.h('span', { title: maiorForn }, Utils.truncate(maiorForn, 30)),
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

  /* Exporta a tabela de Pagamentos Realizados para um .xlsx (todas as linhas). */
  _exportXlsx() {
    if (typeof XLSX === 'undefined') {
      console.error('[Export] Biblioteca XLSX não carregou.');
      alert('Não foi possível gerar o Excel: a biblioteca não carregou. Verifique sua conexão e recarregue a página.');
      return;
    }
    const titulos = (this._data && this._data.titulos) || [];
    const header = ['Tipo', 'Título', 'Fornecedor', 'Histórico', 'Natureza',
                    'Descrição da Natureza', 'Bordero', 'Valor'];
    const rows = titulos.map(t => [
      t.tipo || '',
      String(t.numero || ''),
      t.fornecedor || '',
      t.historico || '',
      String(t.natureza || ''),
      NaturezaMap.describe(t.natureza) || '',
      t.bordero || '',
      Number(t.valor_rs) || 0,
    ]);
    const totalValor = titulos.reduce((s, t) => s + (Number(t.valor_rs) || 0), 0);
    const aoa = [header, ...rows, [], ['TOTAL', '', '', '', '', '', '', totalValor]];

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 8 }, { wch: 12 }, { wch: 36 }, { wch: 42 },
                   { wch: 12 }, { wch: 30 }, { wch: 14 }, { wch: 16 }];
    // Formato moeda na coluna "Valor" (coluna H).
    for (let r = 2; r <= aoa.length; r++) {
      const cell = ws['H' + r];
      if (cell && typeof cell.v === 'number') cell.z = 'R$ #,##0.00';
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pagamentos Realizados');
    const dia = (this._meta && this._meta.data_hoje) ? this._meta.data_hoje : 'export';
    XLSX.writeFile(wb, `pagamentos-realizados-${dia}.xlsx`);
  },

  _columns() {
    return [
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

  init() {
    const btn = DOM.byId('btn-hub');
    const linkAtualizar = DOM.byId('link-atualizar');

    if (this._userCameFromHub()) {
      if (btn) btn.hidden = false;
      if (linkAtualizar) linkAtualizar.hidden = false;
      try { sessionStorage.setItem(this.STORAGE_KEY, '1'); } catch (e) {}
    }
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