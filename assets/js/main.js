// =============================================================================
// Terminal hero effects
// =============================================================================
(function () {
  // ---- Typewriter effect --------------------------------------------------
  const el = document.querySelector(".typewriter");
  if (el) {
    const text = el.getAttribute("data-text") || el.textContent;
    el.textContent = "";
    let i = 0;

    const type = () => {
      if (i < text.length) {
        el.textContent += text.charAt(i++);
        setTimeout(type, 18 + Math.random() * 26);
      }
    };
    // small delay so the page paint settles
    setTimeout(type, 400);
  }

  // ---- Reveal post-list rows on scroll ------------------------------------
  const items = document.querySelectorAll(".post-item");
  if (items.length && "IntersectionObserver" in window) {
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.style.opacity = 1;
            entry.target.style.transform = "none";
            obs.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1 }
    );

    items.forEach((item, idx) => {
      item.style.opacity = 0;
      item.style.transform = "translateY(6px)";
      item.style.transition = "opacity .3s ease, transform .3s ease";
      item.style.transitionDelay = (idx % 8) * 35 + "ms";
      obs.observe(item);
    });
  }
})();
