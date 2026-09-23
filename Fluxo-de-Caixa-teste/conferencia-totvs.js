'use strict';
/* ============================================================================
   CONFERÊNCIA COM O TOTVS — O MIOLO
   ----------------------------------------------------------------------------
   Aqui mora a parte da conferência que não depende da tela: ler o relatório
   de baixas do TOTVS (FINR190, "Relação de Baixas"), casar cada baixa com o
   título que o fluxo mostra e medir se as baixas andam em dia.

   Ficou num arquivo separado por dois motivos. Primeiro, é a parte que mais
   precisa de teste — e aqui ela roda igual no navegador e no computador, sem
   tela nenhuma. Segundo, o fluxo.js já passa das quatro mil linhas; a regra
   de casamento merece ser lida sozinha.

   Nada aqui grava. Quem grava é a tela, e só depois de a pessoa decidir.
   ============================================================================ */
(function (raiz) {

  const TOL = 0.01;                     // um centavo: abaixo disso é igual
  const JANELA_DIAS = 10;               // até onde se procura um título em outra data
  const TIPOS_PROPRIOS_PADRAO = ['TX', 'CIOT'];

  /* ------------------------------------------------------------ utilidades */
  const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
  const perto = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < TOL;

  function normalizar(t){
    return String(t == null ? '' : t)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /* Só letras e números, em maiúsculas. É o que sobra de um nome quando se
     tira tudo que o TOTVS costuma entortar: acento, pontuação, espaço duplo. */
  function chapado(t){
    return normalizar(t).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /* O número do título sem os zeros da frente: o relatório de baixas escreve
     "000000051", a base do fluxo guarda "51". São o mesmo título. */
  function numeroN(v){
    const s = String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
    return s.replace(/^0+(?=.)/, '');
  }

  const tipoN = v => String(v == null ? '' : v).trim().toUpperCase();

  /* A natureza só com os dígitos: "3.3030905" no relatório, 33030905 na base. */
  function naturezaN(v){
    return String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+(?=.)/, '');
  }

  function dataISO(v){
    if (v instanceof Date && !isNaN(v)){
      return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' +
             String(v.getDate()).padStart(2, '0');
    }
    if (typeof v === 'string'){
      const t = v.trim();
      let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return m[1] + '-' + m[2] + '-' + m[3];
      m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/);
      if (m){
        const dia = +m[1], mes = +m[2];
        let ano = +m[3]; if (ano < 100) ano += 2000;
        const d = new Date(ano, mes - 1, dia);
        if (d.getDate() === dia && d.getMonth() === mes - 1)
          return ano + '-' + String(mes).padStart(2, '0') + '-' + String(dia).padStart(2, '0');
      }
    }
    return '';
  }

  /* Número vindo da planilha: número de verdade, ou texto no jeito brasileiro. */
  function valor(v){
    if (typeof v === 'number') return r2(v);
    if (v == null || v === '') return 0;
    let s = String(v).trim().replace(/R\$\s*/i, '').replace(/\s/g, '');
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : r2(n);
  }
  const ehNumero = v => typeof v === 'number' ||
    (typeof v === 'string' && /^-?[\d.]+(,\d+)?$/.test(v.trim()) && v.trim() !== '');

  function somaDias(iso, n){
    const p = String(iso).split('-').map(Number);
    const d = new Date(p[0], p[1] - 1, p[2] + n);
    return dataISO(d);
  }
  function diasEntre(a, b){          // b - a, em dias corridos
    const pa = String(a).split('-').map(Number), pb = String(b).split('-').map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 864e5);
  }

  /* ============================================================================
     1. LER O RELATÓRIO
     ----------------------------------------------------------------------------
     O FINR190 sai do TOTVS como um relatório impresso virado planilha, não como
     uma base. O leitor precisa saber passar por cinco coisas:

       · o cabeçalho das colunas se repete a cada página (25 vezes num arquivo
         de nove dias);
       · "Sub Total : 02/01/2026" fica numa linha e os números do subtotal na
         linha de baixo — lida sem cuidado, a linha de baixo vira um título sem
         data;
       · o histórico passa de 80 caracteres e desce para a linha seguinte
         sozinho, sem número, sem valor — lida sem cuidado, vira um título
         fantasma;
       · o acento vem torto ("SERVIA‡OS"), o mesmo defeito do relatório de
         contas a pagar;
       · no fim vêm o Total Geral, o total sem movimentação e o resumo por
         motivo — que servem para conferir a própria leitura.

     As colunas são achadas pelo nome, não pela posição: se o TOTVS mudar a
     ordem, a leitura continua certa.
     ========================================================================== */
  const COLUNAS = {
    prefixo:    ['prf', 'prefixo'],
    numero:     ['numero', 'notitulo', 'titulo'],
    parcela:    ['prc', 'parcela'],
    tipo:       ['tp', 'tipo'],
    codigo:     ['clifor', 'fornecedor', 'cliente', 'codigo'],
    nome:       ['nomeclifor', 'nomefornecedor', 'nomecliente', 'nome'],
    natureza:   ['natureza'],
    vencto:     ['vencto', 'vencimento', 'venctoreal'],
    historico:  ['historico'],
    baixa:      ['dtbaixa', 'databaixa'],
    original:   ['valororiginal', 'vlroriginal'],
    juros:      ['jurmulta', 'jurosmulta', 'juros'],
    correcao:   ['correcao'],
    desconto:   ['descontos', 'desconto'],
    abatimento: ['abatim', 'abatimento', 'abatimentos'],
    impostos:   ['impostos'],
    acessorio:  ['valoracessorio', 'vlracessorio'],
    total:      ['totalbaixado', 'vlrbaixado', 'valorbaixado'],
    banco:      ['bco', 'banco'],
    digitacao:  ['dtdig', 'dtdigit', 'datadigitacao', 'dtdigitacao'],
    motivo:     ['mot', 'motivo'],
    origem:     ['orig', 'origem'],
  };
  const chaveColuna = t => normalizar(t).replace(/[^a-z0-9]/g, '');

  function acharCabecalho(linha){
    const mapa = {};
    (linha || []).forEach((c, j) => {
      const k = chaveColuna(c);
      if (!k) return;
      Object.keys(COLUNAS).forEach(campo => {
        if (mapa[campo] === undefined && COLUNAS[campo].indexOf(k) >= 0) mapa[campo] = j;
      });
    });
    return (mapa.baixa !== undefined && mapa.total !== undefined && mapa.numero !== undefined) ? mapa : null;
  }

  /* Lê a matriz de uma aba (a saída de sheet_to_json com header:1). Devolve
     null quando a aba não é um relatório de baixas — quem chama tenta a
     próxima. `arrumar` é o conserto de acento da tela; sem ele, o texto passa
     como veio. */
  function lerMatriz(m, arrumar){
    const arruma = typeof arrumar === 'function' ? arrumar : (x => String(x == null ? '' : x).trim());
    let iCab = -1, cols = null;
    for (let i = 0; i < Math.min(m.length, 40); i++){
      const c = acharCabecalho(m[i]);
      if (c){ iCab = i; cols = c; break; }
    }
    if (!cols) return null;

    const cel = (l, campo) => (cols[campo] === undefined ? null : l[cols[campo]]);
    const texto = (l, campo) => { const v = cel(l, campo); return v == null ? '' : String(v).trim(); };

    const titulos = [];
    const info = { emissao: '', referencia: '', totalGeral: null, totalSemMov: null,
                   rodape: {}, continuacoes: 0, repetidos: 0, cabecalhos: 0, subtotais: 0 };
    let pendente = null;           // de quem é a próxima linha só de números
    let anterior = null;           // último título lido: recebe a continuação do histórico

    const primeiroTexto = l => {
      for (let j = 0; j < l.length; j++){
        const v = l[j];
        if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
      }
      return '';
    };

    /* O cabeçalho do relatório (antes da tabela) traz a data de emissão. */
    for (let i = 0; i < iCab; i++){
      const t = primeiroTexto(m[i] || []);
      let x = t.match(/^emiss[aã]o\s*:\s*(\S+)/i); if (x) info.emissao = dataISO(x[1]);
      x = t.match(/^dt\.?\s*ref\.?\s*:\s*(\S+)/i); if (x) info.referencia = dataISO(x[1]);
    }

    for (let i = iCab + 1; i < m.length; i++){
      const l = m[i] || [];
      const cheias = l.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
      if (!cheias.length) continue;

      const t0 = normalizar(primeiroTexto(l));
      if (acharCabecalho(l)){ info.cabecalhos++; anterior = null; continue; }

      if (t0.indexOf('sub total') === 0 || t0.indexOf('subtotal') === 0){
        pendente = 'sub'; info.subtotais++; anterior = null; continue;
      }
      if (t0.indexOf('total geral s/mov') === 0 || t0.indexOf('total geral s mov') === 0){
        pendente = 'semmov'; anterior = null; continue;
      }
      if (t0.indexOf('total geral') === 0){ pendente = 'geral'; anterior = null; continue; }

      /* O resumo por motivo, no pé: "Baixados   4.007.345,55". */
      const rod = String(primeiroTexto(l)).match(/^([A-Za-zÀ-ú. ]+?)\s{2,}([\d.]+,\d{2})$/);
      if (rod && cheias.length === 1){
        info.rodape[normalizar(rod[1]).replace(/\.$/, '')] = valor(rod[2]);
        anterior = null; continue;
      }

      const baixa = dataISO(cel(l, 'baixa'));
      const tot = cel(l, 'total');

      /* Linha só de números, sem data: é o subtotal ou o total que o rótulo
         da linha de cima anunciou. */
      if (!baixa && ehNumero(tot)){
        const par = { original: valor(cel(l, 'original')), total: valor(tot) };
        if (pendente === 'geral') info.totalGeral = par;
        else if (pendente === 'semmov') info.totalSemMov = par;
        pendente = null; anterior = null; continue;
      }

      /* Linha que só tem histórico. Logo depois de uma quebra de página, é o
         TOTVS reimprimindo o histórico do último título da página anterior —
         repetição, não título novo. Colada num título, sem cabeçalho no meio,
         é o resto de um histórico comprido. Nos dois casos, nunca é baixa. */
      const soHistorico = cols.historico !== undefined && cheias.length === 1 &&
        texto(l, 'historico') !== '' && !baixa;
      if (soHistorico){
        const resto = texto(l, 'historico').replace(/\s+/g, ' ');
        if (anterior && anterior._historicoBruto.replace(/\s+/g, ' ').indexOf(resto) < 0){
          anterior._historicoBruto += ' ' + resto;
          anterior.historico = arruma(anterior._historicoBruto.replace(/\s+/g, ' '));
          info.continuacoes++;
        } else info.repetidos++;
        continue;
      }

      if (!baixa || !ehNumero(tot)){ anterior = null; continue; }

      const t = {
        prefixo:   texto(l, 'prefixo'),
        numero:    texto(l, 'numero'),
        parcela:   texto(l, 'parcela'),
        tipo:      tipoN(texto(l, 'tipo')),
        codigo:    texto(l, 'codigo'),
        nome:      arruma(texto(l, 'nome').replace(/\s+/g, ' ')),
        natureza:  texto(l, 'natureza'),
        vencto:    dataISO(cel(l, 'vencto')),
        historico: arruma(texto(l, 'historico').replace(/\s+/g, ' ')),
        baixa:     baixa,
        original:  valor(cel(l, 'original')),
        juros:     valor(cel(l, 'juros')),
        correcao:  valor(cel(l, 'correcao')),
        desconto:  valor(cel(l, 'desconto')),
        abatimento:valor(cel(l, 'abatimento')),
        impostos:  valor(cel(l, 'impostos')),
        acessorio: valor(cel(l, 'acessorio')),
        total:     valor(tot),
        banco:     texto(l, 'banco'),
        digitacao: dataISO(cel(l, 'digitacao')),
        motivo:    texto(l, 'motivo').toUpperCase(),
        origem:    texto(l, 'origem'),
      };
      t._historicoBruto = texto(l, 'historico');
      /* Juros, multa, correção e acessório a mais; desconto a menos. Imposto
         retido e abatimento ficam de fora de propósito: não são custo
         financeiro — o imposto vai para o governo noutro título, e o
         abatimento é crédito do fornecedor. */
      t.acrescimo = r2(t.juros + t.correcao + t.acessorio - t.desconto);
      /* Sem banco, a baixa não tirou dinheiro de conta nenhuma: foi
         compensação (adiantamento, nota de crédito). O próprio relatório
         separa esses no "Total Geral S/Movimentação". */
      t.semBanco = !t.banco;
      titulos.push(t);
      anterior = t;
    }

    titulos.forEach(t => { delete t._historicoBruto; });
    marcarChaves(titulos);

    const datas = titulos.map(t => t.baixa).sort();
    const comBanco = titulos.filter(t => !t.semBanco);
    const semBanco = titulos.filter(t => t.semBanco);
    const soma = lista => r2(lista.reduce((a, t) => a + t.total, 0));

    /* A leitura confere a si mesma: a soma do que foi lido tem de bater com o
       Total Geral do próprio relatório. Se não bater, alguma linha foi lida
       errado — e é melhor saber disso antes de acusar o fluxo. */
    const conferencia = [];
    if (info.totalGeral) conferencia.push({ rotulo: 'com movimentação bancária',
      lido: soma(comBanco), relatorio: info.totalGeral.total });
    if (info.totalSemMov) conferencia.push({ rotulo: 'sem movimentação (compensações)',
      lido: soma(semBanco), relatorio: info.totalSemMov.total });
    conferencia.forEach(c => { c.ok = Math.abs(c.lido - c.relatorio) < 0.05; });

    /* Pagar ou receber? O relatório é o mesmo; a natureza entrega. Nas saídas
       quase tudo começa com 3 (despesa); nas entradas, com 1. */
    let receita = 0, despesa = 0;
    titulos.forEach(t => {
      const n = naturezaN(t.natureza);
      if (/^1/.test(n)) receita++; else if (/^[2-3]/.test(n)) despesa++;
    });

    return {
      titulos: titulos,
      de: datas[0] || '', ate: datas[datas.length - 1] || '',
      dias: Array.from(new Set(datas)),
      comBanco: { qtd: comBanco.length, total: soma(comBanco) },
      semBanco: { qtd: semBanco.length, total: soma(semBanco) },
      conferencia: conferencia,
      confere: conferencia.length > 0 && conferencia.every(c => c.ok),
      carteira: receita > despesa ? 'receber' : 'pagar',
      info: info,
    };
  }

  /* Uma chave estável para cada baixa, para a decisão tomada hoje valer para o
     mesmo relatório tirado de novo amanhã. Duas baixas idênticas em tudo (o
     mesmo título pago em duas vezes iguais no mesmo dia) ganham um contador. */
  function marcarChaves(titulos){
    const vistos = {};
    titulos.forEach(t => {
      const base = ['T', t.baixa, t.prefixo, numeroN(t.numero), t.parcela, t.tipo,
                    chapado(t.codigo), t.total.toFixed(2)].join('|');
      vistos[base] = (vistos[base] || 0) + 1;
      t.chave = base + (vistos[base] > 1 ? ('#' + vistos[base]) : '');
    });
  }

  /* ============================================================================
     2. CASAR COM O FLUXO
     ----------------------------------------------------------------------------
     O teste com o arquivo de janeiro mostrou que "bater" acontece de quatro
     jeitos diferentes, e a ordem das tentativas importa: a mais exigente vem
     primeiro, para uma regra frouxa não roubar o par de uma regra firme.

       1. Mesmo número, mesmo tipo, mesmo dia, mesmo valor. É quase tudo.
       2. Mesmo título e dia, mas o fluxo tem o valor sem os juros que o banco
          cobrou — ou tem outro valor qualquer.
       3. Mesmo título, com valor certo, em outra data — até dez dias de
          distância.
       4. Mesmo dia, mesmo valor e mesmo fornecedor, com número diferente: um
          lado guardou o número do boleto, o outro o da nota.
       5. A soma do dia. Os pagamentos miúdos do banco 007 (pneu, borracharia)
          viram no fluxo uma linha só, "Conta frota". Nenhum deles casa
          sozinho, mas a soma do dia fecha centavo a centavo. Vale também ao
          contrário: vários títulos do fluxo pagos numa baixa só.

     O que sobra é divergência de verdade — com duas exceções que não são
     problema e por isso aparecem à parte: compensação sem banco (não tirou
     dinheiro de conta) e lançamento próprio do fluxo (tarifa, CIOT), que não
     passa pelo contas a pagar do TOTVS.
     ========================================================================== */
  function casar(totvsLista, fluxoLista, opcoes){
    const op = opcoes || {};
    const de = op.de, ate = op.ate;
    const janela = op.janela || JANELA_DIAS;
    const proprios = {};
    (op.tiposProprios || TIPOS_PROPRIOS_PADRAO).forEach(t => { proprios[tipoN(t)] = true; });

    const T = totvsLista.map(t => ({ t: t, par: null }));
    const F = fluxoLista
      .filter(f => f.data >= somaDias(de, -janela) && f.data <= somaDias(ate, janela))
      .map(f => ({ f: f, par: null }));

    const pares = [];
    const juntar = (ts, fs, jeito) => {
      const p = { jeito: jeito, totvs: ts.map(x => x.t), fluxo: fs.map(x => x.f) };
      ts.forEach(x => { x.par = p; });
      fs.forEach(x => { x.par = p; });
      pares.push(p);
      return p;
    };

    const indice = {};
    F.forEach(x => {
      const k = numeroN(x.f.numero) + '|' + tipoN(x.f.tipo);
      (indice[k] = indice[k] || []).push(x);
    });
    const candidatos = x => (indice[numeroN(x.t.numero) + '|' + tipoN(x.t.tipo)] || []).filter(y => !y.par);

    const passar = (filtro, jeito, escolher) => {
      T.forEach(x => {
        if (x.par) return;
        const c = candidatos(x).filter(y => filtro(x.t, y.f));
        if (!c.length) return;
        const y = escolher ? escolher(x.t, c) : c[0];
        juntar([x], [y], jeito);
      });
    };
    const maisPerto = (t, c) => c.slice().sort((a, b) =>
      Math.abs(diasEntre(t.baixa, a.f.data)) - Math.abs(diasEntre(t.baixa, b.f.data)))[0];

    /* Número de nota se repete entre fornecedores: cada motorista MEI tem a
       sua "NF 2". Nas regras que aceitam valor ou data diferente, o nome
       também precisa bater — senão a nota 2 de um motorista casava com a
       nota 2 de outro e virava uma "diferença de valor" que não existe. Nome
       curto ou vazio demais para comparar não impede o par. */
    const nomesParecidos = (a, b) => {
      const x = chapado(a), y = chapado(b);
      if (x.length < 4 || y.length < 4) return false;
      const n = Math.min(x.length, y.length, 12);
      return x.slice(0, n) === y.slice(0, n);
    };
    const mesmoFornecedor = (t, f) => {
      const x = chapado(t.nome), y = chapado(f.fornecedor);
      if (x.length < 4 || y.length < 4) return true;
      return nomesParecidos(t.nome, f.fornecedor);
    };

    // 1. exato
    passar((t, f) => f.data === t.baixa && perto(f.valor, t.total), 'exato');
    // 2a. o fluxo tem o valor do título, sem os juros (ou sem o desconto)
    passar((t, f) => f.data === t.baixa && Math.abs(t.acrescimo) >= TOL &&
                     perto(f.valor, t.total - t.acrescimo), 'sem_acrescimo');
    // 2b. mesmo título e dia, outro valor
    passar((t, f) => f.data === t.baixa && mesmoFornecedor(t, f), 'valor');
    // 3. mesmo título em outra data, com o valor certo
    passar((t, f) => Math.abs(diasEntre(t.baixa, f.data)) <= janela && mesmoFornecedor(t, f) &&
                     (perto(f.valor, t.total) || perto(f.valor, t.total - t.acrescimo)),
           'data', maisPerto);

    // 4. mesmo dia, valor e fornecedor; número diferente
    const porDiaF = {};
    F.forEach(y => { (porDiaF[y.f.data] = porDiaF[y.f.data] || []).push(y); });
    T.forEach(x => {
      if (x.par) return;
      const c = (porDiaF[x.t.baixa] || []).filter(y => !y.par &&
        perto(y.f.valor, x.t.total) && nomesParecidos(y.f.fornecedor, x.t.nome));
      if (c.length) juntar([x], [c[0]], 'numero');
    });

    // 5. a soma do dia
    const diasT = Array.from(new Set(T.map(x => x.t.baixa)));
    diasT.forEach(d => {
      // 5a. várias baixas do mesmo banco no dia = um título do fluxo
      const soltasT = T.filter(x => !x.par && !x.t.semBanco && x.t.baixa === d);
      const porBanco = {};
      soltasT.forEach(x => { (porBanco[x.t.banco] = porBanco[x.t.banco] || []).push(x); });
      Object.keys(porBanco).forEach(b => {
        const grupo = porBanco[b].filter(x => !x.par);
        if (!grupo.length) return;
        const soma = r2(grupo.reduce((a, x) => a + x.t.total, 0));
        const alvo = (porDiaF[d] || []).filter(y => !y.par && perto(y.f.valor, soma));
        if (alvo.length) juntar(grupo, [alvo[0]], 'soma');
      });
      // 5b. vários títulos do fluxo (mesmo fornecedor e conta) = uma baixa
      const soltasF = (porDiaF[d] || []).filter(y => !y.par);
      const porForn = {};
      soltasF.forEach(y => {
        const k = chapado(y.f.fornecedor).slice(0, 12) + '|' + String(y.f.conta_fluxo);
        (porForn[k] = porForn[k] || []).push(y);
      });
      Object.keys(porForn).forEach(k => {
        const grupo = porForn[k];
        if (grupo.length < 2) return;
        const soma = r2(grupo.reduce((a, y) => a + y.f.valor, 0));
        const alvo = T.filter(x => !x.par && x.t.baixa === d && perto(x.t.total, soma));
        if (alvo.length) juntar([alvo[0]], grupo, 'soma');
      });
    });

    /* ------------------------------------------------------ o que sobrou */
    const dentro = d => d >= de && d <= ate;
    const soltosT = T.filter(x => !x.par).map(x => x.t);
    const soltosF = F.filter(x => !x.par && dentro(x.f.data)).map(x => x.f);

    return {
      pares: pares,
      foraDoFluxo: soltosT.filter(t => !t.semBanco),
      compensacoes: soltosT.filter(t => t.semBanco),
      /* Compensação que casou com um título do fluxo é suspeita: no TOTVS ela
         não tirou dinheiro do banco, mas no fluxo está como saída. */
      compensacoesNoFluxo: pares.filter(p => p.totvs.some(t => t.semBanco)),
      semBaixa: soltosF.filter(f => !proprios[tipoN(f.tipo)]),
      proprios: soltosF.filter(f => proprios[tipoN(f.tipo)]),
    };
  }

  /* ============================================================================
     3. AS BAIXAS ANDAM EM DIA?
     ----------------------------------------------------------------------------
     Duas perguntas diferentes, com respostas diferentes:

       · o pagamento saiu no vencimento? Compara a data da baixa com o
         vencimento. Vencimento em sábado, domingo ou feriado conta a partir do
         dia útil seguinte — pagar na segunda um boleto de domingo é pagar em
         dia.
       · a baixa foi lançada no TOTVS logo? Compara a data da baixa com a data
         de digitação, em dias úteis. No mesmo dia ou no seguinte é o normal;
         depois disso, a baixa atrasou. Digitação muito longe da baixa (um ano
         antes, por exemplo) é erro de data no lançamento.

     Compensação entra só na segunda pergunta: ela não é pagamento, mas é baixa.
     ========================================================================== */
  function pontualidade(titulos, ehUtil){
    const util = typeof ehUtil === 'function' ? ehUtil : (iso => {
      const p = String(iso).split('-').map(Number);
      const w = new Date(p[0], p[1] - 1, p[2]).getDay();
      return w !== 0 && w !== 6;
    });
    const proximoUtil = iso => {
      let d = iso;
      for (let i = 0; i < 12 && !util(d); i++) d = somaDias(d, 1);
      return d;
    };
    const uteisEntre = (a, b) => {       // quantos dias úteis de a (exclusive) até b (inclusive)
      if (a === b) return 0;
      const sinal = b > a ? 1 : -1;
      let n = 0, d = a;
      for (let i = 0; i < 400 && d !== b; i++){
        d = somaDias(d, sinal);
        if (util(d)) n += sinal;
      }
      return n;
    };

    const pag = { qtd: 0, noPrazo: 0, atrasados: [], valorAtrasado: 0 };
    titulos.forEach(t => {
      if (t.semBanco || !t.vencto) return;
      pag.qtd++;
      const limite = proximoUtil(t.vencto);
      if (t.baixa <= limite){ pag.noPrazo++; return; }
      pag.atrasados.push({ titulo: t, dias: diasEntre(limite, t.baixa), limite: limite });
      pag.valorAtrasado = r2(pag.valorAtrasado + t.total);
    });
    pag.atrasados.sort((a, b) => b.dias - a.dias || b.titulo.total - a.titulo.total);

    const dig = { qtd: 0, noDia: 0, diaSeguinte: 0, depois: [], antes: [], improvavel: [] };
    titulos.forEach(t => {
      if (!t.digitacao || !t.baixa) return;
      dig.qtd++;
      if (Math.abs(diasEntre(t.baixa, t.digitacao)) > 60){
        dig.improvavel.push({ titulo: t, dias: diasEntre(t.baixa, t.digitacao) });
        return;
      }
      const n = uteisEntre(t.baixa, t.digitacao);
      if (n === 0 && t.digitacao >= t.baixa) dig.noDia++;
      else if (n === 1) dig.diaSeguinte++;
      else if (n > 1) dig.depois.push({ titulo: t, dias: n });
      else dig.antes.push({ titulo: t, dias: n || diasEntre(t.baixa, t.digitacao) });
    });
    dig.depois.sort((a, b) => b.dias - a.dias);

    return {
      pagamentos: pag,
      digitacao: dig,
      pctNoPrazo: pag.qtd ? r2(pag.noPrazo / pag.qtd * 100) : null,
      pctDigitadaEmDia: dig.qtd ? r2((dig.noDia + dig.diaSeguinte) / dig.qtd * 100) : null,
    };
  }

  /* ============================================================================
     4. A LEITURA PARA A TELA
     ----------------------------------------------------------------------------
     Junta o casamento, o dia a dia, os juros e as decisões já tomadas numa
     coisa só, pronta para desenhar. Também é aqui que se decide o que cada
     botão pode fazer — e isso depende de onde vem o número do dia:

       · dia do RELATÓRIO de contas a pagar: o número é a soma da lista de
         títulos. Tirar, incluir, mover e ajustar mudam o número, e é para
         isso que servem.
       · dia da PLANILHA DO ANO: o número veio da planilha que a controladoria
         fecha com os bancos; a lista de títulos só explica. Mexer no número
         ali seria desfazer uma conciliação — então os botões que mudam o total
         ficam travados, com o motivo escrito. Separar os juros continua
         valendo, porque não muda o total do dia, só a linha.
       · dia SEM relatório importado: a conferência aponta, mas não inclui
         nada — o relatório daquele dia, quando chegar, traria tudo de novo.

     As operações que cada decisão gera (lançamento, exclusão) também saem
     prontas daqui. A tela só junta e envia.
     ========================================================================== */
  function analisar(leitura, fluxoLista, ctx){
    const c = ctx || {};
    const fonteDe = d => (c.fontes && c.fontes[d]) || 'vazio';
    const linhaDaConta = typeof c.linhaDaConta === 'function' ? c.linhaDaConta : (() => '');
    const decisoes = {};
    (c.decisoes || []).forEach(d => { if (d && d.chave) decisoes[d.chave] = d; });
    const edita = !!c.podeEditar;
    /* Sem chave não há decisão que se lembre dela. A leitura sempre dá chave;
       isto é para quem montar a lista de outro jeito. */
    if (leitura.titulos.some(t => !t.chave)) marcarChaves(leitura.titulos);

    const cas = casar(leitura.titulos, fluxoLista, {
      de: leitura.de, ate: leitura.ate, tiposProprios: c.tiposProprios, janela: c.janela });

    const itens = [];
    const somaV = lista => r2(lista.reduce((a, x) => a + (Number(x.valor != null ? x.valor : x.total) || 0), 0));
    const rotuloFonte = { relatorio: '', ano: 'planilha do ano', importado: 'planilha antiga', vazio: 'sem relatório' };
    const travaDoDia = (d, verbo) => {
      const f = fonteDe(d);
      if (f === 'relatorio') return '';
      if (f === 'vazio') return 'Não há relatório de contas a pagar importado para ' + br(d) + '. Importe o dia ' +
        'antes de ' + verbo + ' — ou, se ele não existe (fim de semana, débito direto do banco), lance à mão ' +
        'na célula do dia.';
      return 'O número de ' + br(d) + ' vem da planilha do ano, que já fecha com os bancos. ' +
        'A lista de títulos desse dia só explica o número; ' + verbo + ' aqui desfaria a conciliação.';
    };
    const descr = (acao, t, f) => {
      const quem = (t ? t.nome : (f ? f.fornecedor : '')) || '';
      const doc = t ? (t.tipo + ' ' + numeroN(t.numero)) : (f ? (tipoN(f.tipo) + ' ' + numeroN(f.numero)) : '');
      return ('Conferência TOTVS · ' + acao + ' · ' + quem + ' · ' + doc).replace(/\s+/g, ' ').trim().slice(0, 120);
    };

    const novoItem = (categoria, chave, extra) => {
      const it = Object.assign({ categoria: categoria, chave: chave, acoes: [] }, extra);
      const d = decisoes[chave];
      /* Decisão só vale enquanto o que ela fez continua de pé (o lançamento não
         foi apagado, o título não voltou) e enquanto o valor em jogo é o mesmo.
         Se o relatório mudou, a pergunta volta. */
      if (d && d.vivo !== false && (d.valor === undefined || d.valor === '' ||
          perto(d.valor, it.valorRef))) it.decisao = d;
      else if (d) it.decisaoCaiu = d;
      itens.push(it);
      return it;
    };
    const acao = (it, id, rotulo, trava, ops) => {
      it.acoes.push({ id: id, rotulo: rotulo, habilitada: edita && !trava, trava: trava || '',
                      ops: ops || { lancamentos: [], excluir: [] } });
    };
    const manter = (it, rotulo) => acao(it, 'manter', rotulo || 'Manter como está', '', null);

    /* ---- pago no TOTVS, fora do fluxo ---- */
    cas.foraDoFluxo.forEach(t => {
      const conta = c.contaDaNatureza ? c.contaDaNatureza(t.natureza) : '';
      const linha = conta ? linhaDaConta(conta) : '';
      const it = novoItem('fora', t.chave, { data: t.baixa, totvs: t, fluxo: null,
        valorRef: t.total, conta: conta, linha: linha, fonte: fonteDe(t.baixa) });
      /* Natureza que o fluxo nunca viu não tem conta sugerida: a tela pede a
         linha antes de deixar incluir, em vez de adivinhar. */
      acao(it, 'incluir', 'Incluir no fluxo', travaDoDia(t.baixa, 'incluir'), { excluir: [], lancamentos: [
        { data: t.baixa, linha_id: linha, valor: t.total, descricao: descr('incluído', t, null) } ] });
      if (!linha) it.acoes[it.acoes.length - 1].escolherLinha = true;
      manter(it, 'Manter fora do fluxo');
    });

    /* ---- no fluxo, sem baixa no TOTVS ---- */
    cas.semBaixa.forEach(f => {
      const it = novoItem('sem_baixa', 'F|' + f.chave, { data: f.data, totvs: null, fluxo: f,
        valorRef: f.valor, fonte: fonteDe(f.data), perto_do_fim: f.data >= somaDias(leitura.ate, -2) });
      acao(it, 'tirar', 'Tirar do fluxo', travaDoDia(f.data, 'tirar'),
        { lancamentos: [], excluir: [ { chave: f.chave, data: f.data } ] });
      manter(it, 'Manter · cobrar a baixa');
    });

    /* ---- os pares que casaram, mas não por inteiro ---- */
    const juros = [];
    cas.pares.forEach(p => {
      const t = p.totvs[0], f = p.fluxo[0];
      const somaT = r2(p.totvs.reduce((a, x) => a + x.total, 0));
      const somaF = r2(p.fluxo.reduce((a, x) => a + x.valor, 0));
      const acr = r2(p.totvs.reduce((a, x) => a + x.acrescimo, 0));
      const linhaF = linhaDaConta(f.conta_fluxo);

      if (p.totvs.some(x => x.semBanco)){
        const it = novoItem('compensacao', 'C|' + t.chave, { data: f.data, totvs: t, fluxo: f,
          valorRef: somaF, fonte: fonteDe(f.data), jeito: p.jeito });
        acao(it, 'tirar', 'Tirar do fluxo', travaDoDia(f.data, 'tirar'),
          { lancamentos: [], excluir: p.fluxo.map(x => ({ chave: x.chave, data: x.data })) });
        manter(it);
        return;
      }

      if (p.jeito === 'data'){
        const trava = travaDoDia(f.data, 'mover') ||
          (fonteDe(t.baixa) === 'ano' || fonteDe(t.baixa) === 'importado'
            ? travaDoDia(t.baixa, 'mover') : '') ||
          (!linhaF ? 'A conta ' + f.conta_fluxo + ' não está no plano do fluxo.' : '');
        const it = novoItem('data', 'D|' + t.chave, { data: t.baixa, totvs: t, fluxo: f,
          valorRef: somaF, fonte: fonteDe(f.data), dias: diasEntre(f.data, t.baixa) });
        acao(it, 'mover', 'Mover para ' + br(t.baixa), trava, {
          excluir: [ { chave: f.chave, data: f.data } ],
          lancamentos: [ { data: t.baixa, linha_id: linhaF, valor: f.valor,
                           descricao: descr('movido de ' + br(f.data), t, f) } ] });
        manter(it);
      }

      /* Diferença de valor que os juros e descontos não explicam. */
      const semJuros = r2(somaT - acr);
      const explicada = perto(somaF, somaT) || perto(somaF, semJuros);
      if (!explicada && p.jeito !== 'data'){
        const dif = r2(somaT - somaF);
        const it = novoItem('valor', 'V|' + t.chave, { data: f.data, totvs: t, fluxo: f,
          valorRef: dif, diferenca: dif, fonte: fonteDe(f.data), somaT: somaT, somaF: somaF });
        acao(it, 'ajustar', 'Ajustar para ' + moeda(somaT), travaDoDia(f.data, 'ajustar') ||
          (!linhaF ? 'A conta ' + f.conta_fluxo + ' não está no plano do fluxo.' : ''), {
          excluir: [], lancamentos: [ { data: f.data, linha_id: linhaF, valor: dif,
                                        descricao: descr('ajuste ao valor baixado', t, f) } ] });
        manter(it);
      }

      /* Juros, multa e desconto. Se o título está no fluxo SEM os juros, o
         banco pagou mais do que o fluxo mostra, e a linha de juros acrescenta
         a diferença. Se já está com os juros dentro, eles só trocam de linha,
         e o total do dia não se mexe. */
      if (Math.abs(acr) >= TOL){
        const fora = fonteDe(f.data) === 'relatorio' && !perto(somaF, somaT) && perto(somaF, semJuros);
        const lancs = fora
          ? [ { data: f.data, linha_id: c.linhaJuros || '', valor: acr, descricao: descr('juros e multas', t, f) } ]
          : [ { data: f.data, linha_id: linhaF, valor: -acr, descricao: descr('juros levados para a linha própria', t, f) },
              { data: f.data, linha_id: c.linhaJuros || '', valor: acr, descricao: descr('juros e multas', t, f) } ];
        const it = novoItem('juros', 'J|' + t.chave, { data: f.data, totvs: t, fluxo: f,
          valorRef: acr, acrescimo: acr, modo: fora ? 'fora' : 'dentro', fonte: fonteDe(f.data),
          juros: r2(p.totvs.reduce((a, x) => a + x.juros + x.correcao + x.acessorio, 0)),
          desconto: r2(p.totvs.reduce((a, x) => a + x.desconto, 0)) });
        /* Na planilha do ano os juros já estão em alguma linha do dia — a
           planilha fecha com o banco —, mas a conferência não tem como saber
           em qual. Tirar da linha do título podia tirar de onde eles não
           estão. Por isso só nos dias do relatório. */
        const trava = travaDoDia(f.data, 'mexer nos juros') ||
          (!fora && !linhaF ? 'A conta ' + f.conta_fluxo + ' não está no plano do fluxo.' : '');
        acao(it, 'juros', fora ? 'Lançar na linha de juros' : 'Levar para a linha de juros', trava,
             { excluir: [], lancamentos: lancs });
        manter(it, 'Deixar como está');
        juros.push(it);
      }
    });

    /* ---- o que a conferência lançou e agora ficou em dobro ----
       Incluir à mão uma baixa que faltava resolve o dia — até o relatório
       daquele dia ser importado de novo, já com o título dentro. Aí o título
       e o lançamento contam os dois. O mesmo com o ajuste de valor, quando o
       relatório passa a vir com o valor certo. A conferência percebe porque a
       pergunta que ela respondeu deixou de existir: a baixa agora casa. */
    const chavesTotvs = {};
    leitura.titulos.forEach(t => { chavesTotvs[t.chave] = t; });
    const temItem = {};
    itens.forEach(it => { temItem[it.chave] = true; });
    (c.decisoes || []).forEach(d => {
      if (!d || d.vivo === false || !/^(incluir|mover|ajustar)$/.test(String(d.decisao))) return;
      if (temItem[d.chave]) return;
      const chaveT = String(d.chave).replace(/^[DV]\|/, '');
      const t = chavesTotvs[chaveT];
      if (!t) return;                         // não é deste relatório: nada a dizer
      const lancs = String(d.lancs || '').split(',').map(x => x.trim()).filter(Boolean);
      if (!lancs.length) return;
      const it = novoItem('sobra', 'S|' + d.chave, { data: String(d.data || t.baixa).slice(0, 10), totvs: t,
        fluxo: null, valorRef: Number(d.valor) || 0, fonte: fonteDe(t.baixa), origem: d });
      it.acoes.push({ id: 'desfazer', rotulo: 'Desfazer o lançamento', habilitada: edita, trava: '',
                      ops: { lancamentos: [], excluir: [], desfazer: lancs } });
      manter(it, 'Manter os dois');
    });

    /* ------------------------------------------------------ o dia a dia */
    const porDia = {};
    const dia = d => (porDia[d] = porDia[d] || { data: d, totvs: 0, compensacoes: 0, fluxo: 0, ajustes: 0,
                                                 proprios: 0, abertas: 0, fonte: fonteDe(d) });
    leitura.titulos.forEach(t => {
      const x = dia(t.baixa);
      if (t.semBanco) x.compensacoes = r2(x.compensacoes + t.total);
      else x.totvs = r2(x.totvs + t.total);
    });
    const proprioTipo = {};
    (c.tiposProprios || TIPOS_PROPRIOS_PADRAO).forEach(t => { proprioTipo[tipoN(t)] = true; });
    fluxoLista.forEach(f => {
      if (f.data < leitura.de || f.data > leitura.ate) return;
      const x = dia(f.data);
      if (proprioTipo[tipoN(f.tipo)]) x.proprios = r2(x.proprios + f.valor);
      else x.fluxo = r2(x.fluxo + f.valor);
    });
    /* O que a própria conferência já lançou conta a favor do dia: incluir a
       tarifa esquecida resolve a diferença, e a tabela tem de mostrar isso. */
    (c.lancamentosConferencia || []).forEach(l => {
      const d = String(l.data || '').slice(0, 10);
      if (d < leitura.de || d > leitura.ate) return;
      const x = dia(d);
      x.ajustes = r2(x.ajustes + (Number(l.valor) || 0));
    });
    const abertos = itens.filter(it => !it.decisao && it.categoria !== 'juros');
    abertos.forEach(it => { if (porDia[it.data]) porDia[it.data].abertas++; });
    const dias = Object.keys(porDia).sort().map(d => {
      const x = porDia[d];
      x.diferenca = r2(x.fluxo + x.ajustes - x.totvs);
      x.rotuloFonte = rotuloFonte[x.fonte] || '';
      return x;
    });

    /* ------------------------------------------------------ o resumo */
    const pont = pontualidade(leitura.titulos, c.ehUtil);
    const bateram = cas.pares.filter(p => !p.totvs.some(x => x.semBanco) &&
                                          p.jeito !== 'data' && p.jeito !== 'valor');
    const qtdBateram = bateram.reduce((a, p) => a + p.totvs.length, 0);
    const conta = cat => itens.filter(it => it.categoria === cat);
    const abertasDe = cat => conta(cat).filter(it => !it.decisao);
    const jurosPendentes = juros.filter(it => !it.decisao);

    const resumo = {
      de: leitura.de, ate: leitura.ate,
      titulos: leitura.titulos.length,
      com_banco: leitura.comBanco.qtd, total_banco: leitura.comBanco.total,
      compensacoes: leitura.semBanco.qtd, total_compensacoes: leitura.semBanco.total,
      bateram: qtdBateram,
      bateram_pct: leitura.comBanco.qtd ? r2(qtdBateram / leitura.comBanco.qtd * 100) : 0,
      abertas: abertos.length,
      valor_aberto: r2(abertos.reduce((a, it) => a + Math.abs(Number(it.valorRef) || 0), 0)),
      fora: abertasDe('fora').length, fora_valor: somaV(abertasDe('fora').map(it => ({ valor: it.valorRef }))),
      sem_baixa: abertasDe('sem_baixa').length, sem_baixa_valor: somaV(abertasDe('sem_baixa').map(it => ({ valor: it.valorRef }))),
      data: abertasDe('data').length,
      valor: abertasDe('valor').length, valor_dif: somaV(abertasDe('valor').map(it => ({ valor: Math.abs(it.valorRef) }))),
      compensacao_no_fluxo: abertasDe('compensacao').length,
      juros_total: r2(juros.reduce((a, it) => a + it.acrescimo, 0)),
      juros_pendente: r2(jurosPendentes.reduce((a, it) => a + it.acrescimo, 0)),
      proprios: cas.proprios.length, proprios_valor: somaV(cas.proprios),
      pagos_no_prazo_pct: pont.pctNoPrazo, digitadas_em_dia_pct: pont.pctDigitadaEmDia,
      pagos_atrasados: pont.pagamentos.atrasados.length,
      digitadas_depois: pont.digitacao.depois.length,
      datas_improvaveis: pont.digitacao.improvavel.length + pont.digitacao.antes.length,
    };

    juros.sort((a, b) => String(a.data).localeCompare(String(b.data)) ||
                         Math.abs(b.acrescimo) - Math.abs(a.acrescimo));

    return {
      itens: itens,
      divergencias: itens.filter(it => it.categoria !== 'juros'),
      juros: juros,
      reconhecidos: {
        numero: cas.pares.filter(p => p.jeito === 'numero'),
        soma: cas.pares.filter(p => p.jeito === 'soma'),
        compensacoes: cas.compensacoes,
        proprios: cas.proprios,
      },
      dias: dias,
      pontualidade: pont,
      resumo: resumo,
      casamento: cas,
    };
  }

  function br(iso){
    const p = String(iso).split('-');
    return p.length === 3 ? (p[2] + '/' + p[1]) : String(iso);
  }
  function moeda(v){
    return (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* De que conta de fluxo é esta natureza? Primeiro o que o próprio fluxo
     pratica — a natureza de cada título que já está lá, e a conta em que ele
     caiu —, depois a tabela de naturezas do painel de pagamentos. */
  function mapaDeNaturezas(fluxoLista, tabela){
    const conta = {};
    Object.keys(tabela || {}).forEach(k => {
      const n = naturezaN(k);
      const v = tabela[k];
      const cf = String((v && typeof v === 'object') ? (v.conta_fluxo || '') : (v || ''));
      if (n && cf) conta[n] = cf;
    });
    const votos = {};
    (fluxoLista || []).forEach(f => {
      const n = naturezaN(f.natureza);
      if (!n || !f.conta_fluxo) return;
      const v = votos[n] = votos[n] || {};
      v[f.conta_fluxo] = (v[f.conta_fluxo] || 0) + 1;
    });
    Object.keys(votos).forEach(n => {
      const v = votos[n];
      conta[n] = Object.keys(v).sort((a, b) => v[b] - v[a])[0];
    });
    return natureza => conta[naturezaN(natureza)] || '';
  }

  const api = {
    lerMatriz: lerMatriz, casar: casar, pontualidade: pontualidade,
    analisar: analisar, mapaDeNaturezas: mapaDeNaturezas,
    numeroN: numeroN, tipoN: tipoN, naturezaN: naturezaN, chapado: chapado,
    dataISO: dataISO, somaDias: somaDias, diasEntre: diasEntre, perto: perto, r2: r2,
    TIPOS_PROPRIOS_PADRAO: TIPOS_PROPRIOS_PADRAO, JANELA_DIAS: JANELA_DIAS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.ConfTotvsCore = api;

})(typeof window !== 'undefined' ? window : this);
