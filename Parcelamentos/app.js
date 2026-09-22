/* =================================================================
   HUB LINK — Validação Inteligente de Origem
   ================================================================= */
const HubLink = {
    HUB_PATH_PREFIX: '/',   // o hub mora na raiz do domínio

    /* A pasta desta ferramenta, seja qual for o endereço em que ela esteja.
       Descobrir em vez de fixar é o que faz isto continuar certo quando o
       endereço muda. */
    pasta() { return location.pathname.replace(/[^/]*$/, ''); },
    STORAGE_KEY: 'came_from_hub_parcelamentos',

    init() {
        const btn = document.getElementById('btn-hub');
        const linkAtualizar = document.getElementById('link-atualizar');

        if (this._userCameFromHub()) {
            if (btn) btn.hidden = false;
            if (linkAtualizar) linkAtualizar.hidden = false;
            try { sessionStorage.setItem(this.STORAGE_KEY, '1'); } catch (e) { }
        }
    },

    _userCameFromHub() {
        try {
            if (document.referrer) {
                const ref = new URL(document.referrer);
                const sameOrigin = ref.origin === location.origin;
                const isHubPath = ref.pathname.startsWith(this.HUB_PATH_PREFIX);
                const isSelfPath = ref.pathname.startsWith(this.pasta());
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
   QUEM ESTÁ LOGADO, SEGUNDO O CLOUDFLARE ACCESS
   -----------------------------------------------------------------
   A ferramenta roda atrás do Access, que já sabe quem entrou. Este
   endereço é servido pelo próprio Cloudflare, na mesma origem da
   página, e devolve o e-mail da sessão — sem senha, sem configuração,
   sem chamada para fora.

   Fora do Access (github.io, arquivo aberto do disco) ele não existe:
   a função devolve vazio e a gravação segue como antes, sem autor.

   O que isto NÃO é: o e-mail viaja no corpo da mensagem, escrito por
   esta página. Quem contornar o hub e postar direto no endereço do
   script pode escrever o e-mail que quiser. Isto serve para
   identificar no Log quem gravou, não para provar.
   ================================================================= */
async function identidadeAccess() {
    try {
        const r = await fetch('/cdn-cgi/access/get-identity', { credentials: 'include' });
        if (!r.ok) return '';
        const d = await r.json();
        return String((d && (d.email || d.name)) || '').trim();
    } catch (e) { return ''; }
}

/* Pergunta uma vez, no carregamento. Quem grava espera esta promessa,
   para o autor não sair vazio por uma fração de segundo de diferença. */
const IDENTIDADE = identidadeAccess().catch(() => '');

/* =================================================================
   Configuração centralizada — Atualizado p/ Modo Claro (V8)
   ================================================================= */
const Config = Object.freeze({
    /* A leitura vai direto ao Apps Script. Passava por um Worker na conta
       pessoal do Cloudflare que só repassava a resposta: um endereço a mais,
       fora do login do hub, e uma peça a mais para cair — sem ganhar um
       segundo sequer. */
    API_URL: 'https://script.google.com/macros/s/AKfycbxH_wgQAaUif1nohXLzcAHqnYDW1m7ICbFd_6Xn5YU1cve-66EvOGGetrHbsXILRHR0MQ/exec',
    APP_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbxH_wgQAaUif1nohXLzcAHqnYDW1m7ICbFd_6Xn5YU1cve-66EvOGGetrHbsXILRHR0MQ/exec',
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
        orangeDeep:  '#D25500',
        purpleHex:   '#3C003C',
        prevYearHex: '#E4DFE4',   // ano anterior: cinza-ameixa, recua para o laranja se destacar
        prevYearLine:'#CFC7CF',
    }),
});

/* =================================================================
   Comprovantes — anexar / ver / excluir por parcela (Detalhamento)
   Só habilita anexar/excluir se o usuário veio pelo hub (mesma regra
   do botão "voltar ao hub"). Upload/exclusão via Apps Script (no-cors).
   ================================================================= */
const Comprov = (() => {
    let canEdit = false;
    let onChanged = null;
    let pending = null;          // {numero, comp} aguardando o arquivo
    let pendingDelete = null;    // {numero, comp} aguardando confirmação
    let getData = null;          // () => registros atuais (pra conferir se a gravação pegou)
    let ui = null;

    const competenciaDe = (v) => {
        const s = String(v == null ? '' : v).trim();
        let m = s.match(/^(\d{4})-(\d{2})/);          // ISO ou YYYY-MM
        if (m) return m[1] + '-' + m[2];
        m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);     // DD/MM/AAAA
        if (m) return m[3] + '-' + m[2];
        return '';
    };

    const fileToBase64 = (file) => new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => { const s = String(r.result); const i = s.indexOf(','); res(i >= 0 ? s.slice(i + 1) : s); };
        r.onerror = () => rej(new Error('Falha ao ler o arquivo'));
        r.readAsDataURL(file);
    });

    // Após recarregar, confere se a parcela tem (ou não) o comprovante — pra dar
    // retorno honesto, já que a gravação no-cors não devolve resposta.
    const checkHas = (numero, comp) => {
        try {
            const rows = (getData && getData()) || [];
            return rows.some(r => {
                const n = r['Número'] || r['Negociação'] || '';
                if (String(n) !== String(numero)) return false;
                if (competenciaDe(r['Data']) !== comp) return false;
                const u = r['Comprovante'];
                return u && /^https?:\/\//i.test(u);
            });
        } catch (e) { return false; }
    };

    const ensureUI = () => {
        if (ui) return ui;

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*,application/pdf,.pdf';
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);
        fileInput.addEventListener('change', () => {
            const f = fileInput.files && fileInput.files[0];
            fileInput.value = '';
            const p = pending; pending = null;
            if (f && p) doUpload(p.numero, p.comp, f);
        });

        const overlay = document.createElement('div');
        overlay.className = 'cmp-overlay';
        const box = document.createElement('div'); box.className = 'cmp-overlay-box';
        const sp = document.createElement('div'); sp.className = 'cmp-spinner';
        const overlayText = document.createElement('div'); overlayText.textContent = 'Processando…';
        box.appendChild(sp); box.appendChild(overlayText); overlay.appendChild(box);
        document.body.appendChild(overlay);

        const toastEl = document.createElement('div');
        toastEl.className = 'cmp-toast';
        document.body.appendChild(toastEl);

        const modal = document.createElement('div');
        modal.className = 'cmp-modal';
        modal.innerHTML =
            '<div class="cmp-modal-box">' +
              '<div class="cmp-modal-icon"><i class="ph-bold ph-trash"></i></div>' +
              '<h3>Excluir comprovante?</h3>' +
              '<p>O arquivo vai para a Lixeira do Drive (recuperável por 30 dias). Esta parcela ficará sem comprovante.</p>' +
              '<div class="cmp-modal-actions">' +
                '<button type="button" class="cmp-btn-cancel">Cancelar</button>' +
                '<button type="button" class="cmp-btn-danger">Excluir</button>' +
              '</div>' +
            '</div>';
        document.body.appendChild(modal);
        const closeModal = () => { modal.classList.remove('show'); pendingDelete = null; };
        modal.querySelector('.cmp-btn-cancel').addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
        modal.querySelector('.cmp-btn-danger').addEventListener('click', () => {
            const p = pendingDelete; modal.classList.remove('show'); pendingDelete = null;
            if (p) doDelete(p.numero, p.comp);
        });

        ui = { fileInput, overlay, overlayText, toast: toastEl, modal };
        return ui;
    };

    const showOverlay = (on, text) => {
        const u = ensureUI();
        if (text) u.overlayText.textContent = text;
        u.overlay.classList.toggle('show', !!on);
    };
    const toast = (msg) => {
        const u = ensureUI();
        u.toast.textContent = msg;
        u.toast.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => u.toast.classList.remove('show'), 3800);
    };

    /* O autor entra aqui, num lugar só: assim toda gravação já sai
       identificada, inclusive as que forem escritas depois. O backend lê
       este campo como 'usuario' e registra no log da planilha. */
    const post = async (payload) => {
        const usuario = await IDENTIDADE;
        return fetch(Config.APP_SCRIPT_URL, {
            method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ usuario }, payload)),
        });
    };

    const reloadNow = async () => {
        // dá um tempo pro Apps Script salvar + reescrever o link, depois recarrega
        await new Promise(r => setTimeout(r, 2800));
        try { if (onChanged) await onChanged(); } catch (e) { console.error('[comprov] reload:', e); }
        showOverlay(false);
    };

    const doUpload = async (numero, comp, file) => {
        const okType = (file.type && (file.type.indexOf('image/') === 0 || file.type.indexOf('pdf') >= 0)) || /\.(png|jpe?g|gif|webp|heic|pdf)$/i.test(file.name);
        if (!okType) { toast('Tipo não aceito. Use imagem ou PDF.'); return; }
        if (file.size > 15 * 1024 * 1024) { toast('Arquivo grande demais (máx. 15 MB).'); return; }
        showOverlay(true, 'Enviando comprovante…');
        try {
            const dataBase64 = await fileToBase64(file);
            await post({ acao: 'comprovante', numero, competencia: comp, filename: file.name, mimeType: file.type || 'application/octet-stream', dataBase64 });
            await reloadNow();
            if (getData && !checkHas(numero, comp)) {
                toast('Não foi possível confirmar a gravação. Atualize a página e tente de novo.');
            } else {
                toast('Comprovante anexado.');
            }
        } catch (e) {
            showOverlay(false);
            toast('Erro ao enviar: ' + (e.message || e));
        }
    };

    const doDelete = async (numero, comp) => {
        showOverlay(true, 'Excluindo comprovante…');
        try {
            await post({ acao: 'excluir_comprovante', numero, competencia: comp });
            await reloadNow();
            if (getData && checkHas(numero, comp)) {
                toast('Não foi possível confirmar a exclusão. Atualize a página e tente de novo.');
            } else {
                toast('Comprovante excluído.');
            }
        } catch (e) {
            showOverlay(false);
            toast('Erro ao excluir: ' + (e.message || e));
        }
    };

    const requestAttach = (numero, comp) => {
        ensureUI(); pending = { numero, comp }; ui.fileInput.click();
    };
    const requestRemove = (numero, comp) => {
        ensureUI(); pendingDelete = { numero, comp }; ui.modal.classList.add('show');
    };

    // monta o conteúdo da célula "Comprovante" de uma parcela
    const buildCell = (r) => {
        const url = r['Comprovante'];
        const numero = r['Número'] || r['Negociação'] || '';
        const comp = competenciaDe(r['Data']);
        const wrap = document.createElement('div');
        wrap.className = 'cmp-cell';
        const hasUrl = url && /^https?:\/\//i.test(url);

        if (hasUrl) {
            const a = document.createElement('a');
            a.href = url; a.target = '_blank'; a.rel = 'noopener';
            a.className = 'cmp-ver';
            a.innerHTML = '<i class="ph ph-paperclip"></i> Ver';
            wrap.appendChild(a);
            if (canEdit && numero && comp) {
                const del = document.createElement('button');
                del.type = 'button'; del.className = 'cmp-del'; del.title = 'Excluir comprovante';
                del.innerHTML = '<i class="ph ph-x"></i>';
                del.addEventListener('click', () => requestRemove(numero, comp));
                wrap.appendChild(del);
            }
        } else if (canEdit && numero && comp) {
            const btn = document.createElement('button');
            btn.type = 'button'; btn.className = 'cmp-anexar';
            btn.innerHTML = '<i class="ph ph-paperclip"></i> Anexar';
            btn.addEventListener('click', () => requestAttach(numero, comp));
            wrap.appendChild(btn);
        } else {
            const dash = document.createElement('span');
            dash.className = 'cmp-dash'; dash.textContent = '—';
            wrap.appendChild(dash);
        }
        return wrap;
    };

    const configure = (opts) => {
        canEdit = !!opts.canEdit;
        onChanged = opts.onChanged || null;
        getData = opts.getData || null;
    };

    return { buildCell, configure };
})();

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

    /* Rótulo curto para cima das barras: 85,3k · 422k · 1,2M. Curto de
       propósito — duas barras por mês não comportam "R$ 421.634,00". */
    const fmtCompact = (v) => {
        const n = Number(v) || 0, a = Math.abs(n);
        const dec = (x, d) => x.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: d });
        if (a >= 1e6) return dec(n / 1e6, 1) + 'M';
        if (a >= 1e3) return dec(n / 1e3, a >= 1e5 ? 0 : 1) + 'k';
        return dec(n, 0);
    };

    const fmtPct = (v) =>
        new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(v || 0);

    /* Degradê que acompanha a área do gráfico (serve na tela e no PDF). */
    const barGradient = (c1, c2) => (ctx) => {
        const { ctx: c, chartArea } = ctx.chart;
        if (!chartArea) return c1;
        const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
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
        fmtK: fmtCompact,
        pct: fmtPct,
        num: parseNum,
        debounce,
        grad: barGradient,
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
/* =================================================================
   CÓPIA DA BASE NESTE NAVEGADOR
   -----------------------------------------------------------------
   O Apps Script leva de 3 a 40 segundos para responder, e a tela
   passava esse tempo todo no esqueleto. Agora ela abre na hora com a
   última base que chegou inteira e busca a nova por trás.

   A cópia vai comprimida — os 530 KB da base viram menos de 60 —,
   porque o armazenamento do navegador é um só para todas as
   ferramentas do hub, e o Fluxo já guarda o ano dele ali. Navegador
   sem compressão, ou sem espaço, só fica sem o atalho: a tela abre
   como antes.
   ================================================================= */
const CopiaBase = (() => {
    const K = 'parc_base_v1';
    const pode = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
    const paraTexto = (u8) => {
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        return btoa(s);
    };
    const deTexto = (b64) => {
        const s = atob(b64), u8 = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
        return u8;
    };
    const guardar = async (texto) => {
        if (!pode()) return;
        try {
            const fluxo = new Blob([texto]).stream().pipeThrough(new CompressionStream('gzip'));
            const z = paraTexto(new Uint8Array(await new Response(fluxo).arrayBuffer()));
            localStorage.setItem(K, JSON.stringify({ quando: Date.now(), z }));
        } catch (e) { /* sem espaço: segue sem cópia */ }
    };
    const ler = async () => {
        if (!pode()) return null;
        try {
            const bruto = localStorage.getItem(K);
            if (!bruto) return null;
            const c = JSON.parse(bruto);
            if (!c || !c.z || !c.quando) return null;
            const fluxo = new Blob([deTexto(c.z)]).stream().pipeThrough(new DecompressionStream('gzip'));
            return { quando: c.quando, texto: await new Response(fluxo).text() };
        } catch (e) { return null; }
    };
    const esquecer = () => { try { localStorage.removeItem(K); } catch (e) {} };
    return { guardar, ler, esquecer };
})();

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
                    comprovante: '',
                };
            }

            map[id].qtdParcela++;
            const originalStatus = String(row['Status'] || '').trim().toLowerCase();

            if (mesAnoBase < inativo) {
                if (mesAnoP === mesAnoBase && !originalStatus.includes('encerrado')) {
                    map[id].parcelaUnit += saldoDevedor;
                    if (row['Comprovante']) map[id].comprovante = row['Comprovante'];
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

    /* Uma porta só para os dados entrarem, venham da base ou da cópia. A
       consolidação guardada por mês é jogada fora aqui: ela era da base de
       antes, e a tela continuaria mostrando os números velhos. */
    const aplicar = (json) => {
        if (!Array.isArray(json)) throw new Error((json && json.error) || 'a base respondeu num formato inesperado');
        rawData = json
            .map(normalizeKeys)
            .filter(r => r['Número'] || r['Negociação']);
        consolidationCache.clear();
        buildLifeCycleMaps();
        buildIndexes();
    };

    /* Devolve a hora em que a base chegou. */
    const load = async () => {
        const url = Config.API_URL + (Config.API_URL.includes('?') ? '&' : '?') + 'v=' + Date.now();
        const json = await fetchWithRetry(url);
        aplicar(json);
        CopiaBase.guardar(JSON.stringify(json));
        return Date.now();
    };

    /* Devolve a hora em que a cópia foi guardada, ou null sem cópia boa. */
    const loadCopia = async () => {
        const c = await CopiaBase.ler();
        if (!c) return null;
        try { aplicar(JSON.parse(c.texto)); }
        catch (e) { CopiaBase.esquecer(); return null; }
        return c.quando;
    };

    return {
        load,
        loadCopia,
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
    const instances = { abertura: null, quitacao: null, caixa: null, anual: null };
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

        // Coluna Comprovante: link do pagamento do mês (ou "—" se não tiver)
        const tdComprov = document.createElement('td');
        const comprovUrl = c.comprovante;
        if (comprovUrl && /^https?:\/\//i.test(comprovUrl)) {
            const a = document.createElement('a');
            a.href = comprovUrl;
            a.target = '_blank';
            a.rel = 'noopener';
            a.style.cssText = 'display:inline-flex;align-items:center;gap:5px;color:#FF6E00;text-decoration:none;font-weight:600;font-size:12.5px;white-space:nowrap;';
            a.innerHTML = '<i class="ph ph-paperclip"></i> Ver';
            tdComprov.appendChild(a);
        } else {
            tdComprov.textContent = '—';
            tdComprov.style.color = 'var(--muted)';
        }
        tr.appendChild(tdComprov);

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

        // Coluna Comprovante: Ver / Anexar / Excluir por parcela
        const tdComprov = document.createElement('td');
        tdComprov.appendChild(Comprov.buildCell(r));
        tr.appendChild(tdComprov);

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

        tr.appendChild(document.createElement('td')); // coluna Comprovante (sem total)

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
    let anualData = null;
    let anualModo = 'vencimento';   // 'vencimento' | 'quitadas'

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

    const getFilteredDetData = () => {
        const t = $('searchDetalhado').value.toLowerCase(), fO = $('filterDetalhadoOrgao').value.toLowerCase(),
              fN = $('filterDetalhadoNatureza').value.toLowerCase(), fS = $('filterDetalhadoStatus').value.toLowerCase(),
              fM = $('filterDetalhadoMes').value, fA = $('filterDetalhadoAno').value;

        return DataService.getRawData().filter(r => {
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
    };

    const filterDetalhado = Utils.debounce(() => {
        const f = getFilteredDetData();
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

    // re-renderiza as duas tabelas preservando a página atual (usado após anexar/excluir)
    const reRenderTables = () => {
        currentFilteredSintetico = applySort(getFilteredSint(), 'sintetico');
        pagination.sintetico.data = currentFilteredSintetico;
        pagination.sintetico.page = Math.min(pagination.sintetico.page, totPages('sintetico'));
        TableRenderer.renderSintRows(getSlice('sintetico'));
        renderPagination('sintetico', 'paginationSintetico');
        TableRenderer.renderTotals(currentFilteredSintetico);

        const f = applySort(getFilteredDetData(), 'detalhado');
        lastDetalhadoFiltered = f;
        pagination.detalhado.data = f;
        pagination.detalhado.page = Math.min(pagination.detalhado.page, totPages('detalhado'));
        TableRenderer.renderDetRows(getSlice('detalhado'));
        renderPagination('detalhado', 'paginationDetalhado');
        TableRenderer.renderDetFooter(f.length);
    };

    const reloadData = async () => {
        const quando = await DataService.load();
        DataService.processConsolidation(currYear, currMonth);
        reRenderTables();
        marcarBase(quando, 'nova');
    };

    const setOrgaoFilter = (orgao) => {
        selectedOrgao = selectedOrgao === orgao ? null : orgao;
        updateFilterBadge(); updateKPIs(); updateQuitacaoChart(); updateAnualChart(); filterSintetico();
    };

    const clearOrgaoFilter = () => {
        selectedOrgao = null;
        updateFilterBadge(); updateKPIs(); updateQuitacaoChart(); updateAnualChart(); filterSintetico();
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

    /* ------------------------------------------------------------------
       RECEITAS DOS GRÁFICOS
       ------------------------------------------------------------------
       Cada gráfico é uma função que devolve {type, data, options}. A tela
       usa a receita como está; o PDF usa a mesma receita para redesenhar
       o gráfico fora da tela, no tamanho exato da caixa da página — em
       vez de copiar o canvas da tela e esticá-lo, que deixava a imagem
       borrada e deformada.
       ------------------------------------------------------------------ */
    const AXIS_TICK = { color: '#9B8FA0', font: { family: "'Manrope'", size: 10.5, weight: 500 }, padding: 8, maxTicksLimit: 5 };
    const GRID = { color: 'rgba(107, 94, 107, 0.10)', drawTicks: false };
    const CAT_TICK = (weight) => ({ color: '#6B5E6B', font: { family: "'Manrope'", size: 12.5, weight } });

    const aberturaColors = (orgE) => orgE.map(e => e[0] === selectedOrgao ? Config.theme.orangeLight : Config.theme.orangeHex);

    const computeQuitacao = () => {
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

        const labels = [], data = [];
        let restante = totalF;
        Object.keys(anoF).map(Number).sort().forEach(y => {
            if (anoF[y] > 0) { labels.push(String(y)); data.push(restante); restante -= anoF[y]; }
        });
        return { labels, data };
    };

    /* Pagamentos por mês, em dois critérios:
       • 'vencimento' (padrão): soma das parcelas com vencimento no mês, com a
         mesma regra do "A Vencer no Mês" / Efeito Caixa — ignora parcelas
         encerradas e contratos já inativos naquele mês. Assim a barra do mês
         da data-base bate com o KPI. Os meses depois da data-base aparecem
         como "previsto".
       • 'quitadas': só parcelas com status Quitada — o que de fato foi pago.
         Aqui não existe previsto.
       O ano anterior aparece inteiro nos dois casos. */
    const computeAnual = () => {
        const ano = currYear, anoAnt = currYear - 1, soQuitadas = anualModo === 'quitadas';
        const atualAno = new Array(12).fill(0), anterior = new Array(12).fill(0);
        const inativoMap = DataService.getInativoMap();

        DataService.getRawData().forEach(row => {
            const d = Utils.parseDateBR(row['Data']); if (!d) return;
            const y = d.getUTCFullYear(); if (y !== ano && y !== anoAnt) return;
            if (selectedOrgao && (row['Orgão'] || '-') !== selectedOrgao) return;
            const id = row['Número'] || row['Negociação'] || 'S/N';
            const m = d.getUTCMonth();
            if (Utils.mesAno(y, m) >= (inativoMap[id] || Infinity)) return;
            const status = String(row['Status'] || '').trim().toLowerCase();
            if (status.includes('encerrado')) return;
            if (soQuitadas && !status.includes('quitad')) return;
            (y === ano ? atualAno : anterior)[m] += Utils.num(row['Saldo Devedor']);
        });

        const somaAte = (arr, ate) => arr.reduce((s, v, i) => (i <= ate ? s + v : s), 0);
        const totalAtual = somaAte(atualAno, currMonth);
        const totalPrevisto = soQuitadas ? 0 : somaAte(atualAno, 11) - totalAtual;
        return {
            ano, anoAnt, modo: anualModo,
            atual: atualAno.map((v, i) => (i <= currMonth ? v : null)),
            previsto: atualAno.map((v, i) => (!soQuitadas && i > currMonth ? v : null)),
            anterior,
            totalAtual,
            totalPrevisto,
            totalAntPeriodo: somaAte(anterior, currMonth),
            totalAnt: somaAte(anterior, 11),
        };
    };

    /* Os cartões de totais do comparativo — a tela e o PDF leem daqui. */
    const anualStats = (a) => {
        const periodo = currMonth === 11 ? 'ano' : `Jan–${Config.MONTH_NAMES[currMonth]}`;
        const r = a.totalAntPeriodo > 0 ? a.totalAtual / a.totalAntPeriodo - 1 : null;
        const stats = [
            { label: `${a.ano} · ${periodo}`, value: Utils.fmtD(a.totalAtual), swatch: 'atual' },
            { label: `${a.anoAnt} · ${periodo}`, value: Utils.fmtD(a.totalAntPeriodo), swatch: 'anterior' },
            { label: 'Variação', value: r == null ? '—' : Utils.pct(r), delta: r },
        ];
        if (a.totalPrevisto > 0) {
            const proj = a.totalAtual + a.totalPrevisto;
            stats.push({
                label: `${a.ano} · projetado`, value: Utils.fmtD(proj), swatch: 'previsto',
                note: a.totalAnt > 0 ? `${a.anoAnt}: ${Utils.fmtD(a.totalAnt)} (${Utils.pct(proj / a.totalAnt - 1)})` : '',
            });
        } else if (currMonth < 11) {
            stats.push({ label: `${a.anoAnt} · ano completo`, value: Utils.fmtD(a.totalAnt) });
        }
        return stats;
    };

    /* Listras para o "previsto": a diferença não fica só na cor (ajuda em
       impressão em preto e branco e para quem não distingue bem tons). */
    const stripeCache = new WeakMap();
    const listrado = (cor, fundo) => (c) => {
        const ctx = c.chart.ctx;
        if (stripeCache.has(ctx)) return stripeCache.get(ctx);
        const s = 8, cv = document.createElement('canvas');
        cv.width = cv.height = s;
        const g = cv.getContext('2d');
        g.fillStyle = fundo; g.fillRect(0, 0, s, s);
        g.strokeStyle = cor; g.lineWidth = 1.6; g.beginPath();
        g.moveTo(-1, s + 1); g.lineTo(s + 1, -1);
        g.moveTo(-1, 1); g.lineTo(1, -1);
        g.moveTo(s - 1, s + 1); g.lineTo(s + 1, s - 1);
        g.stroke();
        const p = ctx.createPattern(cv, 'repeat');
        stripeCache.set(ctx, p);
        return p;
    };

    const recipes = {
        abertura: (print) => {
            const orgE = dashData.orgEntries;
            return {
                type: 'bar',
                data: { labels: orgE.map(e => e[0]), datasets: [{ data: orgE.map(e => e[1]), backgroundColor: aberturaColors(orgE), borderRadius: 6, maxBarThickness: 28 }] },
                options: {
                    ...ChartManager.baseOptions(), indexAxis: 'y', layout: { padding: { right: 90, top: 20, bottom: 10 } },
                    scales: {
                        x: { display: true, grace: '15%', beginAtZero: true, grid: GRID, border: { display: false }, ticks: { ...AXIS_TICK, callback: v => Utils.fmtD(v) } },
                        y: { display: true, grid: { display: false }, border: { display: false }, ticks: { ...CAT_TICK(600), padding: 8 } },
                    },
                    ...(print ? {} : {
                        onClick: (_evt, elements) => {
                            if (!elements.length) return;
                            setOrgaoFilter(orgE[elements[0].index][0]);
                            const chart = ChartManager.getChart('abertura');
                            if (chart) { chart.data.datasets[0].backgroundColor = aberturaColors(orgE); chart.update('none'); }
                        },
                        onHover: (evt, elements) => { evt.native.target.style.cursor = elements.length ? 'pointer' : 'default'; },
                    }),
                },
            };
        },

        caixa: () => ({
            type: 'bar',
            data: { labels: ['Jan/2023', `${Config.MONTH_NAMES[currMonth]}/${currYear}`], datasets: [{ data: [Config.CAIXA_JAN_2023, dashData.caixaM], backgroundColor: [Config.theme.purpleHex, Config.theme.orangeHex], borderRadius: 6, maxBarThickness: 90, barPercentage: 0.8, categoryPercentage: 0.8 }] },
            options: {
                ...ChartManager.baseOptions(),
                scales: {
                    x: { display: true, grid: { display: false }, border: { display: false }, ticks: { ...CAT_TICK(700), padding: 10 } },
                    y: { display: true, beginAtZero: true, grid: GRID, border: { display: false }, ticks: { ...AXIS_TICK, callback: v => Utils.fmtD(v) } },
                },
            },
        }),

        quitacao: () => {
            const q = computeQuitacao();
            return {
                type: 'bar',
                data: { labels: q.labels, datasets: [{ data: q.data, backgroundColor: Utils.grad(Config.theme.orangeHex, Config.theme.orangeLight), borderRadius: 6, maxBarThickness: 60 }] },
                options: {
                    ...ChartManager.baseOptions(),
                    scales: {
                        x: { display: true, grid: { display: false }, border: { display: false }, ticks: CAT_TICK(600) },
                        y: { display: true, beginAtZero: true, grid: GRID, border: { display: false }, ticks: { ...AXIS_TICK, callback: v => Utils.fmtD(v) } },
                    },
                },
            };
        },

        anual: (print) => {
            const a = anualData, t = Config.theme;
            const barra = { borderWidth: 1, borderRadius: 5, borderSkipped: 'bottom', maxBarThickness: 46, categoryPercentage: 0.74, barPercentage: 0.92 };
            const base = ChartManager.baseOptions();
            // "atual" e "previsto" dividem a mesma pilha: nunca têm valor no
            // mesmo mês, então ocupam a mesma posição da barra do ano corrente
            const datasets = [
                { ...barra, stack: 'anterior', label: String(a.anoAnt), data: a.anterior, backgroundColor: t.prevYearHex, hoverBackgroundColor: '#D8D0D8', borderColor: t.prevYearLine },
                { ...barra, stack: 'atual', label: String(a.ano), data: a.atual, backgroundColor: t.orangeHex, hoverBackgroundColor: t.orangeDeep, borderColor: t.orangeDeep },
            ];
            if (a.totalPrevisto > 0) {
                datasets.push({ ...barra, stack: 'atual', label: `${a.ano} previsto`, data: a.previsto, backgroundColor: listrado('rgba(255,110,0,0.55)', '#FFF1E4'), hoverBackgroundColor: '#FFE0C4', borderColor: t.orangeHex });
            }
            return {
                type: 'bar',
                data: {
                    labels: Config.MONTH_NAMES.map(m => m.toUpperCase()),
                    datasets,
                },
                options: {
                    ...base,
                    layout: { padding: { top: 4, bottom: 0 } },
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: {
                            display: true, position: 'top', align: 'center',
                            labels: { boxWidth: 28, boxHeight: 12, useBorderRadius: true, borderRadius: 3, padding: 18, color: '#1A0F1A', font: { family: "'Manrope'", size: 12, weight: 700 } },
                        },
                        tooltip: {
                            ...base.plugins.tooltip,
                            filter: item => item.raw != null,
                            callbacks: {
                                title: items => (items.length ? Config.MONTH_NAMES_FULL[items[0].dataIndex] : ''),
                                label: ctx => ` ${ctx.dataset.label}: ${Utils.fmt(ctx.raw)}`,
                                footer: items => {
                                    if (!items.length) return '';
                                    const i = items[0].dataIndex, ant = a.anterior[i], at = a.atual[i] ?? a.previsto[i];
                                    return at == null || !ant ? '' : `Variação: ${Utils.pct(at / ant - 1)}`;
                                },
                            },
                        },
                        datalabels: {
                            color: '#4A3F4A',
                            font: { family: "'JetBrains Mono'", size: print ? 9.5 : 11, weight: 600 },
                            anchor: 'end', align: 'end', offset: 3, clamp: true,
                            formatter: v => (v > 0 ? Utils.fmtK(v) : ''),
                            // 24 rótulos não cabem em tela estreita: lá fica só o tooltip
                            display: ctx => print || ctx.chart.width >= 640,
                        },
                    },
                    scales: {
                        x: { display: true, stacked: true, grid: { display: false }, border: { display: false }, ticks: { color: '#1A0F1A', font: { family: "'Manrope'", size: 12, weight: 700 }, padding: 6 } },
                        y: { display: true, stacked: true, beginAtZero: true, grace: '14%', grid: GRID, border: { display: false }, ticks: { ...AXIS_TICK, callback: v => Utils.fmtK(v) } },
                    },
                },
            };
        },
    };

    const drawChart = (key, canvasId) => {
        const r = recipes[key](false);
        ChartManager.destroyChart(key);
        ChartManager.upsertChart(key, canvasId, r.type, () => r.data, () => r.options);
    };

    const updateQuitacaoChart = () => drawChart('quitacao', 'chartQuitacao');

    const anualSubtitulo = (a) => {
        const mes = Config.MONTH_NAMES[currMonth];
        const base = a.modo === 'quitadas'
            ? `Só parcelas quitadas · ${a.ano} até ${mes}`
            : `Parcelas com vencimento em cada mês · ${a.ano} até ${mes}` +
              (a.totalPrevisto > 0 ? `, depois previsto` : '');
        return base + (selectedOrgao ? ` · Órgão: ${selectedOrgao}` : '');
    };

    const renderAnualHeader = (a) => {
        $('anualTitle').textContent = `Comparativo Anual (${a.anoAnt} vs ${a.ano})`;
        $('anualSubtitle').textContent = anualSubtitulo(a);

        const box = $('anualStats');
        box.textContent = '';
        anualStats(a).forEach(s => {
            const card = Utils.el('div', null, 'anual-stat' + (s.delta !== undefined ? ' delta' : ''));
            const l = Utils.el('div', null, 'anual-stat-label');
            if (s.swatch) l.appendChild(Utils.el('span', null, `sw sw-${s.swatch}`));
            l.appendChild(document.createTextNode(s.label));
            const v = Utils.el('div', null, 'anual-stat-value');
            if (s.delta != null) {
                const ic = document.createElement('i');
                ic.className = s.delta >= 0 ? 'ph-bold ph-arrow-up-right' : 'ph-bold ph-arrow-down-right';
                v.appendChild(ic);
            }
            v.appendChild(document.createTextNode(s.value));
            card.appendChild(l); card.appendChild(v);
            if (s.note) card.appendChild(Utils.el('div', s.note, 'anual-stat-note'));
            box.appendChild(card);
        });
    };

    const setAnualModo = (modo) => {
        if (modo !== 'vencimento' && modo !== 'quitadas') return;
        anualModo = modo;
        try { localStorage.setItem('parcel_anual_modo', modo); } catch (e) {}
        document.querySelectorAll('#anualModo .seg-btn').forEach(b => {
            const on = b.dataset.modo === modo;
            b.classList.toggle('active', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        if (DataService.getRawData().length) updateAnualChart();
    };

    const updateAnualChart = () => {
        anualData = computeAnual();
        renderAnualHeader(anualData);
        drawChart('anual', 'chartAnual');
    };

    const updateDashboard = () => {
        computeDashData(); updateKPIs(); ChartManager.registerPlugins();

        // Resumo rápido da sidebar (totais gerais da data-base, sem filtro de órgão)
        const ssSaldo = $('ss-saldo'), ssAtivas = $('ss-ativas');
        if (ssSaldo) ssSaldo.textContent = Utils.fmtD(dashData.totalS);
        if (ssAtivas) ssAtivas.textContent = String(dashData.contSetSize);

        $('caixaSubtitle').textContent = `Comparativo Jan/2023 vs ${Config.MONTH_NAMES[currMonth]}/${currYear}`;

        drawChart('abertura', 'chartAbertura');
        drawChart('caixa', 'chartCaixa');
        updateQuitacaoChart();
        updateAnualChart();
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

    /* ------------------------------------------------------------------
       RELATÓRIO PDF
       ------------------------------------------------------------------
       A4 deitado, fundo branco (imprime bem), com a identidade da tela:
       faixa ameixa no topo, cartões com borda suave e acento colorido,
       gráficos redesenhados na medida da caixa e tabela com cabeçalho
       ameixa. Rodapé com "Página X de Y" em todas as páginas.
       ------------------------------------------------------------------ */
    const PDF_PX_POR_MM = 4;   // escala lógica dos gráficos redesenhados

    const chartImage = (key, wMm, hMm) => {
        const r = recipes[key](true);
        const wPx = Math.round(wMm * PDF_PX_POR_MM), hPx = Math.round(hMm * PDF_PX_POR_MM);
        const holder = document.createElement('div');
        holder.style.cssText = `position:fixed;left:-20000px;top:0;width:${wPx}px;height:${hPx}px;pointer-events:none;`;
        const cv = document.createElement('canvas');
        cv.width = wPx; cv.height = hPx;
        cv.style.width = wPx + 'px'; cv.style.height = hPx + 'px';
        holder.appendChild(cv);
        document.body.appendChild(holder);
        let chart = null;
        try {
            chart = new Chart(cv, {
                type: r.type, data: r.data,
                options: { ...r.options, responsive: false, maintainAspectRatio: false, animation: false, devicePixelRatio: 3 },
            });
            return chart.toBase64Image('image/png', 1);
        } finally {
            if (chart) chart.destroy();
            holder.remove();
        }
    };

    /* Mascote com cantos arredondados, recortado num canvas. Se a imagem
       não carregar (arquivo aberto fora do hub, por exemplo), o relatório
       sai só com o nome. */
    const logoArredondado = () => new Promise((resolve) => {
        let timer = null;
        const done = (v) => { clearTimeout(timer); resolve(v); };
        timer = setTimeout(() => resolve(null), 2500);
        const img = new Image();
        img.onload = () => {
            try {
                const s = 160, cv = document.createElement('canvas');
                cv.width = cv.height = s;
                const ctx = cv.getContext('2d');
                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(0, 0, s, s, 34); else ctx.rect(0, 0, s, s);
                ctx.clip();
                const lado = Math.min(img.naturalWidth, img.naturalHeight);
                ctx.drawImage(img, (img.naturalWidth - lado) / 2, (img.naturalHeight - lado) / 2, lado, lado, 0, 0, s, s);
                done(cv.toDataURL('image/png'));
            } catch (e) { done(null); }
        };
        img.onerror = () => done(null);
        img.src = '../logo-mascote.jpg';
    });

    const exportPDF = async () => {
        if (typeof jspdf === 'undefined') { alert('Biblioteca PDF carregando...'); return; }
        const trigger = $('dctlExportBtn'), origHTML = trigger.innerHTML;
        trigger.disabled = true;
        trigger.innerHTML = '<i class="ph-bold ph-spinner-gap" style="animation:cmpspin 1s linear infinite"></i> Gerando PDF…';
        await new Promise(r => setTimeout(r, 30));

        try {
            const { jsPDF } = jspdf;
            const pdf = new jsPDF({ orientation: 'l', unit: 'mm', format: 'a4', compress: true });
            const W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight();
            const M = 14, GAP = 6, BASE = H - 14;   // BASE: limite inferior do conteúdo (rodapé abaixo)

            const C = {
                plum: [60, 0, 60], ink: [26, 15, 26], muted: [107, 94, 107], subtle: [155, 143, 160],
                border: [232, 224, 232], soft: [246, 242, 246], zebra: [251, 249, 251], white: [255, 255, 255],
                orange: [255, 110, 0], orangeSoft: [255, 241, 228], orangeDeep: [210, 85, 0],
                ok: [31, 122, 61], err: [185, 28, 28], prev: [207, 199, 207],
            };
            const fill = c => pdf.setFillColor(...c);
            const stroke = c => pdf.setDrawColor(...c);
            const ink = c => pdf.setTextColor(...c);
            const font = (style, size) => { pdf.setFont('helvetica', style); pdf.setFontSize(size); };

            const agora = new Date();
            const emitido = `${agora.toLocaleDateString('pt-BR')} às ${agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
            const dataBase = `${Config.MONTH_NAMES_FULL[currMonth]}/${currYear}`;
            const logo = await logoArredondado();

            /* ---- blocos de desenho ---- */
            const cabecalho = () => {
                fill(C.plum); pdf.rect(0, 0, W, 20, 'F');
                fill(C.orange); pdf.rect(0, 20, W, 1, 'F');
                let x = M;
                if (logo) { pdf.addImage(logo, 'PNG', M, 4, 12, 12, 'logo', 'FAST'); x = M + 16; }
                font('bold', 14); ink(C.white); pdf.text('ONTIME', x, 10.2);
                font('bold', 6.5); pdf.setTextColor(255, 170, 110); pdf.text('GESTÃO DE PARCELAMENTOS', x, 14.8, { charSpace: 0.45 });
                font('bold', 10); ink(C.white); pdf.text('Relatório de Parcelamentos', W - M, 9.6, { align: 'right' });
                font('normal', 7.5); pdf.setTextColor(222, 204, 222);
                pdf.text(`Data-base ${dataBase}  ·  Emitido em ${emitido}`, W - M, 14.6, { align: 'right' });
            };

            const novaPagina = (primeira) => { if (!primeira) pdf.addPage(); cabecalho(); };

            const titulo = (texto, sub, y = 33) => {
                fill(C.orange); pdf.roundedRect(M, y - 5.2, 1.4, 7, 0.7, 0.7, 'F');
                font('bold', 16); ink(C.ink); pdf.text(texto, M + 4.5, y);
                if (sub) { font('normal', 8.5); ink(C.muted); pdf.text(sub, M + 4.5, y + 5.5); }
                if (selectedOrgao) {
                    const label = `Filtro: ${selectedOrgao}`;
                    font('bold', 7.5);
                    const w = pdf.getTextWidth(label) + 8;
                    fill(C.orangeSoft); stroke([255, 200, 160]); pdf.setLineWidth(0.25);
                    pdf.roundedRect(W - M - w, y - 5, w, 7, 3.5, 3.5, 'FD');
                    ink(C.orangeDeep); pdf.text(label, W - M - w / 2, y - 0.5, { align: 'center' });
                }
            };

            const cartao = (x, y, w, h) => {
                fill(C.white); stroke(C.border); pdf.setLineWidth(0.3);
                pdf.roundedRect(x, y, w, h, 2.5, 2.5, 'FD');
            };

            const kpi = (x, y, w, h, rotulo, valor, cor) => {
                cartao(x, y, w, h);
                fill(cor); pdf.roundedRect(x + 0.15, y + 3.5, 1.3, h - 7, 0.6, 0.6, 'F');
                font('bold', 7); ink(C.muted); pdf.text(rotulo.toUpperCase(), x + 6, y + 8, { charSpace: 0.25 });
                font('bold', 17); ink(C.ink); pdf.text(valor, x + 6, y + h - 6.5);
            };

            const graficoCard = (x, y, w, h, key, tituloTxt, sub) => {
                cartao(x, y, w, h);
                font('bold', 10.5); ink(C.ink); pdf.text(tituloTxt, x + 5, y + 8);
                if (sub) { font('normal', 7.5); ink(C.muted); pdf.text(sub, x + 5, y + 12.3); }
                const top = y + (sub ? 15 : 11);
                const iw = w - 8, ih = y + h - 3 - top;
                pdf.addImage(chartImage(key, iw, ih), 'PNG', x + 4, top, iw, ih, undefined, 'FAST');
            };

            /* ---- Página 1: visão estratégica ---- */
            novaPagina(true);
            titulo('Visão Estratégica', `Posição consolidada na data-base ${dataBase}`);

            const kY = 44, kH = 24, kW = (W - 2 * M - 2 * GAP) / 3;
            kpi(M, kY, kW, kH, 'Saldo devedor total', $('kpi-saldo').textContent, C.plum);
            kpi(M + kW + GAP, kY, kW, kH, 'Contratos ativos', $('kpi-ativas').textContent, C.orange);
            kpi(M + 2 * (kW + GAP), kY, kW, kH, `A vencer em ${Config.MONTH_NAMES[currMonth]}/${currYear}`, $('kpi-mes').textContent, C.ok);

            const rY = kY + kH + GAP, rH = 64, hW = (W - 2 * M - GAP) / 2;
            graficoCard(M, rY, hW, rH, 'abertura', 'Débitos por Órgão', 'Saldo devedor por órgão credor');
            graficoCard(M + hW + GAP, rY, hW, rH, 'caixa', 'Efeito Caixa', $('caixaSubtitle').textContent);
            const qY = rY + rH + GAP;
            graficoCard(M, qY, W - 2 * M, BASE - qY, 'quitacao', 'Quitação Prevista', 'Saldo restante após os pagamentos de cada ano');

            /* ---- Página 2: comparativo anual ---- */
            novaPagina();
            const a = anualData || computeAnual();
            // a Helvetica do jsPDF não garante travessões: troca por texto simples
            const semTraco = s => String(s).replace(/–/g, ' a ').replace(/—/g, 'n/d');
            const varPeriodo = a.totalAntPeriodo > 0 ? Utils.pct(a.totalAtual / a.totalAntPeriodo - 1) : 'n/d';
            titulo(`Comparativo Anual · ${a.anoAnt} x ${a.ano}`, semTraco(anualSubtitulo(a)));

            const stats = anualStats(a);
            const temNota = stats.some(s => s.note);
            const sY = 44, sH = temNota ? 23 : 19, sW = (W - 2 * M - (stats.length - 1) * GAP) / stats.length;
            stats.forEach((s, i) => {
                const x = M + i * (sW + GAP);
                cartao(x, sY, sW, sH);
                let tx = x + 5;
                if (s.swatch) {
                    if (s.swatch === 'previsto') {
                        fill(C.orangeSoft); stroke(C.orange); pdf.setLineWidth(0.3);
                        pdf.roundedRect(x + 5, sY + 5.1, 3, 3, 0.8, 0.8, 'FD');
                    } else {
                        fill(s.swatch === 'atual' ? C.orange : C.prev);
                        pdf.roundedRect(x + 5, sY + 5.1, 3, 3, 0.8, 0.8, 'F');
                    }
                    tx = x + 10;
                }
                font('bold', 6.8); ink(C.muted); pdf.text(semTraco(s.label).toUpperCase(), tx, sY + 7.6, { charSpace: 0.2 });
                font('bold', 13); ink(C.ink); pdf.text(semTraco(s.value), x + 5, sY + 15.2);
                if (s.note) { font('normal', 7); ink(C.muted); pdf.text(semTraco(s.note), x + 5, sY + 20); }
            });

            const tabH = 26;
            const cY = sY + sH + GAP, cH = BASE - tabH - GAP - cY;
            const legendaPrevisto = a.totalPrevisto > 0 ? ' · Barras listradas e valores em itálico: previsto' : '';
            graficoCard(M, cY, W - 2 * M, cH, 'anual', 'Pagamentos por mês', 'Rótulos em milhares (k) e milhões (M) de reais' + legendaPrevisto);

            const n0 = v => (v == null ? '-' : Math.round(v).toLocaleString('pt-BR'));
            const valorAno = i => a.atual[i] ?? a.previsto[i];
            const varMes = a.anterior.map((ant, i) => (valorAno(i) == null || !ant ? '-' : Utils.pct(valorAno(i) / ant - 1)));
            pdf.autoTable({
                startY: cY + cH + GAP,
                margin: { left: M, right: M, bottom: 12 },
                head: [['R$', ...Config.MONTH_NAMES.map(m => m.toUpperCase()), 'Acumulado']],
                body: [
                    [String(a.anoAnt), ...a.anterior.map(n0), n0(a.totalAntPeriodo)],
                    [String(a.ano), ...a.anterior.map((_, i) => n0(valorAno(i))), n0(a.totalAtual)],
                    ['Variação', ...varMes, varPeriodo],
                ],
                theme: 'plain',
                styles: { font: 'helvetica', fontSize: 6.8, textColor: C.ink, halign: 'right', cellPadding: { top: 1.7, bottom: 1.7, left: 1.2, right: 1.6 } },
                headStyles: { fillColor: C.soft, textColor: C.muted, fontStyle: 'bold', fontSize: 6.5 },
                columnStyles: { 0: { halign: 'left', fontStyle: 'bold', cellWidth: 18 }, 13: { fontStyle: 'bold', cellWidth: 22 } },
                didParseCell: (d) => {
                    const col = d.column.index;
                    if (col === 0) d.cell.styles.halign = 'left';
                    if (d.section !== 'body') return;
                    if (d.row.index === 1) d.cell.styles.fillColor = [255, 248, 241];
                    if (d.row.index === 2) d.cell.styles.textColor = C.muted;
                    if (d.row.index >= 1 && col >= 1 && col <= 12 && a.previsto[col - 1] != null) {
                        d.cell.styles.fontStyle = 'italic';
                        d.cell.styles.textColor = C.subtle;
                    }
                },
            });

            /* ---- Página 3+: resumo sintético ---- */
            novaPagina();
            const paginaInicioTabela = pdf.internal.getNumberOfPages();
            const lista = currentFilteredSintetico;
            titulo('Resumo Sintético', `${lista.length} contrato(s) · posição por contrato na data-base ${dataBase}`);

            let sumDivida = 0, sumParcela = 0, sumAtraso = 0;
            lista.forEach(c => { sumDivida += c.totalDivida; sumParcela += c.parcelaUnit; sumAtraso += c.atraso; });

            pdf.autoTable({
                startY: 43,
                margin: { top: 30, left: M, right: M, bottom: 16 },
                head: [['Natureza', 'Tributo', 'Número', 'Órgão', 'Parcelas', 'Atraso', 'Total da dívida', 'Valor da parcela']],
                body: lista.map(c => [c.natureza, c.tributo, c.numero, c.orgao, c.qtdParcela, c.atraso, Utils.fmt(c.totalDivida), Utils.fmt(c.parcelaUnit)]),
                foot: [[{ content: 'Totais', colSpan: 4 }, '', sumAtraso, Utils.fmt(sumDivida), Utils.fmt(sumParcela)]],
                showHead: 'everyPage',
                showFoot: 'lastPage',
                theme: 'plain',
                styles: { font: 'helvetica', fontSize: 8, textColor: C.ink, valign: 'middle', overflow: 'linebreak', cellPadding: { top: 2.6, bottom: 2.6, left: 3, right: 3 } },
                headStyles: { fillColor: C.plum, textColor: C.white, fontStyle: 'bold', fontSize: 7.5 },
                footStyles: { fillColor: C.orangeSoft, textColor: C.ink, fontStyle: 'bold', fontSize: 8.5 },
                alternateRowStyles: { fillColor: C.zebra },
                columnStyles: {
                    2: { fontStyle: 'bold' },
                    4: { halign: 'center', cellWidth: 20 },
                    5: { halign: 'center', cellWidth: 18 },
                    6: { halign: 'right', cellWidth: 38 },
                    7: { halign: 'right', cellWidth: 36 },
                },
                didParseCell: (d) => {
                    const col = d.column.index;
                    if (d.section !== 'body') {
                        if (col === 4 || col === 5) d.cell.styles.halign = 'center';
                        if (col >= 6) d.cell.styles.halign = 'right';
                        return;
                    }
                    if (col === 5) {
                        d.cell.styles.textColor = (Number(d.cell.raw) || 0) > 0 ? C.err : C.ok;
                        d.cell.styles.fontStyle = 'bold';
                    }
                },
                didDrawPage: () => {
                    if (pdf.internal.getCurrentPageInfo().pageNumber > paginaInicioTabela) cabecalho();
                },
            });

            /* ---- Rodapé em todas as páginas ---- */
            const total = pdf.internal.getNumberOfPages();
            for (let p = 1; p <= total; p++) {
                pdf.setPage(p);
                stroke(C.border); pdf.setLineWidth(0.3); pdf.line(M, H - 10, W - M, H - 10);
                font('normal', 7); ink(C.subtle);
                pdf.text('ONTIME · Controladoria · Gestão de Parcelamentos', M, H - 5.5);
                pdf.text(`Página ${p} de ${total}`, W - M, H - 5.5, { align: 'right' });
            }

            pdf.save(`ONTIME_Parcelamentos_${currYear}-${String(currMonth + 1).padStart(2, '0')}.pdf`);
        } catch (err) {
            console.error(err);
            alert('Erro ao gerar PDF.');
        } finally {
            trigger.disabled = false;
            trigger.innerHTML = origHTML;
        }
    };

    /* ------------------------------------------------------------------
       FIO DE PROGRESSO
       ------------------------------------------------------------------
       Uma linha só, no alto da janela, como a do YouTube. A largura vem
       das etapas reais do init logo abaixo — não é animação em laço. Se o
       fio empacar em 45%, é porque a leitura da base empacou ali, e isso
       é justamente o que a barrinha antiga não sabia dizer.
       ------------------------------------------------------------------ */
    const etapa = (texto, pct) => {
        const t = document.querySelector('.loader-text');
        if (t && texto) t.textContent = texto;
        const fio = $('fio'), fill = $('fio-fill');
        if (!fio || !fill) return;
        if (pct >= 100) {
            fill.style.width = '100%';
            // deixa o fio chegar ao fim antes de sumir; senão o salto não se vê
            setTimeout(() => fio.classList.remove('ativo'), 400);
        } else {
            fio.classList.add('ativo');
            fill.style.width = pct + '%';
        }
    };

    const showError = (message, detail) => {
        const fio = $('fio'); if (fio) fio.classList.remove('ativo');
        const loader = $('loader'); loader.textContent = ''; loader.classList.add('error-state');
        const p = Utils.el('p', message); p.style.color = 'var(--err)'; p.style.fontWeight = '600'; loader.appendChild(p);
        if (detail) { const small = Utils.el('small', detail); small.style.color = 'var(--muted)'; loader.appendChild(small); }
        const btnRetry = Utils.el('button', 'Tentar novamente', 'btn-retry');
        btnRetry.addEventListener('click', () => {
            loader.textContent = ''; loader.appendChild(Utils.el('div', null, 'spinner')); loader.appendChild(Utils.el('p', 'Sincronizando dados...'));
            const f = $('fio-fill'); if (f) f.style.width = '0%';
            init();
        });
        loader.appendChild(btnRetry);
    };

    /* O rodapé do menu diz de quando é a base na tela e se a nova já chegou.
       Mostrar a cópia sem dizer que é cópia seria vender número velho como
       novo. */
    let quandoNaTela = null;
    const marcarBase = (quando, estado) => {
        quandoNaTela = quando;
        const d = new Date(quando);
        const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const dia = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const deHoje = d.toDateString() === new Date().toDateString();
        const txt = $('lastSync'), caixa = txt && txt.parentNode, ponto = caixa && caixa.querySelector('.ss-dot');
        if (!txt) return;
        if (estado === 'nova') {
            txt.textContent = dia + ' ' + hora;
            if (caixa) caixa.title = 'Base atualizada às ' + hora;
        } else {
            txt.textContent = 'cópia de ' + (deHoje ? hora : (dia + ' ' + hora)) +
                              (estado === 'falhou' ? ' · sem conexão' : ' · atualizando');
            if (caixa) caixa.title = estado === 'falhou'
                ? 'Não consegui buscar a base agora. A tela mostra a última cópia guardada neste computador, de ' + dia + ' às ' + hora + '.'
                : 'Mostrando a cópia guardada neste computador enquanto a base nova chega.';
        }
        if (ponto) {
            ponto.classList.toggle('aguardando', estado === 'atualizando');
            ponto.classList.toggle('falhou', estado === 'falhou');
        }
    };

    /* A base nova chega com a tela já em uso: filtros, busca, página, órgão
       marcado e data-base de quem está olhando ficam como estavam. */
    const reaplicar = () => {
        const ids = ['filterSinteticoNatureza', 'filterSinteticoOrgao', 'filterDetalhadoOrgao',
                     'filterDetalhadoNatureza', 'filterDetalhadoAno'];
        const antes = {};
        ids.forEach(id => { antes[id] = $(id).value; });
        DataService.processConsolidation(currYear, currMonth);
        populateFilters(); populateYears();
        ids.forEach(id => {
            const sel = $(id);
            if (Array.from(sel.options).some(o => o.value === antes[id])) sel.value = antes[id];
        });
        updateDashboard();
        reRenderTables();
    };

    const atualizarPorTras = async () => {
        etapa(null, 35);
        try {
            const quando = await DataService.load();
            reaplicar();
            marcarBase(quando, 'nova');
        } catch (err) {
            marcarBase(quandoNaTela, 'falhou');
        } finally {
            etapa(null, 100);
        }
    };

    let telaMontada = false;
    const init = async () => {
        /* Com cópia guardada, a tela nasce dela e a base nova vem por trás. Se
           a cópia não servir para montar a tela, ela é esquecida e a abertura
           segue o caminho de sempre. */
        if (!telaMontada) {
            const quandoCopia = await DataService.loadCopia();
            if (quandoCopia) {
                try {
                    DataService.processConsolidation(currYear, currMonth);
                    populateFilters(); populateYears(); initDataBaseSelector();
                    updateDashboard(); filterSintetico();
                    lastDetalhadoFiltered = DataService.getRawData();
                    renderDetalhado(applySort(DataService.getRawData(), 'detalhado'));
                    $('app-content').style.display = 'flex';
                    const loaderEl = $('loader');
                    loaderEl.classList.add('fade-out');
                    setTimeout(() => { loaderEl.style.display = 'none'; }, 480);
                    initScrollSpy();
                    telaMontada = true;
                    marcarBase(quandoCopia, 'atualizando');
                    atualizarPorTras();
                    return;
                } catch (err) { CopiaBase.esquecer(); }
            }
        }

        etapa('Conectando ao servidor...', 8);
        let quando;
        try { quando = await DataService.load(); } catch (err) { showError('Erro ao acessar os dados.', err.message); return; }
        etapa('Lendo a base...', 45);
        try {
            marcarBase(quando, 'nova');
            DataService.processConsolidation(currYear, currMonth);
        } catch (err) { showError('Erro ao processar os dados.', err.message); return; }
        etapa('Cruzando os dados...', 66);
        try { populateFilters(); populateYears(); initDataBaseSelector(); } catch (err) { showError('Erro ao montar os filtros.', err.message); return; }
        etapa('Montando a tela...', 82);
        try {
            updateDashboard(); filterSintetico();
            lastDetalhadoFiltered = DataService.getRawData();
            renderDetalhado(applySort(DataService.getRawData(), 'detalhado'));
            etapa('Pronto', 100);
            $('app-content').style.display = 'flex';
            const loaderEl = $('loader');
            loaderEl.classList.add('fade-out');
            setTimeout(() => { loaderEl.style.display = 'none'; }, 480);
            if (!telaMontada) initScrollSpy();
            telaMontada = true;
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
        document.querySelectorAll('#anualModo .seg-btn').forEach(b => b.addEventListener('click', () => setAnualModo(b.dataset.modo)));
        let modoSalvo = null;
        try { modoSalvo = localStorage.getItem('parcel_anual_modo'); } catch (e) {}
        if (modoSalvo) setAnualModo(modoSalvo);
    };

    document.addEventListener('DOMContentLoaded', () => {
        HubLink.init(); // Inicia a validação da Origem (Sessão / Hub)
        Comprov.configure({ canEdit: HubLink._userCameFromHub(), onChanged: reloadData, getData: () => DataService.getRawData() });
        bindEvents();
        init();
    });

    return { toggleSidebar, scrollToSection };
})();
