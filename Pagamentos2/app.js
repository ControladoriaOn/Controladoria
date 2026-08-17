'use strict';
/* ============================================================================
   PAGAMENTOS V2 · PAINEL
   ----------------------------------------------------------------------------
   Responde três perguntas, nesta ordem: o que já saiu, o que sai hoje, o que
   sai amanhã. Clicar no cartão troca a tabela de baixo.

   Um título nunca é baixado no dia em que é pago — o pagamento de hoje só vira
   baixa amanhã. Por isso "Pago" é sempre a foto de um dia anterior, e vem do
   relatório de baixas, não do de vencimento.

   A regra de cruzamento Fluig x Totvs mora no conciliacao.js, compartilhado
   com a tela de envio.
   ============================================================================ */

const CONFIG = {
  // ⬇️ mesma URL /exec usada no atualizar.html
  DATA_URL: 'https://script.google.com/macros/s/AKfycbwutQ02_VsAX-cKwsNDSKkG-ScJ9ER6XlPVK6_00hNUPRtBlvYDwok0GisJglU3ES2L/exec',
  RETRIES: 3,
  BACKOFF_MS: 600,
  PAGINA: 60,
};

const {
  safeStr, fmtBR, fmtBR0, fmtData, hojeISO, proxDiaUtil, norm,
  chaveTitulo, estaPago, SITUACOES,
  aplicarAjustes, conciliar, resumir, montarLinhas, definirMapaStatus,
  exportarRelatorio, novoCiot, MODELO_CIOT, CAMPO_OCULTO,
  definirFeriados, diaUtilAnterior, ehDiaUtil, ehFeriado, serieDiaria,
} = Conc;

/* ------------------------------------------------------------------ DOM */
const el = id => document.getElementById(id);
function h(tag, attrs, filhos){
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs){
    if (k === 'class') e.className = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]);
  }
  (filhos || []).forEach(f => { if (f) e.appendChild(typeof f === 'string' ? document.createTextNode(f) : f); });
  return e;
}
const badge = (t, c) => h('span', { class:'badge ' + c, text:t });
const icone = c => h('i', { class:'fa-solid ' + c });

function toast(msg, erro){
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast show' + (erro ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 3600);
}

/* ------------------------------------------------------------- estado */
const state = {
  dados: null,          // payload cru do Apps Script
  baixas: [],
  conc: null, resumo: null, linhas: [],
  dataRef: hojeISO(),
  aba: 'hoje',          // pago | hoje | amanha | atrasado | excecoes
  busca: '', filtroSit: '', filtroOrigem: '',
  ordem: { col:'vencimento', dir:'asc' },
  pagina: 1,
  podeEditar: false,
  autor: '', token: '',
  orfaos: [],
};

/* ------------------------------------------------- veio pelo hub? ------
   Mesma regra das outras ferramentas: os botões de edição só aparecem para
   quem entrou pelo hub, não para quem abriu o link direto. */
const HubLink = {
  HUB: '/Controladoria',
  SELF: '/Controladoria/Pagamentos2',
  KEY: 'came_from_hub_pagamentos2',
  veioDoHub(){
    try {
      if (document.referrer){
        const ref = new URL(document.referrer);
        if (ref.origin === location.origin &&
            ref.pathname.indexOf(this.HUB) === 0 &&
            ref.pathname.indexOf(this.SELF) !== 0) return true;
      }
    } catch(e){}
    try { if (new URLSearchParams(location.search).has('from')) return true; } catch(e){}
    try { if (sessionStorage.getItem(this.KEY) === '1') return true; } catch(e){}
    return false;
  },
  init(){
    const ok = this.veioDoHub();
    if (ok){
      try { sessionStorage.setItem(this.KEY, '1'); } catch(e){}
      ['btn-hub','link-atualizar','btnNovo','btnCiot'].forEach(id => { const n = el(id); if (n) n.hidden = false; });
    }
    return ok;
  },
};

/* --------------------------------------------- senha + nome do autor ---
   Ficam só na aba aberta. A senha é conferida do lado do servidor a cada
   gravação; aqui ela é apenas guardada. */
const Auth = {
  K_TOKEN:'pgv2_token', K_NOME:'pgv2_autor',
  carregar(){
    try {
      state.token = sessionStorage.getItem(this.K_TOKEN) || '';
      state.autor = localStorage.getItem(this.K_NOME) || '';
    } catch(e){}
  },
  guardar(nome, token){
    state.autor = nome; state.token = token;
    try {
      sessionStorage.setItem(this.K_TOKEN, token);
      localStorage.setItem(this.K_NOME, nome);
    } catch(e){}
  },
  limpar(){
    state.token = '';
    try { sessionStorage.removeItem(this.K_TOKEN); } catch(e){}
  },
  /* Devolve uma promessa que só resolve quando houver senha. */
  pedir(){
    return new Promise(resolve => {
      if (state.token && state.autor) return resolve(true);
      const m = el('modalSenha');
      el('ms-nome').value = state.autor || '';
      el('ms-senha').value = '';
      m.classList.add('show');
      setTimeout(() => (state.autor ? el('ms-senha') : el('ms-nome')).focus(), 60);

      const fechar = ok => {
        m.classList.remove('show');
        el('ms-ok').onclick = null; el('ms-cancel').onclick = null; m.onkeydown = null;
        resolve(ok);
      };
      el('ms-ok').onclick = () => {
        const nome = el('ms-nome').value.trim();
        const senha = el('ms-senha').value.trim();
        if (!nome || !senha){ toast('Preencha nome e senha.', true); return; }
        Auth.guardar(nome, senha);
        fechar(true);
      };
      el('ms-cancel').onclick = () => fechar(false);
      m.onkeydown = e => {
        if (e.key === 'Escape') fechar(false);
        if (e.key === 'Enter') el('ms-ok').click();
      };
    });
  },
};

