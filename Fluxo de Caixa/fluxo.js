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

/* ============================================================================
   QUAL BASE ESTA CÓPIA USA
   ----------------------------------------------------------------------------
   Não é uma linha que alguém precisa lembrar de trocar: quem decide é o
   endereço em que a página está rodando. Pasta com "teste" no nome fala com o
   script de teste; qualquer outra fala com produção.

   Assim os arquivos são idênticos nos dois lugares, e copiar a pasta de teste
   por cima da de produção não troca a base sem querer — o endereço muda, o
   comportamento muda junto.

   ATENÇÃO — o que mudou aqui, e por quê.

   Antes existiam duas URLs e a escolha entre elas era feita pelo nome da
   pasta: com "teste" no caminho, usava a URL declarada no index.html; sem
   "teste", usava a que estava escrita como produção. A ideia era boa, mas a
   URL escrita como produção era a do PAGAMENTOS — copiada junto quando esta
   ferramenta nasceu a partir dali.

   Isso virou uma armadilha: renomear a pasta de "Fluxo-teste" para "Fluxo de
   Caixa" faria o fluxo passar a falar com o script do Pagamentos, que exige
   senha e não conhece as ações de fluxo. Como o envio é no-cors e não lê a
   resposta, a tela continuaria dizendo "Salvo." e nada seria gravado.

   Agora é uma URL só, escrita num lugar só. O nome da pasta deixou de ter
   efeito sobre o comportamento: renomear é só renomear.
   ============================================================================ */
const URL_BASE = 'https://script.google.com/macros/s/AKfycbxXdtGsm_3aDGqo52LTXjQ4CJu_zuXdivRfS9dnb6B8TYhyWY_E_rFvNYxrxO5BIfRIfA/exec';

const CONFIG = {
  DATA_URL: URL_BASE,
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

/* Duas leituras do mesmo número. Na compacta, milhões sem centavo, para caber
   mais dias na tela. Na exata, tudo com as duas casas, que é como se confere
   caixa. O botão no alto troca uma pela outra, e a escolha fica guardada.
   Sem "R$": a tela inteira é dinheiro, repetir o símbolo em cada célula só
   rouba espaço de dígito. */
function fmtNum(v){
  if (v === undefined || v === null || v === '') return '';
  const n = num(v);
  if (!n) return '–';                      // zero contábil
  const casas = state.exato ? 2 : (Math.abs(n) < 100 ? 2 : 0);
  return n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}
const fmtGrade = fmtNum;
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
  exato: false,         // centavos à mostra
  recolhidos: {},       // grupos fechados
  autor: '',
  primeiraPintura: true,
  podeEditar: false,
  chave: '',                  // senha de gravação, guardada só nesta sessão
  edicao: null,
  cache: {},            // meses já abertos nesta sessão
};

/* ------------------------------------------------ veio pelo hub? ------
   Mesma regra das outras ferramentas: quem abre o link direto vê, mas não
   digita. Editar é para quem entrou pelo hub. */
