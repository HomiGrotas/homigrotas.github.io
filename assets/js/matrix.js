// =============================================================================
// Matrix digital rain — subtle background effect
// =============================================================================
(function () {
  const canvas = document.getElementById("matrix");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  let width, height, columns, drops = [];

  const FONT_SIZE = 14;
  // Katakana + latin for that classic look
  const GLYPHS =
    "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF$#@&*%";

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
    columns = Math.floor(width / FONT_SIZE);
    drops = Array(columns).fill(0).map(() => Math.floor(Math.random() * -height / FONT_SIZE));
  }

  function draw() {
    ctx.fillStyle = "rgba(10, 14, 20, 0.08)"; // trailing fade
    ctx.fillRect(0, 0, width, height);

    ctx.font = FONT_SIZE + "px 'JetBrains Mono', monospace";

    for (let i = 0; i < columns; i++) {
      const glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      const y = drops[i] * FONT_SIZE;

      ctx.fillStyle = Math.random() > 0.975 ? "#00ff9c" : "#00e5ff";
      ctx.fillText(glyph, i * FONT_SIZE, y);

      if (y > height && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
  }

  resize();
  setInterval(draw, 50);

  window.addEventListener("resize", resize);
})();
