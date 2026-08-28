/* ============================================================================
   PAGAMENTOS V2 · BACKEND (Google Apps Script Web App)
   ----------------------------------------------------------------------------
   Este script é um DEPÓSITO. Ele não calcula KPI nem faz casamento entre Fluig
   e Totvs — isso tudo mora no front (atualizar.html e, depois, o painel), que é
   a parte fácil de ajustar sem reimplantar nada.

   Duas planilhas:
     · OPERAÇÃO  — a posição atual. Cada envio SUBSTITUI as abas enviadas.
     · HISTÓRICO — os pagamentos que de fato saíram. Só CRESCE, uma aba por mês.
                   Nunca é apagada pela ação "limpar". É a base do fluxo de caixa.

   COMO INSTALAR
   1. Abra a planilha de OPERAÇÃO > Extensões > Apps Script. Apague tudo e cole
      este arquivo. Salve.
   2. Rode a função testarInstalacao() pelo editor (escolha o nome dela na lista
      ao lado do botão Executar). Ela cria as abas e mostra na tela, em vermelho,
      uma mensagem começando com "INSTALACAO OK". O vermelho é proposital, é só
      o jeito de garantir que a mensagem apareça — se está escrito OK, deu certo.
   3. Implantar > Nova implantação > Tipo: App da Web
        - Executar como: Eu
        - Quem tem acesso: Qualquer pessoa
   4. Copie a URL /exec e cole em atualizar.html (CONFIG.APP_SCRIPT_URL).

   Sobre a planilha de HISTÓRICO: o ID já vem preenchido em HIST_SHEET_ID. Se
   ela não abrir (ID errado, outra conta, sem permissão), o script NÃO quebra —
   ele grava o histórico na própria planilha de operação, em abas mensais. A
   mensagem do testarInstalacao() diz qual das duas está sendo usada.

   Se editar depois: Gerenciar implantações > lápis > Versão: Nova versão.
   A URL continua a mesma.
   ============================================================================ */

'use strict';

/* ============================ CONFIG ====================================== */
const SHEET_ID      = '';          // vazio = usa a planilha à qual o script está vinculado
/* Este arquivo mora no repositório, que é público — é de lá que os testes o
   leem. Nada aqui é segredo: a senha de gravação fica nas propriedades do
   script, não no código. O ID da planilha de histórico também pode sair daqui,
   se preferir não deixá-lo à vista: rode definirIdHistorico('...') uma vez e
   apague o valor desta linha. O ID sozinho não abre nada para quem não tem
   permissão na planilha, então é mais uma questão de higiene que de risco. */
const HIST_SHEET_ID = '1Tw9NbO76faxXqt6Vd4L45y59yb5kDneZ9vWtamMT0uY';
const PROP_HIST_ID  = 'histSheetId';

function definirIdHistorico(id) {
  const s = String(id || '').trim();
  if (!s) throw new Error('Passe o ID da planilha de histórico.');
  PropertiesService.getScriptProperties().setProperty(PROP_HIST_ID, s);
  return 'ID guardado nas propriedades. Pode apagar o valor de HIST_SHEET_ID no código.';
}
function idHistorico_() {
  return PropertiesService.getScriptProperties().getProperty(PROP_HIST_ID) || HIST_SHEET_ID;
}
const TZ            = 'America/Sao_Paulo';
const PROP_LAST     = 'lastUpdated';
const CACHE_KEY     = 'pgv2_json';
const CACHE_TTL     = 300;         // 5 minutos
const CACHE_CHUNK   = 95000;

/* ----------------------------------------------------------------------------
   ALIMENTAR O HISTÓRICO
   ----------------------------------------------------------------------------
   As abas mensais da planilha de histórico eram a memória do que foi pago dia
   a dia, pensadas para alimentar o fluxo de caixa. As duas ferramentas seguem
   separadas por ora, e quem responde pelo realizado do fluxo é a planilha
   "01. Base realizado 2026.1", então a gravação está desligada.

   Para religar, troque para true aqui e no montarPayload() do atualizar.html —
   os dois lados, senão o envio continua vindo sem os dados. O que já está
   gravado nas abas mensais não é apagado por isto; elas apenas param de
   crescer, e o período desligado fica em branco.
   -------------------------------------------------------------------------- */
const ALIMENTAR_HISTORICO = false;

/* A edição pode ou não pedir senha — ver CHAVE DE ESCRITA, mais abaixo. O nome
   de quem edita é sempre registrado em cada ajuste, com ou sem senha, então o
   registro de quem mexeu em quê se mantém dos dois jeitos. */

/* ============================ SCHEMAS =====================================
   t: 's' texto · 'n' número · 'd' data (yyyy-mm-dd) · 'b' booleano
   ========================================================================== */

/* Título do Totvs. Ganhou 'saldo' e 'loja' na V2: agora o relatório traz
   título EM ABERTO, e é o saldo/dt_baixa que diz se já foi pago. */
const SCHEMA_TITULO = [
  { k: 'numero', t: 's' }, { k: 'id_fluig', t: 's' },
  /* Lançamento próprio (CIOT e afins) repete o mesmo número todo dia, então
     carrega um id próprio para não se confundir com o do dia anterior. */
  { k: 'id_manual', t: 's' }, { k: 'origem_manual', t: 's' },
  { k: 'parcela', t: 's' }, { k: 'prefixo', t: 's' },
  { k: 'tipo', t: 's' }, { k: 'natureza', t: 's' }, { k: 'fornecedor_cod', t: 's' },
  { k: 'loja', t: 's' }, { k: 'fornecedor', t: 's' },
  { k: 'dt_emissao', t: 'd' }, { k: 'vencimento', t: 'd' }, { k: 'dt_baixa', t: 'd' },
  { k: 'valor', t: 'n' }, { k: 'valor_rs', t: 'n' }, { k: 'valor_liquido', t: 'n' },
  { k: 'saldo', t: 'n' },
  { k: 'historico', t: 's' }, { k: 'forma_pgto', t: 's' }, { k: 'banco', t: 's' },
  { k: 'bordero', t: 's' }, { k: 'fluxo_caixa', t: 's' }, { k: 'conta_fluxo', t: 's' },
  { k: 'manual', t: 'b' },
];

const SCHEMA_NF_SERVICO = [
  { k: 'id', t: 'n' }, { k: 'solicitante', t: 's' }, { k: 'numero_nf', t: 's' },
  { k: 'natureza_cod', t: 's' }, { k: 'natureza', t: 's' }, { k: 'fornecedor', t: 's' },
  { k: 'contato', t: 's' }, { k: 'valor_servico', t: 'n' }, { k: 'valor_produto', t: 'n' },
  { k: 'valor_total', t: 'n' }, { k: 'valor_texto', t: 's' },
  { k: 'vencimento', t: 'd' }, { k: 'dt_solicitacao', t: 'd' }, { k: 'dt_emissao', t: 'd' },
  { k: 'aprovador', t: 's' }, { k: 'cnpj', t: 's' }, { k: 'empresa', t: 's' },
  { k: 'observacoes', t: 's' }, { k: 'status', t: 's' },
];

