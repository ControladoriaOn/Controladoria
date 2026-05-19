# CONTEXTO DO PROJETO — Portal de Ferramentas "On Time" / Controladoria


## Estrutura do repositório (GitHub Pages)

- Repositório: **ControladoriaOn/Controladoria**
- Endereço do **hub**: `https://controladoriaon.github.io/Controladoria/`
- O hub é o `index.html` na **raiz** do repositório.
- Cada ferramenta fica em sua **própria pasta** na raiz, com um `index.html`
  dentro. Exemplos: `Antecipação/index.html`, `Comparativo/index.html`,
  `DRE/index.html`.
- Na **raiz** ficam dois arquivos de imagem: `favicon.png` e `logo-mascote.jpg`.
- Como toda ferramenta está **um nível abaixo** da raiz, o caminho relativo
  para esses arquivos é sempre **`../`**.

---

## 1) Favicon

Adicionar dentro da seção `<head>`:

```html
<link rel="icon" type="image/png" href="../favicon.png">
```

## 2) Mascote

Exibir a imagem no cabeçalho/topo da página:

```html
<img src="../logo-mascote.jpg" alt="Mascote On Time"
     style="width:40px;height:40px;border-radius:8px;object-fit:cover;">
```

(O tamanho e o estilo podem ser adaptados ao layout da ferramenta.)

## 3) Botão "Voltar ao hub"

Regra: o botão deve aparecer **somente** quando a página foi aberta a
partir do hub (ou de outra página do portal). A detecção é **automática**,
pelo `document.referrer` — **não é preciso editar o hub**.

HTML do botão (começa oculto por `display:none`):

```html
<a id="btnVoltarHub" href="../index.html"
   style="display:none;align-items:center;gap:6px;padding:7px 12px;
          font:600 13px sans-serif;color:#6B21A8;text-decoration:none;
          border:1.5px solid #E5E7EB;border-radius:9px;">
  ← Voltar ao hub
</a>
```

JavaScript (colar antes de fechar `</body>`):

```html
<script>
  // BOTÃO "VOLTAR AO HUB" — detecção automática da origem.
  (function () {
    var HubLink = {
      HUB_PATH_PREFIX: '/Controladoria',     // pasta-raiz do portal
      STORAGE_KEY: 'came_from_hub_NOME',     // troque NOME por algo único da ferramenta

      init: function () {
        var btn = document.getElementById('btnVoltarHub');
        if (!btn) return;
        if (this.veioDoHub()) {
          btn.style.display = 'inline-flex';
          try { sessionStorage.setItem(this.STORAGE_KEY, '1'); } catch (e) {}
        }
      },

      veioDoHub: function () {
        // 1) A página anterior é outra página do portal (e não esta própria ferramenta)?
        try {
          if (document.referrer) {
            var ref = new URL(document.referrer);
            var refPath = decodeURIComponent(ref.pathname);
            var selfPath = decodeURIComponent(location.pathname);
            var selfDir = selfPath.slice(0, selfPath.lastIndexOf('/') + 1);
            var mesmaOrigem = ref.origin === location.origin;
            var dentroDoPortal = refPath.indexOf(this.HUB_PATH_PREFIX) === 0;
            var mesmaFerramenta = refPath.indexOf(selfDir) === 0;
            if (mesmaOrigem && dentroDoPortal && !mesmaFerramenta) return true;
          }
        } catch (e) {}
        // 2) Reforço opcional: URL contém "?from"
        try {
          if (new URLSearchParams(location.search).has('from')) return true;
        } catch (e) {}
        // 3) Já marcado nesta sessão (sobrevive ao recarregar com F5)
        try {
          if (sessionStorage.getItem(this.STORAGE_KEY) === '1') return true;
        } catch (e) {}
        return false;
      }
    };
    HubLink.init();
  })();
</script>
```

Observações:
- Cada ferramenta deve ter sua **própria `STORAGE_KEY`** (ex.:
  `came_from_hub_dre`, `came_from_hub_comparativo`).
- O botão **não exige** mexer no hub. Se a pessoa abrir a ferramenta
  direto (favoritos, URL digitada), o botão não aparece — comportamento
  esperado.

## 4) Tela de carregamento ("Carregando dados do sistema")

Cobre a tela enquanto os dados são buscados e some quando terminam.

CSS — dentro do `<style>` no `<head>`:

```css
.loading-overlay {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: center; justify-content: center;
  background: rgba(250, 247, 245, 0.96);
  transition: opacity 0.4s;
}
.loading-overlay.hidden { opacity: 0; pointer-events: none; }
```

HTML — logo após abrir o `<body>`:

```html
<div id="loadingOverlay" class="loading-overlay">
  <div style="text-align:center;">
    <img src="../logo-mascote.jpg" alt="Carregando"
         style="width:64px;height:64px;border-radius:14px;object-fit:cover;
                box-shadow:0 4px 14px -6px rgba(0,0,0,0.25);">
    <p style="margin-top:16px;font:600 14px sans-serif;color:#6B5E6B;">
      Carregando dados do sistema...
    </p>
  </div>
</div>
```

JavaScript — chamar **quando os dados terminarem de carregar**:

```js
document.getElementById('loadingOverlay').classList.add('hidden');
```

(Se a ferramenta recarregar os dados depois, use
`.classList.remove('hidden')` para mostrar a tela de novo e
`.classList.add('hidden')` ao concluir.)

---

## Cores da identidade

- Roxo: `#6B21A8`  ·  Laranja: `#F97316`

---

*Este briefing cobre favicon, mascote, botão "Voltar ao hub" e tela de
carregamento. A integração com Google Sheets é específica do dashboard de
Antecipação — se uma ferramenta nova também precisar salvar dados, peça
essa parte separadamente no chat.*