/* ------------------------------------------------------------- rede --- */
async function buscarJson(url, tentativas){
  let erro;
  for (let i = 1; i <= (tentativas || CONFIG.RETRIES); i++){
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch(e){
      erro = e;
      if (i < CONFIG.RETRIES) await new Promise(r => setTimeout(r, CONFIG.BACKOFF_MS * i));
    }
  }
  throw erro;
}

/* Gravações vão como no-cors: a resposta não é legível, então a tela recarrega
   os dados logo depois para mostrar o que de fato ficou gravado. */
async function enviar(payload){
  await fetch(CONFIG.DATA_URL, {
    method:'POST', mode:'no-cors',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify(payload),
  });
}

/* ============================================================================
   CARGA E PREPARO
   ============================================================================ */
async function carregar(primeira){
  const etapa = t => { const n = el('load-text'); if (n) n.textContent = t; };
  etapa(primeira ? 'Lendo a base…' : 'Atualizando…');
  try {
    const url = CONFIG.DATA_URL + (CONFIG.DATA_URL.indexOf('?') >= 0 ? '&' : '?') + 'v=' + Date.now();
    state.dados = await buscarJson(url);
    if (state.dados && state.dados.erro) throw new Error(state.dados.erro);
    etapa('Cruzando Fluig e Totvs…');
    preparar();
    etapa('Montando o dia…');
    render();
    esconderLoader();
  } catch(e){
    mostrarErro(e);
  }
}

function preparar(){
  const d = state.dados || {};
  if (d.config_status) definirMapaStatus(d.config_status);
  // feriados antes de qualquer conta: eles mudam o que é "amanhã"
  definirFeriados(d.feriados || []);

  // ajustes manuais entram por cima dos dados crus, dos dois relatórios
  const aj = d.ajustes || [];
  const resTit = aplicarAjustes(d.titulos || [], aj);
  const resBx  = aplicarAjustes(d.baixas  || [], aj);
  state.orfaos = resTit.orfaos.filter(o => !resBx.titulos.some(t => chaveTitulo(t) === o.alvo));
  state.baixas = resBx.titulos;

  state.conc = conciliar({
    totvs: resTit.titulos,
    nf_servico: d.nf_servico || [],
    nf_titulo:  d.nf_titulo  || [],
    reembolso:  d.reembolso  || [],
  });
  state.resumo = resumir(state.conc, state.dataRef, state.baixas);
  state.linhas = montarLinhas(state.conc, state.baixas);
}

function esconderLoader(){
  const l = el('loader');
  l.classList.add('out');
  setTimeout(() => { l.style.display = 'none'; }, 360);
}
/* Reabre o loader para uma gravação. O esqueleto só faz sentido na primeira
   carga; depois disso ele só atrapalharia. */
function abrirLoader(texto){
  const l = el('loader');
  const esq = l.querySelector('.esqueleto');
  if (esq) esq.style.display = 'none';
  el('load-text').textContent = texto || 'Carregando…';
  l.style.display = 'flex';
  l.classList.remove('out');
}
function mostrarErro(e){
  const l = el('loader');
  l.classList.remove('out');
  l.style.display = 'flex';
  l.innerHTML = '';
  l.appendChild(h('div', { class:'load-logo' }, ['ON', h('span', { text:'TIME' })]));
  l.appendChild(h('div', { class:'load-text', style:'color:var(--danger);font-weight:600',
    text:'Não consegui carregar os dados.' }));
  l.appendChild(h('div', { class:'load-text', style:'max-width:340px;text-align:center',
    text: String(e && e.message || e) }));
  const b = h('button', { class:'btn btn-primary' }, [icone('fa-rotate'), 'Tentar de novo']);
  b.onclick = () => location.reload();
  l.appendChild(b);
}

/* ============================================================================
   RECORTES — cada aba é um filtro sobre a mesma lista de linhas
   ============================================================================ */
function recortes(){
  const r = state.resumo, L = state.linhas.filter(x => !x.oculto);
  const previsto = L.filter(x => x.fonte === 'previsto' && x.situacao !== 'cancelado');
  const emAberto = x => !x.dt_baixa;

  return {
    pago: {
      rotulo: r.dataPago ? ('Pago em ' + fmtData(r.dataPago)) : 'Pago',
      icone: 'fa-circle-check', classe: 'ok',
      valor: r.pago.valor, qtd: r.pago.qtd,
      sub: r.dataPago
        ? (r.pago.qtd + ' títulos baixados')
        : 'sem relatório de baixas carregado',
      linhas: L.filter(x => x.fonte === 'baixa' && x.dt_baixa === r.dataPago),
    },
    hoje: {
      rotulo: 'Previsto para hoje',
      icone: 'fa-calendar-day', classe: 'info',
      valor: r.aPagarHoje.valor, qtd: r.aPagarHoje.qtd,
      sub: r.abertoHoje.qtd + ' no Totvs · ' + r.foraTotvsHoje.qtd + ' só no Fluig'
           + (r.aguardandoHoje.qtd ? (' · ' + r.aguardandoHoje.qtd + ' falta aprovar') : ''),
      linhas: previsto.filter(x => emAberto(x) && x.vencimento === r.dataRef),
    },
    amanha: {
      rotulo: 'Previsto para amanhã',
      icone: 'fa-calendar-plus', classe: 'orange',
      valor: r.aPagarAmanha.valor, qtd: r.aPagarAmanha.qtd,
      sub: fmtData(r.amanha) + ' · ' + r.abertoAmanha.qtd + ' no Totvs · '
           + r.foraTotvsAmanha.qtd + ' só no Fluig',
      linhas: previsto.filter(x => emAberto(x) && x.vencimento === r.amanha),
    },
    atrasado: {
      rotulo: 'Vencido em aberto',
      icone: 'fa-triangle-exclamation', classe: 'danger',
      valor: r.atrasado.valor, qtd: r.atrasado.qtd,
      sub: 'venceu antes de ' + fmtData(r.dataRef) + ' e não foi baixado',
      linhas: previsto.filter(x => emAberto(x) && x.vencimento && x.vencimento < r.dataRef),
      opcional: true,
    },
    ocultos: {
      rotulo: 'Ocultos',
      icone: 'fa-eye-slash', classe: 'mute',
      linhas: state.linhas.filter(x => x.oculto),
      opcional: true, semValor: true,
    },
    excecoes: {
      rotulo: 'Precisa de olho',
      icone: 'fa-flag', classe: 'warn',
      linhas: previsto.filter(x =>
        x.situacao === 'sem_titulo_aprovado' || x.aviso === 'valor_diverge' ||
        x.aviso === 'valor_corrigido_sem_par' || x.modoPar === 'aprox'),
      opcional: true, semValor: true,
    },
  };
}