const SCHEMA_NF_TITULO = [
  { k: 'id', t: 'n' }, { k: 'solicitante', t: 's' }, { k: 'numero_titulo', t: 's' },
  { k: 'natureza_cod', t: 's' }, { k: 'natureza', t: 's' }, { k: 'fornecedor', t: 's' },
  { k: 'valor_total', t: 'n' }, { k: 'valor_texto', t: 's' },
  { k: 'vencimento', t: 'd' }, { k: 'dt_solicitacao', t: 'd' }, { k: 'dt_emissao', t: 'd' },
  { k: 'aprovador', t: 's' }, { k: 'cnpj', t: 's' }, { k: 'empresa', t: 's' },
  { k: 'historico', t: 's' }, { k: 'status', t: 's' },
];

const SCHEMA_REEMBOLSO = [
  { k: 'id', t: 'n' }, { k: 'solicitante', t: 's' }, { k: 'tipo_solicitacao', t: 's' },
  { k: 'tipo_despesa', t: 's' }, { k: 'natureza_cod', t: 's' }, { k: 'fornecedor', t: 's' },
  { k: 'valor_total', t: 'n' }, { k: 'valor_texto', t: 's' }, { k: 'valor_numerico_cru', t: 'b' },
  { k: 'vencimento', t: 'd' }, { k: 'dt_emissao', t: 'd' },
  { k: 'aprovador', t: 's' }, { k: 'cnpj', t: 's' }, { k: 'empresa', t: 's' },
  { k: 'status', t: 's' },
];

/* Vem da aba NATUREZA X FLUXO do relatório de naturezas. As duas últimas
   colunas são o que o relatório da controladoria buscava por PROCV; guardando
   aqui, a exportação sai completa sem link para planilha externa. */
const SCHEMA_NATUREZAS = [
  { k: 'codigo', t: 's' }, { k: 'descricao', t: 's' },
  { k: 'conta_fluxo', t: 's' }, { k: 'fluxo_caixa', t: 's' },
];

/* Tradução dos status do Fluig. O Fluig inventa status novos de vez em quando,
   e esta aba existe para você resolver isso sem mexer no código: escreva o
   texto exato do status de um lado e, do outro, um destes três significados —
   pendente, aprovado ou cancelado. O que não estiver aqui cai numa regra
   padrão e a tela avisa. */
const SCHEMA_CONFIG_STATUS = [
  { k: 'status', t: 's' }, { k: 'significado', t: 's' },
];

/* Dias em que não há pagamento. Sem isto, a previsão de "amanhã" na véspera de
   um feriado apontaria para um dia em que ninguém paga. Nacionais já vêm
   preenchidos; os municipais você acrescenta à mão, uma vez por ano. */
const SCHEMA_FERIADO = [
  { k: 'data', t: 'd' }, { k: 'descricao', t: 's' },
];

/* Ajustes feitos à mão pelo painel. É um LOG: nada é escrito por cima do dado
   original. O painel lê os títulos do último envio e aplica isto por cima, então
   uma edição sobrevive a quantos envios forem feitos no mesmo dia.
   'alvo' identifica o que foi editado: a chave do título, ou 'fluig:<id>'. */
const SCHEMA_AJUSTE = [
  { k: 'id', t: 's' }, { k: 'alvo', t: 's' }, { k: 'campo', t: 's' },
  { k: 'valor_novo', t: 's' }, { k: 'valor_antigo', t: 's' },
  { k: 'autor', t: 's' }, { k: 'quando', t: 's' },
  { k: 'motivo', t: 's' }, { k: 'desfeito', t: 'b' },
];

/* Histórico de pagamentos efetivados — a base do futuro fluxo de caixa.
   'chave' é o identificador do título no Totvs; 'origem' diz se veio do
   relatório ou de lançamento manual. */
const SCHEMA_HIST = [
  { k: 'chave', t: 's' }, { k: 'dt_baixa', t: 'd' }, { k: 'vencimento', t: 'd' },
  { k: 'numero', t: 's' }, { k: 'id_fluig', t: 's' },
  { k: 'parcela', t: 's' }, { k: 'prefixo', t: 's' },
  { k: 'tipo', t: 's' }, { k: 'natureza', t: 's' }, { k: 'conta_fluxo', t: 's' },
  { k: 'fornecedor_cod', t: 's' }, { k: 'loja', t: 's' }, { k: 'fornecedor', t: 's' },
  { k: 'valor_pago', t: 'n' }, { k: 'valor_titulo', t: 'n' },
  { k: 'historico', t: 's' }, { k: 'banco', t: 's' }, { k: 'bordero', t: 's' },
  { k: 'fluxo_caixa', t: 's' }, { k: 'origem', t: 's' }, { k: 'registrado_em', t: 's' },
];

const TABS = {
  Titulos:       SCHEMA_TITULO,   // relatório por VENCIMENTO — o que está previsto
  Baixas:        SCHEMA_TITULO,   // relatório por DATA DE BAIXA — o que já saiu
  TitulosManual: SCHEMA_TITULO,
  NFServico:     SCHEMA_NF_SERVICO,
  NFTitulo:      SCHEMA_NF_TITULO,
  Reembolso:     SCHEMA_REEMBOLSO,
  Naturezas:     SCHEMA_NATUREZAS,
  Ajustes:       SCHEMA_AJUSTE,
  ConfigStatus:  SCHEMA_CONFIG_STATUS,
  Feriados:      SCHEMA_FERIADO,
};

/* ============================ ENTRYPOINTS ================================= */


/* ============================================================================
   CHAVE DE ESCRITA
   ----------------------------------------------------------------------------
   O endereço deste script está escrito no site, que é público. Ler não é
   problema: é o mesmo que a tela mostra. Gravar é: sem nada no caminho,
   qualquer um que ache o endereço pode escrever na base.

   A chave fica guardada aqui dentro, nas propriedades do script, e NUNCA no
   site — senão não seria segredo nenhum. Quem vai usar a tela digita uma vez e
   o navegador guarda, junto com o nome de quem edita.

   Enquanto nenhuma chave for definida, tudo continua funcionando como antes.
   É só rodar definirChaveEscrita('a senha') uma vez para passar a exigir.
   ========================================================================== */
const PROP_CHAVE = 'chaveEscrita';

function chaveExigida_() {
  return !!PropertiesService.getScriptProperties().getProperty(PROP_CHAVE);
}
function chaveConfere_(valor) {
  const esperada = PropertiesService.getScriptProperties().getProperty(PROP_CHAVE);
  if (!esperada) return true;                      // sem chave definida, tudo passa
  return String(valor || '') === String(esperada);
}

/* Rode uma vez pelo editor. Depois apague a senha desta linha do editor —
   ela fica guardada nas propriedades do script, não no código. */
function definirChaveEscrita(senha) {
  const s = String(senha || '').trim();
  if (s.length < 6) throw new Error('Escolha uma senha com pelo menos 6 caracteres.');
  PropertiesService.getScriptProperties().setProperty(PROP_CHAVE, s);
  return 'Chave definida. A partir de agora, gravar exige essa senha.';
}
function removerChaveEscrita() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_CHAVE);
  return 'Chave removida. A gravação voltou a ser livre.';
}

