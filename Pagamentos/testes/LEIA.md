# Testes

São as regras que não podem quebrar, escritas como perguntas com resposta
conhecida. Rodam em Node puro — sem instalar nada, sem navegador, sem
dependências.

## Rodar

Na pasta `Pagamentos`:

```
node testes/rodar.js
```

Sai uma linha por verificação e um placar no fim. Se alguma falhar, o comando
termina com erro, e é isso que o GitHub usa para acender o vermelho.

## Rodar sozinho, sem você fazer nada

O arquivo `.github/workflows/testes.yml` faz o GitHub rodar isso a cada
alteração na pasta `Pagamentos`. Depois de subir um arquivo, aparece um sinal
ao lado do commit: verde passou, vermelho quebrou alguma coisa. Clicando no
sinal, você vê qual verificação falhou, com o nome dela escrito em português.

Não precisa instalar nada na sua máquina para isso funcionar.

## O que está coberto

`conciliacao.teste.js` — qual valor vale em cada situação, a validade dos
ajustes manuais, a caixinha de confirmação de divergência, o relatório do
próprio dia baixando o previsto sem duplicar, e a devolução do banco.

`backend.teste.js` — a chave de escrita, o backup antes de gravar, a
restauração, a rotatividade dos trinta backups e o resumo diário.

`apoio.js` — carrega o `conciliacao.js` e monta um Apps Script de mentira, com
planilha e Drive em memória, para o `Code.gs` rodar fora do Google.

## Acrescentar um teste

Escolha o arquivo pelo assunto, ache o `grupo(...)` mais próximo e acrescente
uma linha:

```javascript
ok('descrição do que tem de ser verdade', expressão que dá true ou false);
igual('descrição', valorObtido, valorEsperado);
```

Escreva a descrição como a frase que você diria para explicar a regra a alguém.
Quando o teste falhar daqui a seis meses, é essa frase que vai dizer o que
quebrou.
