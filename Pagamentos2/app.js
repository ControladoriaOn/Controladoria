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
      ['btn-hub','link-atualizar','btnNovo'].forEach(id => { const n = el(id); if (n) n.hidden = false; });
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
  if (!primeira) el('load-text').textContent = 'Atualizando…';
  try {
    const url = CONFIG.DATA_URL + (CONFIG.DATA_URL.indexOf('?') >= 0 ? '&' : '?') + 'v=' + Date.now();
    state.dados = await buscarJson(url);
    if (state.dados && state.dados.erro) throw new Error(state.dados.erro);
    preparar();
    render();
    esconderLoader();
  } catch(e){
    mostrarErro(e);
  }
}

function preparar(){
  const d = state.dados || {};
  if (d.config_status) definirMapaStatus(d.config_status);

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
  setTimeout(() => { l.style.display = 'none'; }, 450);
}
function mostrarErro(e){
  const l = el('loader');
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
  const r = state.resumo, L = state.linhas;
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
}

function renderNav(){
  const nav = el('nav');
  nav.innerHTML = '';
  const R = recortes();
  ['pago','hoje','amanha','atrasado','excecoes'].forEach(k => {
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

function secaoKPIs(){
  const R = recortes();
  const sec = h('div', { class:'section' });
  const grid = h('div', { class:'kpi-grid' });
  ['pago','hoje','amanha'].forEach(k => {
    const rec = R[k];
    const card = h('div', { class:'kpi clicavel ' + rec.classe + (state.aba === k ? ' ativo' : '') }, [
      h('div', { class:'k-label', text: rec.rotulo }),
      h('div', { class:'k-value', text: 'R$ ' + fmtBR0(rec.valor) }),
      h('div', { class:'k-sub', text: rec.sub }),
    ]);
    card.onclick = () => { state.aba = k; state.pagina = 1; render(); };
    grid.appendChild(card);
  });
  sec.appendChild(grid);
  return sec;
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
    add('info','fa-circle-info','Sem relatório de baixas. ',
      'O “Pago” só aparece depois que o relatório do Totvs filtrado por data de baixa for enviado. Um título nunca é baixado no mesmo dia em que é pago, então esse número é sempre do dia anterior.');
  }
  if (r.semTituloAprovado.qtd){
    add('warn','fa-triangle-exclamation', r.semTituloAprovado.qtd + ' aprovado(s) sem título no Totvs. ',
      'Foram liberados no Fluig e ainda não apareceram no relatório — ou não foram lançados, ou o filtro de vencimento deixou de fora.');
  }
  if (r.divergencias){
    add('danger','fa-scale-unbalanced', r.divergencias + ' com valor diferente entre Fluig e Totvs. ',
      'Vale conferir antes de confiar no total.');
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

  const btnXls = h('button', { class:'btn btn-ghost btn-sm', type:'button' }, [icone('fa-file-excel'), 'Excel']);
  btnXls.onclick = () => exportarExcel(L, rec.rotulo);

  card.appendChild(h('div', { class:'card-bar' }, [
    h('div', { class:'card-bar-title' }, [ icone(rec.icone), rec.rotulo ]),
    h('div', { class:'filtros' }, [
      h('div', { class:'busca' }, [ icone('fa-magnifying-glass'), busca ]),
      selSit, selOri, btnXls,
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

  const tdData = h('td', { class:'mono' }, [ fmtData(ehPago ? x.dt_baixa : x.vencimento) ]);
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
    const b = h('button', { class:'btn-icon', type:'button', title:'Editar este título' }, [icone('fa-pen')]);
    b.onclick = () => abrirEdicao(x);
    tdAcoes.appendChild(h('div', { class:'acoes' }, [b]));
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
  el('load-text').textContent = 'Salvando alteração…';
  el('loader').style.display = 'flex';
  el('loader').classList.remove('out');
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
  el('load-text').textContent = 'Desfazendo…';
  el('loader').style.display = 'flex';
  el('loader').classList.remove('out');
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

/* ------------------------------------------------------ título novo --- */
async function abrirNovo(){
  if (!(await Auth.pedir())) return;
  edicaoAtual = { novo: true };
  el('me-titulo').textContent = 'Novo título';
  el('me-sub').textContent = 'Para o pagamento que não passou nem pelo Fluig nem pelo Totvs. Ele fica numa aba própria e o envio de relatório não apaga.';
  const box = el('me-campos');
  box.innerHTML = '';
  CAMPOS_EDITAVEIS.forEach(c => {
    const input = h('input', { type:c.tipo, id:'ed-'+c.k, step: c.tipo === 'number' ? '0.01' : null,
      value: c.k === 'vencimento' ? state.dataRef : (c.tipo === 'number' ? '0' : '') });
    box.appendChild(h('div', { class:'campo' + (c.wide ? ' wide' : '') }, [
      h('label', { for:'ed-'+c.k, text:c.rot }), input,
    ]));
  });
  el('me-reset').hidden = true;
  el('modalEdit').classList.add('show');
}

async function salvarNovo(){
  const titulo = { manual:true };
  CAMPOS_EDITAVEIS.forEach(c => {
    const input = el('ed-' + c.k);
    if (!input) return;
    titulo[c.k] = c.tipo === 'number' ? (Number(input.value)||0) : input.value.trim();
  });
  if (!titulo.fornecedor || !titulo.valor_rs){
    toast('Favorecido e valor são obrigatórios.', true); return;
  }
  titulo.valor = titulo.valor_rs;
  fecharEdicao();
  el('load-text').textContent = 'Gravando título…';
  el('loader').style.display = 'flex';
  el('loader').classList.remove('out');
  try {
    await enviar({ acao:'titulo_manual', token: state.token, titulo: titulo });
    await new Promise(r => setTimeout(r, 1800));
    await carregar();
    toast('Título lançado.');
  } catch(e){
    esconderLoader();
    toast('Erro ao gravar: ' + (e.message || e), true);
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
  el('btnRecarregar').onclick = () => {
    el('loader').style.display = 'flex';
    el('loader').classList.remove('out');
    carregar();
  };
  el('btnNovo').onclick = abrirNovo;

  el('btnHamburger').onclick = () => abrirMenu(!el('sidebar').classList.contains('open'));
  el('sidebarOverlay').onclick = () => abrirMenu(false);

  el('me-cancel').onclick = fecharEdicao;
  el('me-reset').onclick = desfazerEdicoes;
  el('me-salvar').onclick = () => (edicaoAtual && edicaoAtual.novo) ? salvarNovo() : salvarEdicao();
  el('modalEdit').onclick = e => { if (e.target === el('modalEdit')) fecharEdicao(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharEdicao(); });

  if (!CONFIG.DATA_URL || CONFIG.DATA_URL.indexOf('https://script.google.com/macros/s/AKfycbwutQ02_VsAX-cKwsNDSKkG-ScJ9ER6XlPVK6_00hNUPRtBlvYDwok0GisJglU3ES2L/exec') === 0){
    mostrarErro(new Error('Falta colar a URL do Apps Script em CONFIG.DATA_URL, no topo do app.js.'));
    return;
  }
  carregar(true);
});
