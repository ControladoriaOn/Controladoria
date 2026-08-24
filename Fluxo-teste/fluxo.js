'use strict';
/* ============================================================================
   FLUXO DE CAIXA · ON TIME
   ----------------------------------------------------------------------------
   A conta é a mesma da planilha que a controladoria sempre usou:

       saldo inicial + entradas - saídas = saldo final

   O saldo inicial de um dia é o saldo final do dia anterior. As entradas são
   digitadas aqui. As saídas vêm somadas do relatório de pagamentos que já é
   enviado todo dia — ninguém redigita nada.

   Embaixo fica a posição de saldos dos bancos, que é digitada, e a diferença
   entre ela e o saldo final calculado. Diferença fora de zero quer dizer que
   algum lançamento não passou por aqui: é o alarme da tela.

   Dia passado mostra o que aconteceu. Dia de hoje em diante mostra o previsto,
   porque um pagamento feito hoje só vira baixa amanhã.
   ============================================================================ */

const CONFIG = {
  // mesma URL /exec do painel de pagamentos
  DATA_URL: 'https://script.google.com/macros/s/AKfycbzHS4o-21O7eIfKsyc3Y04J0hBObuhnTAcWZmV7EWXeCyyvlp5FyMpDj93406TgEOZ2/exec',
  RETRIES: 3,
  BACKOFF_MS: 600,
};

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
const icone = c => h('i', { class:'fa-solid ' + c });

function toast(msg, erro){
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast show' + (erro ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 3600);
}

/* -------------------------------------------------------------- números */
const num = v => Number(v) || 0;

/* Na grade o que importa é a ordem de grandeza, não o centavo: milhões com
   centavo viram um borrão. O valor exato fica no title da célula. */
function fmtGrade(v){
  const n = num(v);
  if (!n) return '';
  const abs = Math.abs(n);
  const casas = abs < 100 ? 2 : 0;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}
const fmtExato = v => num(v).toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 });

function fmtData(iso){
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (m[3] + '/' + m[2] + '/' + m[1]) : String(iso || '');
}
const MESES = ['janeiro','fevereiro','março','abril','maio','junho',
               'julho','agosto','setembro','outubro','novembro','dezembro'];