/* ============================================================================
   BACKUP ANTES DE GRAVAR
   ----------------------------------------------------------------------------
   "Enviar para a base" apaga e reescreve as abas de operação. Antes desta
   mudança não havia volta: um envio errado no meio do fechamento não tinha
   como ser desfeito.

   O backup vai para arquivos JSON numa pasta do Drive, não para abas novas na
   planilha — trinta cópias de seis abas deixariam a planilha impossível de
   abrir. Só entram no arquivo as abas que aquele envio vai realmente
   sobrescrever, então um envio parcial gera um backup pequeno.
   ========================================================================== */
const PASTA_BACKUP = 'Pagamentos V2 · Backups';
const MAX_BACKUPS  = 30;

function pastaBackup_() {
  const achadas = DriveApp.getFoldersByName(PASTA_BACKUP);
  return achadas.hasNext() ? achadas.next() : DriveApp.createFolder(PASTA_BACKUP);
}

/* Devolve o nome do arquivo criado, ou '' quando não havia nada a salvar.
   Nunca deixa o envio falhar: se o backup der errado, o aviso vai na resposta
   e a gravação segue — o contrário seria travar o fechamento do dia por causa
   de uma rede de segurança. */
function backupAntes_(ss, abas, motivo) {
  try {
    const conteudo = {};
    let linhas = 0;
    abas.forEach(nome => {
      const schema = TABS[nome];
      if (!schema) return;
      const dados = readTab_(ss, nome, schema);
      conteudo[nome] = dados;
      linhas += dados.length;
    });
    if (!linhas) return '';

    const agora = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH-mm-ss");
    const nome = 'pgv2-backup-' + agora + '.json';
    const corpo = JSON.stringify({
      quando: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss"),
      motivo: String(motivo || ''),
      planilha: ss.getId(),
      abas: conteudo,
    });
    pastaBackup_().createFile(nome, corpo, MimeType.PLAIN_TEXT);
    limparBackupsAntigos_();
    return nome;
  } catch (err) {
    return 'ERRO: ' + String(err && err.message || err);
  }
}

function limparBackupsAntigos_() {
  const arquivos = [];
  const it = pastaBackup_().getFilesByType(MimeType.PLAIN_TEXT);
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf('pgv2-backup-') === 0) arquivos.push(f);
  }
  if (arquivos.length <= MAX_BACKUPS) return 0;
  arquivos.sort((a, b) => a.getName() < b.getName() ? -1 : 1);
  const sobrando = arquivos.slice(0, arquivos.length - MAX_BACKUPS);
  sobrando.forEach(f => f.setTrashed(true));
  return sobrando.length;
}

/* Rode pelo editor para ver o que existe. */
function listarBackups() {
  const arquivos = [];
  const it = pastaBackup_().getFilesByType(MimeType.PLAIN_TEXT);
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf('pgv2-backup-') !== 0) continue;
    let resumo = '';
    try {
      const d = JSON.parse(f.getBlob().getDataAsString());
      resumo = Object.keys(d.abas || {})
        .map(k => k + ' ' + (d.abas[k] || []).length).join(', ') + '  · ' + (d.motivo || '');
    } catch (e) { resumo = '(ilegível)'; }
    arquivos.push(f.getName() + '   ' + resumo);
  }
  arquivos.sort().reverse();
  const msg = arquivos.length
    ? ('Backups, do mais novo para o mais velho:\n' + arquivos.join('\n'))
    : 'Nenhum backup ainda. O primeiro é criado no próximo envio.';
  Logger.log(msg);
  return msg;
}

/* Restaura um backup pelo nome, como listado acima. Antes de restaurar, ele
   mesmo faz um backup do estado atual — assim dá para voltar atrás da volta. */
function restaurarBackup(nomeArquivo) {
  const nome = String(nomeArquivo || '').trim();
  if (!nome) throw new Error('Diga o nome do arquivo. Use listarBackups() para ver quais existem.');
  const it = pastaBackup_().getFilesByName(nome);
  if (!it.hasNext()) throw new Error('Não achei o backup ' + nome + '.');

  const dados = JSON.parse(it.next().getBlob().getDataAsString());
  const abas = Object.keys(dados.abas || {});
  if (!abas.length) throw new Error('Esse backup está vazio.');

  const ss = getSpreadsheet_();
  backupAntes_(ss, abas, 'antes de restaurar ' + nome);

  abas.forEach(aba => {
    const schema = TABS[aba];
    if (!schema) return;
    writeTab_(ss, aba, dados.abas[aba] || [], schema);
  });
  clearCache_();
  const msg = 'Restaurado de ' + nome + ': ' + abas.map(a => a + ' (' +
    (dados.abas[a] || []).length + ')').join(', ') + '.';
  Logger.log(msg);
  return msg;
}


/* ============================================================================
   RESUMO DIÁRIO POR E-MAIL
   ----------------------------------------------------------------------------
   Um e-mail curto de manhã, com o que a pessoa iria abrir a tela para ver: o
   que vence hoje, o que ficou para trás, o que o banco devolveu e o que ainda
   espera uma decisão. Serve para o problema aparecer antes de virar bloqueio
   no fechamento — e para alguém notar quando a base ficou sem atualizar.

   As contas aqui são propositalmente simples e feitas sobre os dados crus. A
   classificação fina (casamento Fluig × Totvs, retenções, devoluções) vive no
   front; repeti-la aqui seria manter a mesma regra em dois lugares e ver as
   duas discordarem com o tempo.

   Para ligar: rode instalarResumoDiario() uma vez. Para desligar,
   removerResumoDiario(). Os destinatários ficam nas propriedades do script,
   por definirDestinatarios('a@x.com, b@x.com').
   ========================================================================== */
const PROP_EMAILS = 'emailsResumo';
const HORA_RESUMO = 8;

function definirDestinatarios(lista) {
  const s = String(lista || '').trim();
  if (!s) throw new Error('Escreva ao menos um e-mail.');
  PropertiesService.getScriptProperties().setProperty(PROP_EMAILS, s);
  return 'Resumo diário vai para: ' + s;
}
function verDestinatarios() {
  const s = PropertiesService.getScriptProperties().getProperty(PROP_EMAILS) || '';
  Logger.log(s || '(ninguém — use definirDestinatarios)');
  return s;
}

function instalarResumoDiario() {
  removerResumoDiario();
  ScriptApp.newTrigger('enviarResumoDiario').timeBased()
    .atHour(HORA_RESUMO).nearMinute(0).everyDays(1)
    .inTimezone(TZ).create();
  return 'Resumo diário ligado, por volta das ' + HORA_RESUMO + 'h.';
}
function removerResumoDiario() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'enviarResumoDiario')
    .forEach(t => ScriptApp.deleteTrigger(t));
  return 'Resumo diário desligado.';
}

