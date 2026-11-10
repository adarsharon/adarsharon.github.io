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
  document.querySelectorAll(".current-year").forEach(el => { el.textContent = String(new Date().getFullYear()); });
})();
