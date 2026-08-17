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
  definirFeriados, diaUtilAnterior, ehDiaUtil, ehFeriado,
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
  aba: 'hoje',          // pago | hoje | amanha | ocultos
  busca: '', filtroSit: '', filtroOrigem: '', filtroTipo: '',
  ordem: { col:'vencimento', dir:'asc' },
  pagina: 1,
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
      ['btn-hub','link-atualizar'].forEach(id => { const n = el(id); if (n) n.hidden = false; });
    }
    return ok;
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

/* ============================================================================
   CARGA E PREPARO
   ============================================================================ */
/* A barra mostra progresso de verdade, não um número inventado: cada etapa
   avança um pedaço, e o último passo fecha em 100%. */
function etapaLoader(texto, pct){
  const t = el('load-text'), f = el('load-barra-fill'), p = el('load-pct');
  if (t) t.textContent = texto;
  if (f) f.style.width = pct + '%';
  if (p) p.textContent = pct + '%';
}
const respira = ms => new Promise(r => setTimeout(r, ms));

async function carregar(primeira){
  etapaLoader(primeira ? 'Lendo a base…' : 'Atualizando…', 12);
  try {
    const url = CONFIG.DATA_URL + (CONFIG.DATA_URL.indexOf('?') >= 0 ? '&' : '?') + 'v=' + Date.now();
    state.dados = await buscarJson(url);
    if (state.dados && state.dados.erro) throw new Error(state.dados.erro);

    etapaLoader('Cruzando Fluig e Totvs…', 55);
    await respira(60);
    preparar();

    etapaLoader('Calculando totais e somas…', 84);
    await respira(60);
    render();

    etapaLoader('Pronto', 100);
    await respira(180);
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
  etapaLoader(texto || 'Carregando…', 8);
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
    ocultos: {
      rotulo: 'Ocultos',
      icone: 'fa-eye-slash', classe: 'mute',
      linhas: state.linhas.filter(x => x.oculto),
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
  ['pago','hoje','amanha','ocultos'].forEach(k => {
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
   momentos. A ordem é sempre ontem, hoje e amanhã — uma linha do tempo não se
   embaralha. O que se move é o destaque: o cartão escolhido cresce e ganha o
   fundo escuro, os outros recuam. */
function secaoKPIs(){
  const R = recortes(), r = state.resumo;
  const sec = h('div', { class:'section' });
  const linha = h('div', { class:'timeline' });

  ['pago','hoje','amanha'].forEach((k, i) => {
    const rec = R[k];
    const ativo = state.aba === k;
    const card = h('div', {
      class:'marco ' + rec.classe + (ativo ? ' destaque' : ' recuado'),
      role:'button', tabindex:'0', 'aria-pressed': ativo ? 'true' : 'false',
    }, [
      h('div', { class:'marco-topo' }, [
        h('span', { class:'marco-quando', text: rec.rotulo }),
      ]),
      h('div', { class:'marco-valor', 'data-valor': Number(rec.valor)||0 }, [ 'R$ ' + fmtBR0(rec.valor) ]),
      h('div', { class:'marco-qtd', text: rec.qtd ? (rec.qtd + (rec.qtd === 1 ? ' título' : ' títulos')) : 'nenhum título' }),
      h('div', { class:'marco-sub', text: rec.sub }),
    ]);

    // só o cartão do dia mostra o quanto do previsto já saiu
    if (k === 'hoje'){
      const prev = R.hoje.valor + R.pago.valor;
      const frac = prev > 0 ? Math.min(1, R.pago.valor / prev) : 0;
      if (r.aguardandoHoje.qtd){
        card.appendChild(h('div', { class:'marco-alerta' }, [
          icone('fa-hourglass-half'),
          h('span', { text: 'R$ ' + fmtBR0(r.aguardandoHoje.valor) + ' aguardando aprovação' }),
        ]));
      }
      card.appendChild(h('div', { class:'marco-barra', title:'proporção já paga em relação ao previsto' },
        [ h('span', { style:'width:' + Math.round(frac*100) + '%' }) ]));
    }

    const ir = () => { if (state.aba !== k){ state.aba = k; state.pagina = 1; state.filtroTipo = ''; render(); } };
    card.onclick = ir;
    card.onkeydown = e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); ir(); } };
    linha.appendChild(card);
    if (i < 2) linha.appendChild(h('div', { class:'timeline-seta' }, [ icone('fa-chevron-right') ]));
  });

  // a coluna do cartão em destaque fica maior; a transição do grid é o que dá
  // o movimento de carrossel
  const pesos = { pago:['1.35fr','1fr','1fr'], hoje:['1fr','1.35fr','1fr'], amanha:['1fr','1fr','1.35fr'] };
  const p = pesos[state.aba] || pesos.hoje;
  linha.style.setProperty('--c1', p[0]);
  linha.style.setProperty('--c2', p[1]);
  linha.style.setProperty('--c3', p[2]);

  sec.appendChild(linha);
  return sec;
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
  if (state.filtroTipo)   L = L.filter(x => (safeStr(x.tipo) || '—') === state.filtroTipo);

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
  // (chips de tipo entram logo abaixo da barra)
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

  /* Chips por tipo de título, montados a partir do que existe no recorte —
     mesma mecânica da ferramenta antiga. */
  const tipos = {};
  rec.linhas.forEach(x => {
    const t = safeStr(x.tipo) || '—';
    tipos[t] = (tipos[t] || 0) + 1;
  });
  const nomes = Object.keys(tipos).sort();
  if (nomes.length > 1){
    const chips = h('div', { class:'chips' });
    const mkChip = (valor, rotulo, qtd) => {
      const cor = valor ? (' t-' + norm(valor).replace(/[^a-z0-9]/g,'') ) : '';
      const b = h('button', { class:'chip' + cor + (state.filtroTipo === valor ? ' active' : ''), type:'button' },
        [ rotulo, h('span', { class:'cnt', text: String(qtd) }) ]);
      b.onclick = () => { state.filtroTipo = valor; state.pagina = 1; render(); };
      return b;
    };
    chips.appendChild(mkChip('', 'Todos', rec.linhas.length));
    nomes.forEach(t => chips.appendChild(mkChip(t, t, tipos[t])));
    card.appendChild(chips);
  }

  const wrap = h('div', { class:'tbl-wrap', id:'tbl-wrap' });
  const topo = paginacao(L, 'topo');
  if (topo) wrap.appendChild(topo);
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
  const topo = paginacao(L, 'topo');
  if (topo) wrap.appendChild(topo);
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

/* Anterior/próxima aparece nas duas pontas da tabela: com muitas linhas,
   rolar até o fim só para virar a página é irritante. */
function paginacao(L, onde){
  const tot = Math.ceil(L.length / CONFIG.PAGINA) || 1;
  if (tot <= 1) return null;
  const nav = h('div', { class:'paginacao ' + onde });
  const mk = (rot, alvo, off) => {
    const b = h('button', { class:'btn btn-ghost btn-sm', type:'button', text:rot });
    b.disabled = off;
    b.onclick = () => { state.pagina = alvo; atualizarTabela(); };
    return b;
  };
  nav.appendChild(h('span', { text:'página ' + state.pagina + ' de ' + tot }));
  nav.appendChild(h('div', { style:'display:flex;gap:6px' }, [
    mk('Anterior', state.pagina - 1, state.pagina <= 1),
    mk('Próxima',  state.pagina + 1, state.pagina >= tot),
  ]));
  return nav;
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
  ])]);

  const tbody = h('tbody');
  const ini = (state.pagina - 1) * CONFIG.PAGINA;
  L.slice(ini, ini + CONFIG.PAGINA).forEach(x => tbody.appendChild(linhaTabela(x, ehPago)));
  const tbl = h('table', {}, [ thead, tbody ]);
  const rodape = paginacao(L, 'baixo');
  return rodape ? h('div', {}, [ tbl, rodape ]) : tbl;
}

