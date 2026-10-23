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
      const v = e.state?.view || 'splash';
      this.renderView(v);
    });
  },

  navigate(viewName, pushHistory = true) {
    if (!this.screens[viewName]) {
      console.warn(`[Router] Screen "${viewName}" not found.`);
      return;
    }

    if (pushHistory) {
      try {
        history.pushState({ view: viewName }, '', `#${viewName}`);
      } catch (e) {
        // Fallback for sandboxed or restricted frames
      }
    }

    this.renderView(viewName);
  },

  renderView(viewName) {
    Object.keys(this.screens).forEach((key) => {
      const el = this.screens[key];
      if (el) el.classList.add('hidden');
    });

    const activeEl = this.screens[viewName];
    if (activeEl) {
      activeEl.classList.remove('hidden');
    }

    if (window.lucide) {
      window.lucide.createIcons();
    }
  },
};
                            
