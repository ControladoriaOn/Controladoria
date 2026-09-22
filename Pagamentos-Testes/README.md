# Pagamentos · Painel e Conferência

Ferramenta de apresentação financeira: mostra o que foi pago ontem, a prévia de
hoje e o previsto para amanhã (painel), e a tela de conferência onde os
relatórios entram e são checados antes de publicar (atualizar).

## Estrutura

```
Pagamentos-Testes/
├── index.html            Painel de apresentação (ontem / hoje / amanhã)
├── atualizar.html        Tela de conferência (entrada e checagem dos relatórios)
├── naturezas.json        Mapa de naturezas (dados, inalterado)
├── styles/
│   ├── variables.css     Design tokens: paleta #3C003C + #FF6E00, tipografia,
│   │                     raios, sombras, durações — a fonte única da marca
│   ├── painel.css        Camada visual do painel
│   └── conferencia.css   Camada visual da conferência (antes inline no HTML)
├── scripts/
│   ├── app.js            Painel — IDÊNTICO ao original (lógica intacta)
│   └── conciliacao.js    Núcleo de conciliação — IDÊNTICO ao original
└── assets/
    ├── mascote.png       Mascote (fundo transparente) — header, loading, vazios
    ├── favicon.png       Favicon 512×512
    ├── apple-touch-icon.png
    └── favicon.ico
```

## O que mudou nesta versão

Só aparência. **Nenhuma lógica, cálculo, regra de negócio, fluxo de conferência,
ID, classe funcional ou seletor foi alterado** — `app.js`, `conciliacao.js` e os
scripts da tela de conferência são cópias byte a byte dos originais.

- Paleta ancorada em roxo profundo `#3C003C` + laranja `#FF6E00`, com variações
  tonais e neutros de respiro.
- Painel com fundo ambiente em gradiente de roxo profundo, blobs de luz laranja,
  grid e grão discretos; cartões de trabalho continuam claros (contraste AA).
- Cartão do momento escolhido acende em laranja com glow suave; os outros dois
  recuam em vidro escuro.
- Tipografia nova: Space Grotesk (títulos e números de destaque), Manrope
  (texto), JetBrains Mono com `tabular-nums` nos valores.
- Entrada em cascata, count-up nos valores (já existente, preservado),
  microinterações de hover/focus/active e loading com o mascote em flutuação
  suave. Tudo desligado quando `prefers-reduced-motion` está ativo.
- Foco visível em todos os elementos interativos.

## Como rodar

É site estático: publique a pasta em qualquer servidor (ou abra via extensão de
"live server"). A base de dados é decidida pelo endereço: pasta com "teste" no
nome fala com o script de teste (declare `window.URL_TESTE` na página), qualquer
outra fala com produção. Nada disso mudou.
