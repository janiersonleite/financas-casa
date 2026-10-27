// Tailwind 3.x gerado no build (substitui o cdn.tailwindcss.com). Sem tema customizado: o CDN anterior rodava com a configuração padrão.
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './js/**/*.js'],
  // Classes montadas dinamicamente (o Tailwind não as enxerga no código). Ver docs/qa/DECISOES.md (D9).
  //   js/app.js: `border-${c}-400 bg-${c}-50 text-${c}-700` com c ∈ {red, green, blue} (botões de tipo da categoria)
  safelist: [
    { pattern: /^(border-(red|green|blue)-400|bg-(red|green|blue)-50|text-(red|green|blue)-700)$/ },
  ],
  theme: { extend: {} },
  plugins: [],
};