const DOW = ['dom','seg','ter','qua','qui','sex','sáb'];
function maiuscula(t){ return t.charAt(0).toUpperCase() + t.slice(1); }
function nomeMes(mes){
  const p = String(mes).split('-');
  return maiuscula(MESES[(+p[1]) - 1]) + ' de ' + p[0];
}
function mesAtual(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function addMes(mes, n){
  const p = String(mes).split('-');
  const d = new Date(+p[0], (+p[1]) - 1 + n, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
/* Aceita 1.234,56 e 1234.56 — quem digita vem do Excel e do banco. */
function parseValor(txt){
  let s = String(txt == null ? '' : txt).trim().replace(/R\$\s*/i, '').replace(/\s/g, '');
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.charAt(0) === '-';
  s = s.replace(/[()\-]/g, '');
  if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return neg ? -n : n;
}

/* ------------------------------------------------------------- estado */
const state = {
  mes: mesAtual(),
  dados: null,
  calc: null,
  soUteis: true,        // dia sem movimento nem saldo fica escondido
  recolhidos: {},       // grupos fechados
  autor: '',
  podeEditar: false,
  edicao: null,
};

/* ------------------------------------------------ veio pelo hub? ------
   Mesma regra das outras ferramentas: quem abre o link direto vê, mas não
   digita. Editar é para quem entrou pelo hub. */
const HubLink = {
  HUB: '/Controladoria',
  SELF: '/Controladoria/Fluxo',
  KEY: 'came_from_hub_fluxo',
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
      const n = el('btn-hub'); if (n) n.hidden = false;
    }
    return ok;
  },
};

function pedirAutor(){
  if (state.autor) return state.autor;
  try { state.autor = sessionStorage.getItem('fluxo_autor') || ''; } catch(e){}
  if (state.autor) return state.autor;
  const nome = (prompt('Seu nome, para ficar registrado no lançamento:') || '').trim();
  if (!nome) return '';
  state.autor = nome;
  try { sessionStorage.setItem('fluxo_autor', nome); } catch(e){}
  return nome;
}

/* ------------------------------------------------------------- rede --- */
async function buscarJson(url){
  let erro;
  for (let i = 1; i <= CONFIG.RETRIES; i++){
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

async function gravar(payload, textoOk){
  try {
    await fetch(CONFIG.DATA_URL, {
      method:'POST', mode:'no-cors',
      headers:{ 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
    toast(textoOk || 'Salvo.');
    return true;
  } catch(e){
    toast('Erro ao salvar: ' + (e.message || e), true);
    return false;
  }
}

/* ============================================================================
   CARGA
   ============================================================================ */
function etapaLoader(texto, pct){
  const t = el('load-text'), f = el('load-barra-fill'), p = el('load-pct');
  if (t) t.textContent = texto;
  if (f) f.style.width = pct + '%';
  if (p) p.textContent = pct + '%';
  const fio = el('fio'), ff = el('fio-fill');
  if (fio && ff){ fio.classList.toggle('ativo', pct < 100); ff.style.width = pct + '%'; }
}
const respira = ms => new Promise(r => setTimeout(r, ms));

async function carregar(primeira){
  etapaLoader(primeira ? 'Lendo o fluxo…' : 'Atualizando…', 14);
  try {
    const url = CONFIG.DATA_URL + (CONFIG.DATA_URL.indexOf('?') >= 0 ? '&' : '?') +
                'fluxo=' + state.mes + '&v=' + Date.now();
    const d = await buscarJson(url);
    if (!d || d.ok === false) throw new Error((d && d.erro) || 'resposta vazia');
    state.dados = d;

    etapaLoader('Somando o mês…', 66);
    await respira(50);
    calcular();

    etapaLoader('Montando a tabela…', 88);
    await respira(50);
    render();

    etapaLoader('Pronto', 100);
    await respira(150);
    esconderLoader();
  } catch(e){
    mostrarErro(e);
  }
}

function esconderLoader(){
  const l = el('loader');
  l.classList.add('out');
  setTimeout(() => { l.style.display = 'none'; }, 360);
}
function abrirLoader(texto){
  const l = el('loader');
  etapaLoader(texto || 'Carregando…', 10);
  l.style.display = 'flex';
  l.classList.remove('out');
}
function mostrarErro(e){
  const l = el('loader');
  l.classList.remove('out');
  l.style.display = 'flex';
  l.innerHTML = '';
  l.appendChild(h('div', { class:'load-text', style:'color:var(--danger);font-weight:700',
    text:'Não consegui carregar o fluxo.' }));
  l.appendChild(h('div', { class:'load-text', style:'max-width:380px;text-align:center;color:var(--muted)',
    text: String(e && e.message || e) }));
  const b = h('button', { class:'btn btn-primary' }, [icone('fa-rotate'), 'Tentar de novo']);
  b.onclick = () => location.reload();
  l.appendChild(b);
}

/* ============================================================================
   CÁLCULO
   ----------------------------------------------------------------------------
   Tudo é somado uma vez, aqui, e a tela só desenha. Isso mantém a rolagem
   leve mesmo com trinta e uma colunas na tela.
   ============================================================================ */
function calcular(){
  const d = state.dados;
  const dias = d.dias.map(x => x.data);
  const plano = d.plano;
  const porId = {};
  plano.forEach(l => { porId[l.id] = l; });

  const filhos = {};
  plano.forEach(l => { if (l.pai) (filhos[l.pai] = filhos[l.pai] || []).push(l.id); });

  /* valores de cada linha folha, dia a dia */
  const val = {};
  const ver = (id, data) => (val[id] && val[id][data]) || 0;
  const põe = (id, data, v) => {
    if (!val[id]) val[id] = {};
    val[id][data] = (val[id][data] || 0) + v;
  };

  // digitado
  const lancPorCel = {};
  (d.lancamentos || []).forEach(l => {
    põe(l.linha_id, l.data, num(l.valor));
    const k = l.linha_id + '|' + l.data;
    (lancPorCel[k] = lancPorCel[k] || []).push(l);
  });

  /* Realizado até ontem, previsto de hoje em diante: o pagamento de hoje só
     aparece no relatório de baixas amanhã, então usar realizado no dia
     corrente mostraria o dia vazio. */
  const hoje = d.hoje;
  const qtdPorCel = {}, previstoCel = {};
  const prev = {};
  (d.previsto || []).forEach(r => {
    if (!r.linha_id || r.data < hoje) return;
    prev[r.linha_id + '|' + r.data] = num(r.valor);
  });
  (d.realizado || []).forEach(r => {
    const k = r.linha_id + '|' + r.data;
    if (!r.linha_id) return;
    if (r.data >= hoje && k in prev) return;   // o previsto já responde por este dia
    põe(r.linha_id, r.data, num(r.valor));
    qtdPorCel[k] = num(r.qtd);
  });
  Object.keys(prev).forEach(k => {
    const p = k.split('|');
    põe(p[0], p[1], prev[k]);
    previstoCel[k] = true;
  });

  /* grupos somam os filhos, de baixo para cima */
  const somaGrupo = (id, data) => {
    const fs = filhos[id];
    if (!fs) return ver(id, data);
    let s = 0;
    fs.forEach(f => { s += (porId[f].tipo === 'grupo') ? somaGrupo(f, data) : ver(f, data); });
    return s;
  };
  plano.forEach(l => {
    if (l.tipo !== 'grupo') return;
    dias.forEach(data => {
      const s = somaGrupo(l.id, data);
      if (s){ if (!val[l.id]) val[l.id] = {}; val[l.id][data] = s; }
    });
  });

  /* totais, saldos e a conta do dia */
  const raizes = plano.filter(l => !l.pai);
  const totEnt = {}, totSai = {}, sdIni = {}, sdFim = {};
  let saldo = num(d.abertura);
  dias.forEach(data => {
    let e = 0, s = 0;
    raizes.forEach(l => {
      const v = ver(l.id, data);
      if (!v) return;
      if (l.secao === 'E') e += v; else s += v;
    });
    totEnt[data] = e; totSai[data] = s;
    sdIni[data] = saldo;
    saldo = saldo + e - s;
    sdFim[data] = saldo;
  });

  /* posição de saldos: o que foi informado, por conta e por dia */
  const contas = d.contas;
  const contaPorId = {};
  contas.forEach(c => { contaPorId[c.id] = c; });
  const filhosConta = {};
  contas.forEach(c => { if (c.pai) (filhosConta[c.pai] = filhosConta[c.pai] || []).push(c.id); });

  const sal = {};
  const temSaldo = {};
  (d.saldos || []).forEach(s => {
    if (!sal[s.conta_id]) sal[s.conta_id] = {};
    sal[s.conta_id][s.data] = num(s.valor);
    temSaldo[s.data] = true;
  });
  contas.forEach(c => {
    if (c.tipo !== 'grupo') return;
    const fs = filhosConta[c.id] || [];
    dias.forEach(data => {
      let s = 0, achou = false;
      fs.forEach(f => {
        const v = sal[f] && sal[f][data];
        if (v !== undefined){ s += v; achou = true; }
      });
      if (achou){ if (!sal[c.id]) sal[c.id] = {}; sal[c.id][data] = s; }
    });
  });

  const empresas = [];
  contas.forEach(c => { if (empresas.indexOf(c.empresa) < 0) empresas.push(c.empresa); });
  const totEmpresa = {}, totBancos = {}, disponivel = {};
  empresas.forEach(emp => { totEmpresa[emp] = {}; });
  dias.forEach(data => {
    let geral = 0, livre = 0;
    empresas.forEach(emp => {
      let t = 0;
      contas.forEach(c => {
        if (c.empresa !== emp || c.tipo !== 'conta') return;
        const v = (sal[c.id] && sal[c.id][data]) || 0;
        t += v;
        if (String(c.disponivel).toLowerCase() === 'sim') livre += v;
      });
      totEmpresa[emp][data] = t;
      geral += t;
    });
    totBancos[data] = geral;
    disponivel[data] = livre;
  });

  /* A diferença é o alarme: bancos menos saldo calculado. Só faz sentido no
     dia em que alguém informou os saldos. */
  const dif = {}, cobertura = {};
  dias.forEach(data => {
    if (!temSaldo[data]) return;
    dif[data] = totBancos[data] - sdFim[data];
    cobertura[data] = disponivel[data] - totSai[data];
  });

  state.calc = {
    dias, val, filhos, porId, totEnt, totSai, sdIni, sdFim,
    sal, temSaldo, contaPorId, filhosConta, empresas, totEmpresa, totBancos,
    disponivel, dif, cobertura, lancPorCel, qtdPorCel, previstoCel, hoje,
  };
}

/* Colunas que aparecem: dia útil sempre; fim de semana e feriado só quando
   tiveram movimento ou saldo informado — senão a tabela vira um deserto. */
function diasVisiveis(){
  const c = state.calc, d = state.dados;
  if (!state.soUteis) return d.dias;
  return d.dias.filter(x =>
    x.util || c.totEnt[x.data] || c.totSai[x.data] || c.temSaldo[x.data]);
}

/* ============================================================================
   RENDER
   ============================================================================ */
function render(){
  renderStamp();
  const c = el('content');
  c.innerHTML = '';
  c.appendChild(barraMes());
  c.appendChild(secaoTabela());
}

function renderStamp(){
  const d = state.dados || {};
  const dot = el('stamp').querySelector('.dot');
  const txt = el('stamp-text');
  if (!d.gerado_em){ dot.className = 'dot off'; txt.textContent = 'sem dados'; return; }
  dot.className = 'dot';
  txt.textContent = 'fluxo de ' + fmtData(d.hoje);
}

function barraMes(){
  const d = state.dados, c = state.calc;
  const sec = h('div', { class:'section barra-mes' });

  const nav = h('div', { class:'mes-nav' });
  const ant = h('button', { class:'btn btn-ghost btn-sm', type:'button', title:'Mês anterior' }, [icone('fa-chevron-left')]);
  ant.onclick = () => irPara(addMes(state.mes, -1));
  const prox = h('button', { class:'btn btn-ghost btn-sm', type:'button', title:'Próximo mês' }, [icone('fa-chevron-right')]);
  prox.onclick = () => irPara(addMes(state.mes, 1));
  const sel = h('select', { class:'filtro' });
  const meses = (d.meses || []).slice();
  if (meses.indexOf(state.mes) < 0) meses.push(state.mes);
  meses.sort().forEach(m => sel.appendChild(h('option', { value:m, text:nomeMes(m), selected: m === state.mes })));
  sel.onchange = e => irPara(e.target.value);

  nav.appendChild(ant);
  nav.appendChild(sel);
  nav.appendChild(prox);

  const ultimo = c.dias[c.dias.length - 1];
  const resumo = h('div', { class:'mes-resumo' }, [
    kpi('Saldo inicial', c.sdIni[c.dias[0]], 'info'),
    kpi('Entradas', somaMes(c.totEnt), 'ok'),
    kpi('Saídas', somaMes(c.totSai), 'orange'),
    kpi('Saldo final', c.sdFim[ultimo], 'plum'),
  ]);

  sec.appendChild(nav);
  sec.appendChild(resumo);
  return sec;
}
function somaMes(mapa){
  return state.calc.dias.reduce((s, d) => s + num(mapa[d]), 0);
}
function kpi(rotulo, valor, classe){
  return h('div', { class:'mini-kpi ' + (classe || '') }, [
    h('span', { class:'mk-label', text:rotulo }),
    h('span', { class:'mk-valor', text:'R$ ' + (fmtGrade(valor) || '0'), title:'R$ ' + fmtExato(valor) }),
  ]);
}

function irPara(mes){
  state.mes = mes;
  abrirLoader('Abrindo ' + nomeMes(mes) + '…');
  carregar();
}

/* --------------------------------------------------------------- tabela */
function secaoTabela(){
  const d = state.dados, c = state.calc;
  const dias = diasVisiveis();
  const sec = h('div', { class:'section' });
  const card = h('div', { class:'card' });

  const legenda = h('div', { class:'card-bar' }, [
    h('div', { class:'card-bar-title' }, [ icone('fa-table-columns'), nomeMes(state.mes) ]),
    h('div', { class:'legenda' }, [
      h('span', {}, [ h('i', { class:'leg leg-real' }), 'realizado' ]),
      h('span', {}, [ h('i', { class:'leg leg-prev' }), 'previsto' ]),
      h('span', {}, [ h('i', { class:'leg leg-edit' }), 'digitado' ]),
      state.podeEditar ? h('span', { class:'leg-dica' }, [ icone('fa-hand-pointer'), 'clique numa célula para ver ou lançar' ])
                       : h('span', { class:'leg-dica' }, [ icone('fa-eye'), 'somente leitura — entre pelo hub para lançar' ]),
    ]),
  ]);
  card.appendChild(legenda);

  const wrap = h('div', { class:'grade-wrap' });
  const tbl = h('table', { class:'grade' });

  /* cabeçalho: cada coluna é um dia */
  const thead = h('thead');
  const tr = h('tr');
  tr.appendChild(h('th', { class:'col-nome', text:'Descrição' }));
  dias.forEach(x => {
    const p = x.data.split('-');
    const th = h('th', { class:'col-dia' + (x.util ? '' : ' nao-util') + (x.data === c.hoje ? ' hoje' : ''),
                         title: x.feriado || '' }, [
      h('span', { class:'d-num', text: p[2] + '/' + p[1] }),
      h('span', { class:'d-dow', text: x.feriado ? 'feriado' : DOW[x.dow] }),
    ]);
    tr.appendChild(th);
  });
  tr.appendChild(h('th', { class:'col-total', text:'Total do mês' }));
  thead.appendChild(tr);
  tbl.appendChild(thead);

  const tbody = h('tbody');
  linhasDaTela().forEach(l => tbody.appendChild(linhaTr(l, dias)));
  tbl.appendChild(tbody);

  wrap.appendChild(tbl);
  card.appendChild(wrap);
  sec.appendChild(card);
  return sec;
}

/* A ordem da tela é a ordem da planilha que a equipe já conhece: saldo
   inicial, entradas, saídas, saldo final, posição de saldos, conferência. */
function linhasDaTela(){
  const d = state.dados, c = state.calc;
  const L = [];

  L.push({ kind:'saldo-ini', label:'Saldo Inicial', get: dia => c.sdIni[dia] });
  L.push({ kind:'espaco' });

  L.push({ kind:'total', label:'Total Entradas', classe:'t-ent', get: dia => c.totEnt[dia] });
  d.plano.filter(l => l.secao === 'E').forEach(l => empilhar(L, l));

  L.push({ kind:'espaco' });
  L.push({ kind:'total', label:'Total Saídas', classe:'t-sai', get: dia => c.totSai[dia] });
  d.plano.filter(l => l.secao === 'S').forEach(l => empilhar(L, l));

  L.push({ kind:'espaco' });
  L.push({ kind:'saldo-fim', label:'Saldo Final', get: dia => c.sdFim[dia] });

  /* posição de saldos, uma empresa por bloco */
  c.empresas.forEach(emp => {
    L.push({ kind:'espaco' });
    L.push({ kind:'cabec-saldo', label:'Posição de saldos · ' + emp });
    d.contas.filter(x => x.empresa === emp).forEach(x => {
      L.push({ kind: x.tipo === 'grupo' ? 'saldo-grupo' : 'saldo-conta',
               conta: x, label: x.descricao,
               get: dia => (c.sal[x.id] && c.sal[x.id][dia]) });
    });
    L.push({ kind:'saldo-total', label:'Total ' + emp, get: dia => c.temSaldo[dia] ? c.totEmpresa[emp][dia] : undefined });
  });

  L.push({ kind:'espaco' });
  L.push({ kind:'bancos', label:'Total nos bancos', get: dia => c.temSaldo[dia] ? c.totBancos[dia] : undefined });
  L.push({ kind:'dif', label:'Diferença', get: dia => c.dif[dia] });
  L.push({ kind:'cobertura', label:'Disponível menos as saídas do dia', get: dia => c.cobertura[dia] });
  return L;
}

/* Empilha uma linha do plano respeitando os grupos fechados. */
function empilhar(L, l){
  if (l.pai && paiFechado(l.pai)) return;
  const c = state.calc;
  L.push({
    kind: l.tipo === 'grupo' ? 'grupo' : 'linha',
    linha: l, label: l.descricao, codigo: l.codigo,
    nivel: nivelDe(l),
    get: dia => (c.val[l.id] && c.val[l.id][dia]),
  });
}
function nivelDe(l){
  let n = 0, p = l.pai;
  while (p && state.calc.porId[p]){ n++; p = state.calc.porId[p].pai; }
  return n;
}
function paiFechado(id){
  let p = id;
  while (p){
    if (state.recolhidos[p]) return true;
    p = state.calc.porId[p] ? state.calc.porId[p].pai : '';
  }
  return false;
}

function linhaTr(l, dias){
  const c = state.calc;
  if (l.kind === 'espaco'){
    const tr = h('tr', { class:'l-espaco' });
    tr.appendChild(h('td', { colspan: dias.length + 2 }));
    return tr;
  }

  const tr = h('tr', { class:'l-' + l.kind + (l.nivel ? ' nivel-' + l.nivel : '') });
  const pegar = l.get || (() => undefined);

  /* nome da linha, com o código e o triângulo de recolher */
  const nome = h('td', { class:'col-nome' });
  const box = h('div', { class:'nome-box' });
  if (l.kind === 'grupo'){
    const fechado = !!state.recolhidos[l.linha.id];
    const b = h('button', { class:'toggle', type:'button', title: fechado ? 'abrir' : 'fechar' },
      [ icone(fechado ? 'fa-chevron-right' : 'fa-chevron-down') ]);
    b.onclick = () => {
      state.recolhidos[l.linha.id] = !fechado;
      render();
    };
    box.appendChild(b);
  }
  if (l.codigo) box.appendChild(h('span', { class:'cod', text: l.codigo }));
  box.appendChild(h('span', { class:'txt', text: l.label }));
  nome.appendChild(box);
  tr.appendChild(nome);

  let total = 0;
  dias.forEach(x => {
    const v = pegar(x.data);
    if (v !== undefined && v !== null) total += num(v);
    tr.appendChild(celula(l, x, v));
  });

  /* Total do mês: soma nas linhas de movimento; nas de saldo, a última foto. */
  let tv = total;
  if (l.kind === 'saldo-ini') tv = c.sdIni[dias[0] ? dias[0].data : c.dias[0]];
  else if (l.kind === 'cobertura') tv = undefined;
  else if (l.kind === 'saldo-fim' || l.kind === 'bancos' || l.kind === 'dif' ||
           l.kind === 'saldo-conta' || l.kind === 'saldo-grupo' ||
           l.kind === 'saldo-total'){
    tv = undefined;
    for (let i = dias.length - 1; i >= 0; i--){
      const v = pegar(dias[i].data);
      if (v !== undefined && v !== null){ tv = v; break; }
    }
  }
  const tdTot = h('td', { class:'col-total num' + classeValor(l, tv) });
  tdTot.textContent = (tv === undefined || tv === null) ? '' : fmtGrade(tv);
  if (tv) tdTot.title = 'R$ ' + fmtExato(tv);
  tr.appendChild(tdTot);
  return tr;
}

function classeValor(l, v){
  if (l.kind !== 'dif' && l.kind !== 'cobertura') return '';
  if (v === undefined || v === null) return '';
  if (l.kind === 'dif') return Math.abs(num(v)) < 0.01 ? ' v-ok' : ' v-alerta';
  return num(v) >= 0 ? ' v-ok' : ' v-alerta';
}

function celula(l, dia, v){
  const c = state.calc;
  const cls = ['num'];
  if (!dia.util) cls.push('nao-util');
  if (dia.data === c.hoje) cls.push('hoje');
  cls.push(classeValor(l, v).trim());

  const editavel = state.podeEditar &&
    ((l.kind === 'linha' && l.linha.modo === 'manual') ||
     l.kind === 'saldo-conta' || l.kind === 'saldo-grupo' || l.kind === 'cabec-saldo');
  const detalhavel = (l.kind === 'linha' && l.linha.modo === 'auto' && num(v)) ||
                     (l.kind === 'linha' && l.linha.modo === 'manual' && num(v));

  const previsto = l.linha && c.previstoCel[l.linha.id + '|' + dia.data];
  if (previsto) cls.push('previsto');
  if (editavel) cls.push('editavel');
  if (detalhavel) cls.push('detalhe');

  const td = h('td', { class: cls.filter(Boolean).join(' ') });
  td.textContent = (v === undefined || v === null) ? '' : fmtGrade(v);
  if (num(v)){
    const q = l.linha && c.qtdPorCel[l.linha.id + '|' + dia.data];
    td.title = 'R$ ' + fmtExato(v) + (q ? ('  ·  ' + q + ' título(s)') : '') +
               (previsto ? '  ·  previsto' : '');
  }

  if (editavel || detalhavel){
    td.onclick = () => abrirCelula(l, dia, v);
  }
  return td;
}

/* ============================================================================
   CLIQUE NA CÉLULA
   ============================================================================ */
function abrirCelula(l, dia, v){
  if (l.kind === 'saldo-conta' || l.kind === 'saldo-grupo' || l.kind === 'cabec-saldo'){
    return abrirSaldos(dia.data);
  }
  if (l.linha.modo === 'auto') return abrirDetalheTitulos(l, dia);
  return abrirLancamentos(l, dia);
}

/* --- o que forma o número: os títulos daquele dia e daquela conta --- */
async function abrirDetalheTitulos(l, dia){
  el('det-titulo').textContent = l.label;
  el('det-sub').textContent = fmtData(dia.data) + ' · carregando…';
  el('det-corpo').innerHTML = '';
  mostrarModal('modal-detalhe');

  if (dia.data >= state.calc.hoje){
    el('det-sub').textContent = fmtData(dia.data) + ' · previsto, ainda não pago';
    el('det-corpo').appendChild(h('div', { class:'empty' }, [
      icone('fa-clock'),
      'Este valor é previsão: são títulos em aberto com vencimento neste dia. ' +
      'O detalhe título a título está no painel de pagamentos.',
    ]));
    return;
  }

  try {
    const url = CONFIG.DATA_URL + '?fluxo_detalhe=' + dia.data +
                '&conta=' + encodeURIComponent(l.linha.codigo) + '&v=' + Date.now();
    const r = await buscarJson(url);
    if (!r || !r.ok) throw new Error((r && r.erro) || 'sem resposta');
    el('det-sub').textContent = fmtData(dia.data) + ' · ' + r.linhas.length +
      ' título(s) · R$ ' + fmtExato(r.total);
    const corpo = el('det-corpo');
    corpo.innerHTML = '';
    if (!r.linhas.length){
      corpo.appendChild(h('div', { class:'empty' }, [ icone('fa-inbox'), 'Nada neste dia.' ]));
      return;
    }
    const tbl = h('table', { class:'tabela-simples' }, [
      h('thead', {}, [ h('tr', {}, [
        h('th', { text:'Número' }), h('th', { text:'Favorecido' }),
        h('th', { text:'Baixa' }), h('th', { class:'num', text:'Valor' }),
      ])]),
    ]);
    const tb = h('tbody');
    r.linhas.forEach(x => {
      tb.appendChild(h('tr', {}, [
        h('td', { class:'mono', text: x.numero || '—' }),
        h('td', {}, [ h('div', { class:'forn' }, [
          x.fornecedor || '—',
          h('small', { text: String(x.historico || '').slice(0, 60) }),
        ])]),
        h('td', { class:'mono', text: fmtData(x.dt_baixa) }),
        h('td', { class:'num', text: fmtExato(x.valor) }),
      ]));
    });
    tbl.appendChild(tb);
    corpo.appendChild(tbl);
  } catch(e){
    el('det-sub').textContent = 'não consegui carregar o detalhe';
    el('det-corpo').appendChild(h('div', { class:'note danger', text: String(e.message || e) }));
  }
}

/* --- linhas digitadas: um dia pode ter mais de um lançamento --- */
function abrirLancamentos(l, dia){
  const lista = state.calc.lancPorCel[l.linha.id + '|' + dia.data] || [];
  if (!state.podeEditar && !lista.length) return;
  if (lista.length > 1 || (!state.podeEditar && lista.length)){
    el('det-titulo').textContent = l.label;
    el('det-sub').textContent = fmtData(dia.data) + ' · ' + lista.length + ' lançamentos';
    const corpo = el('det-corpo');
    corpo.innerHTML = '';
    lista.forEach(x => {
      const b = h('button', { class:'lanc-item', type:'button' }, [
        h('span', { class:'li-val', text:'R$ ' + fmtExato(x.valor) }),
        h('span', { class:'li-desc', text: x.descricao || 'sem observação' }),
        h('span', { class:'li-quem', text: (x.autor || '') + (x.quando ? (' · ' + x.quando.slice(0,10).split('-').reverse().join('/')) : '') }),
      ]);
      b.onclick = () => { fecharModal('modal-detalhe'); editarLancamento(l, dia, x); };
      corpo.appendChild(b);
    });
    if (state.podeEditar){
      const novo = h('button', { class:'btn btn-ghost btn-sm', type:'button', style:'margin-top:12px' },
        [ icone('fa-plus'), 'Novo lançamento neste dia' ]);
      novo.onclick = () => { fecharModal('modal-detalhe'); editarLancamento(l, dia, null); };
      corpo.appendChild(novo);
    }
    mostrarModal('modal-detalhe');
    return;
  }
  editarLancamento(l, dia, lista[0] || null);
}

function editarLancamento(l, dia, lanc){
  if (!state.podeEditar) return;
  if (!pedirAutor()){ toast('Preciso do seu nome para registrar o lançamento.', true); return; }
  state.edicao = { linha: l.linha, data: dia.data, lanc: lanc };
  el('lanc-titulo').textContent = l.label;
  el('lanc-sub').textContent = fmtData(dia.data) +
    (l.linha.secao === 'E' ? ' · entrada' : ' · saída');
  el('lanc-valor').value = lanc ? fmtExato(lanc.valor) : '';
  el('lanc-desc').value = lanc ? (lanc.descricao || '') : '';
  el('lanc-excluir').hidden = !lanc;
  const nota = el('lanc-nota');
  if (lanc && lanc.autor){
    nota.hidden = false;
    nota.textContent = 'lançado por ' + lanc.autor +
      (lanc.quando ? (' em ' + lanc.quando.slice(0,10).split('-').reverse().join('/')) : '');
  } else nota.hidden = true;
  mostrarModal('modal-lanc');
  setTimeout(() => el('lanc-valor').focus(), 60);
}

async function salvarLancamento(){
  const e = state.edicao;
  if (!e) return;
  const v = parseValor(el('lanc-valor').value);
  if (v === null){ toast('Valor inválido.', true); return; }
  const payload = {
    acao: 'fluxo_lancamento',
    lancamento: {
      id: e.lanc ? e.lanc.id : '',
      data: e.data, linha_id: e.linha.id, valor: v,
      descricao: el('lanc-desc').value, autor: state.autor,
    },
  };
  fecharModal('modal-lanc');
  if (await gravar(payload, 'Lançamento salvo.')) recarregarDepois();
}

async function excluirLancamento(){
  const e = state.edicao;
  if (!e || !e.lanc) return;
  fecharModal('modal-lanc');
  if (await gravar({ acao:'fluxo_excluir', id: e.lanc.id }, 'Lançamento excluído.')) recarregarDepois();
}

/* O Apps Script responde sem corpo (no-cors), então esperamos um instante
   antes de reler — é o mesmo compasso da tela de envio do painel. */
function recarregarDepois(){
  abrirLoader('Salvando…');
  setTimeout(() => carregar(), 1500);
}

/* --- posição de saldos do dia: todas as contas de uma vez --- */
function abrirSaldos(data){
  if (!state.podeEditar) return;
  if (!pedirAutor()){ toast('Preciso do seu nome para registrar os saldos.', true); return; }
  const c = state.calc, d = state.dados;
  el('sal-titulo').textContent = 'Posição de saldos';
  el('sal-sub').textContent = fmtData(data) + ' · informe o saldo de cada conta';
  const corpo = el('sal-corpo');
  corpo.innerHTML = '';
  state.edicao = { saldosData: data };

  const atualizarTotal = () => {
    let t = 0;
    corpo.querySelectorAll('input[data-conta]').forEach(i => { t += parseValor(i.value) || 0; });
    el('sal-total').textContent = 'Total: R$ ' + fmtExato(t) +
      '  ·  saldo calculado: R$ ' + fmtExato(c.sdFim[data]) +
      '  ·  diferença: R$ ' + fmtExato(t - c.sdFim[data]);
    el('sal-total').className = 'sal-total' + (Math.abs(t - c.sdFim[data]) < 0.01 ? ' ok' : ' alerta');
  };

  c.empresas.forEach(emp => {
    corpo.appendChild(h('div', { class:'sal-emp', text: emp }));
    d.contas.filter(x => x.empresa === emp && x.tipo === 'conta').forEach(x => {
      const v = c.sal[x.id] && c.sal[x.id][data];
      const inp = h('input', { type:'text', inputmode:'decimal', 'data-conta': x.id,
                               value: (v === undefined || v === null) ? '' : fmtExato(v) });
      inp.oninput = atualizarTotal;
      corpo.appendChild(h('div', { class:'sal-linha' }, [
        h('label', { text: x.descricao }),
        inp,
      ]));
    });
  });
  atualizarTotal();
  mostrarModal('modal-saldos');
}

async function salvarSaldos(){
  const data = state.edicao && state.edicao.saldosData;
  if (!data) return;
  const saldos = [];
  el('sal-corpo').querySelectorAll('input[data-conta]').forEach(i => {
    const v = parseValor(i.value);
    if (v !== null) saldos.push({ conta_id: i.getAttribute('data-conta'), valor: v });
  });
  fecharModal('modal-saldos');
  if (await gravar({ acao:'fluxo_saldo', data: data, saldos: saldos, autor: state.autor },
                   'Saldos do dia salvos.')) recarregarDepois();
}

/* ---------------------------------------------------------------- modais */
function mostrarModal(id){ el(id).classList.add('show'); }
function fecharModal(id){ el(id).classList.remove('show'); }

/* ============================================================================
   EXPORTAÇÃO — mesmo desenho da planilha que a equipe já usa
   ============================================================================ */
function exportar(){
  if (typeof XLSX === 'undefined'){ toast('Biblioteca de planilha carregando…', true); return; }
  const c = state.calc, dias = diasVisiveis();
  const aoa = [];
  aoa.push(['ON TIME', 'Fluxo de Caixa · ' + nomeMes(state.mes)]);
  aoa.push([]);
  aoa.push(['', 'Descrição'].concat(dias.map(x => new Date(x.data + 'T12:00:00'))).concat(['Total do mês']));

  const linhas = linhasDaTela();
  linhas.forEach(l => {
    if (l.kind === 'espaco'){ aoa.push([]); return; }
    const cod = l.codigo || '';
    const nome = (l.nivel ? '   '.repeat(l.nivel) : '') + l.label;
    const pegar = l.get || (() => undefined);
    const vals = dias.map(x => {
      const v = pegar(x.data);
      return (v === undefined || v === null) ? '' : Math.round(num(v) * 100) / 100;
    });
    let tot = vals.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    if (l.kind !== 'linha' && l.kind !== 'grupo' && l.kind !== 'total'){
      tot = '';
      for (let i = vals.length - 1; i >= 0; i--){ if (typeof vals[i] === 'number'){ tot = vals[i]; break; } }
    }
    aoa.push([cod, nome].concat(vals).concat([tot]));
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates:true });
  ws['!cols'] = [{ wch:11 }, { wch:34 }].concat(dias.map(() => ({ wch:13 }))).concat([{ wch:15 }]);

  const FMT = '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-';
  const total = aoa.length, cols = 2 + dias.length + 1;
  for (let r = 3; r < total; r++){
    for (let cc = 2; cc < cols; cc++){
      const addr = XLSX.utils.encode_cell({ r: r, c: cc });
      if (ws[addr]) ws[addr].z = FMT;
    }
  }
  dias.forEach((x, i) => {
    const addr = XLSX.utils.encode_cell({ r: 2, c: 2 + i });
    if (ws[addr]) ws[addr].z = 'dd/mm';
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Fluxo ' + state.mes);
  XLSX.writeFile(wb, 'fluxo-de-caixa-' + state.mes + '.xlsx');
  toast('Planilha gerada.');
}

/* ============================================================================
   INÍCIO
   ============================================================================ */
document.addEventListener('DOMContentLoaded', () => {
  state.podeEditar = HubLink.init();

  const dt = new Date();
  el('headerData').textContent = maiuscula(dt.toLocaleDateString('pt-BR',
    { weekday:'long', day:'numeric', month:'long' }));

  el('btnRecarregar').onclick = () => { abrirLoader('Atualizando…'); carregar(); };
  el('btnExportar').onclick = exportar;
  el('btnDias').onclick = () => {
    state.soUteis = !state.soUteis;
    el('btnDias').querySelector('span').textContent = state.soUteis ? 'Dias úteis' : 'Todos os dias';
    render();
  };
  el('lanc-salvar').onclick = salvarLancamento;
  el('lanc-excluir').onclick = excluirLancamento;
  el('sal-salvar').onclick = salvarSaldos;
  document.querySelectorAll('[data-fechar]').forEach(b => {
    b.onclick = () => fecharModal(b.getAttribute('data-fechar'));
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show'));
    if (e.key === 'Enter' && el('modal-lanc').classList.contains('show')) salvarLancamento();
  });
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); });
  });

  try {
    const p = new URLSearchParams(location.search).get('mes');
    if (p && /^\d{4}-\d{2}$/.test(p)) state.mes = p;
  } catch(e){}

  carregar(true);
});