function enviarResumoDiario() {
  const para = PropertiesService.getScriptProperties().getProperty(PROP_EMAILS);
  if (!para) return 'Sem destinatários. Use definirDestinatarios(...).';
  const r = montarResumoDiario_();
  MailApp.sendEmail({
    to: para,
    subject: 'Contas a pagar · ' + r.hojeBR + (r.alerta ? ' · atenção' : ''),
    htmlBody: r.html,
  });
  return 'Enviado para ' + para;
}

/* Rode pelo editor para ver o texto sem mandar e-mail para ninguém. */
function testarResumoDiario() {
  const r = montarResumoDiario_();
  Logger.log(r.texto);
  return r.texto;
}

function montarResumoDiario_() {
  const ss = getSpreadsheet_();
  const hoje = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const hojeBR = hoje.slice(8,10) + '/' + hoje.slice(5,7) + '/' + hoje.slice(0,4);
  const amanha = nextBusinessDay_(hoje);

  const titulos = readTab_(ss, 'Titulos', SCHEMA_TITULO)
    .concat(readTab_(ss, 'TitulosManual', SCHEMA_TITULO));
  const ajustes = readTab_(ss, 'Ajustes', SCHEMA_AJUSTE).filter(a => a && !a.desfeito);

  /* Ocultos não somam: é dinheiro que não vai sair. Guardo à parte quais
     foram ocultados por devolução do banco, que é o que a tela marca com o
     motivo começando por "Devolvido pelo banco". */
  const ocultos = {}, devolvidos = {};
  ajustes.forEach(a => {
    if (String(a.campo) !== 'oculto') return;
    const ligado = String(a.valor_novo) !== '0' && String(a.valor_novo) !== '';
    ocultos[a.alvo] = ligado;
    if (ligado && /^devolvido pelo banco/i.test(String(a.motivo || ''))) devolvidos[a.alvo] = a.motivo;
    else delete devolvidos[a.alvo];
  });
  const chaveDe = t => [t.prefixo, t.numero, t.parcela, t.tipo, t.fornecedor_cod, t.loja]
    .map(v => String(v == null ? '' : v)).join('|');

  const z = () => ({ qtd: 0, valor: 0 });
  const somaHoje = z(), somaAmanha = z(), atrasado = z();
  titulos.forEach(t => {
    if (t.dt_baixa) return;                       // já saiu
    const ch = t.id_manual ? ('manual:' + t.id_manual) : chaveDe(t);
    if (ocultos[ch]) return;
    const venc = String(t.vencimento || '').slice(0,10);
    if (!venc) return;
    const v = Number(t.valor_confirmado) || Number(t.valor_rs) || 0;
    const alvo = venc === hoje ? somaHoje : (venc === amanha ? somaAmanha
                : (venc < hoje ? atrasado : null));
    if (alvo){ alvo.qtd++; alvo.valor += v; }
  });

  const baixas = readTab_(ss, 'Baixas', SCHEMA_TITULO);
  const devolucoes = z();
  baixas.concat(titulos).forEach(t => {
    const ch = t.id_manual ? ('manual:' + t.id_manual) : chaveDe(t);
    if (!devolvidos[ch]) return;
    devolucoes.qtd++;
    devolucoes.valor += Number(t.valor_liquido) || Number(t.valor_rs) || 0;
  });

  const ultima = getLast_();
  const horasParada = ultima ? ((Date.now() - new Date(ultima).getTime()) / 36e5) : null;
  const baseVelha = horasParada === null || horasParada > 20;

  const alerta = !!(atrasado.qtd || devolucoes.qtd || baseVelha);

  const linha = (rot, b) => rot + ': ' + b.qtd + ' título(s), ' + moedaBR_(b.valor);
  const texto = [
    'Contas a pagar — ' + hojeBR,
    '',
    linha('Vence hoje', somaHoje),
    linha('Vence amanhã (' + amanha.slice(8,10) + '/' + amanha.slice(5,7) + ')', somaAmanha),
    linha('Atrasado', atrasado),
    devolucoes.qtd ? linha('Devolvido pelo banco', devolucoes) : '',
    '',
    baseVelha
      ? ('ATENÇÃO: a base não é atualizada desde ' + (ultima ? ultima.slice(0,16).replace('T',' ') : 'nunca') + '.')
      : ('Base atualizada em ' + ultima.slice(0,16).replace('T',' ') + '.'),
  ].filter(function(x){ return x !== ''; }).join('\n');

  const item = (rot, b, cor) => !b.qtd ? '' :
    '<tr><td style="padding:6px 12px 6px 0;color:#6B5E6B">' + rot + '</td>' +
    '<td style="padding:6px 0;text-align:right;font-weight:700;color:' + cor + '">' +
    moedaBR_(b.valor) + '</td>' +
    '<td style="padding:6px 0 6px 12px;color:#A89CB0">' + b.qtd + '</td></tr>';

  const html =
    '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1A0F1A;max-width:520px">' +
    '<h2 style="margin:0 0 4px;font-size:17px">Contas a pagar</h2>' +
    '<p style="margin:0 0 16px;color:#6B5E6B">' + hojeBR + '</p>' +
    '<table style="border-collapse:collapse;width:100%">' +
      item('Vence hoje', somaHoje, '#1A0F1A') +
      item('Vence amanhã', somaAmanha, '#B45309') +
      item('Atrasado', atrasado, '#DC2626') +
      item('Devolvido pelo banco', devolucoes, '#DC2626') +
    '</table>' +
    (baseVelha
      ? '<p style="margin:16px 0 0;padding:10px 12px;background:#FEE2E2;color:#7F1D1D;border-radius:8px">' +
        'A base não é atualizada desde ' + (ultima ? ultima.slice(0,16).replace('T',' ') : 'nunca') +
        '. Os números acima podem estar velhos.</p>'
      : '<p style="margin:16px 0 0;color:#A89CB0;font-size:12px">Base atualizada em ' +
        ultima.slice(0,16).replace('T',' ') + '.</p>') +
    '<p style="margin:18px 0 0"><a href="https://controladoriaon.github.io/Controladoria/Pagamentos/" ' +
    'style="color:#FF6E00">Abrir o painel</a></p></div>';

  return { hojeBR: hojeBR, alerta: alerta, texto: texto, html: html,
           hoje: somaHoje, amanha: somaAmanha, atrasado: atrasado, devolucoes: devolucoes,
           baseVelha: baseVelha };
}