/* ============================================================================
   RENDER
   ============================================================================ */
function render(){
  renderNav();
  renderSidebar();
  renderStamp();
  const c = el('content');
  c.innerHTML = '';
  c.appendChild(secaoKPIs());
  const avisos = secaoAvisos();
  if (avisos) c.appendChild(avisos);
  c.appendChild(secaoTabela());
  animarValores();
}

/* Os valores sobem contando até o número. Uma vez por carga, curto, e
   respeitando quem pediu menos animação no sistema. */
function animarValores(){
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('.marco-valor[data-valor]').forEach(nó => {
    const alvo = Number(nó.getAttribute('data-valor')) || 0;
    if (!alvo) return;
    const inicio = performance.now(), dur = 620;
    const passo = agora => {
      const t = Math.min(1, (agora - inicio) / dur);
      const suave = 1 - Math.pow(1 - t, 3);
      nó.textContent = 'R$ ' + fmtBR0(alvo * suave);
      if (t < 1) requestAnimationFrame(passo);
      else nó.textContent = 'R$ ' + fmtBR0(alvo);
    };
    requestAnimationFrame(passo);
  });
}

function renderNav(){
  const nav = el('nav');
  nav.innerHTML = '';
  const R = recortes();
  ['pago','hoje','amanha','atrasado','excecoes','ocultos'].forEach(k => {
    const rec = R[k];
    if (rec.opcional && !rec.linhas.length) return;
    const b = h('button', { class:'nav-item' + (state.aba === k ? ' active' : ''), type:'button' }, [
      icone(rec.icone),
      h('span', { text: rec.rotulo }),
      h('span', { class:'cnt', text: String(rec.linhas.length) }),
    ]);
    b.onclick = () => { state.aba = k; state.pagina = 1; render(); fecharMenu(); };
    nav.appendChild(b);
  });
}

function renderSidebar(){
  const R = recortes();
  el('sc-pago').textContent  = 'R$ ' + fmtBR0(R.pago.valor);
  el('sc-pagar').textContent = 'R$ ' + fmtBR0(R.hoje.valor);
}

function renderStamp(){
  const meta = (state.dados && state.dados.meta) || {};
  const dot = el('stamp').querySelector('.dot');
  const txt = el('stamp-text');
  if (!meta.generated_at){ dot.className = 'dot off'; txt.textContent = 'base vazia'; return; }
  const d = new Date(meta.generated_at);
  const horas = (Date.now() - d.getTime()) / 36e5;
  dot.className = 'dot' + (horas > 5 ? ' warn' : '');
  txt.textContent = 'atualizado ' + String(d.getDate()).padStart(2,'0') + '/' +
    String(d.getMonth()+1).padStart(2,'0') + ' às ' + String(d.getHours()).padStart(2,'0') +
    ':' + String(d.getMinutes()).padStart(2,'0') + (horas > 5 ? ' · há um tempo' : '');
}

/* Os três números não são três coisas iguais: são o mesmo dinheiro em três
   momentos. Por isso a tela desenha uma linha do tempo — ontem fechado à
   esquerda, hoje em destaque no centro, amanhã em esboço à direita. */
function secaoKPIs(){
  const R = recortes(), r = state.resumo;
  const sec = h('div', { class:'section' });
  const linha = h('div', { class:'timeline' });

  const marco = (k, classe, extras) => {
    const rec = R[k];
    const card = h('div', {
      class:'marco ' + classe + ' ' + rec.classe + (state.aba === k ? ' ativo' : ''),
      role:'button', tabindex:'0',
    }, [
      h('div', { class:'marco-topo' }, [
        h('span', { class:'marco-quando', text: rec.rotulo }),
        rec.qtd ? h('span', { class:'marco-qtd', text: rec.qtd + (rec.qtd === 1 ? ' título' : ' títulos') }) : null,
      ]),
      h('div', { class:'marco-valor', 'data-valor': Number(rec.valor)||0 }, [ 'R$ ' + fmtBR0(rec.valor) ]),
      h('div', { class:'marco-sub', text: rec.sub }),
    ]);
    (extras || []).forEach(e => e && card.appendChild(e));
    const ir = () => { state.aba = k; state.pagina = 1; render(); };
    card.onclick = ir;
    card.onkeydown = e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); ir(); } };
    return card;
  };

  // ontem: minigráfico dos últimos dias úteis, para o número ter contexto
  const serie = serieDiaria(state.baixas, r.dataPago || r.dataRef, 10);
  linha.appendChild(marco('pago', 'passado', [ serie.some(p => p.temDado) ? sparkline(serie) : null ]));
  linha.appendChild(h('div', { class:'timeline-seta' }, [ icone('fa-chevron-right') ]));

  // hoje: quanto do previsto já virou pagamento
  const prevHoje = R.hoje.valor + R.pago.valor;
  const frac = prevHoje > 0 ? Math.min(1, R.pago.valor / prevHoje) : 0;
  const barra = h('div', { class:'marco-barra', title:'proporção já paga em relação ao previsto' }, [
    h('span', { style:'width:' + Math.round(frac*100) + '%' }),
  ]);
  linha.appendChild(marco('hoje', 'presente', [
    r.aguardandoHoje.qtd
      ? h('div', { class:'marco-alerta' }, [ icone('fa-hourglass-half'),
          h('span', { text: 'R$ ' + fmtBR0(r.aguardandoHoje.valor) + ' aguardando aprovação' }) ])
      : null,
    barra,
  ]));
  linha.appendChild(h('div', { class:'timeline-seta' }, [ icone('fa-chevron-right') ]));
  linha.appendChild(marco('amanha', 'futuro', []));

  sec.appendChild(linha);
  return sec;
}

