# 📋 COMO USAR O TEMPLATE E CSS COMPARTILHADO

Quando você criar uma **nova ferramenta** para o Portal On Time, siga este guia simples.

---

## **1️⃣ Copiar o Template**

- Pegue o arquivo **`template.html`** na raiz do repositório
- Copie para a pasta da sua nova ferramenta
- Renomeie para **`index.html`**

**Exemplo:**
```
Controladoria/
├── template.html          ← pegue aqui
├── MeuFerramental/
│   └── index.html         ← cole renomeado aqui
```

---

## **2️⃣ Customizar o Index**

Abra o `index.html` que você copiou e altere **apenas**:

| O quê | Onde | Exemplo |
|-------|------|---------|
| **Título da página** | `<title>` | `<title>DRE - Portal On Time</title>` |
| **Nome da ferramenta** (no header) | `<h1 class="page-title">` | `<h1 class="page-title"><i>📊</i> DRE</h1>` |
| **STORAGE_KEY** | JavaScript no final | `came_from_hub_dre` |
| **Conteúdo** | Dentro de `<main class="content-body">` | Seu HTML aqui |

---

## **3️⃣ Usar o CSS Compartilhado**

O `styles.css` está **linkado automaticamente** no template:

```html
<link rel="stylesheet" href="../styles.css">
```

✅ Não mexer nesta linha.

---

## **4️⃣ Se Precisar de Estilos Próprios**

Se sua ferramenta precisa de **cores/fontes diferentes**, adicione dentro da tag `<style>` vazia:

```html
<style>
  /* Seus estilos específicos aqui */
  .meu-componente { color: #FF6E00; }
</style>
```

Mas o padrão deve vir do `styles.css` central.

---

## **5️⃣ Não Mexer Em:**

❌ **Não altere:**
- `<link rel="icon">` (favicon)
- `<img src="../logo-mascote.jpg">` (mascote)
- Código do botão "Voltar ao hub"
- Estrutura `<aside class="sidebar">` e `<div class="main-content">`

✅ **Altere apenas:**
- Conteúdo dentro de `<main class="content-body">`
- `<title>` e `<h1 class="page-title">`
- O `STORAGE_KEY` (linha ~95)

---

## **Resumo**

| Passo | Ação |
|-------|------|
| 1 | Copie `template.html` → `sua-ferramenta/index.html` |
| 2 | Altere título, ícone, STORAGE_KEY |
| 3 | Desenvolva seu conteúdo em `<main>` |
| 4 | Estilos gerais vêm de `styles.css` (automático) |
| 5 | Commit! 🚀 |

---

**Dúvidas?** Pergunte ao Claude com: *"Ferramenta para o Hub Ontime"* 👍