function moedaBR_(v) {
  const n = Math.abs(Number(v) || 0).toFixed(2).split('.');
  const inteiro = n[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (Number(v) < 0 ? '-' : '') + 'R$ ' + inteiro + ',' + n[1];
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut_({ ok: false, erro: 'Requisição sem corpo (postData vazio).' });
    }
    const body = JSON.parse(e.postData.contents);

    /* ---- CHAVE ----
       Vale para tudo que grava. Enquanto nenhuma chave estiver definida no
       script, passa direto e nada muda. */
    if (!chaveConfere_(body.chave)) {
      return jsonOut_({ ok: false, erro: 'Chave de escrita inválida ou ausente.' });
    }

    const ss = getSpreadsheet_();

    /* ---- EDIÇÃO PELO PAINEL ---- */
    if (body.acao === 'ajuste' || body.acao === 'desfazer'
        || body.acao === 'titulo_manual' || body.acao === 'excluir_manual') {
      let res;
      if (body.acao === 'ajuste')             res = gravarAjustes_(ss, body.ajustes || []);
      else if (body.acao === 'desfazer')      res = desfazerAjuste_(ss, body.id);
      else if (body.acao === 'excluir_manual') res = excluirTituloManual_(ss, body.id_manual);
      else                                    res = gravarTituloManual_(ss, body.titulo);
      clearCache_();
      return jsonOut_(res);
    }

    /* ---- LIMPEZA ----
       Só mexe na planilha de OPERAÇÃO. O histórico nunca é tocado aqui. */
    if (body.acao === 'limpar') {
      const alvo = body.alvo || 'tudo';
      const aparar = [];
      if (alvo === 'totvs' || alvo === 'tudo') {
        aparar.push('Titulos', 'Baixas', 'NFServico', 'NFTitulo', 'Reembolso');
      }
      if (alvo === 'manuais' || alvo === 'tudo') aparar.push('TitulosManual');
      const bkLimpar = backupAntes_(ss, aparar, 'limpeza: ' + alvo);
      if (alvo === 'totvs' || alvo === 'tudo') {
        writeTab_(ss, 'Titulos',   [], SCHEMA_TITULO);
        writeTab_(ss, 'Baixas',    [], SCHEMA_TITULO);
        writeTab_(ss, 'NFServico', [], SCHEMA_NF_SERVICO);
        writeTab_(ss, 'NFTitulo',  [], SCHEMA_NF_TITULO);
        writeTab_(ss, 'Reembolso', [], SCHEMA_REEMBOLSO);
      }
      if (alvo === 'manuais' || alvo === 'tudo') {
        writeTab_(ss, 'TitulosManual', [], SCHEMA_TITULO);
      }
      const props = PropertiesService.getScriptProperties();
      if (alvo === 'tudo') props.deleteProperty(PROP_LAST);
      else props.setProperty(PROP_LAST, new Date().toISOString());
      clearCache_();
      return jsonOut_({ ok: true, limpou: alvo, backup: bkLimpar,
                        aviso: 'O histórico de pagamentos NÃO foi afetado.' });
    }

    /* ---- GRAVAÇÃO ----
       Cada aba só é tocada se a sua chave vier no envio, então um envio
       parcial não apaga o resto. */
    const resumo = {};

    /* Cópia do estado atual antes de qualquer sobrescrita. Só das abas que
       este envio vai tocar — o resto continua onde está e não precisa de
       cópia. */
    const vaiTocar = [];
    if (Array.isArray(body.titulos))        vaiTocar.push('Titulos');
    if (Array.isArray(body.baixas))         vaiTocar.push('Baixas');
    if (Array.isArray(body.titulos_manual)) vaiTocar.push('TitulosManual');
    if (Array.isArray(body.nf_servico))     vaiTocar.push('NFServico');
    if (Array.isArray(body.nf_titulo))      vaiTocar.push('NFTitulo');
    if (Array.isArray(body.reembolso))      vaiTocar.push('Reembolso');
    if (body.naturezas && typeof body.naturezas === 'object') vaiTocar.push('Naturezas');
    if (vaiTocar.length) resumo.backup = backupAntes_(ss, vaiTocar, 'envio de relatórios');

    if (Array.isArray(body.titulos)) {
      writeTab_(ss, 'Titulos', body.titulos, SCHEMA_TITULO);
      resumo.titulos = body.titulos.length;
    }
    if (Array.isArray(body.baixas)) {
      writeTab_(ss, 'Baixas', body.baixas, SCHEMA_TITULO);
      resumo.baixas = body.baixas.length;
    }
    if (Array.isArray(body.titulos_manual)) {
      writeTab_(ss, 'TitulosManual', body.titulos_manual, SCHEMA_TITULO);
      resumo.titulos_manual = body.titulos_manual.length;
    }
    if (Array.isArray(body.nf_servico)) {
      writeTab_(ss, 'NFServico', body.nf_servico, SCHEMA_NF_SERVICO);
      resumo.nf_servico = body.nf_servico.length;
    }
    if (Array.isArray(body.nf_titulo)) {
      writeTab_(ss, 'NFTitulo', body.nf_titulo, SCHEMA_NF_TITULO);
      resumo.nf_titulo = body.nf_titulo.length;
    }
    if (Array.isArray(body.reembolso)) {
      writeTab_(ss, 'Reembolso', body.reembolso, SCHEMA_REEMBOLSO);
      resumo.reembolso = body.reembolso.length;
    }
    if (body.naturezas && typeof body.naturezas === 'object') {
      const arr = Object.keys(body.naturezas).sort().map(k => {
        const v = body.naturezas[k];
        if (v && typeof v === 'object') {
          return { codigo: k, descricao: v.descricao || '',
                   conta_fluxo: v.conta_fluxo || '', fluxo_caixa: v.fluxo_caixa || '' };
        }
        return { codigo: k, descricao: v || '', conta_fluxo: '', fluxo_caixa: '' };
      });
      writeTab_(ss, 'Naturezas', arr, SCHEMA_NATUREZAS);
      resumo.naturezas = arr.length;
    }

    /* ---- HISTÓRICO ----
       Acontece sozinho, sem botão: tudo que chegou com data de baixa vira
       linha no histórico. Reenviar o mesmo título não duplica. */
    if (ALIMENTAR_HISTORICO && Array.isArray(body.historico) && body.historico.length) {
      const h = gravarHistorico_(body.historico);
      resumo.historico_novos = h.novos;
      resumo.historico_atualizados = h.atualizados;
    }

    if (Object.keys(resumo).filter(k => k !== 'backup').length === 0) {
      return jsonOut_({ ok: false, erro: 'Envio sem dados reconhecidos.' });
    }

    PropertiesService.getScriptProperties().setProperty(PROP_LAST, new Date().toISOString());
    clearCache_();

    return jsonOut_({ ok: true, recebido: resumo, lastUpdated: getLast_() });
  } catch (err) {
    return jsonOut_({ ok: false, erro: String(err && err.message || err) });
  }
}

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};

    if (p.check) {
      const ss = getSpreadsheet_();
      return jsonOut_({
        ok: true,
        lastUpdated: getLast_(),
        exige_chave: chaveExigida_(),
        chave_ok: p.chave !== undefined ? chaveConfere_(p.chave) : null,
        contagem: {
          titulos:   contarTab_(ss, 'Titulos'),
          baixas:    contarTab_(ss, 'Baixas'),
          manuais:   contarTab_(ss, 'TitulosManual'),
          nf_servico: contarTab_(ss, 'NFServico'),
          nf_titulo:  contarTab_(ss, 'NFTitulo'),
          reembolso:  contarTab_(ss, 'Reembolso'),
        },
        feriados: readTab_(ss, 'Feriados', SCHEMA_FERIADO).filter(f => f.data),
      });
    }

    if (p.naturezas) {
      const rows = readTab_(getSpreadsheet_(), 'Naturezas', SCHEMA_NATUREZAS);
      const map = {};
      rows.forEach(r => {
        if (r.codigo) map[r.codigo] = {
          descricao: r.descricao, conta_fluxo: r.conta_fluxo, fluxo_caixa: r.fluxo_caixa };
      });
      return rawJson_(JSON.stringify(map));
    }

    if (p.manuais) {
      return rawJson_(JSON.stringify(readTab_(getSpreadsheet_(), 'TitulosManual', SCHEMA_TITULO)));
    }

    /* Histórico de um mês: ?historico=2026-08 — usado pelo futuro fluxo de caixa.
       Fica fora do payload do painel de propósito, pra não pesar a carga. */
    if (p.historico) {
      const hs = getHistSpreadsheet_();
      return rawJson_(JSON.stringify(readTab_(hs, String(p.historico), SCHEMA_HIST)));
    }
    if (p.historico_meses) {
      const hs = getHistSpreadsheet_();
      const nomes = hs.getSheets().map(s => s.getName())
        .filter(n => /^\d{4}-\d{2}$/.test(n)).sort();
      return jsonOut_({ ok: true, meses: nomes });
    }

    const cached = readCache_();
    if (cached) return rawJson_(cached);

    const json = buildPayload_();
    writeCache_(json);
    return rawJson_(json);
  } catch (err) {
    return jsonOut_({ erro: String(err && err.message || err) });
  }
}