/* Minigráfico de barras dos últimos dias úteis pagos. SVG puro: sem
   dependência e sem custo de renderização. */
function sparkline(serie){
  const w = 132, hh = 30, gap = 2;
  const max = Math.max.apply(null, serie.map(p => p.valor).concat([1]));
  const bw = (w - gap * (serie.length - 1)) / serie.length;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + hh);
  svg.setAttribute('class', 'spark');
  svg.setAttribute('preserveAspectRatio', 'none');
  serie.forEach((p, i) => {
    const altura = Math.max(1.5, (p.valor / max) * hh);
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', (i * (bw + gap)).toFixed(2));
    rect.setAttribute('y', (hh - altura).toFixed(2));
    rect.setAttribute('width', bw.toFixed(2));
    rect.setAttribute('height', altura.toFixed(2));
    rect.setAttribute('rx', '1.5');
    rect.setAttribute('class', i === serie.length - 1 ? 'spark-hoje' : 'spark-dia');
    const t = document.createElementNS(ns, 'title');
    t.textContent = fmtData(p.data) + ' · R$ ' + fmtBR(p.valor);
    rect.appendChild(t);
    svg.appendChild(rect);
  });
  return h('div', { class:'marco-spark' }, [ svg ]);
}

function secaoAvisos(){
  const r = state.resumo, sec = h('div', { class:'section' });
  let tem = false;
  const add = (cls, ic, forte, resto) => {
    tem = true;
    sec.appendChild(h('div', { class:'note ' + cls }, [
      icone(ic), h('div', {}, [ h('strong', { text: forte }), resto ]),
    ]));
  };
  if (!state.baixas.length){
    add('info','fa-circle-info','Ainda sem os pagamentos do dia anterior. ',
      'O “Pago” aparece quando for enviado o relatório diário da controladoria ou o relatório do Totvs filtrado por data de baixa. Um título nunca é baixado no mesmo dia em que é pago, então esse número é sempre de um dia anterior.');
  }
  if (r.semTituloAprovado.qtd){
    add('warn','fa-triangle-exclamation', r.semTituloAprovado.qtd + ' aprovado(s) sem título no Totvs. ',
      'Foram liberados no Fluig e ainda não apareceram no relatório — ou não foram lançados, ou o filtro de vencimento deixou de fora.');
  }
  if (r.divergencias){
    add('danger','fa-scale-unbalanced', r.divergencias + ' com valor diferente entre Fluig e Totvs. ',
      'Vale conferir antes de confiar no total.');
  }
  if (r.ocultos){
    add('info','fa-eye-slash', r.ocultos + ' título(s) oculto(s). ',
      'Ficam fora dos totais, da prévia e do relatório, mas continuam na base — a aba Ocultos lista todos, com o motivo e o botão de trazer de volta.');
  }
  if (state.orfaos.length){
    add('warn','fa-link-slash', state.orfaos.length + ' ajuste(s) sem título correspondente. ',
      'Foram feitos em títulos que não estão mais na base — provavelmente mudaram de número na origem ou saíram do relatório.');
  }
  return tem ? sec : null;
}

/* --------------------------------------------------------------- tabela */
function linhasVisiveis(){
  const rec = recortes()[state.aba];
  let L = rec.linhas.slice();

  const b = norm(state.busca);
  if (b) L = L.filter(x =>
    norm(x.fornecedor).indexOf(b) >= 0 ||
    norm(x.numero).indexOf(b) >= 0 ||
    norm(x.detalhe).indexOf(b) >= 0 ||
    norm(x.id_fluig).indexOf(b) >= 0);

  if (state.filtroSit)    L = L.filter(x => x.situacao === state.filtroSit);
  if (state.filtroOrigem) L = L.filter(x => x.origem === state.filtroOrigem);

  const { col, dir } = state.ordem;
  L.sort((x, y) => {
    let a = x[col], c = y[col];
    if (col === 'valor'){ a = Number(a)||0; c = Number(c)||0; return dir === 'asc' ? a-c : c-a; }
    a = safeStr(a).toLowerCase(); c = safeStr(c).toLowerCase();
    return dir === 'asc' ? a.localeCompare(c) : c.localeCompare(a);
  });
  return L;
}

function secaoTabela(){
  const rec = recortes()[state.aba];
  const L = linhasVisiveis();
  const total = L.reduce((s, x) => s + (Number(x.valor)||0), 0);
  const sec = h('div', { class:'section' });
  const card = h('div', { class:'card' });

  /* barra: título + filtros */
  const busca = h('input', { type:'text', placeholder:'favorecido, número, histórico…', value: state.busca });
  busca.oninput = debounce(e => { state.busca = e.target.value; state.pagina = 1; atualizarTabela(); }, 180);

  const selSit = h('select', { class:'filtro' }, [ h('option', { value:'', text:'Todas as situações' }) ]);
  const sits = {};
  rec.linhas.forEach(x => { sits[x.situacao] = (sits[x.situacao]||0)+1; });
  Object.keys(sits).forEach(s => {
    const rot = (SITUACOES[s] || [s])[0];
    selSit.appendChild(h('option', { value:s, text: rot + ' (' + sits[s] + ')', selected: state.filtroSit === s }));
  });
  selSit.onchange = e => { state.filtroSit = e.target.value; state.pagina = 1; atualizarTabela(); };

  const selOri = h('select', { class:'filtro' }, [ h('option', { value:'', text:'Todas as origens' }) ]);
  const oris = {};
  rec.linhas.forEach(x => { oris[x.origem] = (oris[x.origem]||0)+1; });
  Object.keys(oris).sort().forEach(o => {
    selOri.appendChild(h('option', { value:o, text: o + ' (' + oris[o] + ')', selected: state.filtroOrigem === o }));
  });
  selOri.onchange = e => { state.filtroOrigem = e.target.value; state.pagina = 1; atualizarTabela(); };

  const btnXls = h('button', { class:'btn btn-ghost btn-sm', type:'button' }, [icone('fa-table-list'), 'Conferência']);
  btnXls.onclick = () => exportarExcel(L, rec.rotulo);
  const btnRel = h('button', { class:'btn btn-primary btn-sm', type:'button' }, [icone('fa-file-excel'), 'Relatório']);
  btnRel.onclick = () => gerarRelatorio(L, rec.rotulo);

  card.appendChild(h('div', { class:'card-bar' }, [
    h('div', { class:'card-bar-title' }, [ icone(rec.icone), rec.rotulo ]),
    h('div', { class:'filtros' }, [
      h('div', { class:'busca' }, [ icone('fa-magnifying-glass'), busca ]),
      selSit, selOri, btnXls, btnRel,
    ]),
  ]));

  const wrap = h('div', { class:'tbl-wrap', id:'tbl-wrap' });
  wrap.appendChild(tabela(L));
  card.appendChild(wrap);

  card.appendChild(h('div', { class:'rodape', id:'tbl-rodape' }, [
    h('span', { text: L.length + ' de ' + rec.linhas.length + ' linha(s)' }),
    h('span', { text: 'Total: R$ ' + fmtBR(total) }),
  ]));

  sec.appendChild(card);
  return sec;
}

