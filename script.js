(() => {
  const toggle = document.querySelector(".menu-toggle");
  const menu = document.querySelector("#primary-nav");
  if (toggle && menu) {
    const closeMenu = () => { toggle.setAttribute("aria-expanded", "false"); menu.classList.remove("is-open"); toggle.setAttribute("aria-label", "Open navigation"); };
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
      menu.classList.toggle("is-open", open);
    });
    menu.querySelectorAll("a").forEach(link => link.addEventListener("click", closeMenu));
    document.addEventListener("keydown", event => { if (event.key === "Escape") closeMenu(); });
    document.addEventListener("click", event => { if (!menu.contains(event.target) && !toggle.contains(event.target)) closeMenu(); });
  }
  // Scroll reveal: active when <html> has class "motion" (set in the page head unless the visitor prefers reduced motion).
  const root = document.documentElement;
  if (root.classList.contains("motion") && "IntersectionObserver" in window) {
    const selectors = [
      ".profile-links", ".cv-feature", ".intro-section .section-side", ".intro-section .section-body", ".feature-card",
      ".editorial-label", ".editorial-content", ".contact-section > div",
      ".research-aside", ".research-body > h2", ".research-body > p", ".papers-label", ".paper-list li", ".profile-outro > *",
      ".notes-heading > *", ".writing-feature", ".credit-line", ".talk-item"
    ];
    const staggered = [".feature-card", ".paper-list li", ".notes-heading > *", ".profile-outro > *"];
    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        io.unobserve(el);
        el.classList.add("is-visible");
        const done = () => { el.classList.remove("reveal", "is-visible"); el.style.removeProperty("--reveal-delay"); };
        el.addEventListener("transitionend", ev => { if (ev.target === el && ev.propertyName === "opacity") done(); });
        setTimeout(done, 1500);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    const vh = window.innerHeight;
    document.querySelectorAll(selectors.join(",")).forEach(el => {
      if (el.getBoundingClientRect().top < vh * 0.92) return;  // already on screen at load: leave it alone
      const group = staggered.find(s => el.matches(s));
      if (group) {
        const i = [...el.parentElement.children].filter(c => c.matches(group)).indexOf(el);
        el.style.setProperty("--reveal-delay", Math.min(i, 4) * 90 + "ms");
      }
      el.classList.add("reveal");
      io.observe(el);
    });
  }
  document.querySelectorAll(".current-year").forEach(el => { el.textContent = String(new Date().getFullYear()); });
})();
