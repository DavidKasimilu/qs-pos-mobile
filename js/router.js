export const Router = {
  screens: {},

  init() {
    this.screens = {
      splash: document.getElementById('screen-splash'),
      signin: document.getElementById('screen-signin'),
      register: document.getElementById('screen-register'),
      otp: document.getElementById('screen-otp'),
      forgot: document.getElementById('screen-forgot'),
      'reset-password': document.getElementById('screen-reset-password'),
      pos: document.getElementById('screen-pos'),
    };

    window.addEventListener('popstate', (e) => {
      if (e.state?.view) this.renderView(e.state.view, false);
    });
  },

  navigate(viewName, pushHistory = true) {
    if (!this.screens[viewName]) return;
    if (pushHistory) history.pushState({ view: viewName }, '', `#${viewName}`);
    this.renderView(viewName);
  },

  renderView(viewName) {
    Object.values(this.screens).forEach((el) => {
      if (el) el.classList.add('hidden');
    });

    const target = this.screens[viewName];
    if (target) target.classList.remove('hidden');

    if (window.lucide) window.lucide.createIcons();
  },
};