function atualizarTabela(){
  const rec = recortes()[state.aba];
  const L = linhasVisiveis();
  const wrap = el('tbl-wrap');
  if (!wrap) return render();
  wrap.innerHTML = '';
  wrap.appendChild(tabela(L));
  const total = L.reduce((s, x) => s + (Number(x.valor)||0), 0);
  const rod = el('tbl-rodape');
  rod.innerHTML = '';
  rod.appendChild(h('span', { text: L.length + ' de ' + rec.linhas.length + ' linha(s)' }));
  rod.appendChild(h('span', { text: 'Total: R$ ' + fmtBR(total) }));
}

function thOrd(rot, col){
  const ativo = state.ordem.col === col;
  const th = h('th', { class:'sortable' }, [
    rot,
    h('i', { class:'fa-solid ' + (ativo ? (state.ordem.dir === 'asc' ? 'fa-arrow-up on' : 'fa-arrow-down on') : 'fa-arrows-up-down') }),
  ]);
  th.onclick = () => {
    if (ativo) state.ordem.dir = state.ordem.dir === 'asc' ? 'desc' : 'asc';
    else state.ordem = { col: col, dir: 'asc' };
    atualizarTabela();
  };
  return th;
}

function tabela(L){
  if (!L.length){
    return h('div', { class:'empty' }, [ icone('fa-inbox'), 'Nada nesta lista.' ]);
  }
  const ehPago = state.aba === 'pago';
  const thead = h('thead', {}, [ h('tr', {}, [
    h('th', { text:'Origem' }),
    thOrd('Número','numero'),
    thOrd('Favorecido','fornecedor'),
    thOrd(ehPago ? 'Baixa' : 'Vencimento', ehPago ? 'dt_baixa' : 'vencimento'),
    thOrd('Valor','valor'),
    h('th', { text:'Situação' }),
    h('th', { text:'' }),
  ])]);

  const tbody = h('tbody');
  const ini = (state.pagina - 1) * CONFIG.PAGINA;
  L.slice(ini, ini + CONFIG.PAGINA).forEach(x => tbody.appendChild(linhaTabela(x, ehPago)));
  const tbl = h('table', {}, [ thead, tbody ]);

  if (L.length > CONFIG.PAGINA){
    const box = h('div');
    box.appendChild(tbl);
    const tot = Math.ceil(L.length / CONFIG.PAGINA);
    const nav = h('div', { class:'rodape' });
    const info = h('span', { text: 'página ' + state.pagina + ' de ' + tot });
    const bts = h('div', { style:'display:flex;gap:6px' });
    const mk = (rot, alvo, off) => {
      const b = h('button', { class:'btn btn-ghost btn-sm', type:'button', text:rot });
      b.disabled = off;
      b.onclick = () => { state.pagina = alvo; atualizarTabela(); };
      return b;
    };
    bts.appendChild(mk('Anterior', state.pagina-1, state.pagina <= 1));
    bts.appendChild(mk('Próxima', state.pagina+1, state.pagina >= tot));
    nav.appendChild(info); nav.appendChild(bts);
    box.appendChild(nav);
    return box;
  }
  return tbl;
}

