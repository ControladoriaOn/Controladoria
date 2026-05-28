/* =================================================================
   HUB LINK — Validação Inteligente de Origem
   ================================================================= */
const HubLink = {
    HUB_PATH_PREFIX: '/Controladoria',          
    SELF_PATH_PREFIX: '/Controladoria/Parcelamentos', 
    STORAGE_KEY: 'came_from_hub_parcelamentos',

    init() {
        const btn = document.getElementById('btn-hub');
        const linkAtualizar = document.getElementById('link-atualizar');
        const linkComprovantes = document.getElementById('link-comprovantes');

        if (this._userCameFromHub()) {
            if (btn) btn.hidden = false;
            if (linkAtualizar) linkAtualizar.hidden = false;
            if (linkComprovantes) linkComprovantes.hidden = false;
            try { sessionStorage.setItem(this.STORAGE_KEY, '1'); } catch (e) { }
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
    }
};

/* =================================================================
   Configuração centralizada — Atualizado p/ Modo Claro (V8)
   ================================================================= */
const Config = Object.freeze({
    API_URL: 'https://calm-queen-1204.controladoriaontimegestao.workers.dev',
    CAIXA_JAN_2023: 421634,
    ROWS_PER_PAGE_SINT: 20,
    ROWS_PER_PAGE_DET: 50,

    RETRY_MAX: 3,
    RETRY_DELAY_MS: 1500,

    MONTH_NAMES: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
    MONTH_NAMES_FULL: ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'],

    NUMERIC_COLS: new Set(['qtdParcela', 'atraso', 'totalDivida', 'parcelaUnit', 'Valor Original', 'Saldo Devedor']),

    theme: Object.freeze({
        bgDark:      [250, 247, 245],   // Reflete var(--bg) cream no PDF
        surface1:    [255, 255, 255],
        surface2:    [246, 242, 246],
        surfaceAlt:  [250, 247, 245],
        textMuted:   [107, 94, 107],    // var(--muted)
        textWhite:   [26, 15, 26],      // var(--ink) texto escuro
        orange:      [255, 110, 0],
        purple:      [60, 0, 60],
        green:       [31, 122, 61],
        kpiPurple:   [92, 26, 92],
        gridLine:    [232, 224, 232],

        orangeHex:   '#FF6E00',
        orangeLight: '#ff9544',
        purpleHex:   '#3C003C',
    }),
});

/* =================================================================
   Funções utilitárias puras
   ================================================================= */
const Utils = (() => {
    const fmtCurrency = (v) =>
        new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);

    const fmtCurrencyShort = (v) =>
        new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v || 0);

    const parseDateBR = (val) => {
        if (!val) return null;
        const s = String(val).trim();
        const match = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
        if (match) {
            const day = parseInt(match[1], 10);
            const month = parseInt(match[2], 10) - 1;
            const year = parseInt(match[3], 10);
            if (month < 0 || month > 11 || day < 1 || day > 31) {
                console.warn(`[Parsing] Data inválida ignorada: "${s}"`);
                return null;
            }
            return new Date(Date.UTC(year, month, day));
        }
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
            const d = new Date(s);
            return isNaN(d.getTime()) ? null : d;
        }
        return null;
    };

    const formatDateBR = (val) => {
        const d = parseDateBR(val);
        return d ? d.toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '-';
    };

    const parseNum = (v) => {
        if (v == null || v === '') return 0;
        if (typeof v === 'number') return v;
        let s = String(v).replace(/[R$\s\u00A0]/g, '').trim();
        if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
        return parseFloat(s) || 0;
    };

    const debounce = (fn, ms = 250) => {
        let t;
        return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    };

    const createGradient = (canvasId, c1, c2) => {
        const ctx = document.getElementById(canvasId).getContext('2d');
        const g = ctx.createLinearGradient(0, 0, 0, 300);
        g.addColorStop(0, c1);
        g.addColorStop(1, c2);
        return g;
    };

    const readField = (row, key, fallback = '-') => row[key] ?? fallback;

    const isInativo = (ativoStr) => {
        const v = String(ativoStr || '').trim().toLowerCase();
        return v === 'não' || v === 'nao';
    };

    const mesAno = (year, month) => year * 100 + month;

    const el = (tag, text, className) => {
        const e = document.createElement(tag);
        if (text != null) e.textContent = text;
        if (className) e.className = className;
        return e;
    };

    const option = (value, label, selected = false) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        if (selected) o.selected = true;
        return o;
    };

    return Object.freeze({
        fmt: fmtCurrency,
        fmtD: fmtCurrencyShort,
        parseDateBR,
        formatDateBR,
        num: parseNum,
        debounce,
        grad: createGradient,
        readField,
        isInativo,
        mesAno,
        el,
        option,
    });
})();

/* =================================================================
   DataService — fetch, normalização, indexação
   ================================================================= */
