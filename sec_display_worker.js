'use strict';

importScripts('sec_display_loader.js?v=2');

self.addEventListener('message', async ({ data: config }) => {
  try {
    const baseURL = new URL('./', self.location.href);
    const display = await self.SECDisplayLoader.load({ baseURL, config });
    self.postMessage({ display });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
}, { once: true });