function linhaTabela(x, ehPago){
  const sit = SITUACOES[x.situacao] || ['—','b-mute'];
  const tdSit = h('td', {}, [ badge(sit[0], sit[1]) ]);
  if (x.aviso === 'valor_diverge') tdSit.appendChild(badge('valor diverge','b-danger'));
  if (x.aviso === 'valor_corrigido') tdSit.appendChild(badge('valor corrigido','b-info'));
  if (x.aviso === 'valor_corrigido_sem_par') tdSit.appendChild(badge('valor a conferir','b-warn'));
  if (x.modoPar === 'aprox') tdSit.appendChild(badge('casado por semelhança','b-info'));
  if (x.editado) tdSit.appendChild(badge('editado','b-orange'));
  if (x.estimado) tdSit.appendChild(badge('estimado','b-warn'));
  if (x.oculto)   tdSit.appendChild(badge('oculto','b-mute'));

  const tdData = h('td', { class:'mono' }, [ fmtData(ehPago ? x.dt_baixa : x.vencimento) ]);
  if (!ehPago && x.empurrado){
    tdData.appendChild(h('span', { class:'antes', style:'text-decoration:none',
      title:'venceu em dia sem pagamento e foi para o próximo dia útil',
      text: 'venc. ' + fmtData(x.vencimentoOriginal) }));
  }
  if (x.edicoes && x.edicoes[ehPago ? 'dt_baixa' : 'vencimento'] && !x.edicoes[ehPago?'dt_baixa':'vencimento'].absorvido){
    tdData.appendChild(h('span', { class:'antes', text: fmtData(x.edicoes[ehPago?'dt_baixa':'vencimento'].original) }));
  }

  const tdValor = h('td', { class:'num' }, [ fmtBR(x.valor) ]);
  if (x.edicoes && x.edicoes.valor_rs && !x.edicoes.valor_rs.absorvido){
    tdValor.appendChild(h('span', { class:'antes', text: fmtBR(x.edicoes.valor_rs.original) }));
  } else if (x.valorFluig != null && x.valorTotvs != null && Math.abs(x.valorFluig - x.valorTotvs) > 0.05){
    tdValor.appendChild(h('span', { class:'antes', style:'text-decoration:none',
      text: 'Fluig: ' + fmtBR(x.valorFluig) }));
  }

  const tdAcoes = h('td', {}, []);
  if (state.podeEditar && x.editavel){
    const bts = [];
    // lançamento próprio ainda sem pagamento: atalho para confirmar o valor
    if (x.manual && !x.dt_baixa){
      const bc = h('button', { class:'btn-icon', type:'button', title:'Confirmar o valor que foi pago' }, [icone('fa-circle-check')]);
      bc.onclick = () => confirmarPagamento(x);
      bts.push(bc);
    }
    const b = h('button', { class:'btn-icon', type:'button', title:'Editar este título' }, [icone('fa-pen')]);
    b.onclick = () => abrirEdicao(x);
    bts.push(b);
    const bo = h('button', { class:'btn-icon', type:'button',
      title: x.oculto ? 'Trazer de volta' : 'Ocultar da prévia e dos totais' },
      [icone(x.oculto ? 'fa-eye' : 'fa-eye-slash')]);
    bo.onclick = () => alternarOculto(x);
    bts.push(bo);
    tdAcoes.appendChild(h('div', { class:'acoes' }, bts));
  }

  return h('tr', { class: x.editado ? 'editada' : '' }, [
    h('td', {}, [ badge(x.origem, x.origem === 'Direto no Totvs' ? 'b-mute' : 'b-info') ]),
    h('td', { class:'mono', text: x.numero }),
    h('td', {}, [ h('div', { class:'forn' }, [
      x.fornecedor || '—',
      h('small', { text: [x.status, x.detalhe].filter(Boolean).join(' · ').slice(0, 70) }),
    ])]),
    tdData, tdValor, tdSit, tdAcoes,
  ]);
}

function debounce(fn, ms){
  let t;
  return function(){ const a = arguments; clearTimeout(t); t = setTimeout(() => fn.apply(null, a), ms); };
}

/* ============================================================================
   EDIÇÃO DO TÍTULO
   ----------------------------------------------------------------------------
   Nada é escrito por cima do dado original: cada campo alterado vira uma linha
   na aba Ajustes, e o painel aplica isso por cima a cada carregamento. Por isso
   a edição sobrevive a quantos envios de relatório forem feitos no mesmo dia.
   ============================================================================ */
const CAMPOS_EDITAVEIS = [
  { k:'vencimento',    rot:'Vencimento',        tipo:'date' },
  { k:'dt_baixa',      rot:'Data da baixa',     tipo:'date' },
  { k:'valor_rs',      rot:'Valor (R$)',        tipo:'number' },
  { k:'valor_liquido', rot:'Valor pago (R$)',   tipo:'number' },
  { k:'fornecedor',    rot:'Favorecido',        tipo:'text', wide:true },
  { k:'numero',        rot:'Número do título',  tipo:'text' },
  { k:'parcela',       rot:'Parcela',           tipo:'text' },
  { k:'prefixo',       rot:'Prefixo',           tipo:'text' },
  { k:'tipo',          rot:'Tipo',              tipo:'text' },
  { k:'natureza',      rot:'Natureza',          tipo:'text' },
  { k:'banco',         rot:'Banco',             tipo:'text' },
  { k:'bordero',       rot:'Borderô',           tipo:'text' },
  { k:'historico',     rot:'Histórico',         tipo:'text', wide:true },
];

let edicaoAtual = null;

async function abrirEdicao(linha){
  if (!(await Auth.pedir())) return;
  const t = linha.titulo;
  edicaoAtual = { linha: linha, chave: linha.chave, orig: t };

  el('me-titulo').textContent = 'Editar título ' + linha.numero;
  el('me-sub').textContent = (linha.fornecedor || '') +
    (linha.id_fluig ? (' · solicitação Fluig #' + linha.id_fluig) : '') +
    ' — a alteração fica registrada com seu nome e não altera o Totvs.';

  const box = el('me-campos');
  box.innerHTML = '';
  CAMPOS_EDITAVEIS.forEach(c => {
    const valor = t[c.k];
    const ed = linha.edicoes && linha.edicoes[c.k];
    const input = h('input', {
      type: c.tipo, id: 'ed-' + c.k, step: c.tipo === 'number' ? '0.01' : null,
      value: c.tipo === 'number' ? (Number(valor)||0) : safeStr(valor),
    });
    input.oninput = () => input.classList.add('mudou');
    const campo = h('div', { class:'campo' + (c.wide ? ' wide' : '') }, [
      h('label', { for:'ed-'+c.k, text:c.rot }),
      input,
      (ed && !ed.absorvido && !ed.descartado)
        ? h('span', { class:'orig', text:'antes: ' + safeStr(ed.original) + ' · ' + safeStr(ed.autor) })
        : null,
    ]);
    box.appendChild(campo);
  });
  const motivo = h('input', { type:'text', id:'ed-motivo', placeholder:'opcional — por que está mudando' });
  box.appendChild(h('div', { class:'campo wide' }, [ h('label', { text:'Motivo' }), motivo ]));

  el('me-reset').hidden = !linha.editado;
  el('modalEdit').classList.add('show');
}

function fecharEdicao(){
  el('modalEdit').classList.remove('show');
  edicaoAtual = null;
}