const DataService = (() => {
    let rawData = [];
    let consolidatedData = [];
    let inativoMap = {};
    let nascimentoMap = {};

    let indexByNumero = {};
    let uniqueNaturezas = [];
    let uniqueOrgaos = [];
    let uniqueYears = [];

    // CACHE: consolidação por (ano, mês) — evita recalcular
    const consolidationCache = new Map();

    const KEY_MAP = {
        'numero':      'Número',
        'número':      'Número',
        'negociação':  'Negociação',
        'negociacao':  'Negociação',
        'data':        'Data',
        'orgão':       'Orgão',
        'orgao':       'Orgão',
        'natureza':    'Natureza',
        'tributo':     'Tributo',
        'status':      'Status',
        'valor original': 'Valor Original',
        'saldo devedor':  'Saldo Devedor',
        'ativo':       'Ativo',
    };

    const normalizeKeys = (row) => {
        const clean = {};
        for (const k in row) {
            const trimmed = k.trim();
            const lower = trimmed.toLowerCase();
            const canonical = KEY_MAP[lower] || trimmed;
            clean[canonical] = row[k];
        }
        return clean;
    };

    const fetchWithRetry = async (url, maxRetries = Config.RETRY_MAX) => {
        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`);
                return await res.json();
            } catch (err) {
                lastError = err;
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, Config.RETRY_DELAY_MS * attempt));
                }
            }
        }
        throw lastError;
    };

    const buildIndexes = () => {
        indexByNumero = {};
        const natSet = new Set();
        const orgSet = new Set();
        const yearSet = new Set();

        rawData.forEach(row => {
            const id = row['Número'] || row['Negociação'] || 'S/N';
            if (!indexByNumero[id]) indexByNumero[id] = [];
            indexByNumero[id].push(row);

            if (row['Natureza']) natSet.add(row['Natureza']);
            if (row['Orgão']) orgSet.add(row['Orgão']);

            const d = Utils.parseDateBR(row['Data']);
            if (d) yearSet.add(d.getUTCFullYear());
        });

        uniqueNaturezas = Array.from(natSet).sort();
        uniqueOrgaos = Array.from(orgSet).sort();
        uniqueYears = Array.from(yearSet).sort();
    };

    const buildLifeCycleMaps = () => {
        inativoMap = {};
        nascimentoMap = {};

        rawData.forEach(row => {
            const id = row['Número'] || row['Negociação'] || 'S/N';
            const d = Utils.parseDateBR(row['Data']);
            if (!d) return;

            const ma = Utils.mesAno(d.getUTCFullYear(), d.getUTCMonth());

            if (!nascimentoMap[id] || ma < nascimentoMap[id]) {
                nascimentoMap[id] = ma;
            }

            if (Utils.isInativo(row['Ativo'])) {
                if (!inativoMap[id] || ma < inativoMap[id]) {
                    inativoMap[id] = ma;
                }
            }
        });
    };

    const processConsolidation = (currYear, currMonth) => {
        const cacheKey = `${currYear}-${currMonth}`;
        if (consolidationCache.has(cacheKey)) {
            consolidatedData = consolidationCache.get(cacheKey);
            return;
        }

        const map = {};
        const mesAnoBase = Utils.mesAno(currYear, currMonth);

        rawData.forEach(row => {
            const id = row['Número'] || row['Negociação'] || 'S/N';
            const d = Utils.parseDateBR(row['Data']);
            if (!d) return;

            const anoP = d.getUTCFullYear();
            const mesP = d.getUTCMonth();
            const mesAnoP = Utils.mesAno(anoP, mesP);
            const saldoDevedor = Utils.num(row['Saldo Devedor']);

            if (mesAnoP < mesAnoBase) return;

            const nascimento = nascimentoMap[id] || Infinity;
            const inativo = inativoMap[id] || Infinity;

            if (mesAnoBase < nascimento) return;

            if (!map[id]) {
                map[id] = {
                    natureza: row['Natureza'] || '-',
                    tributo: row['Tributo'] || '-',
                    numero: id,
                    orgao: row['Orgão'] || '-',
                    qtdParcela: 0,
                    atraso: 0,
                    totalDivida: 0,
                    parcelaUnit: 0,
                };
            }

            map[id].qtdParcela++;
            const originalStatus = String(row['Status'] || '').trim().toLowerCase();

            if (mesAnoBase < inativo) {
                if (mesAnoP === mesAnoBase && !originalStatus.includes('encerrado')) {
                    map[id].parcelaUnit += saldoDevedor;
                }
                if (mesAnoP > mesAnoBase || originalStatus === 'a vencer' || originalStatus.includes('atraso')) {
                    map[id].totalDivida += saldoDevedor;
                    if (originalStatus.includes('atraso') && mesAnoP <= mesAnoBase) {
                        map[id].atraso++;
                    }
                }
            }
        });
        consolidatedData = Object.values(map).filter(c => c.totalDivida > 0 || c.parcelaUnit > 0);
        consolidationCache.set(cacheKey, consolidatedData);
    };

    const load = async () => {
        const json = await fetchWithRetry(Config.API_URL);
        rawData = json
            .map(normalizeKeys)
            .filter(r => r['Número'] || r['Negociação']);
        buildLifeCycleMaps();
        buildIndexes();
    };

    return {
        load,
        processConsolidation,
        clearCache: () => consolidationCache.clear(),
        getRawData: () => rawData,
        getConsolidated: () => consolidatedData,
        getInativoMap: () => inativoMap,
        getNascimentoMap: () => nascimentoMap,
        getNaturezas: () => uniqueNaturezas,
        getOrgaos: () => uniqueOrgaos,
        getYears: () => uniqueYears,
    };
})();

/* =================================================================
   ChartManager — criação e atualização de gráficos (Ajustado p/ Tema Claro V8)
   ================================================================= */
const ChartManager = (() => {
    const instances = { abertura: null, quitacao: null, caixa: null };
    let pluginRegistered = false;

    const registerPlugins = () => {
        if (pluginRegistered) return;
        Chart.defaults.font.family = "'Manrope', sans-serif";
        Chart.register(ChartDataLabels);
        pluginRegistered = true;
    };

    const baseOptions = (overrides = {}) => ({
        devicePixelRatio: 2,
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 28, bottom: 10 } },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: 'rgba(26,15,26,0.95)',
                titleColor: '#fff',
                bodyColor: '#fff',
                borderColor: 'rgba(0,0,0,0.1)',
                borderWidth: 1,
                padding: 12,
                cornerRadius: 10,
                callbacks: { label: ctx => Utils.fmtD(ctx.raw) },
            },
            datalabels: {
                color: '#6B5E6B', // var(--muted)
                font: { family: "'Manrope'", size: 12.5, weight: 700 },
                formatter: v => v > 0 ? Utils.fmtD(v) : '',
                anchor: 'end',
                align: 'end',
                ...(overrides.datalabels || {}),
            },
        },
        scales: { x: { display: false }, y: { display: false } },
        ...(overrides.extra || {}),
    });

    const upsertChart = (key, canvasId, type, dataFn, optionsFn) => {
        const { data, options } = { data: dataFn(), options: optionsFn() };
        if (instances[key]) {
            instances[key].data = data;
            instances[key].options = options;
            instances[key].update('none');
        } else {
            instances[key] = new Chart(
                document.getElementById(canvasId),
                { type, data, options }
            );
        }
        return instances[key];
    };

    const destroyChart = (key) => {
        if (instances[key]) {
            instances[key].destroy();
            instances[key] = null;
        }
    };

    return Object.freeze({
        registerPlugins,
        baseOptions,
        upsertChart,
        destroyChart,
        getChart: (key) => instances[key],
    });
})();

/* =================================================================
   TableRenderer
   ================================================================= */
const TableRenderer = (() => {
    const $ = id => document.getElementById(id);

    const statusClass = (statusStr) => {
        const lo = String(statusStr || '-').trim().toLowerCase();
        if (lo === 'a vencer') return 'status-vencer';
        if (lo === 'quitada' || lo === 'encerrado') return 'status-quitada';
        if (lo.includes('atraso')) return 'status-atraso';
        return 'status-default';
    };

    const createSintRow = (c) => {
        const tr = document.createElement('tr');
        const cells = [
            c.natureza,
            c.tributo,
            null, 
            c.orgao,
            c.qtdParcela,
            null, 
            null, 
            Utils.fmt(c.parcelaUnit),
        ];

        cells.forEach((text, i) => {
            const td = document.createElement('td');
            if (i === 2) {
                const strong = document.createElement('strong');
                strong.textContent = c.numero;
                td.appendChild(strong);
            } else if (i === 5) {
                td.textContent = c.atraso;
                td.style.color = c.atraso > 0 ? 'var(--err)' : 'var(--ok)';
                td.style.fontWeight = '700';
            } else if (i === 6) {
                td.textContent = Utils.fmt(c.totalDivida);
                td.className = 'val-destaque';
            } else {
                td.textContent = text;
            }
            tr.appendChild(td);
        });
        return tr;
    };

    const createDetRow = (r) => {
        const tr = document.createElement('tr');
        const status = String(r['Status'] || '-').trim();

        const vals = [
            Utils.formatDateBR(r['Data']),
            null, 
            r['Orgão'] || '-',
            r['Natureza'] || '-',
            Utils.fmt(Utils.num(r['Valor Original'])),
            null, 
            null, 
        ];

        vals.forEach((text, i) => {
            const td = document.createElement('td');
            if (i === 1) {
                const strong = document.createElement('strong');
                strong.textContent = r['Número'] || r['Negociação'] || '-';
                td.appendChild(strong);
            } else if (i === 5) {
                td.textContent = Utils.fmt(Utils.num(r['Saldo Devedor']));
                td.className = 'val-destaque';
            } else if (i === 6) {
                const span = document.createElement('span');
                span.className = `status-badge ${statusClass(status)}`;
                span.textContent = status;
                td.appendChild(span);
            } else {
                td.textContent = text;
            }
            tr.appendChild(td);
        });
        return tr;
    };

    const renderSintRows = (data) => {
        const tbody = $('bodySintetico');
        tbody.textContent = '';
        const frag = document.createDocumentFragment();
        data.forEach(c => frag.appendChild(createSintRow(c)));
        tbody.appendChild(frag);
    };

    const renderTotals = (allFilteredData) => {
        const tfoot = $('tfootSintetico');
        tfoot.textContent = '';

        let sumDivida = 0, sumParcela = 0;
        allFilteredData.forEach(c => { sumDivida += c.totalDivida; sumParcela += c.parcelaUnit; });

        const tr = document.createElement('tr');

        const tdLabel = document.createElement('td');
        tdLabel.setAttribute('colspan', '6');
        tdLabel.style.textAlign = 'right';
        tdLabel.style.color = 'var(--muted)';
        tdLabel.textContent = 'TOTAIS DA PÁGINA (FILTRADO)';
        tr.appendChild(tdLabel);

        const tdDivida = document.createElement('td');
        tdDivida.className = 'val-destaque';
        tdDivida.textContent = Utils.fmt(sumDivida);
        tr.appendChild(tdDivida);

        const tdParcela = document.createElement('td');
        tdParcela.textContent = Utils.fmt(sumParcela);
        tr.appendChild(tdParcela);

        tfoot.appendChild(tr);
    };

    const renderDetRows = (data) => {
        const tbody = $('bodyDetalhado');
        tbody.textContent = '';
        const frag = document.createDocumentFragment();
        data.forEach(r => frag.appendChild(createDetRow(r)));
        tbody.appendChild(frag);
    };

    const renderDetFooter = (count) => {
        $('detalhadoFooter').textContent = `${count} parcela(s) listada(s)`;
    };

    return Object.freeze({ renderSintRows, renderTotals, renderDetRows, renderDetFooter });
})();

/* =================================================================
   App — orquestrador principal
   ================================================================= */
const App = (() => {
    const $ = id => document.getElementById(id);

    const realNow = new Date();
    const realMonth = realNow.getMonth();
    const realYear = realNow.getFullYear();
    let currMonth = realMonth;
    let currYear = realYear;

    let currentFilteredSintetico = [];
    let lastDetalhadoFiltered = [];
    let selectedOrgao = null;

    const pagination = {
        sintetico: { page: 1, data: [] },
        detalhado: { page: 1, data: [] },
    };
    const sortState = {
        sintetico: { col: null, dir: 'asc' },
        detalhado: { col: null, dir: 'asc' },
    };

    let dashData = {};

    const getRowsPerPage = (key) => key === 'sintetico' ? Config.ROWS_PER_PAGE_SINT : Config.ROWS_PER_PAGE_DET;
    const getSlice = (key) => {
        const p = pagination[key];
        const rpp = getRowsPerPage(key);
        return p.data.slice((p.page - 1) * rpp, p.page * rpp);
    };
    const totPages = (key) => Math.max(1, Math.ceil(pagination[key].data.length / getRowsPerPage(key)));

    const renderPagination = (key, containerId) => {
        const container = $(containerId);
        container.textContent = '';
        const t = totPages(key);
        const c = pagination[key].page;
        const cnt = pagination[key].data.length;
        const rpp = getRowsPerPage(key);

        const s = cnt === 0 ? 0 : (c - 1) * rpp + 1;
        const e = Math.min(c * rpp, cnt);

        const info = Utils.el('span', `${s}–${e} de ${cnt} registros`);
        container.appendChild(info);

        const btnWrap = Utils.el('div', null, 'pagination-btns');
        let sp = Math.max(1, c - 2);
        let ep = Math.min(t, sp + 4);
        if (ep - sp < 4) sp = Math.max(1, ep - 4);

        const btnPrev = Utils.el('button');
        btnPrev.innerHTML = '<i class="ph-bold ph-caret-left"></i>';
        btnPrev.disabled = c <= 1;
        btnPrev.addEventListener('click', () => goPage(key, c - 1));
        btnWrap.appendChild(btnPrev);

        for (let i = sp; i <= ep; i++) {
            const btn = Utils.el('button', String(i));
            if (i === c) btn.className = 'active';
            btn.addEventListener('click', () => goPage(key, i));
            btnWrap.appendChild(btn);
        }

        const btnNext = Utils.el('button');
        btnNext.innerHTML = '<i class="ph-bold ph-caret-right"></i>';
        btnNext.disabled = c >= t;
        btnNext.addEventListener('click', () => goPage(key, c + 1));
        btnWrap.appendChild(btnNext);
        container.appendChild(btnWrap);
    };

    const goPage = (key, p) => {
        if (p < 1 || p > totPages(key)) return;
        pagination[key].page = p;
        if (key === 'sintetico') {
            TableRenderer.renderSintRows(getSlice('sintetico'));
            renderPagination('sintetico', 'paginationSintetico');
            TableRenderer.renderTotals(currentFilteredSintetico);
        } else {
            TableRenderer.renderDetRows(getSlice('detalhado'));
            renderPagination('detalhado', 'paginationDetalhado');
        }
    };

    const doSort = (tbl, col) => {
        if (sortState[tbl].col === col) sortState[tbl].dir = sortState[tbl].dir === 'asc' ? 'desc' : 'asc';
        else { sortState[tbl].col = col; sortState[tbl].dir = 'asc'; }

        document.querySelectorAll(`#${tbl} th i`).forEach(i => {
            i.className = 'ph-bold ph-caret-up-down';
            i.classList.remove('active');
        });
        const ic = $(`sort-${tbl}-${col}`);
        if (ic) ic.className = sortState[tbl].dir === 'asc' ? 'ph-bold ph-caret-up active' : 'ph-bold ph-caret-down active';

        if (tbl === 'sintetico') filterSintetico();
        else filterDetalhado();
    };

    const applySort = (arr, tbl) => {
        const { col, dir } = sortState[tbl];
        if (!col) return arr;
        return [...arr].sort((a, b) => {
            let va = a[col], vb = b[col];
            if (col === 'Data') {
                const ta = Utils.parseDateBR(va)?.getTime() || 0;
                const tb = Utils.parseDateBR(vb)?.getTime() || 0;
                return dir === 'asc' ? ta - tb : tb - ta;
            }
            if (Config.NUMERIC_COLS.has(col)) return dir === 'asc' ? Utils.num(va) - Utils.num(vb) : Utils.num(vb) - Utils.num(va);
            va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase();
            return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        });
    };

    const toggleSidebar = () => {
        $('sidebar').classList.toggle('open');
        $('sidebarOverlay').classList.toggle('visible');
    };

    const scrollToSection = (id) => {
        const el = $(id), ct = $('scroll-container'), hd = $('main-header');
        if (!el || !ct || !hd) return;
        ct.scrollTo({ top: el.offsetTop - hd.offsetHeight - 20, behavior: 'smooth' });
    };

    const initScrollSpy = () => {
        const ct = $('scroll-container'), hd = $('main-header');
        const secs = document.querySelectorAll('.scroll-section');
        const navs = document.querySelectorAll('.nav-item[data-target]');
        if (!ct || !hd) return;
        ct.addEventListener('scroll', () => {
            const trigger = hd.getBoundingClientRect().bottom + 100;
            let cur = '';
            secs.forEach(s => { if (s.getBoundingClientRect().top <= trigger) cur = s.id; });
            if (ct.scrollHeight - ct.scrollTop <= ct.clientHeight + 2) cur = secs[secs.length - 1].id;
            navs.forEach(n => n.classList.toggle('active', n.dataset.target === cur));
        });
    };

    const initDataBaseSelector = () => {
        const selAno = $('dataBaseAno');
        selAno.textContent = '';
        [realYear - 1, realYear].forEach(y => selAno.appendChild(Utils.option(String(y), String(y), y === currYear)));
        populateMonthSelector($('dataBaseMes'));
    };

    const populateMonthSelector = (selMes) => {
        selMes.textContent = '';
        const maxMonth = currYear === realYear ? realMonth : 11;
        Config.MONTH_NAMES_FULL.forEach((m, i) => {
            if (i <= maxMonth) selMes.appendChild(Utils.option(String(i), m, i === currMonth));
        });
    };

    const changeDataBase = () => {
        currYear = parseInt($('dataBaseAno').value, 10);
        const maxMonth = currYear === realYear ? realMonth : 11;
        let selectedMes = parseInt($('dataBaseMes').value, 10);
        if (selectedMes > maxMonth) selectedMes = maxMonth;
        currMonth = selectedMes;
        populateMonthSelector($('dataBaseMes'));
        DataService.processConsolidation(currYear, currMonth);
        updateDashboard();
        filterSintetico();
    };

    const populateFilters = () => {
        const nats = DataService.getNaturezas(), orgs = DataService.getOrgaos();
        const fillSelect = (id, items, allLabel) => {
            const sel = $(id); sel.textContent = '';
            sel.appendChild(Utils.option('', allLabel));
            items.forEach(it => sel.appendChild(Utils.option(it, it)));
        };
        fillSelect('filterSinteticoNatureza', nats, 'Todas');
        fillSelect('filterSinteticoOrgao', orgs, 'Todos');
        fillSelect('filterDetalhadoOrgao', orgs, 'Todos');
        fillSelect('filterDetalhadoNatureza', nats, 'Todas');
    };

    const populateYears = () => {
        const yrs = DataService.getYears(), sel = $('filterDetalhadoAno');
        sel.textContent = ''; sel.appendChild(Utils.option('', 'Todos'));
        yrs.forEach(y => sel.appendChild(Utils.option(String(y), String(y))));
    };

    const getFilteredSint = () => {
        const t = $('searchSintetico').value.toLowerCase();
        const fN = $('filterSinteticoNatureza').value.toLowerCase();
        const fO = $('filterSinteticoOrgao').value.toLowerCase();

        return DataService.getConsolidated().filter(c => {
            if (t && !(c.numero.toLowerCase().includes(t) || c.orgao.toLowerCase().includes(t) ||
                c.natureza.toLowerCase().includes(t) || c.tributo.toLowerCase().includes(t))) return false;
            if (fN && c.natureza.toLowerCase() !== fN) return false;
            if (fO && c.orgao.toLowerCase() !== fO) return false;
            if (selectedOrgao && c.orgao !== selectedOrgao) return false;
            return true;
        });
    };

    const filterSintetico = Utils.debounce(() => {
        currentFilteredSintetico = applySort(getFilteredSint(), 'sintetico');
        renderSintetico(currentFilteredSintetico);
    });

    const filterDetalhado = Utils.debounce(() => {
        const t = $('searchDetalhado').value.toLowerCase(), fO = $('filterDetalhadoOrgao').value.toLowerCase(),
              fN = $('filterDetalhadoNatureza').value.toLowerCase(), fS = $('filterDetalhadoStatus').value.toLowerCase(),
              fM = $('filterDetalhadoMes').value, fA = $('filterDetalhadoAno').value;

        let f = DataService.getRawData().filter(r => {
            if (t && !(String(r['Número'] || '').toLowerCase().includes(t) || String(r['Orgão'] || '').toLowerCase().includes(t) ||
                String(r['Natureza'] || '').toLowerCase().includes(t) || String(r['Status'] || '').toLowerCase().includes(t))) return false;
            if (fO && String(r['Orgão'] || '').toLowerCase() !== fO) return false;
            if (fN && String(r['Natureza'] || '').toLowerCase() !== fN) return false;
            if (fS && String(r['Status'] || '').toLowerCase() !== fS) return false;
            if (fM || fA) {
                const d = Utils.parseDateBR(r['Data']); if (!d) return false;
                if (fA && d.getUTCFullYear() !== parseInt(fA, 10)) return false;
                if (fM && (d.getUTCMonth() + 1) !== parseInt(fM, 10)) return false;
            }
            return true;
        });
        lastDetalhadoFiltered = f;
        renderDetalhado(applySort(f, 'detalhado'));
    });

    const renderSintetico = (data) => {
        pagination.sintetico.data = data; pagination.sintetico.page = 1;
        TableRenderer.renderSintRows(getSlice('sintetico'));
        renderPagination('sintetico', 'paginationSintetico');
        TableRenderer.renderTotals(currentFilteredSintetico);
    };

    const renderDetalhado = (data) => {
        pagination.detalhado.data = data; pagination.detalhado.page = 1;
        TableRenderer.renderDetRows(getSlice('detalhado'));
        renderPagination('detalhado', 'paginationDetalhado');
        TableRenderer.renderDetFooter(data.length);
    };

    const setOrgaoFilter = (orgao) => {
        selectedOrgao = selectedOrgao === orgao ? null : orgao;
        updateFilterBadge(); updateKPIs(); updateQuitacaoChart(); filterSintetico();
    };

    const clearOrgaoFilter = () => {
        selectedOrgao = null;
        updateFilterBadge(); updateKPIs(); updateQuitacaoChart(); filterSintetico();
    };

    const updateFilterBadge = () => {
        const container = $('orgaoFilterBadge'); container.textContent = '';
        if (selectedOrgao) {
            const span = Utils.el('span', null, 'filter-badge');
            const icon = document.createElement('i'); icon.className = 'ph-bold ph-funnel';
            span.appendChild(icon);
            span.appendChild(document.createTextNode(` ${selectedOrgao} `));
            const btnClear = document.createElement('button'); btnClear.textContent = '\u00D7';
            btnClear.title = 'Limpar filtro'; btnClear.addEventListener('click', clearOrgaoFilter);
            span.appendChild(btnClear); container.appendChild(span);
        }
    };

    const computeDashData = () => {
        const consolidated = DataService.getConsolidated();
        let totalS = 0, aVencerMes = 0; const orgMap = {};
        consolidated.forEach(c => {
            totalS += c.totalDivida; aVencerMes += c.parcelaUnit;
            orgMap[c.orgao] = (orgMap[c.orgao] || 0) + c.totalDivida;
        });
        dashData = { totalS, contSetSize: consolidated.length, orgMap, caixaM: aVencerMes, aVencerMes, orgEntries: Object.entries(orgMap).sort((a, b) => b[1] - a[1]) };
    };

    const updateKPIs = () => {
        $('kpi-mes-label').textContent = `A Vencer no Mês (${Config.MONTH_NAMES[currMonth]}/${currYear})`;
        if (!selectedOrgao) {
            $('kpi-saldo').textContent = Utils.fmtD(dashData.totalS);
            $('kpi-ativas').textContent = dashData.contSetSize;
            $('kpi-mes').textContent = Utils.fmtD(dashData.aVencerMes);
        } else {
            let saldo = 0, mesVal = 0, ids = 0;
            DataService.getConsolidated().forEach(c => {
                if (c.orgao === selectedOrgao) { saldo += c.totalDivida; mesVal += c.parcelaUnit; ids++; }
            });
            $('kpi-saldo').textContent = Utils.fmtD(saldo);
            $('kpi-ativas').textContent = ids;
            $('kpi-mes').textContent = Utils.fmtD(mesVal);
        }
    };

    const updateQuitacaoChart = () => {
        const consolidated = DataService.getConsolidated(), rawData = DataService.getRawData(),
              inativoMap = DataService.getInativoMap(), mesAnoBase = Utils.mesAno(currYear, currMonth),
              validIds = new Set(consolidated.map(c => c.numero)), anoF = {};
        let totalF = 0;

        rawData.forEach(row => {
            const id = row['Número'] || row['Negociação'] || 'S/N';
            if (!validIds.has(id)) return;
            if (selectedOrgao && (row['Orgão'] || '-') !== selectedOrgao) return;
            const d = Utils.parseDateBR(row['Data']); if (!d) return;

            const anoP = d.getUTCFullYear(), mesAnoP = Utils.mesAno(anoP, d.getUTCMonth());
            if (mesAnoP < mesAnoBase || mesAnoBase >= (inativoMap[id] || Infinity)) return;

            const originalStatus = String(row['Status'] || '').trim().toLowerCase();
            if (mesAnoP > mesAnoBase || originalStatus === 'a vencer' || originalStatus.includes('atraso')) {
                const saldo = Utils.num(row['Saldo Devedor']);
                anoF[anoP] = (anoF[anoP] || 0) + saldo; totalF += saldo;
            }
        });

        const sy = Object.keys(anoF).map(Number).sort(), qL = [], qD = [];
        let restante = totalF;
        sy.forEach(y => { if (anoF[y] > 0) { qL.push(String(y)); qD.push(restante); restante -= anoF[y]; } });

        ChartManager.destroyChart('quitacao');
        ChartManager.upsertChart('quitacao', 'chartQuitacao', 'bar',
            () => ({ labels: qL, datasets: [{ data: qD, backgroundColor: Utils.grad('chartQuitacao', Config.theme.orangeHex, Config.theme.orangeLight), borderRadius: 6, maxBarThickness: 60 }] }),
            () => ({
                ...ChartManager.baseOptions(),
                scales: {
                    x: { display: true, grid: { display: false }, border: { display: false }, ticks: { color: '#6B5E6B', font: { family: "'Manrope'", size: 12.5, weight: 600 } } },
                    y: {
                        display: true, beginAtZero: true,
                        grid: { color: 'rgba(107, 94, 107, 0.10)', drawTicks: false, drawBorder: false },
                        border: { display: false },
                        ticks: { color: '#9B8FA0', font: { family: "'Manrope'", size: 10.5, weight: 500 }, padding: 8, maxTicksLimit: 5, callback: v => Utils.fmtD(v) }
                    }
                }
            })
        );
    };

    const updateDashboard = () => {
        computeDashData(); updateKPIs(); ChartManager.registerPlugins();
        $('caixaSubtitle').textContent = `Comparativo Jan/2023 vs ${Config.MONTH_NAMES[currMonth]}/${currYear}`;
        const orgE = dashData.orgEntries;

        ChartManager.destroyChart('abertura');
        ChartManager.upsertChart('abertura', 'chartAbertura', 'bar',
            () => ({ labels: orgE.map(e => e[0]), datasets: [{ data: orgE.map(e => e[1]), backgroundColor: orgE.map(e => e[0] === selectedOrgao ? Config.theme.orangeLight : Config.theme.orangeHex), borderRadius: 6, maxBarThickness: 28 }] }),
            () => ({
                ...ChartManager.baseOptions(), indexAxis: 'y', layout: { padding: { right: 90, top: 20, bottom: 10 } },
                scales: {
                    x: {
                        display: true, grace: '15%', beginAtZero: true,
                        grid: { color: 'rgba(107, 94, 107, 0.10)', drawTicks: false, drawBorder: false },
                        border: { display: false },
                        ticks: { color: '#9B8FA0', font: { family: "'Manrope'", size: 10.5, weight: 500 }, padding: 8, maxTicksLimit: 5, callback: v => Utils.fmtD(v) }
                    },
                    y: { display: true, grid: { display: false }, border: { display: false }, ticks: { color: '#6B5E6B', font: { family: "'Manrope'", size: 12.5, weight: 600 }, padding: 8 } }
                },
                onClick: (_evt, elements) => {
                    if (elements.length > 0) {
                        setOrgaoFilter(orgE[elements[0].index][0]);
                        const chart = ChartManager.getChart('abertura');
                        if (chart) { chart.data.datasets[0].backgroundColor = orgE.map(e => e[0] === selectedOrgao ? Config.theme.orangeLight : Config.theme.orangeHex); chart.update('none'); }
                    }
                },
                onHover: (evt, elements) => evt.native.target.style.cursor = elements.length ? 'pointer' : 'default'
            })
        );

        ChartManager.destroyChart('caixa');
        ChartManager.upsertChart('caixa', 'chartCaixa', 'bar',
            () => ({ labels: ['Jan/2023', `${Config.MONTH_NAMES[currMonth]}/${currYear}`], datasets: [{ data: [Config.CAIXA_JAN_2023, dashData.caixaM], backgroundColor: [Config.theme.purpleHex, Config.theme.orangeHex], borderRadius: 6, maxBarThickness: 90, barPercentage: 0.8, categoryPercentage: 0.8 }] }),
            () => ({
                ...ChartManager.baseOptions(),
                plugins: { ...ChartManager.baseOptions().plugins, legend: { display: false } },
                scales: {
                    x: { display: true, grid: { display: false }, border: { display: false }, ticks: { color: '#6B5E6B', font: { family: "'Manrope'", size: 12.5, weight: 700 }, padding: 10 } },
                    y: {
                        display: true, beginAtZero: true,
                        grid: { color: 'rgba(107, 94, 107, 0.10)', drawTicks: false, drawBorder: false },
                        border: { display: false },
                        ticks: { color: '#9B8FA0', font: { family: "'Manrope'", size: 10.5, weight: 500 }, padding: 8, maxTicksLimit: 5, callback: v => Utils.fmtD(v) }
                    }
                }
            })
        );
        updateQuitacaoChart();
    };

    const exportExcel = (type) => {
        if (typeof XLSX === 'undefined') { alert('Biblioteca de exportação carregando...'); return; }
        const dateStr = new Date().toISOString().split('T')[0];
        let data, filename, sheetName;
        if (type === 'sintetico') {
            data = currentFilteredSintetico.map(c => ({ 'Natureza': c.natureza, 'Tributo': c.tributo, 'Número': c.numero, 'Órgão': c.orgao, 'Parcelas': c.qtdParcela, 'Atraso': c.atraso, 'Total Dívida': c.totalDivida, 'Valor Parcela': c.parcelaUnit }));
            filename = `ONTIME_Sintetico_${dateStr}.xlsx`; sheetName = 'Resumo Sintético';
        } else {
            data = (lastDetalhadoFiltered.length ? lastDetalhadoFiltered : DataService.getRawData()).map(r => ({ 'Data': Utils.formatDateBR(r['Data']), 'Número': r['Número'] || r['Negociação'] || '-', 'Órgão': r['Orgão'] || '-', 'Natureza': r['Natureza'] || '-', 'Valor Original': Utils.num(r['Valor Original']), 'Saldo Devedor': Utils.num(r['Saldo Devedor']), 'Status': r['Status'] || '-' }));
            filename = `ONTIME_Detalhado_${dateStr}.xlsx`; sheetName = 'Detalhamento';
        }
        if (!data.length) { alert('Sem dados para exportar.'); return; }
        try {
            const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), sheetName); XLSX.writeFile(wb, filename);
        } catch (err) { console.error(err); alert('Erro ao gerar planilha.'); }
    };

    const exportPDF = async () => {
        if (typeof jspdf === 'undefined') { alert('Biblioteca PDF carregando...'); return; }
        const btn = $('btnExportPDF'), origHTML = btn.innerHTML;
        btn.classList.add('loading'); btn.innerHTML = '<i class="ph-bold ph-spinner"></i> <span>Gerando...</span>';
        await new Promise(r => setTimeout(r, 100));

        const t = Config.theme;
        try {
            const { jsPDF } = jspdf;
            const pdf = new jsPDF('l', 'mm', 'a4');
            const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight(), margin = 14;

            // Página 1: Dashboard (Ajustado para Fundo Claro V8)
            pdf.setFillColor(...t.bgDark);
            pdf.rect(0, 0, pageW, pageH, 'F');
            pdf.setTextColor(...t.purple);
            pdf.setFontSize(18); pdf.setFont('helvetica', 'bold');
            pdf.text(`Visão Estratégica - Data Base: ${Config.MONTH_NAMES[currMonth]}/${currYear}`, margin, margin + 5);
            pdf.setTextColor(...t.textMuted); pdf.setFontSize(10); pdf.setFont('helvetica', 'normal');
            pdf.text(`Gerado em ${new Date().toLocaleDateString('pt-BR')}`, margin, margin + 12);

            const kpiY = margin + 20, kpiW = (pageW - (margin * 2) - 10) / 3, kpiH = 28;
            const drawKPI = (x, title, value, color) => {
                pdf.setFillColor(...t.surface1);
                pdf.rect(x, kpiY, kpiW, kpiH, 'F');
                // Título KPI
                pdf.setTextColor(...t.textMuted); pdf.setFontSize(10); pdf.setFont('helvetica', 'bold');
                pdf.text(title, x + 5, kpiY + 8);
                // Valor KPI (Em Tinta escura, pois estamos no modo claro V8)
                pdf.setTextColor(...t.textWhite); pdf.setFontSize(22); pdf.setFont('helvetica', 'bold');
                pdf.text(value, x + 5, kpiY + 22);
            };

            drawKPI(margin, 'SALDO DEVEDOR TOTAL', $('kpi-saldo').textContent, t.purple);
            drawKPI(margin + kpiW + 5, 'CONTRATOS ATIVOS', $('kpi-ativas').textContent, t.orange);
            drawKPI(margin + (kpiW * 2) + 10, `A VENCER ${Config.MONTH_NAMES[currMonth]}/${currYear}`.toUpperCase(), $('kpi-mes').textContent, t.green);

            const chartY = kpiY + kpiH + 8, chartW = (pageW - (margin * 2) - 8) / 2, chartH = 68;
            const drawChart = (x, y, w, h, title, chartObj) => {
                pdf.setFillColor(...t.surface1);
                pdf.rect(x, y, w, h, 'F');
                pdf.setTextColor(...t.textWhite); pdf.setFontSize(12); pdf.setFont('helvetica', 'bold');
                pdf.text(title, x + 5, y + 8);
                if (chartObj) pdf.addImage(chartObj.toBase64Image('image/png', 1.0), 'PNG', x + 2, y + 10, w - 4, h - 12);
            };

            drawChart(margin, chartY, chartW, chartH, 'Débitos por Órgão', ChartManager.getChart('abertura'));
            drawChart(margin + chartW + 8, chartY, chartW, chartH, 'Efeito Caixa', ChartManager.getChart('caixa'));
            drawChart(margin, chartY + chartH + 8, pageW - (margin * 2), 65, 'Quitação Prevista', ChartManager.getChart('quitacao'));

            // Página 2: Sintético
            pdf.addPage();
            pdf.setFillColor(...t.bgDark); pdf.rect(0, 0, pageW, pageH, 'F');
            pdf.setTextColor(...t.purple); pdf.setFontSize(18); pdf.setFont('helvetica', 'bold');
            pdf.text('Resumo Sintético de Parcelamentos', margin, margin + 5);
            pdf.setTextColor(...t.textMuted); pdf.setFontSize(10); pdf.setFont('helvetica', 'normal');
            pdf.text(`Gerado em ${new Date().toLocaleDateString('pt-BR')}`, margin, margin + 12);

            const rows = currentFilteredSintetico.map(c => [c.natureza, c.tributo, c.numero, c.orgao, c.qtdParcela, c.atraso, Utils.fmt(c.totalDivida), Utils.fmt(c.parcelaUnit)]);
            let sumDivida = 0, sumParcela = 0; currentFilteredSintetico.forEach(c => { sumDivida += c.totalDivida; sumParcela += c.parcelaUnit; });
            rows.push(['', '', '', '', '', 'TOTAIS', Utils.fmt(sumDivida), Utils.fmt(sumParcela)]);

            pdf.autoTable({
                head: [['Natureza', 'Tributo', 'Número', 'Órgão', 'Parc.', 'Atraso', 'Total Dívida (R$)', 'Vlr Parcela (R$)']],
                body: rows, startY: margin + 18, theme: 'grid',
                styles: { fillColor: t.surface1, textColor: t.textWhite, lineColor: t.gridLine, lineWidth: 0.1, font: 'helvetica', fontSize: 9 },
                headStyles: { fillColor: t.surface2, textColor: t.textMuted, fontStyle: 'bold', fontSize: 8 },
                alternateRowStyles: { fillColor: t.surfaceAlt },
                willDrawCell: (data) => { if (data.row.index === rows.length - 1) { pdf.setFillColor(...t.surface2); pdf.setTextColor(...t.orange); pdf.setFont('helvetica', 'bold'); } },
                margin: { left: 14, right: 14 },
                didDrawPage: (d) => { if (d.pageNumber > 1) { pdf.setFillColor(...t.bgDark); pdf.rect(0, 0, pageW, pageH, 'F'); } },
            });
            pdf.save(`ONTIME_Relatorio_${new Date().toISOString().split('T')[0]}.pdf`);
        } catch (err) { console.error(err); alert('Erro ao gerar PDF.'); }
        finally { btn.classList.remove('loading'); btn.innerHTML = origHTML; }
    };

    const showError = (message, detail) => {
        const loader = $('loader'); loader.textContent = '';
        const p = Utils.el('p', message); p.style.color = 'var(--err)'; p.style.fontWeight = '600'; loader.appendChild(p);
        if (detail) { const small = Utils.el('small', detail); small.style.color = 'var(--muted)'; loader.appendChild(small); }
        const btnRetry = Utils.el('button', 'Tentar novamente', 'btn-retry');
        btnRetry.addEventListener('click', () => {
            loader.textContent = ''; loader.appendChild(Utils.el('div', null, 'spinner')); loader.appendChild(Utils.el('p', 'Sincronizando dados...')); init();
        });
        loader.appendChild(btnRetry);
    };

    const init = async () => {
        try { await DataService.load(); } catch (err) { showError('Erro ao acessar os dados.', err.message); return; }
        try {
            const st = new Date();
            $('lastSync').textContent = st.toLocaleDateString('pt-BR') + ' ' + st.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            DataService.processConsolidation(currYear, currMonth);
        } catch (err) { showError('Erro ao processar os dados.', err.message); return; }
        try { populateFilters(); populateYears(); initDataBaseSelector(); } catch (err) { showError('Erro ao montar os filtros.', err.message); return; }
        try {
            updateDashboard(); filterSintetico();
            lastDetalhadoFiltered = DataService.getRawData();
            renderDetalhado(applySort(DataService.getRawData(), 'detalhado'));
            $('loader').style.display = 'none'; $('app-content').style.display = 'flex';
            initScrollSpy();
        } catch (err) { showError('Erro ao renderizar o dashboard.', err.message); }
    };

    const bindEvents = () => {
        $('sidebarOverlay').addEventListener('click', toggleSidebar);
        $('btnHamburger').addEventListener('click', toggleSidebar);
        document.querySelectorAll('.nav-item[data-target]').forEach(btn => {
            btn.addEventListener('click', () => { scrollToSection(btn.dataset.target); if (window.innerWidth <= 1024) toggleSidebar(); });
        });
        $('dataBaseMes').addEventListener('change', changeDataBase);
        $('dataBaseAno').addEventListener('change', changeDataBase);
        $('btnExcelSint').addEventListener('click', () => exportExcel('sintetico'));
        $('btnExcelDet').addEventListener('click', () => exportExcel('detalhado'));
        $('btnExportPDF').addEventListener('click', exportPDF);
        $('searchSintetico').addEventListener('input', filterSintetico);
        $('filterSinteticoNatureza').addEventListener('change', filterSintetico);
        $('filterSinteticoOrgao').addEventListener('change', filterSintetico);
        $('searchDetalhado').addEventListener('input', filterDetalhado);
        $('filterDetalhadoOrgao').addEventListener('change', filterDetalhado);
        $('filterDetalhadoNatureza').addEventListener('change', filterDetalhado);
        $('filterDetalhadoStatus').addEventListener('change', filterDetalhado);
        $('filterDetalhadoMes').addEventListener('change', filterDetalhado);
        $('filterDetalhadoAno').addEventListener('change', filterDetalhado);
        document.querySelectorAll('th[data-sort-table]').forEach(th => th.addEventListener('click', () => doSort(th.dataset.sortTable, th.dataset.sortCol)));
    };

    document.addEventListener('DOMContentLoaded', () => {
        HubLink.init(); // Inicia a validação da Origem (Sessão / Hub)
        bindEvents();
        init();
    });

    return { toggleSidebar, scrollToSection };
})();