const HubLink = {
  KEY: 'came_from_hub_fluxo',

  /* A pasta desta ferramenta, seja qual for o endereço em que ela esteja:
     /Fluxo de Caixa/ no domínio do hub, /Controladoria/Fluxo/ no GitHub Pages.
     Descobrir em vez de fixar é o que faz isto continuar certo quando o
     endereço muda — foi exatamente assim que quebrou quando o hub saiu do
     github.io e passou a morar na raiz de hub.ontimelogistica.com.br. */
  pasta(){
    return location.pathname.replace(/[^/]*$/, '');
  },

  veioDoHub(){
    try {
      if (document.referrer){
        const ref = new URL(document.referrer);
        /* Mesma origem e de fora desta pasta: isso é o hub ou outra
           ferramenta, e o domínio inteiro está atrás do Cloudflare Access.
           Quem chega digitando o endereço não tem referrer e fica só lendo. */
        if (ref.origin === location.origin &&
            ref.pathname.indexOf(this.pasta()) !== 0) return true;
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

/* ---------------------------------------------------------------------------
   QUEM ESTÁ LOGADO, SEGUNDO O CLOUDFLARE ACCESS
   ---------------------------------------------------------------------------
   A ferramenta roda atrás do Access, que já sabe quem entrou. Este endereço é
   servido pelo próprio Cloudflare, na mesma origem da página, e devolve o
   e-mail da sessão — sem senha, sem configuração, sem chamada para fora.

   Fora do Access ele não existe: a função devolve vazio e a tela volta a pedir
   o nome digitado, como antes.

   O que isto NÃO é: o e-mail viaja no corpo da mensagem, escrito por esta
   página. Quem contornar o hub e postar direto no endereço do script pode
   escrever o e-mail que quiser. Quem impede essa pessoa é a senha. Isto
   identifica entre os autorizados, não prova.
   ------------------------------------------------------------------------- */
async function identidadeAccess(){
  try {
    const r = await fetch('/cdn-cgi/access/get-identity', { credentials:'include' });
    if (!r.ok) return '';
    const d = await r.json();
    return String((d && (d.email || d.name)) || '').trim();
  } catch(e){ return ''; }
}

/* Pergunta uma vez, no carregamento. Quem grava espera esta promessa. */
let IDENTIDADE = null;

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

/* ---------------------------------------------------------------------------
   SENHA DE GRAVAÇÃO
   ---------------------------------------------------------------------------
   O envio é no-cors: o navegador não deixa ler a resposta do script. Por isso
   a senha é conferida ANTES, por um GET, na hora de guardá-la. Descobrir que
   estava errada só depois de mandar gravar seria descobrir tarde demais.
   ------------------------------------------------------------------------- */
const Chave = {
  K: 'fluxo_chave',
  exigida: false,

  carregar(){
    try { state.chave = sessionStorage.getItem(this.K) || ''; } catch(e){}
  },

  async status(){
    try {
      const r = await fetch(CONFIG.DATA_URL + '?check=1&t=' + Date.now() +
        (state.chave ? ('&chave=' + encodeURIComponent(state.chave)) : ''));
      const d = await r.json();
      this.exigida = !!d.exige_chave;
      if (this.exigida && state.chave && d.chave_ok === false){
        this.esquecer();
        toast('A senha de gravação mudou. Vou pedir a nova na próxima gravação.', true);
      }
    } catch(e){ /* sem status, a gravação ainda tenta e o script decide */ }
  },

  esquecer(){
    state.chave = '';
    try { sessionStorage.removeItem(this.K); } catch(e){}
  },

  async conferir(chave){
    try {
      const r = await fetch(CONFIG.DATA_URL + '?check=1&chave=' +
                            encodeURIComponent(chave) + '&t=' + Date.now());
      const d = await r.json();
      return d && d.chave_ok !== false;
    } catch(e){
      toast('Não consegui conferir a senha agora.', true);
      return false;
    }
  },

  /* Devolve true quando pode gravar. Pede a senha só quando o script exige e
     ela ainda não está guardada nesta sessão. */
  async garantir(){
    if (!this.exigida || state.chave) return true;
    const digitada = (prompt('Senha de gravação do fluxo de caixa:') || '').trim();
    if (!digitada) return false;
    if (!(await this.conferir(digitada))){
      toast('Senha de gravação incorreta.', true);
      return false;
    }
    state.chave = digitada;
    try { sessionStorage.setItem(this.K, digitada); } catch(e){}
    return true;
  },
};

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

/* A senha e o autor entram aqui, num lugar só, para toda gravação sair
   assinada sem que cada botão precise lembrar disso. */
function assinar(payload){
  return Object.assign({}, payload, {
    chave: state.chave || '',
    usuario: state.autor || '',
  });
}

async function gravar(payload, textoOk){
  if (!(await Chave.garantir())) { toast('Gravação cancelada.', true); return false; }
  try {
    await fetch(CONFIG.DATA_URL, {
      method:'POST', mode:'no-cors',
      headers:{ 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify(assinar(payload)),
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

async function buscarMes(mes){
  const url = CONFIG.DATA_URL + (CONFIG.DATA_URL.indexOf('?') >= 0 ? '&' : '?') +
              'fluxo=' + mes + '&v=' + Date.now();
  const d = await buscarJson(url);
  if (!d || d.ok === false) throw new Error((d && d.erro) || 'resposta vazia');
  guardar(mes, d);
  return d;
}

/* Guarda os meses já abertos, mas não todos: seis é mais do que qualquer um
   navega numa sessão, e evita a página ir engordando sozinha. */
function guardar(mes, d){
  state.cache[mes] = d;
  const chaves = Object.keys(state.cache);
  if (chaves.length > 6){
    chaves.sort();
    const longe = chaves.reduce((a, b) =>
      Math.abs(mesesEntre(a, state.mes)) > Math.abs(mesesEntre(b, state.mes)) ? a : b);
    if (longe !== state.mes) delete state.cache[longe];
  }
}
function mesesEntre(a, b){
  const pa = a.split('-'), pb = b.split('-');
  return (+pa[0] * 12 + +pa[1]) - (+pb[0] * 12 + +pb[1]);
}

/* O fio no alto da janela basta para trocar de mês. A tela cheia de
   carregamento é para quando a página abre, não para uma troca de coluna. */
function fioComeca(){
  const fio = el('fio'), ff = el('fio-fill');
  if (!fio) return;
  fio.classList.add('ativo');
  ff.style.width = '35%';
  clearTimeout(fioComeca._t);
  fioComeca._t = setTimeout(() => { ff.style.width = '75%'; }, 260);
}
function fioTermina(){
  const fio = el('fio'), ff = el('fio-fill');
  if (!fio) return;
  clearTimeout(fioComeca._t);
  ff.style.width = '100%';
  setTimeout(() => { fio.classList.remove('ativo'); ff.style.width = '0%'; }, 220);
}

async function carregar(primeira){
  if (primeira) etapaLoader('Lendo o fluxo…', 14); else fioComeca();
  try {
    state.dados = await buscarMes(state.mes);
    if (primeira){ etapaLoader('Somando o mês…', 66); await respira(50); }
    calcular();
    if (primeira){ etapaLoader('Montando a tabela…', 88); await respira(50); }
    render();
    if (primeira){
      etapaLoader('Pronto', 100);
      await respira(150);
      esconderLoader();
    } else fioTermina();
    vizinhos();
  } catch(e){
    if (primeira) mostrarErro(e);
    else { fioTermina(); toast('Não consegui abrir o mês: ' + (e.message || e), true); }
  }
}

/* O mês vizinho é buscado em silêncio, mas um de cada vez e só depois que a
   tela já está pronta. O Apps Script atende uma execução por vez para o mesmo
   usuário: pedir três meses juntos põe o mês que você está olhando atrás dos
   outros dois na fila. Por isso a espera é longa, e por isso isto anda devagar
   de propósito. */
function vizinhos(){
  clearTimeout(vizinhos._t);
  vizinhos._t = setTimeout(async () => {
    for (const m of [addMes(state.mes, -1), addMes(state.mes, 1)]){
      if (state.cache[m] || m !== addMes(state.mes, -1) && !state.cache[addMes(state.mes,-1)]) {
        // segue adiante mesmo assim, mas nunca em paralelo
      }
      if (state.cache[m]) continue;
      try { await buscarMes(m); } catch(e){ return; }
      await respira(300);
      if (state.mes !== m && !state.cache[state.mes]) return;  // o usuário mudou de ideia
    }
  }, 2500);
}

/* Passar o mouse na seta é um bom palpite de para onde a pessoa vai. */
function adiantar(mes){
  if (!state.cache[mes]) buscarMes(mes).catch(() => {});
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
  /* O que veio do relatório e o que foi digitado por cima ficam separados: a
     célula mostra a soma, mas na hora de explicar o número é preciso saber de
     onde veio cada parte. */
  const autoCel = {}, ajusteCel = {};
  (d.lancamentos || []).forEach(l => {
    const k = l.linha_id + '|' + l.data;
    ajusteCel[k] = (ajusteCel[k] || 0) + num(l.valor);
  });
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
    autoCel[k] = (autoCel[k] || 0) + num(r.valor);
    qtdPorCel[k] = num(r.qtd);
  });
  Object.keys(prev).forEach(k => {
    const p = k.split('|');
    põe(p[0], p[1], prev[k]);
    autoCel[k] = (autoCel[k] || 0) + prev[k];
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
  const totEmpresa = {}, totBancos = {};
  empresas.forEach(emp => { totEmpresa[emp] = {}; });
  dias.forEach(data => {
    let geral = 0;
    empresas.forEach(emp => {
      let t = 0;
      contas.forEach(c => {
        if (c.empresa !== emp || c.tipo !== 'conta') return;
        t += (sal[c.id] && sal[c.id][data]) || 0;
      });
      totEmpresa[emp][data] = t;
      geral += t;
    });
    totBancos[data] = geral;
  });

  /* A diferença é o alarme: bancos menos saldo calculado. Só faz sentido no
     dia em que alguém informou os saldos. */
  const dif = {};
  dias.forEach(data => {
    if (!temSaldo[data]) return;
    dif[data] = totBancos[data] - sdFim[data];
  });

  state.calc = {
    dias, val, filhos, porId, totEnt, totSai, sdIni, sdFim,
    sal, temSaldo, contaPorId, filhosConta, empresas, totEmpresa, totBancos,
    dif, lancPorCel, qtdPorCel, previstoCel, hoje,
    autoCel, ajusteCel,
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
  fecharBancosNaPrimeiraVez();
  document.body.classList.toggle('exato', state.exato);
  renderStamp();

  /* Onde a pessoa estava olhando. Trocar de mês, ligar os centavos ou mostrar
     os fins de semana refazem a tabela, e sem isto a tela saltaria para o
     começo a cada vez. */
  const antigo = document.querySelector('.grade-wrap');
  const rolagem = antigo ? { x: antigo.scrollLeft, y: antigo.scrollTop } : null;

  const c = el('content');
  c.innerHTML = '';
  c.appendChild(barraMes());
  c.appendChild(secaoTabela());

  if (rolagem){
    const novo = document.querySelector('.grade-wrap');
    if (novo){ novo.scrollLeft = rolagem.x; novo.scrollTop = rolagem.y; }
  }
  /* A animação de entrada é para a primeira pintura. Repetida a cada
     atualização, ela vira piscada. */
  if (state.primeiraPintura){
    document.body.classList.add('entrando');
    state.primeiraPintura = false;
    setTimeout(() => document.body.classList.remove('entrando'), 700);
  }
  empilharFixas();
}

/* Cada linha que acompanha a rolagem para logo abaixo da anterior. As alturas
   são medidas na hora, e não escritas no estilo, porque mudam com a fonte, com
   o zoom do navegador e com a visão de centavos ligada.

   E medir uma vez não basta: a fonte da página chega depois do primeiro
   desenho e muda a altura de todas as linhas. Quando isso acontece, o
   empilhamento calculado antes fica defasado e a tabela aparece correndo pelos
   vãos. Por isso, além de medir no desenho, há um observador que remede
   sempre que qualquer uma dessas alturas mudar, seja lá por que motivo. */
let observadorFixas = null;

function medirFixas(){
  const thead = document.querySelector('table.grade thead');
  if (!thead) return null;
  const fixas = document.querySelectorAll('table.grade tr.fixa');
  let topo = thead.getBoundingClientRect().height;
  fixas.forEach((tr, i) => {
    tr.classList.toggle('ultima-fixa', i === fixas.length - 1);
    tr.style.setProperty('--topo', (i ? topo - 1 : topo).toFixed(2) + 'px');
    topo += tr.getBoundingClientRect().height - (i ? 1 : 0);
  });
  return { thead, fixas };
}

function empilharFixas(){
  requestAnimationFrame(() => {
    const alvos = medirFixas();
    if (!alvos || typeof ResizeObserver === 'undefined') return;
    if (observadorFixas) observadorFixas.disconnect();
    observadorFixas = new ResizeObserver(() => medirFixas());
    observadorFixas.observe(alvos.thead);
    alvos.fixas.forEach(tr => observadorFixas.observe(tr));
  });
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
  ant.onmouseenter = () => adiantar(addMes(state.mes, -1));
  const prox = h('button', { class:'btn btn-ghost btn-sm', type:'button', title:'Próximo mês' }, [icone('fa-chevron-right')]);
  prox.onclick = () => irPara(addMes(state.mes, 1));
  prox.onmouseenter = () => adiantar(addMes(state.mes, 1));
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
    h('span', { class:'mk-valor', text: fmtGrade(valor) || '0,00', title: fmtExato(valor) }),
  ]);
}

function irPara(mes){
  if (mes === state.mes) return;
  state.mes = mes;
  const guardado = state.cache[mes];
  if (guardado){            // mês já visitado: aparece na hora
    state.dados = guardado;
    calcular();
    render();
    vizinhos();
    return;
  }
  carregar();
}

/* --------------------------------------------------------------- tabela */
function secaoTabela(){
  const d = state.dados, c = state.calc;
  const dias = diasVisiveis();
  const sec = h('div', { class:'section' });
  const card = h('div', { class:'card' });

  /* Fecha ou abre tudo de uma vez — os grupos do plano e os bancos. Fica antes
     do nome do mês, na altura da coluna de descrição, que é a coluna a que ele
     se refere. */
  const tudo = tudoFechado();
  const btnTudo = h('button', { class:'btn-agrupar', type:'button',
    title: tudo ? 'Abrir todos os grupos' : 'Fechar todos os grupos' },
    [ icone(tudo ? 'fa-angles-down' : 'fa-angles-up') ]);
  btnTudo.onclick = () => alternarTudo();

  const legenda = h('div', { class:'card-bar' }, [
    btnTudo,
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

  /* Posição de saldos, uma empresa por bloco. Cada banco é um grupo que abre
     e fecha: no dia a dia o que se lê é o total do banco, e o detalhe por
     conta só interessa na hora de digitar. Por isso nascem fechados. */
  c.empresas.forEach(emp => {
    L.push({ kind:'espaco', cadeia: [] });
    const chaveEmp = 'emp:' + emp;
    L.push({ kind:'cabec-saldo', label:'Posição de saldos · ' + emp,
             grupo: chaveEmp, cadeia: [] });
    d.contas.filter(x => x.empresa === emp).forEach(x => {
      if (x.tipo === 'grupo'){
        L.push({ kind:'saldo-grupo', conta: x, label: x.descricao,
                 grupo: 'banco:' + x.id, cadeia: [chaveEmp],
                 get: dia => (c.sal[x.id] && c.sal[x.id][dia]) });
        return;
      }
      L.push({ kind:'saldo-conta', conta: x, label: x.descricao,
               cadeia: ['banco:' + x.pai, chaveEmp],
               get: dia => (c.sal[x.id] && c.sal[x.id][dia]) });
    });
    L.push({ kind:'saldo-total', label:'Total ' + emp,
             get: dia => c.temSaldo[dia] ? c.totEmpresa[emp][dia] : undefined });
  });

  L.push({ kind:'espaco' });
  L.push({ kind:'bancos', label:'Total nos bancos', get: dia => c.temSaldo[dia] ? c.totBancos[dia] : undefined });
  L.push({ kind:'dif', label:'Diferença', get: dia => c.dif[dia] });
  return L;
}

/* Empilha uma linha do plano. Nada é filtrado aqui: a linha vai para a tabela
   sabendo de quem ela depende, e quem decide se aparece é o CSS. */
function empilhar(L, l){
  const c = state.calc;
  L.push({
    kind: l.tipo === 'grupo' ? 'grupo' : 'linha',
    linha: l, label: l.descricao, codigo: l.codigo,
    nivel: nivelDe(l),
    cadeia: ancestrais(l.pai),
    get: dia => (c.val[l.id] && c.val[l.id][dia]),
  });
}

/* A cadeia de grupos acima de uma linha, do mais próximo ao mais distante. */
function ancestrais(pai){
  const out = [];
  let p = pai;
  while (p){
    out.push(p);
    p = state.calc.porId[p] ? state.calc.porId[p].pai : '';
  }
  return out;
}
function nivelDe(l){
  let n = 0, p = l.pai;
  while (p && state.calc.porId[p]){ n++; p = state.calc.porId[p].pai; }
  return n;
}
function fechado(chave){ return !!state.recolhidos[chave]; }

/* Abrir e fechar grupo não redesenha nada: as linhas já estão na tabela, e o
   que muda é quais delas aparecem. Sem reconstrução não há piscada, a rolagem
   fica onde está e a resposta é imediata. */
function aplicarGrupos(){
  document.querySelectorAll('table.grade tr[data-cadeia]').forEach(tr => {
    const cadeia = tr.getAttribute('data-cadeia').split(' ');
    tr.classList.toggle('oculta', cadeia.some(fechado));
  });
  document.querySelectorAll('table.grade tr[data-grupo]').forEach(tr => {
    const estaFechado = fechado(tr.getAttribute('data-grupo'));
    const i = tr.querySelector('button.toggle i');
    if (i) i.className = 'fa-solid ' + (estaFechado ? 'fa-chevron-right' : 'fa-chevron-down');
    const b = tr.querySelector('button.toggle');
    if (b) b.title = estaFechado ? 'abrir' : 'fechar';
  });
  const btn = document.querySelector('.btn-agrupar');
  if (btn){
    const tudo = tudoFechado();
    const i = btn.querySelector('i');
    if (i) i.className = 'fa-solid ' + (tudo ? 'fa-angles-down' : 'fa-angles-up');
    btn.title = tudo ? 'Abrir todos os grupos' : 'Fechar todos os grupos';
  }
  empilharFixas();
}

function guardarGrupos(){
  try { sessionStorage.setItem('fluxo_grupos', JSON.stringify(state.recolhidos)); } catch(e){}
}
function lerGrupos(){
  try {
    const g = sessionStorage.getItem('fluxo_grupos');
    if (g) state.recolhidos = JSON.parse(g) || {};
  } catch(e){}
}

/* Os bancos nascem fechados: no dia a dia o que se lê é o total de cada um, e
   o detalhe por conta só interessa na hora de digitar. Vale uma vez por
   sessão — depois disso manda o que a pessoa deixou aberto. */
function fecharBancosNaPrimeiraVez(){
  if (state.gruposIniciados) return;
  state.gruposIniciados = true;
  let jaTem = false;
  Object.keys(state.recolhidos).forEach(k => { if (k.indexOf('banco:') === 0) jaTem = true; });
  if (jaTem) return;
  (state.dados.contas || []).forEach(c => {
    if (c.tipo === 'grupo') state.recolhidos['banco:' + c.id] = true;
  });
  guardarGrupos();
}

/* Fecha ou abre tudo de uma vez: as linhas do plano e os bancos. */
function alternarTudo(){
  const algumAberto = state.dados.plano.some(l => l.tipo === 'grupo' && !fechado(l.id)) ||
                      state.dados.contas.some(c => c.tipo === 'grupo' && !fechado('banco:' + c.id)) ||
                      state.calc.empresas.some(e => !fechado('emp:' + e));
  state.recolhidos = {};
  if (algumAberto){
    state.dados.plano.forEach(l => { if (l.tipo === 'grupo') state.recolhidos[l.id] = true; });
    state.dados.contas.forEach(c => { if (c.tipo === 'grupo') state.recolhidos['banco:' + c.id] = true; });
    state.calc.empresas.forEach(e => { state.recolhidos['emp:' + e] = true; });
  }
  guardarGrupos();
  aplicarGrupos();
  return !algumAberto;
}

/* "Tudo fechado" leva em conta as duas hierarquias, senão o ícone do botão
   contradiz o que está na tela. */
function tudoFechado(){
  if (!state.dados || !state.calc) return false;
  return !state.dados.plano.some(l => l.tipo === 'grupo' && !fechado(l.id)) &&
         !state.dados.contas.some(c => c.tipo === 'grupo' && !fechado('banco:' + c.id)) &&
         !state.calc.empresas.some(e => !fechado('emp:' + e));
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

  /* Saldo inicial, total de saídas e saldo final ficam à vista o tempo todo,
     como o cabeçalho dos dias: são as três leituras que dão sentido a qualquer
     linha que se esteja olhando lá embaixo. */
  const acompanha = l.kind === 'saldo-ini' || l.kind === 'saldo-fim' || l.kind === 'total';
  const cadeia = l.cadeia || [];
  const tr = h('tr', { class:'l-' + l.kind + (l.nivel ? ' nivel-' + l.nivel : '') +
                              (l.classe ? ' ' + l.classe : '') + (acompanha ? ' fixa' : '') +
                              (cadeia.some(fechado) ? ' oculta' : '') });
  if (cadeia.length) tr.setAttribute('data-cadeia', cadeia.join(' '));
  if (l.grupo) tr.setAttribute('data-grupo', l.grupo);
  const pegar = l.get || (() => undefined);

  /* nome da linha, com o código e o triângulo de recolher */
  const nome = h('td', { class:'col-nome' });
  const box = h('div', { class:'nome-box' });
  /* O triângulo serve às duas hierarquias: os grupos do plano de contas e os
     bancos da posição de saldos. */
  const chaveGrupo = l.kind === 'grupo' ? l.linha.id : (l.grupo || '');
  if (chaveGrupo) tr.setAttribute('data-grupo', chaveGrupo);
  if (chaveGrupo){
    const estaFechado = fechado(chaveGrupo);
    const b = h('button', { class:'toggle', type:'button', title: estaFechado ? 'abrir' : 'fechar' },
      [ icone(estaFechado ? 'fa-chevron-right' : 'fa-chevron-down') ]);
    /* O estado é lido no momento do clique, e não capturado aqui: como a
       tabela não é mais redesenhada a cada vez, um valor guardado no botão
       envelhece assim que outro comando mexe nos grupos. */
    b.onclick = e => {
      e.stopPropagation();
      state.recolhidos[chaveGrupo] = !fechado(chaveGrupo);
      guardarGrupos();
      aplicarGrupos();
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
  if (l.kind === 'dif' && tv !== undefined && tv !== null){
    const z = Math.abs(num(tv)) < 0.005 ? 0 : num(tv);
    tdTot.textContent = z.toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 });
  } else {
    tdTot.textContent = (tv === undefined || tv === null) ? '' : fmtGrade(tv);
  }
  if (tv) tdTot.title = fmtExato(tv);
  tr.appendChild(tdTot);
  return tr;
}

function classeValor(l, v){
  if (l.kind !== 'dif') return '';
  if (v === undefined || v === null) return '';
  return Math.abs(num(v)) < 0.01 ? ' v-ok' : ' v-alerta';
}

function celula(l, dia, v){
  const c = state.calc;
  const cls = ['num'];
  if (!dia.util) cls.push('nao-util');
  if (dia.data === c.hoje) cls.push('hoje');
  cls.push(classeValor(l, v).trim());

  /* Toda linha aceita ajuste à mão, inclusive as que somam sozinhas do
     relatório: o dinheiro que a automação não enxerga precisa caber em algum
     lugar, e o lugar certo é a conta a que ele pertence. */
  const editavel = state.podeEditar &&
    (l.kind === 'linha' || l.kind === 'saldo-conta' || l.kind === 'saldo-grupo' ||
     l.kind === 'cabec-saldo');
  const detalhavel = l.kind === 'linha' && num(v);

  const chave = l.linha ? (l.linha.id + '|' + dia.data) : '';
  const previsto = chave && c.previstoCel[chave];
  const ajuste = chave ? c.ajusteCel[chave] : 0;
  const auto = chave ? c.autoCel[chave] : 0;
  if (previsto) cls.push('previsto');
  if (editavel) cls.push('editavel');
  if (detalhavel) cls.push('detalhe');
  if (ajuste && l.kind === 'linha' && l.linha.modo === 'auto') cls.push('ajustada');

  const td = h('td', { class: cls.filter(Boolean).join(' ') });
  if (l.kind === 'linha'){ td.setAttribute('data-linha', l.linha.id); td.setAttribute('data-dia', dia.data); }
  if (l.kind === 'dif' && v !== undefined && v !== null){
    const z = Math.abs(num(v)) < 0.005 ? 0 : num(v);
    td.textContent = z.toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 });
  } else {
    td.textContent = (v === undefined || v === null) ? '' : fmtGrade(v);
  }
  if (ajuste && auto){
    td.textContent = fmtGrade(v) || '0';
    td.title = fmtExato(auto) + ' do relatório  ·  ajuste de ' + fmtExato(ajuste) +
               '  =  ' + fmtExato(v);
  } else if (ajuste){
    td.title = fmtExato(v) + '  ·  lançado à mão';
  } else if (num(v)){
    const q = chave && c.qtdPorCel[chave];
    td.title = fmtExato(v) + (q ? ('  ·  ' + q + ' título(s)') : '') +
               (previsto ? '  ·  previsto' : '');
  }

  if (editavel || detalhavel){
    td.onclick = () => abrirCelula(l, dia, v, td);
    if (editavel && l.kind === 'linha'){
      td.ondblclick = e => { e.preventDefault(); editarNaCelula(td, l, dia); };
    }
  }
  return td;
}

/* ============================================================================
   CLIQUE NA CÉLULA
   ============================================================================ */
function abrirCelula(l, dia, v, td){
  if (l.kind === 'saldo-conta' || l.kind === 'saldo-grupo' || l.kind === 'cabec-saldo'){
    return abrirSaldos(dia.data);
  }
  /* Linha digitada é para digitar: o clique abre a própria célula. A janela
     continua ali para observação, exclusão e histórico, no duplo clique da
     linha automática ou quando o dia tem mais de um lançamento. */
  if (l.linha.modo === 'auto') return abrirDetalheTitulos(l, dia);
  if (state.podeEditar) return editarNaCelula(td, l, dia);
  return abrirLancamentos(l, dia);
}

/* ============================================================================
   EDIÇÃO NA PRÓPRIA CÉLULA
   ----------------------------------------------------------------------------
   Enter salva e desce, Tab salva e anda para o dia seguinte, Esc desiste.
   O valor entra na tela na hora e a gravação segue por baixo — quem digita uma
   coluna inteira de recebimentos não pode esperar o servidor a cada tecla.
   ============================================================================ */
function editarNaCelula(td, l, dia){
  if (!state.podeEditar || !td || td.querySelector('input')) return;
  const lista = state.calc.lancPorCel[l.linha.id + '|' + dia.data] || [];
  if (lista.length > 1) return abrirLancamentos(l, dia);   // vários: pela janela
  if (!pedirAutor()){ toast('Preciso do seu nome para registrar o lançamento.', true); return; }

  const lanc = lista[0] || null;
  const antes = td.textContent;
  td.classList.add('editando');
  td.textContent = '';
  const inp = h('input', { type:'text', inputmode:'decimal', class:'cel-input',
                           value: lanc ? fmtExato(lanc.valor) : '' });
  td.appendChild(inp);
  inp.focus();
  inp.select();

  let encerrado = false;
  const encerrar = (salvar, depois) => {
    if (encerrado) return;
    encerrado = true;
    const texto = inp.value;
    td.classList.remove('editando');
    td.textContent = antes;
    if (salvar) aplicarNaCelula(l, dia, lanc, texto);
    if (depois) depois();
  };

  inp.onkeydown = e => {
    if (e.key === 'Enter'){ e.preventDefault(); encerrar(true, () => andar(l, dia, 'baixo')); }
    else if (e.key === 'Tab'){ e.preventDefault(); encerrar(true, () => andar(l, dia, e.shiftKey ? 'esq' : 'dir')); }
    else if (e.key === 'Escape'){ e.preventDefault(); encerrar(false); }
  };
  inp.onblur = () => encerrar(true);
}

/* Depois de salvar a tabela é redesenhada, então a célula vizinha é procurada
   pelo par linha+dia, não pelo elemento antigo, que já não existe. */
function andar(l, dia, sentido){
  const dias = diasVisiveis();
  const iDia = dias.findIndex(x => x.data === dia.data);
  let alvo = null;

  if (sentido === 'dir' || sentido === 'esq'){
    const j = iDia + (sentido === 'dir' ? 1 : -1);
    if (dias[j]) alvo = { linha: l.linha.id, dia: dias[j].data };
  } else {
    const linhas = linhasDaTela().filter(x => x.kind === 'linha' && x.linha.secao === l.linha.secao);
    const i = linhas.findIndex(x => x.linha.id === l.linha.id);
    if (linhas[i + 1]) alvo = { linha: linhas[i + 1].linha.id, dia: dia.data };
  }
  if (!alvo) return;

  setTimeout(() => {
    const td = document.querySelector('td[data-linha="' + alvo.linha + '"][data-dia="' + alvo.dia + '"]');
    if (!td || !td.classList.contains('editavel')) return;
    td.scrollIntoView({ block:'nearest', inline:'nearest' });
    const rec = linhasDaTela().find(x => x.linha && x.linha.id === alvo.linha);
    const d = state.dados.dias.find(x => x.data === alvo.dia);
    if (rec && d) editarNaCelula(td, rec, d);
  }, 30);
}

/* Grava sem tirar o usuário do lugar: o número muda na tela na hora e o envio
   acontece atrás. Se o envio falhar, a tela recarrega e o aviso aparece —
   melhor perder a digitação do que exibir número que não foi gravado. */
function aplicarNaCelula(l, dia, lanc, texto){
  const v = parseValor(texto);
  const atual = lanc ? num(lanc.valor) : null;
  if (v === null && !lanc) return;                       // nada digitado, nada a fazer
  if (v !== null && atual !== null && Math.abs(v - atual) < 0.005) return;   // nada mudou

  const lista = state.dados.lancamentos;
  if (v === null && lanc){                               // apagou: exclui o lançamento
    const i = lista.findIndex(x => x.id === lanc.id);
    if (i >= 0) lista.splice(i, 1);
    redesenhar();
    enviarEmSilencio({ acao:'fluxo_excluir', id: lanc.id }, 'Lançamento excluído.');
    return;
  }

  const id = lanc ? lanc.id : ('m' + Date.now().toString(36) + Math.floor(Math.random() * 1e4));
  if (lanc) lanc.valor = v;
  else lista.push({ id: id, data: dia.data, linha_id: l.linha.id, valor: v,
                    descricao: '', autor: state.autor, quando: '', desfeito: false });
  redesenhar();
  enviarEmSilencio({ acao:'fluxo_lancamento', lancamento: {
    id: id, data: dia.data, linha_id: l.linha.id, valor: v,
    descricao: lanc ? (lanc.descricao || '') : '', autor: state.autor,
  } }, null);
}

function redesenhar(){
  state.cache[state.mes] = state.dados;
  calcular();
  render();
}

async function enviarEmSilencio(payload, textoOk){
  if (!(await Chave.garantir())) { toast('Gravação cancelada.', true); return; }
  fioComeca();
  try {
    await fetch(CONFIG.DATA_URL, {
      method:'POST', mode:'no-cors',
      headers:{ 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify(assinar(payload)),
    });
    fioTermina();
    if (textoOk) toast(textoOk);
  } catch(e){
    fioTermina();
    toast('Não consegui gravar: ' + (e.message || e) + '. Recarregando…', true);
    delete state.cache[state.mes];
    setTimeout(() => carregar(), 1200);
  }
}

/* --- o que forma o número: os títulos daquele dia e daquela conta --- */
/* O bloco dos ajustes: aparece em qualquer célula, acima ou abaixo dos
   títulos. É por aqui que entra o que a automação não enxerga. */
function blocoAjustes(l, dia){
  const c = state.calc;
  const lista = c.lancPorCel[l.linha.id + '|' + dia.data] || [];
  const box = h('div', { class:'ajustes-box' });

  if (lista.length){
    box.appendChild(h('div', { class:'ajustes-titulo', text:
      lista.length === 1 ? 'Ajuste lançado à mão' : (lista.length + ' ajustes lançados à mão') }));
    lista.forEach(x => {
      const b = h('button', { class:'lanc-item', type:'button' }, [
        h('span', { class:'li-val', text: fmtExato(x.valor) }),
        h('span', { class:'li-desc', text: x.descricao || 'sem observação' }),
        h('span', { class:'li-quem', text: (x.autor || '') +
          (x.quando ? (' · ' + x.quando.slice(0,10).split('-').reverse().join('/')) : '') }),
      ]);
      b.onclick = () => { fecharModal('modal-detalhe'); editarLancamento(l, dia, x); };
      box.appendChild(b);
    });
  }

  if (state.podeEditar){
    const novo = h('button', { class:'btn btn-ghost btn-sm', type:'button' },
      [ icone('fa-plus'), lista.length ? 'Lançar outro ajuste' : 'Lançar ajuste neste dia' ]);
    novo.onclick = () => { fecharModal('modal-detalhe'); editarLancamento(l, dia, null); };
    box.appendChild(novo);
    box.appendChild(h('div', { class:'ajustes-dica', text:
      'Valor negativo tira desta conta, positivo acrescenta. Serve para o que o ' +
      'relatório não enxerga — ou para tirar daqui o que já entrou por outro caminho.' }));
  }
  return box;
}

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
    el('det-corpo').appendChild(blocoAjustes(l, dia));
    return;
  }

  try {
    const url = CONFIG.DATA_URL + '?fluxo_detalhe=' + dia.data +
                '&conta=' + encodeURIComponent(l.linha.codigo) + '&v=' + Date.now();
    const r = await buscarJson(url);
    if (!r || !r.ok) throw new Error((r && r.erro) || 'sem resposta');
    const c = state.calc, k = l.linha.id + '|' + dia.data;
    const auto = c.autoCel[k] || 0, ajuste = c.ajusteCel[k] || 0;
    const corpo = el('det-corpo');
    corpo.innerHTML = '';

    /* Sem título no histórico mas com valor na tela: o número veio da migração
       da planilha antiga, que guardou só o total do dia. Dizer "nada neste dia"
       ali seria mentira — o valor está na cara de quem pergunta. */
    if (!r.linhas.length){
      el('det-sub').textContent = fmtData(dia.data) +
        (auto ? (' · ' + fmtExato(auto)) : ' · sem valor do relatório');
      corpo.appendChild(h('div', { class:'note info' }, [
        icone('fa-circle-info'),
        h('span', { text: auto
          ? ('Este valor veio da migração da planilha antiga, que guardava só o total ' +
             'do dia por conta de fluxo — o detalhe título a título está na base do Excel. ' +
             'A partir do momento em que o relatório de baixas passa a alimentar o fluxo, ' +
             'a lista aparece aqui.')
          : 'Nenhum título neste dia nesta conta.' }),
      ]));
      if (ajuste) corpo.appendChild(h('div', { class:'note warn', style:'margin-top:10px' }, [
        icone('fa-pen'),
        h('span', { text:'Há ajuste lançado à mão neste dia: R$ ' + fmtExato(ajuste) +
                          '. O valor na tela é R$ ' + fmtExato(auto + ajuste) + '.' }),
      ]));
      corpo.appendChild(blocoAjustes(l, dia));
      return;
    }
    el('det-sub').textContent = fmtData(dia.data) + ' · ' + r.linhas.length +
      ' título(s) · ' + fmtExato(r.total) +
      (ajuste ? ('  ·  ajuste de ' + fmtExato(ajuste)) : '');
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
    corpo.appendChild(blocoAjustes(l, dia));
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
        h('span', { class:'li-val', text: fmtExato(x.valor) }),
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
  const auto = l.linha.modo === 'auto';
  el('lanc-sub').textContent = fmtData(dia.data) +
    (l.linha.secao === 'E' ? ' · entrada' : ' · saída') +
    (auto ? ' · ajuste sobre o que veio do relatório' : '');
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
  delete state.cache[state.mes];
  fioComeca();
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
    el('sal-total').textContent = 'Total: ' + fmtExato(t) +
      '  ·  saldo calculado: ' + fmtExato(c.sdFim[data]) +
      '  ·  diferença: ' + fmtExato(t - c.sdFim[data]);
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

/* ============================================================================
   IMPORTAÇÃO — LEITURA DA PLANILHA DO ANO
   ----------------------------------------------------------------------------
   Esta parte lê o "Fluxo de Caixa Realizado", aquele com os dias nas colunas e
   o plano de contas nas linhas, e devolve tudo já organizado: plano, contas
   bancárias, saldo de abertura, posição de saldos e entradas.

   O leitor não assume onde as coisas estão. Ele procura pelos textos que
   organizam a planilha — "Saldo Inicial", "Total Entradas", "Total Saídas",
   "Saldo Final", "POSIÇÃO DE SALDOS" — e se orienta por eles. Assim, se alguém
   inserir uma linha no meio do arquivo, o leitor continua funcionando.

   Nada é gravado aqui. A leitura devolve o que entendeu, a tela mostra, e só
   depois de você confirmar é que alguma coisa sai daqui.
   ========================================================================== */

function normalizar(t){
  return String(t == null ? '' : t)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function slug(t){
  return normalizar(t).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function dataISO(v){
  if (v instanceof Date && !isNaN(v)){
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return v.getFullYear() + '-' + m + '-' + d;
  }
  return '';
}

function numero(v){
  if (typeof v === 'number') return v;
  if (v == null || v === '') return 0;
  const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function lerPlanilhaDoAno(wb){
  const avisos = [];
  let matriz = null, aba = '';

  /* A aba certa é a que tem uma linha de cabeçalho com datas de verdade. */
  for (const nome of wb.SheetNames){
    const m = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header:1, raw:true, defval:null });
    const temData = m.slice(0, 12).some(l => (l || []).slice(2).some(c => dataISO(c)));
    if (temData){ matriz = m; aba = nome; break; }
  }
  if (!matriz) throw new Error('Não achei nenhuma aba com dias nas colunas. ' +
    'Este leitor espera a planilha do fluxo do ano, com as datas no cabeçalho.');

  /* Linha do cabeçalho e quais colunas são dias. */
  let iCab = -1;
  for (let i = 0; i < Math.min(matriz.length, 12); i++){
    if ((matriz[i] || []).slice(2).some(c => dataISO(c))){ iCab = i; break; }
  }
  const colunas = [];
  (matriz[iCab] || []).forEach((c, j) => {
    const d = dataISO(c);
    if (d && j >= 2) colunas.push({ j: j, data: d });
  });
  if (!colunas.length) throw new Error('Achei a aba, mas nenhuma coluna com data.');

  const plano = [], contas = [], config = [], saldos = [], entradas = [];
  const saidasPorDia = {};
  let secao = '';          // 'E' entradas, 'S' saídas, '' fora
  let grupoAtual = '';     // id do grupo dentro do plano
  let empresa = '';        // empresa do bloco de saldos
  let bancoAtual = '';     // id do banco dentro do bloco de saldos
  let modoSaldos = false;
  let ordem = 0, ordemConta = 0;

  for (let i = iCab + 1; i < matriz.length; i++){
    const linha = matriz[i] || [];
    const cod = linha[0] == null ? '' : String(linha[0]).trim();
    const desc = linha[1] == null ? '' : String(linha[1]).trim();
    const chave = normalizar(desc);
    if (!cod && !desc) continue;

    /* ---- marcos que organizam o arquivo ---- */
    if (chave === 'saldo inicial'){
      const primeira = colunas.find(c => typeof linha[c.j] === 'number');
      if (primeira){
        config.push({ chave:'saldo_inicial_data',  valor: primeira.data });
        config.push({ chave:'saldo_inicial_valor', valor: String(numero(linha[primeira.j])) });
      } else {
        avisos.push('A linha "Saldo Inicial" não tinha nenhum valor: o saldo de abertura ficou de fora.');
      }
      continue;
    }
    if (chave === 'total entradas'){ secao = 'E'; grupoAtual = ''; continue; }
    if (chave === 'total saidas'){
      /* Guardamos o total de saídas de cada dia só para a conferência: é ele
         que vai ser comparado com a soma do relatório de contas a pagar. */
      colunas.forEach(c => {
        const v = numero(linha[c.j]);
        if (Math.abs(v) > 0.005) saidasPorDia[c.data] = v;
      });
      secao = 'S'; grupoAtual = ''; continue;
    }
    if (chave === 'saldo final'){    secao = ''; continue; }
    if (chave.indexOf('posicao de saldos') === 0){
      modoSaldos = true; secao = '';
      empresa = String(linha[2] == null ? '' : linha[2]).trim() || 'ON TIME';
      bancoAtual = '';
      continue;
    }
    if (chave === 'total' || chave.indexOf('total ') === 0) continue;

    /* ---- bloco das contas bancárias ---- */
    if (modoSaldos){
      /* Como distinguir o banco da conta dentro dele: a conta traz o nome do
         banco e o tipo separados por hífen ("ITAÚ - Conta Corrente"). O banco
         vem sozinho e em maiúsculas. A segunda regra existe por causa de
         linhas como "Sócio", que ficam penduradas no banco anterior sem hífen
         nenhum — sem ela, virariam um banco vazio. */
      const soMaiusculas = desc === desc.toUpperCase();
      const ehConta = desc.indexOf('-') >= 0 || (bancoAtual && !soMaiusculas);
      if (!ehConta){
        bancoAtual = 'bg-' + slug(empresa) + '-' + slug(desc);
        contas.push({ ordem: ++ordemConta, id: bancoAtual, empresa: empresa,
                      descricao: desc, pai: '', tipo: 'grupo', disponivel: '' });
        continue;
      }
      const idConta = 'bc-' + slug(empresa) + '-' + slug(desc);
      contas.push({ ordem: ++ordemConta, id: idConta, empresa: empresa,
                    descricao: desc, pai: bancoAtual, tipo: 'conta', disponivel: 'sim' });
      colunas.forEach(c => {
        if (typeof linha[c.j] !== 'number') return;
        saldos.push({ data: c.data, conta_id: idConta, valor: numero(linha[c.j]) });
      });
      continue;
    }

    /* ---- plano de contas ---- */
    if (!secao) continue;

    if (!cod){
      grupoAtual = 'g-' + secao.toLowerCase() + '-' + slug(desc);
      plano.push({ ordem: ++ordem, id: grupoAtual, codigo: '', descricao: desc,
                   secao: secao, pai: '', tipo: 'grupo', modo: '' });
      continue;
    }

    const idLinha = 'l-' + secao.toLowerCase() + '-' + slug(cod + '-' + desc);
    plano.push({
      ordem: ++ordem, id: idLinha, codigo: cod, descricao: desc,
      secao: secao, pai: grupoAtual, tipo: 'linha',
      /* 'auto' significa alimentada pelo código da conta de fluxo, que é como
         as saídas chegam do relatório de contas a pagar. As entradas são
         digitadas, então não são automáticas. */
      modo: secao === 'S' ? 'auto' : 'manual',
    });

    if (secao === 'E'){
      colunas.forEach(c => {
        const v = numero(linha[c.j]);
        if (Math.abs(v) < 0.005) return;
        entradas.push({ data: c.data, linha_id: idLinha, valor: v });
      });
    }
  }

  if (!plano.length) avisos.push('Não encontrei nenhuma linha de plano de contas.');
  if (!contas.length) avisos.push('Não encontrei o bloco de POSIÇÃO DE SALDOS: as contas bancárias ficaram de fora.');

  return { aba, colunas, plano, contas, config, saldos, entradas, saidasPorDia, avisos };
}


/* ============================================================================
   IMPORTAÇÃO — LEITURA DO RELATÓRIO DE CONTAS A PAGAR
   ----------------------------------------------------------------------------
   O mesmo leitor serve para dois arquivos que só parecem diferentes: a base do
   ano inteiro, com o cabeçalho na primeira linha, e o relatório de um dia, que
   tem título em cima e o cabeçalho na quarta. Em vez de assumir onde está o
   cabeçalho, ele procura a linha que traz "Vencto Real" e "Fluxo Caixa" e se
   orienta por ela.

   A leitura para no primeiro "TOTAL A PAGAR". Isso descarta de uma vez os
   totais do rodapé e o bloco de TRANSFERÊNCIA INTERCOMPANY, que vem depois e
   não é pagamento a fornecedor.

   O que aproveitamos de cada linha: a data do Vencto Real, o código da Conta
   Fluxo C e o valor da coluna Saldo. O resto vai junto para o detalhe.
   ========================================================================== */

const COLUNAS_RELATORIO = {
  banco:       ['banco'],
  numero:      ['no. titulo', 'no titulo', 'numero', 'no. título'],
  tipo:        ['tipo'],
  natureza:    ['natureza'],
  conta_fluxo: ['conta fluxo c', 'conta fluxo', 'conta fluxo c.'],
  fluxo_caixa: ['fluxo caixa'],
  fornecedor:  ['nome fornece', 'fornecedor', 'nome fornecedor'],
  data:        ['vencto real', 'vencimento real', 'vencto. real'],
  valor_titulo:['vlr.titulo', 'vlr titulo', 'valor titulo', 'vlr.título'],
  historico:   ['historico', 'histórico'],
  saldo:       ['saldo'],
  bordero:     ['bordero', 'borderô', 'num bordero'],
};

function acharColunas_(linha){
  const mapa = {};
  (linha || []).forEach((c, j) => {
    const t = normalizar(c);
    if (!t) return;
    Object.keys(COLUNAS_RELATORIO).forEach(campo => {
      if (mapa[campo] === undefined && COLUNAS_RELATORIO[campo].indexOf(t) >= 0) mapa[campo] = j;
    });
  });
  return mapa;
}

function lerRelatorio(wb){
  const avisos = [];
  let matriz = null, aba = '', cols = null, iCab = -1;

  for (const nome of wb.SheetNames){
    const m = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header:1, raw:true, defval:null });
    for (let i = 0; i < Math.min(m.length, 15); i++){
      const c = acharColunas_(m[i]);
      if (c.data !== undefined && c.conta_fluxo !== undefined){
        matriz = m; aba = nome; cols = c; iCab = i; break;
      }
    }
    if (matriz) break;
  }
  if (!matriz) throw new Error('Não achei o cabeçalho do relatório. ' +
    'Esperava uma linha com as colunas "Vencto Real" e "Conta Fluxo C".');

  if (cols.saldo === undefined){
    avisos.push('A coluna "Saldo" não existe neste arquivo: usei o "Vlr.Titulo" como valor pago.');
  }

  const titulos = [];
  const porDia = {};
  const contas = {};
  let semData = 0, semConta = 0, parouEm = 0;
  const vistos = {};   // para dar sequência a títulos idênticos no mesmo dia

  for (let i = iCab + 1; i < matriz.length; i++){
    const l = matriz[i] || [];
    const texto = l.map(c => normalizar(c)).join(' ');

    /* Fim da parte que interessa. O que vem depois é total e intercompany. */
    if (texto.indexOf('total a pagar') >= 0 || texto.indexOf('total movimenta') >= 0){
      parouEm = i + 1; break;
    }

    const data = dataISO(l[cols.data]);
    const banco = l[cols.banco] == null ? '' : String(l[cols.banco]).trim();
    if (!data){
      if (banco || (l[cols.numero] != null && String(l[cols.numero]).trim())) semData++;
      continue;
    }

    const conta = l[cols.conta_fluxo] == null ? '' : String(l[cols.conta_fluxo]).trim();
    if (!conta){ semConta++; continue; }

    const valor = numero(cols.saldo !== undefined ? l[cols.saldo] : l[cols.valor_titulo]);
    const numeroTit = l[cols.numero] == null ? '' : String(l[cols.numero]).trim();
    const forn = l[cols.fornecedor] == null ? '' : String(l[cols.fornecedor]).trim();

    /* No mesmo dia aparecem títulos idênticos de verdade — treze boletos de
       IPVA com o mesmo número, fornecedor e valor. O contador no fim da chave
       impede que um apague o outro, e é estável: relendo o mesmo arquivo, a
       ordem é a mesma. */
    const base = data + '|' + numeroTit + '|' + normalizar(l[cols.tipo]) + '|' +
                 normalizar(forn) + '|' + valor.toFixed(2);
    vistos[base] = (vistos[base] || 0) + 1;

    titulos.push({
      chave: base + '|' + vistos[base],
      dt_baixa: data, vencimento: data,
      numero: numeroTit,
      tipo: l[cols.tipo] == null ? '' : String(l[cols.tipo]).trim(),
      natureza: l[cols.natureza] == null ? '' : String(l[cols.natureza]).trim(),
      conta_fluxo: conta,
      fluxo_caixa: l[cols.fluxo_caixa] == null ? '' : String(l[cols.fluxo_caixa]).trim(),
      fornecedor: forn,
      valor_pago: valor,
      valor_titulo: numero(l[cols.valor_titulo]),
      historico: l[cols.historico] == null ? '' : String(l[cols.historico]).trim(),
      banco: banco,
      bordero: cols.bordero === undefined || l[cols.bordero] == null ? '' : String(l[cols.bordero]).trim(),
      origem: 'relatorio',
    });

    const d = porDia[data] || (porDia[data] = { qtd:0, valor:0 });
    d.qtd++; d.valor += valor;
    contas[conta] = (contas[conta] || 0) + valor;
  }

  if (semData) avisos.push(semData + ' linha(s) sem data em "Vencto Real" ficaram de fora.');
  if (semConta) avisos.push(semConta + ' linha(s) sem "Conta Fluxo C" ficaram de fora — sem conta, não há onde somar.');
  if (!titulos.length) throw new Error('O arquivo foi lido, mas nenhuma linha tinha data e conta de fluxo.');

  const dias = Object.keys(porDia).sort();
  return {
    aba, titulos, dias, porDia, contas, avisos,
    total: titulos.reduce((a, t) => a + t.valor_pago, 0),
    parouEm,
  };
}


/* ============================================================================
   IMPORTAÇÃO — A TELA
   ----------------------------------------------------------------------------
   Duas portas, porque as duas coisas não se parecem: atualizar um dia é rotina
   e precisa ser rápido; carregar o ano é uma vez só e substitui tudo, então
   precisa ser difícil de fazer sem querer.

   A regra que vale para as duas: nada é gravado antes de a tela mostrar o que
   entendeu do arquivo, e o botão diz exatamente o que vai acontecer — não um
   "Importar" genérico, mas "Substituir 03/09".
   ========================================================================== */

const MESES_PT = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

function dataBR(iso){
  const p = String(iso).split('-');
  return p.length === 3 ? (p[2] + '/' + p[1] + '/' + p[0]) : String(iso);
}

function dinheiro(v){
  return (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

const Importar = {
  modo: 'dia',        // 'dia', 'ano' ou 'limpar'
  rel: null,          // leitura do relatório de contas a pagar
  ano: null,          // leitura da planilha do fluxo do ano
  ocupado: false,

  abrir(){
    this.modo = 'dia'; this.rel = null; this.ano = null; this.ocupado = false;
    this.render();
    mostrarModal('modal-importar');
  },

  /* A limpeza mora dentro do modal de importação de propósito: é aqui que se
     está quando uma carga sai torta e se quer recomeçar. Fora daqui ela seria
     um botão vermelho no cabeçalho, ao alcance de quem só queria olhar. */
  abrirLimpeza(){
    if (this.ocupado) return;
    this.modo = 'limpar'; this.rel = null; this.ano = null;
    this.render();
  },

  alternar(){
    if (this.ocupado) return;
    if (this.modo === 'limpar') this.modo = 'dia';
    else this.modo = this.modo === 'dia' ? 'ano' : 'dia';
    this.rel = null; this.ano = null;
    this.render();
  },

  /* ---------------------------------------------------------------- desenho */
  render(){
    const corpo = el('imp-corpo');
    const dia = this.modo === 'dia';
    const limpando = this.modo === 'limpar';

    el('imp-titulo').textContent = limpando ? 'Limpar a base do fluxo'
                                 : dia ? 'Atualizar um dia' : 'Carga inicial do ano';
    el('imp-sub').textContent = limpando
      ? 'Apaga tudo que a ferramenta guarda hoje. Depois disto a tela volta vazia.'
      : dia
      ? 'Solte o relatório de contas a pagar. Nada é gravado antes de você conferir.'
      : 'Solte os dois arquivos: o fluxo do ano e a base realizada. Isto substitui o histórico inteiro.';
    el('imp-alternar').textContent = limpando ? 'voltar para a importação'
                                  : dia ? 'carga inicial do ano' : 'voltar para atualizar um dia';

    /* O link de limpar some enquanto se está limpando: sair de lá é papel do
       "voltar", e dois caminhos para a mesma tela só confundem. */
    const lnk = el('imp-limpar');
    if (lnk) lnk.hidden = limpando;

    corpo.textContent = '';

    if (limpando){
      corpo.appendChild(this.painelLimpeza());
      this.atualizarBotao();
      return;
    }

    corpo.appendChild(this.dropzone());

    if (dia && this.rel) corpo.appendChild(this.resumoRelatorio());
    if (!dia){
      if (this.ano) corpo.appendChild(this.resumoAno());
      if (this.rel) corpo.appendChild(this.resumoRelatorio());
      if (this.ano && this.rel) corpo.appendChild(this.conferencia());
      if (this.ano && this.rel) corpo.appendChild(this.confirmacaoAno());
    }

    this.atualizarBotao();
  },

  dropzone(){
    const dia = this.modo === 'dia';
    const z = h('div', { class:'imp-solta', tabindex:'0' }, [
      h('i', { class:'fa-solid fa-cloud-arrow-up' }),
      h('b', { text: dia ? 'Solte aqui o relatório de contas a pagar'
                         : 'Solte aqui os dois arquivos, ou um de cada vez' }),
      h('span', { text: dia ? 'um dia, uma semana ou o período que o arquivo trouxer'
                            : 'o fluxo do ano e a base realizada, em qualquer ordem' }),
    ]);
    const input = h('input', { type:'file', accept:'.xlsx,.xls', multiple:'multiple' });
    input.style.display = 'none';
    z.appendChild(input);

    z.onclick = () => { if (!this.ocupado) input.click(); };
    input.onchange = e => this.receber(Array.from(e.target.files || []));
    ['dragenter','dragover'].forEach(ev => z.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation(); z.classList.add('sobre');
    }));
    ['dragleave','drop'].forEach(ev => z.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation(); z.classList.remove('sobre');
    }));
    z.addEventListener('drop', e => this.receber(Array.from(e.dataTransfer.files || [])));
    return z;
  },

  /* ---------------------------------------------------------------- leitura */
  async receber(arquivos){
    if (this.ocupado || !arquivos.length) return;
    for (const f of arquivos){
      try {
        const buf = await f.arrayBuffer();
        const wb = XLSX.read(buf, { type:'array', cellDates:true });

        /* Quem decide o que o arquivo é: o próprio arquivo. O relatório tem as
           colunas "Vencto Real" e "Conta Fluxo C"; a planilha do ano tem os
           dias no cabeçalho. Tento o relatório primeiro, que é o mais restrito. */
        let ehRelatorio = true, r = null;
        try { r = lerRelatorio(wb); } catch(e){ ehRelatorio = false; }

        if (ehRelatorio){
          this.rel = r; this.rel.arquivo = f.name;
        } else {
          if (this.modo === 'dia'){
            toast('Este arquivo não parece o relatório de contas a pagar.', true);
            continue;
          }
          this.ano = lerPlanilhaDoAno(wb); this.ano.arquivo = f.name;
        }
      } catch(err){
        toast('Não consegui ler "' + f.name + '": ' + (err.message || err), true);
      }
    }
    this.render();
  },

  /* ---------------------------------------------------------------- resumos */
  resumoRelatorio(){
    const r = this.rel;
    const c = h('div', { class:'imp-cartao' }, [
      h('h4', null, [ icone('fa-file-invoice-dollar'), 'Pagamentos · ' + (r.arquivo || r.aba) ]),
    ]);
    c.appendChild(this.par('Títulos lidos', r.titulos.length.toLocaleString('pt-BR')));
    c.appendChild(this.par('Contas de fluxo diferentes', String(Object.keys(r.contas).length)));
    c.appendChild(this.par('Período', r.dias.length === 1 ? dataBR(r.dias[0])
      : (dataBR(r.dias[0]) + ' a ' + dataBR(r.dias[r.dias.length - 1]) + '  ·  ' + r.dias.length + ' dias')));
    c.appendChild(this.par('Total', 'R$ ' + dinheiro(r.total)));

    /* Poucos dias: mostra um a um, que é o caso do dia a dia. Muitos: agrupa
       por mês, senão a lista some da tela. */
    const t = h('table', { class:'imp-tabela' });
    const cab = h('tr', null, [ h('th', { text: r.dias.length <= 10 ? 'Dia' : 'Mês' }),
                                h('th', { class:'num', text:'Títulos' }),
                                h('th', { class:'num', text:'Valor' }) ]);
    t.appendChild(h('thead', null, [cab]));
    const corpo = h('tbody');
    if (r.dias.length <= 10){
      r.dias.forEach(d => {
        corpo.appendChild(h('tr', null, [
          h('td', { text: dataBR(d) }),
          h('td', { class:'num', text: String(r.porDia[d].qtd) }),
          h('td', { class:'num', text: dinheiro(r.porDia[d].valor) }),
        ]));
      });
    } else {
      const meses = {};
      r.dias.forEach(d => {
        const m = d.slice(0, 7);
        const a = meses[m] || (meses[m] = { qtd:0, valor:0, dias:0 });
        a.qtd += r.porDia[d].qtd; a.valor += r.porDia[d].valor; a.dias++;
      });
      Object.keys(meses).sort().forEach(m => {
        const nome = MESES_PT[Number(m.slice(5, 7)) - 1] + '/' + m.slice(0, 4);
        corpo.appendChild(h('tr', null, [
          h('td', { text: nome + '  (' + meses[m].dias + ' dias)' }),
          h('td', { class:'num', text: String(meses[m].qtd) }),
          h('td', { class:'num', text: dinheiro(meses[m].valor) }),
        ]));
      });
    }
    t.appendChild(corpo);
    c.appendChild(h('div', { class:'imp-rolagem' }, [t]));

    r.avisos.forEach(a => c.appendChild(h('div', { class:'imp-aviso', text:a })));
    return c;
  },

  resumoAno(){
    const a = this.ano;
    const c = h('div', { class:'imp-cartao' }, [
      h('h4', null, [ icone('fa-table-columns'), 'Estrutura do fluxo · ' + (a.arquivo || a.aba) ]),
    ]);
    c.appendChild(this.par('Linhas do plano de contas', String(a.plano.length)));
    c.appendChild(this.par('Contas bancárias', String(a.contas.filter(x => x.tipo === 'conta').length) +
      ' em ' + String(new Set(a.contas.map(x => x.empresa)).size) + ' empresa(s)'));
    c.appendChild(this.par('Posições de saldo', a.saldos.length.toLocaleString('pt-BR')));
    c.appendChild(this.par('Lançamentos de entrada', a.entradas.length.toLocaleString('pt-BR')));
    const cfg = {};
    a.config.forEach(x => { cfg[x.chave] = x.valor; });
    if (cfg.saldo_inicial_data){
      c.appendChild(this.par('Saldo de abertura',
        'R$ ' + dinheiro(cfg.saldo_inicial_valor) + '  em ' + dataBR(cfg.saldo_inicial_data)));
    }
    a.avisos.forEach(x => c.appendChild(h('div', { class:'imp-aviso', text:x })));
    return c;
  },

  /* ------------------------------------------------------------ conferência */
  conferencia(){
    const c = h('div', { class:'imp-cartao' }, [
      h('h4', null, [ icone('fa-scale-balanced'), 'Conferência entre as duas fontes' ]),
      h('p', { class:'cf-text', text:
        'As saídas do fluxo do ano contra a soma dos pagamentos, mês a mês. ' +
        'Diferença aqui quer dizer saída que não passou pelo contas a pagar — ' +
        'juros de antecipação, por exemplo, que o banco desconta direto.' }),
    ]);

    const porMes = {};
    Object.keys(this.ano.saidasPorDia).forEach(d => {
      const m = d.slice(0, 7);
      porMes[m] = porMes[m] || { fluxo:0, base:0 };
      porMes[m].fluxo += this.ano.saidasPorDia[d];
    });
    this.rel.dias.forEach(d => {
      const m = d.slice(0, 7);
      porMes[m] = porMes[m] || { fluxo:0, base:0 };
      porMes[m].base += this.rel.porDia[d].valor;
    });

    const t = h('table', { class:'imp-tabela' });
    t.appendChild(h('thead', null, [ h('tr', null, [
      h('th', { text:'Mês' }), h('th', { class:'num', text:'Fluxo do ano' }),
      h('th', { class:'num', text:'Pagamentos' }), h('th', { class:'num', text:'Diferença' }),
    ])]));
    const tb = h('tbody');
    let tf = 0, tbase = 0;
    Object.keys(porMes).sort().forEach(m => {
      const x = porMes[m];
      tf += x.fluxo; tbase += x.base;
      const nome = MESES_PT[Number(m.slice(5, 7)) - 1] + '/' + m.slice(0, 4);
      tb.appendChild(h('tr', null, [
        h('td', { text: nome }),
        h('td', { class:'num', text: dinheiro(x.fluxo) }),
        h('td', { class:'num', text: dinheiro(x.base) }),
        h('td', { class:'num', text: dinheiro(x.fluxo - x.base) }),
      ]));
    });
    tb.appendChild(h('tr', null, [
      h('td', null, [ h('b', { text:'Total' }) ]),
      h('td', { class:'num' }, [ h('b', { text: dinheiro(tf) }) ]),
      h('td', { class:'num' }, [ h('b', { text: dinheiro(tbase) }) ]),
      h('td', { class:'num' }, [ h('b', { text: dinheiro(tf - tbase) }) ]),
    ]));
    t.appendChild(tb);
    c.appendChild(h('div', { class:'imp-rolagem' }, [t]));
    return c;
  },

  confirmacaoAno(){
    const box = h('label', { class:'imp-check' });
    const chk = h('input', { type:'checkbox', id:'imp-ciente' });
    chk.onchange = () => this.atualizarBotao();
    box.appendChild(chk);
    box.appendChild(h('div', { text:
      'Entendi que isto substitui o plano de contas, as contas bancárias, os ' +
      'saldos, as entradas e todos os pagamentos do período. O que foi digitado ' +
      'na tela não é apagado.' }));
    return box;
  },

  /* ------------------------------------------------------------- limpeza */
  painelLimpeza(){
    const c = h('div', { class:'imp-cartao' }, [
      h('h4', null, [ icone('fa-triangle-exclamation'), 'Apagar tudo e recomeçar' ]),
    ]);

    c.appendChild(h('div', { class:'imp-aviso imp-perigo', text:
      'Isto apaga o plano de contas, as contas bancárias, o saldo de abertura, ' +
      'a posição de saldos de todos os dias, as entradas, os lançamentos ' +
      'digitados na tela e o histórico título a título de todos os meses. ' +
      'Não existe cópia de segurança e não há como desfazer.' }));

    /* O que existe hoje, para a decisão ser tomada olhando o tamanho dela e
       não no escuro. Vem do que a tela já carregou — não custa uma chamada. */
    const d = state.dados;
    if (d){
      c.appendChild(this.par('Linhas do plano de contas', String((d.plano || []).length)));
      c.appendChild(this.par('Contas bancárias',
        String((d.contas || []).filter(x => x.tipo !== 'grupo').length)));
    }

    c.appendChild(h('p', { class:'cf-text', text:
      'Para confirmar, escreva LIMPAR no campo abaixo. A senha de gravação ' +
      'também será pedida.' }));

    const inp = h('input', { type:'text', id:'imp-palavra', class:'imp-campo',
                             placeholder:'LIMPAR', autocomplete:'off',
                             spellcheck:'false' });
    inp.oninput = () => this.atualizarBotao();
    c.appendChild(inp);
    setTimeout(() => { try { inp.focus(); } catch(e){} }, 50);

    return c;
  },

  par(rot, val){
    return h('div', { class:'imp-linha' }, [
      h('span', { class:'imp-rot', text:rot }), h('b', { text:val }),
    ]);
  },

  /* ------------------------------------------------------------------ botão */
  atualizarBotao(){
    const b = el('imp-confirmar');
    b.classList.toggle('btn-danger',  this.modo === 'limpar');
    b.classList.toggle('btn-primary', this.modo !== 'limpar');
    if (this.ocupado){ b.disabled = true; return; }

    if (this.modo === 'limpar'){
      const campo = el('imp-palavra');
      const ok = campo && campo.value.trim().toUpperCase() === 'LIMPAR';
      b.disabled = !ok;
      b.textContent = 'Limpar tudo';
      return;
    }

    if (this.modo === 'dia'){
      if (!this.rel){ b.disabled = true; b.textContent = 'Confirmar'; return; }
      b.disabled = false;
      const d = this.rel.dias;
      b.textContent = d.length === 1 ? ('Substituir ' + dataBR(d[0]))
                                     : ('Substituir os ' + d.length + ' dias');
      return;
    }

    const pronto = this.ano && this.rel && el('imp-ciente') && el('imp-ciente').checked;
    b.disabled = !pronto;
    b.textContent = 'Carregar o ano';
  },

  /* --------------------------------------------------------------- gravação */
  passo(texto, pct){
    const corpo = el('imp-corpo');
    let barra = el('imp-progresso');
    if (!barra){
      corpo.textContent = '';
      const caixa = h('div', { class:'imp-cartao' }, [
        h('h4', null, [ icone('fa-cloud-arrow-up'), 'Gravando' ]),
      ]);
      barra = h('div', { class:'imp-barra', id:'imp-progresso' }, [ h('span') ]);
      caixa.appendChild(barra);
      caixa.appendChild(h('div', { class:'imp-passo', id:'imp-passo' }));
      corpo.appendChild(caixa);
    }
    barra.firstChild.style.width = Math.max(0, Math.min(100, pct)) + '%';
    el('imp-passo').textContent = texto;
  },

  async enviar(payload){
    await fetch(CONFIG.DATA_URL, {
      method:'POST', mode:'no-cors',
      headers:{ 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify(assinar(payload)),
    });
    /* O envio é no-cors: não dá para ler a resposta. Damos um respiro entre os
       blocos para o Apps Script não receber tudo de uma vez e enfileirar. */
    await new Promise(r => setTimeout(r, 900));
  },

  /* Blocos por mês. Um envio com 28 mil títulos não passa: o Apps Script tem
     limite de tempo e de tamanho. Por mês são uns três mil, que passam. */
  blocosPorMes(titulos){
    const por = {};
    titulos.forEach(t => { (por[t.dt_baixa.slice(0, 7)] = por[t.dt_baixa.slice(0, 7)] || []).push(t); });
    return Object.keys(por).sort().map(m => ({ mes:m, titulos:por[m] }));
  },

  async confirmar(){
    if (this.ocupado) return;
    if (!(await Chave.garantir())){ toast('Gravação cancelada.', true); return; }

    this.ocupado = true;
    this.atualizarBotao();
    el('imp-alternar').disabled = true;

    try {
      if (this.modo === 'limpar')   await this.limparBase();
      else if (this.modo === 'ano') await this.gravarAno();
      else                          await this.gravarDia();

      const limpou = this.modo === 'limpar';
      this.passo(limpou ? 'Base apagada. Recarregando a tela…'
                        : 'Pronto. Recarregando a tela…', 100);
      toast(limpou ? 'Base do fluxo apagada.' : 'Importação concluída.');
      /* O cache inteiro cai, não só o mês na tela: uma limpeza mexe em todos
         os meses, e depois de uma importação o mês vizinho também pode ter
         mudado por causa do saldo que vem arrastado. */
      setTimeout(() => { fecharModal('modal-importar'); state.cache = {}; carregar(); }, 900);
    } catch(err){
      toast('Falhou no meio: ' + (err.message || err), true);
      this.ocupado = false;
      this.render();
    }
  },

  /* Uma chamada só, com a palavra digitada indo junto: o script confere a
     senha e a palavra antes de apagar qualquer coisa. Como o envio é no-cors
     e não dá para ler a resposta, quem diz se funcionou é a tela recarregada
     logo depois — e a aba Log da planilha, que registra quem apagou. */
  async limparBase(){
    const palavra = (el('imp-palavra') || {}).value || '';
    this.passo('Apagando a base…', 40);
    await this.enviar({ acao:'fluxo_limpar', confirmar: palavra.trim().toUpperCase() });
    this.passo('Conferindo…', 80);
    await new Promise(r => setTimeout(r, 1200));
  },

  async gravarDia(){
    const blocos = this.blocosPorMes(this.rel.titulos);
    for (let i = 0; i < blocos.length; i++){
      const b = blocos[i];
      this.passo('Gravando ' + MESES_PT[Number(b.mes.slice(5,7)) - 1] + '/' + b.mes.slice(0,4) +
                 '  (' + (i + 1) + ' de ' + blocos.length + ')', (i / blocos.length) * 100);
      await this.enviar({ acao:'fluxo_historico_lote', titulos:b.titulos,
                          datas:this.rel.dias.filter(d => d.slice(0,7) === b.mes) });
    }
  },

  async gravarAno(){
    const a = this.ano;
    let feito = 0;
    const total = 3 + Math.ceil(a.saldos.length / 800) + this.blocosPorMes(this.rel.titulos).length;
    const anda = txt => { this.passo(txt, (feito / total) * 100); feito++; };

    anda('Plano de contas e contas bancárias…');
    await this.enviar({ acao:'fluxo_estrutura', plano:a.plano, contas:a.contas, config:a.config });

    /* Os saldos são a maior lista depois dos títulos: uns três mil registros.
       Vão em blocos de 800 para caber com folga no limite do Apps Script. */
    for (let i = 0; i < a.saldos.length; i += 800){
      anda('Posição de saldos…');
      await this.enviar({ acao:'fluxo_saldos_lote', saldos:a.saldos.slice(i, i + 800) });
    }

    anda('Entradas…');
    await this.enviar({ acao:'fluxo_entradas_lote', entradas:a.entradas });

    const blocos = this.blocosPorMes(this.rel.titulos);
    for (let i = 0; i < blocos.length; i++){
      const b = blocos[i];
      anda('Pagamentos de ' + MESES_PT[Number(b.mes.slice(5,7)) - 1] + '/' + b.mes.slice(0,4) +
           '  (' + (i + 1) + ' de ' + blocos.length + ')');
      await this.enviar({ acao:'fluxo_historico_lote', titulos:b.titulos,
                          datas:this.rel.dias.filter(d => d.slice(0,7) === b.mes) });
    }
  },
};

document.addEventListener('DOMContentLoaded', () => {
  state.podeEditar = HubLink.init();

  /* Quem está logado, e se o script exige senha. As duas coisas em paralelo,
     sem segurar o desenho da tela. */
  Chave.carregar();
  IDENTIDADE = identidadeAccess().then(quem => {
    if (quem){
      state.autor = quem;
      state.autorFixo = true;
      try { sessionStorage.setItem('fluxo_autor', quem); } catch(e){}
    }
  });
  Chave.status();

  const dt = new Date();
  el('headerData').textContent = maiuscula(dt.toLocaleDateString('pt-BR',
    { weekday:'long', day:'numeric', month:'long' }));

  /* Sem URL configurada, a tela para aqui com o motivo na cara, em vez de
     tentar carregar e falhar de um jeito que não explica nada. */
  if (!CONFIG.DATA_URL || CONFIG.DATA_URL.indexOf('COLE_A_URL') === 0){
    mostrarErro(new Error('Falta configurar o endereço do script do fluxo. ' +
      'No topo do fluxo.js, substitua o valor de URL_BASE pela URL /exec da ' +
      'implantação do script desta ferramenta.'));
    return;
  }
  /* O botão de importar só existe para quem entrou pelo hub — é o mesmo
     critério que libera a edição das células. */
  if (state.podeEditar){
    el('btnImportar').hidden = false;
    el('btnImportar').onclick = () => Importar.abrir();
    el('imp-alternar').onclick = () => Importar.alternar();
    el('imp-limpar').onclick = () => Importar.abrirLimpeza();
    el('imp-confirmar').onclick = () => Importar.confirmar();
  }

  el('btnRecarregar').onclick = () => { abrirLoader('Atualizando…'); carregar(); };
  el('btnExportar').onclick = exportar;
  el('btnDias').onclick = () => {
    state.soUteis = !state.soUteis;
    el('btnDias').querySelector('span').textContent = state.soUteis ? 'Dias úteis' : 'Todos os dias';
    render();
  };
  try { state.exato = sessionStorage.getItem('fluxo_exato') === '1'; } catch(e){}
  const pintarCentavos = () => {
    const b = el('btnCentavos');
    b.querySelector('span').textContent = state.exato ? 'Compacto' : 'Centavos';
    b.classList.toggle('ligado', state.exato);
  };
  pintarCentavos();
  el('btnCentavos').onclick = () => {
    state.exato = !state.exato;
    try { sessionStorage.setItem('fluxo_exato', state.exato ? '1' : '0'); } catch(e){}
    pintarCentavos();
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

  lerGrupos();
  window.addEventListener('resize', () => empilharFixas());
  if (document.fonts && document.fonts.ready){
    document.fonts.ready.then(() => empilharFixas()).catch(() => {});
  }

  try {
    const p = new URLSearchParams(location.search).get('mes');
    if (p && /^\d{4}-\d{2}$/.test(p)) state.mes = p;
  } catch(e){}

  carregar(true);
});