async function salvarEdicao(){
  if (!edicaoAtual) return;
  const t = edicaoAtual.orig;
  const ajustes = [];
  CAMPOS_EDITAVEIS.forEach(c => {
    const input = el('ed-' + c.k);
    if (!input) return;
    const novo = input.value;
    const atual = c.tipo === 'number' ? String(Number(t[c.k])||0) : safeStr(t[c.k]);
    if (safeStr(novo) === atual) return;
    ajustes.push({
      alvo: edicaoAtual.chave, campo: c.k,
      valor_novo: novo, valor_antigo: atual,
      autor: state.autor, motivo: el('ed-motivo').value.trim(),
    });
  });
  if (!ajustes.length){ toast('Nada mudou.'); fecharEdicao(); return; }

  fecharEdicao();
  abrirLoader('Salvando alteração…');
  try {
    await enviar({ acao:'ajuste', token: state.token, ajustes: ajustes });
    await new Promise(r => setTimeout(r, 1800));
    await carregar();
    const conferido = state.linhas.some(x => x.chave === ajustes[0].alvo && x.editado);
    if (conferido) toast(ajustes.length + ' campo(s) alterado(s).');
    else { Auth.limpar(); toast('Não gravou. Confira a senha de edição.', true); }
  } catch(e){
    esconderLoader();
    toast('Erro ao salvar: ' + (e.message || e), true);
  }
}

async function desfazerEdicoes(){
  if (!edicaoAtual) return;
  const alvo = edicaoAtual.chave;
  fecharEdicao();
  abrirLoader('Desfazendo…');
  try {
    await enviar({ acao:'desfazer', token: state.token, id: 'alvo:' + alvo });
    await new Promise(r => setTimeout(r, 1800));
    await carregar();
    toast('Edições desfeitas.');
  } catch(e){
    esconderLoader();
    toast('Erro ao desfazer: ' + (e.message || e), true);
  }
}

/* --------------------------------------------------- ocultar / CIOT --- */

/* Ocultar não apaga: o título continua na base e volta com um clique. Apagar
   de verdade não resolveria, porque ele reapareceria no próximo relatório do
   Totvs e alguém teria que apagar de novo todo dia. */
async function alternarOculto(linha){
  if (!(await Auth.pedir())) return;
  const voltando = linha.oculto;
  let motivo = '';
  if (!voltando){
    motivo = prompt('Por que está ocultando este título? (opcional)') || '';
  }
  await gravarComRecarga(
    { acao:'ajuste', token: state.token, ajustes: [{
        alvo: linha.chave, campo: CAMPO_OCULTO,
        valor_novo: voltando ? '0' : '1', valor_antigo: voltando ? '1' : '0',
        autor: state.autor, motivo: motivo,
      }] },
    voltando ? 'Trazendo de volta…' : 'Ocultando…',
    voltando ? 'Título de volta na lista.' : 'Título ocultado.');
}

/* O CIOT é lançado como prévia e, no dia seguinte, confirmado com o valor que
   de fato saiu. Em vez de lançar duas vezes, a mesma linha muda de estado. */
async function confirmarPagamento(linha){
  if (!(await Auth.pedir())) return;
  const t = linha.titulo;
  const sugerido = String(t.valor_rs || 0).replace('.', ',');
  const resp = prompt('Valor que foi pago (R$):', sugerido);
  if (resp === null) return;
  const valor = Conc.parseBRNumber(resp);
  if (!valor){ toast('Valor inválido.', true); return; }

  const ontem = diaUtilAnterior(state.dataRef);
  const data = prompt('Data do pagamento (aaaa-mm-dd):', t.vencimento || ontem);
  if (!data) return;

  const ajustes = [
    { alvo: linha.chave, campo:'dt_baixa', valor_novo: data, valor_antigo:'', autor: state.autor, motivo:'confirmação de pagamento' },
    { alvo: linha.chave, campo:'valor_liquido', valor_novo: String(valor), valor_antigo: String(t.valor_liquido||0), autor: state.autor, motivo:'confirmação de pagamento' },
  ];
  if (Math.abs(valor - (t.valor_rs||0)) > 0.005){
    ajustes.push({ alvo: linha.chave, campo:'valor_rs', valor_novo: String(valor),
      valor_antigo: String(t.valor_rs||0), autor: state.autor, motivo:'confirmação de pagamento' });
  }
  await gravarComRecarga({ acao:'ajuste', token: state.token, ajustes: ajustes },
    'Confirmando…', 'Pagamento confirmado.');
}

/* Envia, espera a planilha assentar e recarrega — como a resposta do Apps
   Script não é legível no modo no-cors, a confirmação vem dos dados. */
async function gravarComRecarga(payload, textoLoader, textoOk){
  abrirLoader(textoLoader);
  try {
    await enviar(payload);
    await new Promise(r => setTimeout(r, 1800));
    await carregar();
    toast(textoOk);
  } catch(e){
    esconderLoader();
    toast('Erro: ' + (e.message || e), true);
  }
}

/* ------------------------------------------------------ título novo --- */
/* modelo: null para título em branco, 'ciot' para o CIOT do dia já preenchido */
async function abrirNovo(modelo){
  if (!(await Auth.pedir())) return;
  const ciot = (modelo === 'ciot');
  const base = ciot ? novoCiot(state.dataRef) : {};
  edicaoAtual = { novo: true, ciot: ciot, base: base };

  el('me-titulo').textContent = ciot ? ('CIOT de ' + fmtData(state.dataRef)) : 'Novo título';
  el('me-sub').textContent = ciot
    ? 'Um lançamento por dia, com o valor total transferido. Só o valor precisa ser digitado; o resto já vai preenchido. Se ainda for previsão, deixe a data do pagamento em branco.'
    : 'Para o pagamento que não passou nem pelo Fluig nem pelo Totvs. Fica numa aba própria e o envio de relatório não apaga.';

  const box = el('me-campos');
  box.innerHTML = '';
  CAMPOS_EDITAVEIS.forEach(c => {
    let v = base[c.k];
    if (v === undefined || v === null) v = (c.k === 'vencimento') ? state.dataRef : (c.tipo === 'number' ? 0 : '');
    const input = h('input', { type:c.tipo, id:'ed-'+c.k, step: c.tipo === 'number' ? '0.01' : null,
      value: c.tipo === 'number' ? (Number(v)||0) : safeStr(v) });
    box.appendChild(h('div', { class:'campo' + (c.wide ? ' wide' : '') }, [
      h('label', { for:'ed-'+c.k, text:c.rot }), input,
    ]));
  });
  el('me-reset').hidden = true;
  el('modalEdit').classList.add('show');
  if (ciot) setTimeout(() => { const i = el('ed-valor_rs'); if (i){ i.focus(); i.select(); } }, 80);
}