/* ============================ PAYLOAD DO PAINEL ===========================
   Devolve as listas CRUAS + meta. A classificação (pago / em aberto /
   aguardando aprovação), o casamento Fluig x Totvs e os KPIs são feitos no
   front, que é onde dá pra ajustar sem reimplantar o Apps Script.
   ========================================================================== */

function buildPayload_() {
  const ss = getSpreadsheet_();
  const payload = {
    versao: 2,
    meta: computeMeta_(),
    titulos: readTab_(ss, 'Titulos', SCHEMA_TITULO)
      .concat(readTab_(ss, 'TitulosManual', SCHEMA_TITULO)),
    /* Baixas ficam separadas: são de outro relatório, filtrado por data de
       baixa, e um título nunca é baixado no mesmo dia em que é pago. */
    baixas: readTab_(ss, 'Baixas', SCHEMA_TITULO),
    nf_servico: readTab_(ss, 'NFServico', SCHEMA_NF_SERVICO),
    nf_titulo:  readTab_(ss, 'NFTitulo',  SCHEMA_NF_TITULO),
    reembolso:  readTab_(ss, 'Reembolso', SCHEMA_REEMBOLSO),
    naturezas:  (function(){
      const map = {};
      readTab_(ss, 'Naturezas', SCHEMA_NATUREZAS).forEach(r => {
        if (r.codigo) map[r.codigo] = {
          descricao: r.descricao, conta_fluxo: r.conta_fluxo, fluxo_caixa: r.fluxo_caixa };
      });
      return map;
    })(),
    feriados: readTab_(ss, 'Feriados', SCHEMA_FERIADO).filter(f => f.data),
    config_status: (function(){
      const map = {};
      readTab_(ss, 'ConfigStatus', SCHEMA_CONFIG_STATUS).forEach(r => {
        if (r.status) map[r.status] = String(r.significado || '').toLowerCase();
      });
      return map;
    })(),
    /* Só os ajustes em vigor — os desfeitos ficam na planilha como histórico,
       mas não voltam para o painel. */
    ajustes: readTab_(ss, 'Ajustes', SCHEMA_AJUSTE).filter(a => !a.desfeito),
  };
  return JSON.stringify(payload);
}

/* meta.data_ref = dia do último envio (referência de "hoje" na tela).
   A classificação de cada título usa o VENCIMENTO dele, não isto aqui. */
function computeMeta_() {
  const lastIso = getLast_();
  if (!lastIso) return { generated_at: null, data_ref: null, data_amanha: null };
  const d = new Date(lastIso);
  const data_ref = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  return {
    generated_at: Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    data_ref: data_ref,
    data_amanha: nextBusinessDay_(data_ref),
  };
}

function getLast_() {
  return PropertiesService.getScriptProperties().getProperty(PROP_LAST) || null;
}

