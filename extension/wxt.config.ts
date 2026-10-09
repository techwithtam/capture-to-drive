import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'Capture to Drive',
    description: 'Save screenshots, pages, PDFs, and files to one Google Drive inbox folder.',
    permissions: ['activeTab', 'scripting', 'debugger', 'contextMenus', 'storage', 'unlimitedStorage', 'alarms'],
    host_permissions: ['<all_urls>'],
    commands: {
      'select-area': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Capture a selected area',
      },
    },
  },
});