function linhaTabela(x, ehPago){
  const sit = SITUACOES[x.situacao] || ['—','b-mute'];
  /* As marcas de conferência (valor diverge, casado por semelhança) vivem na
     tela de conferência. Aqui fica só o que muda a leitura do dia. */
  const tdSit = h('td', {}, [ badge(sit[0], sit[1]) ]);
  if (x.editado)  tdSit.appendChild(badge('editado','b-orange'));
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

  /* O painel é só leitura: ajuste, inclusão e exclusão acontecem na tela de
     conferência, que é onde os dados entram e são checados antes de publicar. */
  const tdAcoes = h('td', {}, []);

  return h('tr', { class: x.editado ? 'editada' : '' }, [
    h('td', {}, [ badge(x.origem, x.origem === 'Direto no Totvs' ? 'b-mute' : 'b-info') ]),
    h('td', { class:'mono', text: x.numero }),
    h('td', {}, [ h('div', { class:'forn' }, [
      x.fornecedor || '—',
      h('small', { text: [x.status, x.detalhe].filter(Boolean).join(' · ').slice(0, 70) }),
    ])]),
    tdData, tdValor, tdSit,
  ]);
}

function debounce(fn, ms){
  let t;
  return function(){ const a = arguments; clearTimeout(t); t = setTimeout(() => fn.apply(null, a), ms); };
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
  HubLink.init();

  // o painel é sempre do dia de hoje — sem seletor de data
  state.dataRef = hojeISO();
  const dt = new Date();
  el('headerData').textContent = dt.toLocaleDateString('pt-BR',
    { weekday:'long', day:'numeric', month:'long' });

  el('btnRecarregar').onclick = () => { abrirLoader('Atualizando…'); carregar(); };
  el('btnHamburger').onclick = () => abrirMenu(!el('sidebar').classList.contains('open'));
  el('sidebarOverlay').onclick = () => abrirMenu(false);

  // estado da barra lateral fica gravado: ela abre como você deixou
  const btnRec = el('btnRecolher');
  try {
    if (localStorage.getItem('pgv2_sidebar') === 'recolhida') document.body.classList.add('recolhida');
  } catch(e){}
  if (btnRec) btnRec.onclick = () => {
    const rec = document.body.classList.toggle('recolhida');
    try { localStorage.setItem('pgv2_sidebar', rec ? 'recolhida' : 'aberta'); } catch(e){}
  };

  if (!CONFIG.DATA_URL || CONFIG.DATA_URL.indexOf('COLE_A_URL') === 0){
    mostrarErro(new Error('Falta colar a URL do Apps Script em CONFIG.DATA_URL, no topo do app.js.'));
    return;
  }
  carregar(true);
});