function nextBusinessDay_(isoDate) {
  const p = isoDate.split('-');
  const d = new Date(+p[0], +p[1] - 1, +p[2]);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

/* ============================ AJUSTES =====================================
   Log append-only. Desfazer não apaga: marca a linha como desfeita, então o
   registro de quem mexeu em quê continua na planilha.
   ========================================================================== */

function gravarAjustes_(ss, ajustes) {
  if (!Array.isArray(ajustes) || !ajustes.length) {
    return { ok: false, erro: 'Nenhum ajuste recebido.' };
  }
  const existentes = readTab_(ss, 'Ajustes', SCHEMA_AJUSTE);
  const agora = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss");
  const novos = [];
  ajustes.forEach(a => {
    if (!a || !a.alvo || !a.campo) return;
    novos.push({
      id: Utilities.getUuid().slice(0, 8),
      alvo: String(a.alvo),
      campo: String(a.campo),
      valor_novo: (a.valor_novo === null || a.valor_novo === undefined) ? '' : String(a.valor_novo),
      valor_antigo: (a.valor_antigo === null || a.valor_antigo === undefined) ? '' : String(a.valor_antigo),
      autor: String(a.autor || 'sem nome'),
      quando: agora,
      motivo: String(a.motivo || ''),
      desfeito: false,
    });
  });
  if (!novos.length) return { ok: false, erro: 'Ajustes sem alvo ou campo.' };
  writeTab_(ss, 'Ajustes', existentes.concat(novos), SCHEMA_AJUSTE);
  return { ok: true, gravados: novos.length, ids: novos.map(n => n.id) };
}

function desfazerAjuste_(ss, id) {
  if (!id) return { ok: false, erro: 'Ajuste não informado.' };
  const linhas = readTab_(ss, 'Ajustes', SCHEMA_AJUSTE);
  let achou = false;
  linhas.forEach(l => {
    // desfaz o ajuste pedido, ou todos de um alvo quando vem 'alvo:<chave>'
    if (l.id === id || ('alvo:' + l.alvo) === id) { l.desfeito = true; achou = true; }
  });
  if (!achou) return { ok: false, erro: 'Ajuste não encontrado.' };
  writeTab_(ss, 'Ajustes', linhas, SCHEMA_AJUSTE);
  return { ok: true, desfeito: id };
}

/* Título lançado direto pelo painel — o pagamento que não passou nem pelo
   Fluig nem pelo Totvs. Fica na aba própria, que o envio de relatório não toca. */
function gravarTituloManual_(ss, titulo) {
  if (!titulo || typeof titulo !== 'object') {
    return { ok: false, erro: 'Título não recebido.' };
  }
  const atuais = readTab_(ss, 'TitulosManual', SCHEMA_TITULO);
  const novo = {};
  SCHEMA_TITULO.forEach(c => { novo[c.k] = titulo[c.k]; });
  novo.manual = true;
  if (!safeNum_(novo.valor_rs) && safeNum_(novo.valor)) novo.valor_rs = safeNum_(novo.valor);
  if (!safeNum_(novo.valor_liquido)) novo.valor_liquido = safeNum_(novo.valor_rs);
  atuais.push(novo);
  writeTab_(ss, 'TitulosManual', atuais, SCHEMA_TITULO);

  // se já nasce baixado, entra no histórico na mesma hora
  let hist = null;
  if (novo.dt_baixa) {
    hist = gravarHistorico_([{
      chave: 'manual|' + (novo.numero || '') + '|' + (novo.fornecedor || '') + '|' + novo.dt_baixa,
      dt_baixa: novo.dt_baixa, vencimento: novo.vencimento,
      numero: novo.numero, id_fluig: novo.id_fluig, parcela: novo.parcela,
      prefixo: novo.prefixo, tipo: novo.tipo, natureza: novo.natureza,
      conta_fluxo: novo.conta_fluxo, fornecedor_cod: novo.fornecedor_cod,
      loja: novo.loja, fornecedor: novo.fornecedor,
      valor_pago: safeNum_(novo.valor_liquido) || safeNum_(novo.valor_rs),
      valor_titulo: safeNum_(novo.valor_rs),
      historico: novo.historico, banco: novo.banco, bordero: novo.bordero,
      fluxo_caixa: novo.fluxo_caixa, origem: 'manual',
    }]);
  }
  PropertiesService.getScriptProperties().setProperty(PROP_LAST, new Date().toISOString());
  return { ok: true, total_manuais: atuais.length, historico: hist };
}

/* Lançamento próprio é seu e não volta de relatório nenhum, então aqui apagar
   é apagar mesmo — diferente do título do Totvs, que só pode ser ocultado
   porque reapareceria no dia seguinte. */
function excluirTituloManual_(ss, idManual) {
  const id = String(idManual || '');
  if (!id) return { ok: false, erro: 'Lançamento não informado.' };
  const atuais = readTab_(ss, 'TitulosManual', SCHEMA_TITULO);
  const restantes = atuais.filter(t => String(t.id_manual || '') !== id);
  if (restantes.length === atuais.length) {
    return { ok: false, erro: 'Lançamento não encontrado.' };
  }
  writeTab_(ss, 'TitulosManual', restantes, SCHEMA_TITULO);
  PropertiesService.getScriptProperties().setProperty(PROP_LAST, new Date().toISOString());
  return { ok: true, excluidos: atuais.length - restantes.length };
}

function safeNum_(v) { return Number(v) || 0; }

/* ============================ HISTÓRICO ===================================
   Uma aba por mês (yyyy-MM), definida pela DATA DE BAIXA. Dedup por
   chave + dt_baixa dentro da aba do mês, então reenviar o mesmo arquivo
   três vezes no dia não gera linha repetida.
   ========================================================================== */

function gravarHistorico_(linhas) {
  const hs = getHistSpreadsheet_();
  const agora = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss");

  // Agrupa o que chegou por mês da baixa.
  const porMes = {};
  linhas.forEach(r => {
    const dt = String(r.dt_baixa || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) return;   // sem baixa válida não entra
    const mes = dt.slice(0, 7);
    (porMes[mes] = porMes[mes] || []).push(r);
  });

  let novos = 0, atualizados = 0;

  Object.keys(porMes).forEach(mes => {
    const existentes = readTab_(hs, mes, SCHEMA_HIST);
    const idx = {};
    existentes.forEach((r, i) => { idx[r.chave + '|' + r.dt_baixa] = i; });

    porMes[mes].forEach(r => {
      const linha = {
        chave: r.chave || '',
        dt_baixa: String(r.dt_baixa || '').slice(0, 10),
        vencimento: String(r.vencimento || '').slice(0, 10),
        numero: r.numero || '', id_fluig: r.id_fluig || '',
        parcela: r.parcela || '', prefixo: r.prefixo || '',
        tipo: r.tipo || '', natureza: r.natureza || '', conta_fluxo: r.conta_fluxo || '',
        fornecedor_cod: r.fornecedor_cod || '', loja: r.loja || '',
        fornecedor: r.fornecedor || '',
        valor_pago: num_(r.valor_pago), valor_titulo: num_(r.valor_titulo),
        historico: r.historico || '', banco: r.banco || '', bordero: r.bordero || '',
        fluxo_caixa: r.fluxo_caixa || '', origem: r.origem || 'totvs',
        registrado_em: agora,
      };
      const k = linha.chave + '|' + linha.dt_baixa;
      if (k in idx) {
        // Mantém a data em que entrou pela primeira vez.
        linha.registrado_em = existentes[idx[k]].registrado_em || agora;
        existentes[idx[k]] = linha;
        atualizados++;
      } else {
        idx[k] = existentes.length;
        existentes.push(linha);
        novos++;
      }
    });

    existentes.sort((a, b) => String(a.dt_baixa).localeCompare(String(b.dt_baixa)));
    writeTab_(hs, mes, existentes, SCHEMA_HIST);
  });

  return { novos: novos, atualizados: atualizados };
}

/* ============================ PLANILHAS =================================== */

function getSpreadsheet_() {
  if (SHEET_ID) return SpreadsheetApp.openById(SHEET_ID);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('Planilha de operação não encontrada. Preencha SHEET_ID no topo do Code.gs.');
}

function getHistSpreadsheet_() {
  const id = idHistorico_();
  if (!id || id.indexOf('COLE_AQUI') === 0) {
    throw new Error('Planilha de histórico não configurada. Rode definirIdHistorico(\'...\') ' +
                    'ou preencha HIST_SHEET_ID no topo do Code.gs.');
  }
  return SpreadsheetApp.openById(id);
}

function getSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function contarTab_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) return 0;
  return Math.max(0, sh.getLastRow() - 1);
}

function writeTab_(ss, name, arr, schema) {
  const sh = getSheet_(ss, name);
  sh.clearContents();
  const headers = schema.map(c => c.k);
  const rows = (arr || []).map(o => schema.map(c => cellOut_(o ? o[c.k] : '', c.t)));
  const matrix = [headers].concat(rows);

  // Colunas de texto/data em formato TEXTO, pra planilha não "adivinhar" tipo.
  schema.forEach((c, i) => {
    if (c.t !== 'n') sh.getRange(1, i + 1, matrix.length, 1).setNumberFormat('@');
  });
  sh.getRange(1, 1, matrix.length, headers.length).setValues(matrix);
  sh.setFrozenRows(1);
}

function readTab_(ss, name, schema) {
  const sh = ss.getSheetByName(name);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => String(h).trim());
  const idx = {};
  schema.forEach(c => { idx[c.k] = headers.indexOf(c.k); });

  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const obj = {};
    let hasData = false;
    schema.forEach(c => {
      const raw = idx[c.k] >= 0 ? row[idx[c.k]] : '';
      const val = cellIn_(raw, c.t);
      obj[c.k] = val;
      if (val !== '' && val !== null && val !== 0 && val !== false) hasData = true;
    });
    if (hasData) out.push(obj);
  }
  return out;
}