async function salvarNovo(){
  const base = (edicaoAtual && edicaoAtual.base) || {};
  const titulo = Object.assign({}, base, { manual:true });
  CAMPOS_EDITAVEIS.forEach(c => {
    const input = el('ed-' + c.k);
    if (!input) return;
    titulo[c.k] = c.tipo === 'number' ? (Number(input.value)||0) : input.value.trim();
  });
  if (!titulo.fornecedor || !titulo.valor_rs){
    toast('Favorecido e valor são obrigatórios.', true); return;
  }
  titulo.valor = titulo.valor_rs;
  if (!titulo.valor_liquido) titulo.valor_liquido = titulo.valor_rs;
  // id próprio: o CIOT repete o número 1 todo dia
  if (!titulo.id_manual){
    titulo.id_manual = (titulo.tipo || 'MAN') + '-' + (titulo.vencimento || state.dataRef) +
      '-' + Math.random().toString(36).slice(2,6);
  }
  if (edicaoAtual && edicaoAtual.ciot) titulo.id_manual = 'CIOT-' + (titulo.vencimento || state.dataRef);
  fecharEdicao();
  await gravarComRecarga({ acao:'titulo_manual', token: state.token, titulo: titulo },
    'Gravando título…', 'Título lançado.');
}

/* Exporta no formato do relatório que a controladoria já usa. Sai exatamente
   o que está na tela, inclusive com os filtros aplicados — por isso o recorte
   vai escrito no cabeçalho e no nome do arquivo. */
function gerarRelatorio(L, rotulo){
  const naturezas = (state.dados && state.dados.naturezas) || {};
  try {
    const res = exportarRelatorio(L, state.dataRef, naturezas, rotulo);
    const semFluxo = L.filter(x => {
      const n = safeStr(x.natureza);
      const info = naturezas[n] || naturezas[n.replace(/^0+/,'')];
      return !x.conta_fluxo && !(info && info.conta_fluxo);
    }).length;
    toast(res.linhas + ' linha(s) no relatório' +
      (semFluxo ? (' · ' + semFluxo + ' sem conta de fluxo') : '') + '.');
  } catch(e){
    toast(e.message || String(e), true);
  }
}

/* --------------------------------------------------------- exportação */
function exportarExcel(L, rotulo){
  if (typeof XLSX === 'undefined'){ toast('Biblioteca de exportação carregando…', true); return; }
  const ehPago = state.aba === 'pago';
  const dados = L.map(x => ({
    'Origem': x.origem,
    'Número': x.numero,
    'Fluig': x.id_fluig || '',
    'Favorecido': x.fornecedor,
    'Vencimento': fmtData(x.vencimento),
    'Data da baixa': x.dt_baixa ? fmtData(x.dt_baixa) : '',
    'Valor': Number(x.valor) || 0,
    'Valor Fluig': x.valorFluig != null ? x.valorFluig : '',
    'Situação': (SITUACOES[x.situacao] || [x.situacao])[0],
    'Status Fluig': x.status || '',
    'Histórico': x.detalhe || '',
    'Editado': x.editado ? 'sim' : '',
  }));
  if (!dados.length){ toast('Nada para exportar.'); return; }
  try {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dados), 'Pagamentos');
    XLSX.writeFile(wb, 'pagamentos-' + norm(rotulo).replace(/[^a-z0-9]+/g,'-') + '-' + state.dataRef + '.xlsx');
  } catch(e){ toast('Erro ao gerar a planilha.', true); }
}

/* ------------------------------------------------------------- menu --- */
function abrirMenu(v){
  el('sidebar').classList.toggle('open', v);
  el('sidebarOverlay').classList.toggle('visible', v);
  el('btnHamburger').setAttribute('aria-expanded', v ? 'true' : 'false');
}
const fecharMenu = () => { if (window.innerWidth <= 1024) abrirMenu(false); };

/* ============================================================================
   INÍCIO
   ============================================================================ */
document.addEventListener('DOMContentLoaded', () => {
  state.podeEditar = HubLink.init();
  Auth.carregar();

  el('dataRef').value = state.dataRef;
  el('dataRef').onchange = e => {
    state.dataRef = e.target.value || hojeISO();
    preparar(); render();
  };
  el('btnHoje').onclick = () => {
    state.dataRef = hojeISO();
    el('dataRef').value = state.dataRef;
    preparar(); render();
  };
  el('btnRecarregar').onclick = () => { abrirLoader('Atualizando…'); carregar(); };
  el('btnNovo').onclick = () => abrirNovo(null);
  const bc = el('btnCiot');
  if (bc) bc.onclick = () => abrirNovo('ciot');

  el('btnHamburger').onclick = () => abrirMenu(!el('sidebar').classList.contains('open'));
  el('sidebarOverlay').onclick = () => abrirMenu(false);

  el('me-cancel').onclick = fecharEdicao;
  el('me-reset').onclick = desfazerEdicoes;
  el('me-salvar').onclick = () => (edicaoAtual && edicaoAtual.novo) ? salvarNovo() : salvarEdicao();
  el('modalEdit').onclick = e => { if (e.target === el('modalEdit')) fecharEdicao(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharEdicao(); });

  if (!CONFIG.DATA_URL || CONFIG.DATA_URL.indexOf('COLE_A_URL') === 0){
    mostrarErro(new Error('Falta colar a URL do Apps Script em CONFIG.DATA_URL, no topo do app.js.'));
    return;
  }
  carregar(true);
});
