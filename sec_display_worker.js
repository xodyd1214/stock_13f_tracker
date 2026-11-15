'use strict';

importScripts('sec_display_loader.js?v=5');

self.addEventListener('message', async ({ data }) => {
  try {
    const baseURL = new URL('./', self.location.href);
    const options = data.config ? data : { config: data };
    const display = await self.SECDisplayLoader.load({ baseURL, ...options });
    self.postMessage({ display });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
}, { once: true });
