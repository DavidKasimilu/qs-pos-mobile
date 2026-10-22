export const Router = {
  screens: {},

  init() {
    this.screens = {
      splash: document.getElementById('screen-splash'),
      signin: document.getElementById('screen-signin'),
      register: document.getElementById('screen-register'),
      pos: document.getElementById('screen-pos'),
    };

    // Listen for device hardware back-button (Android Popstate)
    window.addEventListener('popstate', (event) => {
      if (event.state && event.state.view) {
        this.renderView(event.state.view, false);
      }
    });
  },

  navigate(viewName, pushHistory = true) {
    if (!this.screens[viewName]) return;

    if (pushHistory) {
      history.pushState({ view: viewName }, '', `#${viewName}`);
    }

    this.renderView(viewName);
  },

  renderView(viewName) {
    // Hide all registered full-screen wrappers
    Object.values(this.screens).forEach((el) => {
      if (el) el.classList.add('hidden');
    });

    // Display target screen
    const target = this.screens[viewName];
    if (target) {
      target.classList.remove('hidden');
    }

    // Refresh icons on active screen
    if (window.lucide) {
      window.lucide.createIcons();
    }
  },
};