/* ============================ COERÇÃO DE TIPOS ============================ */

function cellOut_(v, t) {
  if (t === 'n') return (typeof v === 'number') ? v : (Number(v) || 0);
  if (t === 'b') return v === true;
  if (t === 'd') return (v === null || v === undefined || v === '') ? '' : String(v);
  return (v === null || v === undefined) ? '' : String(v);
}

function cellIn_(v, t) {
  if (t === 'n') return Number(v) || 0;
  if (t === 'b') return v === true || v === 'true' || v === 'TRUE';
  if (t === 'd') {
    if (v === null || v === undefined || v === '') return null;
    if (Object.prototype.toString.call(v) === '[object Date]') {
      return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
    }
    return String(v).slice(0, 10);
  }
  return (v === null || v === undefined) ? '' : String(v);
}

function num_(v) { return Number(v) || 0; }

/* ============================ CACHE ======================================= */

function writeCache_(str) {
  try {
    const cache = CacheService.getScriptCache();
    const n = Math.ceil(str.length / CACHE_CHUNK);
    if (n > 25) return;
    const entries = {};
    for (let i = 0; i < n; i++) entries[CACHE_KEY + '_' + i] = str.substr(i * CACHE_CHUNK, CACHE_CHUNK);
    entries[CACHE_KEY + '_count'] = String(n);
    cache.putAll(entries, CACHE_TTL);
  } catch (err) {}
}

function readCache_() {
  try {
    const cache = CacheService.getScriptCache();
    const countStr = cache.get(CACHE_KEY + '_count');
    if (!countStr) return null;
    const n = parseInt(countStr, 10);
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(CACHE_KEY + '_' + i);
    const parts = cache.getAll(keys);
    let out = '';
    for (let i = 0; i < n; i++) {
      const piece = parts[CACHE_KEY + '_' + i];
      if (piece === null || piece === undefined) return null;
      out += piece;
    }
    return out;
  } catch (err) { return null; }
}

function clearCache_() {
  try {
    const cache = CacheService.getScriptCache();
    const countStr = cache.get(CACHE_KEY + '_count');
    const keys = [CACHE_KEY + '_count'];
    if (countStr) {
      const n = parseInt(countStr, 10);
      for (let i = 0; i < n; i++) keys.push(CACHE_KEY + '_' + i);
    }
    cache.removeAll(keys);
  } catch (err) {}
}

/* ============================ RESPOSTAS =================================== */

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function rawJson_(str) {
  return ContentService.createTextOutput(str)
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================ DIAGNÓSTICO =================================
   Rode uma vez pelo editor depois de instalar. Cria as abas que faltarem e
   confirma que as duas planilhas estão acessíveis.
   ========================================================================== */

function testarInstalacao() {
  const ss = getSpreadsheet_();
  Object.keys(TABS).forEach(nome => {
    if (!ss.getSheetByName(nome)) writeTab_(ss, nome, [], TABS[nome]);
  });
  // semente do mapa de status, para a aba não nascer vazia
  if (!contarTab_(ss, 'ConfigStatus')) {
    writeTab_(ss, 'ConfigStatus', [
      { status: 'Aprovação',                   significado: 'pendente'  },
      { status: 'Aprovação Reembolso',         significado: 'pendente'  },
      { status: 'Aguardando baixa titulos Pagto', significado: 'aprovado'  },
      { status: 'Disponivel para Pagamento',   significado: 'aprovado'  },
      { status: 'Solicitação Cancelada',       significado: 'cancelado' },
    ], SCHEMA_CONFIG_STATUS);
  }

  // semente dos feriados nacionais — acrescente os municipais nesta mesma aba
  if (!contarTab_(ss, 'Feriados')) {
    writeTab_(ss, 'Feriados', [
      { data: '2026-01-01', descricao: 'Confraternização Universal' },
      { data: '2026-02-16', descricao: 'Carnaval' },
      { data: '2026-02-17', descricao: 'Carnaval' },
      { data: '2026-04-03', descricao: 'Sexta-feira Santa' },
      { data: '2026-04-21', descricao: 'Tiradentes' },
      { data: '2026-05-01', descricao: 'Dia do Trabalho' },
      { data: '2026-06-04', descricao: 'Corpus Christi' },
      { data: '2026-09-07', descricao: 'Independência' },
      { data: '2026-10-12', descricao: 'Nossa Senhora Aparecida' },
      { data: '2026-11-02', descricao: 'Finados' },
      { data: '2026-11-15', descricao: 'Proclamação da República' },
      { data: '2026-11-20', descricao: 'Consciência Negra' },
      { data: '2026-12-25', descricao: 'Natal' },
      { data: '2027-01-01', descricao: 'Confraternização Universal' },
      { data: '2027-02-08', descricao: 'Carnaval' },
      { data: '2027-02-09', descricao: 'Carnaval' },
      { data: '2027-03-26', descricao: 'Sexta-feira Santa' },
      { data: '2027-04-21', descricao: 'Tiradentes' },
      { data: '2027-05-01', descricao: 'Dia do Trabalho' },
      { data: '2027-05-27', descricao: 'Corpus Christi' },
      { data: '2027-09-07', descricao: 'Independência' },
      { data: '2027-10-12', descricao: 'Nossa Senhora Aparecida' },
      { data: '2027-11-02', descricao: 'Finados' },
      { data: '2027-11-15', descricao: 'Proclamação da República' },
      { data: '2027-11-20', descricao: 'Consciência Negra' },
      { data: '2027-12-25', descricao: 'Natal' },
    ], SCHEMA_FERIADO);
  }

  const hs = getHistSpreadsheet_();
  const mesAtual = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  if (!hs.getSheetByName(mesAtual)) writeTab_(hs, mesAtual, [], SCHEMA_HIST);
  const msg = 'OK\n' +
    'Operação: ' + ss.getName() + '\n' +
    'Histórico: ' + hs.getName() + '\n' +
    'Abas de operação: ' + Object.keys(TABS).join(', ') + '\n' +
    'Aba do mês no histórico: ' + mesAtual;
  Logger.log(msg);
  return msg;
}

/* Procura o mesmo título gravado em meses diferentes — acontece se a data de
   baixa for corrigida no Totvs depois de já ter entrado no histórico. */
function conferirDuplicidadesHistorico() {
  const hs = getHistSpreadsheet_();
  const vistos = {}, dups = [];
  hs.getSheets().forEach(sh => {
    const nome = sh.getName();
    if (!/^\d{4}-\d{2}$/.test(nome)) return;
    readTab_(hs, nome, SCHEMA_HIST).forEach(r => {
      if (!r.chave) return;
      if (vistos[r.chave] && vistos[r.chave] !== nome) {
        dups.push(r.chave + ' → ' + vistos[r.chave] + ' e ' + nome);
      } else {
        vistos[r.chave] = nome;
      }
    });
  });
  const msg = dups.length ? ('Duplicidades encontradas:\n' + dups.join('\n'))
                          : 'Nenhuma duplicidade entre meses.';
  Logger.log(msg);
  return msg;
}
